import * as THREE from 'three';
import { validateFlexibilityAttribute } from './foliage-flexibility';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ModelPart } from './models';
import { checkSignal } from './resources';
export interface DecodedModel {
  parts: ModelPart[];
  dispose(): void;
}
export type ModelDecoder = (
  data: string,
  signal?: AbortSignal,
) => Promise<DecodedModel>;

/** Tracks both complete models and dependencies that finish after a failed parse. */
export class ModelResources {
  private seen = new WeakSet<object>();
  private pending: (() => void)[] = [];
  private closed = false;
  private own(value: object, release: () => void) {
    if (this.seen.has(value)) return;
    this.seen.add(value);
    if (this.closed) release();
    else this.pending.push(release);
  }
  collect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach((item) => this.collect(item));
      return;
    }
    if (value instanceof THREE.BufferGeometry)
      this.own(value, () => value.dispose());
    else if (value instanceof THREE.Texture) {
      this.own(value, () => value.dispose());
      const images = Array.isArray(value.source.data)
        ? value.source.data
        : [value.source.data];
      for (const image of images)
        if (image && typeof image.close === 'function')
          this.own(image, () => image.close());
    } else if (value instanceof THREE.Material) {
      this.own(value, () => value.dispose());
      Object.values(value).forEach((item) => {
        if (item instanceof THREE.Texture) this.collect(item);
      });
    } else if (value instanceof THREE.Object3D) {
      if (this.seen.has(value)) return;
      this.seen.add(value);
      if (value instanceof THREE.Mesh) {
        this.collect(value.geometry);
        this.collect(value.material);
        if (value instanceof THREE.SkinnedMesh)
          this.collect(value.skeleton.boneTexture);
      }
      value.children.forEach((child) => this.collect(child));
    }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = [];
    for (const release of pending) release();
  }
}

function dataBytes(data: string) {
  const match = /^data:([^,]*?),(.*)$/s.exec(data);
  if (!match) throw new Error('Models must embed their data.');
  const base64 = match[1].endsWith(';base64');
  const text = base64 ? atob(match[2]) : decodeURIComponent(match[2]);
  const bytes = base64
    ? Uint8Array.from(text, (character) => character.charCodeAt(0))
    : new TextEncoder().encode(text);
  return { bytes, mime: match[1].split(';')[0] || 'application/octet-stream' };
}

export const decodeModel: ModelDecoder = async (data, signal) => {
  checkSignal(signal);
  if (data.length > 120_000_000) throw new Error('GLB must be under 30 MB.');
  const { bytes } = dataBytes(data);
  if (bytes.byteLength > 30_000_000)
    throw new Error('GLB must be under 30 MB.');
  const resources = new ModelResources(),
    manager = new THREE.LoadingManager();
  const created = new Map<string, string>(),
    resolved = new Set<string>();
  let rejected = false;
  const clearCache = () => {
    for (const url of resolved) {
      THREE.Cache.remove(url);
      THREE.Cache.remove('image-bitmap:' + url);
    }
  };
  const cleanupURLs = () => {
    clearCache();
    // Every resolved blob URL is created by this parse (external URIs are rejected).
    for (const url of resolved) URL.revokeObjectURL(url);
    created.clear();
  };
  manager.setURLModifier((url) => {
    checkSignal(signal);
    if (rejected) throw new Error('Model preparation already failed.');
    if (url.startsWith('data:')) {
      if (!created.has(url)) {
        const source = dataBytes(url);
        created.set(
          url,
          URL.createObjectURL(new Blob([source.bytes], { type: source.mime })),
        );
      }
      url = created.get(url)!;
    } else if (!url.startsWith('blob:'))
      throw new Error('GLB assets must embed all textures and geometry.');
    resolved.add(url);
    return url;
  });
  const abort = () => manager.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const loader = new GLTFLoader(manager);
  loader.register((parser) => {
    // Wrap public parser methods without bypassing its extension dispatch or caches.
    const dependency = parser.getDependency.bind(parser),
      geometries = parser.loadGeometries.bind(parser),
      image = parser.loadImageSource.bind(parser),
      assignTexture = parser.assignTexture.bind(parser);
    const track = <T>(value: T) => {
      resources.collect(value);
      if (value instanceof THREE.Texture) value.anisotropy = 8;
      if (rejected) cleanupURLs();
      return value;
    };
    parser.getDependency = (type, index) =>
      dependency(type, index).then((value) => {
        track(value);
        if (type === 'texture' && !value)
          throw new Error('Could not decode GLB texture ' + index + '.');
        return value;
      });
    parser.loadGeometries = (primitives) => geometries(primitives).then(track);
    parser.loadImageSource = (index, sourceLoader) =>
      image(index, sourceLoader).then(track);
    parser.assignTexture = (...args) => assignTexture(...args).then(track);
    return {
      name: 'TERRAIN_owned_resources',
      beforeRoot: () => {
        for (const item of [
          ...(parser.json.buffers ?? []),
          ...(parser.json.images ?? []),
        ])
          if (
            item.uri !== undefined &&
            (typeof item.uri !== 'string' || !item.uri.startsWith('data:'))
          )
            throw new Error('GLB assets must embed all textures and geometry.');
        return null;
      },
    };
  });
  try {
    const gltf = await loader.parseAsync(bytes.buffer, '');
    resources.collect(gltf.scenes);
    checkSignal(signal);
    gltf.scene.updateMatrixWorld(true);
    const parts: ModelPart[] = [];
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.SkinnedMesh)
        throw new Error(
          'Use a static GLB mesh; skinned assets are not supported yet.',
        );
      if (object instanceof THREE.Mesh) {
        validateFlexibilityAttribute(object.geometry);
        parts.push({
          geometry: object.geometry,
          material: object.material,
          matrix: object.matrixWorld.clone(),
        });
      }
    });
    if (!parts.length) throw new Error('The GLB contains no meshes.');
    return { parts, dispose: () => resources.dispose() };
  } catch (error) {
    rejected = true;
    manager.abort();
    resources.dispose();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    cleanupURLs();
  }
};
