import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { exrFixture, exrAttributes } from './fixtures/environment-exr';
import { environmentPreset } from '../src/core/environment';
import { createProject } from '../src/core/terrain';
import {
  TerrainEnvironment,
  prepareEnvironment,
  validateEnvironmentEXR,
} from '../src/runtime/environment';
const settings = (bytes: Uint8Array) => ({
  ...environmentPreset('daylight'),
  mode: 'image' as const,
  image: {
    name: 'test.exr',
    data:
      'data:application/octet-stream;base64,' +
      btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join('')),
  },
});
const buffer = (bytes: Uint8Array) => bytes.slice().buffer;

describe('OpenEXR environment imports', () => {
  for (const compression of [0, 2, 3] as const)
    for (const type of [THREE.HalfFloatType, THREE.FloatType] as const)
      it(`decodes ${type} samples with compression ${compression}, preserving radiance and orientation`, async () => {
        const bytes = await exrFixture(compression, type);
        expect(validateEnvironmentEXR(buffer(bytes))).toEqual({
          width: 64,
          height: 32,
        });
        const prepared = await prepareEnvironment(settings(bytes)),
          texture = prepared.texture!;
        expect(texture.flipY).toBe(false);
        expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
        expect(THREE.DataUtils.fromHalfFloat(texture.image.data[0])).toBe(2);
        expect(
          THREE.DataUtils.fromHalfFloat(texture.image.data[31 * 64 * 4]),
        ).toBe(3.9375);
        prepared.dispose();
      });
  it('uses the scanline offset table even when chunks are physically out of order', async () => {
    const bytes = await exrFixture(0),
      { table } = exrAttributes(bytes),
      view = new DataView(buffer(bytes));
    const first = Number(view.getBigUint64(table, true)),
      second = Number(view.getBigUint64(table + 8, true));
    const length = second - first,
      reordered = bytes.slice();
    reordered.set(bytes.subarray(second, second + length), first);
    reordered.set(bytes.subarray(first, first + length), second);
    const output = new DataView(reordered.buffer);
    output.setBigUint64(table, BigInt(second), true);
    output.setBigUint64(table + 8, BigInt(first), true);
    const original = await prepareEnvironment(settings(bytes)),
      normalized = await prepareEnvironment(settings(reordered));
    expect(normalized.texture!.image.data).toEqual(
      original.texture!.image.data,
    );
    original.dispose();
    normalized.dispose();
  });
  it('rejects invalid headers, tiled/multipart data, incomplete blocks, non-square pixels and layered channels before decoding', async () => {
    const bytes = await exrFixture(0),
      { attributes, table } = exrAttributes(bytes);
    for (const mutate of [
      (v: DataView) => v.setUint32(4, 0x202, true),
      (v: DataView) => v.setUint32(4, 0x1002, true),
      (v: DataView) =>
        v.setUint32(attributes.get('dataWindow')! + 8, 8191, true),
      (v: DataView) =>
        v.setFloat32(attributes.get('pixelAspectRatio')!, NaN, true),
      (v: DataView) => v.setUint8(attributes.get('lineOrder')!, 1),
      (v: DataView) => v.setUint8(attributes.get('channels')!, 90),
      (v: DataView) => v.setBigUint64(table, BigInt(bytes.length), true),
    ]) {
      const changed = buffer(bytes);
      mutate(new DataView(changed));
      expect(() => validateEnvironmentEXR(changed)).toThrow('EXR');
    }
    expect(() => validateEnvironmentEXR(buffer(bytes.subarray(0, -1)))).toThrow(
      'EXR',
    );
  });
  it('retains live lighting after corrupt EXR data, then successfully retries', async () => {
    const bytes = await exrFixture(0),
      { table } = exrAttributes(bytes);
    const broken = bytes.slice(),
      view = new DataView(broken.buffer);
    // First block, first HALF sample: positive infinity.
    view.setUint16(Number(view.getBigUint64(table, true)) + 8, 0x7c00, true);
    const scene = new THREE.Scene(),
      environment = new TerrainEnvironment(scene),
      project = createProject(8, 32);
    environment.set(environmentPreset('golden'), project);
    const previous = scene.environment;
    await expect(environment.load(settings(broken), project)).rejects.toThrow(
      'non-finite',
    );
    expect(scene.environment).toBe(previous);
    expect(await environment.load(settings(bytes), project)).toBe(true);
    expect(scene.environment).not.toBe(previous);
    environment.dispose();
  });
  it('rejects non-finite FLOAT samples before half-float conversion and bounds finite radiance to the render texture range', async () => {
    const bytes = await exrFixture(0, THREE.FloatType),
      { table } = exrAttributes(bytes);
    const view = new DataView(bytes.buffer),
      sample = Number(view.getBigUint64(table, true)) + 8 + 64 * 3 * 4;
    for (const value of [Infinity, -Infinity, NaN]) {
      view.setFloat32(sample, value, true);
      await expect(prepareEnvironment(settings(bytes))).rejects.toThrow(
        'non-finite',
      );
    }
    view.setFloat32(sample, 100000, true);
    const prepared = await prepareEnvironment(settings(bytes));
    expect(
      THREE.DataUtils.fromHalfFloat(prepared.texture!.image.data[31 * 64 * 4]),
    ).toBe(65504);
    prepared.dispose();
  });
});
