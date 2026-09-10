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

import { createRequire } from 'node:module';
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
/** The TypeScript module the seam oracle parses with (`typeof import('typescript')`). */
export type TypeScriptModule = typeof import('typescript');

let loadedTypeScript: TypeScriptModule | null | undefined;

/**
 * The parser the seam oracle reads with, resolved at run time and never
 * bundled (#10136): TypeScript is a build-time dependency of this package,
 * not a runtime one, and shipping it inside the CLI for one scan is not a
 * trade this command makes. It is resolved from the process's working
 * directory first — the repository the review runs in, whose own
 * `typescript` is exactly the parser that reads its sources — then from
 * this module's own location (the source tree, the test runner). Where
 * neither resolves, or the module does not expose the parser entry points
 * the oracle uses, the answer is `null` and every seam read is the doubt
 * shape: the round republishes interaction files in full, which is what
 * every round did before the seam bound existed. Memoised: one resolution
 * per process, whatever the answer.
 */
export function loadTypeScript(
  /**
   * Where to resolve from, in order — a test's seam. Absent, the default
   * bases (the working directory, then this module) and the memo apply.
   */
  bases?: readonly string[],
): TypeScriptModule | null {
  if (bases === undefined && loadedTypeScript !== undefined) {
    return loadedTypeScript;
  }
  const from = bases ? [...bases] : defaultTypeScriptBases();
  let found: TypeScriptModule | null = null;
  for (const base of from) {
    try {
      const candidate = createRequire(base)('typescript') as unknown;
      if (isTypeScriptModule(candidate)) {
        found = candidate;
        break;
      }
    } catch {
      /* not resolvable or not usable from here — try the next base */
    }
  }
  if (bases === undefined) loadedTypeScript = found;
  return found;
}

/**
 * Where the default resolution looks, in order: the working directory —
 * the repository the review runs in, whose own `typescript` is the one
 * that reads its sources, and the only base a globally installed CLI has
 * (nothing ships beside `dist/`) — then this module's own tree, which
 * serves the source checkout and the test runner. A working directory
 * that no longer exists contributes no base.
 */
export function defaultTypeScriptBases(): string[] {
  const from: string[] = [];
  try {
    from.push(nodePath.join(process.cwd(), 'package.json'));
  } catch {
    /* a working directory that no longer exists: only the CLI's own tree */
  }
  from.push(import.meta.url);
  return from;
}

/**
 * The entry points the oracle calls, present and working: a probe parse of
 * a trivial module runs here so a module that resolves but cannot parse
 * (a broken install, an incompatible build) is refused now, visibly, rather
 * than doubting every file silently. Guards the members added after TS
 * 4.8 (`isSatisfiesExpression`) explicitly: a reviewed repository may pin
 * an older compiler, and the walk must never throw on its absence.
 */
function isTypeScriptModule(value: unknown): value is TypeScriptModule {
  const m = value as Partial<TypeScriptModule> | null;
  if (
    typeof m !== 'object' ||
    m === null ||
    typeof m.createSourceFile !== 'function' ||
    typeof m.forEachChild !== 'function' ||
    typeof m.isImportDeclaration !== 'function' ||
    typeof m.isCallExpression !== 'function' ||
    typeof m.isStringLiteralLike !== 'function' ||
    typeof m.SyntaxKind !== 'object' ||
    typeof m.ScriptKind !== 'object' ||
    typeof m.ScriptTarget !== 'object'
  ) {
    return false;
  }
  try {
    const probe = m.createSourceFile(
      'probe.ts',
      'export {};',
      m.ScriptTarget.Latest,
      true,
      m.ScriptKind.TS,
    );
    return Array.isArray(
      (probe as { parseDiagnostics?: unknown }).parseDiagnostics,
    );
  } catch {
    return false;
  }
}

/**
 * The 1-based lines of `source` that touch its seam with the changed files:
 * every import/require statement whose specifier resolves into `changed`
 * (every line the statement spans), plus every line mentioning a binding
 * such a statement introduces.
 *
 * This is the seam-bounded widening's oracle (#10104): a fix-audit round
 * republishes an interaction file's hunks only where they display one of
 * these lines. It reads the file through TypeScript's own parser (#10136) —
 * the grammar's reading of strings, templates, regex literals, comments,
 * JSX and import clauses, not a hand-rolled approximation of it: six review
 * rounds of an in-house lexer each surfaced a new lexical shape it guessed
 * wrong (a `/` after a non-null `!`, a keyword-shaped property name, a
 * control-word-shaped method, an `import { export as x }` clause), and a
 * wrong guess is not line-local — a mis-lexed literal desyncs everything
 * after it. The parser carries none of that: an `ImportDeclaration` is an
 * import, its clause's bindings are the nodes the grammar says they are.
 *
 * What it marks: `import`/`export … from` declarations, TypeScript's
 * `import x = require(…)`, a type position's `import('…')` and JSDoc's
 * `@import`/`@type {import('…')}` (the JSDoc tree is walked too — a JS
 * caller's types live there) whose specifier resolves into `changed`; a
 * `require(…)` or `import(…)` call whose specifier does, together with
 * EVERY receiver of its value on the way to the statement — the declared
 * names (`const { a, b: c } = require('x')`, `const m = await import('x')`),
 * each identifier or property assigned along a chain (`a = b = require('x')`,
 * `cache ?? (cache = require('x'))`, `exports.m = require('x')`), a class
 * field — through whatever wraps the call (a property access, an `await`,
 * a `?.`, an `as`, a conditional's branch, a `??`); and every line where an
 * identifier spelled like one of those bindings appears. That last read is
 * by NAME, so a shadowing local or a same-named property marks one line too
 * many — over-collection is the budgeted direction; a binding renamed into
 * another local after import, or reached through a barrel, marks no line,
 * and the file itself always stays in scope with its brief, so the seam
 * question is asked even when no hunk survives. A statement that receives
 * nothing (`require('x');`, `await import('x');`, `require('x').init();`)
 * marks its own lines and binds nothing — the grammar introduces no name.
 * A seam read inside a JSDoc ANNOTATION (`@type`, `@param`, `@returns`, …)
 * marks the declaration that comment documents as well as the tag (#10136
 * R18-1): the JSDoc spelling of a type-position import is the same seam as
 * the TypeScript one, and a fix commit changes the declaration, not the
 * comment. A DECLARING tag (`@import`, `@typedef`, `@callback`) introduces
 * a name instead, so it marks its own lines and its uses are marked where
 * they sit. `require`/`createRequire` are recognised in either property
 * spelling — `mod.createRequire` and `mod['createRequire']` are one
 * grammar's two ways of writing the same read — and a `createRequire`
 * renamed by a JSDoc `@import` binds the factory exactly as the statement
 * form does. A COMPUTED key (`mod[k]`) names nothing this read can see: the
 * same class as any dynamically dispatched call, which the oracle does not
 * model and does not refuse over.
 * A dynamic import's value is a promise until an `await` unwraps it, so a
 * method chained onto the un-awaited promise (`import('x').then(handler)`)
 * hands the module to a callback the name read cannot follow: an escape.
 *
 * Every read the oracle cannot prove fails CLOSED — `null`, the doubt
 * state, which `widenScope` republishes in full: no parser resolvable
 * (`loadTypeScript`), a source the parser reports a syntax error on (the
 * tree past the error is a guess), a `require`/`import(…)` whose specifier
 * is not a string literal (a computed one may name a changed file the read
 * cannot see, so "no match" is no proof), a `require`/`import(…)` whose
 * value escapes into an expression the receiver walk does not follow (an
 * argument — `foo(require('x'))` — a method chained onto an un-awaited
 * `import('x')` promise, an array or object literal, a `return`, an
 * `export =`, an element-access target), a `createRequire` alias whose
 * introduction escapes the same way, a JSDoc tag whose own text carries a
 * specifier its parsed subtree never surfaced as an `ImportType` node
 * (TypeScript erases the `@callback`/`@overload`/`@func` family, `@see
 * {@link …}` and the JSDoc `require('…')` type spelling into childless
 * nodes), a specifier the entrance regex can see resolving into `changed`
 * that this walk never resolved (one reader for both halves — a comment
 * that merely mentions the path is a doubt, not a confident `kept: 0`),
 * and a walk that throws on a parser build missing an entry point. Under-
 * collection of the oracle is the one error the seam bound must not make.
 * Line numbers count LF alone — the diff's own accounting — never the
 * CR/LS/PS breaks the parser also counts.
 *
 * Returns the sorted 1-based lines, or `null` for the doubt state.
 */
export function seamLines(
  fromFile: string,
  source: string,
  changed: ReadonlySet<string>,
  packages: readonly WorkspacePackage[] = [],
  ts: TypeScriptModule | null = loadTypeScript(),
): number[] | null {
  if (ts === null) return null;
  try {
    return seamLinesWith(ts, fromFile, source, changed, packages);
  } catch {
    // A parser build the oracle's walk does not fit (an entry point missing,
    // a node shape it did not expect): not a reading, so not a census.
    return null;
  }
}

type TSNode = import('typescript').Node;

/** The read itself; `null` is the doubt state. */
function seamLinesWith(
  ts: TypeScriptModule,
  fromFile: string,
  source: string,
  changed: ReadonlySet<string>,
  packages: readonly WorkspacePackage[],
): number[] | null {
  // LF-only line accounting, computed once: the parser's own line map
  // counts CR, LS and PS as breaks, and a hunk's line numbers do not.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const sf = ts.createSourceFile(
    `seam${scriptExtension(fromFile)}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(ts, fromFile),
  );
  // The parser is error-tolerant, and a tree built past a syntax error is
  // a guess about what the author meant — not a reading the oracle can
  // certify. The diagnostics ride on the source file as an internal field;
  // a build of TypeScript that hides it is one the oracle cannot vouch for.
  const diagnostics = (sf as { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length > 0) return null;

  const marked = new Set<number>();
  const bindings = new Set<string>();
  let refused = false;
  const markSpan = (node: TSNode): void => {
    const from = lineOf(node.getStart(sf));
    const to = lineOf(node.getEnd());
    for (let line = from; line <= to; line++) marked.add(line);
  };
  // The statement — or the class/interface/object member — a node sits in:
  // every line it spans is the seam, not the node's own line alone (a
  // destructuring spread over three lines is one statement), and a member
  // rather than its whole class (one typed method must not republish the
  // class around it).
  // A JSDoc tag that DECLARES a name rather than annotating the code below
  // it. `@import`, `@typedef` and `@callback` introduce a local name; what
  // moves with the changed API is that name's USES, which the binding walk
  // marks where they sit. An annotating tag (`@type`, `@param`,
  // `@returns`, …) types the declaration the comment sits above, and that
  // declaration is the seam.
  const declaresAName = (tag: TSNode): boolean =>
    (typeof ts.isJSDocImportTag === 'function' && ts.isJSDocImportTag(tag)) ||
    (typeof ts.isJSDocTypedefTag === 'function' && ts.isJSDocTypedefTag(tag)) ||
    (typeof ts.isJSDocCallbackTag === 'function' && ts.isJSDocCallbackTag(tag));
  // The declaration a JSDoc comment documents, when `node` sits in an
  // annotating tag of one — `statementOf` stops at the tag, and the code a
  // fix commit actually changes is the declaration below it.
  const jsDocHost = (node: TSNode): TSNode | null => {
    let current: TSNode | undefined = node;
    let tag: TSNode | undefined;
    while (current !== undefined && !ts.isJSDoc(current)) {
      tag = current;
      current = current.parent;
    }
    if (current === undefined) return null;
    if (tag !== undefined && declaresAName(tag)) return null;
    const host = current.parent;
    return host !== undefined && !ts.isSourceFile(host) ? host : null;
  };
  const statementOf = (node: TSNode): TSNode => {
    let current = node;
    while (
      current.parent !== undefined &&
      !ts.isSourceFile(current.parent) &&
      // A node inside a JSDoc comment spans its tag, not the declaration
      // the comment documents.
      !ts.isJSDoc(current.parent) &&
      !ts.isBlock(current.parent) &&
      !ts.isModuleBlock(current.parent) &&
      !ts.isCaseClause(current.parent) &&
      !ts.isDefaultClause(current.parent) &&
      !ts.isClassLike(current.parent) &&
      !ts.isInterfaceDeclaration(current.parent) &&
      !ts.isTypeLiteralNode(current.parent) &&
      !ts.isObjectLiteralExpression(current.parent)
    ) {
      current = current.parent;
    }
    return current;
  };
  // The seam a node sits on: its own statement, and — when the node is a
  // JSDoc type annotation — the declaration that JSDoc documents as well
  // (#10136 R18-1). `/** @type {import('./changed.js').Config} */` above a
  // `const` marks only its comment line otherwise, while the TypeScript
  // spelling of the same seam marks the whole declaration: the JavaScript
  // caller then published a comment line and shed the code the fix commit
  // changes, with the census certifying the shed.
  const markSeamAt = (node: TSNode): void => {
    markSpan(statementOf(node));
    const host = jsDocHost(node);
    if (host !== null) markSpan(statementOf(host));
  };
  // A specifier the read can resolve: a string literal, a template with no
  // substitution, either wrapped in parentheses. Anything else — a name, a
  // concatenation, a substituting template — is computed.
  const literalSpecifier = (
    expr: import('typescript').Expression | undefined,
  ): string | null => {
    let e = expr;
    while (e !== undefined && ts.isParenthesizedExpression(e)) e = e.expression;
    return e !== undefined && ts.isStringLiteralLike(e) ? e.text : null;
  };
  // Every specifier this walk resolved into `changed`, recorded so the
  // post-walk cross-check can prove the two readers agree (#10136 R18-1):
  // a file enters `interaction` on `scanImportSpecifiers`' regex, and any
  // specifier THAT read can see resolving into `changed` which this walk
  // never resolved is an edge the census cannot account for — doubt, not
  // a confident miss.
  const resolvedSpecs = new Set<string>();
  const resolves = (spec: string): boolean => {
    const hit = resolveSpecifier(fromFile, spec, changed, packages) !== null;
    if (hit) resolvedSpecs.add(spec);
    return hit;
  };
  // The property an access expression names, in either spelling: `a.b` and
  // `a['b']` are one grammar's two ways of writing the same read (#10136
  // R18-1), and a reader that knows only the dotted one answers
  // confidently on `mod['createRequire']` and `globalThis['require']`. A
  // computed key (`a[k]`) names nothing this read can see — the same class
  // as any dynamically dispatched call, which the oracle does not model
  // and does not refuse over.
  const accessedName = (node: TSNode): string | null => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null;
    }
    return null;
  };
  // The callee of a call, unwrapped past the shapes that hide it from a
  // plain identifier read: parentheses, and the `(0, require)(…)` comma
  // sequence (the right operand is what actually gets called).
  const unwrapCallee = (expr: TSNode): TSNode => {
    let e = expr;
    for (;;) {
      if (ts.isParenthesizedExpression(e)) {
        e = e.expression;
        continue;
      }
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        e = e.right;
        continue;
      }
      return e;
    }
  };
  // The names a binding pattern or identifier declares — the LOCAL names,
  // whatever property they were taken from.
  const declaredNames = (name: import('typescript').BindingName): string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    const out: string[] = [];
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      out.push(...declaredNames(element.name));
    }
    return out;
  };
  // The names an assignment target receives: an identifier, a property
  // (a private `#field` included — its uses are read by the same name), or
  // an object/array assignment pattern, element by element. Anything else
  // (an element access, a call) is a target the name read cannot follow.
  const assignmentTargetNames = (
    target: import('typescript').Expression,
  ): string[] | null => {
    if (ts.isIdentifier(target)) return [target.text];
    if (ts.isPropertyAccessExpression(target)) return [target.name.text];
    if (ts.isParenthesizedExpression(target)) {
      return assignmentTargetNames(target.expression);
    }
    if (ts.isObjectLiteralExpression(target)) {
      const out: string[] = [];
      for (const prop of target.properties) {
        let names: string[] | null;
        if (ts.isShorthandPropertyAssignment(prop)) names = [prop.name.text];
        else if (ts.isPropertyAssignment(prop)) {
          names = assignmentTargetNames(prop.initializer);
        } else if (ts.isSpreadAssignment(prop)) {
          names = assignmentTargetNames(prop.expression);
        } else names = null;
        if (names === null) return null;
        out.push(...names);
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(target)) {
      const out: string[] = [];
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const names = assignmentTargetNames(
          ts.isSpreadElement(element) ? element.expression : element,
        );
        if (names === null) return null;
        out.push(...names);
      }
      return out;
    }
    if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      // A default inside a pattern: `[a = 1] = …` binds `a`.
      return assignmentTargetNames(target.left);
    }
    return null;
  };
  const isPassThrough = (parent: TSNode, node: TSNode): boolean =>
    ts.isPropertyAccessExpression(parent) ||
    ts.isElementAccessExpression(parent) ||
    ts.isAwaitExpression(parent) ||
    ts.isVoidExpression(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    (typeof ts.isSatisfiesExpression === 'function' &&
      ts.isSatisfiesExpression(parent)) ||
    (ts.isCallExpression(parent) && parent.expression === node) ||
    (ts.isConditionalExpression(parent) && parent.condition !== node) ||
    (ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken));
  // Every receiver of a `require(…)`/`import(…)` value on the way up to its
  // statement. A declaration or a class field is terminal (it binds and the
  // value stops there); an assignment records its target and keeps going —
  // the assignment expression's value flows on (`a = b = require('x')`,
  // `cache ?? (cache = require('x'))`); an expression statement ends the
  // walk with whatever was collected (nothing, for a bare side-effect
  // call). Anything else the value flows into is an escape the name read
  // cannot follow, and the read fails closed. A still-WRAPPED promise
  // reaches no terminal either (#10136 R9-1 round 16): `const p =
  // import('x')` stores the promise, and the callback body that eventually
  // uses the module (`p.then((m) => …)`) is written anywhere — a use the
  // name read cannot account for. So every BINDING terminal refuses while
  // `unwrapped` is still false: receiving the value is gated on the
  // promise's state, not only chaining onto it (`const api = await
  // import('x')` still binds — the await is inside the walk's own path).
  const receiverBindings = (
    call: TSNode,
    promise: boolean,
  ): string[] | null => {
    const out: string[] = [];
    let node: TSNode = call;
    // A dynamic import's value is a PROMISE of the module until an `await`
    // unwraps it: a method chained onto the promise (`.then(handler)`,
    // `.catch(…)`) hands the module to a callback the name read cannot
    // follow, so until the await a call on the path is an escape.
    let unwrapped = !promise;
    for (;;) {
      const parent: TSNode | undefined = node.parent;
      if (parent === undefined) return null;
      if (ts.isAwaitExpression(parent)) unwrapped = true;
      if (
        !unwrapped &&
        ts.isCallExpression(parent) &&
        parent.expression === node
      ) {
        return null;
      }
      if (!unwrapped) {
        // The binding terminals, gated on the promise's state: a
        // declaration, a destructuring default, a class field, or an
        // assignment that would STORE the wrapped promise.
        if (
          (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
          (ts.isBindingElement(parent) && parent.initializer === node) ||
          (ts.isPropertyDeclaration(parent) &&
            parent.initializer === node &&
            (ts.isIdentifier(parent.name) ||
              ts.isPrivateIdentifier(parent.name))) ||
          (ts.isBinaryExpression(parent) &&
            parent.right === node &&
            (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
              parent.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionEqualsToken ||
              parent.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
              parent.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandEqualsToken))
        ) {
          return null;
        }
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        out.push(...declaredNames(parent.name));
        return out;
      }
      if (ts.isBindingElement(parent) && parent.initializer === node) {
        out.push(...declaredNames(parent.name));
        return out;
      }
      if (
        ts.isPropertyDeclaration(parent) &&
        parent.initializer === node &&
        (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name))
      ) {
        out.push(parent.name.text);
        return out;
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.right === node &&
        (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          parent.operatorToken.kind ===
            ts.SyntaxKind.QuestionQuestionEqualsToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
          parent.operatorToken.kind ===
            ts.SyntaxKind.AmpersandAmpersandEqualsToken)
      ) {
        const names = assignmentTargetNames(parent.left);
        if (names === null) return null;
        out.push(...names);
        node = parent;
        continue;
      }
      if (ts.isExpressionStatement(parent) && parent.expression === node) {
        return out;
      }
      if (isPassThrough(parent, node)) {
        node = parent;
        continue;
      }
      return null;
    }
  };
  const bindImportClause = (
    clause: import('typescript').ImportClause | undefined,
  ): void => {
    if (clause?.name) bindings.add(clause.name.text);
    const named = clause?.namedBindings;
    if (named) {
      if (ts.isNamespaceImport(named)) bindings.add(named.name.text);
      else for (const el of named.elements) bindings.add(el.name.text);
    }
  };
  // `forEachChild` never enters a node's JSDoc, and a JavaScript caller's
  // types live there — `@type {import('./x').T}`, `@import { T } from
  // './x'` — so the walk enters it by hand, in every script kind (a `.ts`
  // file's JSDoc import marks one line too many at worst).
  const eachChild = (node: TSNode, fn: (child: TSNode) => void): void => {
    ts.forEachChild(node, fn);
    const docs = (node as { jsDoc?: readonly TSNode[] }).jsDoc;
    if (Array.isArray(docs)) for (const doc of docs) fn(doc);
  };
  const isJSDocImport = (node: TSNode): boolean =>
    typeof ts.isJSDocImportTag === 'function' && ts.isJSDocImportTag(node);
  // A parser too old to know `@import` (TS < 5.5) hands the tag over as an
  // unknown one, clause unread: a seam it cannot show is a doubt, not a
  // "no match".
  const isUnreadableJSDocImport = (node: TSNode): boolean =>
    typeof ts.isJSDocImportTag !== 'function' &&
    (node as { tagName?: { text?: unknown } }).tagName?.text === 'import';
  // A JSDoc tag whose own text carries a `require('…')`/`import('…')`
  // specifier its parsed subtree never surfaced as an `ImportType` node
  // (#10136 R17-2/R18-1). TypeScript's JSDoc parser erases several legal
  // type spellings — the `@callback`/`@overload`/`@func`/`@function`
  // signatures, `@see {@link …}`, and the JSDoc `require('…')` type — into
  // childless nodes (`JSDocSignature`, unknown tags, link text), so the
  // specifier never becomes a node the walk can rule on: no
  // `ImportTypeNode`, no parse diagnostic, no refusal — a confident miss.
  // The doubt is read over the tag's own raw text (`node.pos`/`node.end`),
  // and only when the erased specifier actually resolves into `changed`:
  // an erased type naming something else is no seam either way.
  const jsDocCarriesUnreadSpec = (node: TSNode): boolean => {
    // A JSDoc tag by kind range, not by `ts.isJSDocTag`: that guard is
    // absent from the public type surface of the parser builds the
    // oracle resolves at run time.
    if (
      node.kind < ts.SyntaxKind.FirstJSDocTagNode ||
      node.kind > ts.SyntaxKind.LastJSDocTagNode
    ) {
      return false;
    }
    const raw = source.slice(node.pos, node.end);
    const specs = new Set<string>();
    for (const re of [
      /\brequire\s*\(\s*['"`]([^'"`\n]+)['"`]/g,
      /\bimport\s*\(\s*['"`]([^'"`\n]+)['"`]/g,
    ]) {
      for (const m of raw.matchAll(re)) specs.add(m[1] ?? '');
    }
    if (specs.size === 0) return false;
    const readable = new Set<string>();
    const collect = (n: TSNode): void => {
      if (ts.isImportTypeNode(n)) {
        const arg = n.argument;
        if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) {
          readable.add(arg.literal.text);
        }
      }
      ts.forEachChild(n, collect);
    };
    collect(node);
    for (const spec of specs) {
      if (!readable.has(spec) && resolves(spec)) return true;
    }
    return false;
  };
  // `require` under an alias (#10136 R18-1): `const req =
  // createRequire(import.meta.url)` makes `req` a require factory's
  // product, and a call through it is a require call the plain identifier
  // read cannot see — it returned a confident `[]` where the aliased
  // control correctly marked. The factory itself is matched by the LOCAL
  // names its original name was bound to, not just the literal spelling
  // (#10136 R18-1 round 19): `import { createRequire as cr }`,
  // `const { createRequire: cr } = …`, and `const cr = x.createRequire`
  // all rename it, and a rename the read cannot follow is another
  // confident miss. Both sets are collected file-wide BEFORE the walk (a
  // hoisted use precedes its declaration in source order), by name — the
  // same fuzz the binding read budgets.
  const factoryNames = new Set<string>(['createRequire']);
  // `import { createRequire as cr }` — `propertyName` is the ORIGINAL
  // name, `name` the local one. Shared by the two clause spellings: a
  // JSDoc `@import` binds a factory exactly as the statement does, and
  // reading only the statement left `factoryNames` empty on a JavaScript
  // caller that writes its imports in comments (#10136 R18-1).
  const collectFactoryClause = (
    clause: import('typescript').ImportClause | undefined,
  ): void => {
    const named = clause?.namedBindings;
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if ((el.propertyName ?? el.name).text === 'createRequire') {
          factoryNames.add(el.name.text);
        }
      }
    }
  };
  const collectFactories = (node: TSNode): void => {
    if (ts.isImportDeclaration(node)) {
      collectFactoryClause(node.importClause);
    } else if (isJSDocImport(node)) {
      collectFactoryClause(
        (node as import('typescript').JSDocImportTag).importClause,
      );
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      // `const { createRequire: cr } = …` (and the shorthand form).
      for (const el of node.name.elements) {
        const prop = el.propertyName ?? el.name;
        if (
          ts.isIdentifier(prop) &&
          prop.text === 'createRequire' &&
          ts.isIdentifier(el.name)
        ) {
          factoryNames.add(el.name.text);
        }
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.name) &&
      accessedName(node.initializer) === 'createRequire'
    ) {
      // `const cr = module.createRequire` — the property read binds the
      // local to the same factory, in either spelling.
      factoryNames.add(node.name.text);
    }
    // `eachChild`, not `forEachChild`: a factory bound by a JSDoc
    // `@import` lives in a node's `jsDoc`, which `forEachChild` never
    // enters (#10136 R18-1).
    eachChild(node, collectFactories);
  };
  collectFactories(sf);
  const isFactoryCallee = (callee: TSNode): boolean =>
    (ts.isIdentifier(callee) && factoryNames.has(callee.text)) ||
    accessedName(callee) === 'createRequire';
  const requireAliases = new Set<string>();
  const collectAliases = (node: TSNode): void => {
    if (refused) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrapCallee(node.expression);
      if (isFactoryCallee(callee)) {
        const received = receiverBindings(node, false);
        if (received === null) {
          // The alias itself escapes the receiver walk: calls through it
          // are unreadable either way.
          refused = true;
          return;
        }
        for (const b of received) requireAliases.add(b);
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sf);
  if (refused) return null;
  // Every branch falls through to the children walk at the bottom: the
  // JSDoc a statement carries — an `@import` above an `import`, a
  // `@typedef` above an `export … from` — is a child the walk must enter
  // whatever the statement itself was.
  const visit = (node: TSNode): void => {
    if (refused) return;
    if (jsDocCarriesUnreadSpec(node)) {
      refused = true;
      return;
    }
    if (ts.isImportDeclaration(node)) {
      const spec = literalSpecifier(node.moduleSpecifier);
      if (spec === null) {
        refused = true;
        return;
      }
      if (resolves(spec)) {
        markSpan(node);
        bindImportClause(node.importClause);
      }
    } else if (isUnreadableJSDocImport(node)) {
      refused = true;
      return;
    } else if (isJSDocImport(node)) {
      const tag = node as import('typescript').JSDocImportTag;
      const spec = literalSpecifier(tag.moduleSpecifier);
      if (spec === null) {
        refused = true;
        return;
      }
      if (resolves(spec)) {
        markSpan(node);
        bindImportClause(tag.importClause);
      }
    } else if (
      typeof ts.isJSDocTypedefTag === 'function' &&
      ts.isJSDocTypedefTag(node)
    ) {
      // `@typedef {import('./changed.js').Bar} Local` binds a local ALIAS
      // of an imported type (#10136 R17-3): the ImportType child marks
      // the typedef's own lines, but nothing bound the alias, so a file
      // that types everything through it marked nothing past this line.
      let aliased = false;
      const scan = (n: TSNode): void => {
        if (ts.isImportTypeNode(n)) {
          const arg = n.argument;
          const spec =
            ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)
              ? arg.literal.text
              : null;
          if (spec !== null && resolves(spec)) aliased = true;
        }
        ts.forEachChild(n, scan);
      };
      scan(node);
      if (aliased) {
        const name = (node as import('typescript').JSDocTypedefTag).fullName;
        if (name !== undefined) {
          // A QUALIFIED alias (`ns.Bar`) binds every identifier of the
          // name, not nothing (#10136 R18-1 round 19): dropping it left
          // the alias's uses unmarked beside a specifier the cross-check
          // HAD seen — a confident under-read where the sibling
          // unreadable-`@import` branch refuses. Over-collecting a
          // namespace segment is the direction the name read budgets.
          const bindAll = (n: TSNode): void => {
            if (ts.isIdentifier(n)) bindings.add(n.text);
            ts.forEachChild(n, bindAll);
          };
          bindAll(name);
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        const spec = literalSpecifier(node.moduleSpecifier);
        if (spec === null) {
          refused = true;
          return;
        }
        // A re-export introduces no local binding: the statement is the seam.
        if (resolves(spec)) markSpan(node);
      }
    } else if (ts.isImportTypeNode(node)) {
      // `import('./changed.js').Foo` in a type position: a seam by the
      // grammar (the signature it names moved), used inline — no binding.
      const arg = node.argument;
      const spec =
        ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)
          ? arg.literal.text
          : null;
      if (spec === null) {
        refused = true;
        return;
      }
      if (resolves(spec)) markSeamAt(node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        const spec = literalSpecifier(ref.expression);
        if (spec === null) {
          refused = true;
          return;
        }
        if (resolves(spec)) {
          markSpan(node);
          bindings.add(node.name.text);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapCallee(node.expression);
      // `require` by every spelling the grammar can hide it behind
      // (#10136 R18-1): the bare identifier, a `createRequire` alias
      // collected above, a `(0, require)(…)` comma sequence, and the
      // property form `module.require(…)` — an unwrapped callee the read
      // cannot name is left to the doubt states, never guessed.
      const isRequire =
        (ts.isIdentifier(callee) &&
          (callee.text === 'require' || requireAliases.has(callee.text))) ||
        accessedName(callee) === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && node.arguments.length >= 1) {
        const spec = literalSpecifier(node.arguments[0]);
        if (spec === null) {
          refused = true;
          return;
        }
        if (resolves(spec)) {
          markSeamAt(node);
          const received = receiverBindings(node, isDynamicImport);
          if (received === null) {
            refused = true;
            return;
          }
          for (const b of received) bindings.add(b);
        }
      }
    }
    eachChild(node, visit);
  };
  visit(sf);
  if (refused) return null;
  // One reader for both halves (#10136 R18-1): a file enters
  // `interaction` on `scanImportSpecifiers`' regex, so any specifier the
  // regex can see resolving into `changed` that this walk never resolved
  // is an edge the census cannot account for — a comment or string that
  // merely MENTIONS the changed path, an import the walk's own rules
  // refused to see. A confident census over it sheds the file on evidence
  // nobody read.
  for (const spec of scanImportSpecifiers(source)) {
    if (resolveSpecifier(fromFile, spec, changed, packages) !== null) {
      if (!resolvedSpecs.has(spec)) return null;
    }
  }
  if (bindings.size > 0) {
    const mention = (node: TSNode): void => {
      // A binding use marks the whole statement it sits in
      // (`markSpan(statementOf(…))`), never the identifier's own line
      // (#10136 R18-1): a single-line mark over a multi-line call sheds
      // exactly the hunks inside the call — the argument lines a fix
      // commit changes — while the plan's census certifies the shed.
      if (
        (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
        bindings.has(node.text)
      ) {
        markSeamAt(node);
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        bindings.has(node.argumentExpression.text)
      ) {
        // The bracket spelling of a property-named binding —
        // `exports['moved']` reads back what `exports.moved = require(…)`
        // established; the establishing side of the same spelling is
        // already a doubt state, so the read-back must see it too.
        markSeamAt(node);
      }
      eachChild(node, mention);
    };
    mention(sf);
  }
  return [...marked].sort((a, b) => a - b);
}

function scriptExtension(file: string): string {
  const ext = nodePath.extname(file).toLowerCase();
  return EXT_WALK.includes(ext) ? ext : '.ts';
}

function scriptKindOf(
  ts: TypeScriptModule,
  file: string,
): import('typescript').ScriptKind {
  switch (scriptExtension(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
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
