import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ModelLibrary } from '../src/render/models';
import { ModelResources, decodeModel } from '../src/render/model-loader';
import type { DecodedModel } from '../src/render/model-loader';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { createProject } from '../src/core/terrain';
import { History } from '../src/core/history';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function assetProject(values: Record<string, string>) {
  return {
    assets: Object.fromEntries(
      Object.entries(values).map(([id, data]) => [id, { name: id, data }]),
    ),
  };
}
function decoded() {
  const geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshStandardMaterial();
  return {
    parts: [{ geometry, material, matrix: new THREE.Matrix4() }],
    dispose: vi.fn(() => {
      geometry.dispose();
      material.dispose();
    }),
  };
}
function triangleData(height = 4) {
  const positions = new Float32Array([-2, 0, 0, 2, 0, 0, 0, height, 0]);
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-2, 0, 0],
        max: [2, height, 0],
      },
    ],
  });
  const text = new TextEncoder().encode(
    json.padEnd(Math.ceil(json.length / 4) * 4, ' '),
  );
  const bytes = new Uint8Array(28 + text.length + positions.byteLength),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(text, 20);
  view.setUint32(20 + text.length, positions.byteLength, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  bytes.set(new Uint8Array(positions.buffer), 28 + text.length);
  return 'data:model/gltf-binary;base64,' + btoa(String.fromCharCode(...bytes));
}

describe('staged model ownership', () => {
  it('keeps the old library when a later asset fails and releases earlier candidates', async () => {
    const old = decoded(),
      replacement = decoded();
    const library = new ModelLibrary(async (data) => {
      if (data === 'bad') throw new Error('bad asset');
      return data === 'old' ? old : replacement;
    });
    await library.loadAssets(assetProject({ marker: 'old' }));
    await expect(
      library.loadAssets(assetProject({ marker: 'new', broken: 'bad' })),
    ).rejects.toThrow('bad asset');
    expect(library.get('marker')).toBe(old.parts);
    expect(old.dispose).not.toHaveBeenCalled();
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
    library.dispose();
    expect(old.dispose).toHaveBeenCalledTimes(1);
  });
  it('deduplicates payload aliases and releases removed assets exactly once', async () => {
    const a = decoded(),
      b = decoded();
    const decode = vi.fn(async (data: string) => (data === 'a' ? a : b));
    const library = new ModelLibrary(decode);
    await library.loadAssets(assetProject({ one: 'a', two: 'a' }));
    expect(decode).toHaveBeenCalledTimes(1);
    expect(library.get('one')).toBe(library.get('two'));
    await library.loadAssets(assetProject({ two: 'a' }));
    expect(a.dispose).not.toHaveBeenCalled();
    await library.loadAssets(assetProject({ two: 'b' }));
    expect(a.dispose).toHaveBeenCalledTimes(1);
    library.dispose();
    library.dispose();
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });
  it('retains borrowed assets while a competing commit removes them', async () => {
    const a = decoded(),
      b = decoded(),
      pending = deferred<DecodedModel>();
    const library = new ModelLibrary(async (data) =>
      data === 'a' ? a : pending.promise,
    );
    await library.loadAssets(assetProject({ one: 'a' }));
    const preparing = library.prepareAssets(
      assetProject({ one: 'a', two: 'b' }),
    );
    await library.loadAssets(assetProject({}));
    expect(a.dispose).not.toHaveBeenCalled();
    pending.resolve(b);
    const staged = await preparing;
    library.apply(staged);
    staged.dispose();
    expect(library.get('one')).toBe(a.parts);
    expect(a.dispose).not.toHaveBeenCalled();
    library.dispose();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });
  it('discards late completion after cancellation without replacing the current model', async () => {
    const a = decoded(),
      late = decoded(),
      pending = deferred<DecodedModel>();
    const library = new ModelLibrary(async (data) =>
      data === 'a' ? a : pending.promise,
    );
    await library.loadAssets(assetProject({ one: 'a' }));
    const controller = new AbortController();
    const loading = library.loadAssets(
      assetProject({ one: 'late' }),
      controller.signal,
    );
    controller.abort();
    pending.resolve(late);
    expect(await loading).toBe(false);
    expect(library.get('one')).toBe(a.parts);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    library.dispose();
  });
  it('keeps the newest request when an older decoder ignores cancellation', async () => {
    const stale = decoded(),
      fresh = decoded(),
      pending = deferred<DecodedModel>();
    const library = new ModelLibrary(async (data) =>
      data === 'old' ? pending.promise : fresh,
    );
    const old = library.loadAssets(assetProject({ one: 'old' }));
    expect(await library.loadAssets(assetProject({ one: 'fresh' }))).toBe(true);
    pending.resolve(stale);
    expect(await old).toBe(false);
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(library.get('one')).toBe(fresh.parts);
    library.dispose();
  });
  it('does not resurrect a disposed library when decoding finishes', async () => {
    const late = decoded(),
      pending = deferred<DecodedModel>();
    const library = new ModelLibrary(async () => pending.promise);
    const loading = library.loadAssets(assetProject({ one: 'late' }));
    library.dispose();
    pending.resolve(late);
    expect(await loading).toBe(false);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(() => library.get('one')).toThrow('disposed');
  });
  it('rejects foreign and consumed preparations and frees abandoned candidates', async () => {
    const model = decoded(),
      library = new ModelLibrary(async () => model),
      other = new ModelLibrary();
    const staged = await library.prepareAssets(assetProject({ one: 'x' }));
    expect(() => other.apply(staged)).toThrow('owner');
    staged.dispose();
    staged.dispose();
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(() => library.apply(staged)).toThrow('unavailable');
    library.dispose();
    other.dispose();
  });
});

describe('decoded resource cleanup', () => {
  it('releases shared textures, bitmaps, materials and geometry once, including late arrivals', () => {
    const resources = new ModelResources(),
      bitmap = { close: vi.fn() };
    const texture = new THREE.Texture(bitmap as unknown as ImageBitmap),
      material = new THREE.MeshStandardMaterial({
        map: texture,
        normalMap: texture,
      }),
      geometry = new THREE.BoxGeometry();
    const releases = [texture, material, geometry].map((value) => {
      const spy = vi.fn();
      value.addEventListener('dispose', spy);
      return spy;
    });
    const group = new THREE.Group();
    group.add(
      new THREE.Mesh(geometry, material),
      new THREE.Mesh(geometry, material),
    );
    resources.collect(group);
    resources.collect([texture, material, geometry]);
    resources.dispose();
    resources.dispose();
    releases.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    const lateBitmap = { close: vi.fn() },
      lateTexture = new THREE.Texture(lateBitmap as unknown as ImageBitmap),
      lateRelease = vi.fn();
    lateTexture.addEventListener('dispose', lateRelease);
    resources.collect(lateTexture);
    resources.collect(lateTexture);
    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(lateBitmap.close).toHaveBeenCalledTimes(1);
  });
  it('decodes a real embedded GLB and releases its original mesh resources', async () => {
    const model = await decodeModel(triangleData());
    expect(model.parts).toHaveLength(1);
    expect(model.parts[0].geometry.getAttribute('position').getY(2)).toBe(4);
    const release = vi.fn();
    model.parts[0].geometry.addEventListener('dispose', release);
    model.dispose();
    model.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodeModel(triangleData(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('scene and history preparation', () => {
  it('keeps scene, models and undo target when surface preparation fails after new models decode', async () => {
    const p = createProject(16, 32);
    p.assets = assetProject({ marker: triangleData(4) }).assets;
    p.props = [
      {
        id: 1,
        model: 'marker',
        x: 0,
        z: 0,
        yOffset: 0,
        scale: 1,
        rotation: 0,
        cutHole: false,
        holeRadius: 2,
      },
    ];
    p.brushes[0].model = 'marker';
    p.foliage = [
      { id: 2, brushId: p.brushes[0].id, x: 3, z: 3, scale: 1, rotation: 0 },
    ];
    const scene = new TerrainScene(p);
    await scene.load(p, false);
    const oldParts = scene.library.get('marker'),
      oldMesh = scene.terrain.children[0];
    const history = new History();
    history.checkpoint(p);
    const candidate = structuredClone(p);
    candidate.assets.marker.data = triangleData(8);
    const prepare = vi
      .spyOn(scene.terrainMaterial, 'prepare')
      .mockRejectedValue(new Error('bad surface'));
    await expect(scene.load(candidate)).rejects.toThrow('bad surface');
    expect(scene.project).toBe(p);
    expect(scene.terrain.children[0]).toBe(oldMesh);
    expect(scene.library.get('marker')).toBe(oldParts);
    expect(history.undoTarget).toEqual(p);
    expect(history.canRedo).toBe(false);
    prepare.mockRestore();
    const staged = await scene.prepareLoad(candidate, false);
    expect(scene.project).toBe(p);
    expect(scene.library.get('marker')).toBe(oldParts);
    expect(
      (staged.value.props.children[0].children[0] as THREE.Mesh).geometry
        .getAttribute('position')
        .getY(2),
    ).toBe(8);
    expect(
      (staged.value.foliage.value.children[0] as THREE.InstancedMesh).geometry
        .boundingBox!.max.y,
    ).toBe(8);
    scene.applyPrepared(staged);
    staged.dispose();
    expect(scene.project).toBe(candidate);
    expect(() => scene.applyPrepared(staged)).toThrow('unavailable');
    expect(
      scene.library.get('marker')[0].geometry.getAttribute('position').getY(2),
    ).toBe(8);
    expect(history.undo(p)).toEqual(p);
    expect(history.redoTarget).toEqual(p);
    scene.dispose();
  });
  it('releases a prepared scene abandoned after disposal without reattaching geometry', async () => {
    const p = createProject(16, 32);
    p.assets = assetProject({ marker: triangleData() }).assets;
    const scene = new TerrainScene(p),
      staged = await scene.prepareLoad(p, false);
    const geometry =
        staged.value.models.value.get('marker')!.value.decoded.parts[0]
          .geometry,
      release = vi.fn();
    geometry.addEventListener('dispose', release);
    scene.dispose();
    expect(() => scene.applyPrepared(staged)).toThrow('disposed');
    staged.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(scene.children).toHaveLength(0);
  });
});
