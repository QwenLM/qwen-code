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
// review command changed, fired by an edit to a file the bundle cannot
// contain, which is the one thing this check must never do.
//
// So the rule stops being a list somebody remembers to extend. This asserts
// the property the list is trying to approximate: every file the digest folds
// in is reachable from production code, and nothing reachable is left out.
//
// The walk is over the real working tree, so it needs a full checkout: a
// sparse or partial clone fails this test without anything being wrong.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Whether a static `import`/`export … from` clause is a statement-level
 * type-only form esbuild erases wholesale: a leading `type` with a clause of
 * type-import shape — `type {…}`, `type *…`, or `type` plus exactly one
 * identifier. Under this repo's `verbatimModuleSyntax` a specifier-level
 * `type` prefix is NOT that form: esbuild erases only the specifier and keeps
 * the statement as a side-effect import, so `import { type T } from './b.js'`
 * still puts `b.js` in the bundle, and every named clause is an edge.
 * Counting an erased statement as an edge would fold a never-bundled module
 * into what production imports — a file the digest hashes but the bundle
 * cannot contain passing the guard that exists to reject it.
 */
function isTypeOnlyClause(clause: string): boolean {
  return /^\s*type\s+(?:[{*]|[A-Za-z_$][\w$]*\s*$)/.test(clause);
}

/**
 * The source with comments dropped, which is what the scans below must read:
 * esbuild's lexer ignores comments, so a comment inside a multi-line import
 * clause must neither hide the edge (a comment carrying `;` or `'` defeats
 * the clause capture for the whole statement) nor fake one (a comment-
 * decorated `import type …` would escape `isTypeOnlyClause` and count a
 * clause esbuild erases). String and template literals match first and are
 * returned verbatim, so a `/*` or a `// …` line inside a literal — the
 * agent prompts embed both — never triggers the comment arms.
 */
function stripComments(src: string): string {
  return src.replace(
    /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => (m.startsWith('/') ? ' ' : m),
  );
}

const isTest = (f: string) => NOT_BUNDLED_RE.test(basename(f));
const isFixture = (f: string) =>
  relative(reviewDir, f)
    .split(sep)
    .some((part) => NOT_BUNDLED_DIR.has(part));

/** The modules `f` imports from within this repo, resolved to real paths. */
function localImports(f: string): string[] {
  const src = stripComments(readFileSync(f, 'utf8'));
  const specs: string[] = [];
  // `from '…'` / `export … from '…'`, `await import('…')` — the directory
  // has nine dynamic edges, and a helper reached only that way would be
  // invisible here — and bare `import '…'`, which esbuild bundles for its
  // side effects. Statement-level type-only forms (`import type …`,
  // `export type …`) are the opposite gap: esbuild erases them wholesale, so
  // counting one folds a never-bundled file into what production imports.
  // Specifier-level `type` prefixes are edges, not that gap — see
  // `isTypeOnlyClause`.
  for (const m of src.matchAll(
    /\b(import|export)\b([^;'"]*)\bfrom\s+'(\.[^']+)'/g,
  )) {
    if (!isTypeOnlyClause(m[2])) specs.push(m[3]);
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*'(\.[^']+)'\s*\)/g))
    specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s+'(\.[^']+)'/g)) specs.push(m[1]);

  const out: string[] = [];
  for (const raw of specs) {
    // The literal specifier first — `'./data.json'` keeps its extension, and
    // a NodeNext `.mts` module is imported as `'./foo.mjs'` — then every
    // extension the digest admits, with and without an `index` file, because
    // esbuild resolves `./sub.ts` and `./sub/index.tsx` alike. These two
    // lists must agree: a production module in an extension this closure
    // cannot resolve is digested but never lands in `reachable`, and a
    // correct change reddens this test with a wrong diagnosis.
    const spec = raw.replace(/\.(?:m|c)?jsx?$/, '');
    const candidates = [
      resolve(dirname(f), raw),
      ...[...DIGESTED_EXTENSIONS.code].flatMap((ext) => [
        resolve(dirname(f), spec + ext),
        resolve(dirname(f), spec, `index${ext}`),
      ]),
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

  // What production reaches — the transitive closure from `review.ts`, not a
  // flat union of every file's direct imports: a mutually-importing cluster
  // of production-named files that nothing else imports passes a union while
  // never reaching the bundle. `review.ts` sits outside this directory and
  // is where every subcommand is registered; leaving it out makes each
  // command look test-only, which is what the first draft of this guard did.
  // The closure is seeded from `review/` plus `review.ts`: the day a review
  // lib is imported from outside that closure, files here read as
  // unreachable and this test fails on a change that is correct — widen the
  // closure before believing the finding.
  const reachable = new Set<string>();
  {
    const queue = [join(reviewDir, '..', 'review.ts')];
    while (queue.length > 0) {
      const from = queue.shift()!;
      if (reachable.has(from)) continue;
      reachable.add(from);
      for (const dep of localImports(from)) queue.push(dep);
    }
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
      (f) => !reachable.has(f) && !entryPoints.has(f),
    );
    expect(
      unreachable.map((f) => relative(repoRoot, f)),
      'an unimported file here is either test-only support or a scratch file — or the closure missed it: the scanner sees only single-quoted relative import literals and is seeded from review.ts, so widen the seed set before believing this finding',
    ).toEqual([]);
  });

  describe('the clause classifier reads imports the way esbuild does', () => {
    // The classifier is the oracle for what the bundle reaches; a clause
    // esbuild erases must not count as an edge, and one it keeps must.
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'digest-guard-'));
      writeFileSync(join(dir, 'b.ts'), 'export const v = 1;\n');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const edgesOf = (statement: string): string[] => {
      const importer = join(dir, 'a.ts');
      writeFileSync(importer, `${statement} from './b.js';\n`);
      return localImports(importer);
    };

    it('drops the clauses esbuild erases wholesale', () => {
      // Statement-level forms only — `import type …` / `export type …`.
      expect(edgesOf('import type { T }')).toEqual([]);
      expect(edgesOf('import type D')).toEqual([]);
      expect(edgesOf('import type * as ns')).toEqual([]);
      expect(edgesOf('export type { T }')).toEqual([]);
    });

    it('keeps the clauses esbuild does not erase', () => {
      const b = join(dir, 'b.ts');
      // A specifier-level `type` prefix erases only the specifier under
      // `verbatimModuleSyntax`; the statement survives as a side-effect
      // import, so the module IS in the bundle. Pinning the opposite
      // accused a future production module reached only through such a
      // clause of being test-only scratch — and blocked the classifier fix.
      expect(edgesOf('import { type T }')).toEqual([b]);
      expect(edgesOf('import { type T, type U }')).toEqual([b]);
      expect(edgesOf('export { type T }')).toEqual([b]);
      // `type` is an identifier here, not the modifier: `type` followed by
      // `as` is an import OF an export named `type`, and a bare `type`
      // before `from` (or before `, {`) is a default import named `type`.
      expect(edgesOf('import { type as v }')).toEqual([b]);
      expect(edgesOf('import type')).toEqual([b]);
      expect(edgesOf('import type, { v }')).toEqual([b]);
      expect(edgesOf('import { type T, v }')).toEqual([b]);
      expect(edgesOf('import D, { type T }')).toEqual([b]);
      expect(edgesOf('import { v }')).toEqual([b]);
    });

    it('reads through comments the way esbuild does', () => {
      const b = join(dir, 'b.ts');
      // A comment cannot rescue a clause esbuild erases…
      expect(edgesOf('import type /* note */ { T }')).toEqual([]);
      expect(edgesOf('import type /* note */ D')).toEqual([]);
      // …nor hide one it keeps.
      expect(edgesOf('import /* kept */ { v }')).toEqual([b]);
      // The clause capture stops at `;` and `'`, so a line comment inside a
      // multi-line clause carrying either drops the whole edge.
      const importer = join(dir, 'a.ts');
      writeFileSync(
        importer,
        `import {\n  v, // drive's copy; keep in sync\n} from './b.js';\n`,
      );
      expect(localImports(importer)).toEqual([b]);
    });

    it('does not count import-shaped text inside string literals', () => {
      // The scanner is a heuristic over single-quoted specifiers; a literal
      // quoting an import is the class of edge esbuild never follows. A
      // single-quoted literal cannot hold such a specifier without escaping
      // it, which the scans do not match.
      const importer = join(dir, 'a.ts');
      writeFileSync(importer, `const s = 'import D from "./b.js";';\n`);
      expect(localImports(importer)).toEqual([]);
    });
  });

  it('leaves out nothing production imports', () => {
    // The other direction: an exclusion that overshoots would stop the check
    // seeing a real change. Anything production imports must survive the
    // filters — so `excluded` is the exact complement of what the walk folds
    // in, not a restatement of any single rule.
    const digested = new Set(digestedFiles);
    const excluded = files.filter((f) => !digested.has(f));
    const wronglyExcluded = excluded.filter((f) => reachable.has(f));
    expect(wronglyExcluded.map((f) => relative(repoRoot, f))).toEqual([]);
  });
});
