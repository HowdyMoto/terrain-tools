import { describe, expect, it } from 'vitest';
import {
  createProject,
  materialWeights,
  serializeProject,
  parseProject,
  serializeProjectPackage,
  parseProjectPackage,
  defaultSculptSettings,
  serializeMaterialPreset,
  parseMaterialPreset,
  applyMaterialPreset,
  MAX_MATERIAL_PRESET_BYTES,
} from '../src/index';
const embedded = 'data:image/png;base64,iVBORw0KGgo='; // Schema fixture; image decoding belongs to the host.
const makeSurface = () => ({
  ...createProject(8, 16).materials[1],
  name: 'Granite "warm" <face>',
  color: '#abcdef',
  roughness: 0.72,
  metalness: 0.13,
  normalConvention: 'directx' as const,
  normalStrength: 1.8,
  minHeight: 100,
  maxHeight: 200,
  minSlope: 20,
  maxSlope: 80,
  feather: 3,
  tileSize: 4.5,
  reduceTiling: true,
  blendHeight: 0.65,
  textures: {
    albedo: embedded,
    normal: embedded,
    orm: embedded,
    height: embedded,
  },
});
function serializeSurface(
  material: ReturnType<typeof createProject>['materials'][number],
) {
  const project = createProject(8, 16);
  const index = project.materials.findIndex(
    (layer) => layer.id === material.id,
  );
  project.materials[index] = material;
  return serializeMaterialPreset(project, material.id);
}
describe('portable surface presets', () => {
  it('keeps maps and shading with independent ownership and excludes unrelated data', () => {
    const source = makeSurface(),
      before = structuredClone(source);
    const text = serializeSurface({
      ...source,
      assets: { secret: 'model' },
      heights: [42],
    } as typeof source);
    const raw = JSON.parse(text),
      parsed = parseMaterialPreset(text);
    expect(raw.kind).toBe('terrain-material-preset');
    expect(raw.version).toBe(1);
    expect(Object.keys(raw)).toEqual(['kind', 'version', 'material']);
    expect(raw.material.id).toBeUndefined();
    expect(raw.material.assets).toBeUndefined();
    expect(raw.material.heights).toBeUndefined();
    const { id: _id, ...expected } = source;
    expect(parsed.material).toEqual({ ...expected, proceduralVariant: 1 });
    parsed.material.textures.normal = 'changed';
    expect(source).toEqual(before);
    expect(parseMaterialPreset(text).material.textures.normal).toBe(embedded);
  });
  it('preserves target identity, foliage restrictions and coverage unless placement rules are selected', () => {
    const project = createProject(8, 16);
    project.heights.fill(0);
    const before = structuredClone(project),
      initialWeights = materialWeights(project, 0, 0);
    const preset = parseMaterialPreset(serializeSurface(makeSurface()));
    project.materials[0] = applyMaterialPreset(project.materials[0], preset);
    expect(materialWeights(project, 0, 0)).toEqual(initialWeights);
    expect(project.materials[0].id).toBe(before.materials[0].id);
    expect(project.brushes).toEqual(before.brushes);
    expect(project.paint).toEqual(before.paint);
    expect(project.materials.slice(1)).toEqual(before.materials.slice(1));
    project.materials[0] = applyMaterialPreset(project.materials[0], preset, {
      applyPlacementRules: true,
    });
    expect(materialWeights(project, 0, 0)[0]).toBe(0);
    project.paint[(4 * 9 + 4) * 4] = 1;
    expect(materialWeights(project, 0, 0)).toEqual([1, 0, 0, 0]);
    project.materials[0].textures.albedo = 'different';
    expect(preset.material.textures.albedo).toBe(embedded);
  });
  it('replaces complete shading state and preserves optional legacy defaults through project formats', async () => {
    const project = createProject(8, 16);
    project.sculpt = defaultSculptSettings();
    project.materials[0] = applyMaterialPreset(
      project.materials[0],
      parseMaterialPreset(serializeSurface(makeSurface())),
      { applyPlacementRules: true },
    );
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(
      parseProjectPackage(await serializeProjectPackage(project).arrayBuffer()),
    ).toEqual(project);
    const legacy = createProject(8, 16).materials[2];
    project.materials[0] = applyMaterialPreset(
      project.materials[0],
      parseMaterialPreset(serializeSurface(legacy)),
    );
    expect(project.materials[0].textures).toEqual({});
    expect(project.materials[0].normalConvention).toBeUndefined();
    expect(project.materials[0].normalStrength).toBeUndefined();
    expect(project.materials[0].reduceTiling).toBeUndefined();
    expect(project.materials[0].proceduralVariant).toBe(2);
    const preset = parseMaterialPreset(
      serializeMaterialPreset(project, project.materials[0].id),
    );
    expect(preset.material.proceduralVariant).toBe(2);
  });
  it('rejects malformed, unsupported, oversized and unsafe inputs without changing the destination', () => {
    const target = createProject(8, 16).materials[0],
      before = structuredClone(target);
    const raw = JSON.parse(serializeSurface(makeSurface()));
    for (const replacement of [
      { ...raw, version: 2 },
      { ...raw, kind: 'wrong' },
      { ...raw, material: { ...raw.material, reduceTiling: 'true' } },
      { ...raw, material: { ...raw.material, reduceTiling: 1 } },
      { ...raw, material: null },
      { ...raw, material: { ...raw.material, maxHeight: 0 } },
      { ...raw, material: { ...raw.material, normalConvention: 'unknown' } },
      { ...raw, material: { ...raw.material, roughness: 2 } },
      {
        ...raw,
        material: {
          ...raw.material,
          textures: { albedo: 'https://example.com/image.png' },
        },
      },
      {
        ...raw,
        material: {
          ...raw.material,
          textures: { albedo: embedded, unknown: embedded },
        },
      },
    ])
      expect(() => parseMaterialPreset(JSON.stringify(replacement))).toThrow();
    expect(() => parseMaterialPreset('{')).toThrow();
    expect(() =>
      serializeMaterialPreset(createProject(8, 16), 'missing'),
    ).toThrow('Unknown');
    for (const variant of [-1, 4, 1.5, NaN])
      expect(() =>
        serializeSurface({ ...makeSurface(), proceduralVariant: variant as 0 }),
      ).toThrow('variant');
    expect(() =>
      parseMaterialPreset(' '.repeat(MAX_MATERIAL_PRESET_BYTES + 1)),
    ).toThrow('128 MiB');
    const preset = parseMaterialPreset(JSON.stringify(raw));
    expect(() =>
      applyMaterialPreset(target, preset, {
        applyPlacementRules: 'true' as never,
      }),
    ).toThrow('placement');
    preset.material.tileSize = NaN;
    expect(() => applyMaterialPreset(target, preset)).toThrow('texture scale');
    expect(target).toEqual(before);
  });
});
