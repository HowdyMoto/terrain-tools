import * as THREE from 'three';
import type { TerrainProject } from '../core/types';
import type { ProjectFolder } from './project-folder';
import { MODEL_SIZE_LABEL } from '../core/model-limits';
import {
  MAX_PROJECT_ASSET_BYTES,
  projectAssetBytes,
  assertProjectCapacity,
} from '../core/project-package';
import type { DecodedModel } from '../render/model-loader';
import { checkSignal } from '../render/resources';
import { ImportPreview } from './import-preview';
import {
  importDialog,
  bindFileDrop,
  escapeImportText as esc,
  fileSize,
} from './import-dialog';
import {
  bundleModel,
  modelDataURL,
  writeModelDocument,
  transformModel,
  ModelDependencyError,
} from './foliage-import';
import type {
  ModelDocument,
  FoliageImportOptions,
  ImportedPlant,
} from './foliage-import';

interface ReviewedModel {
  sourcePath?: string;
  name: string;
  document: ModelDocument;
  data: string;
  bytes: number;
  bounds: THREE.Box3;
  triangles: number;
  parts: number;
}
export function showFoliageImport(
  project: TerrainProject,
  targetBrush: number,
  targetModel: number,
  apply: (
    plants: ImportedPlant[],
    options: FoliageImportOptions,
    signal: AbortSignal,
  ) => Promise<boolean>,
  folder?: ProjectFolder,
) {
  const brush = project.brushes[targetBrush];
  const ui = importDialog(
    'Import foliage',
    'Preview your plants, check their size, then turn them into a paintable brush.',
    `
    <div class="import-body"><div class="import-inputs"><fieldset>
    <div class="import-drop" id="foliage-drop"><strong>Drop a model folder or GLB here</strong><span>GLB, or glTF + BIN + textures · up to ${MODEL_SIZE_LABEL} per prepared model</span><div><label class="file-picker">Choose files<input id="foliage-files" type="file" multiple accept=".glb,.gltf,.bin,.png,.jpg,.jpeg,.webp,.ktx2"/></label><label class="file-picker secondary">Choose model folder<input id="foliage-folder" type="file" multiple webkitdirectory/></label></div></div>
    <p class="field-note">Choose files together for a batch. Use Choose folder for glTF assets with nested texture folders. Models are imported as static meshes; source files stay untouched.</p>
    <div id="foliage-dependencies" class="import-review" hidden><p>A glTF needs its companion BIN and textures. Your selected model is kept here; add its missing files, or choose its complete folder.</p><button type="button" id="foliage-locate-folder" class="text-button">Locate model folder</button></div>
    <p class="field-note">${fileSize(MAX_PROJECT_ASSET_BYTES - projectAssetBytes(project))} available in this project's embedded asset budget. Large sources keep their original geometry and textures.</p>
    <div id="foliage-sources" class="import-sources"><p class="import-empty">Each model becomes a randomly selected variant. Select a row to inspect its geometry and materials.</p></div>
    <div class="import-settings"><label class="field"><span>Import into</span><select id="foliage-import-mode"><option value="new">New foliage brush</option><option value="add">Add variants to ${esc(brush.name)}</option><option value="replace">Replace selected model in ${esc(brush.name)}</option></select></label>
    <label class="field"><span>Brush name</span><input id="foliage-import-name" maxlength="120" value="Imported foliage"/></label>
    <label class="field"><span>Plant behavior</span><select id="foliage-import-profile"><option value="ground">Ground cover · flexible, follows slope</option><option value="tree">Tree / shrub · upright, stiff base</option><option value="rigid">Rocks / rigid objects · no wind</option></select></label>
    <label class="field"><span>Source units</span><select id="foliage-import-units"><option value="1">Metres (glTF standard)</option><option value="0.01">Centimetres → metres</option><option value="0.001">Millimetres → metres</option><option value="0.0254">Inches → metres</option><option value="0.3048">Feet → metres</option></select></label></div>
    <label class="import-check"><input id="foliage-import-ground" type="checkbox" checked/> Center horizontally and place pivot at ground level</label>
    <details class="import-advanced" open><summary>Allowed terrain surfaces</summary><div id="foliage-import-surfaces">${project.materials.map((m) => `<label class="import-check"><input type="checkbox" value="${esc(m.id)}" checked/> ${esc(m.name)}</label>`).join('')}</div><p class="field-note">For new brushes. Variants use their destination brush’s placement rules. Density and spacing start from the imported width; fine-tune them after painting a test patch.</p></details>
    <p id="foliage-import-impact" class="import-review">Creates a new brush. Existing brushes and plants stay in place.</p>
    </fieldset></div><aside class="import-inspection"><div id="foliage-preview" class="import-preview"><p>Model preview</p></div><p class="preview-caption">Neutral studio lighting · drag to orbit · scroll to zoom<br/>Preview shows the static rest pose.</p><div id="foliage-model-review" class="import-review">Size, geometry and embedded creator credits appear here.</div></aside></div>`,
  );
  const q = ui.query;
  const linkedFiles = new WeakMap<File, string>();
  if (folder) {
    const button = document.createElement('button');
    button.id = 'foliage-linked-files';
    button.type = 'button';
    button.className = 'primary full-button';
    button.textContent = 'Choose linked GLBs from project…';
    q('#foliage-drop').append(button);
    const note = document.createElement('p');
    note.className = 'field-note';
    note.textContent =
      'Linked GLBs refresh automatically after you export over their files. Choose files / model folder below imports embedded copies instead.';
    q('#foliage-drop').after(note);
    button.onclick = async () => {
      try {
        const chosen = await folder.chooseModels();
        if (ui.signal.aborted) return;
        for (const item of chosen) linkedFiles.set(item.file, item.path);
        await receive(chosen.map((item) => item.file));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          ui.status('Could not link files: ' + String(error), true);
      }
    };
  }
  let models: ReviewedModel[] = [],
    selected = 0,
    preview: ImportPreview | undefined,
    decoded: DecodedModel | undefined;
  let pendingFiles: File[] = [];
  let previewEpoch = 0,
    loading = false;
  const scale = () =>
    Number(q<HTMLSelectElement>('#foliage-import-units').value);
  const ground = () => q<HTMLInputElement>('#foliage-import-ground').checked;
  const update = () => {
    const mode = q<HTMLSelectElement>('#foliage-import-mode').value;
    q<HTMLInputElement>('#foliage-import-name').disabled = mode !== 'new';
    q<HTMLSelectElement>('#foliage-import-profile').disabled =
      mode === 'replace';
    q('.import-apply').textContent =
      mode === 'new'
        ? 'Create foliage brush'
        : mode === 'add'
          ? 'Add variants'
          : 'Replace model';
    q('#foliage-import-impact').textContent =
      mode === 'new'
        ? 'Creates a new brush. Existing brushes and plants stay in place.'
        : mode === 'add'
          ? 'Adds equally weighted variants for future strokes. Existing plants stay unchanged.'
          : 'Updates all plants using the selected model. Keeps its scale, tint and behavior settings; clears its old LODs. Undo restores them.';
    const invalid = mode === 'replace' && models.length !== 1;
    q<HTMLButtonElement>('.import-apply').disabled =
      loading || !models.length || invalid;
    if (invalid && models.length)
      ui.status(
        'Select one model for replacement, or choose New brush / Add variants for a batch.',
        true,
      );
    else if (models.length && !loading)
      ui.status(
        `${models.length} model${models.length === 1 ? '' : 's'} ready. Review size and destination before applying.`,
      );
    const model = models[selected];
    if (model) {
      const size = model.bounds
        .getSize(new THREE.Vector3())
        .multiplyScalar(scale());
      const format = (value: number) =>
        value.toLocaleString(undefined, { maximumFractionDigits: 3 });
      q('#foliage-model-review').textContent =
        `${model.name} · ${format(size.x)} × ${format(size.y)} × ${format(size.z)} m (width × height × depth). ${model.triangles.toLocaleString()} triangles · ${model.parts} mesh parts · ${fileSize(model.bytes)}. ${String(model.document.json.asset.copyright ?? 'No creator credit embedded in this source.')} ${model.triangles > 100000 ? 'Heavy geometry: add lower-detail models in Distance detail before dense painting.' : ''} ${size.y < 0.02 || size.y > 100 ? 'Unusual height: check Source units.' : ''}`;
      if (decoded) preview?.model(decoded, scale(), ground());
    }
  };
  const selectModel = async (index: number) => {
    const token = ++previewEpoch;
    selected = index;
    const model = models[index];
    if (!model) {
      decoded?.dispose();
      decoded = undefined;
      preview?.dispose();
      preview = undefined;
      return;
    }
    ui.status('Loading model preview…');
    try {
      preview ??= await ImportPreview.create(q('#foliage-preview'), ui.signal);
      const next = await preview.decodeModel(model.data, ui.signal);
      if (ui.signal.aborted || token !== previewEpoch) {
        next.dispose();
        return;
      }
      try {
        preview ??= await ImportPreview.create(
          q('#foliage-preview'),
          ui.signal,
        );
        preview.model(next, scale(), ground());
      } catch (error) {
        next.dispose();
        throw error;
      }
      decoded?.dispose();
      decoded = next;
      renderList();
      update();
    } catch (error) {
      if (!ui.signal.aborted && token === previewEpoch)
        ui.status('Could not show preview: ' + String(error), true);
    }
  };
  const renderList = () => {
    q('#foliage-sources').innerHTML = models
      .map(
        (model, i) =>
          `<div class="import-model-row ${i === selected ? 'selected' : ''}"><button data-inspect-model="${i}" aria-pressed="${i === selected}"><strong>${esc(model.name)}</strong><span>${model.triangles.toLocaleString()} triangles · ${fileSize(model.bytes)}</span></button><button data-remove-model="${i}" aria-label="Remove ${esc(model.name)}">×</button></div>`,
      )
      .join('');
    q('#foliage-sources')
      .querySelectorAll<HTMLButtonElement>('[data-inspect-model]')
      .forEach((button) => {
        button.onclick = () => {
          void selectModel(Number(button.dataset.inspectModel));
        };
      });
    q('#foliage-sources')
      .querySelectorAll<HTMLButtonElement>('[data-remove-model]')
      .forEach((button) => {
        button.onclick = () => {
          models.splice(Number(button.dataset.removeModel), 1);
          selected = Math.min(selected, Math.max(0, models.length - 1));
          renderList();
          update();
          void selectModel(selected);
        };
      });
  };
  const receive = async (files: File[]) => {
    if (!files.length || loading) return;
    if (
      !files.some((file) => /\.(glb|gltf)$/i.test(file.name)) &&
      pendingFiles.length
    )
      files = Array.from(
        new Map(
          [...pendingFiles, ...files].map((file) => [
            file.webkitRelativePath || file.name,
            file,
          ]),
        ).values(),
      );
    loading = true;
    ui.busy(true);
    q<HTMLButtonElement>('.import-apply').disabled = true;
    const roots = files.filter((f) => /\.(glb|gltf)$/i.test(f.name));
    const added: ReviewedModel[] = [];
    try {
      if (!roots.length)
        throw new Error(
          'No GLB or glTF models found. Choose the model together with its dependencies.',
        );
      if (roots.length + models.length > 32)
        throw new Error(
          'Choose up to 32 models per import. Use Choose files to select a smaller batch.',
        );
      if (files.reduce((sum, f) => sum + f.size, 0) > MAX_PROJECT_ASSET_BYTES)
        throw new Error(
          'Select a batch under 384 MiB. Split large folders into smaller imports.',
        );
      for (const file of roots) {
        ui.status(
          `Checking ${file.name} (${added.length + 1}/${roots.length})…`,
        );
        const document = await bundleModel(file, files, ui.signal);
        const buffer = writeModelDocument(document),
          data = modelDataURL(buffer);
        const candidate = { ...project, assets: { ...project.assets } };
        let temporaryId = 0;
        for (const model of [...models, ...added, { name: file.name, data }]) {
          while (Object.hasOwn(candidate.assets, `import-${temporaryId}`))
            temporaryId++;
          candidate.assets[`import-${temporaryId++}`] = {
            name: model.name,
            data: model.data,
          };
        }
        assertProjectCapacity(candidate);
        ui.status(
          `Decoding geometry and textures for ${file.name} (${added.length + 1}/${roots.length})…`,
        );
        preview ??= await ImportPreview.create(
          q('#foliage-preview'),
          ui.signal,
        );
        const parsed = await preview.decodeModel(data, ui.signal);
        try {
          checkSignal(ui.signal);
          const bounds = new THREE.Box3();
          let triangles = 0;
          parsed.parts.forEach((part) => {
            part.geometry.computeBoundingBox();
            bounds.union(
              part.geometry.boundingBox!.clone().applyMatrix4(part.matrix),
            );
            triangles +=
              (part.geometry.index?.count ??
                part.geometry.getAttribute('position').count) / 3;
          });
          if (
            bounds.isEmpty() ||
            ![...bounds.min.toArray(), ...bounds.max.toArray()].every(
              Number.isFinite,
            )
          )
            throw new Error(`${file.name} has invalid bounds.`);
          added.push({
            sourcePath: linkedFiles.get(file),
            name: file.name.replace(/\.(glb|gltf)$/i, ''),
            document,
            data,
            bytes: buffer.byteLength,
            bounds,
            triangles: Math.ceil(triangles),
            parts: parsed.parts.length,
          });
        } finally {
          parsed.dispose();
        }
      }
      if (!models.length)
        q<HTMLInputElement>('#foliage-import-name').value = added[0].name.slice(
          0,
          120,
        );
      models.push(...added);
      pendingFiles = [];
      q('#foliage-dependencies').hidden = true;
      renderList();
      loading = false;
      ui.busy(false);
      update();
      await selectModel(models.length - added.length);
    } catch (error) {
      if (!ui.signal.aborted) {
        const dependencyError = error instanceof ModelDependencyError;
        pendingFiles = dependencyError ? files : [];
        q('#foliage-dependencies').hidden = !dependencyError;
        loading = false;
        ui.busy(false);
        update();
        ui.status(
          'Could not add files: ' +
            String(error) +
            (dependencyError
              ? ' Add the missing files or use Locate model folder to retry.'
              : ''),
          true,
        );
      }
    }
  };
  bindFileDrop(
    q('#foliage-drop'),
    q('#foliage-files'),
    (files) => {
      void receive(files);
    },
    {
      signal: ui.signal,
      onError: (error) =>
        ui.status('Could not read model folder: ' + String(error), true),
    },
  );
  q('#foliage-locate-folder').onclick = () =>
    q<HTMLInputElement>('#foliage-folder').click();
  q<HTMLInputElement>('#foliage-folder').onchange = (e) => {
    const input = e.target as HTMLInputElement;
    void receive(Array.from(input.files ?? []));
    input.value = '';
  };
  q('fieldset').addEventListener('change', (e) => {
    if (!(e.target as HTMLElement).closest('#foliage-drop')) update();
  });
  q('.import-apply').onclick = async () => {
    ui.busy(true);
    loading = true;
    ui.status('Preparing foliage and scene resources…');
    try {
      const options: FoliageImportOptions = {
        mode: q<HTMLSelectElement>('#foliage-import-mode')
          .value as FoliageImportOptions['mode'],
        profile: q<HTMLSelectElement>('#foliage-import-profile')
          .value as FoliageImportOptions['profile'],
        name: q<HTMLInputElement>('#foliage-import-name').value,
        materials: Array.from(
          q('#foliage-import-surfaces').querySelectorAll<HTMLInputElement>(
            'input:checked',
          ),
          (el) => el.value,
        ),
        targetBrush,
        targetModel,
      };
      const plants: ImportedPlant[] = [];
      for (const model of models) {
        ui.status(
          `Preparing ${model.name} (${plants.length + 1}/${models.length})…`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        checkSignal(ui.signal);
        const center = model.bounds.getCenter(new THREE.Vector3());
        const offset: [number, number, number] = ground()
          ? [-center.x, -model.bounds.min.y, -center.z]
          : [0, 0, 0];
        const size = model.bounds.getSize(new THREE.Vector3());
        plants.push({
          ...(model.sourcePath
            ? { source: { path: model.sourcePath, scale: scale(), offset } }
            : {}),
          name: model.name,
          data: transformModel(model.document, scale(), offset),
          width: Math.max(size.x, size.z) * scale(),
        });
      }
      checkSignal(ui.signal);
      if (await apply(plants, options, ui.signal)) ui.close();
      else
        ui.status('Cancelled. Your previous brushes and plants are unchanged.');
    } catch (error) {
      ui.status('Could not apply: ' + String(error) + ' You can retry.', true);
    } finally {
      loading = false;
      if (!ui.signal.aborted) {
        ui.busy(false);
        q<HTMLButtonElement>('.import-apply').disabled = !models.length;
      }
    }
  };
  ui.cleanup.push(() => {
    previewEpoch++;
    preview?.dispose();
    decoded?.dispose();
    models = [];
  });
  return ui;
}
