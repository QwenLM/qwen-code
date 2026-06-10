# Design — rc-gateway notification routing rules (cycle 25, add-notification-routing Phase 4a)

**Proposal:** `add-notification-routing` (snooze=cycle 15, prefs=16,
working-device=17 already done; this adds the operator-configurable rule file).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## Goal of this slice

Give the operator a `~/.qwen/rc/routing.yaml` whose **`drop` rules** suppress a
push fan-out by event `kind` and `sessionTag` (session-name glob). This
implements the design's `route: { drop: true }` operator (its rule #1) — the
foundational, lowest-risk piece of the routing layer — and lands the loader +
pure evaluator that later cycles extend with per-subscription routing, urgency,
mentions, and policy-meta matching.

## Deviation note

The proposal's design.md puts the routing module in the daemon
(`packages/cli/src/serve/remoteControl/routing/`) consuming the event bus. We
deliver it gateway-side as an additional **suppression gate in the existing
notifier fan-out** (`webpush/notifier.ts`) — the daemon stays unmodified; all
edits inside `packages/rc-gateway/`.

## Decisions

### D1 — Suppress-only this cycle (rules can DROP, never widen delivery)

The design's rules are allow-oriented (a rule _selects_ which subscriptions
receive). Re-architecting the notifier's existing scope→snooze→prefs→working-
device gates into a unified allow-pipeline is a large, risky refactor of the
package's most bug-prone path (the fan-out is where cycles 9/14/18 each had a
CRITICAL/IMPORTANT). So this slice is **suppress-only**: a matching `drop` rule
removes the whole fan-out for that event; a rule can NEVER cause a push that the
existing gates would have blocked. Worst case of a mis-written rule is _fewer_
notifications, never a leaked one or a missed security prompt. The per-rule
subscription _selection_ (scopeIn/tokenIdsIn/deviceTagsIn/urgency) is deferred.

### D2 — Event-level drop, inserted right after the snooze gate

A `drop` match suppresses the entire event fan-out (no further per-subscription
work), exactly like the design's `drop: true` short-circuit and like the
existing event-global snooze gate. So the new gate sits immediately after snooze
in `notify()`, before the per-subscription loop. Audited as
`push_suppressed { kind, reason: 'routing_rule', ruleId }` — reusing the
existing `push_suppressed` action (already emitted for snooze/working_device);
the new `reason` value needs NO `AUDIT_ACTIONS` change (detail is free-form).
The `/test` path (`notifyToken`) is NOT gated (consistent with snooze).

### D3 — Match subset: `kind` (enum/list) + `sessionTag` (glob)

The notifier at fan-out time has exactly: `payload.kind`, `ctx.sessionName`, and
per-sub token scopes. This slice matches on the two event-global fields:

- `match.kind` — absent → matches any; string → equality; list → membership.
  (Kinds are an enum, NOT globbed — per the design's match table.)
- `match.sessionTag` — absent → matches any; else a glob (string or list)
  against `ctx.sessionName` via the existing **ReDoS-safe linear `globMatch`**
  (`policy/glob.ts`, reused — no new matcher, no regex). If a rule has a
  `sessionTag` but the event has no `sessionName`, the rule does NOT match (we
  can't confirm the constraint → fail to not-suppress, the safe direction).

`policy.decisionSource`/`policy.action`, `originatingClientScope`, `subActor`,
`mentionPatterns`, `urgencyAtLeast` are deferred. (Note: the headline
"silence policy-auto-allow" use case is ALREADY satisfied — cycle-14's enforcer
suppresses push for auto-handled permission events — so deferring policy-meta
matching loses no current capability.)

### D4 — Rule shape follows the design's `match:`/`route:` nesting

`{ id?, match: { kind?, sessionTag? }, route: { drop?: boolean } }` — the
nested `route:` is kept (not flattened) so later cycles add `scopeIn`/`urgency`
under it without a format break. Only `route.drop === true` is acted on this
cycle; a rule whose `route` carries other (deferred) operators loads fine and
simply doesn't suppress. A once-per-process `console.warn` (mirroring the policy
loader's deferred-field warning) fires if any rule uses a match/route field this
slice doesn't honor yet, so an operator isn't silently surprised.

### D5 — Pure loader throws; the CLI applies a fail-OPEN boot policy

`loadRoutingConfig(text)` is pure and throws `RoutingError` on a malformed doc
(mirrors `loadPolicy`/`PolicyError` — clean, testable contract). But because
routing rules only _suppress_, a malformed file must not crash the gateway nor
silently drop pushes: `cli.ts` wraps the load in try/catch and, on error, logs a
warning and proceeds with **no routing matcher** (= today's behavior, full
fan-out). Fail-open is the correct default for a suppression layer (more
notifications on misconfig, never fewer). Absent file (ENOENT) → `null` → no
matcher, same path.

### D6 — Fail-safe wiring order (survives a mid-cycle cut)

The pure `routing/rules.ts` + its tests land FIRST as inert, unimported code.
The notifier/server/cli wiring is the LAST commit, behind an optional
`deps.routing`. If interrupted after commit 1, the package has tested, inert
routing code wired to nothing — never a half-wired fan-out.

## Files

- New `src/routing/rules.ts`: `RoutingRule`/`RoutingRuleMatch`/`RoutingConfig`
  types, `RoutingError`, `loadRoutingConfig(text)`, `loadRoutingConfigFile(path)`
  (ENOENT→null), `compileRouting(config): RoutingMatcher` where
  `RoutingMatcher.firstDrop({kind, sessionName?}): string | null`.
- New `src/routing/rules.test.ts`.
- `src/webpush/notifier.ts`: 7th optional ctor arg `routing?: RoutingMatcher`;
  drop gate after the snooze block.
- `src/webpush/notifier.test.ts`: drop-suppression cases.
- `src/server.ts`: `GatewayDeps.routing?: RoutingMatcher`; thread into the
  `new PushNotifier(...)` call.
- `src/cli.ts`: load `~/.qwen/rc/routing.yaml` fail-open + a `routing:` banner
  line.
- `src/index.ts`: export the new public symbols.

## Verification

- vitest: loader (valid doc; absent→null; malformed doc/rules/match/route →
  RoutingError; unknown fields ignored; deferred-field warn once). evaluator
  (kind equality/list/absent; sessionTag glob/list/absent; sessionTag-present-
  but-no-sessionName → no match; first-matching-drop wins; non-drop rule never
  suppresses). notifier (a drop rule suppresses the whole fan-out + audits
  routing_rule; a non-matching rule leaves delivery unchanged; `/test`
  notifyToken NOT gated; drop gate runs after snooze).
- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` — must stay green; optionally add one
  assertion that GET-with-no-routing.yaml still pushes normally (likely no new
  e2e surface needed; the notifier path isn't hit headlessly without a model
  turn — keep the unit coverage authoritative).
- `git diff --name-only <start>..HEAD` → only `packages/rc-gateway/` + docs.

## Current live effect (a limitation to know)

`buildPayload` (cycle 9) only ever emits `kind: 'permission.required'` today —
there is no `task.completed` (or other) payload yet. So via the live `notify()`
path the only rules with real effect are those matching `permission.required`
or `sessionTag`-only; a `kind: task.completed` drop rule loads and unit-tests
fine but suppresses nothing in production until a completions payload exists.
The canonical examples lead with `task.completed` for clarity, but operators
should know it's currently inert. (No action needed here — it resolves once the
notifier emits more kinds.)

## Deferred (NOT in this slice)

Per-subscription routing (scopeIn/tokenIdsIn/deviceTagsIn), urgency levels,
`suppressIfWorkingDevice` via rule (already imperative), digest/quiet-hours,
mentions (synthetic `kind: mention` events), policy-meta + originatingClientScope

- subActor + urgencyAtLeast matching, the unify-existing-gates refactor,
  `<workspace>/.qwen/routing.yaml` override, hot-reload (fsnotify/debounce),
  `routing_decision` SSE frame, "why no push" web UI, `qwen rc snooze`/routing CLI.
