import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Read-only Node adapter for native/legacy projects and project-local linked GLBs. */
export async function readContentProject(filename) {
  const core = await import('terrain-tools');
  const root = await realpath(dirname(resolve(filename)));
  const file = resolve(filename);
  if ((await stat(file)).size > core.MAX_PROJECT_PACKAGE_BYTES)
    throw new Error('Project exceeds the supported native package size.');
  return core.readProjectFile(
    new Blob([await readFile(file)]),
    async (source) => {
      const path = await realpath(
        resolve(root, core.projectRelativePath(source.path)),
      );
      const subpath = relative(root, path);
      if (
        isAbsolute(subpath) ||
        subpath === '..' ||
        subpath.startsWith('..' + sep)
      )
        throw new Error(
          'Linked model leaves the project folder: ' + source.path,
        );
      const before = await stat(path);
      if (!before.isFile())
        throw new Error('Linked source is not a regular file: ' + source.path);
      core.checkModelFileSize(before.size, source.path);
      const bytes = await readFile(path);
      const after = await stat(path);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
      )
        throw new Error('Source changed while reading: ' + source.path);
      return core.prepareLinkedModel(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
        source,
      );
    },
  );
}

/** Canonical portable snapshot includes current source bytes in benchmark fingerprints. */
export async function portableContentProject(filename) {
  const core = await import('terrain-tools');
  return Buffer.from(
    await core
      .serializeProjectPackage(await readContentProject(filename))
      .arrayBuffer(),
  );
}
