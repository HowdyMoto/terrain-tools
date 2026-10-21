import type { TerrainProject } from '../core/types';
import type { ModelSource } from '../core/model-source';
import {
  ProjectFolder,
  chooseProjectDirectory,
  folderAccessAvailable,
  projectFilename,
} from './project-folder';
import { escapeImportText as esc } from './import-dialog';
import type { ModelRevision } from './project-folder';

interface FolderCallbacks {
  project(): TerrainProject;
  ready(): boolean;
  revision(): number;
  apply(
    project:
      TerrainProject | ((signal: AbortSignal) => Promise<TerrainProject>),
    label: string,
    verify?: () => Promise<void>,
  ): Promise<boolean>;
  encode(project: TerrainProject, linked?: boolean): Promise<Blob>;
  portable(): Promise<void>;
  refresh(): void;
  notify(message: string, error?: boolean): void;
}

/** Artist-facing workspace, explicit saving and bounded background model refresh. */
export class FolderProjects {
  private readonly folders = new Map<string, ProjectFolder>();
  private busy = false;
  private saving = false;
  private selected = '';
  private lastError?: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly focus = () => {
    void this.reload(false);
  };
  constructor(private callbacks: FolderCallbacks) {
    this.timer = setInterval(() => {
      void this.reload(false);
    }, 2000);
    window.addEventListener('focus', this.focus);
  }
  dispose() {
    clearInterval(this.timer);
    window.removeEventListener('focus', this.focus);
  }
  disconnect() {
    // A file-only open has no filesystem binding. Keep prior handles for undo/redo.
    delete this.callbacks.project().folderId;
  }
  get folder() {
    const id = this.callbacks.project().folderId;
    return id ? this.folders.get(id) : undefined;
  }
  controls(project: TerrainProject) {
    const folder = this.folder;
    const available = folderAccessAvailable();
    const assets = Object.entries(project.assets);
    if (!project.assets[this.selected]) this.selected = assets[0]?.[0] ?? '';
    const source = project.assets[this.selected]?.source;
    return `<p class="field-note" id="project-file-location">Keep the main <strong>.terrain</strong> file in the project folder’s root. Folder projects link editable GLBs on disk; a portable copy embeds them for sharing.</p>
      <div class="button-row"><button id="folder-open" ${available ? '' : 'disabled'}>Open project folder…</button><button id="folder-create" ${available ? '' : 'disabled'}>Save as folder project…</button></div>
      <p class="field-note" id="project-save-location">${folder ? `Save project writes <strong>${esc(folder.root.name)}/${esc(folder.filename)}</strong>. Browser autosave also keeps a recovery copy.` : 'Choose a new folder to save this landscape with editable GLBs. For an existing project, open its folder. Without a folder, Save project downloads a portable file; it does not update an existing disk file.'}</p>
      <p class="field-note" id="project-folder-layout"><strong>prepared/</strong> — editable GLBs and ready-to-import art<br/><strong>sources/</strong> — original downloads<br/><strong>scenes/</strong> — alternate scenes and revisions<br/><strong>exports/</strong> — portable delivery files</p>
      <button id="folder-portable" class="full-button">Download portable project</button>
      ${project.folderId && !folder ? '<button id="folder-reconnect" class="primary full-button">Reconnect recovered project folder…</button><p class="field-note" id="folder-recovery-note">Reconnect to keep this recovered document and refresh its linked art. Open folder loads the saved disk document instead.</p>' : ''}
      ${folder && assets.some(([, model]) => !model.source) ? '<button id="folder-extract" class="full-button">Make embedded models editable</button><p class="field-note">Extract GLBs to prepared/models/ and link them. Then Save project to keep the links.</p>' : ''}
      ${!available ? '<p class="field-note">Folder linking needs desktop Chrome or Edge. Portable Open and Save remain available.</p>' : ''}
      ${
        folder
          ? `<label class="import-check"><input id="folder-watch" type="checkbox" ${folder.autoReload ? 'checked' : ''}/> Automatically refresh changed GLBs</label><button id="folder-reload" class="full-button">Reload linked assets now</button><p class="field-note" id="folder-status" role="status">${esc(folder.status)}</p>
      ${assets.length ? `<label class="field"><span>Model source</span><select id="folder-model">${assets.map(([id, model]) => `<option value="${esc(id)}" ${id === this.selected ? 'selected' : ''}>${esc(model.name)}</option>`).join('')}</select></label><p class="field-note" id="folder-source">${source ? esc(source.path) : 'Embedded model — choose a GLB source to iterate on disk.'}</p><div class="button-row"><button id="folder-link">Link / replace source…</button><button id="folder-unlink" ${source ? '' : 'disabled'}>Embed instead</button></div><p class="field-note">Replacements keep the asset ID, painted plants, LOD assignments, wind and prop placements. Keep the same exported pivot, units and material names. Import foliage can create linked brushes directly.</p>` : ''}`
          : ''
      }`;
  }
  bind() {
    const on = (id: string, action: () => Promise<unknown>) => {
      const el = document.getElementById(id);
      if (el)
        el.onclick = () => {
          void action().catch((error) => this.error(error));
        };
    };
    on('folder-open', () => this.open());
    on('folder-create', () => this.create());
    on('folder-reconnect', async () => {
      const root = await chooseProjectDirectory();
      const project = this.callbacks.project();
      const folder = new ProjectFolder(root, await projectFilename(root));
      await folder.reconnect(project);
      if (project !== this.callbacks.project())
        throw new Error('The document changed while reconnecting. Try again.');
      this.folders.set(project.folderId!, folder);
      this.callbacks.refresh();
      await this.reload(true);
      this.callbacks.notify(
        'Project folder reconnected. Recovered edits are preserved.',
      );
    });
    on('folder-portable', () => this.callbacks.portable());
    on('folder-reload', () => this.reload(true));
    on('folder-link', () => this.link());
    on('folder-extract', async () => {
      const folder = this.folder;
      if (!folder) return;
      const project = this.callbacks.project(),
        epoch = this.callbacks.revision();
      const candidate = await folder.externalize(project, true);
      if (
        project !== this.callbacks.project() ||
        epoch !== this.callbacks.revision()
      )
        throw new Error('The document changed during extraction. Try again.');
      if (await this.callbacks.apply(candidate, 'Linking editable models…'))
        this.callbacks.notify(
          'Models extracted to prepared/models. Save project to store the links.',
        );
    });
    on('folder-unlink', async () => {
      const project = this.callbacks.project();
      const model = project.assets[this.selected];
      if (!model || !this.folder) return;
      const embedded = { ...model };
      delete embedded.source;
      await this.callbacks.apply(
        {
          ...project,
          assets: { ...project.assets, [this.selected]: embedded },
        },
        'Embedding model…',
      );
    });
    const select = document.getElementById(
      'folder-model',
    ) as HTMLSelectElement | null;
    if (select)
      select.onchange = () => {
        this.selected = select.value;
        this.callbacks.refresh();
      };
    const watch = document.getElementById(
      'folder-watch',
    ) as HTMLInputElement | null;
    if (watch)
      watch.onchange = () => {
        if (this.folder) this.folder.autoReload = watch.checked;
      };
  }
  private error(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    const message = String(error);
    if (this.folder) this.folder.status = message;
    this.status();
    if (this.lastError !== message) this.callbacks.notify(message, true);
    this.lastError = message;
  }
  private status() {
    const el = document.getElementById('folder-status');
    if (el && this.folder) el.textContent = this.folder.status;
  }
  async open() {
    const root = await chooseProjectDirectory();
    const folder = new ProjectFolder(root, await projectFilename(root));
    let candidate: TerrainProject | undefined;
    if (
      await this.callbacks.apply(
        async (signal) => {
          candidate = await folder.open(signal);
          candidate.folderId ??= crypto.randomUUID();
          const previous = this.folders.get(candidate.folderId);
          if (previous && !(await previous.root.isSameEntry(root)))
            candidate.folderId = crypto.randomUUID();
          return candidate;
        },
        'Opening project folder…',
        () => folder.assertOpeningCurrent(candidate!),
      )
    ) {
      this.folders.set(candidate!.folderId!, folder);
      this.callbacks.refresh();
      this.callbacks.notify(
        'Project folder opened. Changed GLBs refresh automatically.',
      );
    }
  }
  async create() {
    const root = await chooseProjectDirectory();
    const source = this.callbacks.project(),
      revision = this.callbacks.revision();
    // Refuse existing project folders before writing model files.
    const entries = (
      root as FileSystemDirectoryHandle & {
        values(): AsyncIterableIterator<FileSystemHandle>;
      }
    ).values();
    for await (const entry of entries)
      if (entry.kind === 'file' && /\.terrain$/i.test(entry.name))
        throw new Error(
          'This folder already has a project. Open its folder, or choose a new folder for this landscape.',
        );
    const filename =
      (source.name.replace(/[^a-z0-9_-]/gi, '-') || 'Landscape') + '.terrain';
    const folder = new ProjectFolder(root, filename);
    const candidate = await folder.externalize(source);
    candidate.folderId = crypto.randomUUID();
    const blob = await this.callbacks.encode(candidate, true);
    if (
      source !== this.callbacks.project() ||
      revision !== this.callbacks.revision()
    )
      throw new Error(
        'The document changed during folder preparation. Try again.',
      );
    // Publish a valid new document before attaching the workspace; the old document stays intact on failure.
    await folder.save(blob);
    if (
      source !== this.callbacks.project() ||
      revision !== this.callbacks.revision()
    )
      throw new Error(
        'Folder project saved, but the open document changed. Open that folder to continue there.',
      );
    if (await this.callbacks.apply(candidate, 'Connecting project folder…')) {
      this.folders.set(candidate.folderId, folder);
      this.callbacks.refresh();
      this.callbacks.notify(
        'Folder project saved. Edit its prepared/models GLBs to update the scene.',
      );
    }
  }
  async save() {
    const folder = this.folder;
    if (!folder || this.saving)
      throw new Error('Project folder is unavailable or already saving.');
    this.saving = true;
    try {
      const project = this.callbacks.project(),
        epoch = this.callbacks.revision();
      const verify = await folder.verifySaveSources(project);
      if (
        project !== this.callbacks.project() ||
        epoch !== this.callbacks.revision() ||
        folder !== this.folder
      )
        throw new Error(
          'The document changed while preparing the save. Try again.',
        );
      const blob = await this.callbacks.encode(project, true);
      await folder.save(blob, verify);
      this.callbacks.notify('Project saved to its folder.');
    } finally {
      this.saving = false;
    }
  }
  private async link() {
    const folder = this.folder;
    if (!folder) return;
    const project = this.callbacks.project(),
      revision = this.callbacks.revision(),
      id = this.selected;
    const model = project.assets[id];
    const chosen = await folder.chooseModels(false);
    if (!chosen[0] || !model) return;
    const source: ModelSource = {
      ...(model.source ?? { scale: 1, offset: [0, 0, 0], prepared: true }),
      path: chosen[0].path,
    };
    const result = await folder.readModel(source);
    if (
      project !== this.callbacks.project() ||
      revision !== this.callbacks.revision()
    )
      throw new Error(
        'The document changed while choosing a source. Try again.',
      );
    const candidate = {
      ...project,
      assets: {
        ...project.assets,
        [id]: { ...model, data: result.data, source },
      },
    };
    if (
      await this.callbacks.apply(
        candidate,
        'Updating linked model…',
        async () => {
          const file = await (await folder.file(source.path)).getFile();
          if (`${file.lastModified}:${file.size}` !== result.stamp)
            throw new Error('Source changed during preparation. Try again.');
        },
      )
    )
      this.callbacks.notify(
        'Source linked. Future GLB changes refresh automatically.',
      );
  }
  async reload(force: boolean) {
    const folder = this.folder;
    if (
      !folder ||
      this.busy ||
      this.saving ||
      !this.callbacks.ready() ||
      (!force && (!folder.autoReload || document.hidden))
    )
      return;
    this.busy = true;
    const controller = new AbortController();
    let updated = 0;
    try {
      const paths = new Set(
        Object.values(this.callbacks.project().assets).flatMap((model) =>
          model.source ? [model.source.path] : [],
        ),
      );
      // Independent exports must not be held hostage by one broken GLB. Aliases of
      // a source still stage together, with one metadata observation per poll.
      for (const path of paths) {
        if (folder !== this.folder || !this.callbacks.ready()) break;
        let revision: ModelRevision | undefined;
        try {
          const project = this.callbacks.project(),
            epoch = this.callbacks.revision();
          revision = await folder.revisions(
            project,
            path,
            force,
            controller.signal,
          );
          if (!revision) continue;
          if (
            project !== this.callbacks.project() ||
            epoch !== this.callbacks.revision() ||
            folder !== this.folder ||
            !this.callbacks.ready()
          )
            break;
          if (!revision.count) {
            await revision.assertCurrent();
            revision.accept();
            continue;
          }
          folder.status = 'Preparing changed GLBs…';
          this.status();
          const applied = await this.callbacks.apply(
            revision.project,
            'Refreshing linked assets…',
            revision.assertCurrent,
          );
          if (applied) {
            revision.accept();
            updated += revision.count;
          } else {
            controller.abort();
            break;
          }
        } catch (error) {
          revision?.reject();
          if (folder === this.folder) this.error(error);
        }
      }
      if (updated)
        this.callbacks.notify(
          `Updated ${updated} linked model${updated === 1 ? '' : 's'}. Undo restores the previous art.`,
        );
      if (folder.status === 'Linked assets are up to date.')
        this.lastError = undefined;
    } finally {
      this.busy = false;
      this.status();
    }
  }
}
