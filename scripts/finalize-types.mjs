import {
  readdir,
  readFile,
  writeFile,
  rename,
  access,
  mkdir,
  copyFile,
} from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import ts from 'typescript';

// Bundled JavaScript already uses ESM-safe paths. Give the separate declaration
// tree explicit extensions too, so NodeNext consumers can follow its exports.
async function finalize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) {
      await finalize(filename);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const original = await readFile(filename, 'utf8');
    const source = ts.createSourceFile(
      filename,
      original,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        imports.push(node.argument.literal);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const changes = [];
    for (const specifier of imports) {
      const value = specifier.text;
      if (!value.startsWith('.') || extname(value)) continue;
      const target = resolve(dirname(filename), value);
      let extension = '.js';
      try {
        await access(target + '.d.ts');
      } catch {
        await access(join(target, 'index.d.ts'));
        extension = '/index.js';
      }
      changes.push({
        start: specifier.getStart(source) + 1,
        end: specifier.end - 1,
        value: value + extension,
      });
    }
    let result = original;
    for (const change of changes.sort((a, b) => b.start - a.start))
      result =
        result.slice(0, change.start) + change.value + result.slice(change.end);
    if (result !== original) {
      await writeFile(filename + '.tmp', result);
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(filename + '.tmp', filename);
          break;
        } catch (error) {
          if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= 4)
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 50 * (attempt + 1)),
          );
        }
      }
    }
  }
}
await finalize('lib/types');
await mkdir('lib/licenses', { recursive: true });
await copyFile(
  'src/runtime/web-ocean/LICENSE.txt',
  'lib/licenses/web-ocean-MIT.txt',
);
