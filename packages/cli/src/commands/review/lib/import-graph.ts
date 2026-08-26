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


/** An identifier a seam binding can be — nothing flag- or operator-shaped. */
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Words an import clause carries that are never local bindings. */
const CLAUSE_NOISE = new Set(['type', 'typeof', 'default', 'as']);

/**
 * The local bindings an import clause introduces, from the text between the
 * statement keyword and its `from`. A heuristic in the same spirit as
 * `scanImportSpecifiers`, with the same chosen error directions: a name it
 * misses drops a usage line from the seam (the hunk near it may still enter
 * on another line), a name it over-collects marks one line too many — one
 * hunk reviewed once more than needed, never less than the unwidened floor.
 */
function clauseBindings(clause: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const name = raw.trim();
    if (IDENT_RE.test(name) && !CLAUSE_NOISE.has(name)) out.push(name);
  };
  const star = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (star) push(star[1]);
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const entry of braces[1].split(',')) {
      // `a as b` binds the LOCAL alias; `a` alone binds itself. `type x`
      // never reaches runtime, but its usage lines are still seam reads for
      // a reviewer, so type-only names are kept once the keyword is shed.
      const words = entry
        .trim()
        .split(/\s+/)
        .filter((w) => !CLAUSE_NOISE.has(w));
      if (words.length > 0) push(words[words.length - 1]);
    }
  }
  // The default import: the first identifier after the keyword, outside any
  // braces (`import a, { b } from …` — `a`; `import { b } from …` — none).
  const head = clause.split('{')[0];
  const def = /^\s*(?:import|export)\s+(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(
    head,
  );
  if (def) push(def[1]);
  return [...new Set(out)];
}

/**
 * The 1-based lines of `source` that touch its seam with the changed files:
 * every import/require statement whose specifier resolves into `changed`,
 * plus every line mentioning a binding such a statement introduces.
 *
 * This is the seam-bounded widening's oracle (#10104): a fix-audit round
 * republishes an interaction file's hunks only where they display one of
 * these lines. It shares `scanImportSpecifiers`' regex spirit and its
 * documented misses (template-literal specifiers, statements the patterns do
 * not spell), and adds its own: a binding renamed into a local alias after
 * import, or reached through a barrel, marks no line. Both directions were
 * chosen — a missed line drops one hunk from a republication the previous
 * round already cleared once, an extra line republishes one hunk more — and
 * the file itself always stays in scope with its brief, so the seam question
 * is asked even when no hunk survives.
 */
export function seamLines(
  fromFile: string,
  source: string,
  changed: ReadonlySet<string>,
  packages: readonly WorkspacePackage[] = [],
): number[] {
  const lineOf = (index: number): number => {
    let line = 1;
    for (let i = 0; i < index && i < source.length; i++) {
      if (source.charCodeAt(i) === 10) line++;
    }
    return line;
  };
  const marked = new Set<number>();
  const bindings = new Set<string>();
  const fromRe = /\bfrom\s*(['"])([^'"\n]+)\1/g;
  for (const m of source.matchAll(fromRe)) {
    if (resolveSpecifier(fromFile, m[2], changed, packages) === null) continue;
    marked.add(lineOf(m.index ?? 0));
    // The clause sits between the statement keyword and this `from`. The
    // nearest preceding keyword bounds it; a clause the scan cannot bound
    // contributes the statement line alone — fail toward fewer lines, which
    // the always-in-scope brief backstops.
    const at = m.index ?? 0;
    const start = Math.max(
      source.lastIndexOf('import', at),
      source.lastIndexOf('export', at),
    );
    if (start >= 0 && at - start <= 2000) {
      for (const name of clauseBindings(source.slice(start, at))) {
        bindings.add(name);
      }
    }
  }
  const callRe =
    /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)|\bimport\s*(['"])([^'"\n]+)\3/g;
  for (const m of source.matchAll(callRe)) {
    const spec = m[2] ?? m[4];
    if (resolveSpecifier(fromFile, spec, changed, packages) === null) continue;
    const at = m.index ?? 0;
    const line = lineOf(at);
    marked.add(line);
    // `const { a, b: c } = require('x')` / `const x = require('x')`: the
    // bindings sit BEFORE the call, on its own line.
    const lineStart = source.lastIndexOf('\n', at - 1) + 1;
    const before = source.slice(lineStart, at);
    const decl = /(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*$/.exec(
      before,
    );
    if (decl) {
      if (decl[2]) bindings.add(decl[2]);
      if (decl[1]) {
        for (const entry of decl[1].split(',')) {
          const words = entry.trim().split(/[:\s]+/).filter(Boolean);
          const name = words[words.length - 1];
          if (name && IDENT_RE.test(name)) bindings.add(name);
        }
      }
    }
  }
  if (bindings.size > 0) {
    // `$` is legal in the identifiers IDENT_RE admits and is a regex anchor,
    // and `\b` cannot bound a name that starts or ends with it (`store$.x`
    // never matched; a DIFFERENT identifier at end-of-line did). So the
    // names are escaped and the boundary is spelled explicitly: not
    // preceded/followed by an identifier character, `$` included.
    const escaped = [...bindings].map((b) => b.replace(/\$/g, '\\$'));
    const usage = new RegExp(
      `(?<![\\w$])(?:${escaped.join('|')})(?![\\w$])`,
    );
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (usage.test(lines[i])) marked.add(i + 1);
    }
  }
  return [...marked].sort((a, b) => a - b);
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
