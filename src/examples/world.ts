import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  TerrainWorldScene,
  WorldAssets,
  RuntimeMaterialLibrary,
  createModelDecoder,
  TerrainEnvironment,
} from '../runtime';
import type { TerrainProject } from '../core/types';
import { referenceWorld, referenceHeight } from './world-source';
import { createProject } from '../core/terrain';
import { environmentPreset } from '../core/environment';

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.2, 900);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.maxPolarAngle = Math.PI * 0.49;
const status = document.querySelector('#status')!;
const base = new URL(
  import.meta.env.BASE_URL + 'runtime-assets/',
  location.href,
).href;
const manifest = await fetch(base + 'manifest.json').then((r) => {
  if (!r.ok) throw new Error('Build runtime assets first.');
  return r.json();
});
const decoder = createModelDecoder(
  renderer,
  import.meta.env.BASE_URL + 'basis/',
);
const assets = new WorldAssets(undefined, decoder.decode);
const materials = new RuntimeMaterialLibrary(
  renderer,
  manifest.materials,
  base,
  import.meta.env.BASE_URL + 'basis/',
);
assets.materials = materials;
// Only five reusable model payloads, never a copy per tile; decoded resources use leases.
const modelData: TerrainProject['assets'] = {};
for (const [id, entry] of Object.entries(manifest.models) as [
  string,
  { file: string; sha256: string },
][]) {
  const blob = await fetch(base + entry.file).then((r) => r.blob());
  const bytes = await blob.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (hash !== entry.sha256) throw new Error('Prepared model hash mismatch.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  });
  modelData[id] = { name: id, data };
}
const worker = new Worker(
  new URL('./world-source.worker.ts', import.meta.url),
  { type: 'module' },
);
let requestId = 0;
const pending = new Map<
  number,
  { resolve: (p: TerrainProject) => void; reject: (e: Error) => void }
>();
worker.onmessage = (event) => {
  const task = pending.get(event.data.id);
  pending.delete(event.data.id);
  if (event.data.error) task?.reject(new Error(event.data.error));
  else task?.resolve(event.data.project);
};
worker.onerror = (event) => {
  for (const task of pending.values()) task.reject(new Error(event.message));
  pending.clear();
};
const preparation: number[] = [];
const { TerrainPhysics, createWorldCollisionSource } =
  await import('../physics/rapier');
const physics = new TerrainPhysics();
await physics.init();
const world = new TerrainWorldScene(referenceWorld, {
  collision: createWorldCollisionSource(physics.world),
  assets,
  radius: 340,
  maxResidentTiles: 12,
  maxConcurrentLoads: 2,
  cpuByteLimit: 768 * 1024 ** 2,
  gpuByteLimit: 768 * 1024 ** 2,
  lod: new URLSearchParams(location.search).has('full-detail')
    ? false
    : { pixelError: 2 },
  load: async (tile, signal) => {
    const started = performance.now(),
      id = requestId++;
    const p = await new Promise<TerrainProject>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, x: tile.x, z: tile.z });
    });
    signal.throwIfAborted();
    p.assets = modelData;
    p.materials = materials.palette(tile.x < 4 ? [0, 1, 2, 3] : [4, 5, 6, 7]);
    preparation.push(performance.now() - started);
    if (preparation.length > 256) preparation.shift();
    return p;
  },
});
scene.add(world);
const environment = new TerrainEnvironment(scene, renderer),
  proxy = createProject(8, 2000);
const look = environmentPreset('natural');
look.fogNear = 250;
look.fogFar = 650;
look.shadowDistance = 160;
environment.set(look, proxy);
const views = {
  forest: [400, 600],
  open: [1350, 700],
  coast: [850, 1510],
} as const;
function view(name: keyof typeof views) {
  const [x, z] = views[name];
  camera.position.set(x, referenceHeight(x, z) + 5, z);
  controls.target.set(x + 60, referenceHeight(x + 60, z + 50) + 1, z + 50);
  controls.update();
  environment.invalidateHistory();
}
document
  .querySelectorAll<HTMLButtonElement>('[data-view]')
  .forEach(
    (b) => (b.onclick = () => view(b.dataset.view as keyof typeof views)),
  );
view('forest');
const gl = renderer.getContext() as WebGL2RenderingContext,
  debug = gl.getExtension('WEBGL_debug_renderer_info');
const adapter = String(
  gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
);
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
let last = performance.now(),
  recording = false,
  stopped = false,
  frames: number[] = [],
  cpu: number[] = [],
  gpu: number[] = [],
  longTasks: number[] = [];
const queries: WebGLQuery[] = [];
const observer = new PerformanceObserver((list) => {
  if (recording) longTasks.push(...list.getEntries().map((e) => e.duration));
});
observer.observe({ type: 'longtask', buffered: false });
const snapshots: unknown[] = [];
let route:
  | {
      start: number;
      laps: number;
      seconds: number;
      phase: number;
      done: () => void;
    }
  | undefined;
function draw(now: number) {
  if (stopped) return;
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1)),
    started = performance.now();
  if (recording) frames.push(now - last);
  last = now;
  if (route) {
    const elapsed = Math.max(0, (now - route.start) / 1000),
      phase = Math.floor(elapsed / route.seconds);
    if (phase >= route.laps * 3) {
      const done = route.done;
      route = undefined;
      done();
    } else {
      if (phase !== route.phase) {
        route.phase = phase;
        environment.invalidateHistory();
      }
      const [x, z] = Object.values(views)[phase % 3],
        t = elapsed % route.seconds;
      const px = x + t * 20,
        pz = z + Math.sin(t * 0.6) * 40;
      camera.position.set(px, referenceHeight(px, pz) + 5, pz);
      controls.target.set(
        px + 45,
        referenceHeight(px + 45, pz + 40) + 1,
        pz + 40,
      );
    }
  }
  controls.update();
  camera.updateMatrixWorld();
  world.update(camera, dt, innerHeight);
  physics.world.step();
  environment.tick(dt);
  environment.updateCamera(camera);
  let query: WebGLQuery | null = null;
  if (recording && timer && queries.length < 8) {
    query = gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
  }
  environment.render(camera);
  if (query && timer) {
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    queries.push(query);
  }
  if (timer)
    while (
      queries.length &&
      gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = queries.shift()!;
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT))
        gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  if (recording) cpu.push(performance.now() - started);
  if (Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) {
    const s = world.stats;
    status.textContent = `${s.residentTiles} tiles · ${Math.round(s.selectedTerrainTriangles / 1000)}k / ${Math.round(s.fullTerrainTriangles / 1000)}k terrain triangles · ${Math.round(s.assets.gpuBytes / 1024 ** 2)} MiB shared GPU assets · ${s.failedTiles} failed`;
    if (recording)
      snapshots.push({
        time: now,
        stats: s,
        renderer: {
          ...renderer.info.memory,
          submittedTriangles: renderer.info.render.triangles,
          calls: renderer.info.render.calls,
        },
        heap: (
          performance as Performance & { memory?: { usedJSHeapSize: number } }
        ).memory?.usedJSHeapSize,
      });
  }
  requestAnimationFrame(draw);
}
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
requestAnimationFrame(draw);
const api = {
  world,
  assets,
  renderer,
  scene,
  camera,
  environment,
  materials,
  adapter,
  preparation,
  ready: () => {
    camera.updateMatrixWorld();
    world.update(camera, 0, innerHeight);
    return world.whenIdle();
  },
  traverse(laps = 3, seconds = 12) {
    if (
      route ||
      !Number.isInteger(laps) ||
      laps < 1 ||
      laps > 10 ||
      seconds < 1 ||
      seconds > 120
    )
      throw new Error('Invalid traversal.');
    return new Promise<void>((done) => {
      route = { start: performance.now(), laps, seconds, phase: -1, done };
    });
  },
  view,
  move(x: number, z: number, y = 5) {
    camera.position.set(x, referenceHeight(x, z) + y, z);
    controls.target.set(x + 45, referenceHeight(x + 45, z + 40) + 1, z + 40);
    controls.update();
  },
  start() {
    frames = [];
    cpu = [];
    gpu = [];
    longTasks = [];
    snapshots.length = 0;
    recording = true;
  },
  stop() {
    recording = false;
    return {
      adapter,
      width: innerWidth,
      height: innerHeight,
      frames,
      cpu,
      gpu,
      longTasks,
      snapshots,
      preparation,
      loadMilliseconds: [...world.loadMilliseconds],
      colliderCount: physics.world.colliders.len(),
      stats: world.stats,
      sourceEncodedCharacters: Object.values(modelData).reduce(
        (sum, a) => sum + a.data.length,
        0,
      ),
    };
  },
  async dispose() {
    stopped = true;
    world.dispose();
    await world.whenIdle();
    physics.dispose();
    assets.dispose();
    materials.dispose();
    decoder.dispose();
    worker.terminate();
    observer.disconnect();
    controls.dispose();
    environment.dispose();
    renderer.dispose();
  },
};
Object.assign(window, { worldExample: api });
