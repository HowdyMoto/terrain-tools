import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { MaterialLayer } from '../core/types';
import type { WorldAssets } from './world-assets';
import { checkSignal } from '../render/resources';

export type SurfaceArray =
  THREE.DataArrayTexture | THREE.CompressedArrayTexture;
export interface PreparedMapFile {
  file: string;
  bytes: number;
  sha256: string;
}
export interface MaterialLibraryManifest {
  size: number;
  layers: MaterialLayer[];
  maps: Record<'albedo' | 'normal' | 'orm' | 'height', PreparedMapFile>;
}
const keys = ['albedo', 'normal', 'orm', 'height'] as const;
const fingerprint = (layer: MaterialLayer) =>
  JSON.stringify([
    layer.id,
    layer.textures.albedo,
    layer.textures.normal,
    layer.textures.orm,
    layer.textures.height,
    layer.proceduralVariant,
  ]);

/** Verified, compressed arrays shared by any four-slot palette in a world.
 * Keep this loader alive until all associated WorldAssets requests have settled.
 * The manifest's layer definitions are the authoritative prepared material inputs.
 */
export class RuntimeMaterialLibrary {
  readonly manifest: MaterialLibraryManifest;
  private loader: KTX2Loader;
  private fingerprints: string[];
  private key: string;
  constructor(
    renderer: THREE.WebGLRenderer,
    manifest: MaterialLibraryManifest,
    readonly baseURL: string,
    transcoderPath = '/basis/',
  ) {
    this.manifest = structuredClone(manifest);
    if (
      ![256, 512, 1024, 2048].includes(manifest.size) ||
      manifest.layers.length < 4 ||
      manifest.layers.length > 32 ||
      new Set(manifest.layers.map((l) => l.id)).size !== manifest.layers.length
    )
      throw new Error('Invalid prepared material library.');
    for (const key of keys) {
      const map = manifest.maps[key];
      if (
        !map ||
        !/^[a-f0-9]{64}$/.test(map.sha256) ||
        !Number.isSafeInteger(map.bytes) ||
        map.bytes <= 0 ||
        map.bytes > 128 * 1024 ** 2
      )
        throw new Error('Invalid prepared texture metadata.');
    }
    this.fingerprints = manifest.layers.map(fingerprint);
    this.key =
      'ktx-surfaces:' + keys.map((k) => manifest.maps[k].sha256).join(':');
    this.loader = new KTX2Loader()
      .setTranscoderPath(transcoderPath)
      .setWorkerLimit(2)
      .detectSupport(renderer);
  }
  palette(indices: readonly number[]): MaterialLayer[] {
    if (
      indices.length !== 4 ||
      indices.some((i) => !Number.isInteger(i) || !this.manifest.layers[i])
    )
      throw new Error('A tile requires four valid material library indices.');
    return indices.map((i) => structuredClone(this.manifest.layers[i]));
  }
  async prepare(
    assets: WorldAssets,
    materials: MaterialLayer[],
    size: number,
    signal?: AbortSignal,
  ) {
    const indices = materials.map((l) =>
      this.fingerprints.indexOf(fingerprint(l)),
    );
    if (indices.some((i) => i < 0))
      throw new Error(
        'Tile material inputs do not match the prepared library.',
      );
    if (indices.length !== 4 || size !== this.manifest.size)
      throw new Error(
        'Tile texture resolution does not match the prepared library.',
      );
    const encodedBytes = keys.reduce(
      (n, k) => n + this.manifest.maps[k].bytes,
      0,
    );
    // Allow the loader's uncompressed fallback. Actual transcode bytes replace the reservation.
    const ceiling = Math.ceil(
      size * size * 4 * this.manifest.layers.length * 4 * 1.34,
    );
    const lease = await assets.acquire(
      this.key,
      { encodedBytes, cpuBytes: ceiling, gpuBytes: ceiling },
      encodedBytes + ceiling,
      async (loadSignal) => {
        const arrays: SurfaceArray[] = [];
        try {
          for (const key of keys) {
            checkSignal(loadSignal);
            const map = this.manifest.maps[key];
            const response = await fetch(new URL(map.file, this.baseURL), {
              signal: loadSignal,
            });
            if (!response.ok || !response.body)
              throw new Error('Could not fetch prepared texture ' + key);
            const reader = response.body.getReader(),
              bytes = new Uint8Array(map.bytes);
            let offset = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (offset + chunk.value.length > bytes.length)
                  throw new Error('Prepared texture exceeds declared size.');
                bytes.set(chunk.value, offset);
                offset += chunk.value.length;
              }
            } finally {
              await reader.cancel();
            }
            if (offset !== bytes.length)
              throw new Error('Truncated prepared texture.');
            const hash = [
              ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            ]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
            if (hash !== map.sha256)
              throw new Error('Prepared texture hash mismatch.');
            checkSignal(loadSignal);
            const texture = await new Promise<THREE.Texture>(
              (resolve, reject) =>
                this.loader.parse(bytes.buffer, resolve, reject),
            );
            if (!(
              texture instanceof THREE.CompressedArrayTexture ||
              texture instanceof THREE.DataArrayTexture
            )) {
              texture.dispose();
              throw new Error('Expected a prepared texture array.');
            }
            arrays.push(texture);
            checkSignal(loadSignal);
            if (
              texture.image.width !== size ||
              texture.image.height !== size ||
              texture.image.depth !== this.manifest.layers.length
            )
              throw new Error(
                'Prepared texture dimensions do not match its manifest.',
              );
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            texture.anisotropy = 8;
            texture.colorSpace =
              key === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          }
          const cpuBytes = arrays.reduce(
            (sum, texture) =>
              sum +
              Math.max(
                'data' in texture.image ? texture.image.data.byteLength : 0,
                texture.mipmaps.reduce(
                  (n, m) => n + ('data' in m ? m.data.byteLength : 0),
                  0,
                ),
              ),
            0,
          );
          return {
            value: arrays,
            encodedBytes: 0,
            cpuBytes,
            gpuBytes: cpuBytes,
            dispose: () => arrays.forEach((t) => t.dispose()),
          };
        } catch (error) {
          arrays.forEach((t) => t.dispose());
          throw error;
        }
      },
      signal,
    );
    return { lease, indices };
  }
  dispose() {
    this.loader.dispose();
  }
}
