import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { seedEditorProject } from './seed-editor-project.mjs';
import { inspectorControl } from './inspector-controls.mjs';
import {
  createProject,
  editFoliageModels,
  serializeProject,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { readFile } from 'node:fs/promises';

test('native capsule bends touched leaves away, anchors wood and canopy, recovers and records motion', async ({
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
    const { mrt, output, velocity, vec4, Fn, float } =
      await import('three/tsl');
    const { TerrainScene, createTerrainRenderer } =
      await import('/__runtime_test/lib/runtime.js');
    const { createProject, editFoliageModels, serializeProject } =
      await import('/__runtime_test/lib/core.js');
    const p = createProject(8, 32);
    p.heights.fill(0);
    p.wind.enabled = false;
    p.foliage = [];
    p.props = [];
    const model = editFoliageModels(p.brushes[0], [])[0];
    Object.assign(model, {
      model: 'grass',
      alignToNormal: false,
      crush: 1,
      wind: 0,
      interaction: { enabled: true, radius: 100, recovery: 0.3 },
      flexibility: { source: 'attribute', start: 0, end: 1, exponent: 1 },
    });
    p.foliage = [
      {
        id: 1,
        brushId: p.brushes[0].id,
        modelId: model.id,
        x: 0,
        z: 0,
        scale: 1,
        rotation: 0,
      },
    ];
    const before = serializeProject(p);
    const terrain = new TerrainScene(p);
    const parts = terrain.library.get('grass');
    parts.forEach((part) => {
      part.geometry.dispose();
      part.material.dispose();
    });
    parts.length = 0;
    for (const [x, flexible] of [
      [-0.2, false],
      [0.2, true],
    ]) {
      const geometry = new THREE.PlaneGeometry(0.24, 3, 3, 48).translate(
        x,
        1.5,
        0,
      );
      const count = geometry.getAttribute('position').count;
      const flexibility = new Float32Array(count),
        tangents = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        flexibility[i] = flexible
          ? Math.min(
              1,
              Math.max(0, geometry.getAttribute('position').getY(i) / 0.3),
            )
          : 0;
        tangents.set([1, 0, 0, 1], i * 4);
      }
      geometry.setAttribute(
        '_terrain_flexibility',
        new THREE.BufferAttribute(flexibility, 1),
      );
      geometry.setAttribute('tangent', new THREE.BufferAttribute(tangents, 4));
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3),
      );
      // Normal map + tangent + vertex colors exercise the complete 16-attribute MRT pipeline.
      const normalMap = new THREE.DataTexture(
        new Uint8Array([128, 128, 255, 255]),
        1,
        1,
      );
      normalMap.needsUpdate = true;
      const material = new THREE.MeshStandardMaterial({
        color: flexible ? 0x60d030 : 0xc04030,
        normalMap,
        vertexColors: true,
        side: THREE.DoubleSide,
        alphaTest: 0.5,
      });
      parts.push({ geometry, material, matrix: new THREE.Matrix4() });
    }
    terrain.rebuildFoliage();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101820);
    scene.add(
      terrain.foliage,
      new THREE.HemisphereLight(0xffffff, 0xffffff, 3),
    );
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(0, 5, 6);
    light.castShadow = true;
    light.shadow.mapSize.set(128, 128);
    scene.add(light, light.target);
    const camera = new THREE.OrthographicCamera(-1.2, 1.2, 3.3, -0.3, 0.1, 30);
    camera.position.set(0, 0, 6);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const renderer = await createTerrainRenderer();
    renderer.setSize(320, 480);
    renderer.shadowMap.enabled = true;
    document.body.style.cssText =
      'margin:0;background:#101820;color:white;font:14px system-ui;display:flex;flex-wrap:wrap';
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const target = new THREE.RenderTarget(320, 480, {
      type: THREE.HalfFloatType,
      count: 2,
    });
    target.textures[0].name = 'output';
    target.textures[1].name = 'velocity';
    const confidence = Fn(
      (builder) => builder.material.terrainHistoryNode ?? float(1),
    )();
    const outputs = mrt({ output, velocity: vec4(velocity, 0, confidence) });
    const draw = async (label) => {
      await new Promise(requestAnimationFrame);
      renderer.setRenderTarget(target);
      renderer.setMRT(outputs);
      renderer.render(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        320,
        480,
        0,
        0,
      );
      const motion = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        320,
        480,
        1,
      );
      let speed = 0;
      for (let i = 0; i < motion.length; i += 4)
        speed +=
          Math.abs(THREE.DataUtils.fromHalfFloat(motion[i])) +
          Math.abs(THREE.DataUtils.fromHalfFloat(motion[i + 1]));
      renderer.setMRT(null);
      renderer.setRenderTarget(null);
      if (label) {
        const figure = document.createElement('figure');
        figure.style.margin = '10px';
        const caption = document.createElement('figcaption');
        caption.textContent = label;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 480;
        const context = canvas.getContext('2d');
        const display = context.createImageData(320, 480);
        const color = new THREE.Color();
        for (let i = 0; i < pixels.length; i += 4) {
          color
            .setRGB(
              THREE.DataUtils.fromHalfFloat(pixels[i]),
              THREE.DataUtils.fromHalfFloat(pixels[i + 1]),
              THREE.DataUtils.fromHalfFloat(pixels[i + 2]),
            )
            .convertLinearToSRGB();
          display.data.set(
            [color.r * 255, color.g * 255, color.b * 255, 255],
            i,
          );
        }
        context.putImageData(display, 0, 0);
        const image = document.createElement('img');
        image.src = canvas.toDataURL();
        image.width = 320;
        image.height = 480;
        figure.append(caption, image);
        document.body.append(figure);
      }
      return { pixels, speed };
    };
    const body = {
      x: 0,
      z: 0,
      radius: 0.35,
      strength: 1,
      capsule: { bottom: 0, top: 1.95 },
    };
    terrain.update(1 / 60);
    await draw();
    const rest = await draw('Rest · red wood / green leaves');
    terrain.update(1 / 60, [body]);
    const pushed = await draw('Player capsule · low leaves pushed right');
    terrain.update(1 / 60, [body]);
    await draw();
    terrain.update(1 / 60, [body]);
    const settled = await draw();
    terrain.clearInteractions();
    terrain.update(1 / 60, [{ ...body, x: 0.4 }]);
    const reverse = await draw('Capsule on the right · leaves pushed left');
    terrain.update(40);
    const recovered = await draw('Recovered');
    terrain.update(1 / 60, [{ ...body, capsule: { bottom: 5, top: 6.95 } }]);
    const above = await draw();
    const diff = (a, b, x0 = 0, x1 = 320, y0 = 0, y1 = 480) => {
      let changed = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const at = (y * 320 + x) * 4;
          if (
            a[at] !== b[at] ||
            a[at + 1] !== b[at + 1] ||
            a[at + 2] !== b[at + 2]
          )
            changed++;
        }
      return changed;
    };
    const greenCenter = (pixels) => {
      let sum = 0,
        count = 0;
      for (let y = 180; y < 450; y++)
        for (let x = 0; x < 320; x++) {
          const at = (y * 320 + x) * 4;
          if (
            THREE.DataUtils.fromHalfFloat(pixels[at + 1]) > 0.2 &&
            THREE.DataUtils.fromHalfFloat(pixels[at + 1]) >
              THREE.DataUtils.fromHalfFloat(pixels[at]) * 1.3
          ) {
            sum += x;
            count++;
          }
        }
      return sum / count;
    };
    const stats = {
      flexible: diff(rest.pixels, pushed.pixels, 160, 320),
      rigid: diff(rest.pixels, pushed.pixels, 0, 150),
      canopy: diff(rest.pixels, pushed.pixels, 0, 320, 0, 120),
      recovered: diff(rest.pixels, recovered.pixels),
      above: diff(rest.pixels, above.pixels),
      restCenter: greenCenter(rest.pixels),
      pushCenter: greenCenter(pushed.pixels),
      reverseCenter: greenCenter(reverse.pixels),
      moving: pushed.speed,
      settled: settled.speed,
      validation,
      unchanged: serializeProject(p) === before,
    };
    target.dispose();
    terrain.dispose();
    light.dispose();
    renderer.dispose();
    return stats;
  });
  await writeFile(
    info.outputPath('capsule-foliage.json'),
    JSON.stringify(result, null, 2),
  );
  await page.screenshot({
    path: info.outputPath('capsule-foliage.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.unchanged).toBe(true);
  expect(result.flexible).toBeGreaterThan(100);
  expect(result.rigid).toBe(0);
  expect(result.canopy).toBe(0);
  expect(result.recovered).toBe(0);
  expect(result.above).toBe(0);
  expect(result.pushCenter).toBeGreaterThan(result.restCenter + 3);
  expect(result.reverseCenter).toBeLessThan(result.restCenter - 3);
  expect(result.moving).toBeGreaterThan(0.1);
  expect(result.settled).toBeLessThan(0.01);
});

test('walk mode emits a swept player capsule and artist contact presets remain undoable without saving footprints', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    window.walkCapsuleUploads = 0;
    const write = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (
      buffer,
      offset,
      source,
      start = 0,
      size,
    ) {
      if (source instanceof Float32Array && source.length % 20 === 0) {
        for (
          let i = start;
          i + 19 < Math.min(source.length, start + (size ?? source.length));
          i += 20
        ) {
          if (
            source[i + 12] < 0 &&
            Math.abs(source[i + 13] - 0.35) < 0.001 &&
            Math.abs(source[i + 19] - source[i + 18] - 1.95) < 0.01
          )
            window.walkCapsuleUploads++;
        }
      }
      return write.call(this, buffer, offset, source, start, size);
    };
  });
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 60000,
  });
  const p = createProject(32, 64);
  p.heights.fill(0);
  p.view.water = false;
  p.view.textureResolution = 256;
  p.wind.enabled = false;
  p.foliage = [];
  const model = editFoliageModels(p.brushes[0], [])[0];
  Object.assign(model, {
    model: 'grass',
    crush: 1,
    wind: 0,
    interaction: { enabled: true, radius: 2, recovery: 3 },
    flexibility: { source: 'height', start: 0.02, end: 1, exponent: 1 },
  });
  for (let z = -20; z <= 20; z++)
    for (let x = -20; x <= 20; x++)
      p.foliage.push({
        id: p.foliage.length + 1,
        brushId: p.brushes[0].id,
        modelId: model.id,
        x,
        z,
        scale: 1.5,
        rotation: ((x + z) * 0.1) % (Math.PI * 2),
      });
  p.nextId = p.foliage.length + 1;
  await page
    .locator('#file-open')
    .setInputFiles({
      name: 'Capsule meadow.json',
      mimeType: 'application/json',
      buffer: Buffer.from(serializeProject(p)),
    });
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  await page.locator('[data-tab=foliage]').click();
  await page.getByRole('tab', { name: 'Effects', exact: true }).click();
  await (await inspectorControl(page, '[data-contact-preset=woody]')).click();
  await expect(page.locator('#flexibility-source')).toHaveValue('leaves');
  await page.locator('#undo').click();
  await expect(page.locator('#flexibility-source')).toHaveValue('height');
  const save = async (name) => {
    const pending = page.waitForEvent('download');
    await page.locator('#save').click();
    const file = info.outputPath(name + '.terrain');
    await (await pending).saveAs(file);
    return decodeDocument(await readFile(file));
  };
  const before = await save('before-walking');
  await page.locator('#frame').click();
  await page.locator('#walk').click();
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.55);
  await expect(page.locator('#walk-hint')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.55);
  await expect(page.locator('.stage')).toHaveClass(/walking/);
  await expect
    .poll(() => page.evaluate(() => window.walkCapsuleUploads), {
      timeout: 30000,
    })
    .toBeGreaterThan(0);
  await page.keyboard.down('w');
  const uploads = await page.evaluate(() => window.walkCapsuleUploads);
  await expect
    .poll(() => page.evaluate(() => window.walkCapsuleUploads), {
      timeout: 30000,
    })
    .toBeGreaterThan(uploads + 10);
  await page.keyboard.up('w');
  await page.keyboard.press('v');
  await expect(page.locator('.stage')).not.toHaveClass(/walking/);
  expect(await save('after-walking')).toEqual(before);
});
