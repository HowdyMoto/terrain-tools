import { describe, expect, it } from 'vitest';
import { droppedFiles } from '../src/editor/import-files';

function fileEntry(name: string): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: File) => void) => resolve(new File(['test'], name)),
  } as unknown as FileSystemEntry;
}
function directory(
  name: string,
  batches: FileSystemEntry[][],
): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let batch = 0;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
          resolve(batches[batch++] ?? []),
      };
    },
  } as unknown as FileSystemEntry;
}
function transfer(entries: FileSystemEntry[]): DataTransfer {
  return {
    items: entries.map((entry) => ({
      kind: 'file',
      webkitGetAsEntry: () => entry,
    })),
    files: [],
  } as unknown as DataTransfer;
}

describe('folder file drops', () => {
  it('reads all directory batches, preserves nested relative paths and keeps duplicate basenames distinct', async () => {
    const entries = transfer([
      directory('tree.gltf', [
        [fileEntry('tree.gltf'), fileEntry('tree.bin')],
        [
          directory('textures', [[fileEntry('leaf.png')]]),
          directory('alternate', [[fileEntry('leaf.png')]]),
        ],
      ]),
    ]);
    const files = await droppedFiles(entries);
    expect(files.map((file) => file.webkitRelativePath)).toEqual([
      'tree.gltf/tree.gltf',
      'tree.gltf/tree.bin',
      'tree.gltf/textures/leaf.png',
      'tree.gltf/alternate/leaf.png',
    ]);
  });
  it('rejects cancellation and unreadable directories without returning a partial selection', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      droppedFiles(transfer([fileEntry('tree.bin')]), controller.signal),
    ).rejects.toThrow();
    const broken = {
      name: 'broken',
      isDirectory: true,
      createReader: () => ({
        readEntries: (_resolve: unknown, reject: (error: Error) => void) =>
          reject(new Error('Permission denied')),
      }),
    } as unknown as FileSystemEntry;
    await expect(
      droppedFiles(transfer([fileEntry('tree.gltf'), broken])),
    ).rejects.toThrow('Permission denied');
  });
});
