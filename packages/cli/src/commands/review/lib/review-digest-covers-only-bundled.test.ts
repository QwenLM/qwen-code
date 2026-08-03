/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The digest must cover exactly the review sources the bundle contains.
//
// Deciding that by filename has now been wrong four times: `.test.ts` files,
// then `__fixtures__/`, then `lib/test-utils.ts` (test support with a
// production-looking name), then `.DS_Store`. Each was found by a reviewer
// after it shipped, and each produced the same failure — a warning that a
// review command changed, fired by an edit that cannot change a byte of the
// bundle, which is the one thing this check must never do.
//
// So the rule stops being a list somebody remembers to extend. This asserts
// the property the list is trying to approximate: every file the digest folds
// in is reachable from production code, and nothing reachable is left out.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  NOT_BUNDLED_DIR,
  NOT_BUNDLED_FILE,
  NOT_BUNDLED_RE,
} from './stale-bundle.js';

const repoRoot = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
);
const reviewDir = join(
  repoRoot,
  'packages',
  'cli',
  'src',
  'commands',
  'review',
);

/** Every file under `dir`, tests and fixtures included. */
function* allFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* allFiles(full);
    else if (e.isFile()) yield full;
  }
}

const isTest = (f: string) => NOT_BUNDLED_RE.test(basename(f));
const isFixture = (f: string) =>
  relative(reviewDir, f)
    .split(sep)
    .some((part) => NOT_BUNDLED_DIR.has(part));

/** The modules `f` imports from within this repo, resolved to real paths. */
function localImports(f: string): string[] {
  const src = readFileSync(f, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    const spec = m[1].replace(/\.js$/, '');
    for (const ext of ['.ts', '.tsx', '.mts', '/index.ts']) {
      const candidate = resolve(dirname(f), spec + ext);
      try {
        readFileSync(candidate);
        out.push(candidate);
        break;
      } catch {
        // try the next extension
      }
    }
  }
  return out;
}

describe('the staleness digest covers only what the bundle can contain', () => {
  const files = [...allFiles(reviewDir)];
  // Exactly what the digest folds in: the walk's three exclusions applied.
  const digestedFiles = files.filter(
    (f) => !isTest(f) && !isFixture(f) && !NOT_BUNDLED_FILE.has(basename(f)),
  );
  // Production for import purposes is anything that is not a test — an
  // excluded helper still counts as an importer when deciding reachability.
  const production = files.filter((f) => !isTest(f) && !isFixture(f));

  // What production code imports — including `review.ts`, which sits outside
  // this directory and is where every subcommand is registered. Leaving it out
  // makes each command look test-only, which is what the first draft of this
  // guard did.
  const importedByProduction = new Set<string>();
  for (const f of [
    ...production.filter((f) => !NOT_BUNDLED_FILE.has(basename(f))),
    join(reviewDir, '..', 'review.ts'),
  ]) {
    for (const dep of localImports(f)) importedByProduction.add(dep);
  }

  it('folds in no module that only tests import', () => {
    // `lib/test-utils.ts` is the one that got through: a `.ts` with no `.test.`
    // in its name, imported by two test files and nothing else. A future one
    // fails here instead of in a review.
    const digested = digestedFiles.filter((f) => extname(f) === '.ts');
    const importedBySomeTest = new Set<string>();
    for (const t of files.filter(isTest)) {
      for (const dep of localImports(t)) importedBySomeTest.add(dep);
    }
    const testOnly = digested.filter(
      (f) => !importedByProduction.has(f) && importedBySomeTest.has(f),
    );
    expect(testOnly.map((f) => relative(repoRoot, f))).toEqual([]);
  });

  it('leaves out nothing production imports', () => {
    // The other direction: an exclusion that overshoots would stop the check
    // seeing a real change. Anything production imports must survive the
    // filters.
    const excluded = files.filter(
      (f) => isTest(f) || isFixture(f) || NOT_BUNDLED_FILE.has(basename(f)),
    );
    const wronglyExcluded = excluded.filter((f) => importedByProduction.has(f));
    expect(wronglyExcluded.map((f) => relative(repoRoot, f))).toEqual([]);
  });
});
