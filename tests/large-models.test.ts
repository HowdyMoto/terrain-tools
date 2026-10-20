import { describe, it, expect, vi } from 'vitest';
import {
  MAX_MODEL_BYTES,
  checkModelFileSize,
  checkModelDataURL,
} from '../src/core/model-limits';
import { createProject } from '../src/core/terrain';
import { validateProjectData } from '../src/core/serialization';
import {
  parseProjectPackage,
  serializeProjectPackage,
} from '../src/core/project-package';
import {
  bundleModel,
  writeModelDocument,
  transformModel,
  readModelDocument,
} from '../src/editor/foliage-import';

describe('large embedded GLB admission and persistence', () => {
  it('checks byte boundaries before reading a file, without allocating an oversized payload', async () => {
    expect(() => checkModelFileSize(MAX_MODEL_BYTES)).not.toThrow();
    for (const n of [-1, NaN, Infinity, MAX_MODEL_BYTES + 1])
      expect(() => checkModelFileSize(n)).toThrow();
    const file = new File([], 'too-large.glb');
    Object.defineProperty(file, 'size', { value: MAX_MODEL_BYTES + 1 });
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(bundleModel(file, [file])).rejects.toThrow('320 MiB');
    expect(read).not.toHaveBeenCalled();
  });

  it('retains model MIME validation and rejects malformed base64', () => {
    for (const mime of ['model/gltf-binary', 'application/octet-stream'])
      expect(() => checkModelDataURL(`data:${mime};base64,AAAA`)).not.toThrow();
    for (const value of [
      null,
      'https://example.com/a.glb',
      'data:image/png;base64,AAAA',
      'data:model/gltf-binary;base64,A',
      'data:model/gltf-binary;base64,AA!A',
    ])
      expect(() => checkModelDataURL(value)).toThrow();
  });

  it('imports, transforms and round-trips a model beyond every former 30–32 MB gate', async () => {
    // An unused binary payload keeps GPU geometry tiny while exercising the
    // complete container and persistence paths. This is not a fidelity fixture.
    const binary = new Uint8Array(34 * 1024 ** 2);
    binary[0] = 19;
    binary[binary.length - 1] = 217;
    const source = writeModelDocument({
      json: {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{}],
        buffers: [{ byteLength: binary.length }],
      },
      chunks: [{ type: 0x004e4942, bytes: binary }],
    });
    const file = new File([source], 'large.glb', { type: 'model/gltf-binary' });
    const document = await bundleModel(file, [file]);
    const data = transformModel(document, 0.01, [1, 2, 3]);
    const project = createProject(8, 16);
    project.assets.large = { name: file.name, data };
    expect(() => validateProjectData(project, false)).not.toThrow();
    const saved = serializeProjectPackage(project);
    const restored = parseProjectPackage(await saved.arrayBuffer());
    expect(restored.assets.large.data === data).toBe(true);
    const bytes = Buffer.from(
      restored.assets.large.data.split(',')[1],
      'base64',
    );
    const decoded = readModelDocument(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    expect(decoded.json.nodes!.at(-1)).toMatchObject({
      scale: [0.01, 0.01, 0.01],
      translation: [0.01, 0.02, 0.03],
    });
    expect(decoded.chunks[0].bytes[0]).toBe(19);
    expect(decoded.chunks[0].bytes.at(-1)).toBe(217);
    expect(project.assets.large.data === data).toBe(true);
  }, 30000);
});
