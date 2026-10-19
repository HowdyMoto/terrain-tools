import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
// Profiles the built renderer with an external content project's saved viewpoint.
// GPU queries use internal targets only for diagnostics; no application debug API.
const root = resolve('.');
const project = process.argv[2];
if (!project)
  throw new Error(
    'Usage: node scripts/benchmark-forest.mjs <project.terrain> [report.json] [runtime directory=lib]',
  );
const output = process.argv[3] ?? '.qa/forest-render.json';
const libRoot = resolve(process.argv[4] ?? 'lib');
const manifest = JSON.parse(
  await readFile(resolve(dirname(project), '../content-manifest.json'), 'utf8'),
);
const view = manifest.viewpoints.original ?? manifest.viewpoints.trail;
if (!view?.position || !view?.target)
  throw new Error('Content manifest needs an original or trail viewpoint.');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.slice(1);
  if (path === 'favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (path === 'view.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(view));
    return;
  }
  if (path === '') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><style>body{margin:0}</style><script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/":"/three/","three/addons/":"/three/examples/jsm/"}}</script>',
    );
    return;
  }
  const local =
    path === 'project.terrain'
      ? project
      : path.startsWith('lib/')
        ? resolve(libRoot, path.slice(4))
        : path.startsWith('three/')
          ? resolve(root, 'node_modules', path)
          : '';
  if (path !== 'project.terrain' && !local.startsWith(root + sep)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type':
      path === 'project.terrain'
        ? 'application/octet-stream'
        : 'text/javascript',
  });
  createReadStream(local).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--force-high-performance-gpu'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  page.on('pageerror', (e) => console.log('ERROR', e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') console.log('CONSOLE', e.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { loadTerrain, TerrainEnvironment } = await import('/lib/runtime.js');
    const { heightAt } = await import('/lib/core.js');
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(1920, 1080);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.append(renderer.domElement);
    const gl = renderer.getContext(),
      ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) throw new Error('GPU timer queries are unavailable.');
    const debug = gl.getExtension('WEBGL_debug_renderer_info'),
      gpu = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    if (!/NVIDIA.*5060/.test(gpu)) throw new Error(gpu);
    const terrain = await loadTerrain(
      await (await fetch('/project.terrain')).arrayBuffer(),
    );
    const scene = new THREE.Scene();
    scene.add(terrain);
    const lighting = new TerrainEnvironment(scene, renderer);
    await lighting.load(terrain.project.environment, terrain.project);
    const camera = new THREE.PerspectiveCamera(75, 1920 / 1080, 0.1, 3000);
    const view = await (await fetch('/view.json')).json();
    camera.position.fromArray(view.position);
    camera.lookAt(...view.target);
    const yaw = camera.rotation.y,
      pitch = camera.rotation.x;
    const eyeHeight = Math.max(
      1.8,
      view.position[1] -
        heightAt(terrain.project, view.position[0], view.position[2]),
    );
    const prepared = lighting.prepared;
    const names = new Map([[null, 'display']]);
    prepared.cascades?.lights.forEach((l, i) =>
      names.set(l.shadow.map, 'shadow' + i),
    );
    if (prepared.occlusion) {
      for (const k of ['depth', 'ao', 'scratch', 'resolved'])
        names.set(prepared.occlusion[k], 'ao-' + k);
    }
    if (prepared.temporal) {
      names.set(prepared.temporal.color, 'beauty');
      prepared.temporal.history.forEach((t) => names.set(t, 'temporal'));
    }
    let active,
      enabled = false;
    const queries = [],
      totals = {},
      counts = {},
      frames = [],
      cpu = [];
    const end = () => {
      if (active) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        queries.push(active);
        active = null;
      }
    };
    const collect = () => {
      if (gl.getParameter(ext.GPU_DISJOINT_EXT))
        throw new Error('Disjoint GPU timings: rerun the measurement.');
      for (const q of [...queries]) {
        if (!gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE)) continue;
        const ms = gl.getQueryParameter(q.query, gl.QUERY_RESULT) / 1e6;
        totals[q.name] = (totals[q.name] ?? 0) + ms;
        counts[q.name] = (counts[q.name] ?? 0) + 1;
        gl.deleteQuery(q.query);
        queries.splice(queries.indexOf(q), 1);
      }
    };
    const set = renderer.setRenderTarget.bind(renderer);
    renderer.setRenderTarget = (target, ...args) => {
      if (enabled && ext) {
        end();
        active = {
          query: gl.createQuery(),
          name: names.get(target) ?? 'other',
        };
        gl.beginQuery(ext.TIME_ELAPSED_EXT, active.query);
      }
      return set(target, ...args);
    };
    let previous, fence;
    for (let i = 0; i < 400;) {
      const stamp = await new Promise(requestAnimationFrame);
      if (fence && gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) {
        continue;
      }
      if (fence) gl.deleteSync(fence);
      collect();
      const phase = i % 120;
      const x = view.position[0] + Math.sin(phase / 60) * 1;
      camera.position.set(
        x,
        heightAt(terrain.project, x, view.position[2] - phase / 90) + eyeHeight,
        view.position[2] - phase / 90,
      );
      camera.rotation.set(pitch, yaw + Math.sin(phase / 60) * 0.1, 0);
      const start = performance.now();
      terrain.update(1 / 30, [], camera);
      lighting.tick(1 / 30);
      enabled = i >= 160;
      lighting.render(camera);
      end();
      enabled = false;
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      if (i >= 160) {
        frames.push(stamp - previous);
        cpu.push(performance.now() - start);
      }
      previous = stamp;
      i++;
    }
    const deadline = performance.now() + 10000;
    while (queries.length && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4));
      collect();
    }
    if (queries.length) throw new Error('Timed out collecting GPU queries.');
    gl.deleteSync(fence);
    const p = (a, q) => [...a].sort((a, b) => a - b)[Math.floor(a.length * q)];
    return {
      gpu,
      ext: !!ext,
      eyeHeight,
      environment: terrain.project.environment,
      foliageInstances: terrain.project.foliage?.length,
      meanFPS: (1000 * frames.length) / frames.reduce((a, b) => a + b, 0),
      frameMedian: p(frames, 0.5),
      frameP95: p(frames, 0.95),
      cpuMedian: p(cpu, 0.5),
      gpuMsPerFrame: Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [k, v / 240]),
      ),
      counts,
      draw: renderer.info.render,
      error: lighting.animationError,
    };
  });
  if (result.error) throw new Error(result.error);
  // Do not duplicate embedded HDR images in the diagnostic report.
  if (result.environment?.image)
    result.environment.image = { name: result.environment.image.name };
  Object.assign(result, {
    recordedAt: new Date().toISOString(),
    browser: browser.version(),
    project,
    projectSHA256: createHash('sha256')
      .update(await readFile(project))
      .digest('hex'),
    runtimeDirectory: libRoot,
    scheduler: 'requestAnimationFrame with one pending GPU fence',
    resolution: [1920, 1080],
    warmupFrames: 160,
    measuredFrames: 240,
    viewpoint: view,
  });
  console.log(JSON.stringify(result, null, 2));
  await page.screenshot({ path: output.replace('.json', '.png') });
  await writeFile(output, JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.close();
}
