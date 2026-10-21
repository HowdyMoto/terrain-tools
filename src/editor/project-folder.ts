import type { TerrainProject } from '../core/types';
import { parseModelSource, projectRelativePath } from '../core/model-source';
import type { ModelSource } from '../core/model-source';
import { base64ToBytes } from '../core/base64';
import { checkModelFileSize } from '../core/model-limits';
import { readProjectFile } from '../core/glb-project';
import {
  projectPackageFolderId,
  MAX_PROJECT_PACKAGE_BYTES,
} from '../core/project-package';
import { checkSignal } from '../render/resources';
import { prepareLinkedModel } from '../core/model-document';

// Only capabilities granted by the browser's user-initiated pickers are used.
interface Pickers {
  showDirectoryPicker(options: {
    mode: 'readwrite';
    id: string;
  }): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker(options: {
    multiple: boolean;
    startIn: FileSystemDirectoryHandle;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle[]>;
}
export function folderAccessAvailable() {
  return 'showDirectoryPicker' in window && 'showOpenFilePicker' in window;
}
export async function chooseProjectDirectory() {
  if (!folderAccessAvailable())
    throw new Error(
      'Folder projects require desktop Chrome or Edge. Portable projects still work with Open.',
    );
  return (window as unknown as Pickers).showDirectoryPicker({
    mode: 'readwrite',
    id: 'terrain-project',
  });
}
export const fileStamp = (file: File) => `${file.lastModified}:${file.size}`;
const notFound = (error: unknown) =>
  error instanceof DOMException && error.name === 'NotFoundError';

export interface ModelRevision {
  project: TerrainProject;
  count: number;
  assertCurrent(): Promise<void>;
  accept(): void;
  reject(): void;
}

/** Directory handles stay in the editor; documents contain portable relative paths only. */
export class ProjectFolder {
  private applied = new Map<string, string>();
  private observed = new Map<string, string>();
  private failed = new Map<string, string>();
  private savedStamp?: string;
  private opening = new Map<string, string>();
  private needsBackup = false;
  autoReload = true;
  status = 'Linked assets are up to date.';
  constructor(
    readonly root: FileSystemDirectoryHandle,
    readonly filename: string,
  ) {
    if (
      projectRelativePath(filename).includes('/') ||
      !/\.terrain$/i.test(filename)
    )
      throw new Error('The main .terrain file must be in the project root.');
  }
  async file(path: string, create = false) {
    const parts = projectRelativePath(path).split('/');
    let directory = this.root;
    for (const part of parts.slice(0, -1))
      directory = await directory.getDirectoryHandle(part, { create });
    return directory.getFileHandle(parts.at(-1)!, { create });
  }
  private async optionalFile(path: string) {
    try {
      return await (await this.file(path)).getFile();
    } catch (error) {
      if (!notFound(error)) throw error;
      return undefined;
    }
  }
  private async writeNewFile(path: string, blob: Blob) {
    if (await this.optionalFile(path))
      throw new Error('File already exists: ' + path);
    const handle = await this.file(path, true);
    const created = await handle.getFile();
    if (created.size) throw new Error('File changed before writing: ' + path);
    let stream: FileSystemWritableFileStream | undefined;
    try {
      stream = await handle.createWritable();
      await stream.write(blob);
      if (fileStamp(await handle.getFile()) !== fileStamp(created))
        throw new Error('File changed while saving: ' + path);
      await stream.close();
    } catch (error) {
      await stream?.abort().catch(() => {});
      // Remove only our unchanged, empty placeholder after an unsuccessful new-file write.
      await (async () => {
        const current = await this.optionalFile(path);
        if (
          !current ||
          current.size ||
          fileStamp(current) !== fileStamp(created)
        )
          return;
        const parts = projectRelativePath(path).split('/');
        let directory = this.root;
        for (const part of parts.slice(0, -1))
          directory = await directory.getDirectoryHandle(part);
        await directory.removeEntry(parts.at(-1)!);
      })().catch(() => {});
      throw error;
    }
  }
  /** Fresh path lookup supports DCCs that replace a GLB by atomic rename. */
  async readModel(source: ModelSource, signal?: AbortSignal) {
    const settings = parseModelSource(source);
    checkSignal(signal);
    const file = await (await this.file(settings.path)).getFile();
    checkModelFileSize(file.size, settings.path);
    const buffer = await file.arrayBuffer();
    checkSignal(signal);
    const data = prepareLinkedModel(buffer, settings);
    checkSignal(signal);
    if (
      fileStamp(await (await this.file(settings.path)).getFile()) !==
      fileStamp(file)
    )
      throw new Error('Source is still being written: ' + settings.path);
    return { data, stamp: fileStamp(file) };
  }
  async open(signal?: AbortSignal) {
    const file = await (await this.file(this.filename)).getFile();
    this.opening.clear();
    const project = await readProjectFile(file, async (source) => {
      const result = await this.readModel(source, signal);
      this.opening.set(JSON.stringify(source), result.stamp);
      return result.data;
    });
    checkSignal(signal);
    if (
      fileStamp(await (await this.file(this.filename)).getFile()) !==
      fileStamp(file)
    )
      throw new Error('Project changed while it was opening. Try again.');
    this.savedStamp = fileStamp(file);
    const head = await file.slice(0, 12).arrayBuffer();
    this.needsBackup =
      head.byteLength < 12 || new DataView(head).getUint32(8, true) !== 2;
    for (const [id, model] of Object.entries(project.assets)) {
      if (model.source) {
        const key = JSON.stringify(model.source);
        const stamp = this.opening.get(key);
        if (stamp) this.applied.set(id, key + ':' + stamp);
      }
    }
    this.opening.clear();
    return project;
  }
  /** Reauthorize the same folder after browser recovery without replacing unsaved authoring data. */
  async reconnect(project: TerrainProject) {
    const file = await (await this.file(this.filename)).getFile();
    if (file.size > MAX_PROJECT_PACKAGE_BYTES)
      throw new Error('Project exceeds the supported package size.');
    const buffer = await file.arrayBuffer();
    if (
      !project.folderId ||
      projectPackageFolderId(buffer) !== project.folderId
    )
      throw new Error(
        'This is a different folder project. Your recovered document is unchanged.',
      );
    if (
      fileStamp(await (await this.file(this.filename)).getFile()) !==
      fileStamp(file)
    )
      throw new Error('The project changed while reconnecting. Try again.');
    this.savedStamp = fileStamp(file);
    this.needsBackup = new DataView(buffer).getUint32(8, true) !== 2;
  }
  async assertSourcesCurrent(project: TerrainProject) {
    for (const [id, model] of Object.entries(project.assets)) {
      if (!model.source || !this.applied.has(id)) continue;
      const key =
        JSON.stringify(model.source) +
        ':' +
        fileStamp(await (await this.file(model.source.path)).getFile());
      if (this.applied.get(id) !== key)
        throw new Error(
          'Source changed while opening: ' + model.source.path + '. Try again.',
        );
    }
  }
  async chooseModels(multiple = true) {
    const handles = await (window as unknown as Pickers).showOpenFilePicker({
      multiple,
      startIn: this.root,
      types: [
        {
          description: 'Linked GLB models',
          accept: { 'model/gltf-binary': ['.glb'] },
        },
      ],
    });
    const result: { file: File; path: string }[] = [];
    for (const handle of handles) {
      const parts = await this.root.resolve(handle);
      if (!parts?.length)
        throw new Error(
          'Place the GLB inside this project folder, then select it.',
        );
      const path = projectRelativePath(parts.join('/'));
      parseModelSource({ path, scale: 1, offset: [0, 0, 0] });
      result.push({ file: await (await this.file(path)).getFile(), path });
    }
    return result;
  }
  /** Poll metadata only; decode bytes only after two stable observations, or explicit reload. */
  async revisions(
    project: TerrainProject,
    force = false,
    signal?: AbortSignal,
  ): Promise<ModelRevision | undefined> {
    const changed: {
      id: string;
      source: ModelSource;
      stamp: string;
      key: string;
    }[] = [];
    const liveIds = new Set<string>();
    for (const [id, model] of Object.entries(project.assets)) {
      if (!model.source) continue;
      liveIds.add(id);
      checkSignal(signal);
      const source = parseModelSource(model.source);
      const file = await this.optionalFile(source.path);
      const stamp = file ? fileStamp(file) : 'missing';
      const key = JSON.stringify(source) + ':' + stamp;
      const stable = this.observed.get(id) === key;
      if (!stable) this.failed.clear();
      this.observed.set(id, key);
      if (
        !force &&
        (this.applied.get(id) === key || this.failed.get(id) === key || !stable)
      )
        continue;
      if (!file) {
        this.failed.set(id, key);
        throw new Error(
          'Missing linked model: ' +
            source.path +
            '. Restore the file to refresh it.',
        );
      }
      changed.push({ id, source, stamp, key });
    }
    for (const cache of [this.applied, this.observed, this.failed])
      for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
    if (!changed.length) return;
    const candidate = { ...project, assets: { ...project.assets } };
    try {
      for (const item of changed) {
        let result: Awaited<ReturnType<ProjectFolder['readModel']>>;
        try {
          result = await this.readModel(item.source, signal);
        } catch (error) {
          throw new Error(
            'Could not refresh ' + item.source.path + ': ' + String(error),
            { cause: error },
          );
        }
        if (result.stamp !== item.stamp)
          throw new Error('Source changed during refresh: ' + item.source.path);
        candidate.assets[item.id] = {
          ...project.assets[item.id],
          data: result.data,
        };
      }
    } catch (error) {
      if (!signal?.aborted)
        for (const item of changed) this.failed.set(item.id, item.key);
      throw error;
    }
    return {
      project: candidate,
      count: changed.filter(
        (item) =>
          candidate.assets[item.id].data !== project.assets[item.id].data,
      ).length,
      assertCurrent: async () => {
        checkSignal(signal);
        for (const item of changed)
          if (
            fileStamp(await (await this.file(item.source.path)).getFile()) !==
            item.stamp
          )
            throw new Error(
              'Source changed during preparation: ' + item.source.path,
            );
      },
      accept: () => {
        for (const item of changed) {
          this.applied.set(item.id, item.key);
          this.failed.delete(item.id);
        }
        this.status =
          this.failed.size ||
          [...this.observed.values()].some((key) => key.endsWith(':missing'))
            ? 'Some linked GLBs need attention. Restore their files or reload to retry.'
            : 'Linked assets are up to date.';
      },
      reject: () => {
        if (!signal?.aborted)
          for (const item of changed) this.failed.set(item.id, item.key);
      },
    };
  }
  /** Staged writes publish only on close; conflicting external document edits are rejected. */
  async save(blob: Blob) {
    const current = await this.optionalFile(this.filename);
    if ((current ? fileStamp(current) : undefined) !== this.savedStamp)
      throw new Error(
        'The project file changed on disk. Save a portable copy or reopen the folder before replacing it.',
      );
    if (!current) {
      await this.writeNewFile(this.filename, blob);
      this.savedStamp = fileStamp(
        await (await this.file(this.filename)).getFile(),
      );
      return;
    }
    if (current && this.needsBackup) {
      const path = `scenes/${this.filename.replace(/\.terrain$/i, '')}-before-links-${crypto.randomUUID()}.terrain`;
      await this.writeNewFile(path, current);
      this.needsBackup = false;
    }
    const handle = await this.file(this.filename, true);
    const stream = await handle.createWritable();
    try {
      await stream.write(blob);
      const now = await handle.getFile();
      // A newly created empty target has no prior stamp.
      if (current && fileStamp(now) !== this.savedStamp)
        throw new Error('The project file changed during saving.');
      await stream.close();
      this.savedStamp = fileStamp(
        await (await this.file(this.filename)).getFile(),
      );
      this.needsBackup = false;
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
  }
  /** New-folder conversion writes editable GLBs once; no embedded model copies remain in its document. */
  async externalize(project: TerrainProject, keepLinked = false) {
    const candidate = { ...project, assets: { ...project.assets } };
    for (const [id, model] of Object.entries(project.assets)) {
      if (keepLinked && model.source) continue;
      const name = model.name
        .replace(/[^a-z0-9_-]/gi, '-')
        .replace(/-+/g, '-')
        .slice(0, 80);
      const path = `prepared/models/${id}-${name || 'model'}.glb`;
      const bytes = base64ToBytes(
        model.data.slice(model.data.indexOf(',') + 1),
      );
      checkModelFileSize(bytes.length, model.name);
      const existing = await this.optionalFile(path);
      if (existing) {
        const content = new Uint8Array(await existing.arrayBuffer());
        if (
          content.length !== bytes.length ||
          !content.every((v, i) => v === bytes[i])
        )
          throw new Error(
            'An asset already exists at ' +
              path +
              '. Choose a new project folder.',
          );
      } else {
        await this.writeNewFile(path, new Blob([bytes]));
      }
      candidate.assets[id] = {
        ...model,
        source: { path, scale: 1, offset: [0, 0, 0], prepared: true },
      };
    }
    return candidate;
  }
}

/** Only immediate root entries are inspected; original artwork is never traversed. */
export async function projectFilename(root: FileSystemDirectoryHandle) {
  const files: string[] = [];
  const entries = (
    root as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemHandle>;
    }
  ).values();
  for await (const entry of entries)
    if (entry.kind === 'file' && /\.terrain$/i.test(entry.name))
      files.push(entry.name);
  if (files.length !== 1)
    throw new Error(
      files.length
        ? 'Keep one main .terrain file at the root; move alternate scenes into scenes/.'
        : 'No root .terrain file found. Use Save as folder project to create one.',
    );
  return files[0];
}
