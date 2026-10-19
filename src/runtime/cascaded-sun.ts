import * as THREE from 'three';
import type { EnvironmentSettings } from '../core/environment';
import {
  bindMaterialEffect,
  isLitMaterial,
  materialEffectUniforms,
} from './material-effects';

const declarations = /* glsl */ `
uniform float terrainCascadeStart;
uniform vec3 terrainCascadeSplits;
float terrainCascadeBlend(float depth, float edge) {
  return smoothstep(edge * 0.95, edge * 1.05, depth);
}
float terrainCascadeWeight(float index, float depth) {
  float a = terrainCascadeBlend(depth, terrainCascadeSplits.x);
  float b = terrainCascadeBlend(depth, terrainCascadeSplits.y);
  if (index < 0.5) return 1.0 - a;
  if (index < 1.5) return a - b;
  return b;
}
`;

// Patch only this material's directional-light loop. No global ShaderChunk changes,
// and no reliance on the cascades being the first lights in a host scene.
function cascadeLighting() {
  const source = THREE.ShaderChunk.lights_fragment_begin;
  const start = source.indexOf('#if ( NUM_DIR_LIGHTS > 0 )');
  const end = source.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )', start);
  const block = source
    .slice(start, end)
    .replace(
      '#pragma unroll_loop_start',
      'float terrainCascadeIndex; bool terrainIsCascade; float terrainSunWeight; vec3 terrainUnshadowed;\n#pragma unroll_loop_start',
    )
    .replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      `
      getDirectionalLightInfo( directionalLight, directLight );
      terrainCascadeIndex = float(UNROLLED_LOOP_INDEX) - terrainCascadeStart;
      terrainIsCascade = terrainCascadeIndex >= 0.0 && terrainCascadeIndex < 3.0;
      terrainSunWeight = terrainIsCascade ? terrainCascadeWeight(terrainCascadeIndex, vViewPosition.z) : 1.0;
      terrainUnshadowed = directLight.color;
      // Only one cascade contributes away from a blend boundary. Skip the other
      // shadow filters and BRDF evaluations instead of multiplying them by zero.
      if (terrainSunWeight > 0.0) {
    `,
    )
    .replace(
      'RE_Direct( directLight,',
      `
      if (terrainIsCascade) {
        float distanceFade = smoothstep(terrainCascadeSplits.z * 0.9, terrainCascadeSplits.z, vViewPosition.z);
        directLight.color = mix(directLight.color, terrainUnshadowed, distanceFade);
      }
      directLight.color *= terrainSunWeight;
      RE_Direct( directLight,`,
    )
    .replace('material, reflectedLight );', 'material, reflectedLight );\n}');
  return source.slice(0, start) + block + source.slice(end);
}

/** Three PCF shadow maps for one sun, with local shader hooks and texel-stable fitting.
 * Owned by PreparedEnvironment. Constructed off-scene so allocation failure cannot
 * replace the current light rig. Built-in lit materials are bound before rendering.
 */
export class CascadedSun {
  readonly group = new THREE.Group();
  readonly lights: THREE.DirectionalLight[] = [];
  readonly splits = new THREE.Vector3();
  private readonly uniforms = {
    terrainCascadeStart: { value: 0 },
    terrainCascadeSplits: { value: this.splits },
  };
  private readonly materials = new Map<THREE.Material, () => void>();
  private readonly orientation = new THREE.Matrix4();
  private readonly inverseOrientation = new THREE.Matrix4();
  private readonly cameraToLight = new THREE.Matrix4();
  private readonly direction = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly bounds = new THREE.Box3();
  private readonly origin = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly vertices = Array.from(
    { length: 8 },
    () => new THREE.Vector3(),
  );
  private disposed = false;

  constructor(settings: EnvironmentSettings, renderer?: THREE.WebGLRenderer) {
    this.group.name = 'Cascaded sun';
    try {
      for (let i = 0; i < 3; i++) {
        const light = new THREE.DirectionalLight();
        this.lights.push(light);
        light.name = `Sun cascade ${i + 1}`;
        light.castShadow = true;
        light.shadow.mapSize.setScalar(settings.shadowResolution);
        const map = new THREE.WebGLRenderTarget(
          settings.shadowResolution,
          settings.shadowResolution,
          {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
          },
        );
        light.shadow.map = map;
        map.texture.name = light.name + '.shadowMap';
        // Force framebuffer allocation while this candidate is still disposable.
        renderer?.initRenderTarget(map);
        this.group.add(light, light.target);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** The sun direction/color comes from TerrainEnvironment, including its solar clock. */
  update(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    sun: THREE.DirectionalLight,
    settings: EnvironmentSettings,
    casterReach: number,
  ) {
    if (this.disposed) return;
    camera.updateWorldMatrix(true, false);
    const near = Math.max(0.01, camera.near);
    const far = Math.max(
      near + 0.01,
      Math.min(camera.far, settings.shadowDistance ?? 160),
    );
    const split = (fraction: number) =>
      THREE.MathUtils.lerp(
        near + (far - near) * fraction,
        near * (far / near) ** fraction,
        0.7,
      );
    this.splits.set(split(1 / 3), split(2 / 3), far);
    this.direction.subVectors(sun.target.position, sun.position).normalize();
    this.orientation.lookAt(this.origin, this.direction, this.up);
    this.inverseOrientation.copy(this.orientation).invert();
    this.cameraToLight.multiplyMatrices(
      this.inverseOrientation,
      camera.matrixWorld,
    );
    for (let i = 0; i < 3; i++) {
      const light = this.lights[i];
      const start = i === 0 ? near : this.splits.getComponent(i - 1) * 0.95;
      const end = i === 2 ? far : this.splits.getComponent(i) * 1.05;
      this.center.set(0, 0, 0);
      for (let v = 0; v < 8; v++) {
        const depth = v < 4 ? start : end;
        const point = this.vertices[v]
          .set(v % 2 ? 1 : -1, v % 4 < 2 ? 1 : -1, -1)
          .applyMatrix4(camera.projectionMatrixInverse);
        if (camera instanceof THREE.PerspectiveCamera)
          point.multiplyScalar(depth / -point.z);
        else point.z = -depth;
        this.center.add(point);
      }
      this.center.multiplyScalar(1 / 8);
      let radius = 0;
      this.bounds.makeEmpty();
      for (const point of this.vertices) {
        radius = Math.max(radius, point.distanceTo(this.center));
        this.bounds.expandByPoint(
          this.corner.copy(point).applyMatrix4(this.cameraToLight),
        );
      }
      // Rotation-invariant extents prevent swimming when the view rotates.
      radius = Math.ceil(radius * 16) / 16;
      const texel = (2 * radius) / settings.shadowResolution;
      this.center.applyMatrix4(this.cameraToLight);
      this.center.x = Math.floor(this.center.x / texel) * texel;
      this.center.y = Math.floor(this.center.y / texel) * texel;
      this.center.z = this.bounds.max.z + casterReach;
      this.center.applyMatrix4(this.orientation);
      light.position.copy(this.center);
      light.target.position.copy(this.center).add(this.direction);
      light.color.copy(sun.color);
      light.intensity = sun.intensity;
      light.shadow.bias = settings.shadowBias;
      light.shadow.normalBias = settings.shadowNormalBias;
      Object.assign(light.shadow.camera, {
        left: -radius,
        right: radius,
        bottom: -radius,
        top: radius,
        near: 0.1,
        far: this.bounds.max.z - this.bounds.min.z + casterReach + 10,
      });
      light.shadow.camera.updateProjectionMatrix();
    }
    this.group.updateMatrixWorld(true);
    // WebGLRenderer sorts shadow-casting lights ahead of non-shadow lights,
    // retaining traversal order within that group. Other directional lights retain
    // their usual contribution even when inserted before this environment.
    let shadowIndex = 0;
    scene.traverseVisible((object) => {
      if (!camera.layers.test(object.layers)) return;
      if (object instanceof THREE.DirectionalLight && object.castShadow) {
        if (object === this.lights[0])
          this.uniforms.terrainCascadeStart.value = shadowIndex;
        shadowIndex++;
      }
      if (object instanceof THREE.Mesh) {
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          this.bind(material);
      }
    });
  }

  private bind(material: THREE.Material) {
    if (this.materials.has(material) || !isLitMaterial(material)) return;
    const uniforms = materialEffectUniforms(material, this.uniforms);
    this.materials.set(
      material,
      bindMaterialEffect(material, this, {
        key: 'terrain-cascades-v2',
        disposed: () => this.materials.delete(material),
        compile: (shader) => {
          Object.assign(shader.uniforms, uniforms);
          shader.fragmentShader =
            declarations +
            shader.fragmentShader.replace(
              '#include <lights_fragment_begin>',
              cascadeLighting(),
            );
        },
      }),
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const release of this.materials.values()) release();
    this.materials.clear();
    for (const light of this.lights) light.dispose();
    this.group.clear();
  }
}
