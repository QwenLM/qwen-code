import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const typesRoot = resolve(packageRoot, 'dist/types');
const aliasSpecifier = /(['"])@\/([^'"]+)\1/g;

async function* declarationFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* declarationFiles(path);
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      yield path;
    }
  }
}

for await (const file of declarationFiles(typesRoot)) {
  const source = await readFile(file, 'utf8');
  const rewritten = source.replace(
    aliasSpecifier,
    (_match, quote, aliasTarget) => {
      const target = resolve(typesRoot, aliasTarget);
      if (target !== typesRoot && !target.startsWith(`${typesRoot}${sep}`)) {
        throw new Error(`Declaration alias escapes dist/types: ${aliasTarget}`);
      }
      let specifier = relative(dirname(file), target).split(sep).join('/');
      if (!specifier.startsWith('.')) specifier = `./${specifier}`;
      return `${quote}${specifier}${quote}`;
    },
  );
  if (rewritten !== source) await writeFile(file, rewritten);
}
