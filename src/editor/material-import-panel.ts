import * as THREE from 'three';
import type { MaterialLayer } from '../core/types';
import type { PNGChannel } from '../core/heightmap-png';
import type { OrmRequest, OrmResponse, OrmSlot } from './orm-worker';
import {
  createOrmWorker,
  ormWorkerError,
  readTextureDataUrl,
} from './orm-client';
import {
  isTextureFile,
  needsTextureConversion,
  textureAccept,
  textureFormats,
} from './texture-formats';
import { readDataUrl } from './storage';
import { ImportPreview } from './import-preview';
import {
  importDialog,
  bindFileDrop,
  escapeImportText as esc,
  fileSize,
} from './import-dialog';
import {
  detectMap,
  mapRoles,
  mapLabels,
  mapAssignmentError,
  materialName,
  materialPresets,
  materialChannels,
  defaultMapChannel,
  isSmoothnessRole,
  conversionSummary,
} from './material-import';
import type { MapRole, MaterialPreset } from './material-import';
import { checkTextureFile } from './texture-file';
import { MAX_TEXTURE_FILE_BYTES } from '../core/texture-limits';

interface Source {
  file: File;
  url: string;
  role: MapRole;
  channel: PNGChannel;
  manualRole: boolean;
  manualChannel: boolean;
  ready: Promise<void>;
  error?: Error;
}
export interface SurfaceImport {
  layer: MaterialLayer;
  resolution: 256 | 512 | 1024 | 2048;
}
export function showMaterialImport(
  layer: MaterialLayer,
  resolution: number,
  apply: (result: SurfaceImport, signal: AbortSignal) => Promise<boolean>,
) {
  const ui = importDialog(
    'Import a terrain material',
    `Replace the surface of “${layer.name}”. Painted coverage and placement rules stay in place.`,
    `
    <div class="import-body"><div class="import-inputs"><fieldset>
    <label class="field"><span>Made for / source format</span><select id="import-engine">${Object.entries(
      materialPresets,
    )
      .map(
        ([value, preset]) =>
          `<option value="${value}">${esc(preset.label)}</option>`,
      )
      .join('')}</select></label>
    <p id="import-engine-note" class="field-note">${materialPresets.auto.description}</p>
    <div class="import-drop" id="material-drop"><strong>Drop a texture set here</strong><span>${textureFormats} · up to 16 megapixels (4096²)</span><label class="file-picker">Choose maps<input id="material-files" type="file" accept="${textureAccept}" multiple/></label></div>
    <p class="field-note">Up to 256 MiB per source file; 384 MiB of embedded assets per project. TIFF/TGA thumbnails appear after Preview and maps become PNG. TIFF uses the first image.</p>
    <p id="material-file-notice" class="import-file-notice" role="status" hidden></p>
    <div id="material-sources" class="import-sources"><p class="import-empty">Choose all the maps for one material together. Common filenames are assigned automatically; you can change every assignment.</p></div>
    <div class="import-settings"><label class="field"><span>Material name</span><input id="import-material-name" maxlength="120" value="${esc(layer.name)}"/></label>
    <label class="field"><span>Texture covers (metres)</span><input id="import-material-scale" type="number" min="0.5" max="40" step="0.5" value="${layer.tileSize}"/></label>
    <label class="field"><span>Normal convention</span><select id="import-normal"><option value="opengl">OpenGL (+Y)</option><option value="directx">DirectX (−Y)</option></select></label>
    <label class="field"><span>Project texture resolution</span><select id="import-resolution"><option value="256">256² · 5 MiB</option><option value="512">512² · 21 MiB</option><option value="1024">1024² · 85 MiB</option><option value="2048">2048² · 341 MiB</option></select></label></div>
    <details class="import-advanced"><summary>Channel & replacement options</summary>
    <label class="import-check"><input id="import-gloss" type="checkbox"/> Roughness source is gloss / smoothness (invert)</label>
    <label class="import-check"><input id="import-white" type="checkbox" checked/> Use original base color (white layer tint)</label>
    <label class="import-check"><input id="import-replace" type="checkbox" checked/> Replace all maps; omitted slots use procedural defaults</label>
    <p class="field-note">Use extracted texture images. Engine project files, shader graphs and specular workflows are not converted. Unity packed smoothness maps require PNG, TIFF or TGA with alpha. Normal filename suffixes GL/DX override the preset; manual choices remain editable. Changing the preset updates automatic roles and channels, keeping your manual assignments.</p>
    <p class="field-note">Uncheck replacement to keep existing maps in unassigned slots. Supplied roughness and metalness channels use full strength. Height changes blending, not geometry. Resolution affects all four terrain layers.</p></details>
    <button id="preview-material" class="full-button" disabled>Preview material</button></fieldset></div>
    <aside class="import-inspection"><div class="import-preview" id="material-preview"><p>Material preview</p></div><p class="preview-caption">Neutral studio lighting · drag to orbit · scroll to zoom<br/>Sphere + 4 m ground sample. Terrain uses triplanar blending.</p><div id="material-review" class="import-review">Review map assignments, then preview.</div></aside></div>`,
  );
  const q = ui.query;
  const previewButton = q<HTMLButtonElement>('#preview-material');
  previewButton.classList.remove('full-button');
  previewButton.dataset.importEdit = '';
  q('.import-footer > div').prepend(previewButton);
  q<HTMLSelectElement>('#import-resolution').value = String(resolution);
  q<HTMLSelectElement>('#import-normal').value =
    layer.normalConvention ?? 'opengl';
  q('.import-apply').textContent = 'Apply material';
  let sources: Source[] = [],
    epoch = 0,
    worker: Worker | undefined;
  let result: SurfaceImport | undefined, preview: ImportPreview | undefined;
  let resources: { dispose(): void }[] = [];
  const preset = () =>
    q<HTMLSelectElement>('#import-engine').value as MaterialPreset;
  let normalEdited = false,
    glossEdited = false;
  const updateHints = () => {
    const normals = sources.filter((s) => s.role === 'normal');
    if (!normalEdited) {
      q<HTMLSelectElement>('#import-normal').value =
        normals.length === 1
          ? detectMap(normals[0].file.name, preset()).directX
            ? 'directx'
            : 'opengl'
          : materialPresets[preset()].normal;
    }
    const roughness = sources.filter((s) => materialChannels(s).roughness);
    if (!glossEdited) {
      q<HTMLInputElement>('#import-gloss').checked =
        roughness.length === 1 &&
        (isSmoothnessRole(roughness[0].role) ||
          (roughness[0].role === 'roughness' &&
            detectMap(roughness[0].file.name, preset()).gloss));
    }
  };
  const release = () => {
    resources.forEach((r) => r.dispose());
    resources = [];
  };
  const invalidate = () => {
    epoch++;
    worker?.terminate();
    worker = undefined;
    result = undefined;
    q<HTMLButtonElement>('.import-apply').disabled = true;
    const error = mapAssignmentError(sources.map((s) => s.role));
    q<HTMLButtonElement>('#preview-material').disabled = !!error;
    ui.status(
      error || 'Ready to preview. Changes are not applied yet.',
      !!error && sources.length > 0,
    );
    q('#material-review').textContent = 'Preview needs updating after changes.';
  };
  const renderSources = () => {
    q('#material-sources').innerHTML = sources
      .map(
        (source, i) =>
          `<div class="import-source">${source.url ? `<img src="${esc(source.url)}" alt=""/>` : `<span class="import-source-format" title="Preview to decode">${esc(source.file.name.split('.').pop()?.toUpperCase() ?? '…')}</span>`}<div class="import-source-name"><strong title="${esc(source.file.name)}">${esc(source.file.name)}</strong><span>${fileSize(source.file.size)}</span><select data-map-role="${i}" aria-label="Map role for ${esc(source.file.name)}">${mapRoles.map((role) => `<option value="${role}" ${role === source.role ? 'selected' : ''}>${mapLabels[role]}</option>`).join('')}</select><small data-map-conversion="${i}">${esc(conversionSummary(source, q<HTMLInputElement>('#import-gloss').checked))}</small></div><label class="import-channel" ${['occlusion', 'roughness', 'metalness'].includes(source.role) ? '' : 'hidden'}>Read channel<select data-map-channel="${i}" aria-label="Channel for ${esc(source.file.name)}">${['red', 'green', 'blue', 'alpha', 'luminance'].map((c) => `<option ${c === source.channel ? 'selected' : ''}>${c}</option>`).join('')}</select></label><button data-remove-map="${i}" aria-label="Remove ${esc(source.file.name)}">×</button></div>`,
      )
      .join('');
    q('#material-sources')
      .querySelectorAll<HTMLSelectElement>('[data-map-role]')
      .forEach((el) => {
        el.onchange = () => {
          const source = sources[Number(el.dataset.mapRole)];
          source.role = el.value as MapRole;
          source.manualRole = true;
          if (!source.manualChannel)
            source.channel = defaultMapChannel(source.role, preset());
          updateHints();
          renderSources();
          invalidate();
        };
      });
    q('#material-sources')
      .querySelectorAll<HTMLSelectElement>('[data-map-channel]')
      .forEach((el) => {
        el.onchange = () => {
          sources[Number(el.dataset.mapChannel)].channel =
            el.value as PNGChannel;
          sources[Number(el.dataset.mapChannel)].manualChannel = true;
          renderSources();
          invalidate();
        };
      });
    q('#material-sources')
      .querySelectorAll<HTMLButtonElement>('[data-remove-map]')
      .forEach((el) => {
        el.onclick = () => {
          URL.revokeObjectURL(
            sources.splice(Number(el.dataset.removeMap), 1)[0].url,
          );
          updateHints();
          renderSources();
          invalidate();
        };
      });
  };
  q('#import-engine').onchange = () => {
    normalEdited = glossEdited = false;
    for (const source of sources) {
      if (!source.manualRole)
        source.role = detectMap(source.file.name, preset()).role;
      if (!source.manualChannel)
        source.channel = defaultMapChannel(source.role, preset());
    }
    q('#import-engine-note').textContent =
      materialPresets[preset()].description;
    updateHints();
    renderSources();
  };
  q('#import-normal').onchange = () => {
    normalEdited = true;
  };
  q('#import-gloss').onchange = () => {
    glossEdited = true;
    renderSources();
  };
  bindFileDrop(q('#material-drop'), q('#material-files'), (files) => {
    if (!files.length) return;
    const rejected: string[] = [];
    for (const file of files) {
      if (
        !isTextureFile(file.name) ||
        file.size > MAX_TEXTURE_FILE_BYTES ||
        sources.length >= 24
      ) {
        rejected.push(file.name);
        continue;
      }
      if (
        sources.some(
          (s) =>
            s.file.name === file.name &&
            s.file.size === file.size &&
            s.file.lastModified === file.lastModified,
        )
      )
        continue;
      const hint = detectMap(file.name, preset());
      if (!sources.length)
        q<HTMLInputElement>('#import-material-name').value = materialName(
          file.name,
        );
      const source: Source = {
        file,
        url: '',
        role: hint.role,
        channel: hint.channel,
        manualRole: false,
        manualChannel: false,
        ready: Promise.resolve(),
      };
      sources.push(source);
      source.ready = checkTextureFile(file, ui.signal)
        .then(() => {
          if (ui.signal.aborted || !sources.includes(source)) return;
          if (!needsTextureConversion(file.name)) {
            source.url = URL.createObjectURL(file);
            renderSources();
          }
        })
        .catch((error: unknown) => {
          source.error =
            error instanceof Error ? error : new Error(String(error));
          if (!ui.signal.aborted && sources.includes(source))
            ui.status(source.error.message, true);
        });
    }
    updateHints();
    renderSources();
    invalidate();
    if (rejected.length) {
      const notice = q('#material-file-notice');
      notice.hidden = false;
      notice.textContent = `Not added: ${rejected.join(', ')}. Use up to 24 PNG/JPG/WebP/TIFF/TGA images, each at most 256 MiB and 16 megapixels.${rejected.some((name) => /\.psd$/i.test(name)) ? ' Export Photoshop PSD maps as PNG before importing them.' : ''}`;
      ui.status(notice.textContent, true);
    }
  });
  q('fieldset').addEventListener('change', (e) => {
    if (!(e.target as HTMLElement).closest('#material-sources, #material-drop'))
      invalidate();
  });
  q('fieldset').addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'file')
      invalidate();
  });
  const pack = (request: OrmRequest) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const current = (worker = createOrmWorker());
      const abort = () => {
        current.terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      ui.signal.addEventListener('abort', abort, { once: true });
      const done = () => {
        ui.signal.removeEventListener('abort', abort);
        current.terminate();
        if (worker === current) worker = undefined;
      };
      current.onmessage = ({ data }: MessageEvent<OrmResponse>) => {
        if (data.type === 'progress') ui.status(data.message);
        else {
          done();
          if (data.type === 'error') reject(new Error(data.message));
          else resolve(data.png);
        }
      };
      current.onerror = (e) => {
        e.preventDefault();
        done();
        reject(new Error(ormWorkerError(e.message)));
      };
      current.postMessage(request, [
        ...new Set(Object.values(request.sources).map((source) => source!.png)),
      ]);
    });
  q('#preview-material').onclick = async () => {
    invalidate();
    const token = epoch,
      local: { dispose(): void }[] = [];
    const current = () => {
      if (ui.signal.aborted || token !== epoch)
        throw new DOMException('Cancelled', 'AbortError');
    };
    ui.busy(true);
    ui.status('Reading maps and preparing the preview…');
    try {
      const size = Number(q<HTMLInputElement>('#import-material-scale').value);
      if (!Number.isFinite(size) || size < 0.5 || size > 40)
        throw new Error('Texture coverage must be between 0.5 and 40 metres.');
      const error = mapAssignmentError(sources.map((s) => s.role));
      if (error) throw new Error(error);
      const next = structuredClone(layer);
      next.name =
        q<HTMLInputElement>('#import-material-name').value.trim() || layer.name;
      next.tileSize = size;
      if (sources.some((source) => source.role === 'normal'))
        next.normalConvention = q<HTMLSelectElement>('#import-normal').value as
          'opengl' | 'directx';
      else if (q<HTMLInputElement>('#import-replace').checked)
        next.normalConvention = 'opengl';
      if (q<HTMLInputElement>('#import-replace').checked) next.textures = {};
      if (q<HTMLInputElement>('#import-white').checked) next.color = '#ffffff';
      const request: OrmRequest = {
        resolution: Number(q<HTMLSelectElement>('#import-resolution').value),
        sources: {},
        gloss: q<HTMLInputElement>('#import-gloss').checked,
      };
      for (const source of sources) {
        if (source.role === 'ignore') continue;
        await source.ready;
        current();
        if (source.error) throw source.error;
        const converted = needsTextureConversion(source.file.name);
        if (converted && !source.url) {
          ui.status('Converting ' + source.file.name + '…');
          const url = await readTextureDataUrl(source.file, ui.signal);
          current();
          source.url = url;
          renderSources();
        }
        const channels = Object.entries(materialChannels(source));
        if (channels.length) {
          const png = await source.file.arrayBuffer();
          for (const [slot, channel] of channels)
            request.sources[slot as OrmSlot] = {
              png,
              mime: source.file.type,
              name: source.file.name,
              channel,
              requireAlpha:
                isSmoothnessRole(source.role) && channel === 'alpha',
            };
        } else
          next.textures[source.role as keyof MaterialLayer['textures']] =
            converted ? source.url : await readDataUrl(source.file);
        current();
      }
      if (Object.keys(request.sources).length) {
        const png = await pack(request);
        current();
        next.textures.orm = await readDataUrl(
          new File([png], 'packed-orm.png', { type: 'image/png' }),
        );
      }
      const roles = sources.map((s) => s.role);
      if (request.sources.roughness) next.roughness = 1;
      if (request.sources.metalness) next.metalness = 1;
      const material = new THREE.MeshStandardMaterial({
        color: next.color,
        roughness: next.roughness,
        metalness: next.metalness,
        normalScale: new THREE.Vector2(
          next.normalStrength ?? 1,
          (next.normalStrength ?? 1) *
            (next.normalConvention === 'directx' ? -1 : 1),
        ),
      });
      local.push(material);
      const dimensions: string[] = [];
      for (const role of ['albedo', 'normal', 'orm', 'height'] as const) {
        const url = next.textures[role];
        if (!url) continue;
        const texture: THREE.Texture<HTMLImageElement | HTMLCanvasElement> =
          await new THREE.TextureLoader().loadAsync(url).catch(() => {
            throw new Error(
              `Could not decode the ${mapLabels[role].toLowerCase()} map. Remove it and choose a valid ${textureFormats} image.`,
            );
          });
        local.push(texture);
        current();
        const source = texture.image as HTMLImageElement;
        dimensions.push(
          `${mapLabels[role]} ${source.width} × ${source.height}${source.width !== source.height ? ' → square resample' : ''}`,
        );
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = request.resolution;
        canvas
          .getContext('2d')!
          .drawImage(source, 0, 0, canvas.width, canvas.height);
        texture.source.data = canvas;
        texture.needsUpdate = true;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        if (role === 'albedo') {
          texture.colorSpace = THREE.SRGBColorSpace;
          material.map = texture;
        }
        if (role === 'normal') material.normalMap = texture;
        if (role === 'orm')
          material.aoMap =
            material.roughnessMap =
            material.metalnessMap =
              texture;
      }
      current();
      preview ??= await ImportPreview.create(q('#material-preview'), ui.signal);
      current();
      preview.surface(material, 4 / size);
      release();
      resources = local.splice(0);
      result = {
        layer: next,
        resolution: request.resolution as SurfaceImport['resolution'],
      };
      q('#material-review').textContent =
        `${materialPresets[preset()].label} · ${roles.filter((r) => r !== 'ignore').length} source maps · ${request.resolution}² output · ${size} m repeat. ${dimensions.join(' · ')}. ${sources
          .map((source) => conversionSummary(source, request.gloss))
          .filter(Boolean)
          .join(
            '; ',
          )}. Missing maps use procedural defaults on terrain; this preview shows supplied maps only.`;
      ui.status('Preview ready. Apply replaces this layer in one undo step.');
    } catch (error) {
      if (!ui.signal.aborted)
        ui.status('Could not preview: ' + String(error), true);
    } finally {
      local.forEach((r) => r.dispose());
      if (!ui.signal.aborted) {
        ui.busy(false);
        q<HTMLButtonElement>('.import-apply').disabled = !result;
      }
    }
  };
  q('.import-apply').onclick = async () => {
    if (!result) return;
    ui.busy(true);
    ui.status('Preparing terrain material…');
    try {
      if (await apply(result, ui.signal)) ui.close();
      else ui.status('Cancelled. Your previous surface is unchanged.');
    } catch (error) {
      ui.status('Could not apply: ' + String(error) + ' You can retry.', true);
    } finally {
      if (!ui.signal.aborted) ui.busy(false);
    }
  };
  ui.cleanup.push(() => {
    epoch++;
    worker?.terminate();
    preview?.dispose();
    release();
    sources.forEach((s) => URL.revokeObjectURL(s.url));
    sources = [];
  });
  return ui;
}
