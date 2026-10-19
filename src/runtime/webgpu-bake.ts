import * as THREE from 'three';
import { NodeMaterial, RenderTarget } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  varying,
  positionGeometry,
  normalGeometry,
  uv,
  vec3,
  vec4,
  uniform,
  normalize,
  dot,
  cross,
  mix,
  pow,
  max,
  step,
} from 'three/tsl';
import { surfaceUniformValues } from '../render/material';
import { surfaceNodes } from '../render/surface-nodes';
import { gpuDevice, validateGPU } from '../render/renderer';
import { checkSignal } from '../render/resources';
import { terrainExportGeometry } from './bake-material';
import type { TerrainBakeOptions, BakedTerrainSurface } from './bake-material';
import type { TerrainScene } from './terrain-scene';

const baking = new WeakSet<WebGPURenderer>();
export async function bakeWebGPUSurface(
  scene: TerrainScene,
  options: TerrainBakeOptions & { renderer: WebGPURenderer },
): Promise<BakedTerrainSurface> {
  const { renderer, signal, onProgress } = options,
    resolution = options.resolution ?? 2048;
  checkSignal(signal);
  if (baking.has(renderer))
    throw new Error('This renderer is already baking a surface.');
  if (resolution > gpuDevice(renderer).limits.maxTextureDimension2D)
    throw new Error('Surface bake resolution exceeds this GPU’s limits.');
  if (!scene.terrain.children.length)
    throw new Error('Load terrain geometry before baking its surface.');
  baking.add(renderer);
  let prepared:
    Awaited<ReturnType<typeof scene.terrainMaterial.prepare>> | undefined;
  const geometries: THREE.BufferGeometry[] = [],
    textures: THREE.DataTexture[] = [];
  const shader = Object.assign(new NodeMaterial(), {
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
  const target = new RenderTarget(resolution, resolution, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.UnsignedByteType,
  });
  try {
    onProgress?.('Preparing surface maps…');
    prepared = await scene.terrainMaterial.prepare(scene.project, signal);
    checkSignal(signal);
    const values = surfaceUniformValues(
      prepared.value.materials,
      prepared.value.textures.value.arrays,
      prepared.value.textures.value.indices,
    );
    const uniforms = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, { value }]),
    );
    const surface = surfaceNodes(
      uniforms,
      varying(positionGeometry),
      varying(normalGeometry),
      varying(attribute('layerWeights', 'vec4')),
    );
    const channel = uniform(0, 'int');
    const tangent = normalize(varying(attribute('tangent', 'vec4').xyz));
    const normal = normalize(varying(normalGeometry)),
      bitangent = normalize(
        cross(normal, tangent).mul(varying(attribute('tangent', 'vec4').w)),
      );
    shader.vertexNode = vec4(uv().mul(2).sub(1), 0, 1);
    shader.fragmentNode = Fn(() => {
      // Evaluate once outside channel branches: all three outputs share this
      // shader's surface variables, including when exporting normals alone.
      const color = surface.color.toVar(),
        orm = surface.orm.toVar(),
        detailNormal = surface.normal.toVar();
      const value = vec3().toVar();
      If(channel.equal(0), () => {
        const c = max(color, vec3(0));
        value.assign(
          mix(
            pow(c, vec3(1 / 2.4))
              .mul(1.055)
              .sub(0.055),
            c.mul(12.92),
            step(c, vec3(0.0031308)),
          ),
        );
      })
        .ElseIf(channel.equal(1), () => {
          value.assign(vec3(orm.r, orm.g.clamp(0.04, 1), orm.b));
        })
        .Else(() => {
          value.assign(
            normalize(
              vec3(
                dot(tangent, detailNormal),
                dot(bitangent, detailNormal),
                dot(normal, detailNormal),
              ),
            )
              .mul(0.5)
              .add(0.5),
          );
        });
      return vec4(value, 1);
    })();
    const bakeScene = new THREE.Scene(),
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    for (const object of scene.terrain.children) {
      const mesh = object as THREE.Mesh;
      const geometry = terrainExportGeometry(
        mesh.geometry,
        scene.project.size,
        scene.project.view.lowPoly,
        { x: mesh.userData.cellsX, z: mesh.userData.cellsZ },
      );
      geometries.push(geometry);
      const draw = new THREE.Mesh(geometry, shader);
      draw.frustumCulled = false;
      bakeScene.add(draw);
    }
    for (let index = 0; index < 3; index++) {
      checkSignal(signal);
      onProgress?.(
        [
          'Baking base color…',
          'Baking occlusion, roughness and metalness…',
          'Baking detail normals…',
        ][index],
      );
      channel.value = index;
      const pixels = await validateGPU(renderer, async () => {
        const saved = {
          target: renderer.getRenderTarget(),
          mrt: renderer.getMRT(),
          auto: renderer.autoClear,
          clear: renderer.getClearColor(new THREE.Color()),
          alpha: renderer.getClearAlpha(),
        };
        let read: ReturnType<WebGPURenderer['readRenderTargetPixelsAsync']>;
        try {
          renderer.setMRT(null);
          renderer.setRenderTarget(target);
          renderer.autoClear = true;
          renderer.setClearColor(0, 1);
          renderer.render(bakeScene, camera);
          read = renderer.readRenderTargetPixelsAsync(
            target,
            0,
            0,
            resolution,
            resolution,
          );
        } finally {
          // Restore immediately after submission. The host may draw or change
          // targets while readback is pending; don't restore a second time later.
          renderer.setRenderTarget(saved.target);
          renderer.setMRT(saved.mrt);
          renderer.autoClear = saved.auto;
          renderer.setClearColor(saved.clear, saved.alpha);
        }
        const data = await read;
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      });
      checkSignal(signal);
      // WebGPU readback starts at the top; glTF's DataTexture atlas starts at the bottom.
      const oriented = new Uint8Array(pixels.length),
        stride = resolution * 4;
      for (let y = 0; y < resolution; y++)
        oriented.set(
          pixels.subarray(y * stride, (y + 1) * stride),
          (resolution - 1 - y) * stride,
        );
      const map = new THREE.DataTexture(oriented, resolution, resolution);
      map.name = ['Terrain base color', 'Terrain ORM', 'Terrain normal'][index];
      map.colorSpace = index === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      map.magFilter = THREE.LinearFilter;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.generateMipmaps = true;
      map.flipY = false;
      map.needsUpdate = true;
      textures.push(map);
    }
    const material = new THREE.MeshStandardMaterial({
      name: 'Baked terrain PBR',
      map: textures[0],
      aoMap: textures[1],
      roughnessMap: textures[1],
      metalnessMap: textures[1],
      normalMap: textures[2],
      roughness: 1,
      metalness: 1,
    });
    let disposed = false;
    return {
      material,
      resolution,
      dispose() {
        if (disposed) return;
        disposed = true;
        material.dispose();
        textures.forEach((map) => map.dispose());
      },
    };
  } catch (error) {
    textures.forEach((map) => map.dispose());
    throw error;
  } finally {
    prepared?.dispose();
    shader.dispose();
    target.dispose();
    geometries.forEach((g) => g.dispose());
    baking.delete(renderer);
  }
}
