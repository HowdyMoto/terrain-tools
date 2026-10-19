import {
  createProject,
  BackgroundProjectWriter,
  ProjectPackageWriter,
  packageChecksum,
} from '../src/index';

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
async function measure(operation) {
  await frame();
  let active = true,
    frames = 0,
    maximumGap = 0,
    previous = performance.now();
  let duringWork = 0;
  const tick = () => {
    const now = performance.now();
    maximumGap = Math.max(maximumGap, now - previous);
    previous = now;
    frames++;
    if (active) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const started = performance.now();
  const pending = operation();
  const callMs = performance.now() - started;
  const blob = await pending;
  const elapsedMs = performance.now() - started;
  duringWork = frames;
  await frame();
  active = false;
  return {
    blob,
    callMs,
    elapsedMs,
    animationFramesDuringWork: duringWork,
    maximumFrameGapMs: maximumGap,
  };
}
let running = false;
window.runPersistenceBenchmark = async ({
  payloadMiB = 48,
  rounds = 3,
} = {}) => {
  if (running) throw new Error('A persistence benchmark is already running.');
  if (
    !Number.isInteger(payloadMiB) ||
    payloadMiB < 3 ||
    payloadMiB > 192 ||
    payloadMiB % 3 ||
    !Number.isInteger(rounds) ||
    rounds < 2 ||
    rounds > 8
  )
    throw new Error('Use 3–192 MiB in multiples of three and 2–8 rounds.');
  running = true;
  const status = document.querySelector('#progress');
  const project = createProject(512, 512);
  const perAssetBytes = (payloadMiB * 1048576) / 2;
  project.assets.first = {
    name: 'Synthetic first.glb',
    data: 'data:model/gltf-binary;base64,' + 'AQID'.repeat(perAssetBytes / 3),
  };
  project.assets.second = {
    name: 'Synthetic second.glb',
    data: 'data:model/gltf-binary;base64,' + 'BAUG'.repeat(perAssetBytes / 3),
  };
  project.foliage = Array.from({ length: 50000 }, (_, i) => ({
    id: i + 1,
    brushId: 'pine',
    x: (i % 224) * 2 - 224,
    z: Math.floor(i / 224) * 2 - 224,
    scale: 1,
    rotation: ((i % 360) * Math.PI) / 180,
  }));
  project.nextId = 50001;
  const sync = new ProjectPackageWriter(),
    background = new BackgroundProjectWriter();
  const phases = [];
  try {
    for (const mode of ['main-thread', 'background']) {
      const measurements = [];
      for (let round = 0; round < rounds; round++) {
        status.textContent = mode + ' · round ' + (round + 1);
        project.name = 'Persistence round ' + round;
        project.heights[0] = round;
        const result = await measure(() =>
          mode === 'main-thread'
            ? sync.encode(project)
            : background.encode(project),
        );
        const { blob, ...timing } = result;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        measurements.push({
          round,
          ...timing,
          bytes: blob.size,
          checksum: packageChecksum(bytes),
          ...(mode === 'background' ? { worker: background.stats } : {}),
        });
      }
      phases.push({ mode, measurements });
      sync.clear();
    }
    const result = {
      timestamp: new Date().toISOString(),
      browser: navigator.userAgent,
      grid: 512,
      foliage: 50000,
      payloadMiB,
      rounds,
      phases,
      matchingPackages: phases[0].measurements.every(
        (a, i) =>
          a.bytes === phases[1].measurements[i].bytes &&
          a.checksum === phases[1].measurements[i].checksum,
      ),
      scope:
        'Package encoding only: a 512-cell grid, 50,000 foliage records, and two synthetic base64 model payloads. Assets are not renderable. Snapshot capture, first asset transfer, worker startup and encoding are included; rendering, asset decode, IndexedDB writes, downloads and editor history are excluded. Call time is synchronous main-thread work; frame gaps also depend on browser scheduling and system load. First and cached rounds are reported separately.',
    };
    document.querySelector('#results').textContent = JSON.stringify(
      result,
      null,
      2,
    );
    status.textContent = 'Measurement complete.';
    return result;
  } finally {
    background.dispose();
    sync.clear();
    running = false;
  }
};
document.querySelector('#run').onclick = async () => {
  document.querySelector('#run').disabled = true;
  try {
    await window.runPersistenceBenchmark({
      payloadMiB: Number(document.querySelector('#payload').value),
    });
  } catch (error) {
    document.querySelector('#progress').textContent = String(error);
  } finally {
    document.querySelector('#run').disabled = false;
  }
};
