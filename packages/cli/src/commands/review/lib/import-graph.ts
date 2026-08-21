/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// One import hop, for incremental review widening.
//
// An incremental round reviews `anchor..HEAD` — the fix — and skips everything
// the previous round already cleared. But "clean" was certified against the
// code as it stood THEN: a fix that changes a function's contract can break an
// unchanged caller two files away, and a scope that never re-opens the caller
// retires that breakage silently. So the incremental scope is widened by one
// import hop: every still-clean file that imports a changed file re-enters the
// review, briefed to check the interaction seam rather than re-reviewed from
// scratch.
//
// This is a HEURISTIC, and its failure directions are chosen deliberately:
//
// - The specifier scan is regex over source text, not a parse. A specifier
//   quoted in a comment or a string literal scans as an import; the cost is a
//   file reviewed once more than strictly needed. Widening errs toward
//   reviewing.
// - Resolution stops at one hop and does not follow re-export chains (a barrel
//   `index.ts` between caller and callee hides the edge). A missed edge means
//   a file the review skips exactly as the pre-widening scope skipped every
//   dependent; the floor never drops below what incremental review shipped
//   with.
// - Bare workspace-package imports (`@scope/pkg` with no subpath) resolve only
//   to the conventional entry candidates (`src/index.*`, `index.*`). A package
//   with an exports map pointing elsewhere contributes no edge, same floor.
// - `tsconfig` path aliases (`@/lib/utils`), `package.json#exports` subpath
//   rewrites, and declaration-file references are not consulted — each is a
//   per-repo config surface this scanner deliberately does not parse. An
//   alias yields a missed edge (the file keeps the pre-widening floor). An
//   exports map can also make the conventional-layout guesses below resolve
//   a subpath to a file the map actually routes elsewhere — a WRONG edge.
//   Its cost depends on the membership: one extra widened file when the true
//   target is absent, but DISPLACEMENT of the true seam when both are
//   present — the first-hit resolver returns the wrong file instead, and the
//   pairing the widening exists to check retires unreviewed under a scope
//   entry claiming the caller was covered. Literal-first candidate order
//   closes the emitted-extension shape of that displacement; `candidatesFor`
//   below names the mechanics.
//
// The scan reads files from the review worktree (post-change state), because
// the question is whether the caller AS IT NOW STANDS uses what changed.

import * as nodePath from 'node:path';

/** File-reading seam: the incremental scope passes worktree reads, tests pass a map. */
export type SourceReader = (repoRelPath: string) => string | null;

/**
 * Every module specifier the source mentions, deduplicated, order preserved.
 *
 * Four shapes: `import … from 'x'` / `export … from 'x'` (one regex — both
 * end in `from '<spec>'`), side-effect `import 'x'`, dynamic `import('x')`,
 * and CommonJS `require('x')`. Template-literal specifiers are dynamic values
 * and are ignored, as is anything spanning a newline.
 */
export function scanImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (spec: string) => {
    if (spec && !seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  };
  const patterns = [
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) push(m[2]);
  }
  return out;
}

/**
 * Extension candidates for a specifier, ESM-TS aware.
 *
 * This repo — like every NodeNext TypeScript workspace — imports `./x.js`
 * meaning `x.ts`: the specifier names the EMITTED file. Candidates are tried
 * in order and the first membership hit wins: the LITERAL specifier first —
 * the true edge whenever the file it names exists — then the extension
 * remaps, then the bare-specifier extension walk, then the directory-index
 * forms.
 */
const EXT_MAP: ReadonlyArray<[RegExp, string]> = [
  // BOTH TS source extensions for an emitted `.js`: under `react-jsx` a
  // `.tsx` file also emits `.js`, and this repo's UI layer imports
  // `./App.js` while only `App.tsx` exists. Measured before the second row
  // was added: 921 of 6,200 relative `.js` specifiers under packages/cli/src
  // named `.tsx` targets no edge could ever reach.
  [/\.js$/, '.ts'],
  [/\.js$/, '.tsx'],
  // …and `.jsx`: a JSX source in a JS project emits `.js` under the same
  // convention, so the emitted name names it too.
  [/\.js$/, '.jsx'],
  [/\.jsx$/, '.tsx'],
  [/\.mjs$/, '.mts'],
  [/\.cjs$/, '.cts'],
];
const EXT_WALK = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function candidatesFor(base: string): string[] {
  // The LITERAL specifier first, then the extension remaps. `resolveSpecifier`
  // takes the first membership hit, so order is precedence — and an `import
  // './util.js'` in a mixed JS/TS directory where BOTH `util.js` and
  // `util.ts` changed used to resolve to `util.ts`, the file the caller does
  // not import. That is not one extra widened file (the cost this module's
  // header budgets for a wrong edge); it DISPLACES the true edge, so the seam
  // brief points the agent at a pairing that does not exist while the real
  // one — caller × util.js — is named nowhere and retires unreviewed under a
  // `scope.interaction` entry claiming the caller was covered.
  //
  // The remaps still matter, and are still tried: `./x.js` in a TS project
  // usually names `x.ts`, because that is what the emit convention means. It
  // is only when the literal file EXISTS in the membership that it wins, and
  // there the literal is not a guess at all.
  const out: string[] = [base];
  for (const [re, ts] of EXT_MAP) {
    if (re.test(base)) out.push(base.replace(re, ts));
  }
  if (!/\.[a-z]+$/i.test(base)) {
    for (const ext of EXT_WALK) out.push(`${base}${ext}`);
    for (const ext of EXT_WALK) out.push(`${base}/index${ext}`);
  }
  return out;
}

/** POSIX-normalise a joined path and refuse escapes above the repo root. */
function repoJoin(dir: string, spec: string): string | null {
  const joined = nodePath.posix.normalize(nodePath.posix.join(dir, spec));
  // Segment-exact: a legal directory that merely BEGINS with two dots
  // (`..config/mod`) is not an escape, and `startsWith('..')` called it one.
  return joined === '..' || joined.startsWith('../') ? null : joined;
}

/**
 * A workspace package the resolver may route bare specifiers into:
 * `name` from its manifest, `dir` repo-relative (`''` for the root package).
 */
export interface WorkspacePackage {
  name: string;
  dir: string;
}

/**
 * Resolve one specifier to a repo-relative path, or null.
 *
 * `membership` is the only truth consulted — resolution never stats the disk.
 * The caller passes the set of paths it cares about (the review plan's files),
 * so "resolved" means "this specifier names a file in the review", which is
 * the exact question widening asks.
 */
export function resolveSpecifier(
  fromFile: string,
  spec: string,
  membership: ReadonlySet<string>,
  packages: readonly WorkspacePackage[] = [],
): string | null {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = repoJoin(nodePath.posix.dirname(fromFile), spec);
    if (base === null) return null;
    for (const c of candidatesFor(base)) if (membership.has(c)) return c;
    return null;
  }
  for (const pkg of packages) {
    if (spec === pkg.name) {
      // Bare entry import: conventional entry points only (see header).
      const roots = ['src/index', 'index'];
      for (const root of roots) {
        const base = pkg.dir === '' ? root : `${pkg.dir}/${root}`;
        for (const c of candidatesFor(base)) if (membership.has(c)) return c;
      }
      return null;
    }
    if (spec.startsWith(`${pkg.name}/`)) {
      // Normalised like a relative specifier: a legal subpath carrying `.`
      // or `..` segments otherwise builds a candidate string no
      // git-normalised membership path can equal, silently dropping the edge.
      const subRaw = spec.slice(pkg.name.length + 1);
      const subNorm = nodePath.posix.normalize(subRaw);
      // Segment-exact, exactly as `repoJoin` above is and for the same
      // reason: `..config/mod.js` normalises to itself, is a legal directory
      // name, and `startsWith('..')` called it an escape — dropping the
      // widening edge for that path and disabling the seam check this feature
      // exists to perform. The relative branch got the fix; this one did not.
      if (subNorm === '..' || subNorm.startsWith('../')) return null;
      const sub = subNorm;
      const base = pkg.dir === '' ? sub : `${pkg.dir}/${sub}`;
      for (const c of candidatesFor(base)) if (membership.has(c)) return c;
      // Deep imports into a package's emitted tree (`dist/…`) name build
      // output. Emit layouts differ per package — some emit `src/x.ts` to
      // `dist/x.js` (strip dist, add src), this repo's packages emit it to
      // `dist/src/x.js` (strip dist, keep the rest) — so try the stripped
      // path both as-is and under `src/`. Without the strip at all, the
      // remap produced `<pkg>/src/dist/…`, matching nothing.
      const srcSub = sub.startsWith('dist/') ? sub.slice('dist/'.length) : sub;
      for (const base2 of [
        pkg.dir === '' ? srcSub : `${pkg.dir}/${srcSub}`,
        pkg.dir === '' ? `src/${srcSub}` : `${pkg.dir}/src/${srcSub}`,
      ]) {
        for (const c of candidatesFor(base2)) if (membership.has(c)) return c;
      }
      return null;
    }
  }
  return null;
}

/**
 * Discover the workspace packages the plan's files live in.
 *
 * For each file, the nearest ancestor directory whose `package.json` the
 * reader can produce a `name` from is its package; distinct packages are
 * returned root-last so `resolveSpecifier`'s first-match loop sees the most
 * specific dir first. The reader is a seam (worktree reads in production),
 * and every miss is fail-quiet: a file under no readable manifest simply
 * contributes no package, which only ever narrows the widening.
 */
export function discoverWorkspacePackages(
  files: readonly string[],
  readJson: (repoRelPath: string) => string | null,
): WorkspacePackage[] {
  const nameByDir = new Map<string, string | null>();
  const lookup = (dir: string): string | null => {
    const cached = nameByDir.get(dir);
    if (cached !== undefined) return cached;
    const raw = readJson(dir === '' ? 'package.json' : `${dir}/package.json`);
    let name: string | null = null;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name !== '') {
          name = parsed.name;
        }
      } catch {
        // Not a manifest; keep walking up.
      }
    }
    nameByDir.set(dir, name);
    return name;
  };
  const out = new Map<string, string>(); // dir → name, deduped
  for (const file of files) {
    let dir = nodePath.posix.dirname(file);
    if (dir === '.') dir = '';
    for (;;) {
      const name = lookup(dir);
      if (name !== null) {
        if (!out.has(dir)) out.set(dir, name);
        break;
      }
      if (dir === '') break;
      const parent = nodePath.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }
  return [...out.entries()]
    .sort(([a], [b]) => b.length - a.length)
    .map(([dir, name]) => ({ name, dir }));
}

/**
 * Which candidates import a changed file — the widening set.
 *
 * Returns `candidate → the changed files it imports` (non-empty lists only),
 * insertion-ordered by the candidates array. Candidates already in `changed`
 * are skipped: they are in the scope on their own account. A candidate whose
 * source cannot be read (deleted, binary, reader refused) contributes no
 * edges — same fail-quiet floor as every other miss here.
 */
export function dependentsOfChanged(
  changed: ReadonlySet<string>,
  candidates: readonly string[],
  read: SourceReader,
  packages: readonly WorkspacePackage[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (changed.has(candidate)) continue;
    const source = read(candidate);
    if (source === null) continue;
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const spec of scanImportSpecifiers(source)) {
      const resolved = resolveSpecifier(candidate, spec, changed, packages);
      if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved);
        hits.push(resolved);
      }
    }
    if (hits.length > 0) out.set(candidate, hits);
  }
  return out;
}
