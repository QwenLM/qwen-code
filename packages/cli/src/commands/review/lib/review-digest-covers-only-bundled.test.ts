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
//
// The walk is over the real working tree, so it needs a full checkout: a
// sparse or partial clone fails this test without anything being wrong.

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
  DIGESTED_EXTENSIONS,
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
  // `from '…'` and `await import('…')` alike — the directory has nine dynamic
  // edges, and a helper reached only that way would be invisible here.
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)'(\.[^']+)'/g)) {
    const spec = m[1].replace(/\.js$/, '');
    // The literal specifier first — `'./data.json'` keeps its extension —
    // then every extension the digest admits. These two lists must agree: a
    // production module in an extension this closure cannot resolve is
    // digested but never lands in `importedByProduction`, and a correct
    // change reddens this test with a wrong diagnosis.
    const candidates = [
      resolve(dirname(f), m[1]),
      ...[
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.mjs',
        '.json',
        '/index.ts',
      ].map((ext) => resolve(dirname(f), spec + ext)),
    ];
    for (const candidate of candidates) {
      try {
        readFileSync(candidate);
        out.push(candidate);
        break;
      } catch {
        // try the next candidate
      }
    }
  }
  return out;
}

describe('the staleness digest covers only what the bundle can contain', () => {
  const files = [...allFiles(reviewDir)];
  // Exactly what the digest folds in: the code roots' walk, extension
  // allowlist first and the test/fixture exclusions on top of it.
  const digestedFiles = files.filter(
    (f) =>
      DIGESTED_EXTENSIONS.code.has(extname(f)) &&
      !isTest(f) &&
      !isFixture(f) &&
      !NOT_BUNDLED_FILE.has(basename(f)),
  );

  // What production code imports — including `review.ts`, which sits outside
  // this directory and is where every subcommand is registered. Leaving it out
  // makes each command look test-only, which is what the first draft of this
  // guard did. The importer set is closed over `review/` plus `review.ts`:
  // the day a review lib is imported from outside that closure, files here
  // read as unreachable and this test fails on a change that is correct —
  // widen the closure before believing the finding.
  const importedByProduction = new Set<string>();
  for (const f of [...digestedFiles, join(reviewDir, '..', 'review.ts')]) {
    for (const dep of localImports(f)) importedByProduction.add(dep);
  }

  it('folds in no module that only tests import', () => {
    // `lib/test-utils.ts` is the one that got through: a `.ts` with no `.test.`
    // in its name, imported by two test files and nothing else. A future one
    // fails here instead of in a review.
    // Every extension, not just `.ts`: a test-only `.tsx` or `.mts` helper is
    // the same defect with a different suffix.
    // No `importedBySomeTest` conjunct: a file nothing imports at all is just
    // as unreachable from the bundle as one only tests import, and requiring a
    // test importer let an orphan through.
    const entryPoints = new Set([join(reviewDir, '..', 'review.ts')]);
    const unreachable = digestedFiles.filter(
      (f) => !importedByProduction.has(f) && !entryPoints.has(f),
    );
    expect(
      unreachable.map((f) => relative(repoRoot, f)),
      'an unimported file here is either test-only support or a scratch file — production code reaches the bundle only through an import',
    ).toEqual([]);
  });

  it('leaves out nothing production imports', () => {
    // The other direction: an exclusion that overshoots would stop the check
    // seeing a real change. Anything production imports must survive the
    // filters — so `excluded` is the exact complement of what the walk folds
    // in, not a restatement of any single rule.
    const digested = new Set(digestedFiles);
    const excluded = files.filter((f) => !digested.has(f));
    const wronglyExcluded = excluded.filter((f) => importedByProduction.has(f));
    expect(wronglyExcluded.map((f) => relative(repoRoot, f))).toEqual([]);
  });
});
