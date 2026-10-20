import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('automatically bakes existing CC0 trees into relightable distant views without changing exports', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const {
      createProject,
      editFoliageModels,
      environmentPreset,
      defaultFoliageSubsurface,
    } = await import('/__runtime_test/lib/core.js');
    const {
      TerrainScene,
      TerrainEnvironment,
      createTerrainRenderer,
      bakeFoliageImpostor,
      rendererDescription,
    } = await import('/__runtime_test/lib/runtime.js');
    const p = createProject(16, 256);
    p.heights.fill(0);
    p.foliage = [];
    p.view.water = false;
    p.view.textureResolution = 256;
    const data = new Uint8Array(
      await (await fetch('/foliage/photoreal/ph-pine-b.glb')).arrayBuffer(),
    );
    p.assets['ph-pine-b'] = {
      name: 'CC0 pine',
      data: 'data:model/gltf-binary;base64,' + data.toBase64(),
    };
    const model = editFoliageModels(p.brushes[0], [])[0];
    Object.assign(model, {
      model: 'ph-pine-b',
      lods: [{ model: 'ph-pine-b', distance: 60, density: 1 }],
      cullDistance: 900,
      lodFadeDuration: 0.3,
      wind: 0.12,
      color: '#ffffff',
      subsurface: defaultFoliageSubsurface(),
    });
    for (const x of [-20, 0, 20])
      p.foliage.push({
        id: p.nextId++,
        brushId: p.brushes[0].id,
        modelId: model.id,
        x,
        z: 0,
        scale: 1,
        rotation: x * 0.07,
      });
    const saved = JSON.stringify(p);
    const renderer = await createTerrainRenderer();
    renderer.setSize(960, 540);
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const source = new TerrainScene(p, { foliageClusters: false });
    await source.load();
    const hostTarget = new THREE.RenderTarget(8, 8);
    renderer.setRenderTarget(hostTarget);
    renderer.setClearColor('#193344', 0.7);
    renderer.autoClear = false;
    const abort = new AbortController();
    let cancelled = false,
      budgetRejected = false;
    try {
      await bakeFoliageImpostor(source.library.get('ph-pine-b'), {
        renderer,
        signal: abort.signal,
        resolution: 128,
        onProgress: () => abort.abort(),
      });
    } catch (e) {
      cancelled = e.name === 'AbortError';
    }
    try {
      await bakeFoliageImpostor(source.library.get('ph-pine-b'), {
        renderer,
        maxBytes: 1,
      });
    } catch {
      budgetRejected = true;
    }
    const restored =
      renderer.getRenderTarget() === hostTarget &&
      renderer.getClearColor(new THREE.Color()).getHexString() === '193344' &&
      renderer.autoClear === false;
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    hostTarget.dispose();
    let progress = 0;
    const baked = await bakeFoliageImpostor(source.library.get('ph-pine-b'), {
      renderer,
      resolution: 256,
      onProgress: (n) => {
        progress = n;
      },
    });
    const terrain = new TerrainScene(p, {
      foliageClusters: false,
      foliageLazyInstances: true,
      foliageImpostors: new Map([['ph-pine-b', baked]]),
    });
    await terrain.load();
    const scene = new THREE.Scene();
    scene.add(terrain);
    const camera = new THREE.PerspectiveCamera(40, 960 / 540, 0.1, 1000);
    const environment = new TerrainEnvironment(scene, renderer);
    const settings = environmentPreset('natural');
    settings.timeOfDay.enabled = false;
    settings.temporalAA = false;
    settings.fogEnabled = false;
    settings.shadowResolution = 1024;
    settings.shadowDistance = 350;
    await environment.load(settings, p);
    const sourceImages = [];
    const images = [],
      stats = [];
    const target = new THREE.RenderTarget(960, 540);
    for (const [yaw, sun] of [
      [0, 30],
      [90, 30],
      [180, 150],
      [270, 150],
      [45, 30],
      [0, 150],
    ]) {
      const a = (yaw * Math.PI) / 180;
      camera.position.set(Math.sin(a) * 145, 12, Math.cos(a) * 145);
      camera.lookAt(0, 8, 0);
      environment.set({ ...settings, sunAzimuth: sun }, p);
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        terrain.update(1 / 30, [], camera);
        environment.updateCamera(camera);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      images.push(
        new Uint8Array(
          await renderer.readRenderTargetPixelsAsync(target, 0, 0, 960, 540),
        ).toBase64(),
      );
      stats.push({ ...terrain.foliage.viewStats });
      scene.remove(terrain);
      scene.add(source);
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(requestAnimationFrame);
        source.update(1 / 30, [], camera);
        environment.updateCamera(camera);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      sourceImages.push(
        new Uint8Array(
          await renderer.readRenderTargetPixelsAsync(target, 0, 0, 960, 540),
        ).toBase64(),
      );
      scene.remove(source);
      scene.add(terrain);
    }
    renderer.setRenderTarget(null);
    environment.render(camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const primaryAllocated = terrain.foliage.children
      .filter((m) => m.userData.lodLevel === 0)
      .reduce((n, m) => n + m.instanceMatrix.count, 0);
    camera.position.set(0, 8, 35);
    camera.lookAt(0, 6, 0);
    for (let frame = 0; frame < 12; frame++) terrain.update(1 / 30, [], camera);
    const nearStats = { ...terrain.foliage.viewStats };
    camera.position.set(0, 12, 145);
    camera.lookAt(0, 8, 0);
    for (let frame = 0; frame < 12; frame++) terrain.update(1 / 30, [], camera);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    renderer.setRenderTarget(null);
    const exported = terrain.foliage.forExport();
    const exportTriangles = exported.children.reduce(
      (n, m) => n + (m.geometry.index.count / 3) * m.count,
      0,
    );
    const report = {
      adapter: rendererDescription(renderer),
      cancelled,
      budgetRejected,
      restored,
      primaryAllocated,
      nearStats,
      progress,
      views: baked.views,
      bytes: baked.memoryBytes,
      sourceTriangles: baked.sourceTriangles,
      triangles: baked.triangles,
      stats,
      exportTriangles,
      unchanged: saved === JSON.stringify(p),
      validation,
      images,
      sourceImages,
    };
    for (const mesh of exported.children) {
      mesh.geometry.dispose();
      for (const m of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        m.dispose();
      mesh.dispose();
    }
    terrain.dispose();
    source.dispose();
    environment.dispose();
    baked.dispose();
    target.dispose();
    await renderer.backend.device.queue.onSubmittedWorkDone();
    renderer.dispose();
    return report;
  });
  const { images, sourceImages, ...report } = result;
  const comparisons = images.map((encoded, index) => {
    const a = Buffer.from(encoded, 'base64'),
      b = Buffer.from(sourceImages[index], 'base64');
    let actual = 0,
      reference = 0,
      intersection = 0,
      union = 0,
      error = 0;
    for (let y = 215; y < 315; y++)
      for (let x = 280; x < 680; x++) {
        const i = (y * 960 + x) * 4;
        const ma = a[i] + a[i + 1] + a[i + 2] < 140,
          mb = b[i] + b[i + 1] + b[i + 2] < 140;
        if (ma) actual++;
        if (mb) reference++;
        if (ma && mb) intersection++;
        if (ma || mb) {
          union++;
          error +=
            Math.abs(a[i] - b[i]) +
            Math.abs(a[i + 1] - b[i + 1]) +
            Math.abs(a[i + 2] - b[i + 2]);
        }
      }
    return {
      actual,
      reference,
      coverageRatio: actual / Math.max(1, reference),
      iou: intersection / Math.max(1, union),
      meanColorError: error / Math.max(1, union * 3),
    };
  });
  report.comparisons = comparisons;

  await info.attach('impostor-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: '.qa/p1-impostor-preview.png' });
  const sharp = (await import('sharp')).default;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    '.qa/p1-impostor-report.json',
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    '.qa/p1-impostor-source.png',
    await sharp(Buffer.from(sourceImages[0], 'base64'), {
      raw: { width: 960, height: 540, channels: 4 },
    })
      .png()
      .toBuffer(),
  );
  await writeFile(
    '.qa/p1-impostor-view.png',
    await sharp(Buffer.from(images[0], 'base64'), {
      raw: { width: 960, height: 540, channels: 4 },
    })
      .png()
      .toBuffer(),
  );
  for (let i = 0; i < images.length; i++)
    await info.attach('impostor-view-' + i, {
      body: await sharp(Buffer.from(images[i], 'base64'), {
        raw: { width: 960, height: 540, channels: 4 },
      })
        .png()
        .toBuffer(),
      contentType: 'image/png',
    });
  expect(
    comparisons.every(
      (c) =>
        c.reference > 50 &&
        c.coverageRatio > 0.55 &&
        c.coverageRatio < 1.6 &&
        c.iou > 0.3 &&
        c.meanColorError < 55,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(report.validation).toEqual([]);
  expect(report.cancelled).toBe(true);
  expect(report.budgetRejected).toBe(true);
  expect(report.restored).toBe(true);
  expect(report.primaryAllocated).toBe(0);
  expect(report.nearStats.levels[0]).toBe(3);
  expect(report.progress).toBe(120);
  expect(report.unchanged).toBe(true);
  expect(report.triangles).toBeLessThan(report.sourceTriangles / 4);
  expect(report.exportTriangles).toBe(report.sourceTriangles * 3);
  expect(
    report.stats.every((s) => s.instances === 3 && s.levels[1] === 3),
  ).toBe(true);
});
