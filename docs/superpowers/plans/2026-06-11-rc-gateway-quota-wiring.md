# Plan — wire quotas into the live policy path (cycle 43)

See design: `../specs/2026-06-11-rc-gateway-quota-wiring-design.md`.

TDD, fail-safe order (loader → evaluator-param → enforcer-flip; a stop after any
commit is behavior-identical to today). Repo root, absolute paths. Explicit
`packages/rc-gateway/` + `docs/` git-add paths (foreign edits present).

## Commit 1 — docs

## Commit 2 — loader validates maxPerWindow → typed {count,windowSec} (still inert)

`policy/loader.ts`:

- `PolicyRule.maxPerWindow?: { count: number; windowSec: number }` (was `unknown`).
- In the rule build: a present `maxPerWindow` must be a mapping with `count` a
  non-negative integer (`Number.isInteger(count) && count >= 0`) and `windowSec` a
  positive integer (`Number.isInteger(windowSec) && windowSec > 0`); else
  `PolicyError(\`rule[i].maxPerWindow …\`)`. Unknown sub-keys ignored.
- REMOVE the `warnedDeferred` maxPerWindow warning block (no longer deferred).
  (Leave `warnedDeferred` itself only if still used elsewhere — grep; routing has
  its own. In loader it was only for maxPerWindow → remove the now-dead `let` +
  block if nothing else uses it.)
- Evaluator still treats maxPerWindow as unevaluable (no oracle yet) → STILL
  downgrades to prompt → behaviorally inert.

Tests `policy/loaderQuota.test.ts` (or extend an existing loader test): valid
`{count:5,windowSec:60}` parses to the typed shape; `maxPerWindow: 5` (not a
mapping), negative count, `count: 1.5`, `windowSec: 0`, `windowSec: -1`,
non-integer windowSec → `PolicyError`.

Verify: typecheck — `rule.maxPerWindow` consumers (evaluator's `!== undefined`,
lint's scan) still compile (the field is now narrower, not removed).

## Commit 3 — evaluator optional quota oracle (still inert: no caller passes one)

`policy/evaluator.ts`:

- `export interface QuotaOracle { state(ruleId: string, nowMs: number): 'room' | 'exhausted' | 'untracked'; }`
- `classifyConditions(rule, now, quota?)` — extend the maxPerWindow branch per D2:
  no-oracle/id-less → `unevaluable=true`; else `quota.state(id, now.getTime())`:
  `exhausted` → `return 'no-match'`; `room` → no-op (don't clear unevaluable);
  `untracked` → `unevaluable=true`.
- `evaluate(policy, ctx, now = new Date(), quota?)` — thread `quota` into the
  `classifyConditions` call. No other change.

Tests `policy/evaluatorQuota.test.ts` (fake oracle): room→allow + `usedDeferredField
false`; exhausted→falls through to a lower rule / default; untracked→prompt;
id-less maxPerWindow rule + oracle→prompt; NO oracle→prompt (unchanged); a
non-maxPerWindow rule ignores the oracle; **compose: malformed expiresAt +
exhausted quota → no-match (not prompt)**.

## Commit 4 — enforcer flip + lint reconcile (THE behavior change, last)

`policy/enforcer.ts`:

- ctor gains `private readonly quota?: QuotaStore` + `private readonly nowFn:
() => number = Date.now`.
- `handlePermission`: `const nowMs = this.nowFn(); const now = new Date(nowMs);`
  `const oracle = this.quota ? { state: (id, ms) => this.quota!.state(id, ms) } :
undefined;` `const d = evaluate(this.policy, ctx, now, oracle);`
- On the allow SUCCESS path (vote ok), before `return true`: if `this.quota &&
d.ruleId && this.quota.remaining(d.ruleId, nowMs) !== undefined` →
  `await this.quota.consume(d.ruleId, nowMs); quotaRemaining =
this.quota.remaining(d.ruleId, nowMs);` and add `quotaRemaining` to that audit
  record's detail (only when defined). Other audit records unchanged.

`policy/loader.ts` lint (cycle 40 `lintPolicyFile`): drop the `maxPerWindow`→
`deferred` scan (no remaining deferred fields) so a valid quota file lints with
empty `deferred`. Update cycle-40 lint tests (the maxPerWindow file → `deferred: []`).

`cli.ts`: when constructing the enforcer at boot, build
`QuotaStore.create(new FileQuotaWal(<configDir>/quotas.wal, console.warn),
(id) => limitFor(id from active policy))` and pass it. `limitsFor` reads the active
policy's rules: `id → rule.maxPerWindow` for the rule with that id (first match).
(Hot-reload swap is Phase 3; for now the policy is fixed at boot.)

Tests `policy/enforcerQuota.test.ts` (capturing fake daemon + real QuotaStore over
MemoryQuotaWal + injected nowFn): allow via a quota'd rule consumes exactly once on
a successful vote; a FAILED vote (daemon returns false / throws) does NOT consume;
the (count+1)th call within the window falls through (no auto-allow — the prompt/
push path); `quotaRemaining` present in the allow audit detail and decrements;
deny/prompt never consume; an allow via a NON-quota rule does not consume (no WAL
churn). Plus the cycle-40 lint test update.

## Verify (repo root)

typecheck/lint/build/test `@qwen-code/rc-gateway` + `node scripts/rc-gateway-e2e.mjs`.
opus review on `git diff 7d90d8c60..HEAD -- packages/rc-gateway/` — POINT IT at the
one posture-loosening line (room rules that prompted yesterday now auto-allow =
intended) + the consume-gating + the TOCTOU acceptance. Fix → push → update both
memory files (quotas DONE end-to-end; note Phase 3/4 remain).
