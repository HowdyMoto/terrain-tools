import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { maskedPlantGlb } from './fixtures.mjs';

test('cross-fades complementary pixels and alpha-cutout shadows through reversals, culling, wind, and contact', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await runtimePackagePage(page);
  const metrics = await page.evaluate(
    async (data) => {
      const THREE = await import('three');
      const { TerrainScene } = await import('/__runtime_test/lib/runtime.js');
      const { createProject, editFoliageModels, defaultFoliageSubsurface } =
        await import('/__runtime_test/lib/core.js');
      const project = createProject(32, 64);
      project.heights.fill(0);
      project.foliage = [];
      project.assets = { plant: { name: 'Masked cutout cards.glb', data } };
      const model = editFoliageModels(project.brushes[0], [])[0];
      Object.assign(model, {
        model: 'plant',
        wind: 1,
        crush: 1,
        alignToNormal: false,
        lods: [10, 20, 30].map((distance) => ({
          model: 'plant',
          distance,
          density: 1,
        })),
        cullDistance: 60,
        lodHysteresis: 0,
        lodFadeDuration: 1,
        flexibility: { source: 'attribute', start: 0, end: 1, exponent: 1 },
        subsurface: { ...defaultFoliageSubsurface(), smoothEdges: false },
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
      project.wind.enabled = false;
      Object.assign(project.interaction, {
        enabled: true,
        strength: 1,
        recovery: 1,
      });
      const terrain = new TerrainScene(project);
      await terrain.library.loadAssets(project);
      const alpha = new Uint8Array(4 * 4 * 4);
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          alpha.set([255, (x + y) % 2 ? 255 : 0, 255, 255], (y * 4 + x) * 4);
      const alphaMap = new THREE.DataTexture(alpha, 4, 4);
      alphaMap.needsUpdate = true;
      for (const part of terrain.library.get('plant')) {
        const position = part.geometry.getAttribute('position'),
          uv = new Float32Array(position.count * 2);
        for (let i = 0; i < position.count; i++) {
          const center = position.getX(i) < 0 ? -2 : 2;
          uv[i * 2] = (position.getX(i) - center + 0.2) / 0.4;
          uv[i * 2 + 1] = position.getY(i) / 4;
        }
        part.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        part.material.alphaMap = alphaMap;
        part.material.alphaTest = 0.5;
      }
      terrain.rebuildFoliage();
      const colors = [0xff0000, 0x0000ff, 0x00ff00, 0xffff00];
      for (const mesh of terrain.foliage.children) {
        mesh.material.color.set(0);
        mesh.material.emissive.set(colors[mesh.userData.lodLevel]);
        mesh.material.emissiveIntensity = 1;
      }
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0);
      scene.add(terrain.foliage);
      const sun = new THREE.DirectionalLight(0xffffff, 1);
      sun.position.set(0, 6, 8);
      sun.target.position.set(0, 2, 0);
      sun.castShadow = true;
      sun.shadow.mapSize.set(256, 256);
      Object.assign(sun.shadow.camera, {
        left: -6,
        right: 6,
        top: 6,
        bottom: -6,
        near: 0.1,
        far: 30,
      });
      sun.shadow.camera.updateProjectionMatrix();
      scene.add(sun, sun.target);
      const point = new THREE.PointLight(0xffffff, 1, 30);
      point.position.set(0, 5, 6);
      point.castShadow = true;
      point.shadow.mapSize.set(128, 128);
      scene.add(point);
      const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
      camera.position.set(0, 2, 12);
      camera.lookAt(0, 2, 0);
      const selector = new THREE.PerspectiveCamera();
      const move = (distance) => {
        selector.position.set(0, 0, distance);
        selector.updateMatrixWorld();
        terrain.foliage.updateView(selector);
      };
      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
      });
      renderer.setSize(400, 400);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.BasicShadowMap;
      const target = new THREE.WebGLRenderTarget(400, 400);
      // Three r186 stores basic shadows in depth textures (point lights use a
      // cube). Copy depth into RGBA before readback, including all six faces.
      const depthTarget = new THREE.WebGLRenderTarget(256, 256);
      const depthScene = new THREE.Scene();
      const depthCamera = new THREE.Camera();
      const depthGeometry = new THREE.PlaneGeometry(2, 2);
      const depthMaterials = [false, true].map(
        (cube) =>
          new THREE.ShaderMaterial({
            uniforms: { map: { value: null }, face: { value: 0 } },
            vertexShader:
              'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
            fragmentShader: `#include <packing>
          varying vec2 vUv; uniform ${cube ? 'samplerCube' : 'sampler2D'} map; uniform int face;
          void main(){
            vec2 q=vUv*2.0-1.0;
            vec3 direction=face==0?vec3(1.0,q):face==1?vec3(-1.0,q):face==2?vec3(q.x,1.0,q.y):face==3?vec3(q.x,-1.0,q.y):face==4?vec3(q,1.0):vec3(q,-1.0);
            float depth=${cube ? 'textureCube(map,direction)' : 'texture2D(map,vUv)'}.r;
            gl_FragColor=packDepthToRGBA(depth);
          }`,
            depthTest: false,
            depthWrite: false,
          }),
      );
      const depthQuad = new THREE.Mesh(depthGeometry, depthMaterials[0]);
      depthQuad.frustumCulled = false;
      depthScene.add(depthQuad);
      document.body.style.cssText =
        'margin:0;background:#101820;color:white;font:16px system-ui;display:flex;flex-wrap:wrap';
      const read = () => {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(400 * 400 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 400, 400, pixels);
        const shadows = [sun, point].map((light) => {
          const map = light.shadow.map,
            faces = map.isWebGLCubeRenderTarget ? 6 : 1,
            faceBytes = map.width * map.height * 4,
            data = new Uint8Array(faceBytes * faces);
          depthTarget.setSize(map.width, map.height);
          depthQuad.material = depthMaterials[faces === 6 ? 1 : 0];
          depthQuad.material.uniforms.map.value = map.depthTexture;
          for (let face = 0; face < faces; face++) {
            depthQuad.material.uniforms.face.value = face;
            renderer.setRenderTarget(depthTarget);
            renderer.render(depthScene, depthCamera);
            renderer.readRenderTargetPixels(
              depthTarget,
              0,
              0,
              map.width,
              map.height,
              data.subarray(face * faceBytes, (face + 1) * faceBytes),
            );
          }
          return data;
        });
        return { pixels, shadows };
      };
      const show = (label) => {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        const figure = document.createElement('figure');
        figure.style.margin = '12px';
        const caption = document.createElement('figcaption');
        caption.textContent = label;
        const image = document.createElement('img');
        image.src = renderer.domElement.toDataURL();
        image.width = 400;
        image.height = 400;
        figure.append(caption, image);
        document.body.append(figure);
      };
      const count = (pixels) => {
        const counts = { visible: 0, red: 0, blue: 0, yellow: 0 };
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] || pixels[i + 1] || pixels[i + 2]) {
            counts.visible++;
            if (pixels[i] > 200 && pixels[i + 1] > 200) counts.yellow++;
            else if (pixels[i] > pixels[i + 2]) counts.red++;
            else counts.blue++;
          }
        return counts;
      };
      const diff = (a, b, silhouette = false) => {
        let differences = 0;
        for (let i = 0; i < a.length; i += 4) {
          const changed = silhouette
            ? Boolean(a[i] || a[i + 1] || a[i + 2]) !==
              Boolean(b[i] || b[i + 1] || b[i + 2])
            : a[i] !== b[i] ||
              a[i + 1] !== b[i + 1] ||
              a[i + 2] !== b[i + 2] ||
              a[i + 3] !== b[i + 3];
          if (changed) differences++;
        }
        return differences;
      };
      const results = { frames: [], silhouetteErrors: [], shadowErrors: [] };
      move(0);
      terrain.update(0);
      const original = read();
      show('Primary · red');
      const compare = (label) => {
        const frame = read();
        results.frames.push({
          label,
          ...count(frame.pixels),
          ...terrain.foliage.viewStats,
        });
        results.silhouetteErrors.push(
          diff(original.pixels, frame.pixels, true),
        );
        results.shadowErrors.push(
          ...frame.shadows.map((shadow, i) =>
            diff(original.shadows[i], shadow),
          ),
        );
        return frame;
      };
      move(15);
      const atStart = compare('start');
      results.startErrors = diff(original.pixels, atStart.pixels);
      terrain.update(0.25);
      compare('quarter');
      terrain.update(0.25);
      const half = compare('half');
      show('50% · complementary red / blue pixels');
      move(0);
      const reversed = read();
      results.reversalErrors = diff(half.pixels, reversed.pixels);
      terrain.update(0.25);
      const back = compare('reverse');
      move(45);
      results.skipErrors = diff(back.pixels, read().pixels);
      terrain.update(0.5);
      compare('three levels');
      show('Retarget · red / blue / yellow');
      terrain.update(0.5);
      compare('LOD3');
      show('LOD 3 · yellow');
      move(100);
      terrain.update(0.5);
      const fadingOut = read();
      results.cullVisible = count(fadingOut.pixels).visible;
      results.fullVisible = count(original.pixels).visible;
      results.cullShadowChanges = fadingOut.shadows.map((shadow, i) =>
        diff(original.shadows[i], shadow),
      );
      show('Far cull · 50% coverage');
      move(0);
      results.cullReverseErrors = diff(fadingOut.pixels, read().pixels);
      terrain.update(1);
      results.restoredErrors = diff(original.pixels, read().pixels);
      move(100);
      terrain.update(1);
      results.hidden = count(read().pixels).visible;
      results.hiddenStats = { ...terrain.foliage.viewStats };
      move(0);
      terrain.update(1);
      project.wind.enabled = true;
      project.wind.strength = 2;
      move(15);
      terrain.update(0.5, [{ x: 0, z: 0, radius: 3, strength: 1 }]);
      const bent = read();
      show('Wind + contact · 50% LOD transition');
      const saved = terrain.foliage.children.map((mesh) => ({
        mesh,
        count: mesh.count,
        visible: mesh.visible,
        fade: mesh.geometry.getAttribute('terrainFade').array.slice(),
      }));
      for (const entry of saved) {
        const { mesh } = entry;
        mesh.count = mesh.userData.lodLevel === 0 ? 1 : 0;
        mesh.visible = mesh.count > 0;
        const fade = mesh.geometry.getAttribute('terrainFade');
        fade.setX(0, 0);
        fade.setY(0, 1);
        fade.needsUpdate = true;
      }
      const reference = read();
      results.bentSilhouetteErrors = diff(reference.pixels, bent.pixels, true);
      results.bentShadowErrors = reference.shadows.map((shadow, i) =>
        diff(shadow, bent.shadows[i]),
      );
      for (const entry of saved) {
        entry.mesh.count = entry.count;
        entry.mesh.visible = entry.visible;
        const fade = entry.mesh.geometry.getAttribute('terrainFade');
        fade.array.set(entry.fade);
        fade.needsUpdate = true;
      }
      const exported = terrain.foliage.forExport();
      const exportedMaterials = new Set(),
        exportedGeometry = new Set();
      for (const mesh of exported.children) {
        exportedMaterials.add(mesh.material);
        exportedGeometry.add(mesh.geometry);
        if (mesh.geometry.hasAttribute('terrainFade'))
          throw new Error('Transient fade attribute leaked into export.');
        mesh.dispose();
      }
      exportedMaterials.forEach((material) => material.dispose());
      exportedGeometry.forEach((geometry) => geometry.dispose());
      results.finalRepresentations = terrain.foliage.viewStats.drawnInstances;
      target.dispose();
      depthTarget.dispose();
      depthGeometry.dispose();
      depthMaterials.forEach((m) => m.dispose());
      terrain.dispose();
      alphaMap.dispose();
      sun.shadow.map.dispose();
      point.shadow.map.dispose();
      renderer.dispose();
      return results;
    },
    'data:model/gltf-binary;base64,' + maskedPlantGlb().toString('base64'),
  );
  expect(errors).toEqual([]);
  expect(metrics.fullVisible).toBeGreaterThan(1000);
  expect(metrics.fullVisible).toBeLessThan(5000); // Alpha cutouts are present.
  expect(metrics.startErrors).toBe(0);
  expect(metrics.reversalErrors).toBe(0);
  expect(metrics.skipErrors).toBe(0);
  expect(metrics.silhouetteErrors.every((value) => value === 0)).toBe(true);
  expect(metrics.shadowErrors.every((value) => value === 0)).toBe(true);
  const half = metrics.frames.find((frame) => frame.label === 'half');
  expect(half.blue / half.visible).toBeGreaterThan(0.45);
  expect(half.blue / half.visible).toBeLessThan(0.55);
  expect(half).toMatchObject({
    instances: 1,
    drawnInstances: 2,
    transitioning: 1,
  });
  expect(
    metrics.frames.find((frame) => frame.label === 'three levels')
      .drawnInstances,
  ).toBe(3);
  expect(metrics.cullVisible / metrics.fullVisible).toBeGreaterThan(0.45);
  expect(metrics.cullVisible / metrics.fullVisible).toBeLessThan(0.55);
  expect(metrics.cullShadowChanges.every((value) => value > 20)).toBe(true);
  expect(metrics.cullReverseErrors).toBe(0);
  expect(metrics.restoredErrors).toBe(0);
  expect(metrics.hidden).toBe(0);
  expect(metrics.hiddenStats).toMatchObject({
    instances: 0,
    culled: 1,
    transitioning: 0,
    drawnInstances: 0,
  });
  expect(metrics.bentSilhouetteErrors).toBe(0);
  expect(metrics.bentShadowErrors).toEqual([0, 0]);
  expect(metrics.finalRepresentations).toBe(2);
  const path = testInfo.outputPath('crossfade-metrics.json');
  await writeFile(path, JSON.stringify(metrics, null, 2));
  await testInfo.attach('crossfade-metrics', {
    path,
    contentType: 'application/json',
  });
  await page.screenshot({
    path: testInfo.outputPath('foliage-crossfade.png'),
    fullPage: true,
  });
});
