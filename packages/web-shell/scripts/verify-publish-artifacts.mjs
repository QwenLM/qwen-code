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
// npm pack does not run `prepublishOnly`; `--ignore-scripts` prevents future
// pack-time hooks from re-entering this verifier.
let packed;
try {
  packed = new Set(
    JSON.parse(
      execSync('npm pack --dry-run --json --ignore-scripts', {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
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

// A `.`/`..` path segment (also percent-encoded, which Node rejects the same
// way) anywhere in a declared `exports` target. Deliberately not `_`: Node
// resolves `./dist/_/*.js` normally.
const invalidTargetSegment = /(^|\/)(\.|%2e)(\.|%2e)?(\/|$)/i;

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
  // Node resolves an `exports` target only when it is a `./`-relative path
  // whose segments are all real names. A bare (`dist/*`), rooted (`/dist/*`)
  // or dot-segment (`./dist/../dist/*.js`) target throws
  // `ERR_INVALID_PACKAGE_TARGET` for every specifier through that key, so the
  // family it names is unresolvable no matter what the tarball ships. Check
  // the DECLARED string: `join` below normalizes dot segments away, and
  // matching the normalized path would certify a target Node refuses to
  // resolve. The segment test runs after the `./` prefix is stripped, or
  // `(^|\/)` would match that prefix itself and reject every valid target.
  if (!entry.startsWith('./') || invalidTargetSegment.test(entry.slice(2))) {
    problems.push(`${entry} is not a valid "exports" target`);
    continue;
  }
  // A subpath pattern (`"./*": "./dist/*"`) names a family of files, not a
  // path: statting it literally would report a false `missing`. Hold the
  // family against the packed list instead — at least one packed file must
  // match, or the manifest advertises subpaths the tarball does not ship.
  // Node gives `*` pattern meaning only when the KEY carries it, so gate on
  // both sides: a `*` target under a literal key is a literal path and keeps
  // the checks below, and a pattern key with a literal target still needs the
  // relative-import chunk scan the `continue` would skip. A pattern key also
  // has to be a `./`-prefixed subpath key — `"dist/*"` and `"*"` are not, and
  // mixing them with `"."` makes Node reject the whole manifest with
  // `ERR_INVALID_PACKAGE_CONFIG`, root specifier included — and Node honours
  // it only when it carries exactly one `*`, substituting that one capture
  // into every `*` in the target. So the gate requires the prefix and counts
  // stars on the key, and the regex captures on the first `*` and
  // back-references that capture for every later `*` instead of matching each
  // star independently. That back-reference has to be named: `\1` followed
  // immediately by a digit (`./dist/*/*1.js`) compiles as the Annex B octal
  // escape U+0009 rather than as a reference, leaving a pattern no packed
  // path can satisfy — which would refuse a manifest Node resolves fine.
  if (
    key.startsWith('./') &&
    key.split('*').length === 2 &&
    entry.includes('*')
  ) {
    if (packed) {
      const escaped = packPath(join(root, entry)).replace(
        /[.+?^${}()|[\]\\]/g,
        '\\$&',
      );
      const [first, ...rest] = escaped.split('*');
      const pattern =
        first +
        rest
          .map((part, i) => (i === 0 ? '(?<s>.*)' : '\\k<s>') + part)
          .join('');
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
