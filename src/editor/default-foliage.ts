import { importFoliageBrush } from '../core/foliage-preset';
import type { FoliageBrush, TerrainProject } from '../core/types';
import { checkSignal } from '../render/resources';
import { defaultFoliageSubsurface } from '../core/foliage-shading';

const baseURL = import.meta.env.BASE_URL + 'foliage/photoreal/';
export const foliageCreditsURL = baseURL + 'CREDITS.txt';
export const defaultFoliageChoices = [
  ['pine', 'Photoreal pine trees'],
  ['fern', 'Photoreal ferns'],
  ['grass', 'Photoreal meadow grass'],
  ['sorrel', 'Photoreal flowering sorrel'],
] as const;
export type DefaultFoliageKind = (typeof defaultFoliageChoices)[number][0];

/** Sizes are metres at scale 1; white tint preserves the creators' albedo. */
export function defaultFoliageBrush(kind: DefaultFoliageKind): FoliageBrush {
  const pine = kind === 'pine',
    fern = kind === 'fern',
    grass = kind === 'grass';
  const ids = pine
    ? ['ph-pine-b']
    : fern
      ? ['ph-fern-b', 'ph-fern-a']
      : grass
        ? ['ph-grass-tall-a', 'ph-grass-tall-b']
        : ['ph-sorrel-b', 'ph-sorrel-d'];
  const minScale = pine ? 0.75 : fern ? 0.85 : grass ? 1.4 : 2;
  const maxScale = pine ? 1.1 : fern ? 1.3 : grass ? 2.5 : 3.5;
  const wind = pine ? 0.25 : fern ? 0.45 : grass ? 0.65 : 0.25;
  const crush = pine ? 0 : fern ? 0.35 : 0.65;
  return {
    id: kind,
    name: defaultFoliageChoices.find(([id]) => id === kind)![1],
    model: ids[0],
    materials: grass ? ['grass', 'sand'] : ['grass'],
    minWeight: 0.45,
    density: pine ? 0.009 : fern ? 0.8 : grass ? 5 : 8,
    spacing: pine ? 8 : fern ? 0.75 : grass ? 0.22 : 0.15,
    minScale,
    maxScale,
    rotation: 180,
    alignToNormal: !pine,
    maxSlope: pine ? 32 : 45,
    wind,
    crush,
    color: '#ffffff',
    models: ids.map((model, i) => ({
      id: 'variant-' + i,
      model,
      weight: 1,
      minScale,
      maxScale,
      minRotation: -180,
      maxRotation: 180,
      alignToNormal: !pine,
      wind,
      crush,
      color: '#ffffff',
      subsurface: {
        ...defaultFoliageSubsurface(),
        strength: pine ? 0.35 : 0.6,
        thickness: pine ? 0.65 : 0.3,
      },
      interaction: { enabled: crush > 0, radius: 4, recovery: 2.5 },
      flexibility: {
        source: 'height',
        start: pine ? 0.4 : 0.05,
        end: 1,
        exponent: pine ? 2 : 1.5,
      },
      lods: pine
        ? [
            { model: model + '-mid', distance: 55, density: 1 },
            { model: model + '-low', distance: 130, density: 1 },
          ]
        : [{ model: model + '-low', distance: fern ? 22 : 12, density: 0.7 }],
      cullDistance: pine ? 700 : fern ? 100 : 65,
      lodHysteresis: 0.12,
      lodFadeDuration: 0.35,
    })),
  };
}

const cache = new Map<string, string>();
interface DefaultAsset {
  name: string;
  file: string;
  bytes: number;
  sha256: string;
}
let assetManifest: Record<string, DefaultAsset> | undefined;
async function loadManifest(signal?: AbortSignal) {
  checkSignal(signal);
  if (assetManifest) return assetManifest;
  // Public files are served by URL. Importing them as modules breaks Vite's dev server.
  const response = await fetch(baseURL + 'assets.json', { signal });
  if (!response.ok)
    throw new Error(
      'Could not load the foliage catalog (' + response.status + ').',
    );
  const value = (await response.json()) as unknown;
  checkSignal(signal);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid foliage catalog.');
  const parsed: Record<string, DefaultAsset> = Object.create(null) as Record<
    string,
    DefaultAsset
  >;
  for (const [id, entry] of Object.entries(value)) {
    const a = entry as DefaultAsset;
    if (
      !a ||
      typeof a.name !== 'string' ||
      typeof a.file !== 'string' ||
      !/^[a-z0-9_-]+\.glb$/i.test(a.file) ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 1 ||
      a.bytes > 30_000_000 ||
      typeof a.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(a.sha256)
    )
      throw new Error('Invalid foliage catalog entry: ' + id);
    parsed[id] = {
      name: a.name,
      file: a.file,
      bytes: a.bytes,
      sha256: a.sha256,
    };
  }
  assetManifest = parsed;
  return parsed;
}
async function loadAsset(
  id: string,
  manifest: Record<string, DefaultAsset>,
  signal?: AbortSignal,
) {
  checkSignal(signal);
  const asset = manifest[id];
  if (!asset) throw new Error('Unknown default foliage asset: ' + id);
  let data = cache.get(id);
  if (!data) {
    const response = await fetch(baseURL + asset.file, { signal });
    if (!response.ok)
      throw new Error(
        'Could not load ' + asset.name + ' (' + response.status + ').',
      );
    const bytes = await response.arrayBuffer();
    checkSignal(signal);
    if (bytes.byteLength !== asset.bytes)
      throw new Error('Incomplete foliage asset: ' + asset.name);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== asset.sha256)
      throw new Error('Foliage asset checksum mismatch: ' + asset.name);
    // Chunk the conversion to avoid exceeding the call stack on large trees.
    const values = new Uint8Array(bytes),
      chunks: string[] = [];
    for (let i = 0; i < values.length; i += 8192)
      chunks.push(String.fromCharCode(...values.subarray(i, i + 8192)));
    data = 'data:model/gltf-binary;base64,' + btoa(chunks.join(''));
    checkSignal(signal);
    cache.set(id, data);
  }
  return { name: asset.name, data };
}

/** Returns an isolated, portable document. The caller stages GPU resources before committing. */
export async function addDefaultFoliage(
  project: TerrainProject,
  kinds: readonly DefaultFoliageKind[],
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
) {
  let next = project;
  let completed = 0;
  const manifest = await loadManifest(signal);
  for (const kind of kinds) {
    const brush = defaultFoliageBrush(kind);
    const ids = new Set(
      brush.models!.flatMap((m) => [m.model, ...m.lods!.map((l) => l.model)]),
    );
    const assets = Object.fromEntries(
      await Promise.all(
        Array.from(ids, async (id) => [
          id,
          await loadAsset(id, manifest, signal),
        ]),
      ),
    );
    checkSignal(signal);
    next = importFoliageBrush(
      next,
      JSON.stringify({
        kind: 'terrain-foliage-brush',
        version: 1,
        brush,
        surfaceIds: ['grass', 'rock', 'sand', 'snow'],
        assets,
      }),
    );
    onProgress?.(++completed, kinds.length);
  }
  return next;
}
