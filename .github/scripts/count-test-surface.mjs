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
//     own rule) and that is not itself under a REAL condition — an
//     `if (true)` wrapper never withholds its branch, and a `catch`
//     whose `try` holds an assertion fires exactly when that assertion
//     fails, so neither shelters a skip — and every registration
//     nested inside a disabled `describe`. A body skip at file
//     scope — a statement of the module, or inside a `beforeEach`/
//     `beforeAll`/`afterEach`/`afterAll` callback the file registers —
//     disables the whole file, which is what the runner does with it. A
//     registration callback handed by NAME resolves to the single
//     module-scope function declaration or function-valued variable
//     initializer of that name — the runner receives that very
//     function — while an absent, redeclared or nested binding stays
//     opaque. A constant is a literal of any kind (object, array,
//     regex and bigint included), `undefined`/`void 0`/`NaN`/`Infinity`,
//     a unary `!`/`-`/`+`/`~` of a constant, `+` of two string/number
//     constants, a comparison or equality of two primitive constants,
//     a logical `&&`/`||`/`??` of two constants, and any of those
//     behind a type-only wrapper (`as`, `<T>x`, `satisfies`, `!`).
// Deliberately NOT measured, because they are runtime facts the runner is the
// authority for, not declarations: whether an assertion is REACHABLE (dead
// code, a condition that is false in CI, a helper never called), a
// condition-valued guard (`it.skipIf(process.platform === 'win32')`,
// `skip(cond, reason)`, `if (cond) ctx.skip()`, a skip in a `catch`
// whose `try` asserts nothing — this repository's environment-guard
// idiom; the assertions an honest guard shelters are measured, its
// condition is not), and options or collector names carried by a
// binding (`test('x', opts, fn)`, `it[S]('x')`).
//
// `measure` takes {"path", "tip", "pre", "events":
// [{"before", "after", "landed", "mainHolds"}]} — blob files (null =
// absent) for the round's tip, the pre-round ref, and each main-derived
// event the round's history carries (a merge of main, a fast-forwarded
// main commit). For a merge, `after` is MAIN'S OWN side and `before` is
// the merge base it is measured against; for a fast-forwarded commit they
// are the commit and its first parent. `landed` is what the merge commit
// actually holds, and `mainHolds` says whether main held the file at all.
// The round's own delta is tip − pre − Σ(clamped after − before) for each
// total: main's contribution neither charges nor shields, whichever commit
// sequence produced the tip, and the assertion delta reported is the lower
// of the two. Registrations are
// tracked as multisets keyed `kind:title`: the baseline's enabled set is the
// pre-round set plus what main itself enabled across the events minus what
// main disabled, and a tip-disabled registration is charged only while the
// baseline holds more enabled copies of its key than the tip does. An event
// whose before and after are byte-identical (or both absent) moved no
// content, so it neither charges nor shields; whether the baseline HOLDS
// the file is decided separately, by main's side against the merge base.
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
// `fixme` rides the same arm: Playwright's expected-failure mark skips
// the test, which is what `fails`/`failing` already say here.
const DISABLING = new Set(['skip', 'todo', 'fails', 'failing', 'fixme']);
const DISABLING_OPTIONS = new Set(['skip', 'todo', 'fails']);
// Members under a `test.*` root that still name a collector: anything
// else (`step`, `use`, `setTimeout`, `expect`, …) is a utility call, not
// a registration (R30-2). `extend` is deliberately absent — it is a
// factory whose binding is opaque to this instrument.
const PW_COLLECTOR_MEMBERS = new Set([
  'skip',
  'todo',
  'fails',
  'failing',
  'fixme',
  'only',
  'each',
  'for',
  'concurrent',
  'sequential',
  'skipIf',
  'runIf',
  'describe',
  'suite',
  'configure',
]);

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

// Type-only wrappers carry no value of their own — `as T`, `<T>x`,
// `x satisfies T`, `x!` and parentheses all evaluate to their operand —
// so every fold in constant() and the options-object test see through
// them. `await` and `void` are NOT transparent (one unwraps a thenable,
// the other discards the value) and keep their own handling instead.
function unwrap(node) {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n))
  ) {
    n = n.expression;
  }
  return n;
}

// The object/array/regex and bigint folds carry no VALUE — the former a
// truthiness placeholder, the latter a Number with the int64 semantics
// dropped — so neither may feed an operator whose answer depends on the
// value (unary -/+/~, binary arithmetic, comparison). `!x` and the
// logical selectors read truthiness alone and stay foldable (R32-1).
function opaqueLiteral(node) {
  const u = unwrap(node);
  return (
    ts.isObjectLiteralExpression(u) ||
    ts.isArrayLiteralExpression(u) ||
    ts.isRegularExpressionLiteral(u) ||
    ts.isBigIntLiteral(u)
  );
}

// The constant value of an expression the parser can decide without a
// binding: literals of every kind (including object, array, regex and
// bigint), `undefined`/`void 0`/`NaN`/`Infinity`, a unary `!`/`-`/`+`/`~`
// of a constant, `+` of two string/number constants, a comparison or
// equality of two primitive constants, a logical `&&`/`||`/`??` of two
// constants, and any of those behind a type-only wrapper. `{ known:
// false }` for anything else — so one operator away from a shape this
// folds is never one operator away from escaping a signal.
function constant(node) {
  if (!node) return { known: false };
  node = unwrap(node);
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
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.TildeToken:
        // A placeholder is not an operand: `-[]` is -0 (falsy) where the
        // placeholder's `-true` reads truthy (R32-1).
        if (opaqueLiteral(node.operand)) return { known: false };
        return {
          known: true,
          value:
            node.operator === ts.SyntaxKind.MinusToken
              ? -inner.value
              : node.operator === ts.SyntaxKind.PlusToken
                ? +inner.value
                : ~inner.value,
        };
      default:
        return { known: false };
    }
  }
  if (ts.isBinaryExpression(node)) {
    const l = constant(node.left);
    const r = constant(node.right);
    if (!l.known || !r.known) return { known: false };
    const op = node.operatorToken.kind;
    // The logical operators select an operand by truthiness alone, which
    // the object/array/regex placeholder (`true`) answers faithfully.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return { known: true, value: l.value ? r.value : l.value };
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      return { known: true, value: l.value ? l.value : r.value };
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      return {
        known: true,
        value: l.value === null || l.value === undefined ? r.value : l.value,
      };
    }
    if (op === ts.SyntaxKind.PlusToken) {
      if (
        (typeof l.value === 'string' || typeof l.value === 'number') &&
        (typeof r.value === 'string' || typeof r.value === 'number')
      ) {
        return { known: true, value: l.value + r.value };
      }
      return { known: false };
    }
    // Comparison and equality evaluate natively — JS semantics ARE the
    // runner's — but only on primitives: the object/array/regex fold is a
    // truthiness placeholder, not a value (`{} === {}` must never fold
    // true), and a bigint literal folds to a Number for arithmetic, which
    // `1n === 1` would mis-fold.
    if (opaqueLiteral(node.left) || opaqueLiteral(node.right)) {
      return { known: false };
    }
    const a = l.value;
    const b = r.value;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      return { known: true, value: a === b };
    }
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      return { known: true, value: a !== b };
    }
    if (op === ts.SyntaxKind.EqualsEqualsToken) {
      return { known: true, value: a == b };
    }
    if (op === ts.SyntaxKind.ExclamationEqualsToken) {
      return { known: true, value: a != b };
    }
    if (op === ts.SyntaxKind.LessThanToken) {
      return { known: true, value: a < b };
    }
    if (op === ts.SyntaxKind.LessThanEqualsToken) {
      return { known: true, value: a <= b };
    }
    if (op === ts.SyntaxKind.GreaterThanToken) {
      return { known: true, value: a > b };
    }
    if (op === ts.SyntaxKind.GreaterThanEqualsToken) {
      return { known: true, value: a >= b };
    }
    // Arithmetic and bitwise apply JavaScript's own operators, so the
    // fold IS the runtime's answer; the opaque guard above has already
    // kept placeholders and bigints out.
    if (op === ts.SyntaxKind.MinusToken) return { known: true, value: a - b };
    if (op === ts.SyntaxKind.AsteriskToken)
      return { known: true, value: a * b };
    if (op === ts.SyntaxKind.SlashToken) return { known: true, value: a / b };
    if (op === ts.SyntaxKind.PercentToken) return { known: true, value: a % b };
    if (op === ts.SyntaxKind.AsteriskAsteriskToken)
      return { known: true, value: a ** b };
    if (op === ts.SyntaxKind.AmpersandToken)
      return { known: true, value: a & b };
    if (op === ts.SyntaxKind.BarToken) return { known: true, value: a | b };
    if (op === ts.SyntaxKind.CaretToken) return { known: true, value: a ^ b };
    if (op === ts.SyntaxKind.LessThanLessThanToken)
      return { known: true, value: a << b };
    if (op === ts.SyntaxKind.GreaterThanGreaterThanToken)
      return { known: true, value: a >> b };
    if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken)
      return { known: true, value: a >>> b };
    return { known: false };
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
    } else if (
      ts.isNonNullExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n))
    ) {
      // Type-only wrappers are chain-transparent: `(it as any).skip(...)`
      // IS a skip of `it`.
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
  return (call.arguments ?? []).some((arg) => {
    const o = unwrap(arg);
    return (
      ts.isObjectLiteralExpression(o) &&
      o.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          DISABLING_OPTIONS.has(propertyName(p.name)) &&
          truthyConstant(p.initializer),
      )
    );
  });
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

// True when `node` sits under a REAL condition inside the nearest
// enclosing function: an if/switch/loop, a ternary, or a short-circuit
// operand. A wrapper whose deciding operand constant-folds is walked
// through ARM-AWARE: the arm the constant takes is no condition at all
// (`if (true) ctx.skip()`, `true && ctx.skip()`), and the arm it skips
// is dead code that disables nothing (`if (false) { ctx.skip(); }` never
// runs, while `if (false) {} else { ctx.skip(); }` DOES disable — the
// runner reaches the else). A `catch` whose try block holds a counted
// assertion fires exactly when that assertion fails — a skip in either
// is the runner's unconditional outcome, not an environment guard.
// `assertionPositions` must be complete when this runs: callers collect
// their skips during the visit and resolve them after it.
function underCondition(node, assertionPositions) {
  const K = ts.SyntaxKind;
  const inside = (container) =>
    !!container && node.pos >= container.pos && node.end <= container.end;
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (ts.isIfStatement(p)) {
      if (inside(p.expression)) return true;
      const c = constant(p.expression);
      if (!c.known) return true;
      // The arm a constant-true `if` takes is no condition at all; the
      // other arm never runs, so a skip there disables nothing and reads
      // as guard-shaped either way. `if (false) {} else { ctx.skip(); }`
      // is the runner skipping, and it must not hide here.
      if (Boolean(c.value) === inside(p.thenStatement)) continue;
      return true;
    }
    if (ts.isCatchClause(p)) {
      const tryBlock = ts.isTryStatement(p.parent) ? p.parent.tryBlock : null;
      if (
        tryBlock &&
        assertionPositions.some((a) => a > tryBlock.pos && a < tryBlock.end)
      ) {
        continue;
      }
      return true;
    }
    if (ts.isConditionalExpression(p)) {
      if (inside(p.condition)) return true;
      if (!inside(p.whenTrue) && !inside(p.whenFalse)) return true;
      const c = constant(p.condition);
      if (!c.known) return true;
      if (Boolean(c.value) === inside(p.whenTrue)) continue;
      return true;
    }
    if (ts.isSwitchStatement(p) || ts.isIterationStatement(p, false)) {
      return true;
    }
    if (
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === K.AmpersandAmpersandToken ||
        p.operatorToken.kind === K.BarBarToken ||
        p.operatorToken.kind === K.QuestionQuestionToken)
    ) {
      if (inside(p.left)) continue;
      const l = constant(p.left);
      if (!l.known) return true;
      const shortCircuits =
        (p.operatorToken.kind === K.AmpersandAmpersandToken && !l.value) ||
        (p.operatorToken.kind === K.BarBarToken && !!l.value) ||
        (p.operatorToken.kind === K.QuestionQuestionToken &&
          l.value !== null &&
          l.value !== undefined);
      // A decidable short-circuit's right operand either always runs or
      // never does: `true && ctx.skip()` skips, `false && ctx.skip()` is
      // dead code that disables nothing.
      if (!shortCircuits) continue;
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
  // A template's value is a string however its substitutions evaluate —
  // never a thenable — so the runner ignores it exactly like the literal
  // spellings constant() folds.
  if (ts.isTemplateExpression(unwrap(ret.expression))) return true;
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
  // A callback handed by NAME resolves to the single module-scope function
  // declaration or function-valued variable initializer of that name — the
  // runner receives that very function, so the registration measures
  // through its body. An absent, redeclared or nested binding stays
  // opaque.
  const topFns = new Map();
  const ambiguousFns = new Set();
  const bindTopFn = (name, fnNode) => {
    if (ambiguousFns.has(name) || topFns.has(name)) {
      ambiguousFns.add(name);
      topFns.delete(name);
    } else {
      topFns.set(name, fnNode);
    }
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      bindTopFn(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer))
        ) {
          bindTopFn(d.name.text, d.initializer);
        }
      }
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && !extendsChain(node)) {
      const chain = chainOf(node);
      if (
        chain.root !== null &&
        (ROOTS.has(chain.root) || XROOTS.has(chain.root)) &&
        chain.calls.length > 0
      ) {
        const last = chain.calls[chain.calls.length - 1].call;
        const lastArgs = last.arguments ?? [];
        // Playwright namespaces its API on `test`: the kind and the hook
        // boundary follow the chain's first member, so `test.describe` is
        // a SUITE (a disabled one propagates into its body), a
        // `test.beforeEach` is a hook, and the utility members
        // (`test.step`, `test.use`, …) register nothing at all (R30-2).
        const firstMember = chain.members.find((m) => m !== null) ?? null;
        if (
          chain.root === 'test' &&
          firstMember !== null &&
          HOOKS.has(firstMember)
        ) {
          const fns = lastArgs.filter(
            (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
          );
          if (fns.length) hookBodies.push(fns[fns.length - 1]);
          ts.forEachChild(node, visit);
          return;
        }
        if (
          chain.root === 'test' &&
          firstMember !== null &&
          !PW_COLLECTOR_MEMBERS.has(firstMember)
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        // A chain that never reaches a registration call registers
        // nothing: `it.skipIf(cond)`, `it.each(cases)` and
        // `test.extend({})` are collector FACTORIES, and binding one to a
        // variable is not a test. The terminal call carries the title or
        // the callback.
        const terminates =
          lastArgs.length > 0 &&
          (isStringLike(lastArgs[0]) ||
            ts.isTemplateExpression(lastArgs[0]) ||
            lastArgs.some(
              (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
            ) ||
            (lastArgs.length > 1 &&
              ts.isIdentifier(lastArgs[lastArgs.length - 1]) &&
              topFns.has(lastArgs[lastArgs.length - 1].text)));
        if (terminates) {
          const fns = lastArgs.filter(
            (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
          );
          let fn = fns.length ? fns[fns.length - 1] : null;
          if (!fn) {
            const lastArg = lastArgs[lastArgs.length - 1];
            if (ts.isIdentifier(lastArg)) {
              fn = topFns.get(lastArg.text) ?? null;
            }
          }
          registrations.push({
            // A namespaced suite is a SUITE: `test.describe(...)` reads
            // as kind describe, or its disabled state never propagates
            // into the body (R30-2).
            kind:
              firstMember === 'describe' || firstMember === 'suite'
                ? 'describe'
                : (ROOTS.get(chain.root) ?? XROOTS.get(chain.root)),
            title: titleOf(last, sf),
            disabled: registrationDisabled(chain),
            pos: node.getStart(sf),
            fn,
          });
        }
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
      } else if (isBodySkip(chain)) {
        // Conditional-or-not is decided after the visit: a catch clause is
        // a condition only when its try holds no assertion, which needs
        // the complete assertionPositions.
        bodySkips.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let fileDisabled = false;
  for (const skip of bodySkips) {
    if (underCondition(skip, assertionPositions)) continue;
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
      // Only a return the runner provably reaches on EVERY entry silences
      // what follows: one under a runtime condition is the
      // environment-guard idiom whose sheltered assertions stay measured
      // (R27-21/R27-27), and one in dead code never runs.
      if (
        ts.isReturnStatement(n) &&
        returnsNothing(n) &&
        !underCondition(n, assertionPositions)
      ) {
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
  // A body shared between a disabled and an enabled registration stays
  // live: the enabled one executes it, so its assertions are surface.
  const liveFns = new Set(
    registrations.filter((r) => !r.disabled && r.fn).map((r) => r.fn),
  );
  const silenced = registrations.filter(
    (r) => r.disabled && r.fn && !liveFns.has(r.fn),
  );
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

// Nothing the COMPARISON below can see was read from this file: no
// assertion and no enabled registration, which is what the instrument
// reports for a shape it does not parse and for a file that declares
// nothing alike. Disabled registrations do not count as content here,
// because `sameSurface` cannot see them either -- calling a skips-only
// file non-empty would route it to a comparator blind to the only thing
// in it, and no rewrite of it would ever read as movement.
function isEmptySurface(c) {
  return c.declared === 0 && c.enabledTitles.length === 0;
}

// Two counts describe the same CHARGEABLE surface: the assertion totals
// and the enabled-registration multiset. `enabled` is the count of `test:`
// keys in that same multiset, so comparing it adds nothing. A side's
// DISABLED registrations are left out on purpose: they reach no signal --
// only the tip's do -- so main moving them alone is not coverage arriving,
// and treating it as such would re-charge a deletion an earlier round
// already answered for. A file that is NOTHING BUT disabled registrations
// is not compared here at all; `isEmptySurface` sends it to the bytes,
// where its rewrites are visible.
function sameSurface(a, b) {
  const same = (x, y) => {
    if (x.size !== y.size) return false;
    for (const [k, n] of x) if (y.get(k) !== n) return false;
    return true;
  };
  return (
    a.assertions === b.assertions &&
    a.declared === b.declared &&
    same(bag(a.enabledTitles), bag(b.enabledTitles))
  );
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
  // side whole: the model is main's own delta, the landed blob is what the
  // merge commit holds.
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
    const landedRef = ev.landed !== undefined ? ev.landed : ev.after;
    // PRESENCE follows what main CONTRIBUTED to the path. Main holding the
    // file and having moved it puts the file in the baseline, whatever the
    // resolution then did with it -- a round that discards what main landed
    // still answers for it. Main deleting it takes it out only when the
    // merge adopted that deletion; a resolution that kept the file leaves
    // it in the round's hands. Main merely still HOLDING a file it has
    // always held contributes nothing and says nothing: the baseline there
    // is the pre-round ref's, which is where a file the round removed in an
    // EARLIER round already stands removed.
    if (ev.mainHolds !== undefined) {
      const baseHolds = ev.before !== null && ev.before !== undefined;
      const landedHolds = landedRef !== null && landedRef !== undefined;
      // "Moved" means the measured SURFACE moved, not the bytes: main
      // appending a comment to a file an earlier round deleted contributes
      // no coverage, and reading it as a contribution would re-charge that
      // deletion in every round main happens to touch the file.
      //
      // When BOTH sides measure to nothing, that reading is unavailable --
      // an empty surface is what this instrument reports for a file it
      // cannot parse as well as for a file that declares nothing -- so
      // movement falls back to the bytes. The test is what was MEASURED,
      // never the extension: a `.test.ts` that registers nothing measures
      // exactly like a `.py`, and keying on the extension would leave its
      // deletion free. The cost of the fallback is that main touching such
      // a file at all reads as a contribution, so a file an earlier round
      // deleted is charged again; that is fail-closed and one ack entry
      // answers it, where the alternative loses the deletion arm -- the
      // only arm these shapes have.
      const beforeCount = countFile(ev.before, path);
      const afterCount = countFile(ev.after, path);
      const readable =
        !isEmptySurface(beforeCount) || !isEmptySurface(afterCount);
      const moved =
        !baseHolds ||
        (readable
          ? !sameSurface(beforeCount, afterCount)
          : !sameContent(ev.before, ev.after));
      if (ev.mainHolds && moved) {
        baselinePresent = true;
      } else if (!ev.mainHolds && baseHolds && !landedHolds) {
        // `!landedHolds` is redundant for manifests the gate produces --
        // it drops the event entirely when main holds no side and the merge
        // kept the file -- and load-bearing for any other producer.
        baselinePresent = false;
      }
    }
    if (sameContent(ev.before, ev.after)) continue;
    if (ev.mainHolds === undefined) {
      baselinePresent = ev.after !== null && ev.after !== undefined;
    }
    const before = countFile(ev.before, path);
    const after = countFile(ev.after, path);
    const landed = sameContent(ev.after, landedRef)
      ? after
      : countFile(landedRef, path);
    // "What actually landed" is the merge result measured against the
    // BRANCH's own side at the merge, not against the merge base: the
    // latter folds the round's own pre-merge edits into main's landed
    // contribution, so a resolution that kept the branch's side whole
    // would credit main's discarded removal against the round's own
    // (R27-20). A fast-forwarded main commit carries no branch side —
    // its landed blob is main's own, and the merge base is the right
    // baseline there.
    const landedBase =
      ev.branch !== undefined && ev.branch !== null
        ? countFile(ev.branch, path)
        : before;
    assertions -= clamp(
      after.assertions - before.assertions,
      landed.assertions - landedBase.assertions,
    );
    declared -= clamp(
      after.declared - before.declared,
      landed.declared - landedBase.declared,
    );
    enabled -= clamp(
      after.enabled - before.enabled,
      landed.enabled - landedBase.enabled,
    );
    const modelledTitles = new Map();
    absorb(modelledTitles, before.enabledTitles, after.enabledTitles);
    const landedTitles = new Map();
    absorb(landedTitles, landedBase.enabledTitles, landed.enabledTitles);
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
