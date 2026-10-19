import { defaultErosionSettings, parseErosionSettings } from '../core/erosion';
import type { ErosionSettings, ErosionResult } from '../core/erosion';
import type { TerrainProject } from '../core/types';
import { effectiveHoles } from '../core/terrain';
import type { ErosionRequest, ErosionResponse } from './erosion-worker';

interface ErosionPanelCallbacks {
  preview: (project: TerrainProject) => void;
  apply: (result: ErosionResult, settings: ErosionSettings) => void;
  close: () => void;
}
/** Owns one disposable worker and an isolated preview; closing never applies data. */
export function showErosionPanel(
  source: TerrainProject,
  callbacks: ErosionPanelCallbacks,
) {
  const dialog = document.createElement('dialog');
  dialog.id = 'erosion-dialog';
  dialog.className = 'erosion-panel';
  dialog.setAttribute('aria-labelledby', 'erosion-title');
  const start = source.erosion ?? {
    ...defaultErosionSettings(),
    seed: Math.round(source.seed),
  };
  const numeric = (
    key: Exclude<keyof ErosionSettings, 'mode'>,
    label: string,
    min: number,
    max: number,
    step: number,
  ) =>
    '<label class="field"><span>' +
    label +
    '</span><input name="' +
    key +
    '" type="number" min="' +
    min +
    '" max="' +
    max +
    '" step="' +
    step +
    '" value="' +
    start[key] +
    '" required/></label>';
  dialog.innerHTML =
    '<div class="erosion-heading"><span class="eyebrow">LANDSCAPE PROCESS</span><button id="erosion-close" class="icon-button" aria-label="Close erosion preview">×</button></div>' +
    '<h1 id="erosion-title">Weather landscape</h1><p class="field-note">Preview channels and settled slopes. Orbit or zoom to inspect; apply when ready.</p>' +
    '<form id="erosion-form"><fieldset><label class="field"><span>Process</span><select name="mode"><option value="both">Rainfall + thermal settling</option><option value="hydraulic">Hydraulic channels</option><option value="thermal">Thermal slopes</option></select></label>' +
    '<div class="erosion-fields">' +
    numeric('seed', 'Rainfall seed', -2147483648, 2147483647, 1) +
    numeric('rainfall', 'Droplets / cell', 0, 8, 0.1) +
    numeric('radius', 'Channel radius (cells)', 1, 6, 1) +
    numeric('maxDepth', 'Hydraulic depth limit (m)', 0, 10000, 0.1) +
    numeric('thermalIterations', 'Thermal passes', 0, 200, 1) +
    numeric('talus', 'Stable slope (°)', 0, 80, 1) +
    '</div>' +
    '<details><summary>Flow & settling controls</summary><div class="erosion-fields">' +
    numeric('erosion', 'Soil removal rate', 0, 1, 0.01) +
    numeric('deposition', 'Deposition rate', 0, 1, 0.01) +
    numeric('capacity', 'Sediment capacity', 0, 16, 0.1) +
    numeric('inertia', 'Flow inertia', 0, 0.95, 0.01) +
    numeric('evaporation', 'Evaporation / step', 0.005, 0.5, 0.005) +
    numeric('maxSteps', 'Droplet travel (steps)', 8, 128, 1) +
    numeric('thermalRate', 'Thermal transfer rate', 0, 1, 0.01) +
    '</div></details></fieldset>' +
    '<p class="field-note">Edges and cutout rims stay fixed. ' +
    (source.size / source.resolution).toFixed(2) +
    ' m per cell. Each preview starts from the current terrain.</p>' +
    '<button id="erosion-preview" class="full-button primary" type="submit">Calculate preview</button></form>' +
    '<div class="erosion-progress"><progress id="erosion-progress" max="1" value="0" aria-label="Erosion progress"></progress><p id="erosion-status" role="status" aria-live="polite">No changes applied.</p></div>' +
    '<div class="button-row erosion-compare"><button id="erosion-original" disabled aria-pressed="false">Original</button><button id="erosion-result" disabled aria-pressed="true">Result</button></div>' +
    '<div class="button-row"><button id="erosion-cancel">Cancel</button><button id="erosion-apply" class="primary" disabled>Apply erosion</button></div>';
  document.body.append(dialog);
  const query = <T extends HTMLElement = HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const form = query<HTMLFormElement>('form'),
    fieldset = query<HTMLFieldSetElement>('fieldset');
  query<HTMLSelectElement>('[name=mode]').value = start.mode;
  const status = query('#erosion-status'),
    progress = query<HTMLProgressElement>('progress');
  const calculate = query<HTMLButtonElement>('#erosion-preview'),
    apply = query<HTMLButtonElement>('#erosion-apply');
  const original = query<HTMLButtonElement>('#erosion-original'),
    resultButton = query<HTMLButtonElement>('#erosion-result');
  let worker: Worker | undefined,
    result: ErosionResult | undefined,
    settings = start,
    closed = false;
  const comparisonState = (after: boolean) => {
    original.setAttribute('aria-pressed', String(!after));
    resultButton.setAttribute('aria-pressed', String(after));
  };
  const compare = (after: boolean) => {
    try {
      callbacks.preview(
        after && result ? { ...source, heights: result.heights } : source,
      );
      comparisonState(after);
      if (after && result) {
        status.textContent =
          'Preview ready · maximum change ' +
          result.maxChange.toFixed(2) +
          ' m. Soil removed ' +
          result.erodedVolume.toFixed(1) +
          ' m³; deposited ' +
          result.depositedVolume.toFixed(1) +
          ' m³; drained ' +
          result.drainedVolume.toFixed(1) +
          ' m³.';
      } else if (result) {
        status.textContent =
          'Original terrain. Result and Apply use the calculated preview.';
      }
      return true;
    } catch (error) {
      comparisonState(false);
      status.textContent =
        'Could not display preview. The previous terrain was restored: ' +
        String(error);
      return false;
    }
  };
  const stop = () => {
    worker?.terminate();
    worker = undefined;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    dialog.close();
    dialog.remove();
    callbacks.close();
  };
  query('#erosion-close').onclick = close;
  query('#erosion-cancel').onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  original.onclick = () => compare(false);
  resultButton.onclick = () => compare(true);
  const resetResult = () => {
    if (result) compare(false);
    result = undefined;
    apply.disabled = original.disabled = resultButton.disabled = true;
    progress.value = 0;
    status.textContent = 'Settings changed. Calculate a new preview.';
  };
  form.addEventListener('input', resetResult);
  form.addEventListener('change', resetResult);
  const failure = (message: string) => {
    stop();
    fieldset.disabled = false;
    calculate.disabled = false;
    status.textContent = 'Preview failed: ' + message;
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (worker || !form.reportValidity()) return;
    resetResult();
    try {
      const raw: Record<string, unknown> = {};
      for (const [key, value] of new FormData(form))
        raw[key] = key === 'mode' ? value : Number(value);
      settings = parseErosionSettings(raw);
      worker = new Worker(new URL('./erosion-worker.ts', import.meta.url), {
        type: 'module',
      });
      fieldset.disabled = true;
      calculate.disabled = true;
      status.textContent = 'Calculating… You can orbit the terrain or cancel.';
      const current = worker;
      worker.onmessage = (event: MessageEvent<ErosionResponse>) => {
        if (closed || worker !== current) return;
        const message = event.data;
        if (message.type === 'progress') {
          progress.value =
            message.progress.completed / Math.max(1, message.progress.total);
          status.textContent =
            (message.progress.phase === 'hydraulic'
              ? 'Carving drainage channels'
              : 'Settling steep slopes') +
            ' · ' +
            Math.round(progress.value * 100) +
            '%';
        } else if (message.type === 'error') failure(message.message);
        else {
          result = message.result;
          stop();
          fieldset.disabled = false;
          calculate.disabled = false;
          progress.value = 1;
          apply.disabled = original.disabled = resultButton.disabled = false;
          if (!compare(true)) return;
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        failure(event.message || 'Worker could not start.');
      };
      worker.onmessageerror = () =>
        failure('Could not read the worker result.');
      const request: ErosionRequest = {
        input: {
          resolution: source.resolution,
          size: source.size,
          heights: source.heights,
          holes: effectiveHoles(source),
        },
        settings,
      };
      // Structured cloning preserves the original buffers for cancel, comparison and undo.
      worker.postMessage(request);
    } catch (error) {
      failure(error instanceof Error ? error.message : String(error));
    }
  };
  apply.onclick = () => {
    if (!result) return;
    try {
      callbacks.apply(result, settings);
    } catch (error) {
      comparisonState(false);
      status.textContent =
        'Could not apply. The previous terrain was restored: ' + String(error);
    }
  };
  dialog.show();
  query<HTMLButtonElement>('#erosion-preview').focus();
  return { close };
}
