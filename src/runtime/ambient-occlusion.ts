import * as THREE from 'three';
import type { EnvironmentSettings } from '../core/environment';
import {
  bindMaterialEffect,
  isLitMaterial,
  materialEffectUniforms,
} from './material-effects';

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
const vertex = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const depthFunctions = /* glsl */ `
uniform sampler2D terrainAODepth;
uniform vec2 terrainAONearFar;
uniform float terrainAOOrtho;
float terrainViewDepth(vec2 uv) {
  float d = texture2D(terrainAODepth, uv).r;
  float n = terrainAONearFar.x, f = terrainAONearFar.y;
  return mix(n * f / (f - d * (f - n)), n + d * (f - n), terrainAOOrtho);
}
`;
const occlusion = /* glsl */ `
varying vec2 vUv;
uniform mat4 inverseProjection;
uniform mat4 projection;
uniform vec2 fullSize;
uniform float radius;
uniform float strength;
${depthFunctions}
vec3 positionAt(vec2 uv) {
  vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, texture2D(terrainAODepth, uv).r * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
void main() {
  if (texture2D(terrainAODepth, vUv).r >= 0.999999) { gl_FragColor = vec4(1.0); return; }
  vec3 p = positionAt(vUv);
  vec2 texel = 1.0 / fullSize;
  vec3 right = positionAt(vUv + vec2(texel.x, 0.0)) - p;
  vec3 left = p - positionAt(vUv - vec2(texel.x, 0.0));
  vec3 top = positionAt(vUv + vec2(0.0, texel.y)) - p;
  vec3 bottom = p - positionAt(vUv - vec2(0.0, texel.y));
  vec3 normal = normalize(cross(abs(right.z) < abs(left.z) ? right : left, abs(top.z) < abs(bottom.z) ? top : bottom));
  float scale = radius * projection[1][1] * 0.5 / mix(max(-p.z, 0.01), 1.0, terrainAOOrtho);
  vec2 screenRadius = vec2(scale * fullSize.y / fullSize.x, scale);
  float sum = 0.0;
  // Fixed, evenly distributed samples avoid animated noise and temporal ghosting.
  for (int i = 0; i < 24; i++) {
    float angle = float(i) * 2.39996323;
    float distance = sqrt((float(i) + 0.5) / 24.0);
    vec2 uv = vUv + vec2(cos(angle), sin(angle)) * screenRadius * distance;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
    vec3 delta = positionAt(uv) - p;
    float len = length(delta);
    float horizon = max(dot(normal, delta) / max(len, 0.001) - 0.08, 0.0);
    sum += horizon * (1.0 - smoothstep(radius * 0.25, radius, len));
  }
  float visibility = clamp(1.0 - strength * sum * (3.0 / 24.0), 0.08, 1.0);
  gl_FragColor = vec4(vec3(visibility), 1.0);
}`;
const blur = /* glsl */ `
varying vec2 vUv;
uniform sampler2D source;
uniform vec2 direction;
uniform float radius;
${depthFunctions}
void main() {
  float depth = terrainViewDepth(vUv);
  float sum = 0.0, weight = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + direction * float(i);
    float w = exp(-float(i * i) / 5.0) * exp(-abs(terrainViewDepth(uv) - depth) / max(radius * 0.08, 0.01));
    sum += texture2D(source, uv).r * w; weight += w;
  }
  gl_FragColor = vec4(vec3(sum / max(weight, 0.001)), 1.0);
}`;
const resolveDeclarations = /* glsl */ `
uniform sampler2D terrainAOMap;
uniform vec2 terrainAOSize;
uniform vec2 terrainAOHalfSize;
uniform float terrainAORadius;
uniform float terrainAOEnabled;
${depthFunctions}
float terrainAmbientVisibility(float fragmentDepth) {
  if (terrainAOEnabled < 0.5) return 1.0;
  vec2 pixel = gl_FragCoord.xy / terrainAOSize * terrainAOHalfSize - 0.5;
  vec2 base = floor(pixel), f = fract(pixel);
  float sum = 0.0, weight = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 offset = vec2(mod(float(i), 2.0), floor(float(i) / 2.0));
    vec2 uv = (base + offset + 0.5) / terrainAOHalfSize;
    vec2 bilinear = mix(1.0 - f, f, offset);
    float w = bilinear.x * bilinear.y * exp(-abs(terrainViewDepth(uv) - fragmentDepth) / max(terrainAORadius * 0.08, 0.01));
    sum += texture2D(terrainAOMap, uv).r * w; weight += w;
  }
  return weight > 0.001 ? sum / weight : 1.0;
}
`;

const materialDeclarations = /* glsl */ `
uniform sampler2D terrainAOMap;
uniform vec2 terrainAOSize;
uniform float terrainAOEnabled;
float terrainAmbientVisibility(float fragmentDepth) {
  if (terrainAOEnabled < 0.5) return 1.0;
  return texture2D(terrainAOMap, gl_FragCoord.xy / terrainAOSize).r;
}
`;

interface DepthBinding {
  material: THREE.MeshDepthMaterial;
  template?: THREE.Material;
  version: number;
  sourceVersion: number;
  dispose: () => void;
}

/** Indirect-only SSAO using the actual cutout/wind/fade shadow materials for depth.
 * Full-resolution depth, half-resolution 24-sample AO and bilateral filtering.
 * Screen-space visibility cannot account for off-screen canopy or bounced light.
 */
export class AmbientOcclusion {
  private readonly depth: THREE.WebGLRenderTarget;
  private readonly ao: THREE.WebGLRenderTarget;
  private readonly scratch: THREE.WebGLRenderTarget;
  private readonly resolved: THREE.WebGLRenderTarget;
  private readonly passScene = new THREE.Scene();
  private readonly passCamera = new THREE.Camera();
  private readonly quad: THREE.Mesh;
  private readonly aoMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly resolveMaterial: THREE.ShaderMaterial;
  private readonly depths = new Map<THREE.Material, DepthBinding>();
  private readonly materials = new Map<THREE.Material, () => void>();
  private readonly size = new THREE.Vector2();
  private readonly halfSize = new THREE.Vector2();
  private readonly nearFar = new THREE.Vector2();
  private readonly shared;
  private readonly materialUniforms;
  private readonly outputUniforms;
  private disposed = false;
  error?: string;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.depth = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.ao = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.scratch = this.ao.clone();
    this.resolved = this.ao.clone();
    this.shared = {
      terrainAODepth: { value: this.depth.depthTexture },
      terrainAONearFar: { value: this.nearFar },
      terrainAOOrtho: { value: 0 },
    };
    this.materialUniforms = {
      ...this.shared,
      terrainAOMap: { value: this.ao.texture },
      terrainAOSize: { value: this.size },
      terrainAOHalfSize: { value: this.halfSize },
      terrainAORadius: { value: 1 },
      terrainAOEnabled: { value: 1 },
    };
    this.outputUniforms = {
      terrainAOMap: { value: this.resolved.texture },
      terrainAOSize: this.materialUniforms.terrainAOSize,
      terrainAOEnabled: this.materialUniforms.terrainAOEnabled,
    };
    this.resolveMaterial = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: `varying vec2 vUv;\n${resolveDeclarations}\nvoid main() {
        gl_FragColor = vec4(vec3(terrainAmbientVisibility(terrainViewDepth(vUv))), 1.0);
      }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: this.materialUniforms,
    });
    this.aoMaterial = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: occlusion,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        ...this.shared,
        inverseProjection: { value: new THREE.Matrix4() },
        projection: { value: new THREE.Matrix4() },
        fullSize: { value: this.size },
        radius: { value: 1 },
        strength: { value: 1 },
      },
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: blur,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        ...this.shared,
        source: { value: this.ao.texture },
        direction: { value: new THREE.Vector2() },
        radius: { value: 1 },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.aoMaterial);
    this.quad.frustumCulled = false;
    this.passScene.add(this.quad);
    try {
      this.resize();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private resize() {
    const target = this.renderer.getRenderTarget();
    const desired = target
      ? new THREE.Vector2(target.width, target.height)
      : this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.size.equals(desired)) return;
    desired.max(new THREE.Vector2(1, 1));
    const halfSize = desired.clone().multiplyScalar(0.5).ceil();
    this.depth.setSize(desired.x, desired.y);
    this.ao.setSize(halfSize.x, halfSize.y);
    this.scratch.setSize(halfSize.x, halfSize.y);
    this.resolved.setSize(desired.x, desired.y);
    for (const target of [this.depth, this.ao, this.scratch, this.resolved])
      this.renderer.initRenderTarget(target);
    this.size.copy(desired);
    this.halfSize.copy(halfSize);
  }

  private depthMaterial(
    source: THREE.Material,
    template: THREE.Material | undefined,
    multisampled: boolean,
  ) {
    let binding = this.depths.get(source);
    if (!binding) {
      const material = new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
        colorWrite: false,
      });
      const dispose = () => {
        material.dispose();
        source.removeEventListener('dispose', dispose);
        this.depths.delete(source);
      };
      binding = { material, template, version: -1, sourceVersion: -1, dispose };
      this.depths.set(source, binding);
      source.addEventListener('dispose', dispose);
    }
    const depth = binding.material;
    const standard = source as THREE.MeshStandardMaterial;
    depth.map = standard.map ?? null;
    depth.alphaMap = standard.alphaMap ?? null;
    depth.alphaTest = source.alphaTest;
    depth.opacity = source.opacity;
    depth.alphaHash = source.alphaHash;
    const alphaToCoverage = multisampled && source.alphaToCoverage;
    if (depth.alphaToCoverage !== alphaToCoverage) {
      depth.alphaToCoverage = alphaToCoverage;
      depth.needsUpdate = true;
    }
    depth.side = source.side;
    depth.displacementMap = standard.displacementMap ?? null;
    depth.displacementScale = standard.displacementScale ?? 1;
    depth.displacementBias = standard.displacementBias ?? 0;
    depth.clippingPlanes = source.clippingPlanes;
    depth.clipIntersection = source.clipIntersection;
    depth.polygonOffset = source.polygonOffset;
    depth.polygonOffsetFactor = source.polygonOffsetFactor;
    depth.polygonOffsetUnits = source.polygonOffsetUnits;
    depth.visible =
      source.visible &&
      !source.transparent &&
      source.depthWrite &&
      source.depthTest &&
      source.depthFunc === THREE.LessEqualDepth &&
      !source.stencilWrite &&
      !standard.wireframe;
    if (binding.sourceVersion !== source.version) {
      binding.sourceVersion = source.version;
      depth.needsUpdate = true;
    }
    if (
      binding.template !== template ||
      binding.version !== (template?.version ?? 0)
    ) {
      depth.onBeforeCompile = (shader, renderer) => {
        template?.onBeforeCompile(shader, renderer);
        // Color writes are disabled, but alpha-to-coverage still consumes output
        // alpha. Packed depth alpha would give leaves incorrect MSAA coverage.
        shader.fragmentShader = shader.fragmentShader.replace(
          /\}\s*$/,
          'gl_FragColor = vec4(0.0, 0.0, 0.0, diffuseColor.a);\n}',
        );
      };
      depth.customProgramCacheKey = () =>
        'terrain-ao-depth-v2|' + (template?.customProgramCacheKey() ?? '');
      binding.template = template;
      binding.version = template?.version ?? 0;
      depth.needsUpdate = true;
    }
    return depth;
  }

  private bind(material: THREE.Material) {
    if (
      this.materials.has(material) ||
      !isLitMaterial(material) ||
      material.transparent
    )
      return;
    const uniforms = materialEffectUniforms(material, this.outputUniforms);
    this.materials.set(
      material,
      bindMaterialEffect(material, this, {
        key: 'terrain-indirect-ao-v2',
        disposed: () => this.materials.delete(material),
        compile: (shader) => {
          Object.assign(shader.uniforms, uniforms);
          shader.fragmentShader =
            materialDeclarations +
            shader.fragmentShader.replace(
              '#include <aomap_fragment>',
              `#include <aomap_fragment>
          float terrainAO = terrainAmbientVisibility(vViewPosition.z);
          reflectedLight.indirectDiffuse *= terrainAO;
          #if defined(STANDARD) && defined(USE_ENVMAP)
            reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), terrainAO, material.roughness);
          #else
            reflectedLight.indirectSpecular *= terrainAO;
          #endif
          #ifdef USE_CLEARCOAT
            clearcoatSpecularIndirect *= terrainAO;
          #endif
          #ifdef USE_SHEEN
            sheenSpecularIndirect *= terrainAO;
          #endif
        `,
            );
        },
      }),
    );
  }

  /** Render a full viewport. State is restored even when preparation/rendering fails. */
  render(
    scene: THREE.Scene,
    camera: Camera,
    settings: NonNullable<EnvironmentSettings['ambientOcclusion']>,
  ) {
    const renderer = this.renderer;
    this.resize();
    this.nearFar.set(camera.near, camera.far);
    this.shared.terrainAOOrtho.value =
      camera instanceof THREE.OrthographicCamera ? 1 : 0;
    this.materialUniforms.terrainAORadius.value = settings.radius;
    this.aoMaterial.uniforms.inverseProjection.value.copy(
      camera.projectionMatrixInverse,
    );
    this.aoMaterial.uniforms.projection.value.copy(camera.projectionMatrix);
    this.aoMaterial.uniforms.radius.value =
      this.blurMaterial.uniforms.radius.value = settings.radius;
    this.aoMaterial.uniforms.strength.value = settings.strength;
    const saved = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      clear: renderer.getClearColor(new THREE.Color()),
      alpha: renderer.getClearAlpha(),
      auto: renderer.autoClear,
      autoDepth: renderer.autoClearDepth,
      shadow: renderer.shadowMap.autoUpdate,
      needsShadow: renderer.shadowMap.needsUpdate,
      xr: renderer.xr.enabled,
      background: scene.background,
      override: scene.overrideMaterial,
    };
    // The temporal HDR target already owns a sampleable depth attachment. Keep
    // that prepass for the beauty pass, so hidden foliage fails depth testing
    // before expensive PBR shading. Direct canvas rendering retains its own depth.
    const reuseDepth = !!(
      saved.target?.depthTexture &&
      saved.target.depthBuffer &&
      !(saved.target instanceof THREE.WebGLCubeRenderTarget) &&
      saved.target.depth === 1 &&
      saved.face === 0 &&
      saved.mip === 0 &&
      saved.auto &&
      saved.autoDepth &&
      !saved.override &&
      !saved.xr
    );
    const depthTarget = reuseDepth ? saved.target! : this.depth;
    this.shared.terrainAODepth.value = depthTarget.depthTexture!;
    const swaps: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const hidden: THREE.Object3D[] = [];
    try {
      scene.traverseVisible((object) => {
        if (object instanceof THREE.Mesh) {
          const source = Array.isArray(object.material)
            ? object.material
            : [object.material];
          if (
            source.some((m) => m instanceof THREE.ShaderMaterial) &&
            !object.customDepthMaterial
          ) {
            hidden.push(object);
            return;
          }
          for (const material of source) this.bind(material);
          swaps.push([object, object.material]);
          const materials = source.map((material) =>
            this.depthMaterial(
              material,
              object.customDepthMaterial,
              depthTarget.samples > 0,
            ),
          );
          object.material = Array.isArray(object.material)
            ? materials
            : materials[0];
        } else if (
          object instanceof THREE.Line ||
          object instanceof THREE.Points ||
          object instanceof THREE.Sprite
        )
          hidden.push(object);
      });
      for (const object of hidden) object.visible = false;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      renderer.autoClearDepth = true;
      scene.background = null;
      scene.overrideMaterial = null;
      renderer.setClearColor(0xffffff, 1);
      renderer.setRenderTarget(depthTarget);
      renderer.render(scene, camera);
      this.quad.material = this.aoMaterial;
      renderer.setRenderTarget(this.ao);
      renderer.render(this.passScene, this.passCamera);
      this.quad.material = this.blurMaterial;
      this.blurMaterial.uniforms.source.value = this.ao.texture;
      this.blurMaterial.uniforms.direction.value.set(1 / this.halfSize.x, 0);
      renderer.setRenderTarget(this.scratch);
      renderer.render(this.passScene, this.passCamera);
      this.blurMaterial.uniforms.source.value = this.scratch.texture;
      this.blurMaterial.uniforms.direction.value.set(0, 1 / this.halfSize.y);
      renderer.setRenderTarget(this.ao);
      renderer.render(this.passScene, this.passCamera);
      this.error = undefined;
      this.materialUniforms.terrainAOEnabled.value = 1;
      this.quad.material = this.resolveMaterial;
      renderer.setRenderTarget(this.resolved);
      renderer.render(this.passScene, this.passCamera);
    } finally {
      for (const [object, material] of swaps) object.material = material;
      for (const object of hidden) object.visible = true;
      scene.background = saved.background;
      scene.overrideMaterial = saved.override;
      renderer.shadowMap.autoUpdate = saved.shadow;
      renderer.shadowMap.needsUpdate = saved.needsShadow;
      renderer.xr.enabled = saved.xr;
      renderer.autoClear = saved.auto;
      renderer.autoClearDepth = saved.autoDepth;
      renderer.setClearColor(saved.clear, saved.alpha);
      renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    }
    try {
      if (reuseDepth) renderer.autoClearDepth = false;
      renderer.render(scene, camera);
    } finally {
      renderer.autoClearDepth = saved.autoDepth;
    }
  }

  suspend(error: unknown) {
    this.error = String(error);
    this.materialUniforms.terrainAOEnabled.value = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of this.materials.values()) release();
    this.materials.clear();
    for (const binding of this.depths.values()) binding.dispose();
    for (const target of [this.depth, this.ao, this.scratch, this.resolved])
      target.dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    this.resolveMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
