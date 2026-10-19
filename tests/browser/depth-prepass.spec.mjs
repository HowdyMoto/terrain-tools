import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('reuses occlusion depth without changing cutout coverage, transparency, clipping or renderer state', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error' && /THREE|WebGL|Shader/i.test(e.text()))
      errors.push(e.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TerrainEnvironment } =
      await import('/__runtime_test/lib/runtime.js');
    const { createProject, defaultEnvironmentSettings } =
      await import('/__runtime_test/lib/core.js');
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(512, 256);
    renderer.localClippingEnabled = true;
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(45, 2, 0.1, 40);
    camera.position.set(0, 0, 6);
    const data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const alpha = Math.max(
          0,
          Math.min(1, (Math.sin((x + y * 0.6) / 3) * 0.5 + 0.5) * 1.2),
        );
        data.set([255, Math.round(alpha * 255), 255, 255], (y * 64 + x) * 4);
      }
    const alpha = new THREE.DataTexture(data, 64, 64);
    alpha.needsUpdate = true;
    alpha.minFilter = alpha.magFilter = THREE.LinearFilter;
    const leaf = new THREE.MeshStandardMaterial({
      color: 0x559922,
      alphaMap: alpha,
      alphaTest: 0.4,
      alphaToCoverage: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    const bend = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed.x += sin(position.y * 3.0) * 0.15;',
      );
    };
    leaf.onBeforeCompile = bend;
    const leaves = new THREE.Mesh(new THREE.PlaneGeometry(5, 3, 8, 8), leaf);
    leaves.customDepthMaterial = new THREE.MeshDepthMaterial();
    leaves.customDepthMaterial.onBeforeCompile = bend;
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 6),
      new THREE.MeshStandardMaterial({ color: 0xc06020 }),
    );
    back.position.z = -1;
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 3),
      new THREE.MeshStandardMaterial({
        color: 0x4488ff,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    glass.position.set(1, 0, 0.5);
    const clipped = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 24, 12),
      new THREE.MeshStandardMaterial({
        color: 0xcc44cc,
        clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)],
      }),
    );
    clipped.position.set(-1, 0, 1);
    const wire = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, wireframe: true }),
    );
    wire.position.set(0, 0, 1.5);
    scene.add(back, leaves, glass, clipped, wire);
    const project = createProject(8, 20),
      lighting = new TerrainEnvironment(scene, renderer);
    const settings = {
      ...defaultEnvironmentSettings(),
      fogEnabled: false,
      shadows: false,
      sunIntensity: 2,
      ambientIntensity: 1,
    };
    const cases = [];
    for (const samples of [0, 4]) {
      const target = new THREE.WebGLRenderTarget(512, 256, {
        samples,
        depthTexture: new THREE.DepthTexture(512, 256),
      });
      const render = () => {
        renderer.setRenderTarget(null);
        renderer.setRenderTarget(target);
        lighting.render(camera);
        const bytes = new Uint8Array(512 * 256 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 512, 256, bytes);
        return bytes;
      };
      lighting.set(settings, project);
      const reference = render();
      lighting.set(
        {
          ...settings,
          ambientOcclusion: { enabled: true, radius: 2, strength: 0 },
        },
        project,
      );
      // Reuse this rig across different sample counts; coverage is a shader variant.
      const probe = new THREE.WebGLRenderTarget(512, 256, {
        samples: samples === 0 ? 4 : 0,
        depthTexture: new THREE.DepthTexture(512, 256),
      });
      renderer.setRenderTarget(probe);
      lighting.render(camera);
      renderer.setRenderTarget(target);
      probe.dispose();
      const original = renderer.render.bind(renderer),
        passes = [];
      renderer.render = (s, c) => {
        if (s === scene)
          passes.push({
            target: renderer.getRenderTarget() === target,
            clearDepth: renderer.autoClearDepth,
          });
        return original(s, c);
      };
      const actual = render();
      for (const [name, bytes] of [
        ['reference', reference],
        ['prepass', actual],
      ]) {
        const display = document.createElement('canvas');
        display.width = 512;
        display.height = 256;
        const image = display.getContext('2d').createImageData(512, 256);
        for (let y = 0; y < 256; y++)
          image.data.set(
            bytes.subarray(y * 512 * 4, (y + 1) * 512 * 4),
            (255 - y) * 512 * 4,
          );
        display.getContext('2d').putImageData(image, 0, 0);
        const label = document.createElement('div');
        label.textContent = name + ' samples=' + samples;
        document.body.append(label, display);
      }
      renderer.render = original;
      let total = 0,
        max = 0,
        changed = 0;
      for (let i = 0; i < actual.length; i++) {
        const d = Math.abs(actual[i] - reference[i]);
        total += d;
        max = Math.max(max, d);
        if (d > 8) changed++;
      }
      cases.push({
        samples,
        meanDifference: total / actual.length,
        maxDifference: max,
        changed,
        passes,
        restored:
          renderer.autoClearDepth && renderer.getRenderTarget() === target,
      });
      // A failed beauty pass must restore the clear flags before fallback/retry.
      let injected = false;
      renderer.render = (s, c) => {
        if (s === scene && !renderer.autoClearDepth && !injected) {
          injected = true;
          throw new Error('Injected prepass beauty failure');
        }
        return original(s, c);
      };
      render();
      renderer.render = original;
      const failedState =
        renderer.autoClearDepth && renderer.getRenderTarget() === target;
      render();
      cases.at(-1).recovered =
        injected && failedState && !lighting.animationError;
      target.dispose();
    }
    lighting.set(
      {
        ...settings,
        temporalAA: true,
        ambientOcclusion: { enabled: true, radius: 2, strength: 1 },
      },
      project,
    );
    renderer.setRenderTarget(null);
    for (let i = 0; i < 12; i++) lighting.render(camera);
    return {
      cases,
      glError: renderer.getContext().getError(),
      error: lighting.animationError ?? null,
    };
  });
  await writeFile(
    info.outputPath('prepass.json'),
    JSON.stringify(result, null, 2),
  );
  await page.screenshot({
    path: info.outputPath('prepass.png'),
    fullPage: true,
  });
  for (const sample of result.cases) {
    expect(sample.meanDifference).toBeLessThan(0.1);
    expect(sample.changed).toBeLessThan(50);
    expect(sample.passes).toEqual([
      { target: true, clearDepth: true },
      { target: true, clearDepth: false },
    ]);
    expect(sample.restored).toBe(true);
    expect(sample.recovered).toBe(true);
  }
  expect(result.glError).toBe(0);
  expect(result.error).toBeNull();
  expect(errors).toEqual([]);
});
