import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
test('mixed terrain detail preserves rendered seams and full-resolution queries at 1080p', async ({
  page,
}) => {
  test.setTimeout(90000);
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TerrainWorldScene, TerrainLod } =
      await import('/__runtime_test/lib/runtime.js');
    const { createProject } = await import('/__runtime_test/lib/core.js');
    const renderer = new THREE.WebGLRenderer({
      powerPreference: 'high-performance',
    });
    renderer.setSize(1920, 1080);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xff00ff);
    scene.overrideMaterial = new THREE.MeshNormalMaterial();
    const camera = new THREE.PerspectiveCamera(60, 1920 / 1080, 0.1, 2000);
    camera.position.set(12, 32, 100);
    camera.lookAt(70, 0, 10);
    camera.updateMatrixWorld();
    const world = new TerrainWorldScene(
      {
        kind: 'terrain-world',
        version: 1,
        tileSize: 64,
        tiles: [
          { x: 0, z: 0, source: 'left' },
          { x: 1, z: 0, source: 'right' },
        ],
      },
      {
        radius: 200,
        materials: false,
        lod: { pixelError: 2, transitionSeconds: 0 },
        load: async ({ x }) => {
          const p = createProject(8, 64);
          p.resolution = 128;
          p.heights = new Float32Array(129 ** 2);
          p.paint = new Float32Array(129 ** 2 * 4);
          p.holes = new Uint8Array(128 ** 2);
          p.view.water = false;
          for (let j = 0; j <= 128; j++)
            for (let i = 0; i <= 128; i++) {
              const wx = x * 64 + i * 0.5;
              p.heights[j * 129 + i] =
                Math.sin(wx * 0.07) * 2 +
                Math.cos(j * 0.035) * 1.5 +
                Math.sin(wx * 0.7) * 0.04;
            }
          return p;
        },
      },
    );
    scene.add(world);
    world.update(camera, 0, 1080);
    await world.whenIdle();
    for (let i = 0; i < 8; i++) world.update(camera, 1 / 60, 1080);
    const stats = world.stats,
      heights = [world.heightAt(63.99, 30), world.heightAt(64.01, 30)];
    const target = new THREE.WebGLRenderTarget(1920, 1080),
      gl = renderer.getContext(),
      extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const adapter = gl.getExtension('WEBGL_debug_renderer_info');
    function select(full) {
      for (const tile of world.tiles) {
        tile.terrain.visible = full;
        tile.children.find((c) => c instanceof TerrainLod).visible = !full;
      }
    }
    const pixels = [];
    const timings = [];
    for (const full of [false, true]) {
      select(full);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera); // warm the variant
      const output = new Uint8Array(1920 * 1080 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 1920, 1080, output);
      pixels.push(output);
      const cpu = [],
        gpu = [];
      for (let i = 0; i < 25; i++) {
        await new Promise(requestAnimationFrame);
        const q = extension ? gl.createQuery() : null;
        if (q) gl.beginQuery(extension.TIME_ELAPSED_EXT, q);
        const t = performance.now();
        renderer.render(scene, camera);
        cpu.push(performance.now() - t);
        if (q) {
          gl.endQuery(extension.TIME_ELAPSED_EXT);
          while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))
            await new Promise(requestAnimationFrame);
          if (!gl.getParameter(extension.GPU_DISJOINT_EXT))
            gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(q);
        }
      }
      timings.push({
        full,
        cpu,
        gpu,
        triangles: renderer.info.render.triangles,
      });
    }
    let changed = 0,
      total = 0,
      maximum = 0,
      cracks = 0;
    for (let i = 0; i < pixels[0].length; i += 4) {
      let delta = 0;
      for (let c = 0; c < 3; c++)
        delta = Math.max(delta, Math.abs(pixels[0][i + c] - pixels[1][i + c]));
      if (delta > 8) changed++;
      total += delta;
      maximum = Math.max(maximum, delta);
    }
    // Probe the shared edge with both tiles present, away from exterior silhouettes.
    const point = new THREE.Vector3();
    for (let z = 2; z < 62; z += 0.25) {
      point.set(64, world.heightAt(64, z), z).project(camera);
      const x = Math.floor((point.x * 0.5 + 0.5) * 1920),
        y = Math.floor((point.y * 0.5 + 0.5) * 1080);
      if (x < 0 || x >= 1920 || y < 0 || y >= 1080) continue;
      const i = (y * 1920 + x) * 4;
      if (pixels[0][i] > 250 && pixels[0][i + 1] < 5 && pixels[0][i + 2] > 250)
        cracks++;
    }
    const measured = {
      adapter: gl.getParameter(adapter?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
      stats,
      heights,
      cracks,
      meanMaxChannelError: total / (1920 * 1080),
      fractionOver8: changed / (1920 * 1080),
      maximum,
      timings,
    };
    world.dispose();
    await world.whenIdle();
    target.dispose();
    scene.overrideMaterial.dispose();
    renderer.dispose();
    return measured;
  });
  await mkdir('.qa', { recursive: true });
  await writeFile(
    '.qa/world-lod-quality.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  expect(errors).toEqual([]);
  expect(result.stats.failedTiles).toBe(0);
  expect(result.cracks).toBe(0);
  expect(result.stats.selectedTerrainTriangles).toBeLessThan(
    result.stats.fullTerrainTriangles * 0.75,
  );
  expect(Math.abs(result.heights[0] - result.heights[1])).toBeLessThan(0.01);
  expect(result.meanMaxChannelError).toBeLessThan(2);
  expect(result.fractionOver8).toBeLessThan(0.01);
});
