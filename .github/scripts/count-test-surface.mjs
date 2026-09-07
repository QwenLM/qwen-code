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
//   assertions, declared — two totals over the same set: chains inside
//     registrations the runner would execute (a disabled test's or
//     describe's body contributes nothing, so silencing a body and
//     planting an empty same-titled stand-in still measures as removed) or
//     outside any registration. `assertions` additionally drops the ones
//     behind a nothing-returning early `return` — `return;` or a return of
//     any CONSTANT (`undefined`, `null`, `void 0`, `0`, `false`, `''`) in
//     the test body's own control flow, which makes the runner report the
//     test PASSED having asserted nothing. `measure` charges whichever
//     total falls further, so planting a guard ahead of existing
//     assertions measures as their removal, deleting assertions that were
//     already behind one measures as their removal too, and a brand-new
//     test carrying its own platform guard costs nothing. A chain is:
//     rooted at `expect` with a called matcher
//     (`expect(x).toBe(1)`, `expect.soft(x).toBe(1)`,
//     `await expect(p).rejects.toThrow()`), `expect.unreachable(...)`, any
//     called chain rooted at `assert` (`assert(x)`, `assert.equal(a, b)`), and
//     a chain carrying a called `.expect(` member (supertest), in statement
//     position: the chain IS a statement, a `return`, an arrow function's
//     expression body, or a variable initializer (`const res = await
//     request(app).get('/').expect(200)`). So `expect.anything()` as an
//     argument, a matcher that is only property-accessed (`expect(x).toBe;`)
//     and a bare `expect(x)` count nothing.
//   registrations — every `it`/`test`/`describe`/`suite` call (and the
//     `xit`/`xtest`/`xdescribe` aliases), keyed `test:<title>` or
//     `describe:<title>`, each enabled or disabled. Disabled: a
//     `skip`/`todo`/`fails`/`failing` member anywhere in the collector chain
//     (dotted, computed `it['skip']` — literal, escaped, or a constant
//     concatenation — optional-chained, ahead of or behind `each`/`for`/
//     `concurrent`), an x-alias, `.skipIf(<truthy constant>)`,
//     `.runIf(<falsy constant>)`, an options object whose `skip`/`todo`/
//     `fails` is a truthy constant (vitest truthy-checks them, so a reason
//     string disables), a body-level `skip()`/`ctx.skip()` whose first
//     argument is absent or any constant other than `false` (the runner's
//     own rule) and that is not itself under a condition, and every
//     registration nested inside a disabled `describe`. A body skip at file
//     scope — a statement of the module, or inside a `beforeEach`/
//     `beforeAll`/`afterEach`/`afterAll` callback the file registers —
//     disables the whole file, which is what the runner does with it. A
//     constant is a literal of any kind (object, array, regex and bigint
//     included), `undefined`/`void 0`/`NaN`/`Infinity`, a unary
//     `!`/`-`/`+`/`~` of a constant, or `+` of two constants.
// Deliberately NOT measured, because they are runtime facts the runner is the
// authority for, not declarations: whether an assertion is REACHABLE (dead
// code, a condition that is false in CI, a helper never called), a
// condition-valued guard (`it.skipIf(process.platform === 'win32')`,
// `skip(cond, reason)`, `if (cond) ctx.skip()`, a skip in a `catch` —
// this repository's environment-guard idiom; the assertions an honest
// guard shelters are measured, its condition is not), and options or
// collector names carried by a binding (`test('x', opts, fn)`,
// `it[S]('x')`).
//
// `measure` takes {"path", "tip", "pre", "events": [{"before", "after"}]} —
// blob files (null = absent) for the round's tip, the pre-round ref, and each
// main-derived event the round's history carries (a merge of main, a
// fast-forwarded main commit), before/after = the file at the commit's first
// parent and as main's side auto-merges onto it. The round's own delta is
// tip − pre − Σ(after − before) for each total: main's contribution
// neither charges nor shields, whichever commit sequence produced the
// tip, and the assertion delta reported is the lower of the two. Registrations are
// tracked as multisets keyed `kind:title`: the baseline's enabled set is the
// pre-round set plus what main itself enabled across the events minus what
// main disabled, and a tip-disabled registration is charged only while the
// baseline holds more enabled copies of its key than the tip does. An event
// whose before and after are byte-identical (or both absent) moved nothing,
// so it neither shields nor decides whether the baseline holds the file.
// Reports the net assertion and enabled-test deltas, the charged
// registrations, and whether the baseline holds the file at all.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The parser is the measurement's authority, so it must not be the round's
// to choose: on the runner the gate passes WEAKEN_PARSER_FILE, the exact
// file the workflow installed from the TRUSTED base's lockfile pin and
// digested before use — loaded by that path, never by a bare specifier
// whose resolution (a package.json `main`, a sibling `typescript.js`) the
// digest does not cover. Without it (local use, the unit tests) typescript
// resolves from the working directory like every other tool.
const require = createRequire(resolve(process.cwd(), 'package.json'));
const ts = process.env.WEAKEN_PARSER_FILE
  ? require(resolve(process.env.WEAKEN_PARSER_FILE))
  : require('typescript');

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
// Maps, not object literals: `'toString' in {}` is true through the
// prototype chain, and a helper named after any Object.prototype member
// would otherwise register as a phantom collector whose callback's
// assertions vanish from the count.
const ROOTS = new Map([
  ['it', 'test'],
  ['test', 'test'],
  ['describe', 'describe'],
  ['suite', 'describe'],
]);
const XROOTS = new Map([
  ['xit', 'test'],
  ['xtest', 'test'],
  ['xdescribe', 'describe'],
]);
const HOOKS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll']);
const DISABLING = new Set(['skip', 'todo', 'fails', 'failing']);
const DISABLING_OPTIONS = new Set(['skip', 'todo', 'fails']);

const ZERO = () => ({
  language: 'other',
  assertions: 0,
  declared: 0,
  enabled: 0,
  disabled: [],
  enabledTitles: [],
});

function isStringLike(n) {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

// The constant value of an expression the parser can decide without a
// binding: literals of every kind (including object, array, regex and
// bigint), `undefined`/`void 0`/`NaN`/`Infinity`, a unary `!`/`-`/`+`/`~`
// of a constant, `+` of two constants, parentheses. `{ known: false }`
// for anything else — so one operator away from a shape this folds is
// never one operator away from escaping a signal.
function constant(node) {
  if (!node) return { known: false };
  if (ts.isParenthesizedExpression(node)) return constant(node.expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword)
    return { known: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword)
    return { known: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword)
    return { known: true, value: null };
  if (ts.isIdentifier(node) && node.text === 'undefined') {
    return { known: true, value: undefined };
  }
  if (ts.isVoidExpression(node)) return { known: true, value: undefined };
  if (ts.isNumericLiteral(node))
    return { known: true, value: Number(node.text) };
  if (ts.isBigIntLiteral(node))
    return { known: true, value: Number(node.text.replace(/n$/, '')) };
  if (isStringLike(node)) return { known: true, value: node.text };
  if (ts.isIdentifier(node) && node.text === 'NaN')
    return { known: true, value: Number.NaN };
  if (ts.isIdentifier(node) && node.text === 'Infinity')
    return { known: true, value: Number.POSITIVE_INFINITY };
  // Truthy by construction, and non-thenable: a test callback returning
  // one hands the runner nothing to await.
  if (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isRegularExpressionLiteral(node)
  ) {
    return { known: true, value: true };
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const inner = constant(node.operand);
    if (!inner.known) return inner;
    switch (node.operator) {
      case ts.SyntaxKind.ExclamationToken:
        return { known: true, value: !inner.value };
      case ts.SyntaxKind.MinusToken:
        return { known: true, value: -inner.value };
      case ts.SyntaxKind.PlusToken:
        return { known: true, value: +inner.value };
      case ts.SyntaxKind.TildeToken:
        return { known: true, value: ~inner.value };
      default:
        return { known: false };
    }
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = constant(node.left);
    const r = constant(node.right);
    if (
      l.known &&
      r.known &&
      (typeof l.value === 'string' || typeof l.value === 'number') &&
      (typeof r.value === 'string' || typeof r.value === 'number')
    ) {
      return { known: true, value: l.value + r.value };
    }
  }
  return { known: false };
}

function truthyConstant(node) {
  const c = constant(node);
  return c.known && Boolean(c.value);
}

function falsyConstant(node) {
  const c = constant(node);
  return c.known && !c.value;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const c = constant(node.argumentExpression);
    if (c.known && typeof c.value === 'string') return c.value;
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
  if (ts.isVariableDeclaration(p) && p.initializer === n) return true;
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

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (isStringLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const c = constant(name.expression);
    if (c.known && typeof c.value === 'string') return c.value;
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
          DISABLING_OPTIONS.has(propertyName(p.name)) &&
          truthyConstant(p.initializer),
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
  if (XROOTS.has(root)) return true;
  if (members.some((m) => m !== null && DISABLING.has(m))) return true;
  for (const c of calls) {
    const a = (c.call.arguments ?? [])[0];
    if (c.name === 'skipIf' && truthyConstant(a)) return true;
    if (c.name === 'runIf' && (!a || falsyConstant(a))) return true;
  }
  return optionsDisable(calls[calls.length - 1].call);
}

// A body-level unconditional skip: `skip()`, `ctx.skip()`, `this.skip()`.
// The runner skips unless the first argument is exactly `false`, so any
// constant other than `false` disables; a non-constant argument is the
// condition-valued environment guard and stays enabled.
function isBodySkip({ root, members, calls }) {
  if (root === null || ROOTS.has(root) || XROOTS.has(root)) return false;
  if (calls.length === 0) return false;
  const last = calls[calls.length - 1];
  const bare = root === 'skip' && members.length === 0 && calls.length === 1;
  if (!bare && last.name !== 'skip') return false;
  const a = (last.call.arguments ?? [])[0];
  if (!a) return true;
  const c = constant(a);
  return c.known && c.value !== false;
}

// True when `node` sits under a condition inside the nearest enclosing
// function: an if/switch/loop, a ternary, or a short-circuit operand.
function underCondition(node) {
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (
      ts.isIfStatement(p) ||
      ts.isConditionalExpression(p) ||
      ts.isSwitchStatement(p) ||
      ts.isCatchClause(p) ||
      ts.isIterationStatement(p, false) ||
      (ts.isBinaryExpression(p) &&
        (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
  }
  return false;
}

// A return the runner cannot distinguish from `return;`: it yields no
// value the test framework reads, so the test is reported PASSED with
// whatever follows the return unexecuted. Any CONSTANT qualifies —
// vitest ignores a callback's return value unless it is thenable — while
// `return expect(p).resolves.toBe(1)` and `return somePromise` stay
// ordinary control flow the runner awaits.
function returnsNothing(ret) {
  if (!ret.expression) return true;
  return constant(ret.expression).known;
}

// What an unconditional body skip disables: `{applies}` false when the
// skip sits in an ordinary function (a helper, a callback handed to
// something that is not a collector hook — nothing states the file ever
// runs it); otherwise the registration whose OWN callback holds it, or —
// for a collector hook's callback — the registration that hook belongs
// to, with `scope` null meaning the whole file.
function skipTarget(node, registrations) {
  for (let n = node, p = n.parent; p; n = p, p = p.parent) {
    if (!ts.isFunctionLike(p)) continue;
    const own = registrations.find((r) => r.fn === p);
    if (own) return { applies: true, scope: own };
    const call = p.parent;
    if (
      call &&
      ts.isCallExpression(call) &&
      (call.arguments ?? []).includes(p)
    ) {
      const { root } = chainOf(call);
      if (root !== null && HOOKS.has(root)) {
        return {
          applies: true,
          scope: enclosingRegistration(call, registrations),
        };
      }
    }
    return { applies: false, scope: null };
  }
  return { applies: true, scope: null };
}

// The innermost registration whose callback contains `node`.
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
  const hookBodies = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && !extendsChain(node)) {
      const chain = chainOf(node);
      if (
        chain.root !== null &&
        (ROOTS.has(chain.root) || XROOTS.has(chain.root)) &&
        chain.calls.length > 0
      ) {
        const last = chain.calls[chain.calls.length - 1].call;
        const fns = (last.arguments ?? []).filter(
          (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
        );
        registrations.push({
          kind: ROOTS.get(chain.root) ?? XROOTS.get(chain.root),
          title: titleOf(last, sf),
          disabled: registrationDisabled(chain),
          pos: node.getStart(sf),
          fn: fns.length ? fns[fns.length - 1] : null,
        });
      } else if (
        chain.root !== null &&
        HOOKS.has(chain.root) &&
        chain.calls.length > 0
      ) {
        const fns = (
          chain.calls[chain.calls.length - 1].call.arguments ?? []
        ).filter((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (fns.length) hookBodies.push(fns[fns.length - 1]);
      } else if (isStatementLevel(node) && isAssertion(chain)) {
        assertionPositions.push(node.getStart(sf));
      } else if (isBodySkip(chain) && !underCondition(node)) {
        bodySkips.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let fileDisabled = false;
  for (const skip of bodySkips) {
    const target = skipTarget(skip, registrations);
    if (!target.applies) continue;
    if (target.scope) target.scope.disabled = true;
    else fileDisabled = true;
  }
  if (fileDisabled) {
    for (const r of registrations) r.disabled = true;
  }
  // A disabled describe disables everything registered inside its callback,
  // whatever those registrations say for themselves.
  const disabledDescribes = registrations.filter(
    (r) => r.kind === 'describe' && r.disabled && r.fn,
  );
  for (const r of registrations) {
    if (r.disabled || r.pos === undefined) continue;
    for (const d of disabledDescribes) {
      if (d !== r && r.pos > d.fn.pos && r.pos < d.fn.end) {
        r.disabled = true;
        break;
      }
    }
  }
  // Nothing inside a disabled registration's callback executes.
  // A nothing-returning early return in a body's own control flow: in a
  // TEST it stops the assertions after it from being declared surface; in
  // a DESCRIBE it stops the registrations after it from being collected
  // at all, which is the same silencing `skip()` at that position gets.
  const guards = [];
  const suiteGuards = [];
  const collect = (fn, into) => {
    const walk = (n) => {
      if (n !== fn && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
      if (ts.isReturnStatement(n) && returnsNothing(n)) {
        into.push({ from: n.getStart(sf), start: fn.pos, end: fn.end });
      }
      ts.forEachChild(n, walk);
    };
    walk(fn);
  };
  for (const r of registrations) {
    if (!r.fn) continue;
    collect(r.fn, r.kind === 'test' ? guards : suiteGuards);
  }
  // A hook's own body stops at its own early return exactly as a test's
  // does; the assertions a `beforeEach` carries are surface too.
  for (const fn of hookBodies) collect(fn, guards);
  // A describe body's early return silences what follows it there too,
  // not only the registrations it stops the runner from collecting.
  const guarded = (p) =>
    [...guards, ...suiteGuards].some(
      (g) => p > g.from && p >= g.start && p < g.end,
    );
  for (const r of registrations) {
    if (r.disabled || r.pos === undefined) continue;
    if (
      suiteGuards.some(
        (g) => r.pos > g.from && r.pos >= g.start && r.pos < g.end,
      )
    ) {
      r.disabled = true;
    }
  }
  const silenced = registrations.filter((r) => r.disabled && r.fn);
  const executes = (p) => !silenced.some((r) => p > r.fn.pos && p < r.fn.end);
  const key = (r) => `${r.kind}:${r.title}`;
  const declaredAssertions = fileDisabled
    ? []
    : assertionPositions.filter(executes);
  const liveAssertions = declaredAssertions.filter((p) => !guarded(p));
  return {
    language: dialect.toLowerCase(),
    assertions: liveAssertions.length,
    declared: declaredAssertions.length,
    enabled: registrations.filter((r) => r.kind === 'test' && !r.disabled)
      .length,
    disabled: registrations.filter((r) => r.disabled).map(key),
    enabledTitles: registrations.filter((r) => !r.disabled).map(key),
  };
}

function countFile(file, path) {
  if (file === null || file === undefined) return ZERO();
  return count(readFileSync(file, 'utf8'), path);
}

function sameContent(a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) {
    return true;
  }
  if (!a || !b) return false;
  return readFileSync(a).equals(readFileSync(b));
}

function bag(keys) {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function bagAdd(m, k, n) {
  m.set(k, (m.get(k) ?? 0) + n);
}

export function measure({ path, tip, pre, events = [] }) {
  const t = countFile(tip, path);
  const p = countFile(pre, path);
  let assertions = t.assertions - p.assertions;
  let declared = t.declared - p.declared;
  let enabled = t.enabled - p.enabled;
  let baselinePresent = pre !== null && pre !== undefined;
  const baselineEnabled = bag(p.enabledTitles);
  // What main itself added joins the baseline; what main removed leaves
  // it. The branch's own entries are carried across the event on both
  // sides and change nothing.
  const absorb = (target, before, after) => {
    const b = bag(before);
    const a = bag(after);
    for (const [k, n] of a) bagAdd(target, k, Math.max(0, n - (b.get(k) ?? 0)));
    for (const [k, n] of b)
      bagAdd(target, k, -Math.max(0, n - (a.get(k) ?? 0)));
  };
  // What the event MODELLED, clamped by what it actually LANDED -- in ONE
  // direction. The two disagree whenever a merge resolution took neither
  // side whole: the model is what git's auto-merge would have produced,
  // the landed blob is what the merge commit holds.
  //
  // Main's ADDITIONS are never clamped. They raise the baseline whatever
  // the merge kept, or a round that drops what main added during the round
  // gets that removal for free.
  //
  // Main's REMOVALS are credited only as far as they landed. Without that
  // a round could merge main, discard its side, and let the phantom credit
  // absorb its own removal exactly.
  //
  // Equal, and the clamp is the identity: the ordinary merge measures as
  // it always did. What it cannot see is identity -- main removing one
  // assertion while the resolution restores it and drops another nets to
  // zero, the way an assertion moved within a file always has.
  const clamp = (modelled, landed) => {
    if (modelled >= 0) return modelled;
    if (landed >= 0) return 0;
    return Math.max(modelled, landed);
  };
  const clampBag = (modelled, landed) => {
    const out = new Map();
    for (const k of new Set([...modelled.keys(), ...landed.keys()])) {
      const v = clamp(modelled.get(k) ?? 0, landed.get(k) ?? 0);
      if (v !== 0) out.set(k, v);
    }
    return out;
  };
  for (const ev of events) {
    // PRESENCE follows main's own side, not the model's endpoint and not
    // the merge result: the baseline holds the file when main held it at
    // this event, whatever the resolution then did with it. Reading it off
    // a blob main never held is how a file the round authored itself comes
    // to read as baseline coverage; reading it off the merge result is how
    // a round discards a test main added and answers for nothing.
    if (ev.mainHolds !== undefined) baselinePresent = ev.mainHolds;
    if (sameContent(ev.before, ev.after)) continue;
    if (ev.mainHolds === undefined) {
      baselinePresent = ev.after !== null && ev.after !== undefined;
    }
    const landedRef = ev.landed !== undefined ? ev.landed : ev.after;
    const before = countFile(ev.before, path);
    const after = countFile(ev.after, path);
    const landed = sameContent(ev.after, landedRef)
      ? after
      : countFile(landedRef, path);
    assertions -= clamp(
      after.assertions - before.assertions,
      landed.assertions - before.assertions,
    );
    declared -= clamp(
      after.declared - before.declared,
      landed.declared - before.declared,
    );
    enabled -= clamp(
      after.enabled - before.enabled,
      landed.enabled - before.enabled,
    );
    const modelledTitles = new Map();
    absorb(modelledTitles, before.enabledTitles, after.enabledTitles);
    const landedTitles = new Map();
    absorb(landedTitles, before.enabledTitles, landed.enabledTitles);
    for (const [k, n] of clampBag(modelledTitles, landedTitles)) {
      bagAdd(baselineEnabled, k, n);
    }
  }
  const tipEnabled = bag(t.enabledTitles);
  const newlyDisabled = [];
  for (const [k, n] of bag(t.disabled)) {
    const owed = Math.max(
      0,
      (baselineEnabled.get(k) ?? 0) - (tipEnabled.get(k) ?? 0),
    );
    for (let i = 0; i < Math.min(n, owed); i += 1) newlyDisabled.push(k);
  }
  return {
    language: t.language === 'other' ? p.language : t.language,
    // Whichever total fell further: a guard planted ahead of existing
    // assertions shows in the first, assertions deleted from behind a
    // guard the baseline already carried show only in the second.
    assertions: Math.min(assertions, declared),
    enabled,
    newlyDisabled,
    baselinePresent,
  };
}

// Run the CLI only when this file IS the program. Without the guard the
// dispatch reads the argv of whatever imported it: a test runner invoked
// with a positional argument would land in the unknown-mode arm and take
// the importing process down with `process.exit(2)`.
// Compared as REAL paths: the gate runs this from RUNNER_TEMP, and on
// macOS that is reached through /var -> /private/var, so the argv string
// and the module URL disagree while naming the same file.
const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (
  process.argv[1] &&
  realOrSelf(fileURLToPath(import.meta.url)) === realOrSelf(process.argv[1])
) {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'count') {
    const text = readFileSync(0, 'utf8');
    process.stdout.write(`${JSON.stringify(count(text, arg ?? ''))}\n`);
  } else if (mode === 'measure') {
    const manifest = JSON.parse(readFileSync(arg, 'utf8'));
    process.stdout.write(`${JSON.stringify(measure(manifest))}\n`);
  } else {
    process.stderr.write(`count-test-surface: unknown mode '${mode ?? ''}'\n`);
    process.exit(2);
  }
}
