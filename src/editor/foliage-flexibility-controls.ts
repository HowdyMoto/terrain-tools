import type { FoliageFlexibility, FoliageModel } from '../core/types';
import type { ModelLibrary } from '../render/models';
import { hasFlexibilitySource } from '../render/foliage-flexibility';

const sources: [string, string][] = [
  ['whole', 'Whole plant'],
  ['height', 'Height ramp'],
  ['red', 'Vertex color · red'],
  ['green', 'Vertex color · green'],
  ['blue', 'Vertex color · blue'],
  ['alpha', 'Vertex color · alpha'],
  ['attribute', 'Imported flexibility mask'],
];
export function foliageFlexibilityControls(
  model: FoliageModel,
  library: ModelLibrary,
) {
  const mask = model.flexibility;
  const field = (
    key: string,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
  ) =>
    '<label class="field"><span>' +
    label +
    '</span><input id="flexibility-' +
    key +
    '" type="number" value="' +
    value +
    '" min="' +
    min +
    '" max="' +
    max +
    '" step="' +
    step +
    '"/></label>';
  let details =
    '<p class="field-note">Wind uses height; contact tilts and compresses the entire plant.</p>';
  if (mask) {
    const levels = [model.model, ...(model.lods ?? []).map((lod) => lod.model)];
    details =
      field('start', 'Rigid below', mask.start, 0, 0.999, 0.001) +
      field('end', 'Full flexibility above', mask.end, 0.001, 1, 0.001) +
      field('exponent', 'Response curve', mask.exponent, 1, 8, 0.1) +
      '<p class="field-note">Both wind and contact use this mask. Values run from 0 (rigid) to 1 (flexible). A larger curve keeps more of the plant rigid.</p>' +
      (mask.source === 'height'
        ? '<p class="field-note">Height runs from the primary model’s base to its top. Every LOD uses that same height range.</p>'
        : '<p class="field-note" id="flexibility-availability">' +
          levels
            .map((asset, i) => {
              const parts = library.get(asset);
              const available = parts.filter((part) =>
                hasFlexibilitySource(part.geometry, mask.source),
              ).length;
              return (
                (i ? 'LOD ' + i : 'Primary') +
                ': ' +
                available +
                ' of ' +
                parts.length +
                ' mesh parts have this mask.'
              );
            })
            .join(' ') +
          ' Parts without the selected channel stay rigid.</p>' +
          (mask.source === 'attribute'
            ? '<p class="field-note">Import a GLB with a scalar _TERRAIN_FLEXIBILITY attribute (0–1) on each flexible mesh.</p>'
            : '<p class="field-note">Vertex colors also affect material tint or opacity. An imported flexibility mask controls bending independently.</p>'));
  }
  return (
    '<section class="control-section foliage-flexibility-controls"><h3>Plant flexibility</h3>' +
    '<label class="field"><span>Bend mask</span><select id="flexibility-source">' +
    sources
      .map(
        ([value, label]) =>
          '<option value="' +
          value +
          '"' +
          (value === (mask?.source ?? 'whole') ? ' selected' : '') +
          '>' +
          label +
          '</option>',
      )
      .join('') +
    '</select></label>' +
    details +
    '</section>'
  );
}
export function bindFoliageFlexibilityControls(
  model: FoliageModel,
  change: (mask?: FoliageFlexibility) => void,
  fail: (message: string) => void,
) {
  const select = document.getElementById(
    'flexibility-source',
  ) as HTMLSelectElement;
  select.onchange = () => {
    if (select.value === 'whole') change(undefined);
    else
      change({
        start: 0,
        end: 1,
        exponent: 2,
        ...model.flexibility,
        source: select.value as FoliageFlexibility['source'],
      });
  };
  if (!model.flexibility) return;
  const original = { ...model.flexibility };
  for (const key of ['start', 'end', 'exponent'] as const) {
    const input = document.getElementById(
      'flexibility-' + key,
    ) as HTMLInputElement;
    input.onchange = () => {
      const candidate = { ...original, [key]: input.valueAsNumber };
      if (
        !input.validity.valid ||
        !Number.isFinite(input.valueAsNumber) ||
        candidate.end < candidate.start + 0.001
      ) {
        input.value = String(original[key]);
        fail(
          'Use the displayed range; full flexibility must exceed the rigid threshold by at least 0.001.',
        );
        return;
      }
      change(candidate);
    };
  }
}
