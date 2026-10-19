import type { OrmRequest, OrmResponse, OrmSlot } from './orm-worker';
import { createOrmWorker, ormWorkerError } from './orm-client';
import type { PNGChannel } from '../core/heightmap-png';
import { textureAccept, textureFormats } from './texture-formats';
import { checkTextureFile } from './texture-file';

interface OrmPanelCallbacks {
  apply: (
    png: ArrayBuffer,
    useMapValues: { roughness: boolean; metalness: boolean },
  ) => Promise<boolean>;
  close: () => void;
}
export function showOrmPanel(resolution: number, callbacks: OrmPanelCallbacks) {
  const dialog = document.createElement('dialog');
  dialog.id = 'orm-dialog';
  dialog.className = 'orm-panel';
  dialog.setAttribute('aria-labelledby', 'orm-title');
  const slots: [OrmSlot, string][] = [
    ['occlusion', 'Occlusion'],
    ['roughness', 'Roughness / gloss'],
    ['metalness', 'Metalness'],
  ];
  dialog.innerHTML =
    '<span class="eyebrow">SURFACE MAPS</span><h1 id="orm-title">Build an ORM map</h1>' +
    '<p class="field-note">Combine separate ' +
    textureFormats +
    ' maps. Choose the source channel for each map; grayscale files work with any RGB channel. Up to 16 megapixels (4096²) and 256 MiB per source file. Original PNG/TIFF 16-bit samples stay numeric until final 8-bit packing. First TIFF image only.</p>' +
    '<form id="orm-form"><fieldset>' +
    slots
      .map(
        ([slot, label]) =>
          '<section class="orm-source"><label class="field"><span>' +
          label +
          '</span><input id="orm-' +
          slot +
          '" type="file" accept="' +
          textureAccept +
          '"/></label><label class="field"><span>Read channel</span><select id="orm-channel-' +
          slot +
          '"><option value="red">Red / grayscale</option><option value="green">Green</option><option value="blue">Blue</option><option value="alpha">Alpha</option><option value="luminance">RGB luminance</option></select></label><button type="button" data-orm-clear="' +
          slot +
          '" class="text-button">Clear</button></section>',
      )
      .join('') +
    '<label class="orm-check"><input id="orm-gloss" type="checkbox"/> Roughness source is gloss / smoothness (invert)</label>' +
    '<label class="orm-check"><input id="orm-full-strength" type="checkbox" checked/> Use supplied roughness and metalness maps at full strength</label>' +
    '<p class="field-note">Empty channels are white: no occlusion, with roughness and metalness controlled by their sliders. Full strength sets a slider to 1 only when its map is supplied. Output: ' +
    resolution +
    ' × ' +
    resolution +
    '.</p>' +
    '<button id="orm-preview" class="full-button" type="submit">Build preview</button></fieldset></form>' +
    '<div class="orm-previews">' +
    slots
      .map(
        ([slot, label]) =>
          '<figure><canvas width="128" height="128" data-orm-preview="' +
          slot +
          '" aria-label="' +
          label +
          ' output preview"></canvas><figcaption>' +
          label +
          '</figcaption></figure>',
      )
      .join('') +
    '</div>' +
    '<p id="orm-status" class="field-note" role="status" aria-live="polite">No changes applied.</p>' +
    '<div class="button-row"><button id="orm-cancel">Cancel</button><button id="orm-apply" class="primary" disabled>Apply map</button></div>';
  document.body.append(dialog);
  const query = <T extends HTMLElement = HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const form = query<HTMLFormElement>('form'),
    fieldset = query<HTMLFieldSetElement>('fieldset');
  const calculate = query<HTMLButtonElement>('#orm-preview'),
    apply = query<HTMLButtonElement>('#orm-apply'),
    status = query('#orm-status');
  let worker: Worker | undefined,
    result: ArrayBuffer | undefined,
    closed = false,
    epoch = 0;
  const stop = () => {
    worker?.terminate();
    worker = undefined;
  };
  const invalidate = () => {
    epoch++;
    stop();
    result = undefined;
    apply.disabled = true;
    calculate.disabled = false;
    calculate.textContent = 'Build preview';
    status.textContent =
      'Settings changed. Build a new preview before applying.';
    dialog
      .querySelectorAll<HTMLCanvasElement>('canvas')
      .forEach((canvas) => canvas.getContext('2d')!.clearRect(0, 0, 128, 128));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    epoch++;
    stop();
    dialog.close();
    dialog.remove();
    callbacks.close();
  };
  query('#orm-cancel').onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  form.onchange = invalidate;
  dialog
    .querySelectorAll<HTMLButtonElement>('[data-orm-clear]')
    .forEach((button) => {
      button.onclick = () => {
        query<HTMLInputElement>('#orm-' + button.dataset.ormClear).value = '';
        invalidate();
      };
    });
  form.onsubmit = async (event) => {
    event.preventDefault();
    invalidate();
    const token = epoch;
    calculate.disabled = true;
    calculate.textContent = 'Building…';
    status.textContent = 'Reading channel files…';
    try {
      const sources: OrmRequest['sources'] = {},
        transfer: ArrayBuffer[] = [];
      for (const [slot] of slots) {
        const file = query<HTMLInputElement>('#orm-' + slot).files?.[0];
        if (!file) continue;
        await checkTextureFile(file);
        if (closed || token !== epoch) return;
        const png = await file.arrayBuffer();
        if (closed || token !== epoch) return;
        sources[slot] = {
          png,
          name: file.name,
          mime: file.type,
          channel: query<HTMLSelectElement>('#orm-channel-' + slot)
            .value as PNGChannel,
        };
        transfer.push(png);
      }
      if (!transfer.length)
        throw new Error('Choose at least one channel image.');
      const current = (worker = createOrmWorker());
      const failed = (message: string) => {
        stop();
        result = undefined;
        apply.disabled = true;
        calculate.disabled = false;
        calculate.textContent = 'Build preview';
        status.textContent = message;
      };
      current.onmessage = (event: MessageEvent<OrmResponse>) => {
        if (closed || token !== epoch || worker !== current) return;
        const data = event.data;
        if (data.type === 'progress') {
          status.textContent = data.message;
          return;
        }
        if (data.type === 'error') {
          failed(data.message);
          return;
        }
        result = data.png;
        slots.forEach(([slot], channel) => {
          const context = query<HTMLCanvasElement>(
            '[data-orm-preview="' + slot + '"]',
          ).getContext('2d')!;
          const image = context.createImageData(128, 128);
          for (let i = 0; i < 128 * 128; i++) {
            const value = data.preview[i * 4 + channel];
            image.data.set([value, value, value, 255], i * 4);
          }
          context.putImageData(image, 0, 0);
        });
        stop();
        calculate.disabled = false;
        calculate.textContent = 'Rebuild preview';
        apply.disabled = false;
        status.textContent =
          'Preview ready. Terrain is unchanged until Apply map.';
      };
      current.onerror = (event) => {
        event.preventDefault();
        if (worker === current) failed(ormWorkerError(event.message));
      };
      current.postMessage(
        {
          resolution,
          sources,
          gloss: query<HTMLInputElement>('#orm-gloss').checked,
        } satisfies OrmRequest,
        transfer,
      );
    } catch (error) {
      if (closed || token !== epoch) return;
      stop();
      calculate.disabled = false;
      calculate.textContent = 'Build preview';
      status.textContent = String(error);
    }
  };
  apply.onclick = async () => {
    if (!result) return;
    fieldset.disabled = true;
    apply.disabled = true;
    status.textContent = 'Preparing surface material…';
    const normalize = query<HTMLInputElement>('#orm-full-strength').checked;
    try {
      if (
        await callbacks.apply(result, {
          roughness:
            normalize &&
            !!query<HTMLInputElement>('#orm-roughness').files?.length,
          metalness:
            normalize &&
            !!query<HTMLInputElement>('#orm-metalness').files?.length,
        })
      )
        close();
      else if (!closed)
        status.textContent = 'Preparation cancelled. No map applied.';
    } catch (error) {
      if (!closed) status.textContent = 'Could not apply map: ' + String(error);
    } finally {
      if (!closed) {
        fieldset.disabled = false;
        apply.disabled = !result;
      }
    }
  };
  dialog.showModal();
  return { close };
}
