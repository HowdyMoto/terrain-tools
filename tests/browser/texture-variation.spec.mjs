import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { runtimePackagePage } from './runtime-package-page.mjs';

function errorsFrom(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /THREE|Shader|WebGL/.test(message.text()))
      errors.push(message.text());
  });
  return errors;
}

test('texture variation breaks the tile period while retaining map alignment, continuous patch edges and stable mip filtering', async ({
  page,
}, testInfo) => {
  const errors = errorsFrom(page);
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { createProject } = await import('/__runtime_test/lib/core.js');
    const { TerrainScene } = await import('/__runtime_test/lib/runtime.js');
    const project = createProject(8, 8);
    project.view.textureResolution = 256;
    const pattern = (normal = false) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d'),
        image = ctx.createImageData(256, 256);
      let sum = 0;
      for (let y = 0; y < 256; y++)
        for (let x = 0; x < 256; x++) {
          const f =
            Math.sin((x / 256) * Math.PI * 2) +
              Math.cos((y / 256) * Math.PI * 2) * 0.7 >
            0
              ? 255
              : 0;
          image.data.set(
            normal ? [f, 128, 255, 255] : [f, f, f, 255],
            (y * 256 + x) * 4,
          );
          sum += f;
        }
      ctx.putImageData(image, 0, 0);
      return { url: canvas.toDataURL(), mean: sum / 65536 };
    };
    const signal = pattern(),
      normal = pattern(true);
    Object.assign(project.materials[0], {
      tileSize: 1,
      normalStrength: 1,
      blendHeight: 1,
      textures: {
        albedo: signal.url,
        orm: signal.url,
        height: signal.url,
        normal: normal.url,
      },
    });
    const terrain = new TerrainScene(project),
      surface = terrain.terrainMaterial;
    await surface.update(project);
    const material = surface.material,
      production = material.onBeforeCompile;
    const mode = { value: 0 };
    material.onBeforeCompile = (shader, renderer) => {
      production.call(material, shader, renderer);
      shader.uniforms.probeMode = mode;
      shader.fragmentShader =
        'uniform int probeMode;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        'gl_FragColor=vec4(probeMode==0?tc[0].rgb:probeMode==1?orm[0].rgb:probeMode==2?vec3(th[0]):tn[0]*0.5+0.5,1.0);',
      );
    };
    material.customProgramCacheKey = () => 'texture-variation-verification';
    material.toneMapped = false;
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setSize(256, 256);
    const target = new THREE.WebGLRenderTarget(256, 256, {
      depthBuffer: false,
    });
    const scene = new THREE.Scene(),
      camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    scene.add(mesh);
    function render(output = 0, offset = [0, 0], span = 4, size = 256) {
      mode.value = output;
      target.setSize(size, size);
      mesh.geometry.dispose();
      mesh.geometry = new THREE.PlaneGeometry(span, span);
      mesh.geometry.rotateX(-Math.PI / 2);
      mesh.geometry.translate(offset[0], 0, offset[1]);
      mesh.geometry.setAttribute(
        'layerWeights',
        new THREE.Float32BufferAttribute(
          [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
          4,
        ),
      );
      camera.left = camera.bottom = -span / 2;
      camera.right = camera.top = span / 2;
      camera.updateProjectionMatrix();
      camera.position.set(offset[0], 30, offset[1]);
      camera.up.set(0, 0, -1);
      camera.lookAt(offset[0], 0, offset[1]);
      camera.updateMatrixWorld();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      return pixels;
    }
    const difference = (a, b) => {
      let maximum = 0,
        sum = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) {
          const d = Math.abs(a[i] - b[i]);
          maximum = Math.max(maximum, d);
          sum += d;
        }
      return { maximum, mean: sum / ((a.length / 4) * 3) };
    };
    try {
      const regular = render();
      const regularColorAlignment = difference(regular, render(1));
      const regularPeriod = difference(regular, render(0, [1, 0]));
      const retained = await surface.prepare(project);
      const arrays = retained.value.textures.value.arrays;
      project.materials[0].reduceTiling = true;
      await surface.update(project);
      const candidate = await surface.prepare(project);
      const reusedArrays = candidate.value.textures.value.arrays === arrays;
      candidate.dispose();
      retained.dispose();
      const magnifiedColorAlignment = difference(
        render(0, [0, 0], 0.5),
        render(1, [0, 0], 0.5),
      );
      const varied = render();
      const variedPeriod = difference(varied, render(0, [1, 0]));
      const orm = render(1),
        height = render(2),
        normals = render(3);
      let normalMaximumError = 0;
      for (let i = 0; i < orm.length; i += 4) {
        // Independent +Y projection frame: tangent +X, bitangent -Z, normal +Y.
        const x = (orm[i] / 255) * 2 - 1,
          z = -1 / 255,
          length = Math.hypot(x, 1, z);
        const expected = [x, 1, z].map((v) => ((v / length) * 0.5 + 0.5) * 255);
        for (let c = 0; c < 3; c++)
          normalMaximumError = Math.max(
            normalMaximumError,
            Math.abs(normals[i + c] - expected[c]),
          );
      }
      // Probe all three triangle-edge families in positive and negative cells.
      const boundaries = [],
        boundaryColors = [];
      for (const cell of [-3, 0, 2])
        for (const fraction of [0.21, 0.45, 0.73]) {
          for (const [u, v, axis] of [
            [cell + fraction, 1 - fraction, 0],
            [cell, cell + fraction, 0],
            [cell + fraction, cell, 1],
          ]) {
            const x = 2 * u + v,
              y = Math.sqrt(3) * v;
            const left = render(
              1,
              [x - (axis === 0 ? 0.00001 : 0), -y - (axis === 1 ? 0.00001 : 0)],
              0.0001,
              1,
            );
            const right = render(
              1,
              [x + (axis === 0 ? 0.00001 : 0), -y + (axis === 1 ? 0.00001 : 0)],
              0.0001,
              1,
            );
            boundaryColors.push(left[0]);
            boundaries.push(difference(left, right));
          }
        }
      const distant = render(1, [-0.1, 0.7], 512, 64);
      const mipRange = [255, 0];
      for (let i = 0; i < distant.length; i += 4) {
        mipRange[0] = Math.min(mipRange[0], distant[i]);
        mipRange[1] = Math.max(mipRange[1], distant[i]);
      }
      project.materials[0].reduceTiling = false;
      await surface.update(project);
      const disabled = difference(regular, render());
      delete project.materials[0].reduceTiling;
      await surface.update(project);
      const omitted = difference(regular, render());
      return {
        magnifiedColorAlignment,
        regularColorAlignment,
        regularPeriod,
        variedPeriod,
        alignedColor: difference(varied, orm),
        alignedHeight: difference(height, orm),
        normalMaximumError,
        boundaries,
        boundaryColors,
        mipRange,
        mipExpected: signal.mean,
        disabled,
        omitted,
        reusedArrays,
      };
    } finally {
      target.dispose();
      mesh.geometry.dispose();
      terrain.dispose();
      renderer.dispose();
    }
  });
  await writeFile(
    testInfo.outputPath('texture-variation-evidence.json'),
    JSON.stringify(result, null, 2),
  );
  expect(result.regularPeriod.maximum).toBeLessThanOrEqual(1);
  expect(result.variedPeriod.mean).toBeGreaterThan(10);
  // Hardware sRGB mip storage/filtering introduces up to two 8-bit levels versus numeric ORM.
  expect(result.magnifiedColorAlignment.maximum).toBeLessThanOrEqual(1);
  expect(result.alignedColor.maximum).toBeLessThanOrEqual(2);
  expect(result.alignedHeight.maximum).toBeLessThanOrEqual(1);
  expect(result.normalMaximumError).toBeLessThan(2);
  expect(result.boundaries).toHaveLength(27);
  expect(new Set(result.boundaryColors).size).toBeGreaterThan(4);
  expect(result.boundaries.every((d) => d.maximum <= 4)).toBe(true);
  expect(result.mipRange[1] - result.mipRange[0]).toBeLessThanOrEqual(2);
  expect(
    result.mipRange.every((v) => Math.abs(v - result.mipExpected) <= 3),
  ).toBe(true);
  expect(result.disabled.maximum).toBe(0);
  expect(result.omitted.maximum).toBe(0);
  expect(result.reusedArrays).toBe(true);
  expect(errors).toEqual([]);
});

test('artists can toggle texture variation with undo, preset reuse and native recovery', async ({
  page,
}, testInfo) => {
  const errors = errorsFrom(page);
  const project = createProject(32, 32);
  generateTerrain(project, 'flat');
  project.name = 'Surface variation study';
  project.view.water = false;
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await page.locator('#file-open').setInputFiles({
    name: 'variation.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('[data-tab="materials"]').click();
  await expect(page.locator('#reduce-tiling')).not.toBeChecked();
  const history = await page.locator('#undo').getAttribute('title');
  await (await inspectorControl(page, '#reduce-tiling')).check();
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const changed = await page.locator('#undo').getAttribute('title');
  expect(Number(changed.match(/(\d+) undo steps/)[1])).toBe(
    Number(history.match(/(\d+) undo steps/)[1]) + 1,
  );
  await page.locator('#undo').click();
  await expect(page.locator('#reduce-tiling')).not.toBeChecked();
  await page.locator('#redo').click();
  await expect(page.locator('#reduce-tiling')).toBeChecked();
  const presetDownload = page.waitForEvent('download');
  await (await inspectorControl(page, '#save-surface-preset')).click();
  const presetPath = testInfo.outputPath('variation.surface.json');
  await (await presetDownload).saveAs(presetPath);
  expect(
    JSON.parse(await readFile(presetPath, 'utf8')).material.reduceTiling,
  ).toBe(true);
  await page.locator('[data-material="1"]').click();
  await expect(page.locator('#reduce-tiling')).not.toBeChecked();
  await page.locator('#surface-preset-open').setInputFiles(presetPath);
  await expect(page.locator('#toast')).toContainText('Surface preset loaded');
  await expect(page.locator('#reduce-tiling')).toBeChecked();
  const download = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = testInfo.outputPath('variation.terrain');
  await (await download).saveAs(path);
  const saved = decodeDocument(await readFile(path));
  expect(saved.materials.map((m) => m.reduceTiling ?? false)).toEqual([
    true,
    true,
    false,
    false,
  ]);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('[data-tab="materials"]').click();
  await expect(page.locator('#reduce-tiling')).toBeChecked();
  await page.locator('#file-open').setInputFiles(path);
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await expect(page.locator('#reduce-tiling')).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath('texture-variation-control.png'),
  });
  expect(errors).toEqual([]);
});
