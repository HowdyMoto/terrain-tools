import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { chromeGPUArgs } from './chrome-gpu.mjs';
import { benchmarkPower } from './benchmark-power.mjs';
import { installOceanComputeProbe } from './ocean-compute-probe.mjs';
import { runtimePackagePage } from '../tests/browser/runtime-package-page.mjs';
import { portableContentProject } from './read-content-project.mjs';

const option = (name, fallback) =>
  process.argv
    .find((a) => a.startsWith('--' + name + '='))
    ?.slice(name.length + 3) ?? fallback;
const projectPath = option(
  'project',
  'C:/Users/wrigh/Documents/Terrain Studio Projects/Tropical Grove/Tropical-Grove.terrain',
);
const output = option('output', 'test-results/tropical-water.json');
const computeOnly = process.argv.includes('--compute-only');
const runtimeDirectory = option('runtime-lib', 'lib');
const skipCanopy = process.argv.includes('--no-canopy');
const nearClusters = process.argv.includes('--near-clusters');
const variants = option('variants', 'standard,balanced,high').split(',');
if (
  !variants.length ||
  variants.some((value) => !['standard', 'balanced', 'high'].includes(value)) ||
  new Set(variants).size !== variants.length
)
  throw new Error('Choose distinct variants from standard,balanced,high.');
const seconds = Number(option('seconds', computeOnly ? '3' : '10'));
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120)
  throw new Error('Invalid seconds');
const gpuContext = () => {
  try {
    const query = (arguments_) =>
      execFileSync('nvidia-smi', arguments_, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      }).trim();
    return {
      gpu: query([
        '--query-gpu=name,temperature.gpu,utilization.gpu,power.draw,clocks.current.graphics,memory.used',
        '--format=csv',
      ]),
      processes: query([
        '--query-compute-apps=pid,process_name',
        '--format=csv',
      ]),
    };
  } catch {
    return null;
  }
};
const contextBefore = gpuContext();
let server, browser, power;
try {
  const bytes = await portableContentProject(projectPath);
  power = await benchmarkPower();
  const url = 'http://127.0.0.1:5175';
  if (
    !(await fetch(url)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    server = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--configLoader',
        'native',
        '--host',
        '127.0.0.1',
        '--port',
        '5175',
        '--strictPort',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    for (let n = 0; n < 80; n++) {
      if (
        await fetch(url)
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : undefined,
    args: [...chromeGPUArgs(), '--enable-webgpu-developer-features'],
  });
  const page = await browser.newPage({
    baseURL: url,
    viewport: { width: 1920, height: 1080 },
  });
  if (computeOnly) await page.addInitScript(installOceanComputeProbe);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.text().startsWith('BENCH ')) console.log(m.text());
  });
  await page.route('**/__scene.terrain', (route) =>
    route.fulfill({ contentType: 'application/octet-stream', body: bytes }),
  );
  await runtimePackagePage(page, runtimeDirectory);
  const result = await page.evaluate(
    async ({ seconds, computeOnly, skipCanopy, variants, nearClusters }) => {
      const THREE = await import('three');
      const core = await import('/__runtime_test/lib/core.js');
      const {
        TerrainScene,
        TerrainEnvironment,
        createTerrainRenderer,
        rendererDescription,
        webOceanResources,
      } = await import('/__runtime_test/lib/runtime.js');
      const p = core.parseProjectFile(
        await (await fetch('/__scene.terrain')).arrayBuffer(),
      );
      const renderer = await createTerrainRenderer({ timestamps: true });
      renderer.setSize(1920, 1080);
      document.body.replaceChildren(renderer.domElement);
      const adapter = rendererDescription(renderer);
      if (!/RTX 5060/.test(adapter))
        throw new Error('Requires RTX 5060: ' + adapter);
      const validation = [];
      renderer.backend.device.addEventListener('uncapturederror', (e) =>
        validation.push(e.error.message),
      );
      p.environment = core.environmentPreset('natural');
      p.environment.timeOfDay.playing = false;
      p.water = core.defaultWaterSettings(p);
      p.water.ocean.enabled = true;
      p.view.water = true;
      const heights = Array.from(p.heights).sort((a, b) => a - b);
      p.water.seaLevel = heights[Math.floor(heights.length * 0.35)] + 0.15;
      const terrain = new TerrainScene(p, {
        foliageClusters: nearClusters ? { nearby: true } : true,
      });
      await terrain.load();
      const scene = new THREE.Scene();
      scene.add(terrain);
      const camera = new THREE.PerspectiveCamera(55, 1920 / 1080, 0.1, 3000);
      const environment = new TerrainEnvironment(scene, renderer);
      await environment.load(p.environment, p);
      const summarize = (a) => {
        const s = a.slice().sort((a, b) => a - b);
        return {
          samples: a.length,
          p50: s[Math.floor(s.length * 0.5)] ?? null,
          p95: s[Math.floor(s.length * 0.95)] ?? null,
          p99: s[Math.floor(s.length * 0.99)] ?? null,
          max: s.at(-1) ?? null,
        };
      };
      let pending = false;
      const frame = async (delta, gpu) => {
        terrain.update(delta, [], camera);
        environment.tick(delta);
        environment.render(camera);
        if (gpu && !pending && renderer.hasFeature('timestamp-query')) {
          pending = true;
          void renderer
            .resolveTimestampsAsync('render')
            .then(() => gpu.push(renderer.info.render.timestamp))
            .finally(() => (pending = false));
        }
      };
      const runs = [];
      // Reverse the second pass to expose warm/order effects. Same optics and camera.
      const orders = [
        ['forward', variants],
        ['reverse', [...variants].reverse()],
      ];
      for (const [round, selectedVariants] of computeOnly
        ? orders.slice(0, 1)
        : orders) {
        for (const variant of selectedVariants) {
          p.water.ocean.renderer =
            variant === 'standard' ? 'standard' : 'web-ocean';
          p.water.ocean.spectral = {
            ...core.defaultSpectralOceanSettings(),
            quality: variant === 'high' ? 'high' : 'balanced',
          };
          const candidate = terrain.waterSystem.prepare(p);
          try {
            await terrain.waterSystem.prepareGPU(
              candidate,
              renderer,
              camera,
              scene,
            );
            terrain.waterSystem.apply(candidate);
          } finally {
            candidate.dispose();
          }
          for (const view of computeOnly ? ['coast'] : ['coast', 'canopy']) {
            camera.position.set(
              0,
              p.water.seaLevel + (view === 'coast' ? 3.5 : 2.5),
              p.size * (view === 'coast' ? 0.68 : 0.22),
            );
            camera.lookAt(
              0,
              p.water.seaLevel + 0.3,
              p.size * (view === 'coast' ? 0.24 : -0.2),
            );
            camera.updateMatrixWorld();
            environment.invalidateHistory();
            for (let i = 0; i < 90; i++) {
              await new Promise(requestAnimationFrame);
              await frame(1 / 60);
              await renderer.backend.device.queue.onSubmittedWorkDone();
            }
            await renderer.backend.device.queue.onSubmittedWorkDone();
            await window.oceanComputeProfile?.flush();
            const computeStart =
              window.oceanComputeProfile?.samples.length ?? 0;
            const intervals = [],
              cpu = [],
              gpu = [];
            let last = performance.now(),
              start = last,
              now = last;
            while (now - start < seconds * 1000) {
              now = await new Promise(requestAnimationFrame);
              intervals.push(now - last);
              last = now;
              const t = performance.now();
              await frame(
                Math.max(0, Math.min(0.1, intervals.at(-1) / 1000)),
                gpu,
              );
              cpu.push(performance.now() - t);
              await renderer.backend.device.queue.onSubmittedWorkDone();
            }
            await renderer.backend.device.queue.onSubmittedWorkDone();
            await window.oceanComputeProfile?.flush();
            const run = {
              computeMs: summarize(
                window.oceanComputeProfile?.samples.slice(computeStart) ?? [],
              ),
              round,
              variant,
              view,
              frames: cpu.length,
              wallMs: now - start,
              fps: cpu.length / ((performance.now() - start) / 1000),
              frameMs: summarize(intervals.slice(1)),
              cpuMs: summarize(cpu),
              gpuRenderMs: summarize(gpu),
              ocean: webOceanResources(renderer),
              foliage: { ...terrain.foliage.viewStats },
              memory: { ...renderer.info.memory },
            };
            runs.push(run);
            console.log(
              'BENCH ' +
                JSON.stringify({
                  round,
                  variant,
                  view,
                  fps: run.fps,
                  p95: run.frameMs.p95,
                  gpu: run.gpuRenderMs.p95,
                }),
            );
          }
        }
      }
      let canopyBakeMs = 0,
        canopyBytes = 0;
      const canopyFrames = [];
      if (!computeOnly && !skipCanopy) {
        // Same final water scene with canopy field on/off, preserving all authored assets.
        p.environment.canopyLighting = {
          enabled: true,
          strength: 0.65,
          bounce: 0.35,
        };
        const t = performance.now(),
          candidate = await terrain.canopyLighting.prepare(p);
        await terrain.canopyLighting.prepareGPU(candidate, renderer);
        terrain.canopyLighting.apply(candidate);
        environment.set(p.environment, p);
        canopyBakeMs = performance.now() - t;
        for (let i = 0; i < 30; i++) {
          await new Promise(requestAnimationFrame);
          await frame(1 / 60);
          await renderer.backend.device.queue.onSubmittedWorkDone();
        }
        canopyBytes = terrain.canopyLighting.field
          ? terrain.canopyLighting.field.texture.image.data.byteLength +
            terrain.canopyLighting.field.groundTexture.image.data.byteLength
          : 0;

        for (const enabled of [false, true]) {
          p.environment.canopyLighting.enabled = enabled;
          environment.set(p.environment, p);
          environment.invalidateHistory();
          for (let i = 0; i < 60; i++) {
            await new Promise(requestAnimationFrame);
            await frame(1 / 60);
            await renderer.backend.device.queue.onSubmittedWorkDone();
          }
          const intervals = [],
            cpu = [],
            gpu = [];
          let last = performance.now(),
            start = last,
            now = last;
          while (now - start < seconds * 1000) {
            now = await new Promise(requestAnimationFrame);
            intervals.push(now - last);
            last = now;
            const t = performance.now();
            await frame(
              Math.max(0, Math.min(0.1, intervals.at(-1) / 1000)),
              gpu,
            );
            cpu.push(performance.now() - t);
            await renderer.backend.device.queue.onSubmittedWorkDone();
          }
          await renderer.backend.device.queue.onSubmittedWorkDone();
          canopyFrames.push({
            enabled,
            fps: cpu.length / ((performance.now() - start) / 1000),
            frameMs: summarize(intervals.slice(1)),
            cpuMs: summarize(cpu),
            gpuRenderMs: summarize(gpu),
          });
        }
      }
      const computeProfile = window.oceanComputeProfile;
      await computeProfile?.dispose();
      const compute = computeProfile
        ? {
            supported: computeProfile.supported,
            samples: computeProfile.samples.length,
            errors: computeProfile.errors,
          }
        : undefined;
      const beforeDispose = webOceanResources(renderer);
      const project = {
        name: p.name,
        size: p.size,
        plants: p.foliage.length,
        assets: Object.keys(p.assets).length,
        seaLevel: p.water.seaLevel,
      };
      terrain.dispose();
      environment.dispose();
      await renderer.dispose();
      return {
        adapter,
        compute,
        project,
        runs,
        canopyBakeMs,
        canopyBytes,
        canopyFrames,
        beforeDispose,
        cleanup: {
          ocean: webOceanResources(renderer),
          memory: renderer.info.memory.total,
        },
        validation,
      };
    },
    { seconds, computeOnly, skipCanopy, variants, nearClusters },
  );
  const report = {
    date: new Date().toISOString(),
    power: power.power,
    contextBefore,
    contextAfter: gpuContext(),
    browser: browser.version(),
    projectPath: resolve(projectPath),
    projectSHA256: createHash('sha256').update(bytes).digest('hex'),
    source: {
      gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
      runtimeSHA256: createHash('sha256')
        .update(await readFile(resolve(runtimeDirectory, 'runtime.js')))
        .digest('hex'),
      coreSHA256: createHash('sha256')
        .update(await readFile(resolve(runtimeDirectory, 'core.js')))
        .digest('hex'),
    },
    viewport: [1920, 1080],
    secondsPerView: seconds,
    computeOnly,
    variants,
    canopyMeasurement: !computeOnly && !skipCanopy,
    nearClusters,
    note: 'At most one unfinished GPU frame, matching editor admission: each iteration observes the queue fence before its next RAF. FPS counts completed work, not monitor scanout. CPU timing excludes fence waits. Native render timestamp excludes FFT compute passes; frame intervals include integrated work. Driver memory is not measured. External project is loaded read-only; settings are temporary.',
    ...result,
    errors,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log('Saved ' + output);
  if (
    result.compute?.errors.length ||
    (computeOnly && !result.compute?.supported) ||
    errors.length ||
    result.validation.length ||
    result.cleanup.memory ||
    result.cleanup.ocean.simulations
  )
    throw new Error(
      'Rendering errors or resources remain: ' +
        JSON.stringify({
          errors,
          validation: result.validation,
          cleanup: result.cleanup,
        }),
    );
} finally {
  await browser?.close();
  server?.kill();
  await power?.close();
}
