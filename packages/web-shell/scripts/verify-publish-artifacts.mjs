// Runs from `prepublishOnly`: a published version cannot be replaced, so refuse
// to pack artifacts that consumers could not resolve.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// Existing on disk says nothing about shipping: `files` publishes `dist/*.js`,
// and an npm glob does not cross a `/`, so anything the build emits below
// `dist/` is left out. Ask npm which paths it would actually pack.
// `--ignore-scripts` keeps this from re-entering `prepublishOnly`.
let packed;
try {
  packed = new Set(
    JSON.parse(
      execSync('npm pack --dry-run --json --ignore-scripts', {
        cwd: root,
        encoding: 'utf-8',
      }),
    )[0].files.map((file) => file.path),
  );
} catch (error) {
  // No list means no membership check, and a published version cannot be
  // replaced: report it and let the run below refuse the publish.
  problems.push(`could not determine the packed file list: ${error.message}`);
}

// npm lists packed paths relative to the package root, posix-separated and
// without the leading `./` that `exports` targets carry, so both sides of a
// membership check have to be reduced to that form first.
const packPath = (target) => relative(root, target).split(sep).join('/');

const entryPoints = Object.values(pkg.exports).flatMap((entry) =>
  typeof entry === 'string' ? [entry] : Object.values(entry),
);
for (const entry of new Set(entryPoints)) {
  const target = join(root, entry);
  if (!existsSync(target)) {
    problems.push(`missing ${entry}`);
    continue;
  }
  if (packed && !packed.has(packPath(target))) {
    problems.push(`${entry} was built but is not included in the npm package`);
    continue;
  }
  // The bundles share chunks by relative path, and `files` publishes them by
  // globbing `dist/*.js`. A chunk emitted into a subdirectory would be
  // announced by an entry point but never packed.
  if (!entry.endsWith('.js')) continue;
  for (const [, specifier] of readFileSync(target, 'utf8').matchAll(
    /(?:from|import\()\s*['"](\.[^'"]+)['"]/g,
  )) {
    const imported = resolve(dirname(target), specifier);
    if (!existsSync(imported)) {
      problems.push(`${entry} imports ${specifier}, which was not built`);
    } else if (packed && !packed.has(packPath(imported))) {
      problems.push(
        `${entry} imports ${specifier}, which is not included in the npm package`,
      );
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
