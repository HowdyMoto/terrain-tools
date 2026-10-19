import type { PNGChannel } from '../core/heightmap-png';

export const materialPresets = {
  auto: {
    label: 'Auto / custom',
    normal: 'opengl',
    description:
      'Infer maps from filenames. Review the roles and normal convention below.',
  },
  blender: {
    label: 'Blender',
    normal: 'opengl',
    description: 'OpenGL normals and separate roughness/metalness maps.',
  },
  unreal: {
    label: 'Unreal Engine',
    normal: 'directx',
    description:
      'DirectX normals. ORM / ARM maps use R: occlusion, G: roughness, B: metalness. Other packed layouts are selectable below.',
  },
  unity: {
    label: 'Unity — Built-in / URP',
    normal: 'opengl',
    description:
      'Metallic workflow: metallic map R → metalness, A → smoothness (inverted to roughness). Occlusion uses G. Separate roughness maps remain roughness.',
  },
  'unity-hdrp': {
    label: 'Unity — HDRP Lit',
    normal: 'opengl',
    description:
      'Mask map: R → metalness, G → occlusion, A → smoothness (inverted to roughness). The blue detail mask is not imported.',
  },
  opengl: {
    label: 'Generic OpenGL (+Y)',
    normal: 'opengl',
    description:
      'OpenGL normals with roughness/metalness maps. Review packed layouts below.',
  },
  directx: {
    label: 'Generic DirectX (−Y)',
    normal: 'directx',
    description:
      'DirectX normals with roughness/metalness maps. Review packed layouts below.',
  },
} as const;
export type MaterialPreset = keyof typeof materialPresets;

export const mapRoles = [
  'ignore',
  'albedo',
  'normal',
  'orm',
  'rma',
  'mra',
  'metallic-smoothness',
  'hdrp-mask',
  'height',
  'occlusion',
  'roughness',
  'metalness',
] as const;
export type MapRole = (typeof mapRoles)[number];
export const mapLabels: Record<MapRole, string> = {
  ignore: 'Not used',
  albedo: 'Base color',
  normal: 'Normal',
  orm: 'Packed ORM / ARM',
  rma: 'Packed RMA',
  mra: 'Packed MRA',
  'metallic-smoothness': 'Unity metallic + smoothness',
  'hdrp-mask': 'Unity HDRP mask',
  height: 'Height',
  occlusion: 'Ambient occlusion',
  roughness: 'Roughness / gloss',
  metalness: 'Metalness',
};

export type NumericSlot = 'occlusion' | 'roughness' | 'metalness';
export interface MaterialSource {
  role: MapRole;
  channel: PNGChannel;
}
/** Source channels to read before display gamma or alpha multiplication. */
export function materialChannels({
  role,
  channel,
}: MaterialSource): Partial<Record<NumericSlot, PNGChannel>> {
  switch (role) {
    case 'orm':
      return { occlusion: 'red', roughness: 'green', metalness: 'blue' };
    case 'rma':
      return { occlusion: 'blue', roughness: 'red', metalness: 'green' };
    case 'mra':
      return { occlusion: 'blue', roughness: 'green', metalness: 'red' };
    case 'metallic-smoothness':
      return { metalness: 'red', roughness: 'alpha' };
    case 'hdrp-mask':
      return { occlusion: 'green', roughness: 'alpha', metalness: 'red' };
    case 'occlusion':
    case 'roughness':
    case 'metalness':
      return { [role]: channel };
    default:
      return {};
  }
}
export function defaultMapChannel(
  role: MapRole,
  preset: MaterialPreset,
): PNGChannel {
  return role === 'occlusion' && (preset === 'unity' || preset === 'unity-hdrp')
    ? 'green'
    : 'red';
}
export function isSmoothnessRole(role: MapRole) {
  return role === 'metallic-smoothness' || role === 'hdrp-mask';
}

/** Explicit filename conventions take precedence over engine defaults. */
export function detectMap(
  name: string,
  preset: MaterialPreset = 'auto',
): {
  role: MapRole;
  directX: boolean;
  gloss: boolean;
  channel: PNGChannel;
} {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .split(/[^a-z0-9]+/);
  const has = (...tokens: string[]) => tokens.some((t) => words.includes(t));
  const directX = has('directx', 'dx', 'normaldx', 'nordx')
    ? true
    : has('opengl', 'ogl', 'gl', 'normalgl', 'norgl')
      ? false
      : materialPresets[preset].normal === 'directx';
  const gloss = has('gloss', 'glossiness', 'smoothness');
  const metallic = has('metalness', 'metallic', 'metal');
  let role: MapRole;
  if (
    has('orm', 'arm') ||
    /(?:occlusion|ao)roughnessmetal(?:lic|ness)/.test(words.join(''))
  )
    role = 'orm';
  else if (has('rma')) role = 'rma';
  else if (has('mra')) role = 'mra';
  else if (has('detail', 'preview', 'specular', 'spec')) role = 'ignore';
  else if (preset === 'unity-hdrp' && has('mask', 'maskmap'))
    role = 'hdrp-mask';
  else if (
    has('normal', 'nor', 'nrm', 'normalgl', 'normaldx', 'norgl', 'nordx') ||
    (preset === 'unreal' && has('n'))
  )
    role = 'normal';
  else if (metallic && (gloss || preset === 'unity'))
    role = 'metallic-smoothness';
  else if (
    has('roughness', 'rough', 'rgh') ||
    gloss ||
    (preset === 'unreal' && has('r'))
  )
    role = 'roughness';
  else if (metallic) role = 'metalness';
  else if (has('ao', 'occlusion', 'ambientocclusion')) role = 'occlusion';
  else if (has('height', 'displacement', 'disp', 'displ')) role = 'height';
  else if (
    has(
      'albedo',
      'diffuse',
      'diff',
      'color',
      'colour',
      'basecolor',
      'basecolour',
      'basemap',
    ) ||
    (preset === 'unreal' && has('d', 'bc'))
  )
    role = 'albedo';
  else role = 'ignore';
  return {
    role,
    directX,
    gloss: gloss || isSmoothnessRole(role),
    channel: defaultMapChannel(role, preset),
  };
}
export function mapAssignmentError(roles: MapRole[]) {
  const used = roles.filter((role) => role !== 'ignore');
  if (!used.length) return 'Assign at least one image to a map slot.';
  for (const role of used)
    if (used.filter((value) => value === role).length > 1)
      return `Choose one ${mapLabels[role].toLowerCase()} map. Set alternatives to Not used.`;
  if (
    used.includes('orm') &&
    used.some((role) => ['occlusion', 'roughness', 'metalness'].includes(role))
  )
    return 'Choose packed ORM or separate channels. Set the unused approach to Not used.';
  const outputs = new Set<string>();
  for (const role of used) {
    const channels = Object.keys(materialChannels({ role, channel: 'red' }));
    for (const output of channels.length ? channels : [role]) {
      if (outputs.has(output))
        return `Multiple maps supply ${output}. Choose one source or change its role; set alternatives to Not used.`;
      outputs.add(output);
    }
  }
  return '';
}
export function conversionSummary(source: MaterialSource, gloss: boolean) {
  const description = Object.entries(materialChannels(source))
    .map(
      ([slot, channel]) =>
        `${slot === 'roughness' && gloss ? '1 − ' : ''}${channel.toUpperCase()} → ${slot}`,
    )
    .join(' · ');
  return (
    description +
    (source.role === 'hdrp-mask' ? ' · Blue detail mask omitted' : '')
  );
}
export function materialName(filename: string) {
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .replace(
        /(?:[_ -](?:albedo|diffuse|diff|color|basecolor|normal|nor|roughness|rough|orm|arm|rma|mra|mask|maskmap|metallicgloss|height|disp|ao|metalness|metallic|gloss|smoothness|opengl|directx|ogl|gl|dx|\d+k|\d{3,4}))+$/gi,
        '',
      )
      .replace(/[_-]+/g, ' ')
      .trim()
      .slice(0, 120) || 'Imported surface'
  );
}
