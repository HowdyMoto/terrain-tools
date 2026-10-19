import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { serializeProject, parseProject } from '../src/core/serialization';
import {
  defaultEnvironmentSettings,
  environmentPreset,
  parseEnvironmentSettings,
} from '../src/core/environment';
import {
  TerrainEnvironment,
  prepareEnvironment,
  validateEnvironmentHDR,
} from '../src/runtime/environment';

function hdr(rle = false) {
  const header = new TextEncoder().encode(
    '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 32 +X 64\n',
  );
  const pixels = new Uint8Array(rle ? 32 * 12 : 64 * 32 * 4);
  if (rle)
    for (let y = 0; y < 32; y++)
      pixels.set([2, 2, 0, 64, 192, 128, 192, 64, 192, 32, 192, 130], y * 12);
  else
    for (let i = 0; i < pixels.length; i += 4)
      pixels.set([128, 64, 32, 130], i);
  const buffer = new Uint8Array(header.length + pixels.length);
  buffer.set(header);
  buffer.set(pixels, header.length);
  return buffer.buffer;
}
const image = () => ({
  name: 'Test HDR.hdr',
  data:
    'data:application/octet-stream;base64,' +
    btoa(String.fromCharCode(...new Uint8Array(hdr()))),
});
describe('authored environment', () => {
  it('keeps legacy projects readable and persists all authored lighting including the HDR payload', () => {
    const p = createProject(8, 32);
    p.environment = {
      ...environmentPreset('golden'),
      mode: 'image',
      image: image(),
      rotation: 38,
      shadowResolution: 4096,
    };
    expect(parseProject(serializeProject(p))).toEqual(p);
    delete p.environment;
    expect(parseProject(serializeProject(p)).environment).toBeUndefined();
    expect(defaultEnvironmentSettings().mode).toBe('none');
  });
  it('validates lighting ranges, colors, enum values and self-contained image data', () => {
    for (const patch of [
      { sunIntensity: Infinity },
      { sunElevation: -1 },
      { rotation: 181 },
      { fogNear: 900, fogFar: 800 },
      { exposure: 0 },
      { backgroundIntensity: Infinity },
      { backgroundIntensity: -1 },
      { backgroundIntensity: 11 },
      { mode: 'moon' },
      { toneMapping: 'unknown' },
      { shadowResolution: 8192 },
      { sunColor: 'red' },
      { shadows: 1 },
      { mode: 'image' },
      { image: { name: 'remote', data: 'https://example.com/env.hdr' } },
    ])
      expect(() =>
        parseEnvironmentSettings({
          ...environmentPreset('daylight'),
          ...patch,
        }),
      ).toThrow();
    for (const name of [
      'daylight',
      'golden',
      'overcast',
      'studio',
      'natural',
    ] as const)
      expect(parseEnvironmentSettings(environmentPreset(name))).toEqual(
        environmentPreset(name),
      );
  });
  it('decodes flat and RLE HDR radiance without clamping it to display white', async () => {
    expect(validateEnvironmentHDR(hdr())).toEqual({ width: 64, height: 32 });
    expect(validateEnvironmentHDR(hdr(true))).toEqual({
      width: 64,
      height: 32,
    });
    const flat = await prepareEnvironment({
      ...environmentPreset('daylight'),
      mode: 'image',
      image: image(),
    });
    const rle = await prepareEnvironment({
      ...environmentPreset('daylight'),
      mode: 'image',
      image: {
        name: 'RLE.hdr',
        data:
          'data:application/octet-stream;base64,' +
          btoa(String.fromCharCode(...new Uint8Array(hdr(true)))),
      },
    });
    expect((flat.texture as THREE.DataTexture).image.data).toEqual(
      (rle.texture as THREE.DataTexture).image.data,
    );
    expect(
      THREE.DataUtils.fromHalfFloat(
        (flat.texture as THREE.DataTexture).image.data![0],
      ),
    ).toBeGreaterThan(1);
    expect(flat.texture!.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    expect(flat.texture!.mapping).toBe(THREE.EquirectangularReflectionMapping);
    flat.dispose();
    rle.dispose();
  });
  it('rejects incomplete runs, truncated rows, huge dimensions and non-equirectangular maps before decoding', () => {
    for (const data of [
      hdr().slice(0, -1),
      hdr(true).slice(0, -1),
      hdr(true).slice(0, -12),
    ])
      expect(() => validateEnvironmentHDR(data)).toThrow(/HDR/);
    for (const dimensions of ['-Y 4096 +X 8192', '-Y 32 +X 32']) {
      const data = new TextEncoder().encode(
        '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' + dimensions + '\n',
      );
      expect(() => validateEnvironmentHDR(data.buffer)).toThrow(
        'equirectangular',
      );
    }
    const invalid = new Uint8Array(hdr(true));
    invalid[invalid.length - 2] = 0;
    expect(() => validateEnvironmentHDR(invalid.buffer)).toThrow('run');
  });
  it('applies display and environment settings without replacing textures for parameter-only edits', () => {
    const scene = new THREE.Scene(),
      p = createProject(8, 32);
    const background = new THREE.Color('#ff0000');
    scene.background = background;
    const renderer: Pick<
      THREE.WebGLRenderer,
      'toneMapping' | 'toneMappingExposure'
    > = { toneMapping: THREE.NoToneMapping, toneMappingExposure: 2 };
    const environment = new TerrainEnvironment(scene, renderer);
    const settings = {
      ...environmentPreset('studio'),
      rotation: 70,
      backgroundBlur: 0.4,
      environmentIntensity: 1.8,
    };
    environment.set(settings, p);
    const texture = scene.environment!;
    let disposed = 0;
    texture.addEventListener('dispose', () => disposed++);
    environment.set({ ...settings, exposure: 0.7 }, p);
    expect(scene.environment).toBe(texture);
    expect(scene.environmentIntensity).toBe(1.8);
    expect(scene.environmentRotation.y).toBeCloseTo((70 * Math.PI) / 180);
    expect(scene.fog).toBeNull();
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(renderer.toneMappingExposure).toBe(0.7);
    expect(scene.backgroundIntensity).toBe(1.8);
    environment.set(
      { ...settings, backgroundIntensity: 0.4, toneMapping: 'agx' },
      p,
    );
    expect(scene.backgroundIntensity).toBe(0.4);
    expect(scene.environmentIntensity).toBe(1.8);
    expect(scene.environment).toBe(texture);
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);
    environment.set(
      { ...settings, skyColor: '#ffffff', showBackground: true },
      p,
    );
    expect(disposed).toBe(1);
    expect(scene.environment).not.toBe(texture);
    expect(scene.background).toBe(scene.environment);
    environment.dispose();
    environment.dispose();
    expect(scene.children).toHaveLength(0);
    expect(scene.background).toBe(background);
    expect(scene.environment).toBeNull();
    expect(renderer.toneMappingExposure).toBe(2);
  });
  it('keeps sun direction and covers the edited terrain inside the shadow camera', () => {
    const p = createProject(16, 192);
    p.heights.fill(40);
    const scene = new THREE.Scene(),
      environment = new TerrainEnvironment(scene);
    environment.set(
      { ...environmentPreset('daylight'), sunAzimuth: 180, sunElevation: 35 },
      p,
    );
    // Change after the target has moved above zero: direction must not inherit the old target offset.
    environment.set(
      { ...environmentPreset('daylight'), sunAzimuth: 90, sunElevation: 20 },
      p,
    );
    const direction = environment.sun.position
      .clone()
      .sub(environment.sun.target.position)
      .normalize();
    expect(direction.x).toBeCloseTo(Math.cos(Math.PI / 9), 6);
    expect(direction.y).toBeCloseTo(Math.sin(Math.PI / 9), 6);
    expect(direction.z).toBeCloseTo(0, 6);
    p.heights[120] = 120;
    environment.fitShadow(p);
    expect(
      environment.sun.position
        .clone()
        .sub(environment.sun.target.position)
        .normalize()
        .distanceTo(direction),
    ).toBeLessThan(1e-10);
    environment.sun.shadow.updateMatrices(environment.sun);
    for (const x of [-96, 96])
      for (const z of [-96, 96])
        for (const y of [40, 120]) {
          const point = new THREE.Vector3(x, y, z).project(
            environment.sun.shadow.camera,
          );
          expect(
            Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)),
          ).toBeLessThanOrEqual(1);
        }
    environment.dispose();
  });
  it('keeps the last valid lighting after failed or superseded preparation and releases candidates', async () => {
    const p = createProject(8, 32),
      scene = new THREE.Scene(),
      environment = new TerrainEnvironment(scene);
    const results = await Promise.all([
      environment.load(environmentPreset('daylight'), p),
      environment.load(environmentPreset('golden'), p),
    ]);
    expect(results).toEqual([false, true]);
    expect(environment.sun.intensity).toBe(3);
    const current = scene.environment;
    await expect(
      environment.load(
        {
          ...environmentPreset('daylight'),
          mode: 'image',
          image: {
            name: 'bad.hdr',
            data: 'data:application/octet-stream;base64,YmFk',
          },
        },
        p,
      ),
    ).rejects.toThrow('HDR');
    expect(scene.environment).toBe(current);
    const prepared = await prepareEnvironment(environmentPreset('overcast'));
    let disposals = 0;
    prepared.texture!.addEventListener('dispose', () => disposals++);
    prepared.dispose();
    prepared.dispose();
    expect(disposals).toBe(1);
    expect(() => environment.apply(prepared, p)).toThrow('disposed');
    environment.dispose();
  });
});
