import * as THREE from 'three';
import {
  createProject,
  generateTerrain,
  editFoliageModels,
} from '../src/index';
import { TerrainScene } from '../src/runtime';
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(resolve));
const percentile = (values, fraction) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.floor(values.length * fraction))
      ]
    : null;
let running = false;
window.runFoliageBenchmark = async ({
  count = 10000,
  samples = 30,
  shadows = false,
  fadeDuration = 0,
} = {}) => {
  if (running) throw new Error('A benchmark is already running.');
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 50000 ||
    !Number.isInteger(samples) ||
    samples < 5 ||
    samples > 120 ||
    !Number.isFinite(fadeDuration) ||
    fadeDuration < 0 ||
    fadeDuration > 5
  )
    throw new Error(
      'Use 1–50,000 plants, 5–120 samples, and a fade duration from 0 to 5 seconds.',
    );
  running = true;
  const output = document.querySelector('#results'),
    status = document.querySelector('#progress');
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(960, 540);
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.querySelector('#stage').replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#c5d4d4');
  scene.add(new THREE.HemisphereLight('#eef7ff', '#43513c', 2));
  const sun = new THREE.DirectionalLight('#fff1d7', 3);
  sun.position.set(-100, 220, 80);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -360,
    right: 360,
    top: 360,
    bottom: -360,
    near: 1,
    far: 800,
  });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(60, 960 / 540, 0.1, 1200);
  const project = createProject(32, 512);
  generateTerrain(project, 'flat');
  project.heights.fill(0);
  project.view.water = false;
  const model = editFoliageModels(project.brushes[0], project.foliage)[0];
  Object.assign(model, {
    model: 'pine',
    lods: [{ model: 'pine-low', distance: 80, density: 0.6 }],
    cullDistance: 260,
    lodHysteresis: 0.1,
    wind: 0.8,
    crush: 1,
    alignToNormal: false,
  });
  const columns = Math.ceil(Math.sqrt(count));
  project.foliage = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    brushId: 'pine',
    modelId: 'primary',
    x: ((i % columns) / columns) * 500 - 250,
    z: (Math.floor(i / columns) / columns) * 500 - 250,
    scale: 0.8 + (i % 7) * 0.07,
    rotation: (i * 2.399963) % (Math.PI * 2),
  }));
  project.nextId = count + 1;
  const terrain = new TerrainScene(project);
  scene.add(terrain);
  const gl = renderer.getContext(),
    timer = gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    debug = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = debug
    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const pixel = new Uint8Array(4);
  const started = performance.now();
  try {
    status.textContent = 'Preparing ' + count.toLocaleString() + ' plants…';
    await terrain.load();
    const prepareMs = performance.now() - started;
    const phases = [];
    for (const mode of [
      'full',
      'distance-detail',
      ...(fadeDuration > 0 ? ['cross-fade'] : []),
    ]) {
      status.textContent = 'Measuring ' + mode + '…';
      const prepareStart = performance.now();
      if (mode === 'cross-fade') {
        model.lodFadeDuration = fadeDuration;
        terrain.rebuildFoliage();
      }
      const modePrepareMs = performance.now() - prepareStart;
      terrain.foliage.resetView();
      const measurements = [],
        queries = [];
      for (let i = -8; i < samples; i++) {
        await nextFrame();
        camera.position.set((i / samples - 0.5) * 30, 38, 260);
        camera.lookAt(0, 3, -30);
        const begin = performance.now();
        terrain.update(1 / 60, [], mode === 'full' ? undefined : camera);
        const updated = performance.now();
        const query = timer && i >= 0 ? gl.createQuery() : null;
        if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        renderer.render(scene, camera);
        if (query) gl.endQuery(timer.TIME_ELAPSED_EXT);
        const submitted = performance.now();
        gl.finish();
        // A synchronous pixel readback verifies completion across the browser/GPU process boundary.
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const finished = performance.now();
        if (i >= 0) {
          measurements.push({
            selectionCpuMs: updated - begin,
            submissionCpuMs: submitted - updated,
            blockingFrameMs: finished - begin,
            triangles: renderer.info.render.triangles,
            calls: renderer.info.render.calls,
            transitioning: terrain.foliage.viewStats.transitioning,
            drawnInstances: terrain.foliage.viewStats.drawnInstances,
          });
          if (query) queries.push(query);
        }
      }
      const gpuTimes = [];
      let disjoint = false;
      for (let attempt = 0; queries.length && attempt < 120; attempt++) {
        await nextFrame();
        if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
          disjoint = true;
          break;
        }
        for (let i = queries.length - 1; i >= 0; i--)
          if (gl.getQueryParameter(queries[i], gl.QUERY_RESULT_AVAILABLE)) {
            gpuTimes.push(
              gl.getQueryParameter(queries[i], gl.QUERY_RESULT) / 1e6,
            );
            gl.deleteQuery(queries[i]);
            queries.splice(i, 1);
          }
      }
      const unavailableQueries = queries.length;
      queries.forEach((query) => gl.deleteQuery(query));
      const metric = (key) => ({
        median: percentile(
          measurements.map((m) => m[key]),
          0.5,
        ),
        p95: percentile(
          measurements.map((m) => m[key]),
          0.95,
        ),
      });
      phases.push({
        mode,
        selected: { ...terrain.foliage.viewStats },
        modePrepareMs,
        transitioning: metric('transitioning'),
        drawnInstances: metric('drawnInstances'),
        selectionCpuMs: metric('selectionCpuMs'),
        submissionCpuMs: metric('submissionCpuMs'),
        blockingFrameMs: metric('blockingFrameMs'),
        renderedTriangles: metric('triangles'),
        drawCalls: metric('calls'),
        gpuMs: {
          median: disjoint ? null : percentile(gpuTimes, 0.5),
          p95: disjoint ? null : percentile(gpuTimes, 0.95),
          validSamples: disjoint ? 0 : gpuTimes.length,
          disjoint,
          unavailableQueries,
        },
      });
    }
    const result = {
      timestamp: new Date().toISOString(),
      browser: navigator.userAgent,
      gpu,
      count,
      samples,
      resolution: [960, 540],
      pixelRatio: 1,
      antialias: false,
      shadows,
      shadowResolution: shadows ? 1024 : null,
      fadeDuration,
      wind: true,
      prepareMs,
      timerQueryAvailable: !!timer,
      phases,
      scope:
        'Built-in procedural pines, fixed camera path, 512 m flat terrain. CPU measurements include selection/submission; blocking-frame timings include GPU completion and a synchronous 1-pixel readback, and are not interactive FPS. GPU timers are reported only when valid. Asset decode, history, autosave and realistic asset complexity are not benchmarked.',
    };
    output.textContent = JSON.stringify(result, null, 2);
    status.textContent = 'Measurement complete.';
    window.foliageBenchmarkResult = result;
    return result;
  } finally {
    terrain.dispose();
    sun.dispose();
    renderer.dispose();
    running = false;
  }
};
document.querySelector('#run').onclick = () => {
  document.querySelector('#run').disabled = true;
  window
    .runFoliageBenchmark({
      count: Number(document.querySelector('#count').value),
      shadows: document.querySelector('#shadows').checked,
      fadeDuration: Number(document.querySelector('#fade-duration').value),
    })
    .catch((error) => {
      document.querySelector('#progress').textContent = String(error);
    })
    .finally(() => {
      document.querySelector('#run').disabled = false;
    });
};
