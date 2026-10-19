import { describe, it, expect } from 'vitest';
import {
  detectMap,
  mapAssignmentError,
  materialName,
  materialChannels,
  conversionSummary,
} from '../src/editor/material-import';
import type { MapRole, MaterialPreset } from '../src/editor/material-import';
import {
  decodeHeightmapPNG,
  encodeHeightmapPNG,
  encodeRgbaPNG,
} from '../src/core/heightmap-png';
import { packOrmMap } from '../src/core/orm';
import type { OrmSources } from '../src/core/orm';
import {
  bundleModel,
  writeModelDocument,
  readModelDocument,
  transformModel,
  foliageImportDraft,
} from '../src/editor/foliage-import';
import { createProject } from '../src/core/terrain';
import { parseProject, serializeProject } from '../src/core/serialization';

describe('material set recognition', () => {
  it('recognizes provider conventions and flags conflicts without silently overwriting maps', () => {
    expect(detectMap('Rock037_2K-JPG_NormalDX.jpg')).toEqual({
      role: 'normal',
      directX: true,
      gloss: false,
      channel: 'red',
    });
    expect(detectMap('forest_ground_nor_gl_2k.png').role).toBe('normal');
    expect(detectMap('stone_Roughness.png').role).toBe('roughness');
    expect(detectMap('stone_Smoothness.png').gloss).toBe(true);
    expect(detectMap('stone_ARM_1k.png').role).toBe('orm');
    expect(detectMap('stone_preview.png').role).toBe('ignore');
    expect(detectMap('stone_RMA.png').role).toBe('rma');
    expect(mapAssignmentError(['normal', 'normal'])).toContain('Choose one');
    expect(mapAssignmentError(['orm', 'roughness'])).toContain(
      'packed ORM or separate',
    );
    expect(
      mapAssignmentError([
        'albedo',
        'normal',
        'roughness',
        'occlusion',
        'ignore',
      ]),
    ).toBe('');
    expect(materialName('forest_ground_diff_2k.jpg')).toBe('forest ground');
  });

  it('uses engine normal defaults while honoring explicit GL/DX suffixes', () => {
    for (const preset of [
      'auto',
      'blender',
      'unity',
      'unity-hdrp',
      'opengl',
    ] as MaterialPreset[])
      expect(detectMap('Stone_Normal.png', preset).directX).toBe(false);
    for (const preset of ['unreal', 'directx'] as MaterialPreset[]) {
      expect(detectMap('Stone_Normal.png', preset).directX).toBe(true);
      expect(detectMap('Stone_Normal_ogl.png', preset).directX).toBe(false);
    }
    expect(detectMap('Stone_NormalDX.png', 'blender').directX).toBe(true);
    expect(detectMap('T_Stone_N.png', 'unreal').role).toBe('normal');
    expect(detectMap('T_Stone_BC.png', 'unreal').role).toBe('albedo');
  });

  it('identifies Unity workflows without treating separate roughness as smoothness or unknown masks as ORM', () => {
    expect(detectMap('Stone_Metallic.png', 'unity')).toMatchObject({
      role: 'metallic-smoothness',
      gloss: true,
    });
    expect(detectMap('Stone_MetallicGlossMap.png')).toMatchObject({
      role: 'metallic-smoothness',
      gloss: true,
    });
    expect(detectMap('Stone_Occlusion.png', 'unity').channel).toBe('green');
    expect(detectMap('Stone_Roughness.png', 'unity')).toMatchObject({
      role: 'roughness',
      gloss: false,
    });
    expect(detectMap('Stone_MaskMap.png', 'unity-hdrp')).toMatchObject({
      role: 'hdrp-mask',
      gloss: true,
    });
    expect(detectMap('Stone_Mask.png', 'unreal').role).toBe('ignore');
    expect(detectMap('Stone_DetailMask.png', 'unity-hdrp').role).toBe('ignore');
    expect(detectMap('Stone_Specular.png', 'unity').role).toBe('ignore');
    expect(
      detectMap('Stone_OcclusionRoughnessMetallic.png', 'unreal').role,
    ).toBe('orm');
  });

  it('rejects overlapping packed outputs but allows Unity metallic/smoothness plus a separate occlusion map', () => {
    expect(mapAssignmentError(['metallic-smoothness', 'occlusion'])).toBe('');
    expect(mapAssignmentError(['metallic-smoothness', 'roughness'])).toContain(
      'supply roughness',
    );
    expect(mapAssignmentError(['hdrp-mask', 'occlusion'])).toContain(
      'supply occlusion',
    );
    expect(mapAssignmentError(['orm', 'rma'])).toContain('Multiple maps');
    expect(
      conversionSummary({ role: 'hdrp-mask', channel: 'red' }, true),
    ).toContain('1 − ALPHA → roughness');
  });

  it('converts packed layouts numerically, including RGB under zero alpha', async () => {
    const png = await encodeRgbaPNG(
      2,
      1,
      new Uint8Array([51, 102, 153, 204, 17, 33, 77, 0]),
    );
    const cases: [MapRole, boolean, number[]][] = [
      ['orm', false, [51, 102, 153, 255, 17, 33, 77, 255]],
      ['rma', false, [153, 51, 102, 255, 77, 17, 33, 255]],
      ['mra', false, [153, 102, 51, 255, 77, 33, 17, 255]],
      ['metallic-smoothness', true, [255, 51, 51, 255, 255, 255, 17, 255]],
      ['hdrp-mask', true, [102, 51, 51, 255, 33, 255, 17, 255]],
    ];
    for (const [role, gloss, expected] of cases) {
      const maps: OrmSources = { roughnessIsGloss: gloss };
      for (const [slot, channel] of Object.entries(
        materialChannels({ role, channel: 'red' }),
      ))
        maps[slot as 'occlusion' | 'roughness' | 'metalness'] =
          await decodeHeightmapPNG(png, false, channel);
      expect(Array.from(packOrmMap(maps, 2, 1))).toEqual(expected);
    }
  });

  it('requires real alpha for Unity packed smoothness while keeping legacy alpha defaults', async () => {
    const png = await encodeHeightmapPNG({
      width: 1,
      height: 1,
      values: new Float32Array([0.5]),
    });
    await expect(decodeHeightmapPNG(png, false, 'alpha', true)).rejects.toThrow(
      'no alpha channel',
    );
    expect((await decodeHeightmapPNG(png, false, 'alpha')).values[0]).toBe(1);
    const rgba = await encodeRgbaPNG(1, 1, new Uint8Array([200, 100, 50, 0]));
    expect(
      (await decodeHeightmapPNG(rgba, false, 'alpha', true)).values[0],
    ).toBe(0);
  });
});

const modelJSON = () => ({
  asset: { version: '2.0', copyright: 'Original Artist / CC0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  buffers: [{ uri: 'meshes/plant.bin', byteLength: 4 }],
  images: [{ uri: 'textures/leaf.png' }],
});
describe('foliage import preparation', () => {
  it('embeds chosen dependencies, preserves credit and wraps transforms without editing sources', async () => {
    const source = new File([JSON.stringify(modelJSON())], 'plant.gltf');
    const files = [
      source,
      new File([new Uint8Array(4)], 'plant.bin'),
      new File([new Uint8Array([1, 2])], 'leaf.png'),
    ];
    const document = await bundleModel(source, files);
    expect(document.json.buffers![0].uri).toContain(
      'data:application/octet-stream;base64,',
    );
    expect(document.json.images![0].uri).toContain('data:image/png;base64,');
    const data = transformModel(document, 0.01, [-3, -5, 2]);
    const bytes = Uint8Array.from(atob(data.split(',')[1]), (c) =>
      c.charCodeAt(0),
    );
    const restored = readModelDocument(bytes.buffer).json;
    expect(restored.asset.copyright).toBe('Original Artist / CC0');
    expect(restored.nodes![1]).toMatchObject({
      scale: [0.01, 0.01, 0.01],
      translation: [-0.03, -0.05, 0.02],
      children: [0],
    });
    expect(document.json.nodes).toHaveLength(1);
    expect(JSON.parse(await source.text())).toEqual(modelJSON());
  });
  it('rejects missing or ambiguous dependencies, remote references, malformed containers and cancellation', async () => {
    const source = new File([JSON.stringify(modelJSON())], 'plant.gltf');
    await expect(bundleModel(source, [source])).rejects.toThrow(
      'Missing dependency',
    );
    const bin = new File([new Uint8Array(4)], 'plant.bin');
    await expect(bundleModel(source, [source, bin, bin])).rejects.toThrow(
      'Ambiguous dependency',
    );
    const json = modelJSON();
    json.buffers[0].uri = 'https://example.invalid/plant.bin';
    await expect(
      bundleModel(new File([JSON.stringify(json)], 'plant.gltf'), []),
    ).rejects.toThrow('External URL');
    const controller = new AbortController();
    controller.abort();
    await expect(bundleModel(source, [], controller.signal)).rejects.toThrow();
    expect(() => readModelDocument(new ArrayBuffer(24))).toThrow('Invalid GLB');
    const valid = writeModelDocument({
      json: { asset: { version: '2.0' } },
      chunks: [],
    });
    new DataView(valid).setUint32(12, 9999, true);
    expect(() => readModelDocument(valid)).toThrow('chunk length');
  });
  it('stages new brushes, mixtures and explicit replacements without changing the document', () => {
    const project = createProject(32, 64),
      original = serializeProject(project);
    const data = 'data:model/gltf-binary;base64,AAAA';
    const options = {
      mode: 'new' as const,
      name: 'My ferns',
      profile: 'ground' as const,
      materials: ['grass'],
      targetBrush: 0,
      targetModel: 0,
    };
    const plants = [
      { name: 'Fern A', data, width: 1 },
      { name: 'Fern B', data, width: 2 },
    ];
    const created = foliageImportDraft(project, plants, options);
    expect(created.project.brushes[created.brushIndex]).toMatchObject({
      name: 'My ferns',
      spacing: 1.2,
      color: '#ffffff',
    });
    expect(
      parseProject(serializeProject(created.project)).brushes.at(-1)?.models,
    ).toHaveLength(2);
    expect(
      created.project.brushes[created.brushIndex].models!.every(
        (model) => model.interaction?.enabled,
      ),
    ).toBe(true);
    for (const profile of ['tree', 'rigid'] as const) {
      const imported = foliageImportDraft(project, plants, {
        ...options,
        profile,
      });
      expect(
        imported.project.brushes[imported.brushIndex].models!.every(
          (model) => model.interaction?.enabled === false,
        ),
      ).toBe(true);
    }
    const added = foliageImportDraft(project, plants, {
      ...options,
      mode: 'add',
    });
    expect(added.project.brushes[0].models).toHaveLength(3);
    expect(() =>
      foliageImportDraft(project, plants, { ...options, mode: 'replace' }),
    ).toThrow('one model');
    const replaced = foliageImportDraft(project, plants.slice(0, 1), {
      ...options,
      mode: 'replace',
    });
    expect(replaced.project.brushes[0].models![0].lods).toEqual([]);
    expect(() =>
      foliageImportDraft(project, plants, { ...options, materials: [] }),
    ).toThrow('at least one');
    expect(serializeProject(project)).toBe(original);
  });
});
