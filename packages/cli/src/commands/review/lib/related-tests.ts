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
//   vitest/vite config, a setup file, a manifest, the lockfile, a tsconfig,
//   a dependency patch — or a file the diff deletes or renames away, which
//   takes the old edges with it. Each of these runs every suite whole.
// - A path the graph spells differently from the diff: vitest resolves the
//   list against its configured `root`, and a dependency imported by package
//   name is its build output (`dist/…`), not the source the diff changed.
//   A suite whose config moves its root, or that imports a changed
//   dependency without aliasing it to source, runs whole.
// - A suite whose npm `pretest`/`posttest` must run: `npm exec` runs neither.
//   It runs whole.
// - A test that lists a directory without naming the file in it. Nothing
//   here finds that one; the report says so (`relatedTestsSentence`).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * The test scripts `vitest related` stands in for: vitest's one-shot run,
 * naming at most its config. Anything else — another runner, a wrapper, an
 * env prefix, a filter or a flag — keeps its whole suite, as written.
 */
const VITEST_RUN_RE =
  /^vitest(?: run| --run)?(?: --config(?:=| )((?!-)[\w@./-]+))?$/;

/**
 * A path the command can carry: nothing a shell expands inside double
 * quotes, and nothing vitest would read as a flag.
 */
const PATH_TOKEN_RE = /^(?!-)[\w@./-]+$/;

/**
 * Changes that reach every test without being imported by one. The setup
 * clause spares test files: `globalSetup.test.ts` tests a setup, and is in
 * the graph like any other test.
 */
const WHOLE_SUITE_TRIGGER_RE = new RegExp(
  [
    String.raw`(?:^|/)package\.json$`,
    String.raw`(?:^|/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|pnpm-workspace\.yaml|\.npmrc)$`,
    String.raw`(?:^|/)tsconfig[^/]*\.json$`,
    String.raw`(?:^|/)vite(?:st)?(?:\.[\w-]+)*\.(?:config|workspace|projects)\.[cm]?[jt]s$`,
    String.raw`(?:^|/)(?![^/]*\.(?:test|spec)\.)[^/]*setup[^/]*\.[cm]?[jt]sx?$`,
    String.raw`(?:^|/)patches/`,
  ].join('|'),
  'i',
);

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

/** A config key or shorthand that sets vitest's `root`. */
const ROOT_KEY_RE = /\broot\s*:|[{,]\s*root\s*[,}]/;

/** An import of a local module: what it sets, a read of this file cannot see. */
const LOCAL_IMPORT_RE =
  /\bfrom\s*['"]\.|\bimport\s*\(\s*['"]\.|\brequire\s*\(\s*['"]\.|^\s*import\s*['"]\./m;

/** A vitest workspace or projects file: each project may set its own root. */
const PROJECTS_FILE_RE = /^vitest\.(?:workspace|projects)\.[\w.]+$/;

/** More changed files than this, and the related tests are the suite. */
const MAX_CHANGED_FILES = 200;

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
): string | undefined {
  if (changed.length > MAX_CHANGED_FILES) {
    return `it changes ${changed.length} files`;
  }
  if (renamedFrom.length > 0) return `it renames ${renamedFrom[0]}`;
  for (const file of changed) {
    if (!PATH_TOKEN_RE.test(file)) {
      return `${JSON.stringify(file)} cannot be passed to vitest as written`;
    }
    if (WHOLE_SUITE_TRIGGER_RE.test(file)) return `it changes ${file}`;
    // The plan names a deleted file by its old path.
    if (!existsSync(join(root, file))) return `it deletes ${file}`;
  }
  return undefined;
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
 * Whether a dependency's entry is its source: every path its manifest's
 * `main`/`module`/`exports` name is a TypeScript file or lies under `src/`.
 * Then a test importing it by package name is in the graph of its source.
 */
function entryIsSource(manifest: Manifest | undefined): boolean {
  const paths: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string') paths.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === 'object' && v !== null) {
      Object.values(v).forEach(collect);
    }
  };
  collect([manifest?.main, manifest?.module, manifest?.exports]);
  return (
    paths.length > 0 &&
    paths.every((p) => /\.[cm]?tsx?$/.test(p) || /^(?:\.\/)?src\//.test(p))
  );
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
  const patterns = basenames.map(
    (b) =>
      [
        b,
        new RegExp(String.raw`(?:^|[\\/'"\x60\s(,=])${escapeRe(b)}(?![\w.-])`),
      ] as const,
  );
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
      for (const [b, re] of patterns) {
        if (text.includes(b) && re.test(text)) found.get(b)!.push(rel);
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
  /** `dir`'s related run, or undefined when its whole suite runs. */
  select(dir: string): RelatedSelection | undefined;
}

/**
 * The related-test selection for one run. Pure in the tree and the plan, so
 * a `--resume` that rebuilds it picks the same tests the first call did.
 */
export function relatedTests(input: RelatedTestsInput): RelatedTests {
  const { root, changed } = input;
  const reason = wholeSuiteReason(root, changed, input.renamedFrom);
  // Every changed file, source too: a test can assert a source file's text
  // (`build-budget.test.ts` reads `agent-prompt.ts`) without importing it.
  const lookups = [...new Set(changed.map((f) => posix.basename(f)))];
  let naming: Map<string, string[]> | null | undefined = null;
  const named = (): Map<string, string[]> | undefined => {
    if (naming === null) naming = filesNaming(root, lookups);
    return naming;
  };
  const select = (dir: string): RelatedSelection | undefined => {
    if (reason !== undefined) return undefined;
    const manifest = manifestOf(root, dir);
    const script = manifest?.scripts?.['test'];
    const config = vitestRunConfig(
      typeof script === 'string' ? script : undefined,
    );
    if (config === undefined) return undefined;
    // `npm test` runs these around the script; `npm exec` does not.
    if (manifest?.scripts?.['pretest'] || manifest?.scripts?.['posttest']) {
      return undefined;
    }
    // A config named outside vitest's own names is no trigger by name.
    if (config && changed.includes(posix.join(dir, config))) return undefined;
    const configText = configTextOf(root, dir, config);
    if (
      configText === undefined ||
      ROOT_KEY_RE.test(configText) ||
      LOCAL_IMPORT_RE.test(configText)
    ) {
      return undefined;
    }
    try {
      if (readdirSync(join(root, dir)).some((n) => PROJECTS_FILE_RE.test(n))) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    const byName = named();
    if (byName === undefined) return undefined;
    const reach = new Set(input.reachOf(dir));
    /** A dependency this suite's tests import as source, not build output. */
    const asSource = new Map<string, boolean>();
    const importsSource = (dep: string): boolean => {
      let known = asSource.get(dep);
      if (known === undefined) {
        const rel = dir === '.' ? dep : posix.relative(dir, dep);
        known =
          configText.includes(`${rel}/src`) ||
          entryIsSource(manifestOf(root, dep));
        asSource.set(dep, known);
      }
      return known;
    };
    const inDir = (file: string): boolean => {
      const owner = input.ownerOf(file);
      return dir === '.' ? owner === null : owner === dir;
    };
    // A test file runs only in its own suite; a module joins wherever the
    // suite can import it from. Outside every workspace counts as
    // importable: a root-level helper has no manifest to say who uses it.
    const namers = [...byName.values()].flat().filter((file) => {
      if (TEST_FILE_RE.test(file)) return inDir(file);
      const owner = input.ownerOf(file);
      return owner === null || reach.has(owner);
    });
    // A changed file in a dependency the suite imports by package name is,
    // in the graph, that package's build output: the path the diff names
    // matches nothing there, and the tests that import it would not run.
    // Another package's test is no module anything imports.
    const unseen = [...changed, ...namers].some((file) => {
      if (TEST_FILE_RE.test(file)) return false;
      const owner = input.ownerOf(file);
      return (
        owner !== null &&
        owner !== dir &&
        reach.has(owner) &&
        !importsSource(owner)
      );
    });
    if (unseen) return undefined;
    const relative = (file: string): string =>
      dir === '.' ? file : posix.relative(dir, file);
    const paths = [...new Set([...changed, ...namers].map(relative))].sort();
    if (paths.length === 0 || paths.length > MAX_COMMAND_PATHS) {
      return undefined;
    }
    if (!paths.every((p) => PATH_TOKEN_RE.test(p))) return undefined;
    return { config, paths };
  };
  return { reason, select };
}
