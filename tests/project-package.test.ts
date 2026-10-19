import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/terrain';
import { defaultEnvironmentSettings } from '../src/core/environment';
import {
  parseProject,
  serializeProject,
  validateProjectData,
} from '../src/core/serialization';
import {
  assertProjectCapacity,
  projectAssetBytes,
  unusedModelAssetIds,
  serializeProjectPackage,
  parseProjectPackage,
  ProjectPackageWriter,
  packageChecksum,
  MAX_PROJECT_ASSET_BYTES,
} from '../src/core/project-package';
import {
  parseProjectFile,
  readProjectFile,
  projectFromGLB,
  embedProjectPackage,
  PROJECT_EXTENSION,
} from '../src/core/glb-project';

const url = (bytes: number[], mime = 'model/gltf-binary') =>
  'data:' + mime + ';base64,' + btoa(String.fromCharCode(...bytes));
function richProject() {
  const p = createProject(16, 32);
  p.name = 'Terrain · 山';
  p.assets.marker = { name: 'marker.glb', data: url([1, 2, 3, 4, 5]) };
  p.assets.alias = { ...p.assets.marker };
  p.materials[0].textures.albedo = url([9, 8, 7, 6], 'image/png');
  p.materials[1].textures.normal = p.materials[0].textures.albedo;
  p.environment = {
    ...defaultEnvironmentSettings(),
    image: {
      name: 'sky.hdr',
      data: url([7, 8, 9], 'application/octet-stream'),
    },
  };
  p.sculpt = {
    alphaKind: 'custom',
    alpha: { width: 2, height: 2, values: new Float32Array([0, 0.25, 0.5, 1]) },
    rotation: 13,
    stampHeight: 2,
    stampBase: 0,
    stampMode: 'add',
    pressure: true,
  };
  p.holes[4] = 1;
  p.paint[40] = 0.7;
  return p;
}
function rewrite(input: ArrayBuffer, edit: (manifest: any) => void) {
  const header = new Uint8Array(input.slice(0, 32)),
    old = new DataView(input),
    oldLength = old.getUint32(12, true);
  const manifest = JSON.parse(
    new TextDecoder().decode(new Uint8Array(input, 32, oldLength)),
  );
  edit(manifest);
  const json = new TextEncoder().encode(JSON.stringify(manifest)),
    padded = Math.ceil(json.length / 4) * 4;
  const payload = new Uint8Array(input, 32 + Math.ceil(oldLength / 4) * 4);
  const out = new Uint8Array(32 + padded + payload.length);
  out.set(header);
  out.set(json, 32);
  out.set(payload, 32 + padded);
  const view = new DataView(out.buffer);
  view.setUint32(12, json.length, true);
  view.setUint32(20, packageChecksum(json), true);
  return out.buffer;
}
function glb(document: object, binary = new Uint8Array(4)) {
  const json = new TextEncoder().encode(JSON.stringify(document)),
    length = Math.ceil(json.length / 4) * 4;
  const out = new Uint8Array(28 + length + binary.length),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + length);
  out.set(json, 20);
  view.setUint32(20 + length, binary.length, true);
  view.setUint32(24 + length, 0x004e4942, true);
  out.set(binary, 28 + length);
  return out.buffer;
}

describe('portable project packages', () => {
  it('identifies content manifests and points to their editable document', async () => {
    for (const kind of [undefined, 'terrain-content-manifest']) {
      const text = JSON.stringify({
        kind,
        name: 'An external landscape',
        project: 'exports/My Landscape.terrain',
      });
      const message =
        'This file is a content manifest. Open "exports/My Landscape.terrain" instead.';
      expect(() => parseProjectFile(text)).toThrow(message);
      expect(() =>
        parseProjectFile(new TextEncoder().encode(text).buffer),
      ).toThrow(message);
      await expect(readProjectFile(new Blob([text]))).rejects.toThrow(message);
    }
    for (const project of [undefined, 42, 'a'.repeat(241) + '.terrain'])
      expect(() =>
        parseProject(
          JSON.stringify({ kind: 'terrain-content-manifest', project }),
        ),
      ).toThrow('Open the .terrain document in the content folder.');
  });
  it('distinguishes unrelated JSON from unsupported terrain document versions', () => {
    expect(() => parseProject('{"name":"Asset metadata"}')).toThrow(
      'This JSON file is not a Terrain Studio document.',
    );
    const project = createProject(8, 8);
    expect(() => validateProjectData({ ...project, version: 2 })).toThrow(
      'Unsupported terrain project version.',
    );
  });
  it('round-trips complete authoring state with exact buffers and deduplicated assets', async () => {
    const project = richProject(),
      original = structuredClone(project);
    const blob = serializeProjectPackage(project),
      bytes = await blob.arrayBuffer();
    expect(blob.type).toBe('application/x-terrain-project');
    expect(parseProjectPackage(bytes)).toEqual(project);
    expect(project).toEqual(original);
    const metadata = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(bytes, 32, new DataView(bytes).getUint32(12, true)),
      ),
    );
    expect(metadata.chunks.filter((c: any) => c.kind === 'asset')).toHaveLength(
      3,
    );
    expect(metadata.project.assets.marker.data).toEqual(
      metadata.project.assets.alias.data,
    );
    const restored = parseProjectPackage(bytes);
    restored.heights[0] = 7;
    restored.sculpt!.alpha!.values[0] = 1;
    expect(parseProjectPackage(bytes)).toEqual(project);
    expect(await readProjectFile(blob)).toEqual(project);
  });
  it('captures immutable saves and prunes removed assets across reused writers', async () => {
    const writer = new ProjectPackageWriter(),
      project = richProject();
    const expected = structuredClone(project),
      first = writer.encode(project);
    project.heights.fill(3);
    delete project.assets.marker;
    delete project.assets.alias;
    project.materials[0].textures = {};
    const second = writer.encode(project);
    expect(parseProjectPackage(await first.arrayBuffer())).toEqual(expected);
    expect(parseProjectPackage(await second.arrayBuffer())).toEqual(project);
    writer.clear();
    expect(
      parseProjectPackage(await writer.encode(project).arrayBuffer()),
    ).toEqual(project);
    expect(() => writer.encode({ ...project, resolution: 9999 })).toThrow(
      'dimensions',
    );
  });
  it('preserves legacy base64 spelling while rejecting forged asset tails', async () => {
    for (const data of ['AQI', 'AQIDBA', 'AQIDBAU', 'AQIDBAU=', 'AQIDBR==']) {
      const project = createProject(8, 8);
      project.assets.a = {
        name: 'a',
        data: 'data:model/gltf-binary;base64,' + data,
      };
      const bytes = await serializeProjectPackage(project).arrayBuffer();
      expect(parseProjectPackage(bytes).assets.a.data).toBe(
        project.assets.a.data,
      );
      const broken = rewrite(bytes, (m) => {
        m.chunks.find((c: any) => c.kind === 'asset').tail = 'AAAA';
      });
      expect(() => parseProjectPackage(broken)).toThrow();
    }
  });
  it('reads old JSON and version-1 GLBs and preserves presentation bytes in version 2', async () => {
    const project = richProject(),
      json = serializeProject(project),
      legacy = JSON.parse(json);
    expect(parseProjectFile(json)).toEqual(project);
    expect(parseProjectFile(new TextEncoder().encode(json).buffer)).toEqual(
      project,
    );
    const first = glb({
      asset: { version: '2.0' },
      nodes: [
        {
          extensions: { [PROJECT_EXTENSION]: { version: 1, project: legacy } },
        },
      ],
    });
    expect(projectFromGLB(first)).toEqual(project);
    const presentation = glb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: 8 }],
        bufferViews: [{ buffer: 0, byteLength: 8 }],
        nodes: [{ name: 'Presentation' }],
      },
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    const packed = embedProjectPackage(
      presentation,
      await serializeProjectPackage(project).arrayBuffer(),
    );
    const view = new DataView(packed),
      metadata = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(packed, 20, view.getUint32(12, true)),
        ),
      );
    expect(metadata.extensions[PROJECT_EXTENSION].version).toBe(2);
    expect(metadata.nodes[0].name).toBe('Presentation');
    expect(new Uint8Array(packed, 28 + view.getUint32(12, true), 8)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    expect(projectFromGLB(packed)).toEqual(project);
    expect(parseProjectFile(packed)).toEqual(project);
    const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]);
    const meshGLB = glb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: positions.byteLength }],
        bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            count: 3,
            type: 'VEC3',
            min: [-1, 0, 0],
            max: [1, 1, 0],
          },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      new Uint8Array(positions.buffer),
    );
    const standard = await new GLTFLoader().parseAsync(
      embedProjectPackage(
        meshGLB,
        await serializeProjectPackage(project).arrayBuffer(),
      ),
      '',
    );
    const mesh = standard.scene.children[0] as Mesh;
    expect(mesh.geometry.getAttribute('position').array).toEqual(positions);
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material])
      material.dispose();
  });
  it('rejects truncation, corruption, unsupported versions, bad references and forged buffer sizes', async () => {
    const original = await serializeProjectPackage(richProject()).arrayBuffer();
    for (const offset of [0, 8, 12, 16, 20, 24, 32, original.byteLength - 4]) {
      const bad = original.slice(0);
      new Uint8Array(bad)[offset] ^= 1;
      expect(() => parseProjectPackage(bad)).toThrow();
    }
    expect(() => parseProjectPackage(original.slice(0, -4))).toThrow();
    for (const edit of [
      (m: any) => (m.project.heights.chunk = 999),
      (m: any) => (m.project.heights = m.project.holes),
      (m: any) => (m.chunks[0].bytes = -4),
      (m: any) => (m.chunks[0].bytes = 2 ** 32),
      (m: any) => (m.project.resolution = 512),
      (m: any) => (m.project.version = 2),
      (m: any) => m.chunks.push(m.chunks[0]),
    ])
      expect(() => parseProjectPackage(rewrite(original, edit))).toThrow();
    const bad = rewrite(original, (m) => {
      m.project.assets.marker.data = { chunk: 0 };
    });
    expect(() => parseProjectPackage(bad)).toThrow('reference kind');
  });
  it('enforces the same asset budget before writing and counts shared payloads once', () => {
    const project = richProject();
    expect(projectAssetBytes(project)).toBe(12);
    expect(assertProjectCapacity(project, 12)).toBe(12);
    expect(() => assertProjectCapacity(project, 11)).toThrow('budget');
    expect(() =>
      assertProjectCapacity(project, MAX_PROJECT_ASSET_BYTES + 1),
    ).toThrow('Invalid');
    const environment = structuredClone(project.environment);
    validateProjectData(project, false);
    expect(project.environment).toEqual(environment);
  });
  it('keeps prop, brush and LOD assets when selecting unused models', () => {
    const project = richProject();
    project.props = [
      {
        id: project.nextId++,
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
    expect(unusedModelAssetIds(project)).toEqual(['alias']);
    project.brushes[0].model = 'alias';
    expect(unusedModelAssetIds(project)).toEqual([]);
    project.assets.lod = { ...project.assets.marker };
    expect(unusedModelAssetIds(project)).toEqual(['lod']);
    project.brushes[0].models = [
      {
        id: 'variant',
        model: 'pine',
        weight: 1,
        minScale: 1,
        maxScale: 1,
        minRotation: 0,
        maxRotation: 0,
        alignToNormal: false,
        wind: 1,
        crush: 1,
        color: '#ffffff',
        lods: [{ model: 'lod', distance: 10, density: 1 }],
      },
    ];
    expect(unusedModelAssetIds(project)).toEqual([]);
  });
  it('reopens a package whose embedded assets exceed the legacy JSON limit', async () => {
    const project = createProject(8, 8);
    for (let i = 0; i < 3; i++)
      project.assets['large' + i] = {
        name: 'Synthetic payload ' + i,
        data:
          'data:model/gltf-binary;base64,' +
          btoa(String.fromCharCode(i + 1).repeat(25_000_000)),
      };
    expect(() => serializeProject(project)).toThrow('legacy JSON limit');
    const oldSave = JSON.stringify({
      ...project,
      heights: Array.from(project.heights),
      holes: Array.from(project.holes),
      paint: Array.from(project.paint),
    });
    expect(oldSave.length).toBeGreaterThan(100_000_000);
    const migrated = parseProject(oldSave);
    expect(migrated.assets.large2.data === project.assets.large2.data).toBe(
      true,
    );
    const blob = serializeProjectPackage(project);
    expect(blob.size).toBeGreaterThan(75_000_000);
    expect(blob.size).toBeLessThan(75_100_000);
    const restored = parseProjectPackage(await blob.arrayBuffer());
    expect(Object.keys(restored.assets)).toHaveLength(3);
    for (const id of Object.keys(project.assets))
      expect(restored.assets[id].data === project.assets[id].data).toBe(true);
    expect(restored.heights).toEqual(project.heights);
  }, 30000);
});
