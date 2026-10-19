import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createProject, defaultWaterSettings } from '../lib/core.js';
import { TerrainScene } from '../lib/runtime.js';

const samples = 11,
  warmups = 3;
const region = { minX: -8, maxX: 8, minZ: -8, maxZ: 8 };
const measure = (fn) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};
const summarize = (values) => ({
  medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)],
  maxMs: Math.max(...values),
  samplesMs: values,
});
const cases = [];
for (const resolution of [128, 256, 512]) {
  const p = createProject(resolution, 1000);
  p.heights.fill(-2);
  p.foliage = [];
  p.props = [];
  p.water = defaultWaterSettings(p);
  p.water.ocean.enabled = true;
  p.water.seaLevel = 0;
  const scene = new TerrainScene(p);
  scene.waterSystem.apply(scene.waterSystem.prepare(p));
  scene.rebuildTerrain();
  const candidate = structuredClone(p);
  let edit;
  const beginMs = measure(() => {
    edit = scene.beginEdit(candidate);
  });
  const full = [],
    preview = [],
    final = [];
  let dirtyChunks = 0;
  for (let i = -warmups; i < samples; i++) {
    candidate.heights[(resolution / 2) * (resolution + 1) + resolution / 2] =
      i % 2 ? 1 : -1;
    // Alternate ordering to reduce warm-cache/order bias.
    for (const deferred of i % 2 ? [true, false] : [false, true]) {
      const elapsed = measure(() => {
        const state = scene.prepareTerrain(region, candidate, {
          waterPreview: deferred,
        });
        try {
          dirtyChunks = scene.applyTerrain(state).length;
        } finally {
          state.dispose();
        }
      });
      if (i >= 0) (deferred ? preview : full).push(elapsed);
    }
    const elapsed = measure(() => scene.finalizeWaterPreview());
    if (i >= 0) final.push(elapsed);
  }
  edit.rollback();
  scene.dispose();
  cases.push({
    resolution,
    dirtyChunks,
    beginMs,
    immediate: summarize(full),
    deferred: summarize(preview),
    finalWater: summarize(final),
  });
}
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  cpu: os.cpus()[0]?.model,
  fixture: {
    samples,
    warmups,
    sizeMetres: 1000,
    dirtyRegionMetres: 16,
    water: 'tropical ocean over flat terrain, one edited vertex',
  },
  scope:
    'Node CPU terrain preparation/application including water fields. Immediate and deferred paths use the same build and alternate order. No GPU uploads, browser frames, foliage, history, physics or autosave. Final water work still runs synchronously once per stroke. beginMs is one sample, not a statistical result.',
  cases,
};
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/water-preview.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
