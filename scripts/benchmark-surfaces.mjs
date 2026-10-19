/** Compare actual surface draw cost; run after build:runtime. No external server or assets required. */
import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const samples = Number(
  process.argv.find((arg) => arg.startsWith('--samples='))?.split('=')[1] ?? 30,
);
const resolution = Number(
  process.argv.find((arg) => arg.startsWith('--resolution='))?.split('=')[1] ??
    1024,
);
if (
  !Number.isInteger(samples) ||
  samples < 5 ||
  samples > 120 ||
  ![256, 512, 1024, 2048].includes(resolution)
)
  throw new Error('Use --samples=5..120 and --resolution=256|512|1024|2048.');
const root = resolve('.');
const source = await readFile(
  resolve(root, 'public/examples/upland/upland-meadow.terrain'),
);
const browser = await chromium.launch({
  executablePath:
    process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : undefined,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /THREE|Shader|WebGL/.test(message.text()))
      errors.push(message.text());
  });
  await page.route('**/__surface_benchmark/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      '/__surface_benchmark/'.length,
    );
    if (path === 'index.html')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Surface benchmark</title><link rel="icon" href="data:,"><style>body{margin:0}</style><script type="importmap">{"imports":{"three":"/__surface_benchmark/three/build/three.module.js","three/":"/__surface_benchmark/three/","three/addons/":"/__surface_benchmark/three/examples/jsm/"}}</script>',
      });
    if (path === 'upland.terrain')
      return route.fulfill({
        contentType: 'application/octet-stream',
        body: source,
      });
    const local = path.startsWith('lib/')
      ? resolve(root, path)
      : path.startsWith('three/')
        ? resolve(root, 'node_modules', path)
        : '';
    if (!local.startsWith(root + sep)) return route.abort();
    return route.fulfill({
      contentType: 'text/javascript',
      body: await readFile(local),
    });
  });
  await page.goto('http://127.0.0.1:5175/__surface_benchmark/index.html');
  const result = await page.evaluate(
    async ({ samples, resolution }) => {
      const THREE = await import('three');
      const { parseProjectFile } =
        await import('/__surface_benchmark/lib/core.js');
      const { TerrainScene } =
        await import('/__surface_benchmark/lib/runtime.js');
      const p = parseProjectFile(
        await (
          await fetch('/__surface_benchmark/upland.terrain')
        ).arrayBuffer(),
      );
      // Keep the reference geometry, layers and maps; isolate surface cost from plants and props.
      p.foliage = [];
      p.props = [];
      p.assets = {};
      p.brushes = [];
      p.view.textureResolution = resolution;
      p.view.water = false;
      const renderer = new THREE.WebGLRenderer({ antialias: false });
      renderer.setPixelRatio(1);
      renderer.setSize(960, 540);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      document.body.append(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#b9c5c7');
      scene.add(new THREE.HemisphereLight('#eef7ff', '#4b4b38', 1.2));
      const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
      sun.position.set(25, 40, 30);
      scene.add(sun);
      const camera = new THREE.OrthographicCamera(
        -36,
        36,
        20.25,
        -20.25,
        0.1,
        300,
      );
      camera.position.set(0, 55, 35);
      camera.lookAt(0, 6, -2);
      const terrain = new TerrainScene(p);
      scene.add(terrain);
      const gl = renderer.getContext();
      const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = gl.getParameter(
        debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
      );
      const nextFrame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const percentile = (values, fraction) =>
        values.length
          ? [...values].sort((a, b) => a - b)[
              Math.min(values.length - 1, Math.floor(values.length * fraction))
            ]
          : null;
      const metric = (values) => ({
        median: percentile(values, 0.5),
        p95: percentile(values, 0.95),
      });
      const pixel = new Uint8Array(4),
        phases = [];
      try {
        const prepareStart = performance.now();
        await terrain.load();
        const prepareMs = performance.now() - prepareStart;
        // Reverse the second pass to expose order/temperature effects.
        for (const [pass, order] of [
          ['forward', [0, 1, 4]],
          ['reverse', [4, 1, 0]],
        ]) {
          for (const enabledLayers of order) {
            p.materials.forEach((m, i) => {
              m.reduceTiling = i < enabledLayers;
            });
            await terrain.terrainMaterial.update(p);
            const blocking = [],
              submission = [],
              queries = [],
              gpuTimes = [];
            let png;
            try {
              for (let i = -8; i < samples; i++) {
                await nextFrame();
                const query = timer && i >= 0 ? gl.createQuery() : null;
                const begin = performance.now();
                if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
                renderer.render(scene, camera);
                if (query) gl.endQuery(timer.TIME_ELAPSED_EXT);
                const submitted = performance.now();
                gl.finish();
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                if (i >= 0) {
                  blocking.push(performance.now() - begin);
                  submission.push(submitted - begin);
                  if (query) queries.push(query);
                }
                if (i === samples - 1 && pass === 'forward')
                  png = renderer.domElement.toDataURL('image/png');
              }
              let disjoint = false;
              for (
                let attempt = 0;
                queries.length && attempt < 120;
                attempt++
              ) {
                await nextFrame();
                if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
                  disjoint = true;
                  break;
                }
                for (let i = queries.length - 1; i >= 0; i--) {
                  if (
                    !gl.getQueryParameter(queries[i], gl.QUERY_RESULT_AVAILABLE)
                  )
                    continue;
                  gpuTimes.push(
                    gl.getQueryParameter(queries[i], gl.QUERY_RESULT) / 1e6,
                  );
                  gl.deleteQuery(queries[i]);
                  queries.splice(i, 1);
                }
              }
              phases.push({
                pass,
                enabledLayers,
                blockingFrameMs: metric(blocking),
                submissionCpuMs: metric(submission),
                gpuMs: {
                  ...metric(disjoint ? [] : gpuTimes),
                  validSamples: disjoint ? 0 : gpuTimes.length,
                  disjoint,
                  unavailableQueries: queries.length,
                },
                triangles: renderer.info.render.triangles,
                drawCalls: renderer.info.render.calls,
                gpuTextures: renderer.info.memory.textures,
                png,
              });
            } finally {
              queries.forEach((query) => gl.deleteQuery(query));
            }
          }
        }
        return {
          timestamp: new Date().toISOString(),
          browser: navigator.userAgent,
          gpu,
          samplesPerPhase: samples,
          resolution: [960, 540],
          textureResolution: resolution,
          antialias: false,
          shadows: false,
          prepareMs,
          timerQueryAvailable: !!timer,
          phases,
          scope:
            'Reference terrain and generated color maps only; foliage/props omitted. Eight warm-up frames per phase. Forward and reverse order. Blocking timings include GPU completion/readback, not interactive FPS. No hardware budget or AA-quality certification.',
        };
      } finally {
        terrain.dispose();
        renderer.dispose();
      }
    },
    { samples, resolution },
  );
  if (errors.length) throw new Error(errors.join('\n'));
  await mkdir('test-results', { recursive: true });
  for (const phase of result.phases) {
    if (phase.png) {
      const path =
        'test-results/surface-variation-' + phase.enabledLayers + '.png';
      await writeFile(path, Buffer.from(phase.png.split(',')[1], 'base64'));
      phase.capture = path;
    }
    delete phase.png;
  }
  const path = 'test-results/surface-benchmark-' + resolution + '.json';
  result.sourceSha256 = createHash('sha256').update(source).digest('hex');
  await writeFile(path, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ path, ...result }, null, 2));
} finally {
  await browser.close();
}
