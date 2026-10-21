import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Root documents, scenes/, and legacy exports/ share a root content inventory. */
export async function readContentManifest(project) {
  const folder = dirname(resolve(project));
  for (const directory of [folder, dirname(folder)]) {
    try {
      return JSON.parse(
        await readFile(join(directory, 'content-manifest.json'), 'utf8'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(
    'No content-manifest.json found beside the project or in its parent folder.',
  );
}
