# Cycle 33 plan — routing per-subscription targeting (`scopeIn`/`tokenIdsIn`)

TDD, fail-safe commit order (pure module first / notifier wiring last). See the
companion design doc for Decisions D1–D7.

## Commit 1 — docs

Spec + this plan.

> `docs(rc-gateway): cycle 33 spec+plan — routing per-subscription targeting`

## Commit 2 — rules.ts: `scopeIn`/`tokenIdsIn` schema + partition + per-sub matcher (inert)

Tests first in `src/routing/rules.test.ts`:

- `loadRoutingConfig` keeps `scopeIn`/`tokenIdsIn` as string and as string-list.
- malformed `scopeIn` / `tokenIdsIn` (number, mixed list) → `RoutingError`.
- deferred-warning test: swap the `scopeIn:[owner]` example (now honored) for a
  still-deferred field (`originatingClientScope`); assert still warns once.
- `firstDropForSubscription`:
  - `scopeIn:[share]` drops a sub whose token scopes include `share`, not one
    without; returns the rule id / `null`.
  - `tokenIdsIn:[t1]` drops a sub with `tokenId===t1`, not `t2`.
  - AND: rule `{kind:permission.required, scopeIn:[share]}` — sub with share but
    wrong kind → null; right kind but no share → null; both → id.
  - `scopeIn:[]` and `tokenIdsIn:[]` → drops nobody (D5).
  - first matching per-sub drop rule wins; unnamed → `<unnamed>` (reuse the
    `||` guard).
- **safety property (named test):** a rule with `scopeIn`/`tokenIdsIn` returns
  `null` from `firstDrop` (never suppresses the whole fan-out).
- a pure-global rule (`kind` only) returns `null` from
  `firstDropForSubscription` (it lives in the global pass).

Implementation in `src/routing/rules.ts`:

- `RoutingRuleMatch` += `scopeIn?: string | string[]`, `tokenIdsIn?: string | string[]`.
- loader: validate each via `isStringOrStringArray` → `RoutingError` else set.
- `MATCH_HONORED` += `'scopeIn'`, `'tokenIdsIn'`.
- new `RoutingSubscription` interface `{ tokenId: string; scopes: readonly string[] }`.
- `RoutingMatcher` += optional
  `firstDropForSubscription?(ev: {kind; sessionName?}, sub: RoutingSubscription): string | null`.
- `matchScopeIn(spec, scopes)`: `undefined`→true; else `scopes.some(s => spec includes s)`
  (spec normalized to array).
- `matchTokenIdsIn(spec, tokenId)`: `undefined`→true; else membership.
- `compileRouting`: `hasPerSub = r.match.scopeIn !== undefined || r.match.tokenIdsIn !== undefined`;
  `globalDropRules = drop && !hasPerSub`; `perSubDropRules = drop && hasPerSub`.
  `firstDrop` iterates `globalDropRules`; `firstDropForSubscription` iterates
  `perSubDropRules`, AND of `matchKind`∧`matchSessionTag`∧`matchScopeIn`∧
  `matchTokenIdsIn`, `return r.id || '<unnamed>'`.

Verify subset: `npx vitest run --root packages/rc-gateway src/routing/rules.test.ts`.

> `feat(rc-gateway): routing scopeIn/tokenIdsIn per-subscription match (inert)`

## Commit 3 — notifier.ts: wire the per-sub drop gate (last)

Tests first in `src/webpush/notifier.test.ts` (inline matcher stubs, like the
cycle-25 `{ firstDrop: () => … }` ones):

- a matcher whose `firstDropForSubscription` returns an id for the share sub but
  `null` for the approver sub → only the approver receives the push; audit has a
  `push_suppressed { reason:'routing_rule', ruleId, subscriptionId }` for the share.
- `firstDropForSubscription` absent (old-style stub) → delivery unchanged
  (proves the optional-call guard).
- global `firstDrop` still suppresses whole fan-out, audits once (unchanged).
- `notifyToken` (/test) NOT gated by per-sub routing.

Implementation in `src/webpush/notifier.ts`: after the session-lock check
(`lock !== undefined …`) and before the prefs filter, with `scopes` in scope:

```ts
const perSubDrop = this.routing?.firstDropForSubscription?.(
  { kind: payload.kind, sessionName: ctx.sessionName },
  { tokenId: r.tokenId, scopes },
);
if (perSubDrop) {
  void this.audit?.record({
    action: 'push_suppressed',
    target: ctx.sessionId,
    detail: {
      kind: payload.kind,
      reason: 'routing_rule',
      ruleId: perSubDrop,
      subscriptionId: r.id,
    },
  });
  return;
}
```

Full verify: typecheck / lint / build / test + `node scripts/rc-gateway-e2e.mjs`.

> `feat(rc-gateway): apply per-subscription routing drop in push fan-out`

## Then

advisor (done-check) → opus adversarial review on `git diff 5f44a9694..HEAD`
(dimensions: the firstDrop-exclusion safety property, empty-array edge, AND
semantics, audit privacy/discriminator, optional-method back-compat, gate
order, async hygiene; tell it deferred items are not bugs) → apply fixes →
re-verify → push → update both memory files.
