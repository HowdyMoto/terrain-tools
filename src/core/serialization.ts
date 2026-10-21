import { validatePropCutout } from './props';
import { parseEyeHeight } from './project-settings';
import { parseSculptBrushSettings } from './sculpt';
import { validateFoliageDetail } from './foliage-lod';
import { parseFoliageSubsurface } from './foliage-shading';
import type { FoliageModel } from './types';
import { parseEnvironmentSettings } from './environment';
import { parseWaterSettings } from './water';
import { parseErosionSettings } from './erosion';
import type { TerrainProject } from './types';
import { MAX_TEXTURE_DATA_URL_CHARACTERS } from './texture-limits';
import { checkModelDataURL } from './model-limits';
import { parseModelSource } from './model-source';

export const MAX_PROJECT_JSON_CHARACTERS = 100_000_000;
/** Read larger legacy saves for migration; new large saves use binary packages. */
export const MAX_LEGACY_PROJECT_CHARACTERS = 384 * 1024 * 1024;
export function serializeProject(p: TerrainProject) {
  const text = JSON.stringify({
    ...p,
    heights: Array.from(p.heights),
    holes: Array.from(p.holes),
    paint: Array.from(p.paint),
    ...(p.sculpt
      ? {
          sculpt: {
            ...p.sculpt,
            ...(p.sculpt.alpha
              ? {
                  alpha: {
                    ...p.sculpt.alpha,
                    values: Array.from(p.sculpt.alpha.values),
                  },
                }
              : {}),
          },
        }
      : {}),
  });
  if (text.length > MAX_PROJECT_JSON_CHARACTERS)
    throw new Error(
      'Project exceeds the legacy JSON limit. Save a .terrain package instead.',
    );
  return text;
}

/** Validate before allocating typed buffers or replacing a live document. */
export function parseProject(text: string): TerrainProject {
  if (text.length > MAX_LEGACY_PROJECT_CHARACTERS)
    throw new Error(
      'Project exceeds the legacy JSON limit. Use a .terrain package.',
    );
  return validateProjectData(JSON.parse(text));
}
/** Validate parsed metadata or native buffers. Does not mutate the input. */
export function validateProjectData(
  raw: unknown,
  copyBuffers = true,
): TerrainProject {
  const object = (v: unknown, label: string): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
      throw new Error('Invalid ' + label + '.');
    return v as Record<string, unknown>;
  };
  const number = (
    v: unknown,
    label: string,
    min: number,
    max: number,
    integer = false,
  ): number => {
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (integer && !Number.isSafeInteger(v))
    )
      throw new Error('Invalid ' + label + '.');
    return v;
  };
  const name = (v: unknown, label: string): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > 120)
      throw new Error('Invalid ' + label + '.');
    return v;
  };
  const id = (v: unknown): string => {
    const s = name(v, 'identifier');
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(s))
      throw new Error('Invalid identifier.');
    return s;
  };
  const bool = (v: unknown) => {
    if (typeof v !== 'boolean') throw new Error('Invalid boolean setting.');
  };
  const color = (v: unknown) => {
    if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v))
      throw new Error('Invalid color.');
  };
  const list = (v: unknown, label: string, max: number): unknown[] => {
    if (!Array.isArray(v) || v.length > max)
      throw new Error('Invalid ' + label + '.');
    return v;
  };
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length)
      throw new Error('Duplicate ' + label + '.');
  };
  const p = object(raw, 'project');
  if (
    p.folderId !== undefined &&
    (typeof p.folderId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        p.folderId,
      ))
  )
    throw new Error('Invalid project folder identity.');
  const documentPath =
    typeof p.project === 'string' &&
    p.project.length <= 240 &&
    /\.terrain$/i.test(p.project)
      ? p.project
      : undefined;
  if (
    p.kind === 'terrain-content-manifest' ||
    (p.version === undefined && documentPath)
  )
    throw new Error(
      'This file is a content manifest. ' +
        (documentPath
          ? `Open ${JSON.stringify(documentPath)} instead.`
          : 'Open the .terrain document in the content folder.'),
    );
  if (p.version === undefined)
    throw new Error(
      'This JSON file is not a Terrain Studio document. Open a .terrain file or a saved legacy project JSON.',
    );
  if (p.version !== 1) throw new Error('Unsupported terrain project version.');
  const resolution = number(p.resolution, 'terrain dimensions', 8, 512, true),
    size = number(p.size, 'terrain dimensions', 8, 10000),
    vertices = (resolution + 1) ** 2;
  name(p.name, 'project name');
  number(p.seed, 'seed', -2147483648, 2147483647);
  number(p.nextId, 'next identifier', 1, Number.MAX_SAFE_INTEGER, true);
  const buffer = (
    v: unknown,
    length: number,
    min: number,
    max: number,
    integer = false,
  ): number[] | Float32Array | Uint8Array => {
    if (
      (!Array.isArray(v) &&
        !(v instanceof Float32Array) &&
        !(v instanceof Uint8Array)) ||
      v.length !== length
    )
      throw new Error('Invalid terrain buffer.');
    for (const value of v) number(value, 'terrain buffer', min, max, integer);
    return v;
  };
  const heights = buffer(p.heights, vertices, -size, size),
    holes = buffer(p.holes, resolution ** 2, 0, 1, true),
    paint = buffer(p.paint, vertices * 4, 0, 1);
  for (let i = 0; i < paint.length; i += 4)
    if (paint[i] + paint[i + 1] + paint[i + 2] + paint[i + 3] > 1.00001)
      throw new Error('Paint weights exceed one.');
  const materials = list(p.materials, 'material layers', 4);
  if (materials.length !== 4)
    throw new Error('Exactly four material layers are required.');
  const materialIds = materials.map((value) => {
    const m = object(value, 'material');
    name(m.name, 'material name');
    color(m.color);
    number(m.roughness, 'roughness', 0, 1);
    number(m.metalness, 'metalness', 0, 1);
    number(m.minHeight, 'altitude', -100000, 100000);
    number(m.maxHeight, 'altitude', m.minHeight as number, 100000);
    number(m.minSlope, 'slope', 0, 90);
    number(m.maxSlope, 'slope', m.minSlope as number, 90);
    number(m.feather, 'feather', 0, 1000);
    number(m.tileSize, 'texture scale', 0.01, 10000);
    if (m.reduceTiling !== undefined && typeof m.reduceTiling !== 'boolean')
      throw new Error('Invalid texture repetition setting.');
    number(m.blendHeight, 'height blending', 0, 1);
    if (m.normalStrength !== undefined)
      number(m.normalStrength, 'normal strength', 0, 4);
    if (
      m.normalConvention !== undefined &&
      m.normalConvention !== 'opengl' &&
      m.normalConvention !== 'directx'
    )
      throw new Error('Invalid normal map convention.');
    if (m.proceduralVariant !== undefined)
      number(m.proceduralVariant, 'procedural surface variant', 0, 3, true);
    const textures = object(m.textures, 'texture maps');
    for (const [key, data] of Object.entries(textures)) {
      if (
        !['albedo', 'normal', 'orm', 'height'].includes(key) ||
        typeof data !== 'string' ||
        data.length > MAX_TEXTURE_DATA_URL_CHARACTERS ||
        !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(data)
      )
        throw new Error(
          'Texture maps must be embedded PNG, JPEG, or WebP images.',
        );
    }
    return id(m.id);
  });
  unique(materialIds, 'material identifiers');
  const builtins = [
      'pine',
      'pine-low',
      'grass',
      'grass-low',
      'boulder',
      'platform',
      'portal',
    ],
    assets = object(p.assets, 'assets');
  if (Object.keys(assets).length > 256)
    throw new Error('Too many model assets.');
  for (const [key, value] of Object.entries(assets)) {
    id(key);
    if (builtins.includes(key))
      throw new Error('Model identifier conflicts with a built-in asset.');
    const asset = object(value, 'model asset');
    name(asset.name, 'asset name');
    checkModelDataURL(asset.data);
    if (asset.source !== undefined) parseModelSource(asset.source);
  }
  const model = (v: unknown) => {
    if (
      typeof v !== 'string' ||
      (!builtins.includes(v) && !Object.hasOwn(assets, v))
    )
      throw new Error('Unknown model reference.');
  };
  const brushes = list(p.brushes, 'foliage brushes', 256);
  if (!brushes.length)
    throw new Error('At least one foliage brush is required.');
  const brushIds = brushes.map((value) => {
    const b = object(value, 'foliage brush');
    name(b.name, 'brush name');
    model(b.model);
    color(b.color);
    const allowed = list(b.materials, 'allowed surfaces', 4);
    if (allowed.some((v) => typeof v !== 'string' || !materialIds.includes(v)))
      throw new Error('Unknown allowed material.');
    number(b.minWeight, 'minimum weight', 0, 1);
    number(b.density, 'foliage density', 0, 10);
    number(b.minScale, 'minimum scale', 0.01, 1000);
    number(b.maxScale, 'maximum scale', b.minScale as number, 1000);
    number(b.rotation, 'rotation variance', 0, 180);
    number(b.maxSlope, 'slope limit', 0, 90);
    number(b.wind, 'wind flexibility', 0, 10);
    number(b.crush, 'crush response', 0, 1);
    bool(b.alignToNormal);
    if (b.spacing !== undefined) number(b.spacing, 'foliage spacing', 0, 1000);
    if (b.models !== undefined) {
      const entries = list(b.models, 'foliage model entries', 32);
      if (!entries.length)
        throw new Error('A foliage brush needs at least one model entry.');
      const modelIds = entries.map((value) => {
        const entry = object(value, 'foliage model entry');
        model(entry.model);
        validateFoliageDetail(entry as unknown as FoliageModel);
        if (entry.subsurface !== undefined)
          parseFoliageSubsurface(entry.subsurface);
        for (const lod of (entry as unknown as FoliageModel).lods ?? [])
          model(lod.model);
        number(entry.weight, 'model probability weight', 0, 1000);
        number(entry.minScale, 'model minimum scale', 0.01, 1000);
        number(
          entry.maxScale,
          'model maximum scale',
          entry.minScale as number,
          1000,
        );
        number(entry.minRotation, 'model minimum rotation', -180, 180);
        number(
          entry.maxRotation,
          'model maximum rotation',
          entry.minRotation as number,
          180,
        );
        number(entry.wind, 'model wind flexibility', 0, 10);
        number(entry.crush, 'model crush response', 0, 1);
        if (entry.interaction !== undefined) {
          const interaction = object(entry.interaction, 'model interaction');
          bool(interaction.enabled);
          number(interaction.radius, 'model contact radius', 0.01, 1000);
          number(interaction.recovery, 'model recovery time', 0.01, 1000);
        }
        if (entry.flexibility !== undefined) {
          const mask = object(entry.flexibility, 'foliage flexibility');
          if (
            !['height', 'red', 'green', 'blue', 'alpha', 'attribute'].includes(
              mask.source as string,
            )
          )
            throw new Error('Invalid foliage flexibility source.');
          number(mask.start, 'flexibility start', 0, 0.999);
          number(
            mask.end,
            'flexibility end',
            (mask.start as number) + 0.001,
            1,
          );
          number(mask.exponent, 'flexibility exponent', 1, 8);
        }
        bool(entry.alignToNormal);
        color(entry.color);
        return id(entry.id);
      });
      unique(modelIds, 'foliage model identifiers');
    }
    return id(b.id);
  });
  unique(brushIds, 'brush identifiers');
  const instanceIds: string[] = [];
  for (const value of list(p.foliage, 'foliage instances', 50000)) {
    const f = object(value, 'foliage instance');
    instanceIds.push(
      String(
        number(f.id, 'instance identifier', 1, Number.MAX_SAFE_INTEGER, true),
      ),
    );
    if (typeof f.brushId !== 'string' || !brushIds.includes(f.brushId))
      throw new Error('Unknown foliage brush.');
    const brush = brushes[brushIds.indexOf(f.brushId as string)] as Record<
      string,
      unknown
    >;
    if (brush.models !== undefined) {
      const entries = brush.models as Record<string, unknown>[];
      if (
        typeof f.modelId !== 'string' ||
        !entries.some((m) => m.id === f.modelId)
      )
        throw new Error('Unknown foliage model entry.');
    } else if (f.modelId !== undefined && f.modelId !== 'primary') {
      throw new Error('Unknown foliage model entry.');
    }
    number(f.x, 'foliage position', -size / 2, size / 2);
    number(f.z, 'foliage position', -size / 2, size / 2);
    number(f.scale, 'instance scale', 0.01, 1000);
    number(f.rotation, 'instance rotation', -Math.PI * 2, Math.PI * 2);
  }
  for (const value of list(p.props, 'props', 10000)) {
    const prop = object(value, 'prop');
    instanceIds.push(
      String(
        number(
          prop.id,
          'instance identifier',
          1,
          Number.MAX_SAFE_INTEGER,
          true,
        ),
      ),
    );
    model(prop.model);
    number(prop.x, 'prop position', -size / 2, size / 2);
    number(prop.z, 'prop position', -size / 2, size / 2);
    number(prop.yOffset, 'prop elevation', -10000, 10000);
    number(prop.scale, 'prop scale', 0.01, 1000);
    number(prop.rotation, 'prop rotation', -Math.PI * 2, Math.PI * 2);
    number(prop.holeRadius, 'cutout radius', 0, 10000);
    bool(prop.cutHole);
    if (prop.cutout !== undefined) validatePropCutout(prop.cutout);
  }
  unique(instanceIds, 'instance identifiers');
  for (const value of instanceIds)
    if (Number(value) >= (p.nextId as number))
      throw new Error('Next identifier must exceed all instance identifiers.');
  const wind = object(p.wind, 'wind');
  bool(wind.enabled);
  number(wind.strength, 'wind strength', 0, 10);
  number(wind.direction, 'wind direction', 0, 360);
  number(wind.gust, 'wind gust', 0, 1);
  number(wind.speed, 'wind speed', 0, 20);
  const interaction = object(p.interaction, 'interaction');
  bool(interaction.enabled);
  number(interaction.radius, 'contact radius', 0.01, 1000);
  number(interaction.strength, 'compression', 0, 1);
  number(interaction.recovery, 'recovery time', 0.01, 1000);
  const view = object(p.view, 'view');
  parseEyeHeight(view.eyeHeight);
  if (
    view.textureResolution !== undefined &&
    ![256, 512, 1024, 2048].includes(view.textureResolution as number)
  )
    throw new Error('Invalid texture resolution.');
  bool(view.lowPoly);
  bool(view.wireframe);
  bool(view.water);
  number(view.waterLevel, 'water level', -10000, 10000);
  const erosion =
    p.erosion === undefined ? undefined : parseErosionSettings(p.erosion);
  const environment =
    p.environment === undefined
      ? undefined
      : parseEnvironmentSettings(p.environment);
  const water = p.water === undefined ? undefined : parseWaterSettings(p.water);
  const floats = (value: number[] | Float32Array | Uint8Array) =>
    !copyBuffers && value instanceof Float32Array
      ? value
      : new Float32Array(value);
  let sculpt: TerrainProject['sculpt'];
  if (p.sculpt !== undefined) {
    const settings = object(p.sculpt, 'sculpt settings');
    if (
      !['none', 'round', 'ridge', 'crater', 'custom'].includes(
        settings.alphaKind as string,
      )
    )
      throw new Error('Invalid sculpt alpha kind.');
    number(settings.rotation, 'alpha rotation', -180, 180);
    number(settings.stampHeight, 'stamp height', 0, 10000);
    number(settings.stampBase, 'stamp base', -10000, 10000);
    bool(settings.pressure);
    if (!['add', 'subtract', 'set'].includes(settings.stampMode as string))
      throw new Error('Invalid stamp mode.');
    if (settings.alphaName !== undefined)
      name(settings.alphaName, 'alpha name');
    if (settings.alphaKind === 'custom' && settings.alpha === undefined)
      throw new Error('Custom alpha is missing.');
    sculpt = { ...settings } as unknown as TerrainProject['sculpt'];
    if (settings.brush !== undefined)
      sculpt!.brush = parseSculptBrushSettings(settings.brush);
    if (settings.alpha !== undefined) {
      const alpha = object(settings.alpha, 'sculpt alpha');
      const width = number(alpha.width, 'alpha width', 1, 512, true),
        height = number(alpha.height, 'alpha height', 1, 512, true);
      sculpt!.alpha = {
        width,
        height,
        values: floats(buffer(alpha.values, width * height, 0, 1)),
      };
    }
  }
  return {
    ...p,
    ...(water
      ? {
          water,
          view: {
            ...view,
            water: water.ocean.enabled,
            waterLevel: water.seaLevel,
          },
        }
      : {}),
    ...(sculpt ? { sculpt } : {}),
    ...(erosion ? { erosion } : {}),
    ...(environment ? { environment } : {}),
    heights: floats(heights),
    holes:
      !copyBuffers && holes instanceof Uint8Array
        ? holes
        : new Uint8Array(holes),
    paint: floats(paint),
  } as unknown as TerrainProject;
}
