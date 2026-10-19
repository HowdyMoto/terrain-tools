import {
  defaultFoliageSubsurface,
  parseFoliageSubsurface,
} from '../core/foliage-shading';
import type { FoliageSubsurface } from '../core/foliage-shading';
import type { FoliageModel } from '../core/types';
import type { ModelLibrary } from '../render/models';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
function materialNames(model: FoliageModel, library: ModelLibrary) {
  return [
    ...new Set(
      [model.model, ...(model.lods ?? []).map((lod) => lod.model)]
        .flatMap((asset) => library.get(asset))
        .flatMap((part) =>
          Array.isArray(part.material) ? part.material : [part.material],
        )
        .map((material) => material.name),
    ),
  ];
}

const numbers = [
  ['strength', 'Transmission strength', 1, 0.05],
  ['thickness', 'Leaf thickness / absorption', 4, 0.05],
  ['wrap', 'Light wrap', 1, 0.05],
] as const;

export function foliageShadingControls(
  model: FoliageModel,
  library: ModelLibrary,
) {
  const s = model.subsurface;
  return (
    '<section class="control-section foliage-shading-controls"><h3>Leaf lighting</h3>' +
    '<label class="toggle-field"><span>Thin-leaf translucency</span><input id="leaf-enabled" type="checkbox" ' +
    (s ? 'checked' : '') +
    '/><span class="switch"></span></label>' +
    (s
      ? '<label class="field"><span>Apply to</span><select id="leaf-mode"><option value="cutout" ' +
        (s.mode === 'cutout' ? 'selected' : '') +
        '>Leaf cutouts only</option><option value="all" ' +
        (s.mode === 'all' ? 'selected' : '') +
        '>All model materials</option></select></label>' +
        '<details><summary>Choose materials</summary>' +
        materialNames(model, library)
          .map(
            (name, index) =>
              '<label class="toggle-field"><span>' +
              escape(name || 'Unnamed material') +
              '</span><input type="checkbox" data-leaf-material="' +
              index +
              '" ' +
              (!s.materials || s.materials.includes(name) ? 'checked' : '') +
              '/><span class="switch"></span></label>',
          )
          .join('') +
        '<p class="field-note">Uncheck bark, twigs or flowers that should stay opaque. Names match across LODs; a material shared by bark and leaves must be split in the source asset.</p></details>' +
        numbers
          .map(
            ([key, label, max, step]) =>
              '<label class="range-field"><span>' +
              label +
              '<output id="out-leaf-' +
              key +
              '">' +
              s[key] +
              '</output></span><input id="leaf-' +
              key +
              '" type="range" min="0" max="' +
              max +
              '" step="' +
              step +
              '" value="' +
              s[key] +
              '"/></label>',
          )
          .join('') +
        '<label class="color-field"><span>Transmission tint</span><input id="leaf-tint" type="color" value="' +
        s.tint +
        '"/></label>' +
        '<label class="toggle-field"><span>Smooth leaf edges (MSAA)</span><input id="leaf-smoothEdges" type="checkbox" ' +
        (s.smoothEdges ? 'checked' : '') +
        '/><span class="switch"></span></label>'
      : '') +
    '<p class="field-note">Sunlight passes through leaves and follows cast shadows. Cutouts keeps opaque bark and stones solid; use All only for leaf-only meshes without alpha cutouts. White tint preserves the leaf color. Greater thickness absorbs more light.</p>' +
    '<p class="field-note">The imported alpha map still defines the leaf silhouette. Translucency adds light through the leaf without making it see-through. Settings include all distance LODs.</p></section>'
  );
}

export function bindFoliageShadingControls(
  model: FoliageModel,
  library: ModelLibrary,
  change: (settings?: FoliageSubsurface) => void,
  fail: (message: string) => void,
) {
  const input = (key: string) =>
    document.getElementById('leaf-' + key) as HTMLInputElement;
  input('enabled').onchange = () =>
    change(input('enabled').checked ? defaultFoliageSubsurface() : undefined);
  const current = model.subsurface;
  if (!current) return;
  const apply = (patch: Partial<FoliageSubsurface>) => {
    try {
      change(parseFoliageSubsurface({ ...current, ...patch }));
    } catch (error) {
      fail(String(error));
    }
  };
  const mode = document.getElementById('leaf-mode') as HTMLSelectElement;
  const names = materialNames(model, library);
  const choices = [
    ...document.querySelectorAll<HTMLInputElement>('[data-leaf-material]'),
  ];
  for (const choice of choices)
    choice.onchange = () =>
      apply({
        materials: choices
          .filter((item) => item.checked)
          .map((item) => names[Number(item.dataset.leafMaterial)]),
      });
  mode.onchange = () =>
    apply({ mode: mode.value as FoliageSubsurface['mode'] });
  input('tint').onchange = () => apply({ tint: input('tint').value });
  input('smoothEdges').onchange = () =>
    apply({ smoothEdges: input('smoothEdges').checked });
  for (const [key] of numbers) {
    input(key).oninput = () => {
      document.getElementById('out-leaf-' + key)!.textContent =
        input(key).value;
    };
    input(key).onchange = () => apply({ [key]: input(key).valueAsNumber });
  }
}
