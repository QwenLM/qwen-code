#!/usr/bin/env node
// The instrument behind the review gate's test-weakening check
// (run-autofix-review-verification.sh): the DECLARED test surface of a test
// file, measured by the TypeScript compiler's parser rather than by text
// patterns. Comments, string and template literals, regex literals and JSX
// are the parser's business, so a token that only LOOKS like an assertion
// never counts, and an assertion split across lines or wrapped in a callback
// always does. The parser is error-tolerant: any input yields a tree, so a
// file the round cannot compile still measures here and fails in the package
// test run, where compile errors belong.
//
//   count <path>            read the file's bytes on stdin; print its surface
//   measure <manifest.json> the round's net change of one file (see below)
//
// Surface of one file, position-free:
//   assertions — statement-level call chains rooted at `expect` with a called
//     matcher (`expect(x).toBe(1)`, `expect.soft(x).toBe(1)`,
//     `await expect(p).rejects.toThrow()`), `expect.unreachable(...)`, any
//     called chain rooted at `assert` (`assert(x)`, `assert.equal(a, b)`), and
//     a chain carrying a called `.expect(` member (supertest). Statement-level
//     means the chain IS a statement, a `return`, or an arrow function's
//     expression body — so `expect.anything()` as an argument, a matcher that
//     is only property-accessed (`expect(x).toBe;`) and a bare `expect(x)`
//     count nothing.
//   registrations — every `it`/`test`/`describe`/`suite` call (and the
//     `xit`/`xtest`/`xdescribe` aliases), keyed `test:<title>` or
//     `describe:<title>`, each enabled or disabled. Disabled: a
//     `skip`/`todo`/`fails`/`failing` member anywhere in the collector chain
//     (dotted, computed `it['skip']`, optional-chained, ahead of or behind
//     `each`/`for`/`concurrent`), an x-alias, `.skipIf(<truthy literal>)`,
//     `.runIf(<falsy literal>)`, an options object whose `skip`/`todo` is the
//     literal `true`, or a body-level `skip()`/`ctx.skip()` with no condition
//     (no arguments, a reason string, or the literal `true`).
//   guards — bare `return;` statements in a test body's own control flow (not
//     inside a nested function) that sit before an assertion of that body: the
//     early-return spelling of a skip.
//
// Deliberately NOT measured, because they are runtime facts the runner is the
// authority for, not declarations: whether an assertion is REACHABLE (dead
// code, a condition that is false in CI, a helper never called), a
// condition-valued guard (`it.skipIf(process.platform === 'win32')`,
// `skip(cond, reason)` — this repository's environment-guard idiom), and
// options carried by reference (`test('x', opts, fn)`).
//
// `measure` takes {"path", "tip", "pre", "events": [{"before", "after"}]} —
// blob files (null = absent) for the round's tip, the pre-round ref, and each
// main-derived event the round's history carries (a merge of main, a
// fast-forwarded main commit), before/after = the file at the commit's first
// parent and as main's side auto-merges onto it. The round's own delta is
// tip − pre − Σ(after − before): main's contribution neither charges nor
// shields, whichever commit sequence produced the tip. Reports the net
// assertion, guard and enabled-registration deltas, the titles that were
// enabled in the baseline and are disabled at the tip, and whether the
// baseline holds the file at all.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';

// typescript resolves from the checkout under measurement (the working
// directory), the way every other check the gate runs resolves its tooling:
// the staged copy of this file lives outside the checkout.
const require = createRequire(resolve(process.cwd(), 'package.json'));
const ts = require('typescript');

const DIALECTS = {
  '.ts': 'TS',
  '.mts': 'TS',
  '.cts': 'TS',
  '.tsx': 'TSX',
  '.js': 'JS',
  '.mjs': 'JS',
  '.cjs': 'JS',
  '.jsx': 'JSX',
};
const ROOTS = {
  it: 'test',
  test: 'test',
  describe: 'describe',
  suite: 'describe',
};
const XROOTS = { xit: 'test', xtest: 'test', xdescribe: 'describe' };
const DISABLING = new Set(['skip', 'todo', 'fails', 'failing']);

const ZERO = () => ({
  language: 'other',
  assertions: 0,
  guards: 0,
  enabled: 0,
  disabled: [],
  enabledTitles: [],
});

function isStringLike(n) {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const a = node.argumentExpression;
    if (isStringLike(a)) return a.text;
  }
  return null;
}

// Decompose the call chain that ends at `call` into its root identifier and
// its calls in order, each tagged with the member name that precedes it
// (null for a call on the root itself or on another call's result).
function chainOf(call) {
  const segments = [];
  let n = call;
  for (;;) {
    if (ts.isCallExpression(n)) {
      segments.push({ call: n });
      n = n.expression;
    } else if (ts.isTaggedTemplateExpression(n)) {
      // it.skip.each`table`('a', fn): the tagged template is a call link.
      segments.push({ call: n });
      n = n.tag;
    } else if (
      ts.isPropertyAccessExpression(n) ||
      ts.isElementAccessExpression(n)
    ) {
      segments.push({ member: memberName(n) });
      n = n.expression;
    } else if (ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n)) {
      n = n.expression;
    } else {
      break;
    }
  }
  segments.reverse();
  const calls = [];
  const members = [];
  let pending = null;
  for (const s of segments) {
    if (s.call) {
      calls.push({ call: s.call, name: pending });
      pending = null;
    } else {
      members.push(s.member);
      pending = s.member;
    }
  }
  let root = null;
  if (ts.isIdentifier(n)) root = n.text;
  else if (n.kind === ts.SyntaxKind.ThisKeyword) root = 'this';
  return { root, members, calls };
}

// True when `node` is not the outermost link of its chain.
function extendsChain(node) {
  const p = node.parent;
  if (!p) return false;
  if (
    (ts.isPropertyAccessExpression(p) ||
      ts.isElementAccessExpression(p) ||
      ts.isCallExpression(p)) &&
    p.expression === node
  ) {
    return true;
  }
  if (ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p)) {
    return extendsChain(p);
  }
  return false;
}

function isStatementLevel(node) {
  let n = node;
  let p = n.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isAwaitExpression(p) ||
      ts.isVoidExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(p)))
  ) {
    n = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isExpressionStatement(p) || ts.isReturnStatement(p)) return true;
  return ts.isArrowFunction(p) && p.body === n;
}

function isAssertion({ root, calls }) {
  if (root === 'expect') {
    if (calls.length >= 2) return true;
    return calls.length === 1 && calls[0].name === 'unreachable';
  }
  if (root === 'assert') return calls.length >= 1;
  return calls.some((c) => c.name === 'expect');
}

function truthyLiteral(a) {
  if (!a) return false;
  if (a.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isNumericLiteral(a)) return Number(a.text) !== 0;
  if (isStringLike(a)) return a.text !== '';
  return false;
}

function falsyLiteral(a) {
  if (!a) return true;
  if (
    a.kind === ts.SyntaxKind.FalseKeyword ||
    a.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(a)) return a.text === 'undefined';
  if (ts.isNumericLiteral(a)) return Number(a.text) === 0;
  if (isStringLike(a)) return a.text === '';
  return false;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (isStringLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && isStringLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

function optionsDisable(call) {
  return (call.arguments ?? []).some(
    (o) =>
      ts.isObjectLiteralExpression(o) &&
      o.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          (propertyName(p.name) === 'skip' ||
            propertyName(p.name) === 'todo') &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ),
  );
}

function titleOf(call, sf) {
  const a = (call.arguments ?? [])[0];
  if (!a) return '';
  if (isStringLike(a)) return a.text;
  if (ts.isTemplateExpression(a)) return a.getText(sf);
  return '';
}

function registrationDisabled({ root, members, calls }) {
  if (root in XROOTS) return true;
  if (members.some((m) => m !== null && DISABLING.has(m))) return true;
  for (const c of calls) {
    const a = (c.call.arguments ?? [])[0];
    if (c.name === 'skipIf' && truthyLiteral(a)) return true;
    if (c.name === 'runIf' && falsyLiteral(a)) return true;
  }
  return optionsDisable(calls[calls.length - 1].call);
}

// A body-level unconditional skip: `skip()`, `ctx.skip()`, `this.skip()`,
// with no arguments, a reason string, or the literal `true`.
function isBodySkip({ root, members, calls }) {
  if (root === null || root in ROOTS || root in XROOTS) return false;
  if (calls.length === 0) return false;
  const last = calls[calls.length - 1];
  const bare = root === 'skip' && members.length === 0 && calls.length === 1;
  if (!bare && last.name !== 'skip') return false;
  const a = (last.call.arguments ?? [])[0];
  return !a || isStringLike(a) || a.kind === ts.SyntaxKind.TrueKeyword;
}

// The registration (chain-top collector call) whose callback contains `node`.
function enclosingRegistration(node, registrations) {
  let best = null;
  for (const r of registrations) {
    if (r.fn && node.pos >= r.fn.pos && node.end <= r.fn.end) {
      if (!best || r.fn.pos >= best.fn.pos) best = r;
    }
  }
  return best;
}

export function count(text, path) {
  const dialect = DIALECTS[extname(path).toLowerCase()];
  if (!dialect) return ZERO();
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind[dialect],
  );
  const assertionPositions = [];
  const registrations = [];
  const bodySkips = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && !extendsChain(node)) {
      const chain = chainOf(node);
      if (
        chain.root !== null &&
        (chain.root in ROOTS || chain.root in XROOTS) &&
        chain.calls.length > 0
      ) {
        const last = chain.calls[chain.calls.length - 1].call;
        const fns = (last.arguments ?? []).filter(
          (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
        );
        registrations.push({
          kind: ROOTS[chain.root] ?? XROOTS[chain.root],
          title: titleOf(last, sf),
          disabled: registrationDisabled(chain),
          fn: fns.length ? fns[fns.length - 1] : null,
        });
      } else if (isStatementLevel(node) && isAssertion(chain)) {
        assertionPositions.push(node.getStart(sf));
      } else if (isBodySkip(chain)) {
        bodySkips.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const skip of bodySkips) {
    const r = enclosingRegistration(skip, registrations);
    if (r) r.disabled = true;
    else
      registrations.push({ kind: 'test', title: '', disabled: true, fn: null });
  }
  let guards = 0;
  for (const r of registrations) {
    if (r.kind !== 'test' || !r.fn) continue;
    const lastAssertion = Math.max(
      -1,
      ...assertionPositions.filter((p) => p >= r.fn.pos && p < r.fn.end),
    );
    if (lastAssertion < 0) continue;
    const walk = (n) => {
      if (n !== r.fn && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
      if (
        ts.isReturnStatement(n) &&
        !n.expression &&
        n.getStart(sf) < lastAssertion
      ) {
        guards += 1;
      }
      ts.forEachChild(n, walk);
    };
    walk(r.fn);
  }
  const key = (r) => `${r.kind}:${r.title}`;
  return {
    language: dialect.toLowerCase(),
    assertions: assertionPositions.length,
    guards,
    enabled: registrations.filter((r) => !r.disabled).length,
    disabled: registrations.filter((r) => r.disabled).map(key),
    enabledTitles: registrations.filter((r) => !r.disabled).map(key),
  };
}

function countFile(file, path) {
  if (file === null || file === undefined) return ZERO();
  return count(readFileSync(file, 'utf8'), path);
}

export function measure({ path, tip, pre, events = [] }) {
  const t = countFile(tip, path);
  const p = countFile(pre, path);
  let assertions = t.assertions - p.assertions;
  let guards = t.guards - p.guards;
  let enabled = t.enabled - p.enabled;
  let baselinePresent = pre !== null && pre !== undefined;
  const baselineEnabled = new Set(p.enabledTitles);
  const mainDisabled = new Set();
  for (const ev of events) {
    const before = countFile(ev.before, path);
    const after = countFile(ev.after, path);
    assertions -= after.assertions - before.assertions;
    guards -= after.guards - before.guards;
    enabled -= after.enabled - before.enabled;
    baselinePresent = ev.after !== null && ev.after !== undefined;
    const afterEnabled = new Set(after.enabledTitles);
    for (const k of after.enabledTitles) baselineEnabled.add(k);
    for (const k of before.enabledTitles) {
      if (!afterEnabled.has(k)) mainDisabled.add(k);
    }
  }
  const newlyDisabled = t.disabled.filter(
    (k) => baselineEnabled.has(k) && !mainDisabled.has(k),
  );
  return {
    language: t.language === 'other' ? p.language : t.language,
    assertions,
    guards,
    enabled,
    newlyDisabled,
    baselinePresent,
  };
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'count') {
  const text = readFileSync(0, 'utf8');
  process.stdout.write(`${JSON.stringify(count(text, arg ?? ''))}\n`);
} else if (mode === 'measure') {
  const manifest = JSON.parse(readFileSync(arg, 'utf8'));
  process.stdout.write(`${JSON.stringify(measure(manifest))}\n`);
} else if (mode !== undefined) {
  process.stderr.write(`count-test-surface: unknown mode '${mode}'\n`);
  process.exit(2);
}
