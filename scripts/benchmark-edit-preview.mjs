import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { createProject, generateTerrain } from '../lib/core.js';
import { TerrainScene } from '../lib/runtime.js';

const numberArg = (key, fallback) =>
  Number(
    process.argv
      .find((arg) => arg.startsWith('--' + key + '='))
      ?.split('=')[1] ?? fallback,
  );
const count = numberArg('count', 50000),
  samples = numberArg('samples', 7),
  resolution = numberArg('resolution', 128);
if (
  !Number.isInteger(count) ||
  count < 0 ||
  count > 50000 ||
  !Number.isInteger(samples) ||
  samples < 3 ||
  samples > 30 ||
  ![32, 64, 128, 256, 512].includes(resolution)
)
  throw new Error(
    'Use --count=0..50000 --samples=3..30 --resolution=32|64|128|256|512.',
  );
const project = createProject(resolution, 192);
generateTerrain(project, 'flat');
const side = Math.ceil(Math.sqrt(count));
project.foliage = Array.from({ length: count }, (_, id) => ({
  id: id + 1,
  brushId: 'grass',
  x: (((id % side) + 0.5) / side) * 190 - 95,
  z: ((Math.floor(id / side) + 0.5) / side) * 190 - 95,
  scale: 1,
  rotation: id * 0.5,
}));
project.nextId = count + 1;
const scene = new TerrainScene(project);
scene.rebuildTerrain();
scene.rebuildFoliage();
scene.rebuildProps();
const results = [];
for (let i = -1; i < samples; i++) {
  globalThis.gc?.();
  const baseline = process.memoryUsage().arrayBuffers;
  const copyingAt = performance.now();
  let candidate = {
    ...project,
    heights: project.heights.slice(),
    holes: project.holes.slice(),
    paint: project.paint.slice(),
    foliage: project.foliage.slice(),
  };
  const copiedAt = performance.now();
  let edit = scene.beginEdit(candidate);
  const preparedAt = performance.now();
  globalThis.gc?.();
  const retained = process.memoryUsage().arrayBuffers - baseline;
  const rollbackAt = performance.now();
  edit.rollback();
  const finishedAt = performance.now();
  edit = undefined;
  candidate = undefined;
  globalThis.gc?.();
  await new Promise(setImmediate);
  globalThis.gc?.();
  if (i >= 0)
    results.push({
      copyMs: copiedAt - copyingAt,
      prepareMs: preparedAt - copiedAt,
      rollbackMs: finishedAt - rollbackAt,
      extraArrayBufferBytes: retained,
      baselineArrayBufferBytes: baseline,
      postRollbackArrayBufferDelta:
        process.memoryUsage().arrayBuffers - baseline,
    });
}
scene.dispose();
const median = (key) =>
  [...results].map((row) => row[key]).sort((a, b) => a - b)[
    Math.floor(results.length / 2)
  ];
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  cpu: os.cpus()[0]?.model,
  garbageCollectionAvailable: typeof globalThis.gc === 'function',
  fixture: {
    count,
    model: 'procedural grass',
    resolution,
    sizeMetres: 192,
    samples,
    warmups: 1,
  },
  scope:
    'CPU candidate-buffer copy, retained scene preparation and rollback only. No renderer, GPU uploads, sculpt dabs, history, collision, autosave, imported assets or whole-process memory budget.',
  median: Object.fromEntries(
    [
      'copyMs',
      'prepareMs',
      'rollbackMs',
      'extraArrayBufferBytes',
      'postRollbackArrayBufferDelta',
    ].map((key) => [key, median(key)]),
  ),
  samples: results,
};
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/edit-preview-' + count + '.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
