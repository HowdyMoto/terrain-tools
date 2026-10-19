import { WATER_PRESETS, waterPreset } from '../core/water';
import type { WaterSettings, WaterSurface, WaterPreset } from '../core/water';
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const field = (
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step = 0.1,
) =>
  `<label class="field"><span>${label}</span><input id="${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}"/></label>`;
const toggle = (id: string, label: string, value: boolean) =>
  `<label class="toggle-field"><span>${label}</span><input id="${id}" type="checkbox" ${value ? 'checked' : ''}/><span class="switch"></span></label>`;
const section = (id: string, title: string, html: string) =>
  `<section class="control-section" id="${id}"><h3>${title}</h3>${html}</section>`;
const controls: [keyof WaterSurface, string, number, number, number][] = [
  ['visibility', 'Visibility distance (m)', 0.05, 200, 0.1],
  ['roughness', 'Surface roughness', 0.02, 1, 0.01],
  ['swellHeight', 'Swell height (m)', 0, 10, 0.05],
  ['swellLength', 'Swell length (m)', 2, 500, 1],
  ['waveHeight', 'Wave height (m)', 0, 3, 0.01],
  ['waveLength', 'Wave length (m)', 0.5, 50, 0.1],
  ['direction', 'Direction (°)', -360, 360, 1],
  ['speed', 'Animation speed', 0, 3, 0.05],
  ['ripple', 'Fine ripples', 0, 1, 0.01],
  ['foam', 'Shore foam amount', 0, 1, 0.05],
  ['foamWidth', 'Foam width (m)', 0.05, 20, 0.1],
  ['wetness', 'Wet ground strength', 0, 1, 0.05],
  ['wetBand', 'Wet bank height (m)', 0.05, 3, 0.05],
  ['caustics', 'Caustic light', 0, 1, 0.05],
];
const slider = (
  s: WaterSurface,
  [key, label, min, max, step]: (typeof controls)[number],
) =>
  `<label class="range-field"><span>${label}<output id="out-water-${key}">${s[key]}</output></span><input id="water-${key}" data-water-surface="${key}" type="range" value="${s[key]}" min="${min}" max="${max}" step="${step}"/></label>`;
export function waterControls(
  w: WaterSettings,
  selected: string,
  placement: string | null,
  points: number,
) {
  const body = w.bodies.find((b) => b.id === selected),
    s = body?.surface ?? w.ocean.surface;
  const shape = body?.extent;
  return (
    '<div class="inspector-heading"><span class="eyebrow">ENVIRONMENT</span><h1>Water</h1><p>Shape oceans, lakes and clear shallow pools.</p></div>' +
    `<div id="water-context"><label class="field"><span>Selected water</span><select id="water-body"><option value="ocean">Ocean</option>${w.bodies.map((b) => `<option value="${escape(b.id)}" ${b.id === selected ? 'selected' : ''}>${escape(b.name)}</option>`).join('')}</select></label>` +
    toggle(
      body ? 'water-body-enabled' : 'water',
      body ? 'Show this body' : 'Show ocean',
      body?.enabled ?? w.ocean.enabled,
    ) +
    field(
      body ? 'water-elevation' : 'water-sea-level',
      'Water height (m)',
      body?.elevation ?? w.seaLevel,
      -10000,
      10000,
    ) +
    `<p class="field-note">${body ? 'Height from world zero, independent of ocean sea level.' : 'Ocean sea level, measured from world zero. Raise it above the ground to flood the terrain.'}</p></div>` +
    section(
      'water-shape',
      'Water bodies',
      (body
        ? `<label class="field"><span>Name</span><input id="water-name" value="${escape(body.name)}" maxlength="120"/></label>`
        : '') +
        (shape?.kind === 'ellipse'
          ? field('water-x', 'Center X (m)', shape.x, -10000, 10000) +
            field('water-z', 'Center Z (m)', shape.z, -10000, 10000) +
            field(
              'water-radius-x',
              'Radius X (m)',
              shape.radiusX,
              0.25,
              10000,
            ) +
            field(
              'water-radius-z',
              'Radius Z (m)',
              shape.radiusZ,
              0.25,
              10000,
            ) +
            field(
              'water-rotation',
              'Rotation (°)',
              shape.rotation,
              -360,
              360,
              1,
            )
          : '') +
        (shape?.kind === 'polygon'
          ? `<details><summary>Outline coordinates (X, Z metres)</summary><label class="field"><textarea id="water-outline" rows="6">${shape.points.map((p) => `${p.x.toFixed(2)}, ${p.z.toFixed(2)}`).join('\n')}</textarea></label></details>`
          : '') +
        (placement
          ? `<p class="field-note" role="status">${placement === 'polygon' ? `Click banks to draw an outline · ${points} points. Enter finishes.` : 'Click terrain to place ' + (placement === 'basin' ? 'a connected basin.' : 'a pond.')} Esc cancels.</p><div class="button-row">${placement === 'polygon' ? '<button id="water-finish" class="full-button">Finish outline</button>' : ''}<button id="water-cancel" class="full-button">Cancel</button></div>`
          : '<div class="button-row"><button id="water-add-ellipse" class="full-button">Place pond</button><button id="water-add-basin" class="full-button">Fill basin</button></div><button id="water-add-polygon" class="full-button">Draw lake outline</button>') +
        (body
          ? '<div class="button-row"><button id="water-duplicate" class="full-button">Duplicate</button><button id="water-delete" class="full-button">Delete body</button></div>'
          : '') +
        '<p class="field-note">Bodies have independent elevations. Water reveals existing depressions; sculpt a basin if the ground is too high.</p>',
    ) +
    section(
      'water-appearance',
      'Appearance',
      `<label class="field"><span>Water preset</span><select id="water-preset"><option value="">Choose a preset…</option>${Object.entries(
        WATER_PRESETS,
      )
        .map(([key, label]) => `<option value="${key}">${label}</option>`)
        .join(
          '',
        )}</select></label><label class="color-field"><span>Water color</span><input id="water-color" type="color" value="${s.color}"/></label>` +
        controls
          .slice(0, 2)
          .map((c) => slider(s, c))
          .join('') +
        toggle('water-reflections', 'Reflect nearby scenery', w.reflections) +
        '<p class="field-note">Visibility controls how far you can see through the water. Reflections fall back to the sky outside the screen.</p>',
    ) +
    section(
      'water-waves',
      'Waves & swells',
      controls
        .slice(2, 9)
        .map((c) => slider(s, c))
        .join('') +
        toggle('water-wind', 'Follow world wind direction', s.windLinked),
    ) +
    section(
      'water-shore',
      'Shore & shallow water',
      controls
        .slice(9)
        .map((c) => slider(s, c))
        .join('') +
        '<p class="field-note">Wet ground darkens below water and fades above its level by the bank height. Caustics add moving light to sunlit shallows, fading with depth and water visibility. Set each strength to zero to disable it.</p>',
    )
  );
}
export function bindWaterControls(
  w: WaterSettings,
  selected: string,
  edit: (change: (w: WaterSettings) => void) => Promise<boolean>,
  select: (id: string) => void,
  placement: (kind: 'ellipse' | 'basin' | 'polygon' | null) => void,
  finish: () => void,
) {
  const input = (id: string) =>
    document.getElementById(id) as HTMLInputElement | null;
  const on = (id: string, fn: () => void) => {
    const el = input(id);
    if (el) el.onchange = fn;
  };
  const click = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  const surface = (w: WaterSettings) =>
    w.bodies.find((b) => b.id === selected)?.surface ?? w.ocean.surface;
  on('water-body', () => select(input('water-body')!.value));
  on('water-sea-level', () =>
    edit((w) => {
      w.seaLevel = input('water-sea-level')!.valueAsNumber;
    }),
  );
  on('water', () =>
    edit((w) => {
      w.ocean.enabled = input('water')!.checked;
    }),
  );
  on('water-reflections', () =>
    edit((w) => {
      w.reflections = input('water-reflections')!.checked;
    }),
  );
  on('water-preset', () => {
    const preset = input('water-preset')!.value as WaterPreset;
    if (preset in WATER_PRESETS)
      edit((w) => Object.assign(surface(w), waterPreset(preset)));
  });
  on('water-color', () =>
    edit((w) => {
      surface(w).color = input('water-color')!.value;
    }),
  );
  on('water-wind', () =>
    edit((w) => {
      surface(w).windLinked = input('water-wind')!.checked;
    }),
  );
  for (const [key] of controls) {
    const el = input('water-' + key)!;
    el.oninput = () => {
      document.getElementById('out-water-' + key)!.textContent = el.value;
    };
    el.onchange = () =>
      edit((w) => {
        (surface(w) as unknown as Record<string, unknown>)[key] =
          el.valueAsNumber;
      });
  }
  for (const kind of ['ellipse', 'basin', 'polygon'] as const)
    click('water-add-' + kind, () => placement(kind));
  click('water-cancel', () => placement(null));
  click('water-finish', finish);
  const body = w.bodies.find((b) => b.id === selected);
  if (!body) return;
  on('water-name', () =>
    edit((w) => {
      w.bodies.find((b) => b.id === selected)!.name =
        input('water-name')!.value;
    }),
  );
  on('water-body-enabled', () =>
    edit((w) => {
      w.bodies.find((b) => b.id === selected)!.enabled =
        input('water-body-enabled')!.checked;
    }),
  );
  on('water-elevation', () =>
    edit((w) => {
      w.bodies.find((b) => b.id === selected)!.elevation =
        input('water-elevation')!.valueAsNumber;
    }),
  );
  for (const [id, key] of [
    ['x', 'x'],
    ['z', 'z'],
    ['radius-x', 'radiusX'],
    ['radius-z', 'radiusZ'],
    ['rotation', 'rotation'],
  ] as const)
    on('water-' + id, () =>
      edit((w) => {
        const e = w.bodies.find((b) => b.id === selected)!.extent;
        if (e.kind === 'ellipse') e[key] = input('water-' + id)!.valueAsNumber;
      }),
    );
  on('water-outline', () =>
    edit((w) => {
      const b = w.bodies.find((b) => b.id === selected)!;
      b.extent = {
        kind: 'polygon',
        points: input('water-outline')!
          .value.trim()
          .split('\n')
          .map((line) => {
            const [x, z] = line.split(',').map(Number);
            return { x, z };
          }),
      };
    }),
  );
  click('water-delete', () =>
    edit((w) => {
      w.bodies = w.bodies.filter((b) => b.id !== selected);
    }),
  );
  click('water-duplicate', async () => {
    const id = crypto.randomUUID();
    const applied = await edit((w) => {
      const copy = structuredClone(w.bodies.find((b) => b.id === selected)!);
      copy.id = id;
      copy.name += ' copy';
      w.bodies.push(copy);
    });
    if (applied) select(id);
  });
}
