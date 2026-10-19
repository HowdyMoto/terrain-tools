import type { PropCutout, PropInstance } from '../core/types';
import { validatePropCutout } from '../core/props';
const field = (id: string, label: string, value: number, dimension = true) =>
  '<label class="field"><span>' +
  label +
  '</span><input id="' +
  id +
  '" type="number" step="any" min="' +
  (dimension ? 0.01 : -10000) +
  '" max="' +
  (dimension ? 20000 : 10000) +
  '" value="' +
  Number(value.toFixed(4)) +
  '"/></label>';
export function propCutoutControls(prop: PropInstance) {
  const c = prop.cutout;
  return (
    '<label class="field"><span>Cutout shape</span><select id="cutout-shape"><option value="circle" ' +
    (!c ? 'selected' : '') +
    '>Circle</option><option value="rectangle" ' +
    (c ? 'selected' : '') +
    '>Rectangle</option></select></label>' +
    (c
      ? '<div class="prop-field-grid">' +
        field('cutout-width', 'Width (m)', c.width) +
        field('cutout-depth', 'Depth (m)', c.depth) +
        field('cutout-offset-x', 'Local offset X', c.offsetX, false) +
        field('cutout-offset-z', 'Local offset Z', c.offsetZ, false) +
        '</div>'
      : '') +
    '<button id="fit-prop-cutout" class="full-button">Fit model bounds</button><p class="field-note">Footprints use local metres and follow the prop’s scale and rotation. Model bounds include off-centre mesh origins. Hole edges follow terrain cells.</p>'
  );
}
export function bindPropCutoutControls(
  prop: PropInstance,
  apply: (value: PropCutout | undefined) => void,
  fit: () => PropCutout,
  error: (message: string) => void,
) {
  const shape = document.querySelector<HTMLSelectElement>('#cutout-shape')!;
  shape.onchange = () =>
    apply(
      shape.value === 'circle'
        ? undefined
        : {
            shape: 'rectangle',
            width: Math.max(0.01, prop.holeRadius * 2),
            depth: Math.max(0.01, prop.holeRadius * 2),
            offsetX: 0,
            offsetZ: 0,
          },
    );
  for (const [id, key] of [
    ['cutout-width', 'width'],
    ['cutout-depth', 'depth'],
    ['cutout-offset-x', 'offsetX'],
    ['cutout-offset-z', 'offsetZ'],
  ] as const) {
    const input = document.querySelector<HTMLInputElement>('#' + id);
    if (!input || !prop.cutout) continue;
    input.onchange = () => {
      const value = { ...prop.cutout!, [key]: Number(input.value) };
      try {
        if (!input.value.trim()) throw new Error('Enter a cutout value.');
        validatePropCutout(value);
        apply(value);
      } catch (e) {
        input.value = String(prop.cutout![key]);
        error(String(e));
      }
    };
  }
  document.querySelector<HTMLButtonElement>('#fit-prop-cutout')!.onclick =
    () => {
      try {
        apply(fit());
      } catch (e) {
        error(String(e));
      }
    };
}
export function placementFootprintControls(
  mode: string,
  width: number,
  depth: number,
) {
  return (
    '<label class="field"><span>Placement cutout</span><select id="prop-footprint"><option value="circle" ' +
    (mode === 'circle' ? 'selected' : '') +
    '>Circle</option><option value="rectangle" ' +
    (mode === 'rectangle' ? 'selected' : '') +
    '>Rectangle</option><option value="model" ' +
    (mode === 'model' ? 'selected' : '') +
    '>Model bounds</option></select></label>' +
    (mode === 'rectangle'
      ? '<div class="prop-field-grid">' +
        field('prop-width', 'Width (m)', width) +
        field('prop-depth', 'Depth (m)', depth) +
        '</div>'
      : '')
  );
}
