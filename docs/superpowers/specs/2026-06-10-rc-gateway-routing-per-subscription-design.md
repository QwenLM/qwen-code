# Cycle 33 — Notification routing: per-subscription targeting (`scopeIn`/`tokenIdsIn`), suppress-only — design

## Context

Cycle 25 shipped `routing.yaml` `drop` rules as an **event-global** gate: a rule
matching the event's `kind`/`sessionTag` suppresses the WHOLE push fan-out once
(`RoutingMatcher.firstDrop`). The `add-notification-routing` design also calls
for **per-subscription** targeting — silencing pushes to a specific class of
device/token without silencing everyone (e.g. "don't push prompts to guest
share tokens", "mute these two device tokens"). This cycle adds two
per-subscription match fields, `scopeIn` and `tokenIdsIn`, still SUPPRESS-ONLY.

## Deviation from the proposal

The design.md frames routing as daemon-side delivery policy. We implement it
gateway-side in the cycle-9 push notifier fan-out, alongside the existing
snooze / prefs / quiet-hours / working-device gates. No new subscription
fields are needed: `scopeIn` reads the subscription's owning-token scopes
(`TokenStore.scopesFor`), `tokenIdsIn` reads `subscription.tokenId` — both
already in hand inside the per-sub loop. `deviceTagsIn` (would need a new
subscription field), urgency, mentions, policy-meta matching stay deferred.

## Decisions

- **D1 — Two matcher methods, not one unified per-sub evaluator.** `firstDrop(ev)`
  stays the EVENT-GLOBAL gate (matches once, suppresses the whole fan-out, audits
  once with NO `subscriptionId`). A new `firstDropForSubscription(ev, sub)` is the
  PER-SUB gate (evaluated inside the fan-out loop, audits per matching sub with a
  `subscriptionId`). Keeping them separate preserves the cycle-25 contract that a
  global drop audits exactly once.

- **D2 — Partition drop rules by PRESENCE of a per-sub field.** `compileRouting`
  splits `route.drop===true` rules into `globalDropRules` (NO `scopeIn` and NO
  `tokenIdsIn`) and `perSubDropRules` (has at least one). `firstDrop` iterates
  ONLY `globalDropRules`; `firstDropForSubscription` iterates ONLY
  `perSubDropRules`. **Load-bearing safety property: a rule carrying `scopeIn`/
  `tokenIdsIn` can NEVER suppress the whole fan-out** — it is excluded from the
  global pass by construction. (Behaviorally inert for every existing config,
  since no deployed config has the new fields → safe to land before wiring.)

- **D3 — AND across ALL present match fields.** A rule with `kind` + `scopeIn` +
  `tokenIdsIn` requires every present field to match, consistent with the existing
  `kind`∧`sessionTag` convention. The per-sub path REUSES `matchKind`/
  `matchSessionTag` (event fields) and adds `matchScopeIn`/`matchTokenIdsIn`
  (sub fields); a rule with no per-sub field never reaches this path (D2).

- **D4 — `scopeIn` = exact string membership; a sub matches if its token holds
  AT LEAST ONE listed scope.** Scopes are a closed 5-value enum
  (`session:read`/`approve`/`write`/`owner`/`share`), so exact membership is
  correct — `scopeIn` is NOT routed through `globMatch` (no needless regex
  surface). `tokenIdsIn` is likewise exact membership of `subscription.tokenId`.

- **D5 — Empty-array edge: `scopeIn: []` / `tokenIdsIn: []` drops NOBODY.** By
  D2 an empty array is "present", so the rule moves into the per-sub pass; by D4
  intersection-non-empty / membership against `[]` matches nothing. So adding
  `scopeIn: []` flips a rule from "drop everyone" (global) to "drop no one"
  (per-sub, matches none) — the SAFE direction, and **consistent with the
  existing `kind: []`** (which `isStringOrStringArray` already accepts and
  `[].includes()` already makes match nothing). Validation accepts `[]`.

- **D6 — Gate placement: after scope + session-lock, before prefs.** The explicit
  operator routing decision sits ahead of the implicit prefs/quiet-hours/
  working-device gates so "why no push" reads as the operator's rule first.
  Placement only decides which `reason` wins when several gates would suppress
  (each just `return`s the sub — no double-send risk). `scopes` is already
  resolved and non-undefined at this point (the `!scopes` early-return precedes
  it). Audits `push_suppressed { kind, reason:'routing_rule', ruleId,
subscriptionId }` — same `reason` token as the global drop, discriminated by
  the presence of `subscriptionId`. The `/test` path (`notifyToken`) is NOT gated.

- **D7 — `firstDropForSubscription` is OPTIONAL on `RoutingMatcher`.** The
  notifier calls `this.routing?.firstDropForSubscription?.(…)` so a matcher
  predating this method (and the existing inline test stubs) keeps typechecking
  and simply performs no per-sub drop. `compileRouting` always provides it.

## Implementation & commit order

1. **Docs** (this spec + plan).
2. **rules.ts (pure, inert):** add `scopeIn?`/`tokenIdsIn?` to `RoutingRuleMatch`
   - string-or-string-array validation (reuse `isStringOrStringArray`) + add both
     to `MATCH_HONORED`; partition in `compileRouting`; add `matchScopeIn`/
     `matchTokenIdsIn`; add optional `firstDropForSubscription` to the interface +
     the compiled matcher; `firstDrop` now iterates `globalDropRules` only. Tests in
     `rules.test.ts`. Notifier does NOT yet call the new method → inert. (Also swap
     the deferred-warning test's `scopeIn:[owner]` example for a still-deferred
     field so it documents reality.)
3. **notifier.ts (wire last):** in the per-sub loop, after the session-lock check
   and before the prefs filter, call `firstDropForSubscription` and skip + audit
   on a match. Tests in `notifier.test.ts`.

## Deferred (not this cycle)

`deviceTagsIn` (needs a new subscription field); urgency / `urgencyAtLeast`;
mentions (synthetic `kind:mention`); policy-meta / `originatingClientScope` /
`subActor` matching; the unify-existing-gates refactor; `<workspace>/.qwen/
routing.yaml` override; hot-reload; `routing_decision` SSE; "why no push" web UI;
`qwen rc` CLI.

## Verification

`typecheck/lint/build/test --workspace @qwen-code/rc-gateway` +
`node scripts/rc-gateway-e2e.mjs`. New tests: `scopeIn:[share]` drops a share
sub but not an approver sub; `tokenIdsIn:[id]` drops only that token's subs;
AND of `kind`+`scopeIn` (sub satisfies one not the other → no drop); a per-sub
rule returns `null` from `firstDrop` (the safety property, named test);
`scopeIn:[]`/`tokenIdsIn:[]` drop nobody; per-sub audit carries `subscriptionId`,
global audit does not; all cycle-25/29 notifier tests unchanged.
