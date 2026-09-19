// Runs from `prepublishOnly`: a published version cannot be replaced, so refuse
// to pack artifacts that consumers could not resolve.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const entryPoints = Object.values(pkg.exports).flatMap((entry) =>
  typeof entry === 'string' ? [entry] : Object.values(entry),
);
for (const entry of new Set(entryPoints)) {
  const target = join(root, entry);
  if (!existsSync(target)) {
    problems.push(`missing ${entry}`);
    continue;
  }
  // The bundles share chunks by relative path, and `files` publishes them by
  // globbing `dist/*.js`. A chunk emitted into a subdirectory would be
  // announced by an entry point but never packed.
  if (!entry.endsWith('.js')) continue;
  for (const [, specifier] of readFileSync(target, 'utf8').matchAll(
    /(?:from|import\()\s*['"](\.[^'"]+)['"]/g,
  )) {
    if (!existsSync(resolve(dirname(target), specifier))) {
      problems.push(`${entry} imports ${specifier}, which was not built`);
    }
  }
}

// Declarations ship verbatim, so they must not import through the alias that
// only this repository resolves.
const typesDir = join(root, 'dist/types');
if (existsSync(typesDir)) {
  for (const name of readdirSync(typesDir, { recursive: true })) {
    if (!name.endsWith('.d.ts')) continue;
    const source = readFileSync(join(typesDir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const [, specifier] of source.matchAll(
      /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
    )) {
      if (specifier.startsWith('@/')) {
        problems.push(`dist/types/${name} imports the repo-only ${specifier}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(
    `Refusing to publish @qwen-code/web-shell:\n${problems
      .map((problem) => `  - ${problem}`)
      .join('\n')}`,
  );
  process.exit(1);
}
