import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import {
  prepareTerrainData,
  terrainPreparationInput,
  terrainPreparationTransfers,
} from '../src/core/terrain-preparation';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { TerrainLod } from '../src/runtime/terrain-lod';
import { TerrainPreparer } from '../src/runtime/terrain-preparer';

class FakeWorker {
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: () => void;
  stopped = false;
  message?: {
    id: number;
    project: ReturnType<typeof createProject>;
    lod: boolean;
  };
  postMessage(message: typeof this.message) {
    this.message = message;
  }
  terminate() {
    this.stopped = true;
  }
  complete() {
    const request = this.message!;
    this.onmessage?.({
      data: {
        id: request.id,
        data: prepareTerrainData(request.project, request.lod),
      },
    } as MessageEvent);
  }
}
describe('off-thread terrain preparation', () => {
  it('keeps snapshots small, transfers each owned buffer once, and leaves live arrays attached', () => {
    const p = createProject(32, 64);
    p.assets.large = { name: 'Private model', data: 'large-model-payload' };
    p.materials[0].textures.albedo = 'large-image-payload';
    const snapshot = terrainPreparationInput(p);
    expect(snapshot.assets).toBeUndefined();
    expect(snapshot.materials[0].textures).toEqual({});
    const result = prepareTerrainData(snapshot);
    const buffers = terrainPreparationTransfers(result);
    expect(new Set(buffers).size).toBe(buffers.length);
    structuredClone(result, { transfer: buffers });
    expect(p.heights.byteLength).toBe(33 * 33 * 4);
    expect(snapshot.heights.byteLength).toBe(p.heights.byteLength);
    expect(p.assets.large.data).toBe('large-model-payload');
  });

  it('matches existing geometry, normals, morphs and culling bounds exactly', () => {
    const p = createProject(64, 128);
    p.foliage = [];
    for (let i = 0; i < p.heights.length; i++)
      p.heights[i] = Math.sin(i * 0.7) * 4;
    p.holes[1] = 1;
    const reference = new TerrainScene(p),
      prepared = new TerrainScene(p, {
        preparedTerrain: prepareTerrainData(terrainPreparationInput(p)),
      });
    reference.rebuildTerrain();
    prepared.rebuildTerrain();
    reference.terrain.children.forEach((mesh, index) => {
      const a = (mesh as THREE.Mesh).geometry,
        b = (prepared.terrain.children[index] as THREE.Mesh).geometry;
      for (const key of ['position', 'normal', 'layerWeights'])
        expect(b.getAttribute(key).array).toEqual(a.getAttribute(key).array);
      expect(b.index!.array).toEqual(a.index!.array);
      expect(b.boundingBox).toEqual(a.boundingBox);
      expect(b.boundingSphere).toEqual(a.boundingSphere);
    });
    const a = new TerrainLod(reference),
      b = new TerrainLod(prepared);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
    for (const distance of [1000, 10, 300, 1500]) {
      camera.position.set(distance, 20, distance);
      for (let frame = 0; frame < 40; frame++) {
        a.update(camera, 1080, 1 / 30);
        b.update(camera, 1080, 1 / 30);
      }
      expect(b.stats).toEqual(a.stats);
      a.children.forEach((mesh, index) => {
        const ga = (mesh as THREE.Mesh).geometry,
          gb = (b.children[index] as THREE.Mesh).geometry;
        expect(gb.index!.array).toEqual(ga.index!.array);
        expect(gb.morphAttributes.position![0].array).toEqual(
          ga.morphAttributes.position![0].array,
        );
        expect(gb.boundingSphere).toEqual(ga.boundingSphere);
      });
    }
    a.dispose();
    b.dispose();
    reference.dispose();
    prepared.dispose();
  });

  it('cancels active work, rejects late replies, reuses successful workers and retries errors', async () => {
    const workers: FakeWorker[] = [];
    const pool = new TerrainPreparer(1, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const p = createProject(8, 16),
      first = new AbortController();
    const pending = pool.prepare(p, first.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    first.abort();
    await rejected;
    expect(workers[0].stopped).toBe(true);
    const retry = pool.prepare(p, new AbortController().signal);
    workers[0].complete(); // Retired worker must not settle the new request.
    workers[1].complete();
    await expect(retry).resolves.toMatchObject({ resolution: 8 });
    const failure = pool.prepare(p, new AbortController().signal);
    const failed = expect(failure).rejects.toThrow('Injected');
    workers[1].onerror?.({ message: 'Injected' } as ErrorEvent);
    await failed;
    const successful = pool.prepare(p, new AbortController().signal);
    workers[2].complete();
    await successful;
    const queued1 = pool.prepare(p, new AbortController().signal),
      queued2 = pool.prepare(p, new AbortController().signal);
    const rejection1 = expect(queued1).rejects.toMatchObject({
        name: 'AbortError',
      }),
      rejection2 = expect(queued2).rejects.toMatchObject({
        name: 'AbortError',
      });
    pool.dispose();
    await Promise.all([rejection1, rejection2]);
    expect(workers.every((worker) => worker.stopped)).toBe(true);
    await expect(pool.prepare(p, new AbortController().signal)).rejects.toThrow(
      'disposed',
    );
  });
});
