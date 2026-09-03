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
 * statement keyword and its `from`, or `null` when a brace entry the clause
 * carries does not parse to a binding: a silently skipped entry is an
 * unenumerated escape, and under-collection is the one error the seam bound
 * must not make (#10136). Over-collection stays the budgeted cost — a name
 * too many marks one line too many, never one fewer.
 */
function clauseBindings(clause: string): string[] | null {
  const out: string[] = [];
  // The noise filter applies where the words ARE keywords — a brace entry's
  // `type`/`typeof`/`default`/`as`. In the star and default positions the
  // name is the binding itself, keyword-shaped or not (`import * as type`,
  // `import type from`): filtering there dropped a real binding with no
  // doubt (#10136), so those positions bind whatever the grammar admits.
  const push = (raw: string) => {
    const name = raw.trim();
    if (IDENT_RE.test(name)) out.push(name);
  };
  const star = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (star) push(star[1]);
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const entry of braces[1].split(',')) {
      const name = entry.trim();
      if (name === '') continue; // a trailing comma binds nothing
      // `a as b` binds the LOCAL alias; `a` alone binds itself. `type x`
      // never reaches runtime, but its usage lines are still seam reads for
      // a reviewer, so type-only names are kept once the keyword is shed.
      const words = name.split(/\s+/).filter((w) => !CLAUSE_NOISE.has(w));
      const local = words[words.length - 1];
      if (local === undefined || !IDENT_RE.test(local)) return null;
      push(local);
    }
  }
  // The default import: the first identifier after the keyword, outside any
  // braces (`import a, { b } from …` — `a`; `import { b } from …` — none).
  // `type`/`typeof` right after the keyword is the type-only MODIFIER when a
  // name, a brace or a star follows it (`import type X`, `import type {`)
  // and the default binding itself otherwise (`import type from`,
  // `import type, { x } from`) — a name the grammar admits, not noise.
  const head = clause.split('{')[0];
  const def =
    /^\s*(?:import|export)\s+([A-Za-z_$][\w$]*)(?:\s+([A-Za-z_$][\w$]*)|\s*(,))?/.exec(
      head,
    );
  if (def) {
    const [, first, second, comma] = def;
    if (first !== 'type' && first !== 'typeof') push(first);
    else if (second !== undefined) push(second);
    else if (comma !== undefined || !/[{*]/.test(clause)) push(first);
  }
  return [...new Set(out)];
}

/** Words after which a `/` opens a regex literal, never a division. */
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
]);
/** Punctuator characters after which a `/` opens a regex literal. */
const REGEX_AFTER_PUNCT = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);
/** Words that open a block statement's `{` (its `}` ends a statement). */
const BLOCK_AFTER_WORDS = new Set(['else', 'try', 'finally', 'do']);
/** Words whose `(…)` is a control head: a `/` after its `)` opens a regex. */
const CONTROL_PAREN_WORDS = new Set(['if', 'while', 'for', 'with']);
const IDENT_CHAR_RE = /[\w$]/;

/**
 * A comment-stripped view of `source`, length- and newline-preserving:
 * every comment byte becomes a space, nothing else moves, so every position
 * and line number in it is the same position and line number in the source.
 * The seam scans run on THIS, because a keyword inside a comment used to
 * displace the clause-bound scan and parse the clause to the wrong bindings
 * (#10136) — comment-awareness is the scan's job, and one strip gives it to
 * every pattern at once.
 *
 * The walk is a lexer over the JavaScript lexical grammar, not a
 * comment-marker scan (#10136): a marker is a comment only in the CODE
 * state, and every other state is tracked, never guessed — string literals
 * with their escapes (an unterminated quote ends at its line), template
 * literals with `${…}` interpolations nested to any depth (the interpolation
 * is code again, braces and all, and a backtick inside it opens a NESTED
 * template, never closes the outer one), regex literals with their escapes
 * and character classes, and the shebang line. Whether a `/` opens a regex
 * or is a division is decided by the token before it, the standard rule: a
 * regex after an operator, a control-flow keyword, a statement boundary, a
 * control head's `)` or a block's `}`; a division after an operand — a
 * name, a number, a literal, a `]`, a call's or grouping's `)`, an object
 * literal's `}`.
 *
 * Returns `null` — the DOUBT state — wherever the walk cannot prove the
 * state it is in: a `/` after a `}` whose `{` it could not class as block or
 * object literal, or after a punctuator the rule does not list; a `)` or
 * `}` with no opener; a block comment, regex literal, template or
 * interpolation still open at end of input (the walk lost sync). The seam
 * oracle republishes such a file in full. Nothing here is guessed, so a
 * miss cannot blank a real seam statement — the one error the seam bound
 * must not make. Known residual, documented rather than modelled: JSX is
 * not a lexical state of this walk — a closing tag's `</` is an
 * unterminated regex literal to the JS grammar, so a JSX file doubts at
 * its first closing tag and republishes in full (measured: no `.ts` source
 * in this repository doubts; most `.tsx` files do) — and a `/` after a
 * generic's `>` reads as a regex, which only ever costs an unblanked
 * comment on that line — over-collection, the budgeted direction.
 */
export function stripComments(source: string): string | null {
  const out = source.split('');
  const n = source.length;
  const at = (k: number): string => (k < n ? source.charAt(k) : '');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  // The token before the cursor, as the regex/division rule reads it: its
  // last character, the word it ended (for the keyword lists), whether it
  // was a postfix `++`/`--` (an operand whatever `+` says), and — when it
  // was a `)` or `}` — the class of what it closed.
  let prevChar = '';
  let prevWord = '';
  let prevPostfix = false;
  let prevClose: boolean | null = null;
  // Every open `{`, classed when it opened: `true` for a block (statement
  // position — its `}` ends a statement), `false` for an object literal
  // (operand — its `}` ends an expression), `null` when the walk could not
  // tell. Every open `(`: `true` for a control head (`if (…)`), `false` for
  // a call or a grouping. Every open template interpolation: the brace
  // depth it was entered at, so its own `}` is told apart from the code's.
  const braces: Array<boolean | null> = [];
  const parens: boolean[] = [];
  const tplFrames: number[] = [];
  const setPunct = (c: string): void => {
    prevPostfix =
      (c === '+' || c === '-') &&
      prevChar === c &&
      !prevPostfix &&
      prevWord === '';
    prevChar = c;
    prevWord = '';
    prevClose = null;
  };
  const setOperand = (): void => {
    prevChar = '`';
    prevWord = '';
    prevPostfix = false;
    prevClose = null;
  };
  // Walk a template body from `from`: the index after the closing backtick,
  // or the index of a `${` (the caller enters code), or -1 when the input
  // ends inside the template.
  const walkTemplate = (from: number): number => {
    let k = from;
    while (k < n) {
      const d = at(k);
      if (d === '\\') k += 2;
      else if (d === '`') return k + 1;
      else if (d === '$' && at(k + 1) === '{') return k;
      else k++;
    }
    return -1;
  };
  // Enter code at a `${`, or land after a closing backtick. Returns false
  // when the template never closes.
  const resumeTemplate = (from: number): boolean => {
    const next = walkTemplate(from);
    if (next < 0) return false;
    if (at(next) === '$') {
      tplFrames.push(braces.length);
      i = next + 2;
      setPunct('(');
    } else {
      i = next;
      setOperand();
    }
    return true;
  };

  let i = 0;
  if (at(0) === '#' && at(1) === '!') {
    // The shebang: a comment by the host's grammar, never the lexer's.
    while (i < n && at(i) !== '\n') {
      out[i] = ' ';
      i++;
    }
  }
  while (i < n) {
    const c = at(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        const d = at(i);
        if (d === '\\') i += 2;
        else if (d === c) {
          i++;
          break;
        } else if (d === '\n') break;
        else i++;
      }
      setOperand();
      continue;
    }
    if (c === '`') {
      if (!resumeTemplate(i + 1)) return null;
      continue;
    }
    if (c === '/' && at(i + 1) === '/') {
      const from = i;
      while (i < n && at(i) !== '\n') i++;
      blank(from, i);
      continue;
    }
    if (c === '/' && at(i + 1) === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0) return null;
      blank(i, close + 2);
      i = close + 2;
      continue;
    }
    if (c === '/') {
      let regex: boolean | null;
      if (prevChar === '') regex = true;
      else if (prevPostfix) regex = false;
      else if (IDENT_CHAR_RE.test(prevChar)) {
        regex = REGEX_AFTER_WORDS.has(prevWord);
      } else if (prevChar === ')' || prevChar === '}') regex = prevClose;
      else if (prevChar === ']' || prevChar === '`' || prevChar === '/') {
        regex = false;
      } else regex = REGEX_AFTER_PUNCT.has(prevChar) ? true : null;
      if (regex === null) return null;
      if (!regex) {
        i++;
        setPunct('/');
        continue;
      }
      i++;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const d = at(i);
        if (d === '\n') break;
        if (d === '\\') i += 2;
        else if (d === '[') {
          inClass = true;
          i++;
        } else if (d === ']') {
          inClass = false;
          i++;
        } else if (d === '/' && !inClass) {
          i++;
          closed = true;
          break;
        } else i++;
      }
      if (!closed) return null;
      while (i < n && IDENT_CHAR_RE.test(at(i))) i++;
      setOperand();
      continue;
    }
    if (c === '{') {
      // Classed by the token before it. A block: after a `)` (a control
      // head's or a signature's), a `=>`, a block keyword, a name (`class
      // X {`, `function f() {` reaches here via `)`), a statement boundary,
      // or another block's `{`. An object literal: after an operator, an
      // opener, a separator, a `return`-like word, or an object literal's
      // own `{`. Unknowable otherwise.
      let block: boolean | null;
      if (
        prevChar === '' ||
        prevChar === ')' ||
        prevChar === ';' ||
        prevChar === '}' ||
        prevChar === '>'
      ) {
        block = true;
      } else if (IDENT_CHAR_RE.test(prevChar)) {
        block =
          BLOCK_AFTER_WORDS.has(prevWord) || !REGEX_AFTER_WORDS.has(prevWord);
      } else if (prevChar === '{') {
        block = braces.length > 0 && braces[braces.length - 1] === true;
      } else if (REGEX_AFTER_PUNCT.has(prevChar) || prevChar === '`') {
        block = false;
      } else {
        block = null;
      }
      braces.push(block);
      i++;
      setPunct('{');
      continue;
    }
    if (c === '}') {
      const frame = tplFrames[tplFrames.length - 1];
      if (frame !== undefined && braces.length === frame) {
        // The interpolation's own close: back into the template body.
        tplFrames.pop();
        if (!resumeTemplate(i + 1)) return null;
        continue;
      }
      // A `}` with no opener may close a block the walk never saw: refuse.
      if (braces.length === 0) return null;
      const closed = braces.pop();
      i++;
      prevChar = '}';
      prevWord = '';
      prevPostfix = false;
      prevClose = closed === undefined ? null : closed;
      continue;
    }
    if (c === '(') {
      parens.push(
        IDENT_CHAR_RE.test(prevChar) && CONTROL_PAREN_WORDS.has(prevWord),
      );
      i++;
      setPunct('(');
      continue;
    }
    if (c === ')') {
      if (parens.length === 0) return null;
      const control = parens.pop() === true;
      i++;
      prevChar = ')';
      prevWord = '';
      prevPostfix = false;
      prevClose = control;
      continue;
    }
    if (IDENT_CHAR_RE.test(c)) {
      const from = i;
      while (i < n && IDENT_CHAR_RE.test(at(i))) i++;
      prevWord = source.slice(from, i);
      prevChar = at(i - 1);
      prevPostfix = false;
      prevClose = null;
      continue;
    }
    i++;
    setPunct(c);
  }
  if (tplFrames.length > 0) return null;
  return out.join('');
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
 *
 * One read fails CLOSED (#10136): any read whose bindings cannot be
 * proven collected marks EVERY line, the doubt shape `widenScope`
 * republishes in full. The reads that doubt: a clause carrying a quote (no
 * legal clause has one; a keyword inside a string displaced the bound), a
 * keyword-bound clause past the 2000-char cap (a barrel re-export the read
 * cannot enumerate), a brace entry that parses to no identifier, ANY
 * dynamic `import(` call (its value escapes into expressions the
 * line-shape read cannot follow — an awaited or wrapped declaration, a
 * callback parameter), and a `require(` whose own line parses to no
 * declaration the read can collect. Under-collection of the oracle is the
 * one error the seam bound must not make.
 */
export function seamLines(
  fromFile: string,
  source: string,
  changed: ReadonlySet<string>,
  packages: readonly WorkspacePackage[] = [],
): number[] {
  const lexed = stripComments(source);
  if (lexed === null) {
    // The lexer could not prove its state (#10136): the doubt shape,
    // exactly as an unreadable clause below — every line, the file in full.
    return Array.from({ length: source.split('\n').length }, (_, i) => i + 1);
  }
  const stripped = lexed;
  const lineOf = (index: number): number => {
    let line = 1;
    for (let i = 0; i < index && i < stripped.length; i++) {
      if (stripped.charCodeAt(i) === 10) line++;
    }
    return line;
  };
  const marked = new Set<number>();
  const bindings = new Set<string>();
  let doubt = false;
  const fromRe = /\bfrom\s*(['"])([^'"\n]+)\1/g;
  for (const m of stripped.matchAll(fromRe)) {
    if (resolveSpecifier(fromFile, m[2], changed, packages) === null) continue;
    marked.add(lineOf(m.index ?? 0));
    // The clause sits between the statement keyword and this `from`. The
    // nearest preceding keyword bounds it — word-bounded, because a binding
    // that merely CONTAINS the keyword (`exporter`, `reimport`) used to
    // displace the bound inside its own name and parse the clause to zero
    // bindings; a clause the scan cannot bound contributes the statement
    // line alone — fail toward fewer lines, which the always-in-scope
    // brief backstops. A clause carrying a quote character is none the
    // scan can read — no legal clause has one — so the bound fails CLOSED
    // instead (#10136).
    const at = m.index ?? 0;
    let start = -1;
    for (const km of stripped
      .slice(0, at)
      .matchAll(/(^|[^\w$])(?:import|export)(?![\w$])/g)) {
      start = (km.index ?? 0) + (km[1]?.length ?? 0);
    }
    const clause = start >= 0 ? stripped.slice(start, at) : null;
    if (clause === null) continue;
    if (clause.length > 2000) {
      // Keyword-bound but past the cap the read budgets — a barrel
      // re-export whose bindings the scan cannot enumerate. Marking the
      // statement line alone would shed every usage line, so the bound
      // fails CLOSED instead (#10136).
      doubt = true;
      break;
    }
    if (/['"`]/.test(clause)) {
      doubt = true;
      break;
    }
    const names = clauseBindings(clause);
    if (names === null) {
      doubt = true;
      break;
    }
    for (const name of names) {
      bindings.add(name);
    }
  }
  const callRe =
    /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)|\bimport\s*(['"])([^'"\n]+)\3/g;
  for (const m of stripped.matchAll(callRe)) {
    const spec = m[2] ?? m[4];
    if (resolveSpecifier(fromFile, spec, changed, packages) === null) continue;
    const at = m.index ?? 0;
    marked.add(lineOf(at));
    if (m[2] === undefined) continue; // side-effect `import 'x'`: no bindings
    // A dynamic `import(` fails closed outright: its value escapes into
    // expressions the line-shape read cannot follow — a declaration on the
    // previous line, a `.then` callback's parameter — and a read whose
    // bindings cannot be proven collected is the one error the seam bound
    // must not make (#10136).
    if (m[0].startsWith('import')) {
      doubt = true;
      break;
    }
    // `const { a, b: c } = require('x')` / `const x = require('x')`: the
    // bindings sit BEFORE the call, on its own line. Any other shape — a
    // wrapped or keywordless declaration, an assignment to an existing
    // binding, a bare side-effect call — parses to no declaration the read
    // can collect, and fails CLOSED (#10136).
    const lineStart = stripped.lastIndexOf('\n', at - 1) + 1;
    const before = stripped.slice(lineStart, at);
    const decl =
      /(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*$/.exec(
        before,
      );
    if (!decl) {
      doubt = true;
      break;
    }
    if (decl[2]) {
      bindings.add(decl[2]);
      continue;
    }
    for (const entry of decl[1].split(',')) {
      const raw = entry.trim();
      if (raw === '') continue; // a trailing comma binds nothing
      // Split at `=` BEFORE the rename parse: a default (`moved =
      // fallback`) binds the imported name, not the fallback expression.
      const words = raw
        .split('=')[0]
        .split(/[:\s]+/)
        .filter(Boolean);
      const local = words[words.length - 1];
      if (!local || !IDENT_RE.test(local)) {
        doubt = true;
        break;
      }
      bindings.add(local);
    }
    if (doubt) break;
  }
  if (doubt) {
    // The clause read could not be trusted: mark every line so `widenScope`
    // keeps every hunk and republishes the file in full — the same shape a
    // scan that keeps everything produces, the doubt state its seam record
    // already reads.
    const total = source.split('\n').length;
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (bindings.size > 0) {
    // `$` is legal in the identifiers IDENT_RE admits and is a regex anchor,
    // and `\b` cannot bound a name that starts or ends with it (`store$.x`
    // never matched; a DIFFERENT identifier at end-of-line did). So the
    // names are escaped and the boundary is spelled explicitly: not
    // preceded/followed by an identifier character, `$` included.
    const escaped = [...bindings].map((b) => b.replace(/\$/g, '\\$'));
    const usage = new RegExp(`(?<![\\w$])(?:${escaped.join('|')})(?![\\w$])`);
    const lines = stripped.split('\n');
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
