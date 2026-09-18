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
  if (!existsSync(join(root, entry))) problems.push(`missing ${entry}`);
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
