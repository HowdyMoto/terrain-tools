import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  editFoliageModels,
  serializeProject,
  defaultFoliageSubsurface,
} from 'terrain-tools';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { decodeDocument, maskedPlantGlb } from './fixtures.mjs';

function track(page) {
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

for (const backend of ['webgl', 'webgpu'])
  test(`${backend}: transmits backlight through leaves while respecting shadows, thickness, bark and cutout silhouettes`, async ({
    page,
  }, info) => {
    const errors = track(page);
    await runtimePackagePage(page);
    const result = await page.evaluate(async (backend) => {
      const THREE = await import('three');
      const {
        configureFoliageSubsurface,
        createTerrainRenderer,
        rendererDescription,
      } = await import('/__runtime_test/lib/runtime.js');
      const { defaultFoliageSubsurface } =
        await import('/__runtime_test/lib/core.js');
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0);
      const camera = new THREE.OrthographicCamera(
        -1.3,
        1.3,
        1.3,
        -1.3,
        0.1,
        20,
      );
      camera.position.set(0, 0, 5);
      camera.lookAt(0, 0, 0);
      const bytes = new Uint8Array(32 * 32 * 4);
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const i = (y * 32 + x) * 4;
          bytes.set(
            [
              80,
              180,
              40,
              ((x - 15.5) / 13) ** 2 + ((y - 15.5) / 15) ** 2 < 1 ? 255 : 0,
            ],
            i,
          );
        }
      const texture = new THREE.DataTexture(bytes, 32, 32);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      const geometry = new THREE.PlaneGeometry(2, 2);
      const source = new THREE.MeshStandardMaterial({
        map: texture,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 1,
      });
      const leaf = new THREE.Mesh(geometry, source);
      leaf.receiveShadow = true;
      scene.add(leaf);
      const sun = new THREE.DirectionalLight(0xffffff, 5);
      sun.position.set(0, 0, -5);
      sun.castShadow = true;
      sun.shadow.mapSize.set(512, 512);
      Object.assign(sun.shadow.camera, {
        left: -2,
        right: 2,
        top: 2,
        bottom: -2,
        near: 0.1,
        far: 15,
      });
      sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.bias = -0.0001;
      scene.add(sun, sun.target);
      const blocker = new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, 0.7),
        new THREE.MeshStandardMaterial({ color: 0, side: THREE.DoubleSide }),
      );
      blocker.position.z = -1;
      blocker.castShadow = true;
      blocker.visible = false;
      scene.add(blocker);
      const native = backend === 'webgpu';
      const renderer = native
        ? await createTerrainRenderer()
        : new THREE.WebGLRenderer({
            antialias: true,
            preserveDrawingBuffer: true,
          });
      renderer.setSize(256, 256);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      const target = new THREE.WebGLRenderTarget(256, 256);
      const render = async () => {
        if (native) await new Promise(requestAnimationFrame);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(256 * 256 * 4);
        if (native)
          pixels.set(
            await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256),
          );
        else renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
        return pixels;
      };
      const center = (pixels) => {
        let sum = 0;
        for (let y = 115; y < 141; y++)
          for (let x = 115; x < 141; x++) sum += pixels[(y * 256 + x) * 4 + 1];
        return sum / (26 * 26);
      };
      const show = (label) => {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        const figure = document.createElement('figure');
        const caption = document.createElement('figcaption');
        caption.textContent = label;
        const image = document.createElement('img');
        image.src = renderer.domElement.toDataURL();
        figure.append(caption, image);
        document.body.append(figure);
      };
      document.body.style.cssText =
        'margin:0;background:#171e20;color:white;font:16px system-ui;display:flex;flex-wrap:wrap';
      const off = center(await render());
      show('Standard PBR · backlit');
      const material = source.clone();
      configureFoliageSubsurface(material, {
        ...defaultFoliageSubsurface(),
        smoothEdges: false,
      });
      leaf.material = material;
      const onPixels = await render(),
        on = center(onPixels);
      show('Thin-leaf transmission');
      blocker.visible = true;
      const shadow = center(await render());
      show('Same leaf · cast shadow');
      blocker.visible = false;
      const thick = source.clone();
      configureFoliageSubsurface(thick, {
        ...defaultFoliageSubsurface(),
        thickness: 4,
        smoothEdges: false,
      });
      leaf.material = thick;
      const absorbed = center(await render());
      show('Thicker / absorbing leaf');
      const bark = new THREE.MeshStandardMaterial({
        color: '#805430',
        roughness: 1,
        side: THREE.DoubleSide,
      });
      configureFoliageSubsurface(bark, defaultFoliageSubsurface());
      leaf.material = bark;
      const opaqueBark = center(await render());
      sun.position.z = 5;
      leaf.material = source;
      const frontOff = await render();
      leaf.material = material;
      const frontOn = await render();
      const frontDifference = frontOn.reduce(
        (sum, v, i) => sum + Math.abs(v - frontOff[i]),
        0,
      );
      const hole = onPixels[(30 * 256 + 30) * 4 + 1];
      const result = {
        off,
        on,
        shadow,
        absorbed,
        opaqueBark,
        frontDifference,
        hole,
        renderer: native
          ? rendererDescription(renderer)
          : renderer.getContext().getParameter(renderer.getContext().RENDERER),
      };
      for (const m of [source, material, thick, bark, blocker.material])
        m.dispose();
      geometry.dispose();
      blocker.geometry.dispose();
      texture.dispose();
      sun.shadow.dispose();
      target.dispose();
      renderer.dispose();
      return result;
    }, backend);
    expect(result.on).toBeGreaterThan(result.off + 30);
    expect(result.shadow).toBeLessThan(result.on * 0.15);
    expect(result.absorbed).toBeLessThan(result.on * 0.15);
    expect(result.opaqueBark).toBe(0);
    expect(result.frontDifference).toBe(0);
    expect(result.hole).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath('leaf-lighting-comparison.png'),
      fullPage: true,
    });
    await writeFile(
      info.outputPath('leaf-lighting-metrics.json'),
      JSON.stringify(result, null, 2),
    );
  });

test('authors leaf lighting and natural sunlight with failed preparation recovery, undo and portable saves', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const errors = track(page);
  await page.addInitScript(() => {
    const original = Float32Array;
    window.restoreLeafPreparation = () => {
      window.Float32Array = original;
    };
    window.Float32Array = new Proxy(original, {
      construct(target, args, constructor) {
        if (window.rejectLeafPreparation && args[0] === 16) {
          window.caughtLeafPreparation = true;
          throw new RangeError('Injected leaf preparation failure');
        }
        return Reflect.construct(target, args, constructor);
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(16, 32);
  project.name = 'Leaf lighting authoring';
  project.wind.enabled = false;
  project.view.water = false;
  project.view.textureResolution = 256;
  project.assets.leaf = {
    name: 'Leaf fixture',
    data:
      'data:model/gltf-binary;base64,' + maskedPlantGlb().toString('base64'),
  };
  const model = editFoliageModels(project.brushes[0], [])[0];
  Object.assign(model, {
    model: 'leaf',
    flexibility: { source: 'height', start: 0, end: 1, exponent: 1 },
    lods: [{ model: 'leaf', distance: 20, density: 1 }],
    lodFadeDuration: 0.35,
  });
  project.foliage = [
    {
      id: 1,
      brushId: project.brushes[0].id,
      modelId: model.id,
      x: 0,
      z: 0,
      scale: 2,
      rotation: 0,
    },
  ];
  project.nextId = 2;
  await page.locator('#file-open').setInputFiles({
    name: 'leaves.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const save = async (selector, name) => {
    const pending = page.waitForEvent('download', { timeout: 20000 });
    await (await inspectorControl(page, selector)).click();
    const path = info.outputPath(name);
    await (await pending).saveAs(path);
    return { path, data: decodeDocument(await readFile(path)) };
  };
  const original = await save('#save', 'before.terrain');
  const history = await page
    .locator('#undo, #redo')
    .evaluateAll((nodes) =>
      nodes.map((n) => ({ title: n.title, disabled: n.disabled })),
    );
  await page.evaluate(() => {
    window.rejectLeafPreparation = true;
  });
  await page.locator('#leaf-enabled').evaluate((input) => {
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#toast')).toContainText(
    'previous plants and settings were kept',
  );
  expect(await page.evaluate(() => window.caughtLeafPreparation)).toBe(true);
  await page.evaluate(() => {
    window.rejectLeafPreparation = false;
  });
  await expect(page.locator('#leaf-enabled')).not.toBeChecked();
  expect(
    await page
      .locator('#undo, #redo')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ title: n.title, disabled: n.disabled })),
      ),
  ).toEqual(history);
  expect((await save('#save', 'failed.terrain')).data).toEqual(original.data);
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#leaf-enabled')).not.toBeChecked();
  await (await inspectorControl(page, '#leaf-enabled')).check();
  await (await inspectorControl(page, '#leaf-mode')).selectOption('all');
  await page.locator('#leaf-thickness').evaluate((input) => {
    input.value = '0.65';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#leaf-thickness')).toHaveValue('0.65');
  await page.locator('#undo').click();
  await expect(page.locator('#leaf-thickness')).toHaveValue('0.3');
  await page.locator('#redo').click();
  await expect(page.locator('#leaf-thickness')).toHaveValue('0.65');
  await (await inspectorControl(page, '[data-leaf-material="0"]')).uncheck();
  expect(
    (await save('#save', 'excluded-material.terrain')).data.brushes[0].models[0]
      .subsurface.materials,
  ).toEqual([]);
  await page.locator('#undo').click();
  await expect(page.locator('[data-leaf-material="0"]')).toBeChecked();
  const brush = await save('#save-brush', 'leaves.foliage.json');
  const expected = {
    ...defaultFoliageSubsurface(),
    mode: 'all',
    thickness: 0.65,
  };
  expect(brush.data.brush.models[0].subsurface).toEqual(expected);
  await page.locator('[data-tab=light]').click();
  await (
    await inspectorControl(page, '#environment-preset')
  ).selectOption('natural');
  await expect(page.locator('#env-toneMapping')).toHaveValue('agx');
  await expect(page.locator('#daylight-enabled')).toBeChecked();
  await expect(page.locator('#env-environmentIntensity')).toHaveValue('0.2');
  await expect(page.locator('#env-backgroundIntensity')).toHaveValue('1');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const saved = await save('#save', 'leaves.terrain');
  expect(saved.data.brushes[0].models[0].subsurface).toEqual(expected);
  expect(saved.data.environment.shadowNormalBias).toBe(0.025);
  await page.locator('#undo').click();
  await expect(page.locator('#env-toneMapping')).toHaveValue('aces');
  await page.locator('#redo').click();
  await expect(page.locator('#env-toneMapping')).toHaveValue('agx');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('[data-tab=light]').click();
  await expect(page.locator('#env-toneMapping')).toHaveValue('agx');
  // GLTFExporter compares typed-array constructors; retire the allocation fault proxy.
  await page.evaluate(() => window.restoreLeafPreparation());
  const glb = await save('#export', 'leaves.glb');
  expect(glb.data.brushes[0].models[0].subsurface).toEqual(expected);
  const runtime = await context.newPage();
  const runtimeErrors = track(runtime);
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime.locator('#open-project').setInputFiles(glb.path);
  await expect(runtime.locator('#status')).toContainText('1 foliage instances');
  await page.locator('[data-tab=foliage]').click();
  await (
    await inspectorControl(page, '.foliage-shading-controls')
  ).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('leaf-lighting-controls.png'),
  });
  expect(errors).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
