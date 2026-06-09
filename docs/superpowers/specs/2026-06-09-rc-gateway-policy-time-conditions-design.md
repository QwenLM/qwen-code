# Design — rc-gateway policy time conditions (cycle 22, policy-engine Phase 2a)

**Proposal:** `add-policy-engine` (Phase 2, slice a).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## Goal of this slice

Make the policy evaluator actually evaluate two rule conditions it
currently **defers** (and thus safety-downgrades to `prompt`):
`match.timeOfDay` and rule-level `expiresAt`. After this slice, a rule
like "allow `npm test` only 09:00–17:00" or "this allow rule expires
2026-07-01" auto-decides when the condition holds, instead of always
prompting. `maxPerWindow` (stateful quota) stays deferred — Phase 2b.

This completes part of cycle 13/14's deferred safety-downgrade
([[qwen-rc-gateway-architecture]] cycles 13–14): currently the evaluator
downgrades ANY matched allow/deny rule that carries timeOfDay/expiresAt/
maxPerWindow to `prompt` (the "never auto-decide on an unevaluated
constraint" invariant). We now _evaluate_ two of those three, so only
genuinely-unevaluated constraints downgrade.

## Semantics (from `add-policy-engine/design.md`, not invented)

- **`timeOfDay: {from, to, timezone}`** — `from`/`to` are `"HH:MM"`
  24-hour local times **in the rule's IANA `timezone`**; the window
  **wraps midnight when `from > to`** (e.g. `23:00`–`07:00` = the night
  window). The gateway's own wall-clock is the source of truth, projected
  into `timezone` via `Intl.DateTimeFormat` (handles DST correctly — no
  dep).
- **`expiresAt`** — an absolute ISO-8601 instant. At/after it the rule is
  **expired** and no longer applies.

## Decisions

### D1 — Conditions are MATCH gates (skip the rule), not post-match downgrades

A well-formed condition that is **not satisfied** makes the rule **not
match** — evaluation falls through to the next rule / default (exactly
like a non-matching `tool`/`argsGlob`). Concretely:

- `expiresAt` in the past → rule does not match (it's dead).
- current time **outside** `timeOfDay` → rule does not match.

A well-formed condition that **is** satisfied lets the rule apply with
its **real action** (allow/deny auto-vote) — **no downgrade**.

### D2 — Malformed condition → keep the safety downgrade (never auto-decide on what we couldn't evaluate)

If a present condition can't be parsed (bad `HH:MM`, invalid IANA
timezone that makes `Intl` throw, unparseable `expiresAt`), we **cannot**
evaluate it. We must neither fail-open (silently drop the rule — a
malformed `deny`/quiet rule would vanish) nor auto-decide (unsafe). So a
matched rule with a **malformed** timeOfDay/expiresAt is **downgraded to
`prompt`** (`requireScope` carried; `usedDeferredField: true`) — identical
to today's behavior for these fields. The human decides; the malformed
rule neither silently disappears nor silently auto-allows.

### D3 — Clock by injection; evaluator stays a pure function of (policy, ctx, now)

`evaluate(policy, ctx, now = new Date())` gains an optional `now`. All
condition logic reads only `now` — still no I/O, deterministic under a
fixed `now` + fixed timezone (DST transitions included). The enforcer
calls `evaluate` with the real clock (default); tests inject `now`.

### D4 — `maxPerWindow` stays deferred (Phase 2b)

Quotas need a persistent per-`(ruleId, window)` counter, consume-on-
_invoke_ (not on match) semantics, and a WAL — a stateful lifecycle out
of scope here. A rule carrying `maxPerWindow` still downgrades to
`prompt` (`usedDeferredField: true`). The loader's deferred-field warning
is narrowed to mention only `maxPerWindow` (timeOfDay/expiresAt are now
evaluated).

## Evaluation algorithm (per rule, after the existing static-field match)

`classifyConditions(rule, now) → 'no-match' | 'match' | 'unevaluable'`:

1. `expiresAt` present: malformed → remember `unevaluable`; else if
   `now >= expiresAt` → **return `'no-match'`** (definitively dead).
2. `timeOfDay` present: malformed → remember `unevaluable`; else if
   `now`-in-tz is **outside** the (possibly midnight-wrapping) window →
   **return `'no-match'`**.
3. `maxPerWindow` present → remember `unevaluable` (deferred).
4. Any `unevaluable` remembered → `'unevaluable'`; else `'match'`.

A definitive **`no-match`** (well-formed-and-unsatisfied) always wins over
`unevaluable` — a dead/out-of-window rule is skipped even if it also has a
malformed sibling field.

Then in `evaluate`, for a rule whose static fields match AND
`classifyConditions !== 'no-match'`:

- `unevaluable` (or any still-deferred field) **and** `action !== 'prompt'`
  → downgrade: `{action:'prompt', requireScope, usedDeferredField:true}`.
- otherwise apply the rule's real action; `usedDeferredField =
(status === 'unevaluable')`.

`specificity()` is unchanged (timeOfDay still contributes +20 by
presence).

## Files

- New `src/policy/conditions.ts`:
  `parseTimeOfDay(raw): {fromMin,toMin,timezone}|null`,
  `isWithinTimeOfDay(parsed, now): boolean` (projects `now` into
  `timezone` via `Intl.DateTimeFormat(..., {timeZone, hour:'2-digit',
minute:'2-digit', hour12:false})`, parses to minutes-of-day, applies
  the wrap rule; an invalid timezone makes `Intl` throw → caught →
  signaled as malformed via the parse step returning null first / a
  try-around), `parseExpiresAt(raw): number|null`,
  `isExpired(ms, now): boolean`.
- `src/policy/evaluator.ts`: thread `now`; replace the blanket
  presence-based `usedDeferred` with `classifyConditions`; keep the
  existing static `ruleMatches` for tool/args/path/origin/sessionTag.
- `src/policy/loader.ts`: narrow the deferred-field warning to
  `maxPerWindow` only (timeOfDay/expiresAt are now evaluated). No type
  changes (fields stay `unknown`, read defensively at eval time).
- `src/policy/enforcer.ts`: call `evaluate(policy, ctx)` (real clock,
  default `now`) — verify it still compiles with the new optional param;
  no behavior change needed there.

## Safety / review notes

- **The malformed-downgrade (D2) is the crux** — verify a rule with a
  typo'd timezone or `from:"9"` (not `09:00`) prompts, never auto-allows,
  and never silently vanishes. Point the reviewer here.
- **Midnight wrap** (`from > to`) and **DST** correctness (a window
  defined in `America/Los_Angeles` evaluated against a UTC `now` across a
  spring-forward boundary) — table-test both.
- **Boundary** — is the window inclusive of `from` and `to`? Decision:
  inclusive both ends (`m >= fromMin && m <= toMin`, or the wrap form).
  `expiresAt` boundary: expired when `now >= expiresAt` (strict-future =
  still valid), matching cycle-13's `now >= expiresAt` share-expiry
  convention.
- No new audit actions; `policy_decision` already carries `action`/
  `ruleId`. No secrets logged.

## Deferred (NOT in this slice)

- `maxPerWindow` quota evaluation + counter + WAL (Phase 2b).
- Hot-reload of policy.yaml + `qwen rc policy` CLI (Phase 3).
- `policy_decision` SSE frame + web UI (Phase 4).
- Workspace+user policy merge.
- A >5-min wall-clock-drift warning (design's threat-model row) — needs a
  trusted time source; out of scope.

## Verification

- vitest: `conditions.ts` (parseTimeOfDay valid/invalid incl. `"24:00"`,
  `"09:9"`, non-string; isWithinTimeOfDay inside/outside/boundary/
  midnight-wrap/DST via fixed `now`+zone; parseExpiresAt valid ISO/garbage;
  isExpired before/at/after). `evaluator.ts` (well-formed-in-window allow
  → allow not prompt; out-of-window → falls through to next rule/default;
  expired allow → falls through; not-yet-expired → applies; malformed
  timeOfDay/expiresAt → downgrade to prompt; maxPerWindow still downgrades;
  a dead+malformed rule is skipped; specificity/order unchanged).
- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` (no new e2e surface needed — the
  evaluator is pure; existing enforcer e2e must still pass. Optionally add
  one enforcer-level assertion that an out-of-window allow rule does not
  auto-vote. Keep it if cheap.)
