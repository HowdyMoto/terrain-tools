import type { TerrainProject } from './types';
import { SnapshotStore } from './snapshots';
import type { Snapshot } from './snapshots';

export interface HistoryOptions {
  /** Maximum total undo and redo states. Zero disables history. Default 64. */
  limit?: number;
  /** Estimated retained CPU bytes. Default 256 MiB; always keeps one available state. */
  byteLimit?: number;
}
export interface HistoryStats {
  undoCount: number;
  redoCount: number;
  retainedBytes: number;
  byteLimit: number;
  limit: number;
  evictedCount: number;
  /** A single remaining snapshot exceeds the budget. */
  overBudget: boolean;
}
interface Entry {
  id: number;
  snapshot: Snapshot;
}
type Direction = 'undo' | 'redo';

/** A one-shot mutable restore candidate. Prepare scene resources before commit; dispose on failure. */
export class PreparedHistory {
  private state?: {
    project: TerrainProject;
    apply: (
      current: TerrainProject,
      candidate: TerrainProject,
    ) => TerrainProject;
  };
  constructor(
    project: TerrainProject,
    apply: (
      current: TerrainProject,
      candidate: TerrainProject,
    ) => TerrainProject,
  ) {
    this.state = { project, apply };
  }
  get project() {
    if (!this.state) throw new Error('History preparation is unavailable.');
    return this.state.project;
  }
  commit(current: TerrainProject) {
    if (!this.state) throw new Error('History preparation is unavailable.');
    const result = this.state.apply(current, this.state.project);
    this.state = undefined;
    return result;
  }
  dispose() {
    this.state = undefined;
  }
}

/** Bounded, structurally shared snapshots. Restores never expose retained mutable data. */
export class History {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private store = new SnapshotStore();
  private revision = 0;
  private nextId = 0;
  private evicted = 0;
  private limit: number;
  private byteLimit: number;
  constructor(options: number | HistoryOptions = {}) {
    const config = typeof options === 'number' ? { limit: options } : options;
    this.limit = config.limit ?? 64;
    this.byteLimit = config.byteLimit ?? 256 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.limit) ||
      this.limit < 0 ||
      !Number.isSafeInteger(this.byteLimit) ||
      this.byteLimit < 1
    )
      throw new Error('Invalid history limits.');
  }
  checkpoint(project: TerrainProject) {
    if (!this.limit) return;
    const base = this.past.at(-1) ?? this.future.at(-1);
    // Capture before modifying stacks so an allocation or invalid-value failure preserves history.
    const snapshot = this.store.capture(project, base?.snapshot);
    this.store.retain(snapshot);
    for (const entry of this.future) this.store.release(entry.snapshot);
    this.future = [];
    this.past.push({ id: ++this.nextId, snapshot });
    this.revision++;
    this.trim();
  }
  prepareUndo() {
    return this.prepare('undo');
  }
  prepareRedo() {
    return this.prepare('redo');
  }
  private prepare(direction: Direction): PreparedHistory | undefined {
    const entry = (direction === 'undo' ? this.past : this.future).at(-1);
    if (!entry) return undefined;
    const id = entry.id,
      revision = this.revision;
    return new PreparedHistory(
      this.store.restore<TerrainProject>(entry.snapshot),
      (current, candidate) => {
        const from = direction === 'undo' ? this.past : this.future;
        const to = direction === 'undo' ? this.future : this.past;
        const target = from.at(-1);
        if (this.revision !== revision || target?.id !== id)
          throw new Error('History changed during preparation.');
        const snapshot = this.store.capture(current, target.snapshot);
        this.store.retain(snapshot);
        from.pop();
        this.store.release(target.snapshot);
        to.push({ id: ++this.nextId, snapshot });
        this.revision++;
        this.trim();
        return candidate;
      },
    );
  }
  undo(current: TerrainProject) {
    return this.restore('undo', current);
  }
  redo(current: TerrainProject) {
    return this.restore('redo', current);
  }
  private restore(direction: Direction, current: TerrainProject) {
    const prepared = this.prepare(direction);
    try {
      return prepared?.commit(current) ?? current;
    } finally {
      prepared?.dispose();
    }
  }
  private get retainedBytes() {
    return this.store.bytes + (this.past.length + this.future.length) * 48;
  }
  private trim() {
    while (
      this.past.length + this.future.length > 1 &&
      (this.past.length + this.future.length > this.limit ||
        this.retainedBytes > this.byteLimit)
    ) {
      // Expire the farthest reachable state, preserving the nearest undo/redo steps.
      const stack =
        this.past.length >= this.future.length ? this.past : this.future;
      this.store.release(stack.shift()!.snapshot);
      this.evicted++;
    }
  }
  clear() {
    for (const entry of [...this.past, ...this.future])
      this.store.release(entry.snapshot);
    this.past = [];
    this.future = [];
    this.evicted = 0;
    this.revision++;
  }
  /** Independent inspection copy. For asynchronous restores, use prepareUndo/prepareRedo. */
  get undoTarget() {
    const entry = this.past.at(-1);
    return entry && this.store.restore<TerrainProject>(entry.snapshot);
  }
  get redoTarget() {
    const entry = this.future.at(-1);
    return entry && this.store.restore<TerrainProject>(entry.snapshot);
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get stats(): HistoryStats {
    return {
      undoCount: this.past.length,
      redoCount: this.future.length,
      retainedBytes: this.retainedBytes,
      byteLimit: this.byteLimit,
      limit: this.limit,
      evictedCount: this.evicted,
      overBudget: this.retainedBytes > this.byteLimit,
    };
  }
}
