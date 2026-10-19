import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeHeightmapPNG } from 'terrain-tools';
import { decodeDocument, solidPng } from './fixtures.mjs';
import { runtimePackagePage } from './runtime-package-page.mjs';

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(message.text())
    )
      errors.push(message.text());
  });
  return errors;
}
async function save(page, testInfo, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = testInfo.outputPath(name);
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function packedPixel(data) {
  const bytes = Buffer.from(data.split(',')[1], 'base64');
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return Promise.all(
    ['red', 'green', 'blue'].map(async (channel) => {
      const map = await decodeHeightmapPNG(buffer, false, channel);
      expect([map.width, map.height]).toEqual([256, 256]);
      return Math.round(map.values[0] * 255);
    }),
  );
}
async function previewPixels(page) {
  return page
    .locator('[data-orm-preview]')
    .evaluateAll((canvases) =>
      canvases.map((canvas) =>
        Array.from(canvas.getContext('2d').getImageData(64, 64, 1, 1).data),
      ),
    );
}

test('ORM authoring previews numeric channels, retries failure, cancels and restores one-step history', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const Original = window.Uint8Array;
    window.Uint8Array = new Proxy(Original, {
      construct(target, args, constructor) {
        if (
          window.failSurfaceHistoryBytes &&
          args.length === 3 &&
          args[2] === window.failSurfaceHistoryBytes
        ) {
          window.surfaceHistoryFailed = true;
          throw new RangeError('Injected ORM history failure');
        }
        return Reflect.construct(target, args, constructor);
      },
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'src',
    );
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...descriptor,
      set(value) {
        if (value.startsWith('data:image/') && window.failSurfaceDecode) {
          queueMicrotask(() => this.dispatchEvent(new Event('error')));
          return;
        }
        if (value.startsWith('data:image/') && window.holdSurfaceDecode) {
          window.releaseSurfaceDecode = () => descriptor.set.call(this, value);
          return;
        }
        descriptor.set.call(this, value);
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await page.locator('[data-tab="materials"]').click();
  await (
    await inspectorControl(page, '#texture-resolution')
  ).selectOption('256');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const baseline = await save(page, testInfo, 'baseline.terrain');
  const history = await page.locator('#undo').getAttribute('title');
  const files = {
    occlusion: {
      name: 'ao.png',
      mimeType: 'image/png',
      buffer: solidPng(32, 100, 170),
    },
    roughness: {
      name: 'gloss.png',
      mimeType: 'image/png',
      buffer: solidPng(77, 64, 177),
    },
  };
  const configure = async () => {
    await (await inspectorControl(page, '#build-orm')).click();
    for (const [slot, file] of Object.entries(files))
      await page.locator('#orm-' + slot).setInputFiles(file);
    await page.locator('#orm-channel-roughness').selectOption('green');
    await page.locator('#orm-gloss').check();
  };
  await configure();
  await page.locator('#orm-preview').click();
  await expect(page.locator('#orm-apply')).toBeEnabled();
  expect(await previewPixels(page)).toEqual([
    [32, 32, 32, 255],
    [191, 191, 191, 255],
    [255, 255, 255, 255],
  ]);
  await page.screenshot({ path: testInfo.outputPath('orm-preview.png') });
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  await page.locator('#orm-channel-roughness').selectOption('blue');
  await expect(page.locator('#orm-apply')).toBeDisabled();
  expect(await previewPixels(page)).toEqual(Array(3).fill([0, 0, 0, 0]));
  await page.locator('#orm-cancel').click();
  expect(await save(page, testInfo, 'cancelled-preview.terrain')).toEqual(
    baseline,
  );

  await configure();
  await page.locator('#orm-roughness').setInputFiles({
    name: 'bad.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not PNG'),
  });
  await page.locator('#orm-preview').click();
  await expect(page.locator('#orm-status')).toContainText('PNG');
  await expect(page.locator('#orm-preview')).toBeEnabled();
  await expect(page.locator('#orm-apply')).toBeDisabled();
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  await page.locator('#orm-roughness').setInputFiles(files.roughness);
  await page.locator('#orm-preview').click();
  await expect(page.locator('#orm-apply')).toBeEnabled();
  await page.evaluate(() => {
    window.failSurfaceDecode = true;
  });
  await page.locator('#orm-apply').click();
  await expect(page.locator('#orm-status')).toContainText(
    'Could not apply map',
  );
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  await page.evaluate((bytes) => {
    window.failSurfaceDecode = false;
    window.failSurfaceHistoryBytes = bytes;
  }, baseline.heights.length * 4);
  await page.locator('#orm-apply').click();
  await expect(page.locator('#orm-status')).toContainText(
    'Injected ORM history failure',
  );
  expect(await page.evaluate(() => window.surfaceHistoryFailed)).toBe(true);
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  await page.evaluate(() => {
    window.failSurfaceHistoryBytes = 0;
  });
  await page.locator('#orm-apply').click();
  await expect(page.locator('#orm-dialog')).toHaveCount(0);
  const applied = await save(page, testInfo, 'applied.terrain');
  expect(await packedPixel(applied.materials[0].textures.orm)).toEqual([
    32, 191, 255,
  ]);
  const expected = structuredClone(baseline);
  expected.materials[0].textures.orm = applied.materials[0].textures.orm;
  expected.materials[0].roughness = 1;
  expect(applied).toEqual(expected);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, testInfo, 'undone.terrain')).toEqual(baseline);
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, testInfo, 'redone.terrain')).toEqual(applied);

  // Cancelling a prepared image decode must preserve both document and history.
  const afterApplyHistory = await page.locator('#undo').getAttribute('title');
  await (await inspectorControl(page, '#build-orm')).click();
  await page.locator('#orm-metalness').setInputFiles({
    name: 'metal.png',
    mimeType: 'image/png',
    buffer: solidPng(80, 90, 100),
  });
  await page.locator('#orm-preview').click();
  await expect(page.locator('#orm-apply')).toBeEnabled();
  await page.evaluate(() => {
    window.holdSurfaceDecode = true;
  });
  await page.locator('#orm-apply').click();
  await page.waitForFunction(() => !!window.releaseSurfaceDecode);
  await page.locator('#orm-cancel').click();
  await page.evaluate(() => {
    window.holdSurfaceDecode = false;
    window.releaseSurfaceDecode();
  });
  expect(await save(page, testInfo, 'cancelled-apply.terrain')).toEqual(
    applied,
  );
  expect(await page.locator('#undo').getAttribute('title')).toBe(
    afterApplyHistory,
  );

  await (
    await inspectorControl(page, '#normal-convention')
  ).selectOption('directx');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const directx = await save(page, testInfo, 'directx.terrain');
  expected.materials[0].normalConvention = 'directx';
  expect(directx).toEqual(expected);
  await page.locator('#undo').click();
  await expect(page.locator('#normal-convention')).toHaveValue('opengl');
  await page.locator('#redo').click();
  await expect(page.locator('#normal-convention')).toHaveValue('directx');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await page.locator('[data-tab="materials"]').click();
  await expect(page.locator('#normal-convention')).toHaveValue('directx');
  expect(await save(page, testInfo, 'restored.terrain')).toEqual(directx);
  const download = page.waitForEvent('download');
  await page.locator('#export').click();
  const glb = testInfo.outputPath('orm-roundtrip.glb');
  await (await download).saveAs(glb);
  expect(decodeDocument(await readFile(glb))).toEqual(directx);
  await page.locator('#file-open').setInputFiles(glb);
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  expect(await save(page, testInfo, 'glb-restored.terrain')).toEqual(directx);
  expect(errors).toEqual([]);
});

test('production PBR shader renders signed triplanar normal conventions and numeric ORM channels', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await runtimePackagePage(page);
  const result = await page.evaluate(
    async ({ gl, dx, back, orm }) => {
      const THREE = await import('three');
      const { createProject } = await import('/__runtime_test/lib/core.js');
      const { TerrainScene } = await import('/__runtime_test/lib/runtime.js');
      const project = createProject(32, 32);
      project.view.textureResolution = 256;
      project.materials[0].textures.normal = gl;
      project.materials[0].textures.orm = orm;
      project.materials[0].roughness = 0.5;
      project.materials[0].metalness = 0.75;
      const terrain = new TerrainScene(project),
        surface = terrain.terrainMaterial;
      await surface.update(project);
      const material = surface.material,
        productionCompile = material.onBeforeCompile;
      let output = 'normal';
      material.onBeforeCompile = (shader, renderer) => {
        productionCompile.call(material, shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          output === 'normal'
            ? 'gl_FragColor=vec4(normal*0.5+0.5,1.0);'
            : 'gl_FragColor=vec4(surfaceAo,surfaceRoughness,surfaceMetalness,1.0);',
        );
      };
      material.customProgramCacheKey = () =>
        'pbr-output-verification-' + output;
      material.toneMapped = false;
      const renderer = new THREE.WebGLRenderer({ antialias: false });
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setSize(32, 32);
      const target = new THREE.WebGLRenderTarget(32, 32, {
        depthBuffer: false,
      });
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      scene.add(mesh);
      const axes = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
        [1, 1, 1],
        [-1, 1, -1],
        [1, -1, -1],
        [-1, -1, 1],
      ];
      const pixel = new Uint8Array(4);
      const render = (direction) => {
        const n = new THREE.Vector3(...direction).normalize();
        mesh.geometry.dispose();
        mesh.geometry = new THREE.PlaneGeometry(2, 2);
        mesh.geometry.applyQuaternion(
          new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            n,
          ),
        );
        mesh.geometry.setAttribute(
          'layerWeights',
          new THREE.Float32BufferAttribute(
            [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            4,
          ),
        );
        camera.position.copy(n).multiplyScalar(5);
        camera.up.set(
          0,
          Math.abs(n.y) > 0.9 ? 0 : 1,
          Math.abs(n.y) > 0.9 ? 1 : 0,
        );
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 16, 16, 1, 1, pixel);
        return Array.from(pixel);
      };
      const capture = () => axes.map(render);
      const openGl = capture();
      const references = axes.slice(0, 6).map((direction, index) => {
        render(direction);
        const tangents = [
          [0, 0, -1],
          [0, 0, 1],
          [1, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
          [-1, 0, 0],
        ];
        const bitangents = [
          [0, 1, 0],
          [0, 1, 0],
          [0, 0, -1],
          [0, 0, 1],
          [0, 1, 0],
          [0, 1, 0],
        ];
        const normal = new THREE.Vector3(...direction)
          .multiplyScalar((240 / 255) * 2 - 1)
          .addScaledVector(
            new THREE.Vector3(...tangents[index]),
            (176 / 255) * 2 - 1,
          )
          .addScaledVector(
            new THREE.Vector3(...bitangents[index]),
            (201 / 255) * 2 - 1,
          )
          .normalize()
          .applyMatrix3(
            new THREE.Matrix3().getNormalMatrix(camera.matrixWorldInverse),
          )
          .normalize();
        return normal
          .toArray()
          .map((value) => Math.round((value * 0.5 + 0.5) * 255));
      });
      const retained = await surface.prepare(project);
      const originalArrays = retained.value.textures.value.arrays;
      project.materials[0].normalConvention = 'directx';
      await surface.update(project);
      const same = await surface.prepare(project);
      const reused = same.value.textures.value.arrays === originalArrays;
      same.dispose();
      retained.dispose();
      const wrong = capture();
      project.materials[0].textures.normal = dx;
      await surface.update(project);
      const directX = capture();
      project.view.lowPoly = true;
      await surface.update(project);
      const flat = capture();
      project.materials[0].textures.normal = back;
      project.materials[0].normalStrength = 0;
      await surface.update(project);
      const disabled = capture();
      const base = axes.map((direction) => {
        render(direction);
        const n = new THREE.Vector3(...direction)
          .normalize()
          .applyMatrix3(
            new THREE.Matrix3().getNormalMatrix(camera.matrixWorldInverse),
          )
          .normalize();
        return n
          .toArray()
          .map((value) => Math.round((value * 0.5 + 0.5) * 255));
      });
      output = 'orm';
      material.needsUpdate = true;
      const ormPixel = render([0, 1, 0]);
      target.dispose();
      mesh.geometry.dispose();
      terrain.dispose();
      renderer.dispose();
      return {
        openGl,
        directX,
        wrong,
        flat,
        disabled,
        references,
        base,
        reused,
        ormPixel,
      };
    },
    Object.fromEntries(
      Object.entries({
        gl: solidPng(176, 201, 240),
        dx: solidPng(176, 54, 240),
        back: solidPng(110, 90, 0),
        orm: solidPng(32, 192, 128),
      }).map(([key, value]) => [
        key,
        'data:image/png;base64,' + value.toString('base64'),
      ]),
    ),
  );
  const maxError = (a, b) =>
    Math.max(
      ...a.flatMap((pixel, i) =>
        pixel.slice(0, 3).map((v, c) => Math.abs(v - b[i][c])),
      ),
    );
  expect(maxError(result.openGl, result.directX)).toBeLessThanOrEqual(1);
  expect(
    maxError(result.openGl.slice(0, 6), result.references),
  ).toBeLessThanOrEqual(1);
  expect(maxError(result.openGl, result.wrong)).toBeGreaterThan(70);
  expect(maxError(result.openGl, result.flat)).toBeLessThanOrEqual(1);
  expect(maxError(result.disabled, result.base)).toBeLessThanOrEqual(1);
  expect(result.reused).toBe(true);
  expect(result.ormPixel).toEqual([32, 96, 96, 255]);
  expect(errors).toEqual([]);
});
