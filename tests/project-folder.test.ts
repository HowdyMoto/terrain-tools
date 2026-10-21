import { expect, it } from 'vitest';
import { createProject } from '../src/core/terrain';
import { modelDataURL, writeModelDocument } from '../src/core/model-document';
import { ProjectFolder } from '../src/editor/project-folder';

it('verifies saved art by bytes across legacy MIME and base64 spellings', async () => {
  const buffer = writeModelDocument({
    json: { asset: { version: '2.0', generator: 'legacy' } },
    chunks: [],
  });
  const file = new File([buffer], 'Tree.glb', { lastModified: 1000 });
  const root = {
    getFileHandle: async () => ({ getFile: async () => file }),
  };
  const folder = new ProjectFolder(
    root as unknown as FileSystemDirectoryHandle,
    'Scene.terrain',
  );
  const project = createProject(8, 32);
  const source = {
    path: 'Tree.glb',
    scale: 1,
    offset: [0, 0, 0] as [number, number, number],
    prepared: true,
  };
  const canonical = modelDataURL(buffer);
  project.assets.tree = {
    name: 'Legacy Tree',
    source,
    data: canonical
      .replace('model/gltf-binary', 'application/octet-stream')
      .replace(/=+$/, ''),
  };
  project.assets.alias = { name: 'Canonical Tree', source, data: canonical };
  await (
    await folder.verifySaveSources(project)
  )();
  project.assets.alias.data = modelDataURL(
    writeModelDocument({
      json: { asset: { version: '2.0', generator: 'different art' } },
      chunks: [],
    }),
  );
  await expect(folder.verifySaveSources(project)).rejects.toThrow(
    'Linked art differs',
  );
});

it('waits for a stable export and updates every same-source alias together', async () => {
  const glb = (name: string) =>
    writeModelDocument({
      json: { asset: { version: '2.0', generator: name } },
      chunks: [],
    });
  const original = glb('original'),
    revised = glb('revised');
  const oldFile = new File([original], 'Tree.glb', { lastModified: 1000 }),
    newFile = new File([revised], 'Tree.glb', { lastModified: 2000 });
  let reads = 0;
  // Simulate an export completing immediately after the first metadata read.
  const root = {
    getDirectoryHandle: async () => root,
    getFileHandle: async () => ({
      getFile: async () => (reads++ === 0 ? oldFile : newFile),
    }),
  };
  const project = createProject(8, 32);
  for (const id of ['tree', 'alias'])
    project.assets[id] = {
      name: id,
      data: modelDataURL(original),
      source: {
        path: 'prepared/Tree.glb',
        scale: 1,
        offset: [0, 0, 0],
        prepared: true,
      },
    };
  const folder = new ProjectFolder(
    root as unknown as FileSystemDirectoryHandle,
    'Scene.terrain',
  );
  expect(await folder.revisions(project, 'prepared/Tree.glb')).toBeUndefined();
  expect(await folder.revisions(project, 'prepared/Tree.glb')).toBeUndefined();
  const revision = await folder.revisions(project, 'prepared/Tree.glb');
  expect(revision?.count).toBe(2);
  expect(revision?.project.assets.tree.data).toBe(modelDataURL(revised));
  expect(revision?.project.assets.alias.data).toBe(modelDataURL(revised));
  expect(project.assets.tree.data).toBe(modelDataURL(original));
  await revision!.assertCurrent();
  revision!.accept();
  expect(
    await folder.revisions(revision!.project, 'prepared/Tree.glb'),
  ).toBeUndefined();
});
