import {
  defaultTimeOfDay,
  formatSolarTime,
  solarPosition,
} from '../core/daylight';
import type { TimeOfDaySettings } from '../core/daylight';
import type { EnvironmentSettings } from '../core/environment';

export function daylightControls(settings: EnvironmentSettings) {
  const cycle = settings.timeOfDay ?? defaultTimeOfDay();
  const field = (
    key: keyof TimeOfDaySettings,
    label: string,
    min: number,
    max: number,
    step: number,
  ) =>
    `<label class="field"><span>${label}</span><input id="daylight-${key}" data-daylight="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${cycle[key]}" required/></label>`;
  return `<section class="control-section daylight-controls"><h3>Time of day</h3>
    <label class="toggle-field"><span>Dynamic sun & sky</span><input id="daylight-enabled" type="checkbox" ${cycle.enabled ? 'checked' : ''}/><span class="switch"></span></label>
    ${
      cycle.enabled
        ? `
      <label class="field"><span>Solar time</span><input id="daylight-time" aria-label="Solar time" type="time" step="60" value="${formatSolarTime(cycle.hour)}" required/></label>
      <input id="daylight-hour" class="daylight-scrubber" aria-label="Time of day" type="range" min="0" max="23.99" step="0.01" value="${cycle.hour}"/>
      <p id="daylight-status" class="field-note" aria-live="off"></p>
      <div class="button-row daylight-times"><button data-solar-hour="6">06:00</button><button data-solar-hour="12">Noon</button><button data-solar-hour="18">18:00</button><button data-solar-hour="0">Night</button></div>
      <button id="daylight-play" class="full-button" aria-pressed="${cycle.playing}">${cycle.playing ? 'Pause at current time' : 'Play day / night cycle'}</button>
      ${field('dayLengthMinutes', 'Full day lasts (minutes)', 0.25, 1440, 0.25)}
      <p class="field-note">Pause saves the time shown. Playback leaves undo and autosave alone. Solar noon is 12:00; seasons and latitude change sunrise and sunset.</p>
      <details><summary>Sun path & atmosphere</summary>
      ${field('latitude', 'Latitude (° north / south)', -90, 90, 0.1)}
      <label class="field"><span>Season</span><select id="daylight-season"><option value="custom">Custom day</option><option value="80">March equinox</option><option value="172">June solstice</option><option value="266">September equinox</option><option value="355">December solstice</option></select></label>
      ${field('dayOfYear', 'Day of year', 1, 365, 1)}
      ${field('northOffset', 'North rotation (° from +Z)', 0, 360, 1)}
      ${field('haze', 'Atmospheric haze', 2, 20, 0.1)}
      ${field('rayleigh', 'Blue-sky scattering', 1, 4, 0.1)}
      ${field('nightBrightness', 'Night sky brightness', 0, 1, 0.01)}
      <label class="toggle-field"><span>Match fog to sky</span><input id="daylight-autoFog" data-daylight="autoFog" type="checkbox" ${cycle.autoFog ? 'checked' : ''}/><span class="switch"></span></label>
      <p class="field-note">North is +Z and east is +X before rotation. Higher haze softens the sky and warms low sunlight. Night brightness adds sky fill, without a moon light. Switch off Dynamic sun & sky to return to manual lighting.</p>
      </details>`
        : '<p class="field-note">Animate sunlight, shadows, atmospheric scattering and sky reflections. Your imported HDR/EXR image stays available for fixed lighting.</p>'
    }
    </section>`;
}

export function updateDaylightReadout(
  settings: EnvironmentSettings | undefined,
  hour: number,
  error?: string,
) {
  if (!settings?.timeOfDay?.enabled) return;
  const status = document.querySelector<HTMLElement>('#daylight-status');
  if (!status) return;
  const state = solarPosition(settings.timeOfDay, hour);
  status.textContent =
    error ??
    `Sun elevation ${state.elevation.toFixed(1)}° · azimuth ${state.azimuth.toFixed(1)}°`;
  const time = document.querySelector<HTMLInputElement>('#daylight-time')!;
  const range = document.querySelector<HTMLInputElement>('#daylight-hour')!;
  if (document.activeElement !== time && document.activeElement !== range) {
    time.value = formatSolarTime(hour);
    range.value = String(hour);
  }
}

export function bindDaylightControls(
  get: () => EnvironmentSettings,
  apply: (settings: EnvironmentSettings, preserveTime?: boolean) => void,
  getHour: () => number,
) {
  const current = () => get().timeOfDay ?? defaultTimeOfDay();
  const change = (patch: Partial<TimeOfDaySettings>, preserveTime = true) =>
    apply({ ...get(), timeOfDay: { ...current(), ...patch } }, preserveTime);
  document.querySelector<HTMLInputElement>('#daylight-enabled')!.onchange = (
    event,
  ) => {
    const enabled = (event.target as HTMLInputElement).checked,
      previous = get();
    apply({
      ...previous,
      ...(enabled ? { mode: 'sky' as const } : {}),
      ...(!previous.timeOfDay && enabled
        ? {
            sunColor: '#ffffff',
            ambientIntensity: Math.min(previous.ambientIntensity, 0.2),
          }
        : {}),
      timeOfDay: { ...current(), enabled, playing: false },
    });
  };
  if (!current().enabled) return;
  document.querySelector<HTMLButtonElement>('#daylight-play')!.onclick = () =>
    change({ playing: !current().playing });
  const time = document.querySelector<HTMLInputElement>('#daylight-time')!;
  const range = document.querySelector<HTMLInputElement>('#daylight-hour')!;
  time.onchange = () => {
    if (!time.reportValidity()) return;
    const [hours, minutes] = time.value.split(':').map(Number);
    change({ hour: hours + minutes / 60, playing: false }, false);
  };
  range.oninput = () => {
    time.value = formatSolarTime(Number(range.value));
  };
  range.onchange = () =>
    change({ hour: Number(range.value), playing: false }, false);
  document
    .querySelectorAll<HTMLButtonElement>('[data-solar-hour]')
    .forEach((button) => {
      button.onclick = () =>
        change(
          { hour: Number(button.dataset.solarHour), playing: false },
          false,
        );
    });
  const season = document.querySelector<HTMLSelectElement>('#daylight-season')!;
  season.value = ['80', '172', '266', '355'].includes(
    String(current().dayOfYear),
  )
    ? String(current().dayOfYear)
    : 'custom';
  season.onchange = () => {
    if (season.value !== 'custom') change({ dayOfYear: Number(season.value) });
  };
  document
    .querySelectorAll<HTMLInputElement>('[data-daylight]')
    .forEach((input) => {
      input.onchange = () => {
        if (input.reportValidity())
          change({
            [input.dataset.daylight!]:
              input.type === 'checkbox' ? input.checked : Number(input.value),
          });
      };
    });
  updateDaylightReadout(get(), getHour());
}
