import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { bakeCanopyLight } from '../src/core/canopy-lighting';
import {
  environmentPreset,
  parseEnvironmentSettings,
} from '../src/core/environment';
import { serializeProject, parseProject } from '../src/core/serialization';
import { editFoliageModels } from '../src/core/foliage';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { getCanopyBinding } from '../src/render/canopy-binding';

it('bakes bounded, terrain-following canopy visibility and local material tint', () => {
  const p = createProject(8, 16);
  p.heights.fill(0);
  const input = {
    project: p,
    colors: p.materials.map(() => [0.1, 0.5, 0.2] as [number, number, number]),
    cells: 8,
    occluders: [] as {
      x: number;
      y: number;
      z: number;
      rx: number;
      ry: number;
      rz: number;
      rotation?: number;
    }[],
  };
  const open = bakeCanopyLight(input);
  expect(open.dimensions).toEqual([8, 8, 8]);
  for (let i = 3; i < open.pixels.length; i += 4)
    expect(open.pixels[i]).toBeCloseTo(1);
  input.occluders.push({
    x: 0,
    y: 4,
    z: 0,
    rx: 5,
    ry: 2,
    rz: 3,
    rotation: 0.7,
  });
  const covered = bakeCanopyLight(input);
  const index = (4 * 8 * 8 + 4) * 4;
  expect(covered.pixels[index + 3]).toBeLessThan(0.9);
  expect(covered.pixels[index + 1]).toBeGreaterThan(covered.pixels[index]);
  expect(covered.pixels[((4 * 8 + 7) * 8 + 4) * 4 + 3]).toBeCloseTo(1);
  p.heights.fill(50);
  input.occluders[0].y += 50;
  const raised = bakeCanopyLight(input);
  expect(raised.pixels).toEqual(covered.pixels);
  expect(raised.groundRange).toEqual([50, 1]);
  expect(raised.ground.every((value) => value === 0)).toBe(true);
  input.occluders[0].rotation = NaN;
  expect(() => bakeCanopyLight(input)).toThrow('bounds');
  expect(() => bakeCanopyLight({ ...input, cells: 100 })).toThrow('limits');
});

it('validates and persists optional canopy lighting without changing legacy projects', () => {
  const p = createProject(8, 16);
  p.environment = {
    ...environmentPreset('natural'),
    canopyLighting: { enabled: true, strength: 0.65, bounce: 0.35 },
  };
  expect(parseProject(serializeProject(p)).environment).toEqual(p.environment);
  for (const canopyLighting of [
    { enabled: true, strength: NaN, bounce: 0 },
    { enabled: true, strength: 1, bounce: 2 },
    { enabled: 'yes', strength: 1, bounce: 1 },
  ])
    expect(() =>
      parseEnvironmentSettings({ ...p.environment, canopyLighting }),
    ).toThrow();
  expect(environmentPreset('natural').canopyLighting).toBeUndefined();
});

it('stages canopy resources, reuses gain-only edits and keeps GPU data out of export metadata', async () => {
  const p = createProject(8, 16);
  p.heights.fill(0);
  p.foliage = [];
  p.environment = {
    ...environmentPreset('natural'),
    canopyLighting: { enabled: true, strength: 0.65, bounce: 0.35 },
  };
  const model = editFoliageModels(p.brushes[0], [])[0];
  model.model = 'pine';
  p.foliage.push({
    id: p.nextId++,
    brushId: p.brushes[0].id,
    modelId: model.id,
    x: 0,
    z: 0,
    scale: 2,
    rotation: 0,
  });
  const terrain = new TerrainScene(p);
  await terrain.load(p, false);
  const manager = terrain.canopyLighting;
  expect(manager.field).toBeDefined();
  const field = manager.field!;
  const disposed = vi.spyOn(field, 'dispose');
  const candidate = await manager.prepare(p, {
    ...p.environment,
    canopyLighting: { enabled: true, strength: 1, bounce: 0.8 },
  });
  expect(candidate.value).toBe(field);
  candidate.dispose();
  expect(disposed).not.toHaveBeenCalled();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    manager.prepare(p, p.environment, undefined, cancelled.signal),
  ).rejects.toThrow();
  expect(manager.field).toBe(field);
  const mesh = terrain.terrain.children[0] as THREE.Mesh;
  expect(getCanopyBinding(mesh)?.field).toBe(field);
  const adopted = new THREE.Mesh();
  terrain.props.add(adopted);
  expect(getCanopyBinding(adopted)?.field).toBe(field);
  adopted.removeFromParent();
  expect(getCanopyBinding(adopted)).toBeUndefined();
  expect(JSON.stringify(mesh.clone().userData)).not.toContain('canopy');
  const exported = terrain.foliage.forExport();
  expect(JSON.stringify(exported.userData)).not.toContain('canopy');
  exported.traverse((object) =>
    expect(getCanopyBinding(object)).toBeUndefined(),
  );
  terrain.position.set(10, 0, 20);
  manager.updateTransform();
  expect(field.worldToLocal.elements[12]).toBe(-10);
  const off = await manager.prepare(p, {
    ...p.environment,
    canopyLighting: { enabled: false, strength: 1, bounce: 1 },
  });
  manager.apply(off);
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(getCanopyBinding(mesh)?.field).toBeUndefined();
  terrain.dispose();
  terrain.dispose();
});

it('retains the current field through previews, rollback and failed rebakes, then retries the committed scene', async () => {
  vi.useFakeTimers();
  const p = createProject(8, 16);
  p.heights.fill(0);
  p.foliage = [{ id: 1, brushId: 'pine', x: 0, z: 0, scale: 2, rotation: 0 }];
  p.nextId = 2;
  p.environment = {
    ...environmentPreset('natural'),
    canopyLighting: { enabled: true, strength: 0.65, bounce: 0.35 },
  };
  const terrain = new TerrainScene(p);
  try {
    await terrain.load(p, false);
    const manager = terrain.canopyLighting,
      field = manager.field!;
    expect(field).toBeDefined();
    const prepare = vi.spyOn(manager, 'prepare'),
      dispose = vi.spyOn(field, 'dispose');
    const candidate = structuredClone(p);
    candidate.heights.fill(2);
    const preview = terrain.beginEdit(candidate);
    manager.invalidate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(prepare).not.toHaveBeenCalled();
    expect(manager.field).toBe(field);
    preview.rollback();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.field).toBe(field);
    expect(dispose).not.toHaveBeenCalled();
    prepare.mockRejectedValueOnce(new Error('Injected canopy failure'));
    const committed = terrain.beginEdit(candidate);
    committed.commit();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.field).toBe(field);
    expect(manager.error?.message).toContain('Injected');
    manager.invalidate();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.error).toBeUndefined();
    expect(manager.field).not.toBe(field);
    expect(dispose).toHaveBeenCalledTimes(1);
    terrain.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.field).toBeUndefined();
  } finally {
    terrain.dispose();
    vi.useRealTimers();
  }
});
