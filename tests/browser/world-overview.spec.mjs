import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('native distant terrain renders beyond 2.5 km without loading detailed tiles or models', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { createProject } = await import('/__runtime_test/lib/core.js');
    const { TerrainWorldOverview, createTerrainRenderer, rendererDescription } =
      await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    renderer.setSize(512, 384);
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const world = {
      kind: 'terrain-world',
      version: 1,
      tileSize: 250,
      tiles: Array.from({ length: 12 }, (_, x) => ({
        x,
        z: 0,
        source: String(x),
      })),
    };
    let loads = 0;
    const overview = new TerrainWorldOverview(world, {
      radius: 3000,
      maxResidentTiles: 16,
      materials: false,
      load: async () => {
        loads++;
        const p = createProject(32, 250);
        p.heights.fill(0);
        return p;
      },
    });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#000000');
    scene.add(overview, new THREE.AmbientLight('#ffffff', 2));
    const camera = new THREE.PerspectiveCamera(45, 512 / 384, 0.2, 4000);
    camera.position.set(125, 80, 125);
    camera.lookAt(2625, 0, 125);
    camera.updateMatrixWorld();
    overview.update(camera, ['0,0']);
    await overview.whenIdle();
    // Geometry-only mode has no ORM maps; use diffuse ground for this coverage probe.
    for (const key of overview.streaming.residentKeys)
      overview.streaming.get(key).material.metalness = 0;
    const target = new THREE.RenderTarget(512, 384);
    const render = async () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      return renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 384);
    };
    const on = await render();
    const index = (192 * 512 + 256) * 4;
    const visible = [...on.slice(index, index + 3)];
    overview.visible = false;
    const off = await render();
    overview.visible = true;
    const stats = overview.stats;
    const far = overview.streaming.get('10,0');
    const ray = new THREE.Raycaster(
      new THREE.Vector3(2625, 200, 125),
      new THREE.Vector3(0, -1, 0),
    );
    far.updateWorldMatrix(true, false);
    const height = ray.intersectObject(far)[0]?.point.y;
    const restored = overview.streaming.get('0,0');
    overview.update(camera, []);
    const handoff = restored.visible;
    const adapter = rendererDescription(renderer);
    overview.dispose();
    await overview.whenIdle();
    target.dispose();
    renderer.setRenderTarget(null);
    renderer.dispose();
    return {
      visible,
      hidden: [...off.slice(index, index + 3)],
      loads,
      stats,
      height,
      handoff,
      validation,
      adapter,
      cleanup: renderer.info.memory.total,
    };
  });
  await info.attach('distant-coverage.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.visible.reduce((a, b) => a + b, 0)).toBeGreaterThan(150);
  expect(result.hidden).toEqual([0, 0, 0]);
  expect(result.stats.residentTiles).toBe(12);
  expect(result.stats.visibleTiles).toBe(11);
  expect(result.stats.triangles).toBeLessThan(10000);
  expect(result.loads).toBe(12);
  expect(result.height).toBe(0);
  expect(result.handoff).toBe(true);
  expect(result.cleanup).toBe(0);
});
