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

const entryPoints = Object.entries(pkg.exports).flatMap(([key, entry]) =>
  typeof entry === 'string'
    ? [[key, entry]]
    : Object.values(entry).map((value) => [key, value]),
);
const seen = new Set();
for (const [key, entry] of entryPoints) {
  // `[key, entry]` pairs are fresh arrays, so identity dedup (`new Set` over
  // the pairs) would never fire. The key is part of the dedup text on
  // purpose: which branch a pair takes depends on the key, so two keys
  // sharing one target must both be checked.
  if (seen.has(key + '\0' + entry)) continue;
  seen.add(key + '\0' + entry);
  // A subpath pattern (`"./*": "./dist/*"`) names a family of files, not a
  // path: statting it literally would report a false `missing`. Hold the
  // family against the packed list instead — at least one packed file must
  // match, or the manifest advertises subpaths the tarball does not ship.
  // Node gives `*` pattern meaning only when the KEY carries it, so gate on
  // both sides: a `*` target under a literal key is a literal path and keeps
  // the checks below, and a pattern key with a literal target still needs the
  // relative-import chunk scan the `continue` would skip. Node honours a
  // pattern key only when it carries exactly one `*`, and substitutes that
  // one capture into every `*` in the target — so the gate counts stars on
  // the key, and the regex captures on the first `*` and back-references
  // that capture for every later `*` instead of matching each star
  // independently.
  if (key.split('*').length === 2 && entry.includes('*')) {
    if (packed) {
      const escaped = packPath(join(root, entry)).replace(
        /[.+?^${}()|[\]\\]/g,
        '\\$&',
      );
      const [first, ...rest] = escaped.split('*');
      const pattern =
        first +
        rest.map((part, i) => (i === 0 ? '(.*)' : '\\1') + part).join('');
      if (![...packed].some((file) => new RegExp(`^${pattern}$`).test(file))) {
        problems.push(`${entry} matches no file in the npm package`);
      }
    }
    continue;
  }
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
