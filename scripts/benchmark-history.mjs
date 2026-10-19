import { cpus } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProject, History } from '../lib/core.js';

const mode = process.argv
  .find((value) => value.startsWith('--mode='))
  ?.slice(7);
if (!mode) {
  const measurements = ['full-copy', 'shared'].map((value) => {
    const result = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=1024',
        fileURLToPath(import.meta.url),
        '--mode=' + value,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 120000 },
    );
    if (result.status !== 0)
      throw new Error(
        result.error?.message ?? result.stderr ?? 'History benchmark failed.',
      );
    return JSON.parse(result.stdout);
  });
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        cpu: cpus()[0]?.model,
        grid: 512,
        foliage: 50000,
        checkpoints: 24,
        measurements,
        scope:
          'CPU history only, in separate processes with forced GC. Synthetic embedded strings represent payload retention; they are not renderable assets. Excludes live project allocation, GPU work, asset decoding, autosave and editor refresh. The full-copy reference uses the original structuredClone implementation.',
      },
      null,
      2,
    ),
  );
} else {
  if (!global.gc || !['full-copy', 'shared'].includes(mode))
    throw new Error('Use --expose-gc and a valid mode.');
  class FullCopyHistory {
    past = [];
    future = [];
    checkpoint(project) {
      this.past.push(structuredClone(project));
      if (this.past.length > 24) this.past.shift();
      this.future = [];
    }
    undo(current) {
      const previous = this.past.pop();
      if (!previous) return current;
      this.future.push(structuredClone(current));
      return previous;
    }
    redo(current) {
      const next = this.future.pop();
      if (!next) return current;
      this.past.push(structuredClone(current));
      return next;
    }
    clear() {
      this.past = [];
      this.future = [];
    }
  }
  const project = createProject(512, 512);
  project.foliage = Array.from({ length: 50000 }, (_, i) => ({
    id: i + 1,
    brushId: 'grass',
    x: (i % 200) - 100,
    z: Math.floor(i / 200) - 125,
    scale: 1,
    rotation: i % 6,
  }));
  project.nextId = 50001;
  project.assets.profile = {
    name: 'Synthetic embedded payload',
    data:
      'data:model/gltf-binary;base64,' +
      Buffer.alloc(4 * 1024 * 1024, 7).toString('base64'),
  };
  for (let i = 0; i < 4; i++)
    project.materials[i].textures.albedo =
      'data:image/png;base64,' + Buffer.alloc(256 * 1024, i).toString('base64');
  const history = mode === 'shared' ? new History(24) : new FullCopyHistory();
  global.gc();
  const before = process.memoryUsage(),
    samples = [];
  for (let step = 0; step < 24; step++) {
    const at = performance.now();
    history.checkpoint(project);
    samples.push(performance.now() - at);
    project.heights[step * 1100] += 0.1;
  }
  global.gc();
  const after = process.memoryUsage(),
    stats = history.stats;
  const undoStart = performance.now();
  let restored = history.undo(project);
  const undoMs = performance.now() - undoStart;
  const redoStart = performance.now();
  restored = history.redo(restored);
  const redoMs = performance.now() - redoStart;
  if (
    restored.heights[23 * 1100] !== project.heights[23 * 1100] ||
    restored.foliage.length !== project.foliage.length
  )
    throw new Error('History benchmark round-trip failed.');
  history.clear();
  console.log(
    JSON.stringify({
      mode,
      embeddedCharacters:
        Object.values(project.assets).reduce(
          (n, asset) => n + asset.data.length,
          0,
        ) +
        project.materials.reduce(
          (n, material) => n + material.textures.albedo.length,
          0,
        ),
      checkpointMilliseconds: samples,
      firstCheckpointMs: samples[0],
      medianCheckpointMs: [...samples].sort((a, b) => a - b)[12],
      retainedHeapBytes: after.heapUsed - before.heapUsed,
      retainedArrayBufferBytes: after.arrayBuffers - before.arrayBuffers,
      undoMs,
      redoMs,
      stats,
      clearedStats: history.stats,
    }),
  );
}
