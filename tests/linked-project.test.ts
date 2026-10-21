import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/terrain';
import { readProjectFile } from '../src/core/glb-project';
import {
  ProjectPackageWriter,
  parseProjectPackage,
  projectPackageSources,
  packageChecksum,
} from '../src/core/project-package';
import {
  parseModelSource,
  projectRelativePath,
} from '../src/core/model-source';
import {
  prepareLinkedModel,
  readModelDocument,
  writeModelDocument,
} from '../src/core/model-document';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from '../src/core/foliage-preset';
import {
  capturePackageProject,
  PackageEncodingSession,
} from '../src/core/package-transfer';
import type { PackageRequest } from '../src/core/package-transfer';

it('retains linked model scale and pivot across revisions and rejects external dependencies', () => {
  const source = {
    path: 'prepared/Tree.glb',
    scale: 0.01,
    offset: [2, -4, 6] as [number, number, number],
  };
  for (const name of ['Initial art', 'Revised art']) {
    const buffer = writeModelDocument({
      json: {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name }],
      },
      chunks: [],
    });
    const url = prepareLinkedModel(buffer, source);
    const bytes = Uint8Array.from(atob(url.split(',')[1]), (char) =>
      char.charCodeAt(0),
    );
    const document = readModelDocument(bytes.buffer);
    expect(document.json.nodes?.[1]).toMatchObject({
      scale: [0.01, 0.01, 0.01],
      translation: [0.02, -0.04, 0.06],
      children: [0],
    });
    expect(document.json.nodes?.[0].name).toBe(name);
  }
  const external = writeModelDocument({
    json: {
      asset: { version: '2.0' },
      images: [{ uri: 'https://example.com/texture.png' }],
    },
    chunks: [],
  });
  expect(() =>
    prepareLinkedModel(external, {
      path: source.path,
      scale: 1,
      offset: [0, 0, 0],
      prepared: true,
    }),
  ).toThrow('embed their buffers and textures');
});

const data = (text: string) => 'data:model/gltf-binary;base64,' + btoa(text);
function fixture() {
  const project = createProject(8, 32);
  project.folderId = '00000000-0000-4000-8000-000000000001';
  project.assets.tree = {
    name: 'Tree',
    data: data('old-art'.repeat(10000)),
    source: {
      path: 'prepared/foliage/tree.glb',
      scale: 0.01,
      offset: [1, 2, 3],
    },
  };
  project.assets.rock = { name: 'Rock', data: data('embedded-rock') };
  project.brushes[0].model = 'tree';
  project.props.push({
    id: 1,
    model: 'tree',
    x: 1,
    z: 2,
    scale: 2,
    rotation: 0.4,
    yOffset: 0,
    cutHole: false,
    holeRadius: 1,
  });
  project.foliage.push({
    id: 2,
    brushId: project.brushes[0].id,
    x: 3,
    z: 4,
    scale: 1,
    rotation: 2,
  });
  project.nextId = 3;
  return project;
}
function rewriteMetadata(buffer: ArrayBuffer, edit: (raw: any) => void) {
  const view = new DataView(buffer),
    size = view.getUint32(12, true);
  const raw = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 32, size)),
  );
  edit(raw);
  const json = new TextEncoder().encode(JSON.stringify(raw));
  const oldStart = 32 + Math.ceil(size / 4) * 4;
  const start = 32 + Math.ceil(json.length / 4) * 4;
  const out = new Uint8Array(start + buffer.byteLength - oldStart);
  out.set(new Uint8Array(buffer, 0, 32));
  out.set(json, 32);
  out.set(new Uint8Array(buffer, oldStart), start);
  const header = new DataView(out.buffer);
  header.setUint32(12, json.length, true);
  header.setUint32(20, packageChecksum(json), true);
  return out.buffer;
}

describe('folder project packages', () => {
  it('resolves a shared source recipe once while preserving separate model IDs', async () => {
    const project = fixture();
    project.assets.alias = { ...project.assets.tree };
    const blob = new ProjectPackageWriter().encode(project, 'linked');
    let calls = 0;
    const restored = await readProjectFile(blob, async () => {
      calls++;
      return data('current shared art');
    });
    expect(calls).toBe(1);
    expect(restored.assets.tree.data).toBe(restored.assets.alias.data);
    expect(Object.keys(restored.assets)).toEqual(Object.keys(project.assets));
  });
  it('stores relative links without model payloads and resolves current art with stable authoring references', async () => {
    const project = fixture(),
      before = structuredClone(project);
    const writer = new ProjectPackageWriter();
    const linked = writer.encode(project, 'linked');
    const portable = writer.encode(project);
    expect(portable.size - linked.size).toBeGreaterThan(60000);
    const buffer = await linked.arrayBuffer();
    expect(new DataView(buffer).getUint32(8, true)).toBe(2);
    expect(projectPackageSources(buffer)).toEqual({
      tree: project.assets.tree.source,
    });
    expect(() => parseProjectPackage(buffer)).toThrow('Open project folder');
    await expect(readProjectFile(linked)).rejects.toThrow(
      'Open project folder',
    );
    const latest = data('revised-art');
    const seen: string[] = [];
    const restored = await readProjectFile(linked, async (source) => {
      seen.push(source.path);
      return latest;
    });
    expect(seen).toEqual(['prepared/foliage/tree.glb']);
    expect(restored).toEqual({
      ...project,
      assets: {
        ...project.assets,
        tree: { ...project.assets.tree, data: latest },
      },
    });
    expect(project).toEqual(before);
    const unpacked = parseProjectPackage(await portable.arrayBuffer());
    expect(unpacked.folderId).toBeUndefined();
    expect(unpacked.assets.tree.source).toBeUndefined();
    expect(unpacked.assets.tree.data).toBe(project.assets.tree.data);
  });
  it('keeps a self-contained recovery snapshot and link metadata through the background worker protocol', async () => {
    const project = fixture();
    const capture = capturePackageProject(project);
    const session = new PackageEncodingSession();
    const request: PackageRequest = {
      id: 1,
      project: capture.project,
      foliage: capture.foliage,
      dictionary: capture.payloads.map((_, i) => i),
      added: capture.payloads.map((url, i) => [i, url]),
      mode: 'recovery',
    };
    const restored = parseProjectPackage(
      await session.encode(request).arrayBuffer(),
    );
    expect(restored).toEqual(project);
    const linked = session.encode({
      ...request,
      id: 2,
      added: [],
      mode: 'linked',
    });
    expect(
      await readProjectFile(linked, async () => project.assets.tree.data),
    ).toEqual(project);
    const portable = session.encode({
      ...request,
      id: 3,
      added: [],
      mode: 'portable',
    });
    const independent = parseProjectPackage(await portable.arrayBuffer());
    expect(independent.assets.tree.data).toBe(project.assets.tree.data);
    expect(independent.assets.tree.source).toBeUndefined();
  });
  it('rejects corrupt link metadata before invoking a file resolver and recovers after a failed source read', async () => {
    const project = fixture(),
      writer = new ProjectPackageWriter();
    const good = writer.encode(project, 'linked');
    const bytes = await good.arrayBuffer();
    for (const path of [
      '../escape.glb',
      'C:/private.glb',
      '/absolute.glb',
      'assets/../../escape.glb',
      'https://example.com/a.glb',
      'assets\\tree.glb',
    ]) {
      const broken = rewriteMetadata(bytes, (raw) => {
        raw.project.assets.tree.source.path = path;
        raw.project.assets.tree.data.external = path;
      });
      let called = false;
      await expect(
        readProjectFile(new Blob([broken]), async () => {
          called = true;
          return data('unexpected');
        }),
      ).rejects.toThrow();
      expect(called).toBe(false);
    }
    await expect(
      readProjectFile(good, async () => {
        throw new Error('Missing source');
      }),
    ).rejects.toThrow('Missing source');
    expect(
      await readProjectFile(good, async () => project.assets.tree.data),
    ).toEqual(project);
    await expect(
      readProjectFile(good, async () => 'not a GLB data URL'),
    ).rejects.toThrow();
  });
  it('keeps shared brushes portable instead of carrying another project’s source links', () => {
    const project = fixture();
    const text = serializeFoliageBrush(project, project.brushes[0].id);
    expect(JSON.parse(text).assets.tree.source).toBeUndefined();
    const restored = importFoliageBrush(createProject(8, 32), text);
    expect(Object.values(restored.assets).every((asset) => !asset.source)).toBe(
      true,
    );
  });
  it('validates source paths and retained import recipes', () => {
    expect(
      parseModelSource({
        path: 'prepared/Tree.glb',
        scale: 1,
        offset: [0, 0, 0],
      }).path,
    ).toBe('prepared/Tree.glb');
    for (const path of [
      '',
      '.',
      '..',
      'x//a.glb',
      'x/./a.glb',
      '../a.glb',
      'x\u0000/a.glb',
    ])
      expect(() => projectRelativePath(path)).toThrow();
    for (const edit of [
      { scale: 0 },
      { offset: [0, NaN, 0] },
      { path: 'a.gltf' },
      { prepared: 'yes' },
    ])
      expect(() =>
        parseModelSource({
          path: 'a.glb',
          scale: 1,
          offset: [0, 0, 0],
          ...edit,
        }),
      ).toThrow();
  });
});
