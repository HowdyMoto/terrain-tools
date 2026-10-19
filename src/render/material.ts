import * as THREE from 'three';
import { noise } from '../core/math';
import type { TerrainProject, MaterialLayer } from '../core/types';
import {
  PreparedResource,
  SharedResource,
  checkSignal,
  linkedController,
} from './resources';
import { surfaceDeclarations, surfaceEvaluation } from './surface-shader';
import { shoreDeclarations } from '../runtime/water-shore';
const keys = ['albedo', 'normal', 'orm', 'height'] as const;
type MapKey = (typeof keys)[number];
interface SurfaceTextures {
  arrays: THREE.DataArrayTexture[];
  sources: (string | number)[];
  size: number;
}
interface SurfaceState {
  textures: SharedResource<SurfaceTextures>;
  materials: MaterialLayer[];
  uniforms: [string, THREE.IUniform][];
  lowPoly: boolean;
  wireframe: boolean;
}
export type PreparedMaterial = PreparedResource<SurfaceState>;
export class TerrainMaterial {
  readonly material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 1,
  });
  private textures?: SharedResource<SurfaceTextures>;
  private disposed = false;
  private requests = new Set<AbortController>();
  private updating?: AbortController;
  private uniforms: Record<string, THREE.IUniform> = {};
  /** Stable uniforms supplied by TerrainWater; empty effects preserve legacy terrain. */
  readonly shoreUniforms = {
    terrainShore: { value: null as THREE.Texture | null },
    terrainShoreSize: { value: 1 },
    terrainShoreCells: { value: 1 },
    terrainShoreTime: { value: 0 },
    terrainShoreEnabled: { value: 0 },
  };
  constructor() {
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      Object.assign(shader.uniforms, this.shoreUniforms);
      shader.vertexShader =
        'attribute vec4 layerWeights;varying vec4 vWeights;varying vec3 vTerrain;varying vec3 vTerrainNormal;\n' +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWeights=layerWeights;vTerrain=position;vTerrainNormal=normal;',
      );
      shader.fragmentShader =
        surfaceDeclarations + shoreDeclarations + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        surfaceEvaluation +
          `
        vec4 shore = terrainShoreAt(vTerrain.xz);
        diffuseColor.rgb *= 1.0 - shore.r * 0.45;
        surfaceRoughness = mix(surfaceRoughness,min(surfaceRoughness,0.22),shore.r);
        `,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor=clamp(surfaceRoughness,0.04,1.0);',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <metalnessmap_fragment>',
        'float metalnessFactor=clamp(surfaceMetalness,0.0,1.0);',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        'normal=normalize(normalMatrix*normalize(surfaceNormal));',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        `if(shore.g>0.001) {
          float caustic=terrainCaustic(vTerrain.xz,shore.b,shore.a);
          reflectedLight.directDiffuse*=max(0.0,1.0+caustic*shore.g*max(0.0,terrainN.y));
        }
        reflectedLight.indirectDiffuse*=surfaceAo;
        #if defined(USE_ENVMAP) && defined(STANDARD)
          reflectedLight.indirectSpecular*=computeSpecularOcclusion(saturate(dot(geometryNormal,geometryViewDir)),surfaceAo,material.roughness);
        #endif
        #include <aomap_fragment>
      `,
      );
    };
    this.material.customProgramCacheKey = () =>
      'terrain-pbr-triplanar-v5-shore';
  }
  private procedural(key: MapKey, layer: number) {
    const size = 256,
      canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!,
      image = ctx.createImageData(size, size);
    for (let z = 0; z < size; z++)
      for (let x = 0; x < size; x++) {
        const f = noise(x * 0.14, z * 0.14, layer * 72),
          detail = noise(x * 0.65, z * 0.65, layer + 1),
          v = 190 + f * 40 + detail * 25,
          i = (z * size + x) * 4;
        image.data.set(
          key === 'normal'
            ? [128 + (f - 0.5) * 22, 128 + (detail - 0.5) * 22, 254, 255]
            : key === 'orm'
              ? [220 + f * 35, 220 + detail * 35, 255, 255]
              : key === 'height'
                ? [f * 255, f * 255, f * 255, 255]
                : [v, v, v, 255],
          i,
        );
      }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }
  private image(
    source: string,
    signal: AbortSignal,
  ): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        image.src = '';
        reject(new DOMException('Preparation cancelled.', 'AbortError'));
      };
      image.onload = () => {
        cleanup();
        resolve(image);
      };
      image.onerror = () => {
        cleanup();
        image.src = '';
        reject(new Error('Could not decode texture.'));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      image.src = source;
    });
  }
  async prepare(
    p: TerrainProject,
    signal?: AbortSignal,
  ): Promise<PreparedMaterial> {
    if (this.disposed) throw new Error('Terrain material has been disposed.');
    const { controller, unlink } = linkedController(signal);
    this.requests.add(controller);
    const size = p.view.textureResolution ?? 512;
    const materials = p.materials.map((material) => ({
      ...material,
      textures: { ...material.textures },
    }));
    const lowPoly = p.view.lowPoly,
      wireframe = p.view.wireframe;
    const sources = keys.flatMap((key) =>
      materials.map(
        (material, layer) =>
          material.textures[key] ?? material.proceduralVariant ?? layer,
      ),
    );
    let textures: SharedResource<SurfaceTextures> | undefined;
    const arrays: THREE.DataArrayTexture[] = [];
    try {
      checkSignal(controller.signal);
      if (![256, 512, 1024, 2048].includes(size))
        throw new Error('Unsupported terrain texture resolution.');
      const current = this.textures?.value;
      if (
        current &&
        current.size === size &&
        sources.every((source, i) => source === current.sources[i])
      )
        textures = this.textures!.retain();
      else {
        // Yield between channels so cancellation can stop the next large allocation.
        for (const key of keys) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkSignal(controller.signal);
          const data = new Uint8Array(size * size * 4 * 4),
            canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const context = canvas.getContext('2d', {
            willReadFrequently: true,
          })!;
          try {
            for (let layer = 0; layer < 4; layer++) {
              checkSignal(controller.signal);
              const source = materials[layer].textures[key];
              let image: CanvasImageSource;
              if (source) {
                try {
                  image = await this.image(source, controller.signal);
                } catch (error) {
                  checkSignal(controller.signal);
                  throw new Error(
                    'Could not decode ' +
                      materials[layer].name +
                      ' ' +
                      key +
                      ' texture.',
                    { cause: error },
                  );
                }
              } else
                image = this.procedural(
                  key,
                  materials[layer].proceduralVariant ?? layer,
                );
              try {
                checkSignal(controller.signal);
                context.clearRect(0, 0, size, size);
                context.drawImage(image, 0, 0, size, size);
                data.set(
                  context.getImageData(0, 0, size, size).data,
                  layer * size * size * 4,
                );
              } finally {
                if (image instanceof HTMLImageElement) image.src = '';
                else if (image instanceof HTMLCanvasElement) {
                  image.width = 0;
                  image.height = 0;
                }
              }
            }
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
          const texture = new THREE.DataArrayTexture(data, size, size, 4);
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          // Preserve grazing-angle ground detail; WebGL clamps to device support.
          texture.anisotropy = 8;
          texture.generateMipmaps = true;
          texture.colorSpace =
            key === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          texture.needsUpdate = true;
          arrays.push(texture);
        }
        textures = new SharedResource({ arrays, sources, size }, () =>
          arrays.forEach((texture) => texture.dispose()),
        );
      }
      checkSignal(controller.signal);
      const retained = textures;
      const uniforms: [string, THREE.IUniform][] = Object.entries(
        surfaceUniformValues(materials, textures.value.arrays),
      ).map(([key, value]) => [key, { value }]);
      return new PreparedResource(
        this,
        { textures, materials, uniforms, lowPoly, wireframe },
        () => retained.release(),
      );
    } catch (error) {
      if (textures) textures.release();
      else arrays.forEach((texture) => texture.dispose());
      throw error;
    } finally {
      this.requests.delete(controller);
      unlink();
    }
  }
  assertPrepared(prepared: PreparedMaterial) {
    if (this.disposed) throw new Error('Terrain material has been disposed.');
    prepared.assert(this);
  }
  apply(prepared: PreparedMaterial) {
    this.assertPrepared(prepared);
    this.updating?.abort();
    const state = prepared.take(this),
      previous = this.textures;
    this.textures = state.textures;
    for (const [key, uniform] of state.uniforms) {
      if (this.uniforms[key]) this.uniforms[key].value = uniform.value;
      else this.uniforms[key] = uniform;
    }
    if (this.material.flatShading !== state.lowPoly) {
      this.material.flatShading = state.lowPoly;
      this.material.needsUpdate = true;
    }
    this.material.wireframe = state.wireframe;
    previous?.release();
  }
  /** Latest update wins; failed or cancelled preparation leaves the current material untouched. */
  async update(p: TerrainProject, signal?: AbortSignal) {
    this.updating?.abort();
    const { controller, unlink } = linkedController(signal);
    this.updating = controller;
    let prepared: PreparedMaterial | undefined;
    try {
      prepared = await this.prepare(p, controller.signal);
      checkSignal(controller.signal);
      this.updating = undefined;
      this.apply(prepared);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      prepared?.dispose();
      if (this.updating === controller) this.updating = undefined;
      unlink();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.updating?.abort();
    this.requests.forEach((controller) => controller.abort());
    this.textures?.release();
    this.textures = undefined;
    this.material.dispose();
  }
}

/** Shared by live rendering and offline surface baking. Texture ownership stays with the caller. */
export function surfaceUniformValues(
  materials: MaterialLayer[],
  arrays: THREE.DataArrayTexture[],
) {
  const vector = (values: number[]) =>
    new THREE.Vector4(values[0], values[1], values[2], values[3]);
  return {
    terrainAlbedo: arrays[0],
    terrainNormal: arrays[1],
    terrainOrm: arrays[2],
    terrainHeight: arrays[3],
    layerColors: materials.map((m) => new THREE.Color(m.color)),
    layerRoughness: vector(materials.map((m) => m.roughness)),
    layerMetalness: vector(materials.map((m) => m.metalness)),
    layerScale: vector(materials.map((m) => m.tileSize)),
    layerVariation: vector(materials.map((m) => (m.reduceTiling ? 1 : 0))),
    layerBlend: vector(materials.map((m) => m.blendHeight)),
    layerNormalY: vector(
      materials.map((m) => (m.normalConvention === 'directx' ? -1 : 1)),
    ),
    layerNormalStrength: vector(materials.map((m) => m.normalStrength ?? 1)),
  };
}
