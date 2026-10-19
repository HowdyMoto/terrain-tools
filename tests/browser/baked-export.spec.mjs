import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { writeFile } from 'node:fs/promises';

test('standard PBR GLB preserves layered appearance, holes, normals and the editable project', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(message.text())
    )
      errors.push(message.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { createProject, parseProjectFile, serializeProject } =
      await import('/__runtime_test/lib/core.js');
    const { TerrainScene, exportTerrainGLB, bakeTerrainSurface } =
      await import('/__runtime_test/lib/runtime.js');
    const project = createProject(32, 32);
    project.view.textureResolution = 256;
    project.view.water = false;
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++) {
        const i = z * 33 + x;
        project.heights[i] = x * 0.12 + Math.sin(z * 0.25) * 0.7;
        const blend = x / 32;
        project.paint.set([blend, 1 - blend, 0, 0], i * 4);
      }
    for (let z = 14; z < 18; z++)
      for (let x = 14; x < 18; x++) project.holes[z * 32 + x] = 1;
    const map = (kind, layer) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d'),
        image = ctx.createImageData(64, 64);
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const color =
            kind === 'albedo'
              ? [
                  90 + layer * 50 + Math.sin((x / 64) * Math.PI * 2) * 35,
                  120 + Math.cos((y / 64) * Math.PI * 2) * 30,
                  55 + layer * 20,
                ]
              : kind === 'normal'
                ? [165, layer === 0 ? 105 : 150, 246]
                : kind === 'orm'
                  ? [180, 155 + layer * 35, 40 + layer * 20]
                  : [90 + Math.sin((x / 64) * Math.PI * 2) * 50, 0, 0];
          image.data.set([...color, 255], (y * 64 + x) * 4);
        }
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL();
    };
    for (let layer = 0; layer < 4; layer++) {
      Object.assign(project.materials[layer], {
        color: layer === 0 ? '#d8be9d' : '#b7c4af',
        tileSize: 8,
        reduceTiling: layer < 2,
        roughness: 0.8,
        metalness: 0.6,
        normalStrength: 0.8,
        normalConvention: layer === 1 ? 'directx' : 'opengl',
        blendHeight: 0.4,
        textures: Object.fromEntries(
          ['albedo', 'normal', 'orm', 'height'].map((kind) => [
            kind,
            map(kind, layer),
          ]),
        ),
      });
    }
    const source = new TerrainScene(project);
    await source.load();
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(256, 256);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#141a20');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x657586, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(-20, 40, 15);
    scene.add(light);
    const camera = new THREE.OrthographicCamera(-23, 23, 23, -23, 0.1, 200);
    camera.position.set(30, 45, 30);
    camera.lookAt(0, 1, 0);
    const target = new THREE.WebGLRenderTarget(256, 256);
    const render = (object) => {
      scene.add(object);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(256 * 256 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
      scene.remove(object);
      return pixels;
    };
    const difference = (a, b) => {
      let count = 0,
        total = 0,
        max = 0,
        large = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) {
          const d = Math.abs(a[i] - b[i]);
          total += d;
          max = Math.max(max, d);
          count++;
          if (d > 12) large++;
        }
      return { mean: total / count, max, large: large / count };
    };
    const original = render(source);
    renderer.setClearColor('#123456', 0.37);
    renderer.autoClear = false;
    renderer.shadowMap.enabled = true;
    const gl = renderer.getContext(),
      hostPack = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, hostPack);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    const state = () => ({
      pack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) === hostPack,
      target: renderer.getRenderTarget() === target,
      clear: renderer.getClearColor(new THREE.Color()).getHex(),
      alpha: renderer.getClearAlpha(),
      auto: renderer.autoClear,
      shadows: renderer.shadowMap.enabled,
      viewport: renderer.getCurrentViewport(new THREE.Vector4()).toArray(),
    });
    const before = state(),
      progress = [];
    const glb = await exportTerrainGLB(source, {
      surface: 'pbr',
      renderer,
      resolution: 1024,
      onProgress: (message) => progress.push(message),
    });
    const after = state();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(hostPack);
    renderer.autoClear = true;
    const json = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true)),
      ),
    );
    const recovered = parseProjectFile(glb);
    const loaded = await new GLTFLoader().parseAsync(glb, '');
    const baked = render(loaded.scene);
    const terrainMaterial = json.materials.find(
      (material) => material.name === 'Baked terrain PBR',
    );
    const primitive = json.meshes[0].primitives[0];
    const sourceIndex = source.terrain.children.reduce(
      (sum, mesh) => sum + mesh.geometry.index.count,
      0,
    );
    const exportedIndex = json.meshes
      .flatMap((mesh) => mesh.primitives)
      .reduce(
        (sum, p) =>
          sum +
          (p.indices === undefined
            ? json.accessors[p.attributes.POSITION].count
            : json.accessors[p.indices].count),
        0,
      );
    const authoring = {
      actual: JSON.parse(serializeProject(recovered)),
      expected: JSON.parse(serializeProject(project)),
    };
    // Abort after a completed pass: the owned atlas and retained source maps must be released.
    const texturesBeforeCancel = renderer.info.memory.textures;
    const checkFramebuffer = gl.checkFramebufferStatus.bind(gl);
    gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_UNSUPPORTED;
    let allocationRejected = false;
    try {
      await bakeTerrainSurface(source, { renderer, resolution: 256 });
    } catch (error) {
      allocationRejected = error.message.includes('allocate');
    } finally {
      gl.checkFramebufferStatus = checkFramebuffer;
    }
    const controller = new AbortController();
    let cancelled = false;
    try {
      await bakeTerrainSurface(source, {
        renderer,
        resolution: 256,
        signal: controller.signal,
        onProgress: (message) => {
          if (message.includes('occlusion')) controller.abort();
        },
      });
    } catch (error) {
      cancelled = error.name === 'AbortError';
    }
    const following = await bakeTerrainSurface(source, {
      renderer,
      resolution: 256,
    });
    following.dispose();
    following.dispose();
    const noTextureLeaks =
      renderer.info.memory.textures === texturesBeforeCancel;
    const liveAfter = render(source);
    project.view.lowPoly = true;
    await source.load(project);
    const flatOriginal = render(source);
    const flatGlb = await exportTerrainGLB(source, {
      surface: 'pbr',
      renderer,
      resolution: 1024,
    });
    const flat = await new GLTFLoader().parseAsync(flatGlb, '');
    const flatPixels = render(flat.scene);
    const flatNormals = [];
    flat.scene.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const n = mesh.geometry.getAttribute('normal');
      for (let i = 0; i < n.count; i += 3)
        flatNormals.push(
          n.getX(i) === n.getX(i + 1) &&
            n.getY(i) === n.getY(i + 1) &&
            n.getZ(i) === n.getZ(i + 2),
        );
    });
    const output = {
      smooth: difference(original, baked),
      flat: difference(flatOriginal, flatPixels),
      sourceUnaffected: difference(original, liveAfter),
      before,
      after,
      cancelled,
      noTextureLeaks,
      allocationRejected,
      authoring,
      sourceIndex,
      exportedIndex,
      progress,
      channels: {
        base: !!terrainMaterial.pbrMetallicRoughness.baseColorTexture,
        orm: !!terrainMaterial.pbrMetallicRoughness.metallicRoughnessTexture,
        normal: !!terrainMaterial.normalTexture,
        ao: !!terrainMaterial.occlusionTexture,
      },
      tangent: primitive.attributes.TANGENT !== undefined,
      uv: primitive.attributes.TEXCOORD_0 !== undefined,
      flatNormals: flatNormals.every(Boolean),
    };
    target.dispose();
    source.dispose();
    renderer.dispose();
    return output;
  });
  const { authoring, ...evidence } = result;
  await writeFile(
    testInfo.outputPath('baked-surface-evidence.json'),
    JSON.stringify({ ...evidence, errors }, null, 2),
  );
  await testInfo.attach('baked-surface-evidence', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  expect(result.before).toEqual(result.after);
  expect(result.channels).toEqual({
    base: true,
    orm: true,
    normal: true,
    ao: true,
  });
  expect(result.tangent).toBe(true);
  expect(result.uv).toBe(true);
  expect(result.sourceIndex).toBe(result.exportedIndex);
  expect(authoring.actual).toEqual(authoring.expected);
  expect(result.cancelled).toBe(true);
  expect(result.noTextureLeaks).toBe(true);
  expect(result.allocationRejected).toBe(true);
  expect(result.sourceUnaffected.mean).toBe(0);
  expect(result.smooth.mean).toBeLessThan(2);
  expect(result.smooth.large).toBeLessThan(0.01);
  expect(result.flat.mean).toBeLessThan(2);
  expect(result.flat.large).toBeLessThan(0.01);
  expect(result.flatNormals).toBe(true);
  expect(errors).toEqual([]);
});

test('editor exports baked PBR and cancels encoding without editing the document', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const { readFile } = await import('node:fs/promises');
  const { decodeDocument } = await import('./fixtures.mjs');
  const errors = [],
    downloads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('download', (file) => downloads.push(file.suggestedFilename()));
  await page.addInitScript(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      if (window.holdExportBlob) {
        (window.exportBlobReleases ??= []).push(() => toBlob.apply(this, args));
        window.releaseExportBlob = () =>
          window.exportBlobReleases.splice(0).forEach((release) => release());
        return;
      }
      return toBlob.apply(this, args);
    };
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await (await inspectorControl(page, '#resolution')).selectOption('32');
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated');
  const save = async (name) => {
    const waiting = page.waitForEvent('download');
    await page.locator('#save').click();
    const path = testInfo.outputPath(name + '.terrain');
    await (await waiting).saveAs(path);
    return decodeDocument(await readFile(path));
  };
  const before = await save('before'),
    history = await page.locator('#undo').getAttribute('title');
  await page.locator('#export-mode').selectOption('pbr-1024');
  await page.evaluate(() => {
    window.holdExportBlob = true;
  });
  const count = downloads.length;
  await page.locator('#export').click();
  await page.waitForFunction(() => !!window.releaseExportBlob);
  await expect(page.locator('#export-progress')).toContainText('Encoding GLB');
  await page.screenshot({ path: testInfo.outputPath('export-progress.png') });
  await page.locator('#cancel-export').click();
  await expect(page.locator('#export-progress')).toContainText('Cancelling');
  await page.evaluate(() => {
    window.holdExportBlob = false;
    window.releaseExportBlob();
  });
  await expect(page.locator('#export-dialog')).toHaveCount(0);
  await expect(page.locator('#toast')).toHaveText('Scene export cancelled.');
  expect(downloads.length).toBe(count);
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  expect(await save('cancelled')).toEqual(before);
  const pending = page.waitForEvent('download');
  await page.locator('#export').click();
  const path = testInfo.outputPath('baked-terrain.glb');
  await (await pending).saveAs(path);
  await expect(page.locator('#export-dialog')).toHaveCount(0);
  const bytes = await readFile(path),
    json = JSON.parse(
      bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
    );
  const material = json.materials.find(
    (material) => material.name === 'Baked terrain PBR',
  );
  expect(material.normalTexture).toBeTruthy();
  expect(material.pbrMetallicRoughness.baseColorTexture).toBeTruthy();
  expect(decodeDocument(bytes)).toEqual(before);
  expect(await save('after')).toEqual(before);
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  await page.screenshot({ path: testInfo.outputPath('export-options.png') });
  expect(errors).toEqual([]);
});
