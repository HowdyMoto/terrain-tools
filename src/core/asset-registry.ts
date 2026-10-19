/** Accounted bytes, excluding driver/program overhead and host-owned input documents. */
export interface AssetBytes {
  encodedBytes: number;
  cpuBytes: number;
  gpuBytes: number;
}
export interface AssetResource<T> extends AssetBytes {
  value: T;
  /** Must not throw. */
  dispose(): void;
}
export interface AssetLease<T> {
  readonly value: T;
  release(): void;
}
export interface AssetBudget {
  cpuBytes: number;
  gpuBytes: number;
  /** Upper bound of simultaneous loader scratch plus retained candidate CPU bytes. */
  stagingBytes: number;
  maxPending?: number;
  /** Bounds metadata even for resources declaring zero bytes. */
  maxEntries?: number;
}
interface Entry<T> {
  controller: AbortController;
  refs: number;
  touched: number;
  reserve: AssetBytes;
  scratch: number;
  resource?: AssetResource<T>;
  promise: Promise<AssetResource<T>>;
}
const aborted = () =>
  new DOMException('Asset preparation cancelled.', 'AbortError');
const valid = (value: number) => Number.isSafeInteger(value) && value >= 0;
const cpu = (bytes: AssetBytes) => bytes.encodedBytes + bytes.cpuBytes;
function checkBytes(bytes: AssetBytes) {
  if (
    ![bytes.encodedBytes, bytes.cpuBytes, bytes.gpuBytes, cpu(bytes)].every(
      valid,
    )
  )
    throw new Error('Invalid asset byte accounting.');
}

/** World-owned content cache. Active and staged leases are never evicted.
 * Reservations must conservatively include loader allocations; actual resources
 * exceeding a reservation are rejected. Counters are estimates, not driver telemetry.
 */
export class AssetRegistry<T> {
  private entries = new Map<string, Entry<T>>();
  private closed = false;
  private serial = 0;
  private peak = { cpuBytes: 0, gpuBytes: 0, stagingBytes: 0 };
  readonly budget: Required<AssetBudget>;
  constructor(budget: AssetBudget) {
    this.budget = {
      ...budget,
      maxPending: budget.maxPending ?? 8,
      maxEntries: budget.maxEntries ?? 4096,
    };
    if (
      ![budget.cpuBytes, budget.gpuBytes, budget.stagingBytes].every(valid) ||
      !Number.isInteger(this.budget.maxPending) ||
      this.budget.maxPending < 1 ||
      !Number.isInteger(this.budget.maxEntries) ||
      this.budget.maxEntries < 1 ||
      this.budget.maxEntries > 65536
    )
      throw new Error('Invalid asset budget.');
  }
  get stats() {
    let encodedBytes = 0,
      cpuBytes = 0,
      gpuBytes = 0,
      stagingBytes = 0,
      pending = 0,
      active = 0,
      cached = 0;
    for (const entry of this.entries.values()) {
      const bytes = entry.resource ?? entry.reserve;
      encodedBytes += bytes.encodedBytes;
      cpuBytes += cpu(bytes);
      gpuBytes += bytes.gpuBytes;
      if (!entry.resource) {
        pending++;
        stagingBytes += cpu(entry.reserve) + entry.scratch;
      } else if (entry.refs) active++;
      else cached++;
    }
    return {
      encodedBytes,
      cpuBytes,
      gpuBytes,
      stagingBytes,
      pending,
      active,
      cached,
      peak: { ...this.peak },
    };
  }
  private recordPeak() {
    const s = this.stats;
    for (const key of ['cpuBytes', 'gpuBytes', 'stagingBytes'] as const)
      this.peak[key] = Math.max(this.peak[key], s[key]);
  }
  /** Dispose unleased cached entries, oldest first, until the request fits. */
  private makeRoom(bytes: AssetBytes, scratch: number) {
    const fits = () => {
      const s = this.stats;
      return (
        s.cpuBytes + cpu(bytes) <= this.budget.cpuBytes &&
        s.gpuBytes + bytes.gpuBytes <= this.budget.gpuBytes &&
        s.stagingBytes + cpu(bytes) + scratch <= this.budget.stagingBytes &&
        s.pending < this.budget.maxPending &&
        this.entries.size < this.budget.maxEntries
      );
    };
    for (const [key, entry] of [...this.entries].sort(
      (a, b) => a[1].touched - b[1].touched,
    )) {
      if (fits()) return;
      if (!entry.refs && entry.resource) {
        this.entries.delete(key);
        entry.resource.dispose();
      }
    }
    if (!fits())
      throw new Error(
        'Asset residency/staging budget exceeded; active leases were retained.',
      );
  }
  async acquire(
    key: string,
    reserve: AssetBytes,
    scratchBytes: number,
    load: (signal: AbortSignal) => Promise<AssetResource<T>>,
    signal?: AbortSignal,
  ): Promise<AssetLease<T>> {
    if (this.closed) throw new Error('Asset registry is closed.');
    if (signal?.aborted) throw aborted();
    checkBytes(reserve);
    if (!key || !valid(scratchBytes)) throw new Error('Invalid asset request.');
    let entry = this.entries.get(key);
    if (entry?.controller.signal.aborted) throw aborted();
    if (!entry) {
      this.makeRoom(reserve, scratchBytes);
      const candidate: Entry<T> = {
        controller: new AbortController(),
        refs: 0,
        touched: ++this.serial,
        reserve: { ...reserve },
        scratch: scratchBytes,
        promise: undefined as unknown as Promise<AssetResource<T>>,
      };
      entry = candidate;
      this.entries.set(key, candidate);
      this.recordPeak();
      candidate.promise = Promise.resolve()
        .then(async () => {
          if (candidate.controller.signal.aborted) throw aborted();
          const resource = await load(candidate.controller.signal);
          try {
            checkBytes(resource);
            if (candidate.controller.signal.aborted || this.closed)
              throw aborted();
            if (
              cpu(resource) > cpu(reserve) ||
              resource.gpuBytes > reserve.gpuBytes
            )
              throw new Error(
                'Asset exceeded its declared preparation reservation.',
              );
            // Capture accounting rather than trusting a mutable source handle.
            candidate.resource = {
              value: resource.value,
              encodedBytes: resource.encodedBytes,
              cpuBytes: resource.cpuBytes,
              gpuBytes: resource.gpuBytes,
              dispose: () => resource.dispose(),
            };
            this.recordPeak();
            return candidate.resource;
          } catch (error) {
            resource.dispose();
            throw error;
          }
        })
        .catch((error) => {
          if (this.entries.get(key) === candidate) this.entries.delete(key);
          throw error;
        });
    }
    const held = entry;
    held.refs++;
    held.touched = ++this.serial;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.refs--;
      held.touched = ++this.serial;
      if (!held.refs && !held.resource) held.controller.abort();
      if (!held.refs && this.closed && held.resource) {
        this.entries.delete(key);
        held.resource.dispose();
      }
    };
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        release();
        reject(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const resource = await Promise.race([held.promise, cancelled]);
      if (signal?.aborted) throw aborted();
      return { value: resource.value, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }
  /** Release only unleased cache entries; pending work and active clients remain valid. */
  trim() {
    for (const [key, entry] of this.entries)
      if (!entry.refs && entry.resource) {
        this.entries.delete(key);
        entry.resource.dispose();
      }
  }
  /** Stop admission/cancel preparations. Existing leases remain valid until released. */
  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values())
      if (!entry.resource) entry.controller.abort();
    this.trim();
  }
}

/** Stable SHA-256 identity, including the interpretation/version supplied by the caller. */
export async function assetHash(data: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
