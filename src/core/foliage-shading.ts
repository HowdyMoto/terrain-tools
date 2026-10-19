/** Thin-sheet leaf transmission. This is not volumetric or refractive glass. */
export interface FoliageSubsurface {
  /** Cutout limits the effect to alpha-tested leaf materials, preserving opaque bark. */
  mode: 'cutout' | 'all';
  /** Optional material-name selection shared by LODs. Omitted selects all eligible materials. */
  materials?: string[];
  strength: number;
  /** Dimensionless optical thickness; larger values absorb more transmitted light. */
  thickness: number;
  tint: string;
  /** Angular wrap around grazing light, from 0 to 1. */
  wrap: number;
  /** Smooth cutout coverage when the renderer uses MSAA. Shadow cutouts stay unchanged. */
  smoothEdges: boolean;
}

export function defaultFoliageSubsurface(): FoliageSubsurface {
  return {
    mode: 'cutout',
    strength: 0.6,
    thickness: 0.3,
    tint: '#ffffff',
    wrap: 0.25,
    smoothEdges: true,
  };
}

export function parseFoliageSubsurface(value: unknown): FoliageSubsurface {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid leaf subsurface settings.');
  const s = value as FoliageSubsurface;
  if (
    !['cutout', 'all'].includes(s.mode) ||
    typeof s.smoothEdges !== 'boolean' ||
    typeof s.tint !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(s.tint)
  )
    throw new Error('Invalid leaf subsurface material settings.');
  if (
    s.materials !== undefined &&
    (!Array.isArray(s.materials) ||
      s.materials.length > 128 ||
      new Set(s.materials).size !== s.materials.length ||
      s.materials.some((name) => typeof name !== 'string' || name.length > 256))
  )
    throw new Error('Invalid leaf subsurface material selection.');
  for (const [key, maximum] of [
    ['strength', 1],
    ['thickness', 4],
    ['wrap', 1],
  ] as const)
    if (
      typeof s[key] !== 'number' ||
      !Number.isFinite(s[key]) ||
      s[key] < 0 ||
      s[key] > maximum
    )
      throw new Error('Invalid leaf subsurface ' + key + '.');
  return {
    mode: s.mode,
    ...(s.materials ? { materials: [...s.materials] } : {}),
    strength: s.strength,
    thickness: s.thickness,
    tint: s.tint,
    wrap: s.wrap,
    smoothEdges: s.smoothEdges,
  };
}
