import { createProject } from './terrain';
import { foliageModels } from './foliage';
import { validateProjectData } from './serialization';
import type { FoliageBrush, TerrainProject } from './types';

/** A portable brush embeds only its referenced GLB assets, not terrain or textures. */
export function serializeFoliageBrush(
  project: TerrainProject,
  brushId: string,
) {
  const brush = project.brushes.find((b) => b.id === brushId);
  if (!brush) throw new Error('Unknown foliage brush.');
  const ids = new Set([
    brush.model,
    ...foliageModels(brush).flatMap((m) => [
      m.model,
      ...(m.lods ?? []).map((lod) => lod.model),
    ]),
  ]);
  const text = JSON.stringify({
    kind: 'terrain-foliage-brush',
    version: 1,
    brush,
    surfaceIds: project.materials.map((m) => m.id),
    assets: Object.fromEntries(
      Object.entries(project.assets).filter(([id]) => ids.has(id)),
    ),
  });
  if (text.length > 100_000_000 || new Blob([text]).size > 100_000_000)
    throw new Error(
      'Brush exceeds the 100 MB file limit. Use smaller model assets or save the complete .terrain project.',
    );
  return text;
}

/** Return a new project; validation and asset remapping never mutate the source. */
export function importFoliageBrush(
  project: TerrainProject,
  text: string,
): TerrainProject {
  if (text.length > 100_000_000)
    throw new Error('Brush exceeds the 100 MB import limit.');
  const raw = JSON.parse(text);
  if (
    !raw ||
    raw.kind !== 'terrain-foliage-brush' ||
    raw.version !== 1 ||
    !Array.isArray(raw.surfaceIds) ||
    raw.surfaceIds.length !== 4
  )
    throw new Error('Invalid foliage brush file.');
  const validation = createProject(8, 8);
  validation.brushes = [raw.brush];
  validation.assets = raw.assets;
  validation.materials.forEach((m, i) => {
    m.id = raw.surfaceIds[i];
  });
  const source = validateProjectData(validation);
  if (project.brushes.length >= 256)
    throw new Error('Maximum 256 foliage brushes.');
  const next = structuredClone(project),
    brush: FoliageBrush = structuredClone(source.brushes[0]);
  const remapped = new Map<string, string>();
  for (const [id, asset] of Object.entries(source.assets)) {
    const existing = Object.entries(next.assets).find(
      ([, a]) => a.data === asset.data,
    );
    if (existing) {
      remapped.set(id, existing[0]);
      continue;
    }
    if (Object.keys(next.assets).length >= 256)
      throw new Error('Maximum 256 model assets.');
    let destination = id;
    while (Object.hasOwn(next.assets, destination))
      destination = 'asset-' + next.nextId++;
    next.assets[destination] = asset;
    remapped.set(id, destination);
  }
  brush.model = remapped.get(brush.model) ?? brush.model;
  for (const model of brush.models ?? []) {
    model.model = remapped.get(model.model) ?? model.model;
    for (const lod of model.lods ?? [])
      lod.model = remapped.get(lod.model) ?? lod.model;
  }
  brush.materials = [
    ...new Set(
      brush.materials.map(
        (id) =>
          next.materials.find((m) => m.id === id)?.id ??
          next.materials[source.materials.findIndex((m) => m.id === id)].id,
      ),
    ),
  ];
  do {
    brush.id = 'brush-' + next.nextId++;
  } while (next.brushes.some((b) => b.id === brush.id));
  next.brushes.push(brush);
  return next;
}
