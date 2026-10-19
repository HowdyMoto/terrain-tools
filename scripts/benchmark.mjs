import { createProject, applyBrush } from 'terrain-tools';
import { TerrainScene } from 'terrain-tools/three';
import { TerrainPhysics } from 'terrain-tools/rapier';
import { cpus } from 'node:os';
const ms = (fn) => {
  const start = performance.now();
  const result = fn();
  return { milliseconds: performance.now() - start, result };
};
const median = (values) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const terrain = [];
for (const resolution of [256, 512]) {
  const project = createProject(resolution, 512),
    scene = new TerrainScene(project),
    physics = new TerrainPhysics();
  await physics.init();
  const full = ms(() => scene.rebuildTerrain()),
    collision = ms(() => physics.rebuild(project));
  const step = project.size / resolution,
    x = -project.size / 2 + 16 * step,
    z = x,
    region = { minX: x - 5, maxX: x + 5, minZ: z - 5, maxZ: z + 5 };
  const local = [],
    localCollision = [];
  let updated = 0;
  for (let i = 0; i < 12; i++) {
    applyBrush(project, {
      tool: 'raise',
      x,
      z,
      radius: 5,
      strength: 0.1,
      falloff: 0.6,
      target: 0,
      material: 0,
      brushId: 'pine',
      seed: 42,
    });
    const run = ms(() => scene.rebuildTerrain(region));
    updated = run.result.length;
    local.push(run.milliseconds);
    localCollision.push(
      ms(() => physics.rebuild(project, region)).milliseconds,
    );
  }
  terrain.push({
    resolution,
    totalChunks: scene.terrain.children.length,
    updatedChunks: updated,
    fullGeometryMs: full.milliseconds,
    medianLocalGeometryMs: median(local),
    fullCollisionMs: collision.milliseconds,
    medianLocalCollisionMs: median(localCollision),
  });
  physics.dispose();
  scene.dispose();
}
const p = createProject(128, 512);
p.foliage = Array.from({ length: 50000 }, (_, i) => ({
  id: i + 1,
  brushId: 'grass',
  x: ((i % 224) / 224) * 500 - 250,
  z: (Math.floor(i / 224) / 224) * 500 - 250,
  scale: 1,
  rotation: 0,
}));
const scene = new TerrainScene(p);
const initialization = ms(() => scene.rebuildFoliage());
const contactTimes = [];
for (let i = 0; i < 120; i++)
  contactTimes.push(
    ms(() => scene.update(1 / 60, [{ x: 0, z: 0, radius: 4, strength: 1 }]))
      .milliseconds,
  );
const result = {
  node: process.version,
  cpu: cpus()[0]?.model,
  platform: process.platform,
  terrain,
  foliage: {
    instances: p.foliage.length,
    batches: scene.foliage.children.length,
    initializationMs: initialization.milliseconds,
    medianContactCpuMs: median(contactTimes),
  },
  scope:
    'CPU geometry/collider/contact timings only; no GPU rendering, asset decoding, history snapshots, autosave, or browser frame-time claim.',
};
scene.dispose();
console.log(JSON.stringify(result, null, 2));
