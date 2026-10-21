import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createProject } from '../src/core/terrain.ts';
import { serializeProjectPackage } from '../src/core/project-package.ts';
import { parseProjectFile } from '../src/core/glb-project.ts';
import { writeContentProject } from '../scripts/create-content-project.mjs';
import { readContentManifest } from '../scripts/content-project-manifest.mjs';

const temporary = [];
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'terrain-project-layout-'));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    // Only delete the exact temporary roots created by this test.
    expect(resolve(path).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(path).toContain('terrain-project-layout-');
    await rm(path, { recursive: true, force: true });
  }
});

it('creates a root project that opens without supporting folders or source art', async () => {
  const root = join(await fixture(), 'My Landscape');
  const project = createProject(8, 32);
  project.name = 'My Landscape';
  project.heights[4] = 7;
  const document = serializeProjectPackage(project);
  const file = await writeContentProject(root, project.name, document);
  expect(file).toBe(join(root, 'My-Landscape.terrain'));
  const bytes = await readFile(file);
  expect(bytes).toEqual(Buffer.from(await document.arrayBuffer()));
  expect(
    parseProjectFile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    ),
  ).toEqual(project);
  expect((await readdir(root)).sort()).toEqual(
    [
      'My-Landscape.terrain',
      'README.md',
      'CREDITS.md',
      'content-manifest.json',
      'sources',
      'prepared',
      'scenes',
      'tools',
      'exports',
    ].sort(),
  );
  expect(await readdir(join(root, 'exports'))).toEqual([]);
  expect(await readContentManifest(file)).toMatchObject({
    project: 'My-Landscape.terrain',
    bytes: bytes.length,
    credits: 'CREDITS.md',
  });
});

it('refuses to overwrite existing folders and leaves no folder on an encoding failure', async () => {
  const parent = await fixture();
  const root = join(parent, 'Existing');
  await mkdir(root);
  await writeFile(join(root, 'Artist.terrain'), 'authored revision');
  await expect(
    writeContentProject(root, 'Artist', new Blob(['replacement'])),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(root, 'Artist.terrain'), 'utf8')).toBe(
    'authored revision',
  );
  const broken = {
    arrayBuffer: async () => {
      throw new Error('Encoding failed');
    },
  };
  await expect(
    writeContentProject(join(parent, 'Failed'), 'Failed', broken),
  ).rejects.toThrow('Encoding failed');
  expect(await readdir(parent)).toEqual(['Existing']);
  // A successful retry can use the same path after failed preparation.
  await writeContentProject(join(parent, 'Failed'), 'CON', new Blob(['retry']));
  expect(
    await readFile(join(parent, 'Failed', 'Landscape-CON.terrain'), 'utf8'),
  ).toBe('retry');
});

it('finds inventories for root projects, alternate scenes and legacy exports without hiding malformed metadata', async () => {
  const root = await fixture();
  const manifest = {
    kind: 'terrain-content-manifest',
    project: 'Landscape.terrain',
  };
  await writeFile(
    join(root, 'content-manifest.json'),
    JSON.stringify(manifest),
  );
  for (const folder of ['', 'scenes', 'exports']) {
    await mkdir(join(root, folder), { recursive: true });
    expect(
      await readContentManifest(join(root, folder, 'Landscape.terrain')),
    ).toEqual(manifest);
  }
  await writeFile(join(root, 'scenes', 'content-manifest.json'), '{broken');
  await expect(
    readContentManifest(join(root, 'scenes', 'Broken.terrain')),
  ).rejects.toThrow();
});
