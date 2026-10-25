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
//   the skill loader opens. Every module that names a changed file's
//   basename joins the list, so the tests that import it run.
// - A change that reaches every test without being imported by any — the
//   vitest/vite config, a setup file, a manifest, the lockfile, a tsconfig,
//   a dependency patch — or a file the diff deletes or renames away, which
//   takes the old edges with it. Each of these runs every suite whole.
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

/** `dir`'s own `test` script, read from its manifest. */
function testScriptOf(root: string, dir: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, dir, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, unknown> };
    const script = pkg.scripts?.['test'];
    return typeof script === 'string' ? script : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the graph covers a changed file: a script under a `src/` segment
 * is code the tests import. Anything else — a doc, a fixture, a schema, a
 * script a test spawns — is looked up by name too.
 */
const importedOnly = (file: string): boolean =>
  SCRIPT_RE.test(file) && /(?:^|\/)src\//.test(file);

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
  const lookups = [
    ...new Set(
      changed.filter((f) => !importedOnly(f)).map((f) => posix.basename(f)),
    ),
  ];
  let naming: Map<string, string[]> | null | undefined = null;
  const named = (): Map<string, string[]> | undefined => {
    if (naming === null) naming = filesNaming(root, lookups);
    return naming;
  };
  const select = (dir: string): RelatedSelection | undefined => {
    if (reason !== undefined) return undefined;
    const config = vitestRunConfig(testScriptOf(root, dir));
    if (config === undefined) return undefined;
    const byName = named();
    if (byName === undefined) return undefined;
    const reach = new Set(input.reachOf(dir));
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
