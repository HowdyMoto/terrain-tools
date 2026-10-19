import { AssetRegistry, assetHash } from '../core/asset-registry';
import type {
  AssetBudget,
  AssetBytes,
  AssetLease,
  AssetResource,
} from '../core/asset-registry';
import { decodeModel } from '../render/model-loader';
import type { ModelDecoder } from '../render/model-loader';
import { modelMemory } from './asset-memory';
import { createWaterFoamTexture } from './water-foam';

/** Shared by every tile of a world. Leases survive disposal of the registry owner. */
export class WorldAssets {
  /** Optional immutable compressed library. All tiles must select matching palettes. */
  materials?: import('./material-library').RuntimeMaterialLibrary;
  readonly registry: AssetRegistry<unknown>;
  readonly decode: ModelDecoder;
  private hashes = new Map<string, Promise<string>>();
  private hashing = 0;
  private hashingBytes = 0;
  private peakHashingBytes = 0;
  private closed = false;
  constructor(
    budget: AssetBudget = {
      cpuBytes: 768 * 1024 ** 2,
      gpuBytes: 768 * 1024 ** 2,
      stagingBytes: 512 * 1024 ** 2,
    },
    decoder: ModelDecoder = decodeModel,
    /** Conservative per-model preparation ceiling. Prepared pack metadata may lower it. */
    readonly modelReservation = {
      cpuBytes: 128 * 1024 ** 2,
      gpuBytes: 128 * 1024 ** 2,
    },
  ) {
    this.registry = new AssetRegistry(budget);
    this.decode = async (data, signal) => {
      if (this.closed) throw new Error('World assets have been disposed.');
      if (signal?.aborted)
        throw new DOMException('Asset cancelled.', 'AbortError');
      const encodedBytes = data.length * 2;
      let hashed = this.hashes.get(data);
      if (!hashed) {
        // Retain a hash only for a pending/live cached resource. Repeated tiles
        // must not copy and SHA-256 the same multi-megabyte payload each time.
        if (
          this.hashing >= this.registry.budget.maxPending ||
          this.hashingBytes +
            encodedBytes * 2 +
            this.registry.stats.stagingBytes >
            this.registry.budget.stagingBytes
        )
          throw new Error('Model hashing exceeds the staging budget.');
        this.hashing++;
        this.hashingBytes += encodedBytes * 2;
        this.peakHashingBytes = Math.max(
          this.peakHashingBytes,
          this.hashingBytes,
        );
        hashed = assetHash(data).finally(() => {
          this.hashing--;
          this.hashingBytes -= encodedBytes * 2;
        });
        this.hashes.set(data, hashed);
      }
      const forget = () => {
        if (this.hashes.get(data) === hashed) this.hashes.delete(data);
      };
      try {
        const key = 'model:' + (await hashed);
        const lease = await this.acquire(
          key,
          { encodedBytes, ...modelReservation },
          encodedBytes * 2,
          async (signal) => {
            const decoded = await decoder(data, signal);
            try {
              return {
                value: decoded,
                encodedBytes,
                ...modelMemory(decoded.parts),
                dispose: () => {
                  forget();
                  decoded.dispose();
                },
              };
            } catch (error) {
              decoded.dispose();
              throw error;
            }
          },
          signal,
        );
        return { parts: lease.value.parts, dispose: lease.release };
      } catch (error) {
        forget();
        throw error;
      }
    };
  }
  acquire<T>(
    key: string,
    reserve: AssetBytes,
    scratch: number,
    load: (signal: AbortSignal) => Promise<AssetResource<T>>,
    signal?: AbortSignal,
  ) {
    return this.registry.acquire(
      key,
      reserve,
      // Keep concurrent hash scratch inside the same staging ceiling. This can
      // conservatively retain its reservation until this loader settles.
      scratch + this.hashingBytes,
      load,
      signal,
    ) as Promise<AssetLease<T>>;
  }
  /** One shared GPU foam texture; the expensive procedural preparation runs off-thread. */
  foam(signal?: AbortSignal) {
    return this.acquire(
      'water-foam-v1',
      {
        encodedBytes: 0,
        cpuBytes: 4 * 1024 ** 2,
        gpuBytes: Math.ceil((4 * 1024 ** 2 * 4) / 3),
      },
      8 * 1024 ** 2,
      async (signal) => {
        let pixels: Uint8Array | undefined;
        if (typeof Worker !== 'undefined')
          pixels = await new Promise<Uint8Array>((resolve, reject) => {
            const worker = new Worker(
              new URL('./water-foam.worker.ts', import.meta.url),
              { type: 'module' },
            );
            const done = () => {
              signal.removeEventListener('abort', abort);
              worker.terminate();
            };
            const abort = () => {
              done();
              reject(
                new DOMException('Foam preparation cancelled.', 'AbortError'),
              );
            };
            signal.addEventListener('abort', abort, { once: true });
            worker.onmessage = (event) => {
              done();
              if (event.data.error) reject(new Error(event.data.error));
              else resolve(event.data.pixels);
            };
            worker.onerror = (event) => {
              done();
              reject(new Error(event.message));
            };
            if (signal.aborted) abort();
            else worker.postMessage({});
          });
        const value = createWaterFoamTexture(pixels);
        return {
          value,
          encodedBytes: 0,
          cpuBytes: 4 * 1024 ** 2,
          gpuBytes: Math.ceil((4 * 1024 ** 2 * 4) / 3),
          dispose: () => value.dispose(),
        };
      },
      signal,
    );
  }
  get stats() {
    return {
      ...this.registry.stats,
      hashingBytes: this.hashingBytes,
      peakHashingBytes: this.peakHashingBytes,
    };
  }
  trim() {
    this.registry.trim();
  }
  dispose() {
    this.closed = true;
    this.hashes.clear();
    this.registry.dispose();
  }
}
