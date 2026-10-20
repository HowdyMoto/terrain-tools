import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const current = resolve('src/core/terrain-lod.ts');
const baseline = argument('baseline') ? resolve(argument('baseline')) : null;
const output = resolve(argument('output') ?? '.qa/terrain-lod-benchmark.json');
const iterations = Number(argument('iterations') ?? 500);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5000)
  throw new Error('Use 1 to 5000 iterations.');
const positions = new Float32Array(33 * 33 * 3),
  indices = [];
for (let z = 0; z <= 32; z++)
  for (let x = 0; x <= 32; x++) {
    const i = z * 33 + x;
    positions.set(
      [
        x * 1.25,
        (((i * 17) % 83) - 41) * 0.125 + ((x * z) % 7) * 0.0625,
        z * 2.5,
      ],
      i * 3,
    );
  }
for (let z = 0; z < 32; z++)
  for (let x = 0; x < 32; x++) {
    const a = z * 33 + x,
      b = a + 33;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
const original = new Uint32Array(indices);
const implementations = {
  current: (await import(pathToFileURL(current).href)).buildTerrainLods,
};
if (baseline)
  implementations.baseline = (
    await import(pathToFileURL(baseline).href)
  ).buildTerrainLods;
const results = [];
let expected;
for (const mode of baseline
  ? ['baseline', 'current', 'current', 'baseline']
  : ['current', 'current']) {
  const build = implementations[mode];
  const coldStart = performance.now();
  build(positions, original, 32, 32);
  const firstCallMs = performance.now() - coldStart;
  for (let i = 0; i < 40; i++) build(positions, original, 32, 32);
  const samples = [];
  const hash = createHash('sha256');
  for (let i = 0; i < iterations; i++) {
    // Different heights on each chunk; grid topology stays the same.
    for (let vertex = 0; vertex < positions.length / 3; vertex++)
      positions[vertex * 3 + 1] = (((vertex * 17 + i * 3) % 83) - 41) * 0.125;
    const start = performance.now();
    const levels = build(positions, original, 32, 32);
    samples.push(performance.now() - start);
    // Exact equivalence, outside the timed interval.
    for (const level of levels) {
      hash.update(
        new Uint8Array(
          level.indices.buffer,
          level.indices.byteOffset,
          level.indices.byteLength,
        ),
      );
      hash.update(
        new Uint8Array(
          level.target.buffer,
          level.target.byteOffset,
          level.target.byteLength,
        ),
      );
      hash.update(new Uint8Array(new Float64Array([level.error]).buffer));
    }
  }
  const signature = hash.digest('hex');
  if (expected && signature !== expected)
    throw new Error('LOD outputs changed.');
  expected = signature;
  const sorted = [...samples].sort((a, b) => a - b);
  const summary = {
    p50: sorted[Math.floor(iterations * 0.5)],
    p95: sorted[Math.floor(iterations * 0.95)],
    max: sorted.at(-1),
  };
  results.push({ mode, firstCallMs, summary, signature, samples });
  console.log(JSON.stringify({ mode, firstCallMs, summary }));
}
const fingerprint = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      iterations,
      sourceSHA256: {
        current: await fingerprint(current),
        baseline: baseline ? await fingerprint(baseline) : null,
      },
      note: 'CPU-only 32x32 terrain LOD preparation, varying heights, unchanged topology and exact indices/targets/error hash in all modes. First call is reported separately; current second trial reuses the cache. Timings exclude hashes/input preparation and are not FPS.',
      results,
    },
    null,
    2,
  ) + '\n',
);
