import { describe, expect, it } from 'vitest';
import {
  createProject,
  generateTerrain,
  applyBrush,
  defaultSculptSettings,
  defaultSculptBrushSettings,
  SCULPT_BRUSH_TOOLS,
  builtInAlpha,
  serializeSculptPreset,
  parseSculptPreset,
  MAX_SCULPT_PRESET_BYTES,
  serializeProject,
  parseProject,
  serializeProjectPackage,
  parseProjectPackage,
  History,
} from '../src/index';
import type { SculptSettings, BrushStroke } from '../src/core/types';

function settings(): SculptSettings {
  return {
    ...defaultSculptSettings(),
    brush: {
      name: 'Ridged shoreline · 山',
      tool: 'stamp',
      radius: 9.5,
      strength: 0.75,
      falloff: 0.25,
      target: -12,
    },
    alphaKind: 'custom',
    alphaName: 'Precise cliff.png',
    alpha: {
      width: 2,
      height: 2,
      values: new Float32Array([0, 1 / 65535, 0.23456789, 1]),
    },
    rotation: 67,
    stampHeight: 17.5,
    stampBase: -3.5,
    stampMode: 'set',
    pressure: false,
  };
}
describe('portable sculpt presets', () => {
  it('round-trips complete brush settings and precise independent alpha samples', () => {
    const source = settings(),
      before = structuredClone(source);
    const text = serializeSculptPreset(source, 42);
    const preset = parseSculptPreset(text);
    expect(preset).toEqual({ settings: source, talus: 42 });
    expect(preset.settings.alpha!.values).toBeInstanceOf(Float32Array);
    preset.settings.alpha!.values[0] = 1;
    preset.settings.brush.radius = 2;
    expect(source).toEqual(before);
    expect(JSON.parse(text).settings.alpha.values[1]).toBeLessThan(1 / 255);
    const legacy = defaultSculptSettings();
    delete legacy.brush;
    expect(
      parseSculptPreset(serializeSculptPreset(legacy)).settings.brush,
    ).toEqual(defaultSculptBrushSettings());
  });

  it('preserves actual edits for every sculpt tool and built-in shape', () => {
    for (const tool of SCULPT_BRUSH_TOOLS) {
      for (const kind of [
        'none',
        'round',
        'ridge',
        'crater',
        'custom',
      ] as const) {
        const source = settings();
        source.brush!.tool = tool;
        source.brush!.target = 4;
        source.alphaKind = kind;
        const imported = parseSculptPreset(serializeSculptPreset(source, 18));
        const a = createProject(32, 32),
          b = createProject(32, 32);
        generateTerrain(a, 'alpine');
        generateTerrain(b, 'alpine');
        a.holes.fill(1, 20, 40);
        b.holes.set(a.holes);
        const dab = (s: SculptSettings, talus: number): BrushStroke => ({
          tool: s.brush!.tool,
          x: 1,
          z: -2,
          radius: s.brush!.radius,
          strength: s.brush!.strength,
          falloff: s.brush!.falloff,
          target: s.brush!.tool === 'stamp' ? s.stampHeight : s.brush!.target,
          rotation: (s.rotation * Math.PI) / 180,
          stampBase: s.stampBase,
          stampMode: s.stampMode,
          talus,
          alpha:
            s.alphaKind === 'custom'
              ? s.alpha
              : s.alphaKind === 'none'
                ? undefined
                : builtInAlpha(s.alphaKind),
          material: 0,
          brushId: 'pine',
          seed: 42,
        });
        applyBrush(a, dab(source, 18));
        applyBrush(b, dab(imported.settings, imported.talus));
        expect(b.heights).toEqual(a.heights);
        expect(b.holes).toEqual(a.holes);
      }
    }
  });

  it('rejects malformed settings, unsupported tools and oversized files before use', () => {
    const valid = JSON.parse(serializeSculptPreset(settings()));
    const corrupt = [
      (x: any) => {
        x.version = 2;
      },
      (x: any) => {
        x.kind = 'terrain-foliage-brush';
      },
      (x: any) => {
        delete x.settings.brush;
      },
      (x: any) => {
        x.settings.brush.tool = 'prop';
      },
      (x: any) => {
        x.settings.brush.name = '';
      },
      (x: any) => {
        x.settings.brush.radius = 0;
      },
      (x: any) => {
        x.settings.brush.radius = 51;
      },
      (x: any) => {
        x.settings.brush.strength = '1';
      },
      (x: any) => {
        x.settings.brush.falloff = null;
      },
      (x: any) => {
        x.settings.brush.target = 10001;
      },
      (x: any) => {
        x.settings.alpha.width = 513;
      },
      (x: any) => {
        x.settings.alpha.values.pop();
      },
      (x: any) => {
        x.settings.alpha.values[0] = -1;
      },
      (x: any) => {
        delete x.settings.alpha;
      },
      (x: any) => {
        x.settings.pressure = 1;
      },
      (x: any) => {
        x.talus = 81;
      },
    ];
    for (const change of corrupt) {
      const invalid = structuredClone(valid);
      change(invalid);
      expect(() => parseSculptPreset(JSON.stringify(invalid))).toThrow();
    }
    expect(() =>
      parseSculptPreset(' '.repeat(MAX_SCULPT_PRESET_BYTES + 1)),
    ).toThrow('8 MiB');
    expect(() => serializeSculptPreset(settings(), NaN)).toThrow('slope');
    const invalid = settings();
    invalid.brush!.target = Infinity;
    expect(() => serializeSculptPreset(invalid)).toThrow('target');
  });

  it('survives native packages, legacy JSON and independently restored history', async () => {
    const project = createProject(8, 16),
      history = new History();
    const before = structuredClone(project);
    history.checkpoint(project);
    project.sculpt = parseSculptPreset(
      serializeSculptPreset(settings()),
    ).settings;
    const loaded = parseProjectPackage(
      await serializeProjectPackage(project).arrayBuffer(),
    );
    expect(loaded.sculpt).toEqual(project.sculpt);
    expect(parseProject(serializeProject(project)).sculpt).toEqual(
      project.sculpt,
    );
    const undone = history.undo(project);
    expect(undone).toEqual(before);
    const redone = history.redo(undone);
    expect(redone.sculpt).toEqual(project.sculpt);
    redone.sculpt!.brush!.strength = 2;
    redone.sculpt!.alpha!.values[0] = 1;
    expect(project.sculpt!.brush!.strength).toBe(0.75);
    expect(project.sculpt!.alpha!.values[0]).toBe(0);
    const legacy = JSON.parse(serializeProject(project));
    delete legacy.sculpt.brush;
    expect(parseProject(JSON.stringify(legacy)).sculpt!.brush).toBeUndefined();
    legacy.sculpt.brush = { ...defaultSculptBrushSettings(), tool: 'material' };
    expect(() => parseProject(JSON.stringify(legacy))).toThrow('tool');
  });

  it('stores full-size alphas exactly and excludes unrelated document payloads', () => {
    const source = settings();
    source.alpha = {
      width: 512,
      height: 512,
      values: Float32Array.from(
        { length: 512 * 512 },
        (_, i) => (i % 65536) / 65535,
      ),
    };
    (source as unknown as Record<string, unknown>).assets = {
      secret: 'unrelated scene payload',
    };
    const text = serializeSculptPreset(source);
    expect(text.length).toBeLessThan(MAX_SCULPT_PRESET_BYTES);
    expect(text).not.toContain('unrelated scene payload');
    const loaded = parseSculptPreset(text);
    expect(new Uint8Array(loaded.settings.alpha!.values.buffer)).toEqual(
      new Uint8Array(source.alpha.values.buffer),
    );
  });
});
