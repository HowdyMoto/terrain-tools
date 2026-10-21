import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Create a new artist-owned folder. Existing folders are never overwritten. */
export async function writeContentProject(directory, name, document) {
  const root = resolve(directory);
  const filename =
    name
      .trim()
      .replace(/[^a-z0-9-_]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'Landscape';
  // Prefix Windows device names, even when followed by a file extension.
  const project =
    (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(filename)
      ? 'Landscape-' + filename
      : filename) + '.terrain';
  // Finish the potentially fallible encoding/read before touching the folder.
  const bytes = Buffer.from(await document.arrayBuffer());
  await mkdir(root); // Intentionally exclusive, including existing empty folders.
  for (const folder of ['sources', 'prepared', 'scenes', 'tools', 'exports'])
    await mkdir(join(root, folder));
  await writeFile(join(root, project), bytes, { flag: 'wx' });
  await writeFile(
    join(root, 'content-manifest.json'),
    JSON.stringify(
      {
        kind: 'terrain-content-manifest',
        name,
        project,
        credits: 'CREDITS.md',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  await writeFile(
    join(root, 'README.md'),
    `# ${name}\n\nOpen **${project}** from this folder in Terrain Studio. It contains the editable landscape and its embedded assets.\n\nSave your working project here in the root. Keep alternate scenes in \`scenes/\` and GLB/delivery exports in \`exports/\`. Browser autosave is a recovery copy; Save project downloads a file rather than writing back here automatically.\n\n- \`sources/\`: original downloads and DCC authoring files.\n- \`prepared/\`: ready-to-import models, materials and heightmaps.\n- \`scenes/\`: alternate editable scenes and named revisions.\n- \`tools/\`: project-specific conversion/build scripts.\n- \`exports/\`: GLBs and other delivery files.\n- \`CREDITS.md\`: artists, source links, licenses and modifications.\n- \`content-manifest.json\`: supporting inventory, not the file to open. Its checksum describes the initial generated document; record a new checksum after an intentional rebuild.\n`,
    { flag: 'wx' },
  );
  await writeFile(
    join(root, 'CREDITS.md'),
    '# Asset credits\n\nRecord each imported asset’s title, author, source URL, license and any modifications here. Keep original license files with the downloads in `sources/`.\n',
    { flag: 'wx' },
  );
  return join(root, project);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const directory = process.argv[2];
  if (!directory || process.argv.length > 3)
    throw new Error(
      'Usage: npm run project:create -- "C:/path/to/My Landscape" (a new folder)',
    );
  // Uses the built, locked toolkit, without installing anything in the art folder.
  const { createProject, serializeProjectPackage } =
    await import('terrain-tools');
  const project = createProject(128, 256);
  project.name = basename(resolve(directory)).slice(0, 120);
  const file = await writeContentProject(
    directory,
    project.name,
    serializeProjectPackage(project),
  );
  console.log(`Created project. Open ${file}`);
}
