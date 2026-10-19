import {
  defaultEnvironmentSettings,
  environmentPreset,
  parseEnvironmentSettings,
} from '../core/environment';
import type {
  EnvironmentSettings,
  EnvironmentPreset,
} from '../core/environment';
import { daylightControls, bindDaylightControls } from './daylight-controls';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const ranges: [keyof EnvironmentSettings, string, number, number, number][] = [
  ['sunAzimuth', 'Sun azimuth (°)', 0, 360, 0.5],
  ['sunElevation', 'Sun elevation (°)', 2, 90, 0.25],
  ['sunIntensity', 'Sun intensity', 0, 20, 0.1],
  ['exposure', 'Exposure', 0.05, 8, 0.05],
  ['environmentIntensity', 'Sky / HDRI intensity', 0, 10, 0.05],
  ['ambientIntensity', 'Ambient fill', 0, 10, 0.05],
  ['rotation', 'HDRI rotation (°)', -180, 180, 1],
  ['backgroundBlur', 'Background blur', 0, 1, 0.05],
  ['backgroundIntensity', 'Sky background brightness', 0, 10, 0.05],
];
const colors: [keyof EnvironmentSettings, string][] = [
  ['sunColor', 'Sun color'],
  ['skyColor', 'Sky / ambient color'],
  ['horizonColor', 'Horizon color'],
  ['groundColor', 'Ground bounce color'],
  ['backgroundColor', 'Solid background'],
  ['fogColor', 'Fog color'],
];
const numeric: [keyof EnvironmentSettings, string, number, number, number][] = [
  ['fogNear', 'Fog start (m)', 0, 100000, 1],
  ['fogFar', 'Fog end (m)', 0.01, 200000, 0.01],
  ['shadowBias', 'Shadow depth bias', -0.01, 0.01, 0.0001],
  ['shadowNormalBias', 'Shadow normal bias (m)', 0, 5, 0.01],
  ['shadowPadding', 'Shadow height padding (m)', 0, 1000, 1],
];
const toggles: [keyof EnvironmentSettings, string][] = [
  ['showBackground', 'Show sky / HDRI background'],
  ['fogEnabled', 'Enable distance fog'],
  ['shadows', 'Sun shadows'],
  ['temporalAA', 'Stable foliage edges (temporal)'],
];
export function environmentControls(settings = defaultEnvironmentSettings()) {
  const range = ([key, label, min, max, step]: (typeof ranges)[number]) =>
    '<label class="range-field"><span>' +
    label +
    '<output id="out-env-' +
    key +
    '">' +
    (settings[key] ??
      (key === 'temporalSharpness' ? 0.25 : settings.environmentIntensity)) +
    '</output></span><input data-env="' +
    key +
    '" id="env-' +
    key +
    '" type="range" min="' +
    min +
    '" max="' +
    max +
    '" step="' +
    step +
    '" value="' +
    (settings[key] ??
      (key === 'temporalSharpness' ? 0.25 : settings.environmentIntensity)) +
    '"/></label>';
  const toggle = ([key, label]: (typeof toggles)[number]) =>
    '<label class="toggle-field"><span>' +
    label +
    '</span><input data-env="' +
    key +
    '" id="env-' +
    key +
    '" type="checkbox" ' +
    (settings[key] ? 'checked' : '') +
    '/><span class="switch"></span></label>';
  return (
    daylightControls(settings) +
    '<section class="control-section environment-controls"><h3>Lighting & atmosphere</h3>' +
    '<label class="field"><span>Lighting preset</span><select id="environment-preset"><option value="custom">Custom / current</option><option value="natural">Natural sunlight · fine shadows</option><option value="daylight">Daylight</option><option value="golden">Golden hour</option><option value="overcast">Overcast</option><option value="studio">Neutral studio</option></select></label>' +
    ranges
      .slice(settings.timeOfDay?.enabled ? 2 : 0, 4)
      .map(range)
      .join('') +
    '<label class="field"><span>Display transform</span><select data-env="toneMapping" id="env-toneMapping"><option value="aces" ' +
    (settings.toneMapping === 'aces' ? 'selected' : '') +
    '>ACES filmic</option><option value="neutral" ' +
    (settings.toneMapping === 'neutral' ? 'selected' : '') +
    '>Neutral</option><option value="agx" ' +
    (settings.toneMapping === 'agx' ? 'selected' : '') +
    '>AgX</option></select></label>' +
    '<label class="field"><span>Environment illumination</span><select data-env="mode" id="env-mode"><option value="none">Ambient fill only</option><option value="sky">Procedural sky</option>' +
    (settings.image ? '<option value="image">Imported HDRI</option>' : '') +
    '</select></label>' +
    '<button id="import-environment" class="full-button">Import HDR / EXR environment</button>' +
    (settings.image
      ? '<p class="field-note">' +
        escape(settings.image.name) +
        '</p><button id="remove-environment" class="text-button">Remove environment image</button>'
      : '') +
    '<p class="field-note">Radiance .hdr or OpenEXR .exr, 2:1 equirectangular, up to 4096 × 2048 and 32 MB. Lighting is embedded with the project.</p>' +
    ranges
      .slice(4)
      .filter(
        ([key]) =>
          !settings.timeOfDay?.enabled ||
          !['rotation', 'backgroundBlur'].includes(key),
      )
      .map(range)
      .join('') +
    toggles.map(toggle).join('') +
    (settings.temporalAA
      ? range(['temporalSharpness', 'Foliage detail recovery', 0, 1, 0.05])
      : '') +
    '<p class="field-note">Temporal stabilization reduces fine-leaf shimmer. Detail recovery restores local contrast in leaves and bark; 0 keeps the softer resolve. Fast wind can still soften moving leaves.</p>' +
    '<details><summary>Colors, fog & shadows</summary>' +
    colors
      .filter(
        ([key]) =>
          !settings.timeOfDay?.enabled ||
          ![
            'skyColor',
            'horizonColor',
            ...(settings.timeOfDay.autoFog ? ['fogColor'] : []),
          ].includes(key),
      )
      .map(
        ([key, label]) =>
          '<label class="color-field"><span>' +
          label +
          '</span><input type="color" data-env="' +
          key +
          '" id="env-' +
          key +
          '" value="' +
          settings[key] +
          '"/></label>',
      )
      .join('') +
    numeric
      .map(
        ([key, label, min, max, step]) =>
          '<label class="field"><span>' +
          label +
          '</span><input type="number" data-env="' +
          key +
          '" id="env-' +
          key +
          '" min="' +
          min +
          '" max="' +
          max +
          '" step="' +
          step +
          '" value="' +
          settings[key] +
          '" required/></label>',
      )
      .join('') +
    '<label class="field"><span>Shadow map</span><select id="env-shadowResolution" data-env="shadowResolution">' +
    [1024, 2048, 4096]
      .map(
        (value) =>
          '<option value="' +
          value +
          '" ' +
          (value === settings.shadowResolution ? 'selected' : '') +
          '>' +
          value +
          ' × ' +
          value +
          '</option>',
      )
      .join('') +
    '</select></label>' +
    '<label class="field"><span>Shadow coverage</span><select id="env-shadowCascades" data-env="shadowCascades"><option value="1" ' +
    ((settings.shadowCascades ?? 1) === 1 ? 'selected' : '') +
    '>Whole terrain · one map</option><option value="3" ' +
    (settings.shadowCascades === 3 ? 'selected' : '') +
    '>Camera detail · three cascades</option></select></label>' +
    (settings.shadowCascades === 3
      ? '<label class="field"><span>Shadow distance (m)</span><input type="number" id="env-shadowDistance" data-env="shadowDistance" min="10" max="2000" step="1" value="' +
        (settings.shadowDistance ?? 160) +
        '" required/></label><p class="field-note">Three maps follow the camera, keeping nearby leaves sharp. Shorter reach improves detail; shadows fade at the far limit. Each cascade uses the selected map size. 2048 is a good starting point; 4096 uses four times the shadow memory.</p>'
      : '') +
    '<p class="field-note">HDRI rotation affects reflections and the background. Align the directional sun separately for cast shadows. Natural sunlight aligns the atmospheric sky and enables camera cascades. Low normal bias preserves small leaf shadows; increase it only to hide self-shadow artifacts. Height padding includes tall assets.</p></details>' +
    '<details><summary>Contact shading</summary><label class="toggle-field"><span>Indirect ambient occlusion</span><input type="checkbox" id="env-ao-enabled" data-ao="enabled" ' +
    (settings.ambientOcclusion?.enabled ? 'checked' : '') +
    '/><span class="switch"></span></label>' +
    '<label class="field"><span>Occlusion radius (m)</span><input type="number" id="env-ao-radius" data-ao="radius" min="0.1" max="10" step="0.1" value="' +
    (settings.ambientOcclusion?.radius ?? 2.5) +
    '" required/></label>' +
    '<label class="field"><span>Occlusion strength</span><input type="number" id="env-ao-strength" data-ao="strength" min="0" max="3" step="0.05" value="' +
    (settings.ambientOcclusion?.strength ?? 1.25) +
    '" required/></label>' +
    '<p class="field-note">Adds depth around roots, rocks and overlapping plants by reducing indirect light. Direct sunlight and leaf transmission keep their brightness. Uses visible surfaces, including moving leaf cutouts; off-screen canopy and bounced light require more advanced illumination. Costs one depth pass plus screen-space filtering.</p></details></section>'
  );
}
export function bindEnvironmentControls(
  get: () => EnvironmentSettings | undefined,
  change: (value: EnvironmentSettings) => Promise<void>,
  importFile: () => void,
  error: (message: string) => void,
  currentHour?: () => number,
) {
  const settings = () => get() ?? defaultEnvironmentSettings();
  const apply = (value: EnvironmentSettings, preserveTime = true) => {
    if (
      preserveTime &&
      settings().timeOfDay?.enabled &&
      value.timeOfDay?.enabled &&
      currentHour
    )
      value = {
        ...value,
        timeOfDay: { ...value.timeOfDay, hour: currentHour() },
      };
    void Promise.resolve()
      .then(() => change(parseEnvironmentSettings(value)))
      .catch((e) => error(String(e)));
  };
  bindDaylightControls(
    settings,
    apply,
    () => currentHour?.() ?? settings().timeOfDay?.hour ?? 12,
  );
  const mode = document.querySelector<HTMLSelectElement>('#env-mode')!;
  mode.value = settings().mode;
  document.querySelector<HTMLSelectElement>('#environment-preset')!.onchange = (
    event,
  ) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== 'custom')
      apply({
        ...environmentPreset(value as EnvironmentPreset),
        ...(settings().image ? { image: settings().image } : {}),
      });
  };
  document.querySelector<HTMLButtonElement>('#import-environment')!.onclick =
    importFile;
  const remove = document.querySelector<HTMLButtonElement>(
    '#remove-environment',
  );
  if (remove)
    remove.onclick = () =>
      apply({
        ...settings(),
        image: undefined,
        mode: settings().mode === 'image' ? 'sky' : settings().mode,
      });
  document.querySelectorAll<HTMLInputElement>('[data-ao]').forEach((input) => {
    input.onchange = () => {
      if (!input.reportValidity()) return;
      apply({
        ...settings(),
        ambientOcclusion: {
          enabled: false,
          radius: 2.5,
          strength: 1.25,
          ...settings().ambientOcclusion,
          [input.dataset.ao!]:
            input.type === 'checkbox' ? input.checked : Number(input.value),
        },
      });
    };
  });
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-env]')
    .forEach((input) => {
      if (input instanceof HTMLInputElement && input.type === 'range')
        input.oninput = () => {
          document.querySelector('#out-env-' + input.dataset.env)!.textContent =
            input.value;
        };
      input.onchange = () => {
        if (!input.reportValidity()) return;
        const key = input.dataset.env!;
        const value =
          input instanceof HTMLInputElement && input.type === 'checkbox'
            ? input.checked
            : ['mode', 'toneMapping'].includes(key) ||
                (input instanceof HTMLInputElement && input.type === 'color')
              ? input.value
              : Number(input.value);
        apply({
          ...settings(),
          [key]: value,
          ...(key === 'mode' && value !== 'sky' && settings().timeOfDay
            ? {
                timeOfDay: {
                  ...settings().timeOfDay!,
                  enabled: false,
                  playing: false,
                },
              }
            : {}),
        });
      };
    });
}
