# Policy-decision "why" (P4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface _why_ the rc-gateway policy engine auto-decided a tool
call — a compact closed-enum `reason` on the streamed decision record, plus
an owner-scope `POST /policy/explain` dry-run returning the full per-rule
trace.

**Architecture:** Entirely inside `packages/rc-gateway/`. Component A adds
one derived field at the enforcer's five audit sites. Component B adds a
new route factory (`createPolicyExplainRoute`) that reuses the existing
`explainPolicy(...)` evaluator against the gateway's live, hot-reloaded
policy — reached through a getter bundle threaded into `createGatewayApp`
via a mutable `currentPolicy` holder (the same closure pattern the codebase
already uses for `mdnsAdvertiser`).

**Tech Stack:** TypeScript, Express 4, Vitest. SDK: `@qwen-code/sdk`.

## Global Constraints

- **No daemon change.** Nothing under `packages/cli/src/serve` or
  `packages/core`. `packages/rc-gateway/src/cli.ts` IS in scope; the
  daemon is NOT. `POST /policy/explain` makes no daemon call.
- **Metadata-only.** The `policy_decision` `reason`, the explain response,
  and the `policy_explained` audit row carry only ids, closed-enum tokens,
  operator-authored config strings (rule ids / rule `reason`), and
  booleans — NEVER the caller's simulated args, path, scope, or tag as
  values, and never session/tool content.
- **`reason` vocabulary is the site-derivable set only:** `rule-allow`,
  `rule-deny`, `rule-prompt`, `rule-downgraded-deferred`, `default`,
  `eval-error`. Near-miss causes (`quota-exhausted`, `expired`,
  `outside-time-window`) are NOT knowable at the audit site and MUST NOT
  appear there — they live only in the explain trace.
- **`/policy/explain` is `owner` scope, gateway-global (no `:id`),
  read-only.** It evaluates against the live policy anchored to the
  gateway's own project root; the request body cannot override the root.
- **The 4th arg to `explainPolicy` is a `QuotaOracle`** (`{ state(ruleId,
nowMs) }`), not a `QuotaStore` — adapt as
  `{ state: (id, ms) => store.state(id, ms) }`.
- Follow existing route conventions: factory `createXRoute(...):
RequestHandler`; fail-closed `res.status(N).json({ error, code })`;
  audit via `void deps.audit?.record({ action, actorTokenId:
req.rcClient?.id, subActor: req.rcClient?.subActor, ... })`.

---

### Task 1: Enforcer decision `reason`

**Files:**

- Modify: `packages/rc-gateway/src/policy/enforcer.ts`
- Test: `packages/rc-gateway/src/policy/enforcer.test.ts`

**Interfaces:**

- Consumes: `PolicyDecision { action: 'allow'|'deny'|'prompt'; source:
'policy'|'default'; ruleId?; usedDeferredField: boolean; … }` (from
  `./evaluator.js`).
- Produces: exported `policyDecisionReason(d: PolicyDecision): string`
  (used only here, but exported for direct unit testing).

The enforcer writes a `policy_decision` audit record at five sites in
`handlePermission` (`enforcer.ts`): the eval-error catch (~line 122, no
`PolicyDecision` in scope), the allow branch voted (~156) and not-voted
(~174), the deny branch voted (~197) and not-voted (~214), and the prompt
fall-through (~232). Each `detail` currently carries `{ requestId, action,
ruleId?, voted, decisionSource, quotaRemaining? }`. Add a `reason` field to
every one.

- [ ] **Step 1: Write the failing test for the reason mapping**

Add to `enforcer.test.ts` (top-level `describe`), importing
`policyDecisionReason`:

```ts
import { policyDecisionReason } from './enforcer.js';
import type { PolicyDecision } from './evaluator.js';

const dec = (over: Partial<PolicyDecision>): PolicyDecision => ({
  action: 'allow',
  source: 'policy',
  usedDeferredField: false,
  ...over,
});

describe('policyDecisionReason', () => {
  it('maps a matched allow/deny/prompt to rule-<action>', () => {
    expect(policyDecisionReason(dec({ action: 'allow' }))).toBe('rule-allow');
    expect(policyDecisionReason(dec({ action: 'deny' }))).toBe('rule-deny');
    expect(policyDecisionReason(dec({ action: 'prompt' }))).toBe('rule-prompt');
  });
  it('maps a no-rule-match default to "default" regardless of action', () => {
    expect(
      policyDecisionReason(dec({ source: 'default', action: 'prompt' })),
    ).toBe('default');
    expect(
      policyDecisionReason(dec({ source: 'default', action: 'allow' })),
    ).toBe('default');
  });
  it('maps a matched-but-unevaluable downgrade to rule-downgraded-deferred', () => {
    expect(
      policyDecisionReason(dec({ action: 'prompt', usedDeferredField: true })),
    ).toBe('rule-downgraded-deferred');
  });
  it('does not emit near-miss tokens (quota/expired/time-window)', () => {
    // an exhausted/expired rule falls through to source:'default'
    expect(policyDecisionReason(dec({ source: 'default' }))).toBe('default');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/enforcer.test.ts -t "policyDecisionReason"`
Expected: FAIL — `policyDecisionReason` is not exported.

- [ ] **Step 3: Add the exported mapping function**

In `enforcer.ts`, above the `PolicyEnforcer` class (after the imports), add:

```ts
/**
 * The site-derivable "why" token for a resolved decision (P4). Derived
 * purely from the decision the enforcer already holds — no trace recompute.
 * `eval-error` is NOT produced here (that branch has no PolicyDecision); the
 * catch site sets it literally. Near-miss causes (quota-exhausted, expired,
 * outside-time-window) make a rule fall through to source:'default', so they
 * are indistinguishable here from a genuine no-match — they surface only in
 * the explain trace, never in this token.
 */
export function policyDecisionReason(d: PolicyDecision): string {
  if (d.source === 'default') return 'default';
  if (d.usedDeferredField) return 'rule-downgraded-deferred';
  return `rule-${d.action}`;
}
```

Ensure `PolicyDecision` is imported as a type in `enforcer.ts` (it already
imports from `./evaluator.js`; add `PolicyDecision` to that type import if
not present).

- [ ] **Step 4: Run to verify the mapping test passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/enforcer.test.ts -t "policyDecisionReason"`
Expected: PASS.

- [ ] **Step 5: Add `reason` at all five audit sites**

In `handlePermission`, add the field to each `detail`:

- Eval-error catch branch (the `catch {}` after `evaluate(...)`): add
  `reason: 'eval-error',` to its `detail`.
- The other four (`d`-bearing) sites — the allow-voted, allow-not-voted,
  deny-voted, deny-not-voted, and prompt fall-through details: add
  `reason: policyDecisionReason(d),`.

Example (allow-voted site) — the detail becomes:

```ts
detail: {
  requestId,
  action: 'allow',
  ruleId: d.ruleId,
  voted: true,
  decisionSource: d.source,
  reason: policyDecisionReason(d),
  ...(quotaRemaining !== undefined ? { quotaRemaining } : {}),
},
```

Example (eval-error catch site) — the detail becomes:

```ts
detail: {
  requestId,
  action: 'prompt',
  voted: false,
  decisionSource: 'default',
  reason: 'eval-error',
},
```

Leave every existing field exactly as-is; `reason` is purely additive.

- [ ] **Step 6: Write failing tests asserting the audit `reason` at the branches**

Add to `enforcer.test.ts`. `enforcer.test.ts` has NO existing eval-error
test and does not import `vi`; the rule-decided branches ARE exercised —
mirror the existing `decisionSource` test (`enforcer.test.ts:304`,
`"stamps decisionSource:'policy' … 'default' on no-match"`) for the fake
`DaemonClient` + recording `audit` + frame harness. A helper to read the
recorded row (define once or reuse the file's existing accessor):

```ts
const policyDecisionDetail = (audit: {
  entries: Array<{ action: string; detail?: unknown }>;
}) =>
  audit.entries.find((e) => e.action === 'policy_decision')?.detail as
    | Record<string, unknown>
    | undefined;
```

**Rule-decided cases** — drive the same way `:304` does (a policy whose
rule denies → `deny`; an empty policy → no-match `default`):

```ts
it("reason 'rule-deny' on a rule-decided deny", async () => {
  // build the enforcer with a policy: rules:[{ match:{tool:<the frame's tool>}, action:'deny' }]
  // drive one permission frame, then:
  expect(policyDecisionDetail(audit)).toMatchObject({
    action: 'deny',
    decisionSource: 'policy',
    reason: 'rule-deny',
  });
});

it("reason 'default' on a no-rule-match", async () => {
  // enforcer with an empty policy (rules:[]) → default prompt, as :304's second half does
  expect(policyDecisionDetail(audit)).toMatchObject({
    decisionSource: 'default',
    reason: 'default',
  });
});
```

**Eval-error case** — there is no way to make `frameToContext`/`evaluate`
throw from outside (both read defensively), so spy the evaluator. Import
the module namespace and add `vi` to the vitest import; Vitest resolves the
enforcer's named `evaluate` import through the module namespace, so the
spy takes effect:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as evaluatorMod from './evaluator.js';

it("reason 'eval-error' when evaluation throws (fail-safe)", async () => {
  const spy = vi.spyOn(evaluatorMod, 'evaluate').mockImplementationOnce(() => {
    throw new Error('boom');
  });
  // drive one normal permission frame through the enforcer, then:
  expect(policyDecisionDetail(audit)).toMatchObject({
    action: 'prompt',
    decisionSource: 'default',
    reason: 'eval-error',
  });
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
```

If any PRE-EXISTING `policy_decision` assertion in this file uses `toEqual`
(exact match) on the detail, the new `reason` field will break it — switch
that assertion to `toMatchObject`, or add `reason` to its expected object.
Step 7's full run surfaces any such case.

- [ ] **Step 7: Run to verify all enforcer tests pass**

Run: `cd packages/rc-gateway && npx vitest run src/policy/enforcer.test.ts`
Expected: PASS (new reason assertions + all pre-existing tests).

- [ ] **Step 8: Typecheck**

Run: `cd packages/rc-gateway && npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors versus the pre-existing baseline.

- [ ] **Step 9: Commit**

```bash
git add packages/rc-gateway/src/policy/enforcer.ts packages/rc-gateway/src/policy/enforcer.test.ts
git commit -m "feat(rc-gateway): add closed-enum reason to policy_decision audit record"
```

---

### Task 2: `policy_explained` audit action + explain route factory

**Files:**

- Modify: `packages/rc-gateway/src/auditLog.ts`
- Create: `packages/rc-gateway/src/routes/policyExplain.ts`
- Test: `packages/rc-gateway/src/routes/policyExplain.test.ts`

**Interfaces:**

- Consumes: `explainPolicy(policy, ctx, now?, quota?): PolicyExplanation`,
  `ToolCallContext`, `QuotaOracle` (from `../policy/evaluator.js`);
  `Policy` (from `../policy/loader.js`); `POLICY_OPERATIONS` (from
  `../policy/loader.js`, = `['read','write','execute']`); `AuditRecorder`,
  `OWNER`/`hasScope` are NOT needed here (scope is enforced at the mount in
  Task 3).
- Produces:
  - `export interface PolicyExplainAccess { policy(): Policy | undefined;
projectRoot(): string; quotaOracle?(): QuotaOracle | undefined }`
  - `export function createPolicyExplainRoute(access: PolicyExplainAccess,
deps?: { audit?: AuditRecorder }): RequestHandler`
  - `export function buildExplainContext(body: PolicyExplainBody,
projectRoot: string): ToolCallContext` (throws `ExplainBodyError` on a
    bad `operation`).

- [ ] **Step 1: Add the `policy_explained` audit action**

In `auditLog.ts`, add `| 'policy_explained'` to the `AuditAction` union
(append after the final member `'session_approval_mode_set'`) AND add
`'policy_explained'` to the `AUDIT_ACTIONS` array (append after the final
entry `'session_approval_mode_set'`). Both edits are required — the union
types it, the array validates query params.

- [ ] **Step 2: Write the failing test for `buildExplainContext`**

Create `packages/rc-gateway/src/routes/policyExplain.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildExplainContext, ExplainBodyError } from './policyExplain.js';

describe('buildExplainContext', () => {
  it('maps tool/path/args/operation/scope/tag and anchors to projectRoot', () => {
    const ctx = buildExplainContext(
      {
        tool: 'write_file',
        path: '/etc/passwd',
        args: { path: '/etc/passwd', content: 'x' },
        operation: 'write',
        scope: 'owner',
        tag: 'ci',
      },
      '/work',
    );
    expect(ctx).toMatchObject({
      tool: 'write_file',
      projectRoot: '/work',
      cwd: '/work',
      paths: ['/etc/passwd'],
      operations: ['write'],
      originScope: 'owner',
      sessionTag: 'ci',
    });
    expect(ctx.args).toMatchObject({ path: '/etc/passwd' });
  });

  it('accepts operation as a comma list or array and validates each value', () => {
    expect(
      buildExplainContext({ tool: 'x', operation: 'read,write' }, '/w')
        .operations,
    ).toEqual(['read', 'write']);
    expect(
      buildExplainContext({ tool: 'x', operation: ['read', 'execute'] }, '/w')
        .operations,
    ).toEqual(['read', 'execute']);
    expect(() =>
      buildExplainContext({ tool: 'x', operation: 'fly' }, '/w'),
    ).toThrow(ExplainBodyError);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/routes/policyExplain.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the route file**

Create `packages/rc-gateway/src/routes/policyExplain.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import type { Policy } from '../policy/loader.js';
import { POLICY_OPERATIONS } from '../policy/loader.js';
import type { QuotaOracle, ToolCallContext } from '../policy/evaluator.js';
import { explainPolicy } from '../policy/evaluator.js';

/** Live handles the route needs, resolved per request (policy hot-reloads). */
export interface PolicyExplainAccess {
  /** Current (hot-reloaded) policy, or undefined when none is loaded. */
  policy(): Policy | undefined;
  /** Trusted pathGlob anchor — the gateway's own workspace, never body-supplied. */
  projectRoot(): string;
  /** Live quota oracle, or undefined (dry-run: maxPerWindow → prompt). */
  quotaOracle?(): QuotaOracle | undefined;
}

export interface PolicyExplainRouteDeps {
  audit?: AuditRecorder;
}

/** The accepted request body (all fields optional except `tool`). */
export interface PolicyExplainBody {
  tool?: unknown;
  args?: unknown;
  path?: unknown;
  operation?: unknown;
  scope?: unknown;
  tag?: unknown;
}

/** Thrown by {@link buildExplainContext} on an invalid `operation` value. */
export class ExplainBodyError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Map a JSON body to the evaluator's `ToolCallContext`, mirroring the
 * `policy explain` CLI (explain.ts): `path` becomes `paths:[path]` and is
 * merged into `args.path` when absent; `operation` accepts a comma string or
 * an array and each value is validated against read|write|execute. The
 * `projectRoot` is the gateway's own — the body cannot set it.
 */
export function buildExplainContext(
  body: PolicyExplainBody,
  projectRoot: string,
): ToolCallContext {
  const tool = typeof body.tool === 'string' ? body.tool : '';
  let args: unknown = body.args;
  const path = typeof body.path === 'string' ? body.path : undefined;
  if (path !== undefined) {
    if (isPlainObject(args)) {
      if (args['path'] === undefined) args['path'] = path;
    } else if (args === undefined) {
      args = { path };
    }
  }

  let operations: string[] | undefined;
  if (body.operation !== undefined) {
    const raw = (
      Array.isArray(body.operation) ? body.operation : [body.operation]
    )
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    for (const o of raw) {
      if (!(POLICY_OPERATIONS as readonly string[]).includes(o)) {
        throw new ExplainBodyError(
          `invalid operation '${o}'; expected one of ${POLICY_OPERATIONS.join(' | ')}`,
        );
      }
    }
    operations = raw;
  }

  const ctx: ToolCallContext = { tool, projectRoot, cwd: projectRoot };
  if (path !== undefined) ctx.paths = [path];
  if (args !== undefined) ctx.args = args;
  if (operations !== undefined) ctx.operations = operations;
  if (typeof body.scope === 'string') ctx.originScope = body.scope;
  if (typeof body.tag === 'string') ctx.sessionTag = body.tag;
  return ctx;
}

/**
 * `POST /policy/explain` — owner-only (enforced at the mount), read-only
 * dry-run against the live policy. No daemon call, no mutation. The response
 * ({ decision, trace }) reflects the caller's path/args only as closed-enum
 * classification tokens — never as values.
 */
export function createPolicyExplainRoute(
  access: PolicyExplainAccess,
  deps: PolicyExplainRouteDeps = {},
): RequestHandler {
  return (req, res) => {
    try {
      const body = (req.body ?? {}) as PolicyExplainBody;
      if (typeof body.tool !== 'string' || body.tool.length === 0) {
        res.status(400).json({ error: 'Missing tool', code: 'invalid_tool' });
        return;
      }
      let ctx: ToolCallContext;
      try {
        ctx = buildExplainContext(body, access.projectRoot());
      } catch (err) {
        if (err instanceof ExplainBodyError) {
          res
            .status(400)
            .json({ error: err.message, code: 'invalid_operation' });
          return;
        }
        throw err;
      }

      const policy = access.policy();
      if (!policy) {
        res
          .status(503)
          .json({ error: 'No policy loaded', code: 'policy_unavailable' });
        return;
      }

      const exp = explainPolicy(
        policy,
        ctx,
        new Date(),
        access.quotaOracle?.(),
      );

      void deps.audit?.record({
        action: 'policy_explained',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        detail: {
          tool: ctx.tool,
          decision: exp.decision.action,
          ...(exp.decision.ruleId ? { ruleId: exp.decision.ruleId } : {}),
        },
      });

      res.status(200).json({ decision: exp.decision, trace: exp.trace });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Policy explain failed',
          code: 'policy_explain_failed',
        });
      }
    }
  };
}
```

- [ ] **Step 5: Run `buildExplainContext` tests to green**

Run: `cd packages/rc-gateway && npx vitest run src/routes/policyExplain.test.ts`
Expected: PASS.

- [ ] **Step 6: Add route-handler unit tests (mocked req/res + stub access)**

Append to `policyExplain.test.ts`. Use a minimal fake `req`/`res` (no
Express server) and a hand-built `Policy`:

```ts
import {
  createPolicyExplainRoute,
  type PolicyExplainAccess,
} from './policyExplain.js';
import type { Policy } from '../policy/loader.js';

const POLICY: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'deny-write',
      match: { tool: 'write_file' },
      action: 'deny',
      reason: 'no writes',
    },
  ],
};

function fakeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
      return this;
    },
  };
}
const access: PolicyExplainAccess = {
  policy: () => POLICY,
  projectRoot: () => '/work',
  quotaOracle: () => undefined,
};

describe('createPolicyExplainRoute', () => {
  it('200s with a decision + trace for a matched rule', async () => {
    const audited: unknown[] = [];
    const h = createPolicyExplainRoute(access, {
      audit: {
        record: async (e) => {
          audited.push(e);
        },
      },
    });
    const res = fakeRes();
    await h(
      {
        body: { tool: 'write_file', path: '/x' },
        rcClient: { id: 't1', scopes: ['owner'] },
      } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(200);
    const out = res.body as { decision: { action: string }; trace: unknown[] };
    expect(out.decision.action).toBe('deny');
    expect(Array.isArray(out.trace)).toBe(true);
    // audit row: metadata only
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: 'policy_explained',
      actorTokenId: 't1',
      detail: { tool: 'write_file', decision: 'deny' },
    });
    // NEVER echoes the caller path
    expect(JSON.stringify(res.body)).not.toContain('/x');
  });

  it('400s on a missing tool', async () => {
    const h = createPolicyExplainRoute(access);
    const res = fakeRes();
    await h(
      { body: {}, rcClient: { id: 't1' } } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe('invalid_tool');
  });

  it('503s when no policy is loaded', async () => {
    const h = createPolicyExplainRoute({ ...access, policy: () => undefined });
    const res = fakeRes();
    await h(
      { body: { tool: 'read_file' }, rcClient: { id: 't1' } } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe('policy_unavailable');
  });
});
```

- [ ] **Step 7: Run the full route test file**

Run: `cd packages/rc-gateway && npx vitest run src/routes/policyExplain.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `cd packages/rc-gateway && npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors versus baseline.

- [ ] **Step 9: Commit**

```bash
git add packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/routes/policyExplain.ts packages/rc-gateway/src/routes/policyExplain.test.ts
git commit -m "feat(rc-gateway): policy_explained audit action + POST /policy/explain route factory"
```

---

### Task 3: Wire the live policy, mount the owner route, integration test

**Files:**

- Modify: `packages/rc-gateway/src/server.ts` (GatewayDeps field + mount)
- Modify: `packages/rc-gateway/src/cli.ts` (live-policy threading)
- Test: `packages/rc-gateway/src/routes/policyExplain.integration.test.ts`

**Interfaces:**

- Consumes: `createPolicyExplainRoute`, `PolicyExplainAccess` (Task 2);
  `OWNER`, `requireScope` (already imported in `server.ts`); `Policy`
  (from `./policy/loader.js`), `QuotaOracle` (from
  `./policy/evaluator.js`).

**Background (verified):** `createGatewayApp` (cli.ts:553) runs before the
policy loads (cli.ts:699) and the enforcer is built (743). The reloader's
`apply` (cli.ts:793-796) is the single site the live policy swaps. The
codebase already reads late-bound state through a closure over a `let`
declared before `createGatewayApp` (see `mdnsAdvertiser`, cli.ts:543 +
`mdnsStatus: () => mdnsAdvertiser?…`, cli.ts:587). Use that pattern.

- [ ] **Step 1: Add the `policyExplain` dep to `GatewayDeps` and mount the route**

In `server.ts`:

1. Add the imports near the other route imports:

```ts
import { createPolicyExplainRoute } from './routes/policyExplain.js';
import type { PolicyExplainAccess } from './routes/policyExplain.js';
```

2. Add an optional field to the `GatewayDeps` interface (near the other
   optional deps like `walDir`/`snooze`):

```ts
  /** Live policy access for POST /policy/explain (P4). Absent → route not mounted. */
  policyExplain?: PolicyExplainAccess;
```

3. Mount the route next to the other owner routes (near the rewind mount,
   after `audit`/`ownerEvents` exist). Gateway-global (no `:id`), owner
   scope, no session middleware (it is not session-scoped):

```ts
if (deps.policyExplain) {
  app.post(
    '/policy/explain',
    requireScope(OWNER, audit),
    createPolicyExplainRoute(deps.policyExplain, { audit }),
  );
}
```

- [ ] **Step 2: Thread the live policy through `cli.ts`**

In `cli.ts`:

1. Declare a mutable holder before `createGatewayApp` (alongside the other
   pre-app `let`s near `let mdnsAdvertiser;`, ~line 543). Ensure `Policy`
   is imported as a type:

```ts
// Live policy for POST /policy/explain, read through a closure so the route
// always sees the hot-reloaded ruleset (set at load + in the reloader apply).
let currentPolicy: Policy | undefined;
```

2. In the `createGatewayApp({ … })` deps object, add the access bundle
   (closures over `currentPolicy`, the existing `workspaceCwd`, and the
   `quota` local built later — the closures run only per-request, after
   boot, so referencing the later-initialized `quota` is safe, exactly as
   `mdnsStatus` references the later `mdnsAdvertiser`):

```ts
    policyExplain: {
      policy: () => currentPolicy,
      projectRoot: () => workspaceCwd ?? process.cwd(),
      // Local alias so the truthiness narrowing survives into the nested
      // arrow at tsc time (a bare `quota.state` inside the inner closure does
      // not stay narrowed — this is why enforcer.ts:106 uses `this.quota!`).
      quotaOracle: () => {
        const q = quota;
        return q ? { state: (id, ms) => q.state(id, ms) } : undefined;
      },
    },
```

3. Set `currentPolicy` at the load site — immediately after
   `const policy = await loadLayeredPolicy(...)` (cli.ts:699):

```ts
currentPolicy = policy;
```

4. Keep it current on hot-reload — inside the reloader's `apply`
   (cli.ts:793-796), add the assignment alongside the existing swap:

```ts
      apply: (p) => {
        activeEnforcer.setPolicy(p);
        applyQuotaLimits(p);
        currentPolicy = p;
      },
```

- [ ] **Step 3: Typecheck the wiring**

Run: `cd packages/rc-gateway && npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors versus baseline (confirms the `quota` /
`workspaceCwd` / `currentPolicy` closures type-check and `GatewayDeps`
accepts the bundle).

- [ ] **Step 4: Write the failing end-to-end integration test**

Create `packages/rc-gateway/src/routes/policyExplain.integration.test.ts`.
Mirror `approvalMode.integration.test.ts`'s harness (real
`createGatewayApp` + `startStubDaemon` + `TokenStore`), and pass a
hand-built `policyExplain` access (there is no way to inject policy through
`createGatewayApp` otherwise — see recon):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { startStubDaemon } from '../testing/stubDaemon.js';
import type { Policy } from '../policy/loader.js';

const POLICY: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'deny-write',
      match: { tool: 'write_file' },
      action: 'deny',
      reason: 'no writes',
    },
  ],
};

async function boot() {
  const base = mkdtempSync(join(tmpdir(), 'p4-'));
  const stub = await startStubDaemon();
  const daemon = new DaemonClient(stub.url);
  const store = await TokenStore.open(join(base, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const { token: writer } = await store.issue(['write'], 'w');
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath: join(base, 'audit.log'),
    policyExplain: {
      policy: () => POLICY,
      projectRoot: () => base,
      quotaOracle: () => undefined,
    },
  });
  const server = gw.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/policy/explain`;
  return { base, stub, server, owner, writer, url };
}

let ctx: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(async () => {
  if (ctx) {
    ctx.server.close();
    await ctx.stub.close();
    ctx = undefined;
  }
});

describe('POST /policy/explain (integration)', () => {
  it('owner gets a full trace; the response never echoes the caller path', async () => {
    ctx = await boot();
    const r = await fetch(ctx.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.owner}`,
      },
      body: JSON.stringify({ tool: 'write_file', path: '/etc/secret-xyz' }),
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      decision: { action: string };
      trace: unknown[];
    };
    expect(out.decision.action).toBe('deny');
    expect(out.trace.length).toBeGreaterThan(0);
    // metadata safety: no field reflects the simulated path back
    expect(JSON.stringify(out)).not.toContain('/etc/secret-xyz');
  });

  it('rejects a write-scope token with 403', async () => {
    ctx = await boot();
    const r = await fetch(ctx.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.writer}`,
      },
      body: JSON.stringify({ tool: 'write_file' }),
    });
    expect(r.status).toBe(403);
  });
});
```

(If the stub-daemon or token-issue call shapes differ from the snippet,
copy them verbatim from `approvalMode.integration.test.ts` — that file is
the authoritative harness; only the `policyExplain` dep and the two
assertions are new.)

- [ ] **Step 5: Run the integration test**

Run: `cd packages/rc-gateway && npx vitest run src/routes/policyExplain.integration.test.ts`
Expected: PASS (owner 200 + no echo; write 403).

- [ ] **Step 6: Run the full rc-gateway suite**

Run: `cd packages/rc-gateway && npx vitest run`
Expected: all green — no regressions across policy, rewind, agents,
workflows, reviews, approval-mode.

- [ ] **Step 7: Final typecheck**

Run: `cd packages/rc-gateway && npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors versus baseline.

- [ ] **Step 8: Commit**

```bash
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/cli.ts packages/rc-gateway/src/routes/policyExplain.integration.test.ts
git commit -m "feat(rc-gateway): mount owner POST /policy/explain against the live policy"
```
