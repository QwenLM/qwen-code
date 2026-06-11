# rc-gateway — wire quotas into the live policy path (cycle 43, Phase 2b part 2)

## Context

Cycle 42 landed the INERT `QuotaStore` + WAL (`src/policy/quotas.ts`). This cycle
WIRES it — the behavior flip: a `maxPerWindow` rule stops downgrading to prompt and
becomes a real rolling-window rate limit (spec.md:119-139). Done as the IMMEDIATE
next cycle so quotas don't sprawl.

**Serialization finding (the cycle-42 MUST-CONFIRM, now resolved):** the pump's
`runLoop` (`webpush/pump.ts:164-184`) does `for await (ev) { … await
enforcer.handlePermission(…) }` → events are STRICTLY serialized WITHIN a session.
There is one `runLoop` PER session, so two different sessions interleave at awaits.
For a quota shared across sessions, the check(evaluator)/consume(enforcer-after-vote)
split is therefore a BOUNDED TOCTOU: at most ~(concurrent sessions matching the same
rule) extra grants at the boundary. ACCEPTED, not mutexed: `maxPerWindow` is a SOFT
throttle (beyond-cap → prompt, not deny), the gateway runs few sessions per
workspace, and consuming before the vote would violate design.md:68 ("consume only
after the tool is actually invoked"). A future HARD-limit mode would need a
reservation/mutex — out of scope; documented in code.

## Decisions

- **D1 — Loader validates `maxPerWindow` → typed `{count,windowSec}` (FAIL-CLOSED).**
  `PolicyRule.maxPerWindow?: { count: number; windowSec: number }` (was `unknown`).
  In `loadPolicy`: a present `maxPerWindow` must be a mapping with `count` a
  non-negative integer and `windowSec` a positive integer, else `PolicyError`
  (consistent with cycle-38's fail-closed posture — a malformed user policy
  blocks boot). Unknown sub-keys ignored (forward-compat). This is the only loader
  change; the deferred-field `console.warn` for `maxPerWindow` is REMOVED (it is no
  longer deferred).
- **D2 — Evaluator gains an OPTIONAL quota oracle (backward-compatible seam).**
  `evaluate(policy, ctx, now = new Date(), quota?: QuotaOracle)` where
  `QuotaOracle = { state(ruleId, nowMs): 'room' | 'exhausted' | 'untracked' }`
  (a read-only view of the store; NO consume — the evaluator must not mutate).
  Exactly ONE non-test caller (`enforcer.ts:95`), so the signature change is safe;
  every existing call (and every test) omits `quota` and keeps TODAY's behavior.
  In `classifyConditions(rule, now, quota?)` (the maxPerWindow branch, step 3 —
  AFTER the expiresAt/timeOfDay checks):
  - `quota` absent OR rule has NO `id` → `unevaluable = true` (today's path:
    downgrade to prompt; an id-less rule can't be tracked/persisted). UNCHANGED.
  - `quota` present + `id` → `quota.state(id, now.getTime())`:
    - `exhausted` → **`return 'no-match'` IMMEDIATELY** — an exhausted rule does
      not apply, period, so it WINS over any `unevaluable` set by a malformed
      expiresAt/timeOfDay sibling (compose test: malformed-expiresAt +
      exhausted-quota ⇒ no-match, NOT prompt).
    - `room` → the maxPerWindow condition is SATISFIED: do NOTHING — in particular
      do NOT clear a prior `unevaluable` (a room quota on a rule whose expiresAt is
      malformed still ⇒ prompt).
    - `untracked` → `unevaluable = true` (limit unknown to the store) → prompt.
      `usedDeferredField` is set only for malformed timeOfDay/expiresAt or the
      no-oracle/id-less/untracked maxPerWindow case — NOT for a satisfied tracked quota.
      NOTE: the `exhausted` fall-through yields the spec's `rule_id:null/
decision_source:default` outcome ONLY when no lower rule matches — it emerges
      naturally from the existing default fall-through; never hard-code it (a lower
      matching rule's id is the correct result then).
- **D3 — Enforcer builds the store + consumes AFTER a successful allow vote.**
  `PolicyEnforcer` gains an optional `QuotaStore` (+ a `nowFn: () => number`,
  default `Date.now`, for testability). **Thread ONE instant:** at the top of
  `handlePermission`, `const nowMs = this.nowFn(); const now = new Date(nowMs);`
  — pass `now` to `evaluate` and `nowMs` to `consume`/`remaining`, so the check and
  the consume (on opposite sides of the `await` vote) prune against the SAME
  boundary. It passes a `{ state }` oracle (over the store) to `evaluate`.
  **Consume-gating (must be explicit — cycle-42 `consume` appends UNCONDITIONALLY,
  it does not check `limitsFor`):** on an `allow` whose vote SUCCEEDS, gate on
  `d.ruleId !== undefined && store.remaining(d.ruleId, nowMs) !== undefined` (i.e. a
  TRACKED quota rule) — only then `await store.consume(d.ruleId, nowMs)` and read
  `quotaRemaining = store.remaining(d.ruleId, nowMs)` (post-consume) for the audit.
  Do NOT consume on untracked allows (would churn WAL garbage + meaningless
  `quotaRemaining`); never consume on a failed vote, deny, or prompt (design.md:68).
  Audit `policy_decision` detail gains `quotaRemaining` only when applicable
  (spec.md:166). Never throws (store is defensively total).
- **D4 — `lint` reconciled.** Cycle-40 `lintPolicyFile`'s `deferred` list (rules
  with `maxPerWindow`) + its "will downgrade to prompt" wording are now WRONG once
  honored. Re-purpose: drop `maxPerWindow` from `deferred` (there are no remaining
  deferred fields), so a valid quota file lints clean with no note. Update the
  cycle-40 lint tests accordingly (the `maxPerWindow` file now lints with empty
  `deferred`).

## Safety / fail-safe

- **The single live decision change is D2's maxPerWindow branch, reached ONLY when
  an oracle is passed — i.e. ONLY from the enforcer with a store.** Pure-evaluator
  callers (tests, any future dry-run) are byte-identical. Within the enforcer, a
  `room` quota now auto-allows where it used to prompt — the intended flip — and an
  `exhausted` quota falls through (more conservative than today's prompt only if a
  lower rule denies; otherwise default-prompt, same UX). Fail-closed preserved:
  untracked/id-less/no-store → prompt.
- **Fail-safe commit order:** docs → D1 loader validation + type + tests (maxPerWindow
  still downgrades to prompt — evaluator unchanged, so still INERT behaviorally) →
  D2 evaluator oracle param + classifyConditions + tests (still inert: no caller
  passes an oracle yet) → D3 enforcer store+consume + D4 lint reconcile + tests
  (THE FLIP, last). A stop after any commit lands safe (oracle absent = today).
- Consume is post-successful-vote; a thrown/failed vote never consumes. Store is
  total → enforcer stays never-throws.

## Tests

- Loader: valid `{count,windowSec}` parses; malformed (`maxPerWindow: 5`, negative
  count, zero/negative windowSec, non-integer) → `PolicyError`.
- Evaluator (with a fake oracle): `room` → rule's real action (allow), no
  `usedDeferredField`; `exhausted` → falls through to the next rule / default;
  `untracked` → prompt; id-less maxPerWindow rule + oracle → prompt; NO oracle →
  prompt (unchanged). A non-maxPerWindow rule is unaffected by the oracle.
- Enforcer (capturing fake daemon + real QuotaStore/MemoryQuotaWal): an allow via a
  quota'd rule consumes exactly once on a successful vote; a FAILED vote does NOT
  consume; the (count+1)th call within the window falls through (no auto-allow);
  `quotaRemaining` appears in the audit detail; deny/prompt never consume.
- Lint: a `maxPerWindow` file now lints valid with empty `deferred` (cycle-40 test
  updated).

## Deferred

Phase 3 hot-reload (swap policy + `limitsFor`) + `qwen rc policy reload`; Phase 4
`policy_decision` SSE frame (carrying `quotaRemaining`) + web UI; a strict
HARD-limit reservation mode (vs the current soft throttle).
