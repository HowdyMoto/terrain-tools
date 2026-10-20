import { checkSignal } from '../render/resources';

/** Capture entries during the drop event, then read every directory-reader batch.
 * Relative paths let a model resolve sibling BIN files and nested textures. */
export async function droppedFiles(
  transfer: DataTransfer,
  signal?: AbortSignal,
) {
  const items = Array.from(transfer.items).filter(
    (item) => item.kind === 'file',
  );
  const entries = items.map((item) => item.webkitGetAsEntry?.());
  if (!entries.some(Boolean)) return Array.from(transfer.files);
  const files: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string) => {
    checkSignal(signal);
    const path = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      checkSignal(signal);
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      files.push(file);
      if (files.length > 4096)
        throw new Error('Choose a smaller model folder (up to 4,096 files).');
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        checkSignal(signal);
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child, path + '/');
      }
    }
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) await walk(entry, '');
    else {
      const file = items[i].getAsFile();
      if (file) files.push(file);
    }
  }
  checkSignal(signal);
  return files;
}
