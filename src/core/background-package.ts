import { capturePackageProject } from './package-transfer';
import type {
  PackageCapture,
  PackageRequest,
  PackageResponse,
} from './package-transfer';
import type { TerrainProject } from './types';

type PackageWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'
>;
export interface BackgroundPackageOptions {
  /** Supply a custom worker host; omitted uses the bundled browser worker. */
  workerFactory?: () => PackageWorker;
  /** Pending snapshots, excluding the active one. Default 4, range 1–64. */
  maxPending?: number;
  /** Maximum duration of one request, including worker startup. Default 120,000 ms. */
  timeoutMs?: number;
}
export interface BackgroundPackageStats {
  active: boolean;
  pending: number;
  cachedAssets: number;
  cachedCharacters: number;
  lastCaptureMs: number;
  lastPostMs: number;
  lastEncodeMs: number;
}
type Waiter = { resolve: (blob: Blob) => void; reject: (error: Error) => void };
interface Job {
  id: number;
  latest: boolean;
  capture?: PackageCapture;
  waiters: Waiter[];
}

/** Browser worker encoder with exact snapshots, bounded queuing, and opt-in autosave coalescing. */
export class BackgroundProjectWriter {
  private worker?: PackageWorker;
  private payloads = new Map<string, number>();
  private nextPayload = 0;
  private nextJob = 0;
  private pending: Job[] = [];
  private active?: Job;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private captureMs = 0;
  private postMs = 0;
  private encodeMs = 0;
  private readonly maximum: number;
  private readonly timeout: number;
  private readonly factory: () => PackageWorker;

  constructor(options: BackgroundPackageOptions = {}) {
    this.maximum = options.maxPending ?? 4;
    this.timeout = options.timeoutMs ?? 120000;
    if (
      !Number.isInteger(this.maximum) ||
      this.maximum < 1 ||
      this.maximum > 64 ||
      !Number.isFinite(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 600000
    )
      throw new Error('Invalid background package limits.');
    this.factory =
      options.workerFactory ??
      (() =>
        new Worker(new URL('./project-package-worker.ts', import.meta.url), {
          type: 'module',
        }));
  }
  get stats(): BackgroundPackageStats {
    let characters = 0;
    for (const url of this.payloads.keys()) characters += url.length;
    return {
      active: !!this.active,
      pending: this.pending.length,
      cachedAssets: this.payloads.size,
      cachedCharacters: characters,
      lastCaptureMs: this.captureMs,
      lastPostMs: this.postMs,
      lastEncodeMs: this.encodeMs,
    };
  }
  /** Resolves with the exact state captured synchronously at this call. Live arrays stay attached. */
  encode(project: TerrainProject): Promise<Blob> {
    return this.enqueue(project, false);
  }
  /** Pending autosaves collapse to the newest snapshot; replaced callers receive that newer Blob. */
  encodeLatest(project: TerrainProject): Promise<Blob> {
    return this.enqueue(project, true);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resetWorker();
    const error = new Error('Background package writer disposed.');
    const jobs = [...(this.active ? [this.active] : []), ...this.pending];
    this.active = undefined;
    this.pending = [];
    for (const job of jobs)
      for (const waiter of job.waiters) waiter.reject(error);
  }
  private enqueue(project: TerrainProject, latest: boolean): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (this.disposed) throw new Error('Background package writer disposed.');
      const replaced = latest
        ? this.pending.findIndex((job) => job.latest)
        : -1;
      if (this.active && replaced < 0 && this.pending.length >= this.maximum)
        throw new Error(
          'Background package queue is full. Wait for a pending save.',
        );
      const started = performance.now();
      const capture = capturePackageProject(project);
      this.captureMs = performance.now() - started;
      const waiters =
        replaced < 0 ? [] : this.pending.splice(replaced, 1)[0].waiters;
      waiters.push({ resolve, reject });
      this.pending.push({ id: ++this.nextJob, latest, capture, waiters });
      this.start();
    });
  }
  private start() {
    if (this.disposed || this.active || !this.pending.length) return;
    const job = (this.active = this.pending.shift()!);
    try {
      if (!this.worker) {
        const worker = (this.worker = this.factory());
        worker.onmessage = (event: MessageEvent<PackageResponse>) => {
          if (this.worker !== worker) return;
          const response = event.data;
          if (!response || typeof response !== 'object') {
            this.fail(new Error('Invalid background package response.'));
            return;
          }
          if (response.id !== this.active?.id) return;
          if (response.type === 'error') {
            this.fail(new Error(response.message));
            return;
          }
          if (response.type !== 'result' || !(response.blob instanceof Blob)) {
            this.fail(new Error('Invalid background package response.'));
            return;
          }
          clearTimeout(this.timer);
          this.encodeMs = response.encodeMs;
          const completed = this.active!;
          this.active = undefined;
          for (const waiter of completed.waiters) waiter.resolve(response.blob);
          this.start();
        };
        worker.onerror = (event) => {
          event.preventDefault();
          if (this.worker === worker)
            this.fail(
              new Error(event.message || 'Background package worker failed.'),
            );
        };
        worker.onmessageerror = (event) => {
          event.preventDefault();
          if (this.worker === worker)
            this.fail(
              new Error('Could not read the background package response.'),
            );
        };
      }
      const capture = job.capture!;
      const keep = new Map<string, number>(),
        added: [number, string][] = [];
      const dictionary = capture.payloads.map((url) => {
        let id = this.payloads.get(url);
        if (id === undefined) {
          id = this.nextPayload++;
          added.push([id, url]);
        }
        keep.set(url, id);
        return id;
      });
      const message: PackageRequest = {
        id: job.id,
        project: capture.project,
        foliage: capture.foliage,
        dictionary,
        added,
      };
      this.timer = setTimeout(
        () => this.fail(new Error('Background package encoding timed out.')),
        this.timeout,
      );
      const started = performance.now();
      this.worker.postMessage(message, capture.transfer);
      this.postMs = performance.now() - started;
      this.payloads = keep;
      job.capture = undefined;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private fail(error: Error) {
    const failed = this.active;
    this.active = undefined;
    this.resetWorker();
    for (const waiter of failed?.waiters ?? []) waiter.reject(error);
    this.start();
  }
  private resetWorker() {
    clearTimeout(this.timer);
    if (this.worker) {
      this.worker.onmessage =
        this.worker.onerror =
        this.worker.onmessageerror =
          null;
      this.worker.terminate();
      this.worker = undefined;
    }
    this.payloads.clear();
    this.nextPayload = 0;
  }
}
