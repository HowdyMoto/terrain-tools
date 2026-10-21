import { parseProject } from '../core/serialization';
import { readProjectFile } from '../core/glb-project';
import { BackgroundProjectWriter } from '../core/background-package';
import type { TerrainProject } from '../core/types';
const writer = new BackgroundProjectWriter({ maxPending: 2 });
const committed = new WeakSet<Blob>();
let writes: Promise<void> = Promise.resolve();
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('terrain-studio', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export function projectDownload(project: TerrainProject, linked = false) {
  return writer.encode(project, linked ? 'linked' : 'portable');
}
export async function saveLocal(project: TerrainProject) {
  // Capture before yielding; pending autosaves share the newest immutable result.
  // Handle rejection immediately even while a previous IndexedDB write is pending.
  const encoding = writer.encodeLatest(project).then(
    (blob) => ({ blob }),
    (error: unknown) => ({ error }),
  );
  const saving = writes
    .catch(() => {})
    .then(async () => {
      const result = await encoding;
      if ('error' in result) throw result.error;
      const data = result.blob;
      if (committed.has(data)) return;
      const db = await database();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('projects', 'readwrite');
          tx.objectStore('projects').put(data, 'autosave');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () =>
            reject(tx.error ?? new Error('Autosave transaction aborted.'));
        });
        committed.add(data);
      } finally {
        db.close();
      }
    });
  writes = saving;
  return saving;
}
export async function loadLocal() {
  await writes.catch(() => {});
  const db = await database();
  try {
    const data = await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction('projects')
        .objectStore('projects')
        .get('autosave');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (data === undefined) return null;
    if (typeof data === 'string') return parseProject(data); // Existing version-1 autosaves.
    if (data instanceof Blob) return readProjectFile(data);
    throw new Error('Unsupported local project data.');
  } finally {
    db.close();
  }
}
export function download(
  data: BlobPart,
  name: string,
  type = 'application/octet-stream',
) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const readDataUrl = (
  file: File,
  signal?: AbortSignal,
  progress?: (fraction: number) => void,
) =>
  new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason ?? new DOMException('Import cancelled.', 'AbortError'),
      );
      return;
    }
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      cleanup();
      reject(
        signal?.reason ?? new DOMException('Import cancelled.', 'AbortError'),
      );
    };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error);
    };
    reader.onabort = () => {
      cleanup();
      reject(
        signal?.reason ?? new DOMException('Import cancelled.', 'AbortError'),
      );
    };
    reader.onprogress = (event) => {
      if (event.lengthComputable) progress?.(event.loaded / event.total);
    };
    signal?.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(file);
  });
