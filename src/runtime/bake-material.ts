import * as THREE from 'three';
import type { TerrainScene } from './terrain-scene';
import { surfaceUniformValues } from '../render/material';
import {
  surfaceDeclarations,
  surfaceEvaluation,
} from '../render/surface-shader';
import { checkSignal } from '../render/resources';
import { isWebGPU } from '../render/renderer';
import type { TerrainRenderer } from '../render/renderer';
import { bakeWebGPUSurface } from './webgpu-bake';

export type TerrainBakeResolution = 256 | 512 | 1024 | 2048 | 4096;
export interface TerrainBakeOptions {
  renderer: TerrainRenderer;
  resolution?: TerrainBakeResolution;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export interface BakedTerrainSurface {
  material: THREE.MeshStandardMaterial;
  resolution: number;
  /** Releases only the baked material/maps, never the source scene. */
  dispose(): void;
}
const baking = new WeakSet<THREE.WebGLRenderer>();

/** Owns its geometry. Shared atlas UVs run across all chunks; flat exports carry actual face normals. */
export function terrainExportGeometry(
  source: THREE.BufferGeometry,
  size: number,
  lowPoly: boolean,
  filledGrid?: { x: number; z: number },
) {
  let geometry = source.clone();
  try {
    if (filledGrid) {
      const indices = new Uint32Array(filledGrid.x * filledGrid.z * 6);
      let at = 0;
      for (let z = 0; z < filledGrid.z; z++)
        for (let x = 0; x < filledGrid.x; x++) {
          const a = z * (filledGrid.x + 1) + x,
            b = a + 1,
            c = a + filledGrid.x + 1,
            d = c + 1;
          indices.set([a, c, b, b, c, d], at);
          at += 6;
        }
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    if (lowPoly) {
      const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
      geometry.dispose();
      geometry = flat;
      geometry.computeVertexNormals();
    }
    const positions = geometry.getAttribute('position'),
      normals = geometry.getAttribute('normal');
    const uv = new Float32Array(positions.count * 2),
      tangents = new Float32Array(positions.count * 4);
    const tangent = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      uv[i * 2] = positions.getX(i) / size + 0.5;
      uv[i * 2 + 1] = 0.5 - positions.getZ(i) / size;
      // A stable tangent for the heightfield's +X / -Z UV orientation.
      tangent.set(normals.getY(i), -normals.getX(i), 0).normalize();
      tangent.toArray(tangents, i * 4);
      tangents[i * 4 + 3] = 1;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('tangent', new THREE.BufferAttribute(tangents, 4));
    return geometry;
  } catch (error) {
    geometry.dispose();
    throw error;
  }
}

/**
 * Bake the production layered shader into standard glTF surface maps.
 * Keep source scene/project resources alive and unchanged until this resolves.
 * The host renderer can keep rendering between bake passes; its target/clear/XR state is restored.
 */
export async function bakeTerrainSurface(
  scene: TerrainScene,
  options: TerrainBakeOptions,
): Promise<BakedTerrainSurface> {
  const { renderer, signal, onProgress } = options,
    resolution = options.resolution ?? 2048;
  if (![256, 512, 1024, 2048, 4096].includes(resolution))
    throw new Error('Unsupported surface bake resolution.');
  if (isWebGPU(renderer))
    return bakeWebGPUSurface(scene, { ...options, renderer });
  if (baking.has(renderer))
    throw new Error('This renderer is already baking a surface.');
  checkSignal(signal);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (gl.isContextLost())
    throw new Error('Cannot bake with a lost WebGL context.');
  const viewportLimit = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  if (
    resolution >
    Math.min(
      renderer.capabilities.maxTextureSize,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      ...viewportLimit,
    )
  )
    throw new Error('Surface bake resolution exceeds this GPU’s limits.');
  if (!scene.terrain.children.length)
    throw new Error('Load terrain geometry before baking its surface.');
  baking.add(renderer);
  const geometries: THREE.BufferGeometry[] = [],
    textures: THREE.DataTexture[] = [];
  let prepared:
    Awaited<ReturnType<typeof scene.terrainMaterial.prepare>> | undefined;
  let shader: THREE.ShaderMaterial | undefined,
    target: THREE.WebGLRenderTarget | undefined;
  try {
    onProgress?.('Preparing surface maps…');
    prepared = await scene.terrainMaterial.prepare(scene.project, signal);
    checkSignal(signal);
    const values = surfaceUniformValues(
      prepared.value.materials,
      prepared.value.textures.value.arrays,
    );
    const uniforms: Record<string, THREE.IUniform> = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, { value }]),
    );
    uniforms.bakeChannel = { value: 0 };
    shader = new THREE.ShaderMaterial({
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
      vertexShader: `
        attribute vec4 layerWeights; attribute vec4 tangent;
        varying vec4 vWeights; varying vec3 vTerrain; varying vec3 vTerrainNormal;
        varying vec3 vBakeTangent; varying vec3 vBakeBitangent;
        void main() {
          vWeights=layerWeights; vTerrain=position; vTerrainNormal=normal;
          vBakeTangent=normalize(tangent.xyz); vBakeBitangent=normalize(cross(normal,vBakeTangent)*tangent.w);
          gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
        }`,
      fragmentShader:
        surfaceDeclarations +
        `
        varying vec3 vBakeTangent; varying vec3 vBakeBitangent;
        uniform int bakeChannel;
        vec3 toSrgb(vec3 v) {
          v=max(v,vec3(0.0));
          return mix(1.055*pow(v,vec3(1.0/2.4))-0.055,12.92*v,lessThanEqual(v,vec3(0.0031308)));
        }
        void main() {
          vec4 diffuseColor=vec4(1.0);
          ` +
        surfaceEvaluation +
        `
          vec3 result;
          if(bakeChannel==0) result=toSrgb(surface);
          else if(bakeChannel==1) result=vec3(surfaceAo,clamp(surfaceRoughness,0.04,1.0),surfaceMetalness);
          else {
            mat3 frame=mat3(normalize(vBakeTangent),normalize(vBakeBitangent),normalize(vTerrainNormal));
            result=normalize(inverse(frame)*normalize(surfaceNormal))*0.5+0.5;
          }
          gl_FragColor=vec4(result,1.0);
        }`,
    });
    const bakeScene = new THREE.Scene(),
      camera = new THREE.Camera();
    for (const object of scene.terrain.children) {
      const mesh = object as THREE.Mesh;
      // Fill only the bake mesh so sampling near hole rims never pulls in a blank atlas texel.
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
    target = new THREE.WebGLRenderTarget(resolution, resolution, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    const stages = [
      'Baking base color…',
      'Baking occlusion, roughness and metalness…',
      'Baking detail normals…',
    ];
    for (let channel = 0; channel < 3; channel++) {
      checkSignal(signal);
      onProgress?.(stages[channel]);
      checkSignal(signal);
      uniforms.bakeChannel.value = channel;
      const pixels = new Uint8Array(resolution * resolution * 4);
      const previous = {
        target: renderer.getRenderTarget(),
        face: renderer.getActiveCubeFace(),
        mip: renderer.getActiveMipmapLevel(),
        clear: renderer.getClearColor(new THREE.Color()),
        alpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear,
        xr: renderer.xr.enabled,
        shadows: renderer.shadowMap.enabled,
        pack: gl.getParameter(
          gl.PIXEL_PACK_BUFFER_BINDING,
        ) as WebGLBuffer | null,
      };
      let read: Promise<unknown>;
      try {
        renderer.xr.enabled = false;
        renderer.shadowMap.enabled = false;
        renderer.autoClear = true;
        renderer.setClearColor(0, 1);
        renderer.setRenderTarget(target);
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        )
          throw new Error(
            'The GPU could not allocate the surface atlas. Choose a smaller bake resolution.',
          );
        renderer.render(bakeScene, camera);
        read = renderer.readRenderTargetPixelsAsync(
          target,
          0,
          0,
          resolution,
          resolution,
          pixels,
        );
      } finally {
        // Three's asynchronous read keeps its pack buffer bound until its fence completes.
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous.pack);
        renderer.setRenderTarget(previous.target, previous.face, previous.mip);
        renderer.setClearColor(previous.clear, previous.alpha);
        renderer.autoClear = previous.autoClear;
        renderer.xr.enabled = previous.xr;
        renderer.shadowMap.enabled = previous.shadows;
      }
      try {
        await read;
      } finally {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous.pack);
      }
      checkSignal(signal);
      if (gl.isContextLost())
        throw new Error('WebGL context was lost during the surface bake.');
      const texture = new THREE.DataTexture(pixels, resolution, resolution);
      texture.name = ['Terrain base color', 'Terrain ORM', 'Terrain normal'][
        channel
      ];
      texture.colorSpace =
        channel === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.flipY = false;
      texture.needsUpdate = true;
      textures.push(texture);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    checkSignal(signal);
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
        textures.forEach((texture) => texture.dispose());
      },
    };
  } catch (error) {
    textures.forEach((texture) => texture.dispose());
    throw error;
  } finally {
    prepared?.dispose();
    shader?.dispose();
    target?.dispose();
    geometries.forEach((geometry) => geometry.dispose());
    baking.delete(renderer);
  }
}
