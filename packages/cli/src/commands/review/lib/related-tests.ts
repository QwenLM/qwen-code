/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which of a suite's tests run: all of them, or only the ones the diff can
// reach.
//
// A suite that cannot finish inside its deadline reports a timeout and
// nothing else. Measured on this repo at 8 CPUs: `packages/cli`'s suite takes
// 724s (4214 CPU-s) against a 540s deadline, so on such a machine its test
// phase has only ever said "infrastructure". `vitest related <files>` runs
// the tests whose import graph reaches one of the files; on four merged PRs
// whose diff stayed narrow it ran 127–364 of the suite's 1351 files, in
// 326–439s and 1200–2087 CPU-s. Two more touched a manifest, or core modules
// nearly everything imports, and ran close to the whole suite either way.
//
// vitest follows imports, and that is all it follows. What it cannot see:
//
// - A file read by name — a doc a contract test checks, a bundled SKILL.md
//   the skill loader opens, a source file a test asserts the text of. Every
//   module that names a changed file's basename joins the list, so the tests
//   that import it run.
// - A change that reaches every test without being imported by any — the
//   vitest/vite config and the setup files it names, a workspace manifest,
//   the lockfile, a tsconfig, a dependency patch, a `__mocks__` module — or a
//   file the diff deletes or renames away, which takes the old edges with it.
//   Each of these runs every suite whole. The list is the conventions this
//   module knows, not every way a file can reach a test.
// - A snapshot: vitest binds `__snapshots__/<test>.snap` to `<test>` by name,
//   so the test joins the list.
// - A path the graph spells differently from the diff: vitest resolves the
//   list against its configured `root`, so a suite whose config moves it
//   runs whole; and a package imported by name is its build output in the
//   graph, so a changed file of a package whose entry is not its source
//   brings that build output with it (`buildOutputOf`).
// - A suite whose npm `pretest`/`posttest` must run: `npm exec` runs neither.
//   It runs whole, as does one whose `vitest` npm exec would not find.
// - A test that lists a directory, or builds the file's name at run time,
//   without naming the file. Nothing here finds that one; the report says so
//   (`relatedTestsSentence`).

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';

/**
 * The test scripts `vitest related` stands in for: vitest's one-shot run,
 * naming at most its config. Anything else — another runner, a wrapper, an
 * env prefix, a filter or a flag — keeps its whole suite, as written.
 */
const VITEST_RUN_RE =
  /^vitest(?: run| --run)?(?: --config(?:=| )((?![-/])[\w@./-]+))?$/;

/**
 * A path the command can carry: nothing a shell expands inside double
 * quotes, nothing vitest would read as a flag, and nothing absolute.
 */
const PATH_TOKEN_RE = /^(?![-/])[\w@./-]+$/;

/**
 * Changes that reach every test without being imported by one, by name.
 * A workspace manifest is matched apart (`isManifest`): a `package.json`
 * under a fixture or an example is no workspace's.
 */
const WHOLE_SUITE_TRIGGER_RE = new RegExp(
  [
    String.raw`(?:^|/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.[cm]?js)$`,
    String.raw`(?:^|/)tsconfig[^/]*\.json$`,
    String.raw`(?:^|/)vite(?:st)?(?:\.[\w-]+)*\.(?:config|workspace|projects)\.[cm]?[jt]s$`,
    String.raw`^patches/`,
    String.raw`(?:^|/)__mocks__/`,
  ].join('|'),
  'i',
);

/**
 * A setup file by the convention of its name — the whole stem a setup word
 * (`test-setup.ts`, `setupTests.ts`, `globalSetup.ts`,
 * `vitest-global-setup.js`, `client/test/setup.ts`), never a module that
 * merely contains one (`setupGithubCommand.ts`, `useLiveVoiceSetup.ts`), nor
 * a test of a setup (`globalSetup.test.ts`). Not under `src/`, where a
 * `setup.ts` is as likely ordinary code: a setup file there is caught by its
 * config naming it (`setupNamesOf`).
 */
const SETUP_FILE_RE =
  /(?:^|\/)(?:test[-_.]?setup|setup[-_.]?tests?|(?:vitest[-_.]?)?(?:global[-_.]?)?setup)\.[cm]?[jt]sx?$/i;

/** Snapshot files vitest binds to their test by name. */
const SNAPSHOT_RE = /^(.*\/)?__snapshots__\/([^/]+)\.snap$/;

/** A JavaScript or TypeScript module, by extension. */
const SCRIPT_RE = /\.[cm]?[jt]sx?$/;

/** A test file vitest's default `include` collects. */
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The config files vitest looks for, in its order, when none is named. */
const DEFAULT_CONFIGS = ['vitest', 'vite'].flatMap((stem) =>
  ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
    (ext) => `${stem}.config.${ext}`,
  ),
);

/** A config key or shorthand that sets vitest's `root`, quoted or bare. */
const ROOT_KEY_RE = /(?:\broot|['"]root['"])\s*:|[{,]\s*root\s*[,}]/;

/** An inline projects list, quoted or bare: each project may set its own root. */
const PROJECTS_KEY_RE = /(?:\bprojects|['"]projects['"])\s*:/;

/** An import of a local module: what it sets, a read of this file cannot see. */
const LOCAL_IMPORT_RE =
  /\bfrom\s*['"]\.|\bimport\s*\(\s*['"]\.|\brequire\s*\(\s*['"]\.|^\s*import\s*['"]\./m;

/** A vitest workspace or projects file: each project may set its own root. */
const PROJECTS_FILE_RE = /^vitest\.(?:workspace|projects)\.[\w.]+$/;

/** More changed files than this, and the related tests are the suite. */
const MAX_CHANGED_FILES = 200;

/**
 * More distinct basenames than this, and the name scan is not run: it reads
 * the whole tree once per name (about 40 ms each on this repo), and a diff
 * this wide relates most of a suite anyway.
 */
const MAX_LOOKUPS = 64;

/** More paths than this on one command, and the suite runs whole instead. */
const MAX_COMMAND_PATHS = 400;

/** Past this many files the name scan stops, and every suite runs whole. */
const MAX_SCANNED_FILES = 50_000;

/** A module larger than this is generated, not one that reads a doc. */
const MAX_SCANNED_BYTES = 8 * 1024 * 1024;

/**
 * Why every suite must run whole for this diff, or undefined when the
 * related tests can stand in for them.
 */
export function wholeSuiteReason(
  root: string,
  changed: readonly string[],
  renamedFrom: readonly string[],
  ownerOf: (file: string) => string | null,
): string | undefined {
  if (changed.length > MAX_CHANGED_FILES) {
    return `it changes ${changed.length} files`;
  }
  if (renamedFrom.length > 0) return `it renames ${renamedFrom[0]}`;
  for (const file of changed) {
    if (
      WHOLE_SUITE_TRIGGER_RE.test(file) ||
      isManifest(file, ownerOf) ||
      (SETUP_FILE_RE.test(file) && !/(?:^|\/)src\//.test(file))
    ) {
      return `it changes ${file}`;
    }
    // The plan names a deleted file by its old path.
    if (!existsSync(join(root, file))) return `it deletes ${file}`;
  }
  return undefined;
}

/** The root manifest, or a workspace's own: one at the dir it owns. */
function isManifest(
  file: string,
  ownerOf: (file: string) => string | null,
): boolean {
  if (posix.basename(file) !== 'package.json') return false;
  const dir = posix.dirname(file);
  return dir === '.' || ownerOf(file) === dir;
}

/**
 * The `--config` a test script names, `''` for none, or undefined when the
 * script is not one `vitest related` can stand in for.
 */
export function vitestRunConfig(
  script: string | undefined,
): string | undefined {
  const m = VITEST_RUN_RE.exec((script ?? '').trim().replace(/\s+/g, ' '));
  return m ? (m[1] ?? '') : undefined;
}

interface Manifest {
  scripts?: Record<string, unknown>;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
}

/** `dir`'s manifest, or undefined when it cannot be read. */
function manifestOf(root: string, dir: string): Manifest | undefined {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(join(root, dir, 'package.json'), 'utf8'),
    );
    return typeof pkg === 'object' && pkg !== null
      ? (pkg as Manifest)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of the config vitest reads for `dir` — the one its script names,
 * or the first it would find — `''` when there is none, or undefined when
 * the named one is missing or unreadable.
 */
function configTextOf(
  root: string,
  dir: string,
  named: string,
): string | undefined {
  const candidates = named ? [named] : DEFAULT_CONFIGS;
  for (const name of candidates) {
    const file = join(root, dir, name);
    if (!existsSync(file)) continue;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }
  return named ? undefined : '';
}

/**
 * Whether a dependency's entry is its source: every code path its manifest's
 * `main`/`module`/`exports` name is a TypeScript file or lies under `src/`.
 * Then a test importing it by package name is in the graph of its source.
 * Non-code subpaths (`"./package.json"`, a stylesheet) are not what a test
 * imports a package by, so a package that also exports them can still be
 * source.
 */
function entryIsSource(manifest: Manifest | undefined): boolean {
  const paths = entryPathsOf(manifest).filter((p) => SCRIPT_RE.test(p));
  return (
    paths.length > 0 &&
    paths.every((p) => /\.[cm]?tsx?$/.test(p) || /^src\//.test(p))
  );
}

/** Every path a manifest's `main`/`module`/`exports` name, normalised. */
function entryPathsOf(manifest: Manifest | undefined): string[] {
  const paths: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string') paths.push(posix.normalize(v));
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === 'object' && v !== null) {
      Object.values(v).forEach(collect);
    }
  };
  collect([manifest?.main, manifest?.module, manifest?.exports]);
  return [...new Set(paths)];
}

/** A module whose build output a package's entry can carry. */
const BUILT_RE = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * Where a package's build put a changed file, repo-relative: its compiled
 * counterpart under the directory the entry points into (`src/x.ts` →
 * `dist/src/x.js` or `dist/x.js`), or — when none exists, as for a bundle —
 * every JavaScript entry the manifest names. `[]` for a package whose entry
 * is its source, or for a file no build carries; undefined when the build
 * output cannot be found, and then the suite runs whole. A test importing
 * the package by name has this output in its graph, not the source.
 */
function buildOutputOf(
  root: string,
  pkg: string,
  file: string,
): string[] | undefined {
  const manifest = manifestOf(root, pkg);
  // No entry, nothing to import it by; a source entry is in the graph as is.
  if (
    entryPathsOf(manifest).length === 0 ||
    entryIsSource(manifest) ||
    !BUILT_RE.test(file)
  ) {
    return [];
  }
  const exists = (p: string): boolean => existsSync(join(root, pkg, p));
  const entries = entryPathsOf(manifest).filter(
    (p) => /\.[cm]?js$/.test(p) && !p.startsWith('../') && exists(p),
  );
  const rel = pkg === '.' ? file : posix.relative(pkg, file);
  const js = rel
    .replace(/\.mts$/, '.mjs')
    .replace(/\.cts$/, '.cjs')
    .replace(/\.tsx?$/, '.js');
  const outDirs = [...new Set(entries.map((p) => p.split('/')[0]))].filter(
    (d) => d !== '.' && !d.endsWith('.js'),
  );
  const counterparts = outDirs
    .flatMap((d) => [`${d}/${js}`, `${d}/${js.replace(/^src\//, '')}`])
    .filter(exists);
  const found = counterparts.length > 0 ? counterparts : entries;
  if (found.length === 0) return undefined;
  return [...new Set(found)].map((p) => (pkg === '.' ? p : `${pkg}/${p}`));
}

/**
 * The basenames a config's `setupFiles`/`globalSetup` name: what runs before
 * every test of the suite, imported by none. Read off the text after each
 * key — wider than the value at worst, which only keeps more suites whole.
 */
function setupNamesOf(configText: string): Set<string> {
  const names = new Set<string>();
  for (const m of configText.matchAll(/\b(?:setupFiles|globalSetup)\s*:/g)) {
    const after = configText.slice(m.index + m[0].length, m.index + 400);
    for (const q of after.matchAll(/['"\x60]([^'"\x60\n]+)['"\x60]/g)) {
      if (SCRIPT_RE.test(q[1])) names.add(posix.basename(q[1]));
    }
  }
  return names;
}

/**
 * Whether `npm exec` in `dir` runs the `vitest` its `npm test` would. npm
 * exec looks in the root's `node_modules/.bin` only — never the workspace's
 * own (measured, npm 10.9) — and with none there it wants the registry. So
 * the root must have one, and no `.bin` between the workspace and the root
 * may hold a different one.
 */
function sameVitest(root: string, dir: string): boolean {
  const binOf = (at: string): string | undefined => {
    for (const name of ['vitest', 'vitest.cmd']) {
      const file = join(root, at, 'node_modules', '.bin', name);
      if (existsSync(file)) return file;
    }
    return undefined;
  };
  const rootBin = binOf('.');
  if (!rootBin) return false;
  const rootTarget = vitestTargetOf(rootBin);
  if (rootTarget === undefined) return false;
  for (let at = dir; at !== '.' && at !== ''; at = posix.dirname(at)) {
    const own = binOf(at);
    if (!own) continue;
    if (vitestTargetOf(own) !== rootTarget) return false;
  }
  return true;
}

/**
 * The vitest a `.bin/vitest` runs. A symlink resolves to the module itself.
 * pnpm (and npm on some layouts) instead writes a small launcher per install
 * root, each `exec`ing its own relative path to the same `vitest.mjs`; two
 * such launchers have different real paths while running one and the same
 * vitest, so identity is the module a launcher names, not the launcher.
 */
function vitestTargetOf(bin: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    return undefined;
  }
  // The module itself: a link already resolved to it.
  if (SCRIPT_RE.test(real)) return real;
  let text: string;
  try {
    text = readFileSync(real, 'utf8');
  } catch {
    return real;
  }
  // pnpm appends metadata as a comment (`# cmd-shim-target=/…/vitest.mjs`):
  // it names a vitest, but not one this launcher executes. Drop comment lines,
  // and any `key=value` token — an option or a metadata field, not a path.
  const body = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const named = [...body.matchAll(/[^\s"']*vitest[^\s"']*\.(?:mjs|cjs|js)/g)]
    .map((m) => m[0])
    .filter((p) => !p.startsWith('-') && !p.includes('='))
    .map((p) => p.replace(/^\$basedir[\\/]/, '').replace(/^%~dp0[\\/]?/i, ''));
  const last = named.at(-1);
  if (last === undefined) return real;
  try {
    return realpathSync(join(dirname(real), last));
  } catch {
    return undefined;
  }
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every script in the tree that names one of `basenames` — as a path's last
 * segment or a quoted name, not inside a longer one — by repo-relative path,
 * or undefined when the tree is too large to read. Skips `node_modules`,
 * build output and dot-directories, and never follows a symlink: the tree is
 * the pull request's, and a link out of it is not its code.
 */
export function filesNaming(
  root: string,
  basenames: readonly string[],
): Map<string, string[]> | undefined {
  const found = new Map(basenames.map((b) => [b, [] as string[]]));
  if (basenames.length === 0) return found;
  if (basenames.length > MAX_LOOKUPS) return undefined;
  // The name as written, and as a regex spells it (`guide\.md`).
  const patterns = basenames.map((b) => {
    const escaped = b.replace(/\./g, '\\.');
    const forms = escaped === b ? [b] : [b, escaped];
    const re = new RegExp(
      String.raw`(?:^|[\\/'"\x60\s(,=^])(?:${forms.map(escapeRe).join('|')})(?![\w.-])`,
    );
    return [b, forms, re] as const;
  });
  let seen = 0;
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (
          e.name.startsWith('.') ||
          e.name === 'node_modules' ||
          e.name === 'dist' ||
          e.name === 'coverage'
        ) {
          continue;
        }
        if (!walk(rel)) return false;
        continue;
      }
      if (!e.isFile() || !SCRIPT_RE.test(e.name)) continue;
      if (++seen > MAX_SCANNED_FILES) return false;
      let text: string;
      try {
        if (statSync(join(root, rel)).size > MAX_SCANNED_BYTES) continue;
        text = readFileSync(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      for (const [b, forms, re] of patterns) {
        if (forms.some((f) => text.includes(f)) && re.test(text)) {
          found.get(b)!.push(rel);
        }
      }
    }
    return true;
  };
  return walk('') ? found : undefined;
}

/** What one suite's related run is handed. */
export interface RelatedSelection {
  /** The `--config` its script names, `''` for none. */
  config: string;
  /** The changed files and the files that name one, relative to its dir. */
  paths: string[];
}

export interface RelatedTestsInput {
  root: string;
  /** The diff's files, repo-relative — a deletion by its old path. */
  changed: readonly string[];
  /** The old paths of the files the diff renames. */
  renamedFrom: readonly string[];
  /** The workspace a repo-relative path lives in, or null outside them all. */
  ownerOf: (file: string) => string | null;
  /** The dirs a suite can import from: its own, and what it depends on. */
  reachOf: (dir: string) => readonly string[];
}

export interface RelatedTests {
  /** Why every suite runs whole, when one must. */
  reason: string | undefined;
  /** Whether `dir`'s test script is one a related run could stand in for. */
  narrowable(dir: string): boolean;
  /** `dir`'s related run, or undefined when its whole suite runs. */
  select(dir: string): RelatedSelection | undefined;
  /**
   * Why `dir` runs whole, when it could have run related — the diff-level
   * `reason`, or the gate that stopped it. Undefined for a suite with no
   * vitest `test` script of its own.
   */
  bailReason(dir: string): string | undefined;
}

/**
 * The related-test selection for one run. Pure in the tree and the plan, so
 * a `--resume` that rebuilds it picks the same tests the first call did.
 */
export function relatedTests(input: RelatedTestsInput): RelatedTests {
  const { root, changed, ownerOf } = input;
  const reason = wholeSuiteReason(root, changed, input.renamedFrom, ownerOf);
  // Every changed file, source too: a test can assert a source file's text
  // (`build-budget.test.ts` reads `agent-prompt.ts`) without importing it.
  const lookups = [...new Set(changed.map((f) => posix.basename(f)))];
  let naming: Map<string, string[]> | null | undefined = null;
  const named = (): Map<string, string[]> | undefined => {
    if (naming === null) naming = filesNaming(root, lookups);
    return naming;
  };
  const scriptOf = (manifest: Manifest | undefined): string | undefined => {
    const script = manifest?.scripts?.['test'];
    return typeof script === 'string' ? script : undefined;
  };
  const narrowable = (dir: string): boolean =>
    vitestRunConfig(scriptOf(manifestOf(root, dir))) !== undefined;
  // Every gate that stops a suite says so: a report that ran everything whole
  // should name the knob an operator can act on (a cap, a pretest, a config).
  const selectionIn = (
    dir: string,
  ): { selection?: RelatedSelection; bail?: string } => {
    if (reason !== undefined) return { bail: reason };
    const manifest = manifestOf(root, dir);
    const config = vitestRunConfig(scriptOf(manifest));
    if (config === undefined) return {};
    // `npm test` runs these around the script; `npm exec` does not.
    if (manifest?.scripts?.['pretest'] || manifest?.scripts?.['posttest']) {
      return { bail: 'it runs a pretest or posttest script' };
    }
    if (!sameVitest(root, dir)) {
      return { bail: 'npm exec would run a different vitest than npm test' };
    }
    // A config named outside vitest's own names is no trigger by name.
    if (config && changed.includes(posix.join(dir, config))) {
      return { bail: 'the diff changes the config its test script names' };
    }
    const configText = configTextOf(root, dir, config);
    if (configText === undefined) {
      return { bail: 'its vitest config cannot be read' };
    }
    if (
      ROOT_KEY_RE.test(configText) ||
      PROJECTS_KEY_RE.test(configText) ||
      LOCAL_IMPORT_RE.test(configText)
    ) {
      return {
        bail:
          'its vitest config sets a root or projects, or imports a local ' +
          'module',
      };
    }
    try {
      if (readdirSync(join(root, dir)).some((n) => PROJECTS_FILE_RE.test(n))) {
        return { bail: 'a vitest workspace or projects file sits beside it' };
      }
    } catch {
      return { bail: 'its directory cannot be read' };
    }
    const setupNames = setupNamesOf(configText);
    if (changed.some((f) => setupNames.has(posix.basename(f)))) {
      return { bail: 'the diff changes a setup file its config names' };
    }
    const reach = new Set(input.reachOf(dir));
    const reachable = (file: string): boolean => {
      const owner = ownerOf(file);
      return owner === null || owner === dir || reach.has(owner);
    };
    // A path no command can carry runs the suite whole where the suite can
    // import it; outside every workspace it is only left off the list. In a
    // single-root repo every path is in reach (there is no owner to name), so
    // only the root suite — the only one — escalates.
    const carried = changed.filter((f) => PATH_TOKEN_RE.test(f));
    if (
      changed.some(
        (f) =>
          !PATH_TOKEN_RE.test(f) &&
          reachable(f) &&
          (ownerOf(f) !== null || dir === '.'),
      )
    ) {
      return { bail: 'a changed path cannot be carried on the command line' };
    }
    if (carried.length > MAX_COMMAND_PATHS) {
      return { bail: 'the diff changes more paths than one command can carry' };
    }
    const byName = named();
    if (byName === undefined) {
      return {
        bail: 'the diff changes more distinct names than the lookup scans',
      };
    }
    const inDir = (file: string): boolean => {
      const owner = ownerOf(file);
      return dir === '.' ? owner === null : owner === dir;
    };
    const snapshotTests = changed.flatMap((f) => {
      const m = SNAPSHOT_RE.exec(f);
      const test = m ? `${m[1] ?? ''}${m[2]}` : undefined;
      return test && existsSync(join(root, test)) ? [test] : [];
    });
    // A test file runs only in its own suite; a module joins wherever the
    // suite can import it from. Outside every workspace counts as
    // importable: a root-level helper has no manifest to say who uses it.
    const namers = [...[...byName.values()].flat(), ...snapshotTests].filter(
      (file) => (TEST_FILE_RE.test(file) ? inDir(file) : reachable(file)),
    );
    // What a test importing a package by name has in its graph: the
    // package's build output, beside the source the diff names.
    const built: string[] = [];
    for (const file of [...carried, ...namers]) {
      // In a single-root repo every path's owner is null — the one package IS
      // the root, and `buildOutputOf(root, '.', file)` is its own build
      // output. In a multi-root repo an ownerless path belongs to the root
      // package, so only the root suite carries that output.
      const owner = ownerOf(file) ?? (dir === '.' ? '.' : null);
      if (owner === null || TEST_FILE_RE.test(file) || !reachable(file)) {
        continue;
      }
      const output = buildOutputOf(root, owner, file);
      if (output === undefined) {
        return { bail: 'a package it imports has no build output to name' };
      }
      built.push(...output);
    }
    const relative = (file: string): string =>
      dir === '.' ? file : posix.relative(dir, file);
    const paths = [
      ...new Set([...carried, ...namers, ...built].map(relative)),
    ].sort();
    // Nothing related: the whole suite is the honest run, not a bail anyone
    // can act on.
    if (paths.length === 0) return {};
    if (paths.length > MAX_COMMAND_PATHS) {
      return {
        bail: 'its related tests take more paths than one command can carry',
      };
    }
    if (!paths.every((p) => PATH_TOKEN_RE.test(p))) {
      return { bail: 'a related path cannot be carried on the command line' };
    }
    return { selection: { config, paths } };
  };
  const select = (dir: string): RelatedSelection | undefined =>
    selectionIn(dir).selection;
  const bailReason = (dir: string): string | undefined => selectionIn(dir).bail;
  return { reason, narrowable, select, bailReason };
}
