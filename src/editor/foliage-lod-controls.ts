import type { FoliageModel } from '../core/types';
import { validateFoliageDetail } from '../core/foliage-lod';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]!,
  );
type Detail = Pick<
  FoliageModel,
  'lods' | 'cullDistance' | 'lodHysteresis' | 'lodFadeDuration'
>;
export function foliageDetailControls(
  model: FoliageModel,
  choices: [string, string][],
) {
  const number = (
    id: string,
    label: string,
    value: number,
    min: number,
    max: number,
    step = 1,
  ) =>
    '<label class="field"><span>' +
    label +
    '</span><input id="' +
    id +
    '" type="number" min="' +
    min +
    '" max="' +
    max +
    '" step="' +
    step +
    '" value="' +
    value +
    '"/></label>';
  return (
    '<section class="control-section foliage-detail-controls"><h3>Distance &amp; detail</h3><p class="field-note">Choose simpler meshes with matching origin and dimensions. Distances use metres from the camera to each plant.</p>' +
    (model.lods ?? [])
      .map(
        (lod, i) =>
          '<div class="lod-entry"><h4>LOD ' +
          (i + 1) +
          '</h4><label class="field"><span>Model</span><select id="lod-model-' +
          i +
          '">' +
          choices
            .map(
              ([id, label]) =>
                '<option value="' +
                escape(id) +
                '"' +
                (id === lod.model ? ' selected' : '') +
                '>' +
                escape(label) +
                '</option>',
            )
            .join('') +
          '</select></label><button class="text-button" data-import-lod="' +
          i +
          '">Import LOD GLB</button>' +
          number(
            'lod-distance-' + i,
            'Start distance (m)',
            lod.distance,
            0.1,
            100000,
            0.1,
          ) +
          number(
            'lod-density-' + i,
            'Retained density (%)',
            lod.density * 100,
            0,
            100,
            1,
          ) +
          '<button class="text-button" data-remove-lod="' +
          i +
          '">Remove LOD ' +
          (i + 1) +
          '</button></div>',
      )
      .join('') +
    '<button id="add-lod" class="full-button"' +
    ((model.lods?.length ?? 0) >= 3 ? ' disabled' : '') +
    '>Add distance LOD</button>' +
    number(
      'foliage-cull-distance',
      'Cull distance (m) · 0 = unlimited',
      model.cullDistance ?? 0,
      0,
      100000,
      0.1,
    ) +
    number(
      'foliage-lod-hysteresis',
      'Switch hysteresis (%)',
      (model.lodHysteresis ?? 0.1) * 100,
      0,
      50,
    ) +
    number(
      'foliage-lod-fade',
      'Transition time (s) · 0 = instant',
      model.lodFadeDuration ?? 0,
      0,
      5,
      0.01,
    ) +
    '<p class="field-note">Cross-fades use a fine pixel pattern and temporarily draw overlapping levels. Longer fades increase overlap. Density keeps a stable subset. Hidden plants return when you move closer. Save brush includes every referenced LOD asset.</p><p id="foliage-detail-stats" class="field-note" aria-live="off"></p></section>'
  );
}
export function bindFoliageDetailControls(
  model: FoliageModel,
  change: (detail: Detail) => void,
  fail: (message: string) => void,
  importAsset: (index: number) => void,
) {
  const original = {
    lods: structuredClone(model.lods ?? []),
    cullDistance: model.cullDistance ?? 0,
    lodHysteresis: model.lodHysteresis ?? 0.1,
    lodFadeDuration: model.lodFadeDuration ?? 0,
  };
  const commit = (edit: (detail: typeof original) => void) => {
    try {
      const detail = structuredClone(original);
      edit(detail);
      validateFoliageDetail(detail);
      change(detail);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };
  const bindNumber = (
    id: string,
    initial: number,
    edit: (detail: typeof original, value: number) => void,
  ) => {
    const input = document.getElementById(id) as HTMLInputElement;
    input.onchange = () => {
      if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) {
        input.value = String(initial);
        fail('Enter a value within the displayed range.');
        return;
      }
      commit((detail) => edit(detail, input.valueAsNumber));
      if (input.isConnected) input.value = String(initial); // Restore after validation failure.
    };
  };
  original.lods.forEach((lod, i) => {
    const select = document.getElementById(
      'lod-model-' + i,
    ) as HTMLSelectElement;
    document.querySelector<HTMLButtonElement>(
      '[data-import-lod="' + i + '"]',
    )!.onclick = () => importAsset(i);
    select.onchange = () =>
      commit((detail) => {
        detail.lods[i].model = select.value;
      });
    bindNumber('lod-distance-' + i, lod.distance, (detail, value) => {
      detail.lods[i].distance = value;
    });
    bindNumber('lod-density-' + i, lod.density * 100, (detail, value) => {
      detail.lods[i].density = value / 100;
    });
    document.querySelector<HTMLButtonElement>(
      '[data-remove-lod="' + i + '"]',
    )!.onclick = () =>
      commit((detail) => {
        detail.lods.splice(i, 1);
      });
  });
  document.getElementById('add-lod')!.onclick = () =>
    commit((detail) => {
      if (detail.lods.length >= 3) return;
      if (
        !detail.lods.length &&
        !detail.cullDistance &&
        model.lodFadeDuration === undefined
      )
        detail.lodFadeDuration = 0.25;
      const previous = detail.lods.at(-1);
      const distance = (previous?.distance ?? 0) + 50;
      detail.lods.push({
        model: previous?.model ?? model.model,
        distance,
        density: previous?.density ?? 1,
      });
      if (detail.cullDistance > 0 && detail.cullDistance <= distance)
        detail.cullDistance = distance + 50;
    });
  bindNumber(
    'foliage-cull-distance',
    original.cullDistance,
    (detail, value) => {
      detail.cullDistance = value;
    },
  );
  bindNumber(
    'foliage-lod-hysteresis',
    original.lodHysteresis * 100,
    (detail, value) => {
      detail.lodHysteresis = value / 100;
    },
  );
  bindNumber('foliage-lod-fade', original.lodFadeDuration, (detail, value) => {
    detail.lodFadeDuration = value;
  });
}
