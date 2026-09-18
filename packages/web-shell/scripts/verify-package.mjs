import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const typesRoot = resolve(packageRoot, 'dist/types');
const repositoryAliasSpecifier =
  /\b(?:from|import\s*\(|require\s*\()\s*['"]@\//;

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

const failures = [];
for await (const file of declarationFiles(typesRoot)) {
  const source = await readFile(file, 'utf8');
  if (repositoryAliasSpecifier.test(source)) {
    failures.push(
      `repository-only @/ import leaked into ${file.slice(packageRoot.length + 1)}`,
    );
  }
}

const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
);

function collectExportTargets(value, targets = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.add(value);
    return targets;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectExportTargets(nested, targets);
  }
  return targets;
}

for (const target of collectExportTargets(packageJson.exports)) {
  try {
    await access(resolve(packageRoot, target));
  } catch {
    failures.push(`missing package export target: ${target}`);
  }
}

if (failures.length > 0) {
  throw new Error(failures.join('\n'));
}
