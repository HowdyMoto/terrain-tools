/// <reference types="@webgpu/types" />
import { WebGPURenderer, PCFShadowMap } from 'three/webgpu';
import type { WebGLRenderer, Texture } from 'three';
import { installShaderRetention } from './shader-cache';
import { installTerrainLighting } from './node-lighting';
import { installSharedGeometryOwnership } from './shared-geometry';

export type TerrainRenderer = WebGPURenderer | WebGLRenderer;
export function isWebGPU(renderer?: unknown): renderer is WebGPURenderer {
  return !!(renderer as WebGPURenderer | undefined)?.isWebGPURenderer;
}

/** Native WebGPU is required. Never silently run the WebGL fallback backend. */
export async function createTerrainRenderer({
  timestamps = false,
}: { timestamps?: boolean } = {}) {
  if (!navigator.gpu)
    throw new Error(
      'Terrain Studio requires WebGPU. Open it in current Chrome or Edge with hardware acceleration enabled.',
    );
  const renderer = new WebGPURenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    trackTimestamp: timestamps,
  });
  try {
    await renderer.init();
    gpuDevice(renderer);
    installTerrainLighting(renderer);
    installShaderRetention(renderer);
    installSharedGeometryOwnership(renderer);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    return renderer;
  } catch (error) {
    try {
      renderer.dispose();
    } catch {
      /* Initialization may fail before Three creates its managers. */
    }
    throw new Error(
      'Could not initialize native WebGPU. Check browser hardware acceleration and the dedicated GPU driver.',
      { cause: error },
    );
  }
}

/** Backend details are isolated here because the public renderer types omit native backend details. */
export function gpuDevice(renderer: WebGPURenderer): GPUDevice {
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean;
    device?: GPUDevice;
  };
  if (!backend.isWebGPUBackend || !backend.device)
    throw new Error('A ready native WebGPU renderer is required.');
  return backend.device;
}

export function rendererDescription(renderer: WebGPURenderer) {
  const info = gpuDevice(renderer).adapterInfo;
  return `WebGPU · ${info.description || [info.vendor, info.architecture, info.device].filter(Boolean).join(' ')}`;
}

/** GPU error scopes turn otherwise asynchronous validation failures into a
 * rejected preparation, before document/history/resource ownership changes. */
const validationQueues = new WeakMap<GPUDevice, Promise<unknown>>();
export async function validateGPU<T>(
  renderer: WebGPURenderer,
  prepare: () => Promise<T> | T,
): Promise<T> {
  const device = gpuDevice(renderer);
  const previous = validationQueues.get(device) ?? Promise.resolve();
  const operation = previous.then(() => validateDevice(renderer, prepare));
  // Error scopes form a device stack. Superseded preparations may still be
  // compiling, so serialize scopes even when a newer editor request has started.
  validationQueues.set(
    device,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  );
  return operation;
}

async function validateDevice<T>(
  renderer: WebGPURenderer,
  prepare: () => Promise<T> | T,
): Promise<T> {
  const device = gpuDevice(renderer);
  // Three r186 catches synchronous texture allocation exceptions and installs a
  // shared 1×1 placeholder. Such a candidate must not enter the authored scene.
  const backend = renderer.backend as unknown as {
    createTexture(texture: Texture, options?: object): void;
    get(texture: Texture): { initialized?: boolean };
    delete(texture: Texture): void;
  };
  const createTexture = backend.createTexture;
  backend.createTexture = function (texture, options) {
    createTexture.call(this, texture, options);
    if (!this.get(texture).initialized) {
      // The placeholder belongs to Three's format cache. Detach it so disposing
      // a failed candidate cannot destroy a texture used by another material.
      this.delete(texture);
      throw new Error(
        'GPU texture allocation failed: ' + (texture.name || 'unnamed texture'),
      );
    }
  };
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let value: T | undefined,
    failure: unknown,
    failed = false;
  try {
    value = await prepare();
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    backend.createTexture = createTexture;
  }
  const scopes = [device.popErrorScope(), device.popErrorScope()];
  const [validation, memory] = await Promise.all(scopes);
  if (failed) throw failure;
  if (validation || memory) throw new Error((validation ?? memory)!.message);
  return value as T;
}
