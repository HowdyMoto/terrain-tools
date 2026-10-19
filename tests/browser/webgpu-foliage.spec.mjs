import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { maskedPlantGlb } from './fixtures.mjs';

test('native WebGPU preserves rigid masks, wind/contact deformation and directional/point shadows', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(
    async (data) => {
      const THREE = await import('three');
      const { TerrainScene, createTerrainRenderer } =
        await import('/__runtime_test/lib/runtime.js');
      const { createProject, editFoliageModels } =
        await import('/__runtime_test/lib/core.js');
      const project = createProject(32, 64);
      project.heights.fill(0);
      project.foliage = [];
      project.props = [];
      project.assets = { plant: { name: 'Painted plant.glb', data } };
      const model = editFoliageModels(project.brushes[0], [])[0];
      Object.assign(model, {
        model: 'plant',
        wind: 1,
        crush: 1,
        alignToNormal: false,
        flexibility: { source: 'attribute', start: 0, end: 1, exponent: 1 },
      });
      project.foliage = [
        {
          id: 1,
          brushId: project.brushes[0].id,
          modelId: model.id,
          x: 0,
          z: 0,
          scale: 1,
          rotation: 0,
        },
      ];
      project.nextId = 2;
      Object.assign(project.wind, {
        enabled: false,
        strength: 2,
        direction: 0,
        speed: 1,
        gust: 0,
      });
      Object.assign(project.interaction, {
        enabled: true,
        strength: 1,
        recovery: 0.2,
      });
      const terrain = new TerrainScene(project);
      await terrain.library.loadAssets(project);
      terrain.rebuildFoliage();
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x101820);
      scene.add(terrain.foliage, new THREE.AmbientLight(0xffffff, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.position.set(0, 6, 8);
      light.target.position.set(0, 2, 0);
      light.castShadow = true;
      light.shadow.mapSize.set(256, 256);
      Object.assign(light.shadow.camera, {
        left: -6,
        right: 6,
        top: 6,
        bottom: -6,
        near: 0.1,
        far: 30,
      });
      light.shadow.camera.updateProjectionMatrix();
      scene.add(light, light.target);
      const point = new THREE.PointLight(0xffffff, 2, 30);
      point.position.set(0, 5, 6);
      point.castShadow = true;
      point.shadow.mapSize.set(128, 128);
      scene.add(point);
      const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
      camera.position.set(0, 2, 12);
      camera.lookAt(0, 2, 0);
      const renderer = await createTerrainRenderer();
      const { NodeMaterial, QuadMesh } = await import('three/webgpu');
      const {
        texture: nodeTexture,
        cubeTexture,
        uv,
        normalize,
        screenCoordinate,
        ivec2,
        vec3,
        vec4,
      } = await import('three/tsl');
      renderer.setSize(400, 400);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      document.body.style.cssText =
        'margin:0;background:#101820;color:white;font:16px system-ui;display:flex;flex-wrap:wrap';
      const target = new THREE.WebGLRenderTarget(400, 400);
      const readShadow = async (light) => {
        const map = light.shadow.map;
        const copy = new NodeMaterial();
        copy.fragmentNode = vec4(
          vec3(
            light.isPointLight
              ? cubeTexture(
                  map.depthTexture,
                  normalize(vec3(uv().mul(2).sub(1), -1)),
                ).compare(0.98)
              : nodeTexture(map.depthTexture).load(ivec2(screenCoordinate.xy))
                  .r,
          ),
          1,
        );
        const quad = new QuadMesh(copy);
        const output = new THREE.WebGLRenderTarget(map.width, map.height);
        renderer.setRenderTarget(output);
        quad.render(renderer);
        const pixels = await renderer.readRenderTargetPixelsAsync(
          output,
          0,
          0,
          map.width,
          map.height,
        );
        copy.dispose();
        output.dispose();
        return pixels;
      };
      const snapshot = async (label) => {
        await new Promise(requestAnimationFrame);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const padded = await renderer.readRenderTargetPixelsAsync(
          target,
          0,
          0,
          400,
          400,
        );
        // Native readback rows are padded to a 256-byte boundary.
        const pixels = new Uint8Array(400 * 400 * 4);
        for (let y = 0; y < 400; y++)
          pixels.set(padded.subarray(y * 1792, y * 1792 + 1600), y * 1600);
        const shadows = [await readShadow(light), await readShadow(point)];
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        const figure = document.createElement('figure');
        figure.style.margin = '12px';
        const caption = document.createElement('figcaption');
        caption.textContent = label + ' · left rigid / right flexible';
        const image = document.createElement('img');
        image.src = renderer.domElement.toDataURL();
        image.width = 400;
        image.height = 400;
        figure.append(caption, image);
        document.body.append(figure);
        return { pixels, shadows };
      };
      const differences = (a, b, left = 0, right = 400, width = 400) => {
        let count = 0;
        for (let i = 0; i < a.length; i += 4) {
          const x = (i / 4) % width;
          if (
            x >= left &&
            x < right &&
            Math.abs(a[i] - b[i]) +
              Math.abs(a[i + 1] - b[i + 1]) +
              Math.abs(a[i + 2] - b[i + 2]) >
              0
          )
            count++;
        }
        return count;
      };
      terrain.update(0);
      const rest = await snapshot('Rest');
      project.wind.enabled = true;
      terrain.update(0.75);
      const wind = await snapshot('Wind');
      project.wind.enabled = false;
      terrain.clearInteractions();
      terrain.update(0.1, [{ x: 0, z: 0, radius: 3, strength: 1 }]);
      const crushed = await snapshot('Contact');
      terrain.update(10);
      const recovered = await snapshot('Recovered');
      const stats = {
        windRigid: differences(rest.pixels, wind.pixels, 0, 200),
        windFlexible: differences(rest.pixels, wind.pixels, 200, 400),
        contactRigid: differences(rest.pixels, crushed.pixels, 0, 200),
        contactFlexible: differences(rest.pixels, crushed.pixels, 200, 400),
        recovery: differences(rest.pixels, recovered.pixels),
        windShadows: rest.shadows.map((p, i) =>
          differences(
            p,
            wind.shadows[i],
            0,
            Infinity,
            i ? point.shadow.map.width : light.shadow.map.width,
          ),
        ),
        contactShadows: rest.shadows.map((p, i) =>
          differences(
            p,
            crushed.shadows[i],
            0,
            Infinity,
            i ? point.shadow.map.width : light.shadow.map.width,
          ),
        ),
      };

      target.dispose();
      terrain.dispose();
      light.dispose();
      point.dispose();
      renderer.dispose();
      return stats;
    },
    'data:model/gltf-binary;base64,' + maskedPlantGlb().toString('base64'),
  );
  expect(errors).toEqual([]);
  expect(result.windRigid).toBe(0);
  expect(result.contactRigid).toBe(0);
  expect(result.windFlexible).toBeGreaterThan(100);
  expect(result.contactFlexible).toBeGreaterThan(100);
  expect(result.recovery).toBe(0);
  expect(result.windShadows.every((value) => value > 20)).toBe(true);
  expect(result.contactShadows.every((value) => value > 20)).toBe(true);
  await writeFile(
    testInfo.outputPath('native-deformation-metrics.json'),
    JSON.stringify(result, null, 2),
  );
  await page.screenshot({
    path: testInfo.outputPath('native-foliage-deformation.png'),
    fullPage: true,
  });
});

test('unloading shared foliage batches preserves neighboring native buffers and releases the final lease', async ({
  page,
}) => {
  await runtimePackagePage(page);
  const result = await page.evaluate(
    async (data) => {
      const THREE = await import('three');
      const { TerrainScene, WorldAssets, createTerrainRenderer } =
        await import('/__runtime_test/lib/runtime.js');
      const { createProject, editFoliageModels } =
        await import('/__runtime_test/lib/core.js');
      const renderer = await createTerrainRenderer();
      renderer.setSize(256, 256);
      const device = renderer.backend.device,
        errors = [];
      device.addEventListener('uncapturederror', (e) =>
        errors.push(e.error.message),
      );
      const assets = new WorldAssets(),
        scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0xffffff, 3));
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(0, 2, 6);
      camera.lookAt(0, 1, 0);
      const make = async () => {
        const p = createProject(8, 16);
        p.view.water = false;
        p.view.textureResolution = 256;
        p.assets = { plant: { name: 'shared plant', data } };
        const model = editFoliageModels(p.brushes[0], [])[0];
        Object.assign(model, {
          model: 'plant',
          wind: 1,
          crush: 1,
          alignToNormal: false,
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
        p.nextId = 2;
        const terrain = new TerrainScene(p, { assets });
        await terrain.load();
        terrain.terrain.visible = false;
        scene.add(terrain);
        return terrain;
      };
      const render = async () => {
        await new Promise(requestAnimationFrame);
        renderer.render(scene, camera);
        await device.queue.onSubmittedWorkDone();
      };
      const a = await make(),
        b = await make();
      a.position.x = -1;
      b.position.x = 1;
      await render();
      await render();
      const memoryBefore = { ...renderer.info.memory };
      a.removeFromParent();
      a.dispose();
      await render();
      await render();
      const survivor = renderer.domElement.toDataURL();
      const c = await make();
      c.position.x = -1;
      await render();
      b.removeFromParent();
      b.dispose();
      await render();
      await render();
      c.removeFromParent();
      c.dispose();
      assets.dispose();
      await render();
      const memoryAfter = { ...renderer.info.memory };
      renderer.dispose();
      return { errors, survivor, memoryBefore, memoryAfter };
    },
    'data:model/gltf-binary;base64,' + maskedPlantGlb().toString('base64'),
  );
  expect(result.errors).toEqual([]);
  expect(result.survivor.length).toBeGreaterThan(1000);
  expect(result.memoryAfter.attributes).toBeLessThan(
    result.memoryBefore.attributes,
  );
  expect(result.memoryAfter.geometries).toBeLessThan(
    result.memoryBefore.geometries,
  );
});
