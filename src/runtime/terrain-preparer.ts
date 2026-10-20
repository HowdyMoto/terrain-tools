import { terrainPreparationInput } from '../core/terrain-preparation';
import type { PreparedTerrainData } from '../core/terrain-preparation';
import type { PreparedTerrainChunk } from '../core/terrain-preparation';
import type { TerrainProject } from '../core/types';
import { cancelled, checkSignal } from '../render/resources';
const preparedChunks = new WeakMap<object, PreparedTerrainChunk>();
export function rememberPreparedTerrain(
  geometry: object,
  data: PreparedTerrainChunk,
) {
  preparedChunks.set(geometry, data);
}
export function takePreparedTerrain(geometry: object) {
  const data = preparedChunks.get(geometry);
  preparedChunks.delete(geometry);
  return data;
}

interface Task {
  id: number;
  project: TerrainProject;
  lod: boolean;
  signal: AbortSignal;
  resolve(data: PreparedTerrainData): void;
  reject(error: Error): void;
  abort(): void;
}
interface Slot {
  worker: Worker;
  task?: Task;
  timer?: ReturnType<typeof setTimeout>;
}
/** Small persistent worker pool. Cancellation terminates active work, not just
 * its promise; replacement workers start lazily. Live document buffers stay owned. */
export class TerrainPreparer {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private closed = false;
  private nextId = 0;
  constructor(
    private concurrency = 2,
    private factory = () =>
      new Worker(new URL('./terrain-preparation.worker.ts', import.meta.url), {
        type: 'module',
      }),
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error('Use one to eight terrain workers.');
  }
  prepare(
    project: TerrainProject,
    signal: AbortSignal,
    lod = true,
  ): Promise<PreparedTerrainData> {
    checkSignal(signal);
    if (this.closed)
      return Promise.reject(new Error('Terrain preparer is disposed.'));
    if (this.queue.length >= 32)
      return Promise.reject(new Error('Terrain preparation queue is full.'));
    return new Promise((resolve, reject) => {
      const task: Task = {
        id: this.nextId++,
        project,
        lod,
        signal,
        resolve,
        reject,
        abort: () => {
          const slot = this.slots.find((entry) => entry.task === task);
          if (slot) this.finish(slot, cancelled(), true);
          else {
            this.queue = this.queue.filter((entry) => entry !== task);
            signal.removeEventListener('abort', task.abort);
            reject(cancelled());
          }
        },
      };
      signal.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }
  private pump() {
    while (!this.closed && this.queue.length) {
      let slot = this.slots.find((entry) => !entry.task);
      if (!slot) {
        if (this.slots.length >= this.concurrency) return;
        try {
          slot = { worker: this.factory() };
          const current = slot;
          slot.worker.onmessage = (event) => {
            if (event.data.id === current.task?.id)
              this.finish(
                current,
                event.data.error ? new Error(event.data.error) : undefined,
                false,
                event.data.data,
              );
          };
          slot.worker.onerror = (event) =>
            this.finish(
              current,
              new Error(event.message || 'Terrain worker failed.'),
              true,
            );
          slot.worker.onmessageerror = () =>
            this.finish(
              current,
              new Error('Terrain worker returned invalid data.'),
              true,
            );
          this.slots.push(slot);
        } catch (error) {
          const task = this.queue.shift()!;
          task.signal.removeEventListener('abort', task.abort);
          task.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          continue;
        }
      }
      const task = this.queue.shift()!;
      slot.task = task;
      const current = slot;
      slot.timer = setTimeout(
        () =>
          this.finish(current, new Error('Terrain worker timed out.'), true),
        120000,
      );
      try {
        const input = terrainPreparationInput(task.project);
        slot.worker.postMessage(
          { id: task.id, project: input, lod: task.lod },
          [input.heights.buffer, input.paint.buffer, input.holes.buffer],
        );
      } catch (error) {
        this.finish(
          slot,
          error instanceof Error ? error : new Error(String(error)),
          true,
        );
      }
    }
  }
  private finish(
    slot: Slot,
    error?: Error,
    retire = false,
    data?: PreparedTerrainData,
  ) {
    const task = slot.task;
    if (!task) return;
    clearTimeout(slot.timer);
    slot.task = undefined;
    task.signal.removeEventListener('abort', task.abort);
    if (retire) {
      slot.worker.terminate();
      this.slots = this.slots.filter((entry) => entry !== slot);
    }
    if (
      !error &&
      (!data ||
        data.size !== task.project.size ||
        data.resolution !== task.project.resolution ||
        !Array.isArray(data.chunks))
    )
      error = new Error('Invalid prepared terrain dimensions.');
    if (error) task.reject(error);
    else task.resolve(data!);
    this.pump();
  }
  dispose() {
    this.closed = true;
    for (const slot of [...this.slots]) {
      if (slot.task) this.finish(slot, cancelled(), true);
      else slot.worker.terminate();
    }
    this.slots = [];
    for (const task of this.queue) {
      task.signal.removeEventListener('abort', task.abort);
      task.reject(cancelled());
    }
    this.queue = [];
  }
}

export async function yieldPreparation(signal: AbortSignal) {
  checkSignal(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkSignal(signal);
}
