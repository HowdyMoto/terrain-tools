import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromeGPUArgs } from './chrome-gpu.mjs';
import { runtimePackagePage } from '../tests/browser/runtime-package-page.mjs';

// CPU selection benchmark only: no renderer, GPU timing or FPS inference.
const argument = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseline = argument('baseline-lib')
  ? resolve(argument('baseline-lib'))
  : null;
const output = resolve(argument('output') ?? '.qa/foliage-selection.json');
const port = Number(argument('port') ?? 5199);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid port.');
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--configLoader',
    'native',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { stdio: 'ignore', windowsHide: true },
);
let browser;
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error('Owned preview exited.');
    if (
      await fetch(url)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    if (i > 100) throw new Error('Build first; preview did not start.');
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    executablePath:
      process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : undefined,
    args: chromeGPUArgs(),
  });
  const results = [];
  for (const mode of baseline
    ? ['baseline', 'current', 'current', 'baseline']
    : ['current', 'current']) {
    const context = await browser.newContext({ baseURL: url });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await runtimePackagePage(page);
    if (baseline)
      await page.route('**/__selection_baseline/**', async (route) => {
        const relative = new URL(route.request().url()).pathname.slice(
          '/__selection_baseline/'.length,
        );
        const path = resolve(baseline, relative);
        if (!path.startsWith(baseline + sep)) return route.abort();
        await route.fulfill({
          contentType: 'text/javascript',
          body: await readFile(path),
        });
      });
    console.log(`Measuring ${mode} selection`);
    const trials = await page.evaluate(
      async (runtimeURL) => {
        const THREE = await import('three');
        const { createProject, editFoliageModels } = await import(
          runtimeURL + 'core.js'
        );
        const { TerrainScene } = await import(runtimeURL + 'runtime.js');
        const trials = [];
        for (const count of [1000, 10000, 50000]) {
          const project = createProject(8, 2048);
          project.heights.fill(0);
          const model = editFoliageModels(project.brushes[0], [])[0];
          Object.assign(model, {
            model: 'pine',
            lods: [
              { model: 'pine-low', distance: 40, density: 0.6 },
              { model: 'pine-low', distance: 100, density: 0.2 },
            ],
            cullDistance: 180,
            lodHysteresis: 0.1,
            lodFadeDuration: 0.4,
          });
          const side = Math.ceil(Math.sqrt(count));
          project.foliage = Array.from({ length: count }, (_, i) => ({
            id: project.nextId++,
            brushId: project.brushes[0].id,
            modelId: model.id,
            x: ((i % side) - side / 2) * 4,
            z: (Math.floor(i / side) - side / 2) * 4,
            scale: 1,
            rotation: i * 0.7,
          }));
          const terrain = new TerrainScene(project);
          terrain.rebuildFoliage();
          const reservedInstanceBytes = terrain.foliage.children.reduce(
            (bytes, mesh) =>
              bytes +
              mesh.instanceMatrix.array.byteLength +
              (mesh.geometry.getAttribute('terrainContact')?.array.byteLength ??
                0) +
              (mesh.geometry.getAttribute('terrainFade')?.array.byteLength ??
                0),
            0,
          );
          const camera = new THREE.PerspectiveCamera();
          camera.position.set(0, 3, 0);
          const start = performance.now();
          terrain.foliage.updateView(camera);
          const initialSelectionMs = performance.now() - start;
          const times = [],
            checkpoints = [];
          for (let frame = 0; frame < 480; frame++) {
            // Continuous traversal, small vertical motion, and two large teleports.
            camera.position.set(
              (frame < 160 ? frame : frame < 320 ? frame - 160 : frame - 640) *
                0.25,
              3 + Math.sin(frame * 0.01),
              Math.sin(frame * 0.02) * 12,
            );
            const before = performance.now();
            terrain.update(1 / 60, [], camera);
            const duration = performance.now() - before;
            if (frame >= 40) {
              times.push(duration);
            }
            if (frame % 80 === 79) {
              // Outside timing: identify exact packed IDs, matrices and fade ranges.
              let hash = 2166136261;
              for (const mesh of terrain.foliage.children) {
                const arrays = [
                  mesh.userData.instanceIds,
                  mesh.instanceMatrix.array.subarray(0, mesh.count * 16),
                  mesh.geometry
                    .getAttribute('terrainFade')
                    ?.array.subarray(0, mesh.count * 3) ?? [],
                ];
                for (const array of arrays)
                  for (const number of array)
                    hash = Math.imul(hash ^ Math.round(number * 1e5), 16777619);
              }
              checkpoints.push({
                frame,
                hash: hash >>> 0,
                stats: terrain.foliage.viewStats,
              });
            }
            if (frame % 40 === 0) await new Promise(requestAnimationFrame);
          }
          trials.push({
            count,
            initialSelectionMs,
            reservedInstanceBytes,
            times,
            checkpoints,
          });
          terrain.dispose();
        }
        return trials;
      },
      mode === 'baseline' ? '/__selection_baseline/' : '/__runtime_test/lib/',
    );
    if (errors.length) throw new Error(errors.join('\n'));
    for (const trial of trials) {
      const sorted = [...trial.times].sort((a, b) => a - b);
      trial.summary = {
        medianMs: sorted[Math.floor(sorted.length * 0.5)],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        maxMs: sorted.at(-1),
      };
      const reference = results[0]?.trials.find(
        (item) => item.count === trial.count,
      );
      if (
        reference &&
        JSON.stringify(reference.checkpoints) !==
          JSON.stringify(trial.checkpoints)
      )
        throw new Error(
          `Packed foliage changed for ${mode}, population ${trial.count}.`,
        );
    }
    results.push({ mode, trials });
    console.log(
      JSON.stringify(
        trials.map(({ count, summary, reservedInstanceBytes }) => ({
          count,
          summary,
          reservedInstanceBytes,
        })),
      ),
    );
    await context.close();
  }
  const hash = async (root) =>
    createHash('sha256')
      .update(await readFile(resolve(root, 'runtime.js')))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    node: process.version,
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    buildSHA256: {
      current: await hash('lib'),
      baseline: baseline ? await hash(baseline) : null,
    },
    note: 'CPU update/LOD selection and reserved authored instance attributes only. No renderer or GPU work; these timings are not FPS. Fixed 4 m spacing, built-in pine geometry, thinning 60%/20%, 40/100 m LODs, 180 m culling, fades, two teleports. Checkpoints hash exact selected IDs, transforms and fade ranges outside timing. All authored instances and all primary buffers remain resident.',
    results,
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser?.close();
  server.kill();
}
