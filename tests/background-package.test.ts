import { describe, expect, it, vi } from 'vitest';
import { BackgroundProjectWriter } from '../src/core/background-package';
import {
  PackageEncodingSession,
  capturePackageProject,
} from '../src/core/package-transfer';
import type {
  PackageRequest,
  PackageResponse,
} from '../src/core/package-transfer';
import { createProject } from '../src/core/terrain';
import { defaultSculptSettings } from '../src/core/sculpt';
import { defaultEnvironmentSettings } from '../src/core/environment';
import {
  parseProjectPackage,
  ProjectPackageWriter,
} from '../src/core/project-package';

class WorkerHost {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  sent: PackageRequest[] = [];
  terminated = false;
  failPost = false;
  session = new PackageEncodingSession();
  postMessage(message: PackageRequest, transfer: Transferable[]) {
    if (this.failPost) throw new Error('Injected post failure');
    this.sent.push(structuredClone(message, { transfer }));
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: PackageResponse) {
    this.onmessage?.call(
      this as unknown as Worker,
      new MessageEvent('message', { data }),
    );
  }
  complete(index = this.sent.length - 1) {
    const request = this.sent[index];
    try {
      this.reply({
        id: request.id,
        type: 'result',
        blob: this.session.encode(request),
        encodeMs: 3,
      });
    } catch (error) {
      this.reply({ id: request.id, type: 'error', message: String(error) });
    }
  }
  crash() {
    let prevented = false;
    this.onerror?.call(
      this as unknown as Worker,
      {
        message: 'Injected worker crash',
        preventDefault() {
          prevented = true;
        },
      } as ErrorEvent,
    );
    expect(prevented).toBe(true);
  }
}
function fixture() {
  const project = createProject(16, 32);
  project.assets.marker = {
    name: 'Marker',
    data: 'data:model/gltf-binary;base64,AQIDBA==',
  };
  project.assets.alias = { ...project.assets.marker };
  project.materials[0].textures.albedo = 'data:image/png;base64,AQIDBA==';
  project.environment = {
    ...defaultEnvironmentSettings(),
    image: {
      name: 'Sky',
      data: 'data:application/octet-stream;base64,AQIDBA==',
    },
  };
  project.sculpt = {
    ...defaultSculptSettings(),
    alphaKind: 'custom',
    alpha: {
      width: 2,
      height: 2,
      values: new Float32Array([0, 1 / 65535, 0.5, 1]),
    },
  };
  return project;
}
function harness(options: { maxPending?: number; timeoutMs?: number } = {}) {
  const workers: WorkerHost[] = [];
  const writer = new BackgroundProjectWriter({
    ...options,
    workerFactory: () => {
      const worker = new WorkerHost();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  return { writer, workers };
}
const read = async (blob: Blob) =>
  parseProjectPackage(await blob.arrayBuffer());

describe('background package snapshots', () => {
  it('captures exact editable state, preserves subarray boundaries, and never detaches live buffers', async () => {
    const project = fixture(),
      { writer, workers } = harness();
    const backing = new Float32Array(project.heights.length + 8);
    backing.set(project.heights, 4);
    project.heights = backing.subarray(4, backing.length - 4);
    const before = structuredClone(project);
    const saving = writer.encode(project);
    expect(workers[0].sent[0].project.heights.buffer.byteLength).toBe(
      project.heights.byteLength,
    );
    project.name = 'Later edit';
    project.heights[0] = 8;
    project.holes[0] = 1;
    project.sculpt!.alpha!.values[0] = 1;
    project.assets.marker.data = 'data:model/gltf-binary;base64,BQYHCA==';
    project.materials[0].name = 'Later surface';
    expect(project.paint.byteLength).toBeGreaterThan(0);
    expect(backing.byteLength).toBeGreaterThan(project.heights.byteLength);
    workers[0].complete();
    expect(await read(await saving)).toEqual(before);
    writer.dispose();
  });

  it('packs canonical foliage precisely and preserves extension/order fallbacks without coercing invalid values', async () => {
    const project = fixture(),
      { writer, workers } = harness();
    project.foliage = [
      {
        id: 1,
        brushId: 'pine',
        x: 1 / 3,
        z: -0,
        scale: 1.23456789,
        rotation: Math.PI,
      },
      {
        id: 2,
        brushId: 'grass',
        modelId: 'primary',
        x: -2,
        z: 3,
        scale: 0.7,
        rotation: 0.123456789,
      },
    ];
    project.nextId = 3;
    let saving = writer.encode(project);
    expect(workers[0].sent[0].foliage?.values).toBeInstanceOf(Float64Array);
    project.foliage[0].x = 9;
    workers[0].complete();
    const packed = await read(await saving);
    expect(packed.foliage[0].x).toBe(1 / 3);
    expect(packed.foliage[0].scale).toBe(1.23456789);
    expect(packed.foliage[0].rotation).toBe(Math.PI);
    expect(packed.foliage[1].modelId).toBe('primary');
    (project.foliage[0] as unknown as Record<string, unknown>).artistNote = {
      group: 'foreground',
    };
    saving = writer.encode(project);
    expect(workers[0].sent[1].foliage).toBeUndefined();
    workers[0].complete();
    expect((await read(await saving)).foliage).toEqual(
      (await read(new ProjectPackageWriter().encode(project))).foliage,
    );
    delete (project.foliage[0] as unknown as Record<string, unknown>)
      .artistNote;
    (project.foliage[0] as unknown as Record<string, unknown>).scale = '1';
    saving = writer.encode(project);
    const rejected = expect(saving).rejects.toThrow();
    expect(workers[0].sent[2].foliage).toBeUndefined();
    workers[0].complete();
    await rejected;
    writer.dispose();
  });

  it('coalesces pending autosaves while preserving exact file saves and queue order', async () => {
    const project = fixture(),
      { writer, workers } = harness({ maxPending: 2 });
    project.name = 'active';
    const active = writer.encodeLatest(project);
    project.name = 'old autosave';
    const old = writer.encodeLatest(project);
    project.name = 'file snapshot';
    const exact = writer.encode(project);
    project.name = 'newest autosave';
    const latest = writer.encodeLatest(project);
    expect(writer.stats.pending).toBe(2);
    workers[0].complete();
    expect((await read(await active)).name).toBe('active');
    expect(workers[0].sent[1].project.name).toBe('file snapshot');
    workers[0].complete();
    expect((await read(await exact)).name).toBe('file snapshot');
    expect(workers[0].sent[2].project.name).toBe('newest autosave');
    workers[0].complete();
    const blob = await latest;
    expect(await old).toBe(blob);
    expect((await read(blob)).name).toBe('newest autosave');
    expect(writer.stats).toMatchObject({ active: false, pending: 0 });
    writer.dispose();
  });

  it('sends each unchanged payload once, shares aliases, and prunes removed assets', async () => {
    const project = fixture(),
      { writer, workers } = harness();
    let saving = writer.encode(project);
    expect(workers[0].sent[0].added).toHaveLength(3);
    workers[0].complete();
    await saving;
    project.heights[2] += 1;
    saving = writer.encode(project);
    expect(workers[0].sent[1].added).toHaveLength(0);
    workers[0].complete();
    expect(await read(await saving)).toEqual(project);
    delete project.assets.marker;
    delete project.assets.alias;
    project.materials[0].textures = {};
    saving = writer.encode(project);
    workers[0].complete();
    await saving;
    expect(writer.stats.cachedAssets).toBe(1);
    project.assets.returned = {
      name: 'Returned',
      data: 'data:model/gltf-binary;base64,AQIDBA==',
    };
    saving = writer.encode(project);
    expect(workers[0].sent[3].added).toHaveLength(1);
    workers[0].complete();
    expect(await read(await saving)).toEqual(project);
    writer.dispose();
    expect(writer.stats.cachedCharacters).toBe(0);
  });

  it('restarts after worker failure and resends every payload needed by queued work', async () => {
    const project = fixture(),
      { writer, workers } = harness();
    const failed = writer.encode(project);
    const rejection = expect(failed).rejects.toThrow('worker crash');
    project.name = 'Recovered snapshot';
    const recovered = writer.encodeLatest(project);
    workers[0].crash();
    await rejection;
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].sent[0].added).toHaveLength(3);
    workers[0].complete(); // Old responses cannot settle the new worker's job.
    expect(writer.stats.active).toBe(true);
    workers[1].complete();
    expect((await read(await recovered)).name).toBe('Recovered snapshot');
    writer.dispose();
  });

  it('rejects invalid document encoding without replacing a valid pending snapshot', async () => {
    const project = fixture(),
      { writer, workers } = harness();
    project.heights[0] = NaN;
    const bad = writer.encode(project);
    const rejected = expect(bad).rejects.toThrow('buffer');
    project.heights[0] = 0;
    const good = writer.encodeLatest(project);
    workers[0].complete();
    await rejected;
    workers[1].complete();
    expect(await read(await good)).toEqual(project);
    writer.dispose();
  });

  it('bounds queued snapshots, rejects disposed work, and settles every waiter', async () => {
    const project = fixture(),
      { writer } = harness({ maxPending: 1 });
    const active = writer.encode(project),
      pending = writer.encodeLatest(project);
    const first = expect(active).rejects.toThrow('disposed');
    const second = expect(pending).rejects.toThrow('disposed');
    await expect(writer.encode(project)).rejects.toThrow('queue is full');
    const replacing = writer.encodeLatest(project);
    const third = expect(replacing).rejects.toThrow('disposed');
    expect(writer.stats.pending).toBe(1);
    writer.dispose();
    await Promise.all([first, second, third]);
    await expect(writer.encode(project)).rejects.toThrow('disposed');
    expect(writer.stats).toMatchObject({
      active: false,
      pending: 0,
      cachedAssets: 0,
    });
  });

  it('times out a stalled worker, then completes queued work on a fresh host', async () => {
    vi.useFakeTimers();
    const { writer, workers } = harness({ timeoutMs: 10 });
    try {
      const project = fixture(),
        stalled = writer.encode(project);
      const rejected = expect(stalled).rejects.toThrow('timed out');
      const queued = writer.encodeLatest(project);
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(workers[0].terminated).toBe(true);
      workers[1].complete();
      expect(await read(await queued)).toEqual(project);
    } finally {
      writer.dispose();
      vi.useRealTimers();
    }
  });

  it('recovers from startup/post failures and does not discard pending work on capture failure', async () => {
    let failing = true;
    const workers: WorkerHost[] = [];
    const writer = new BackgroundProjectWriter({
      workerFactory: () => {
        if (failing) throw new Error('Worker unavailable');
        const worker = new WorkerHost();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const project = fixture();
    await expect(writer.encode(project)).rejects.toThrow('unavailable');
    failing = false;
    const first = writer.encodeLatest(project);
    const queued = writer.encodeLatest(project);
    const broken = { ...project, assets: { bad: { name: 'bad', data: 4 } } };
    await expect(writer.encodeLatest(broken as never)).rejects.toThrow('asset');
    expect(writer.stats.pending).toBe(1);
    workers[0].complete();
    await first;
    workers[0].complete();
    await queued;
    workers[0].failPost = true;
    await expect(writer.encode(project)).rejects.toThrow('post failure');
    const next = writer.encode(project);
    workers[1].complete();
    expect(await read(await next)).toEqual(project);
    writer.dispose();
  });

  it('rejects malformed worker responses and recovers the next request', async () => {
    const { writer, workers } = harness();
    const project = fixture();
    const invalid = writer.encode(project);
    const rejected = expect(invalid).rejects.toThrow(
      'Invalid background package response',
    );
    workers[0].reply(null as never);
    await rejected;
    const next = writer.encode(project);
    workers[1].complete();
    expect(await read(await next)).toEqual(project);
    writer.dispose();
  });

  it('rejects missing worker dictionary references without losing the last valid cache', () => {
    const capture = capturePackageProject(fixture()),
      session = new PackageEncodingSession();
    const request = {
      id: 1,
      project: capture.project,
      dictionary: [1, 2, 3],
      added: capture.payloads.map(
        (value, index) => [index + 1, value] as [number, string],
      ),
    };
    expect(session.encode(request)).toBeInstanceOf(Blob);
    expect(() =>
      session.encode({ ...request, dictionary: [99], added: [] }),
    ).toThrow('Missing');
    expect(() =>
      session.encode({
        ...request,
        added: [],
        project: {
          ...request.project,
          assets: { bad: { name: 'bad', data: 99 } },
        },
      }),
    ).toThrow('reference');
    expect(session.encode({ ...request, added: [] })).toBeInstanceOf(Blob);
  });
});
