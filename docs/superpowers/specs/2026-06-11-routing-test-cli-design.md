# Cycle 52 — `qwen rc routing test` dry-run inspector

Proposal: `add-notification-routing`, task **5.1** ("Operator dry-run:
read an event JSON from stdin or file, run it through the loaded rules
with a hypothetical subscription set, print the decisions table. Print
`would_send` and `would_suppress` rows."). A daemon-free inspector in the
proven `policy explain` / `routing rules` family — pure logic + a thin
argv branch.

## What it does

`qwen rc routing test [<event-json>] [--sub <scopes>[@<tokenId>]]... [--resolved]`

- Reads a synthetic event as JSON — from a positional arg, else from
  stdin (so `cat event.json | qwen rc routing test` covers the "file"
  case via shell redirection). The honored fields are `kind` (required
  string) and `sessionName` (optional string); the gateway's compiled
  matcher consumes exactly those, so other event fields are accepted and
  ignored (future-proofs the input for when mentions/policy fields land —
  same interface, no break).
- `--sub <scopes>[@<tokenId>]` (repeatable) describes a hypothetical
  subscription: comma-separated token scopes, optional `@tokenId`. The
  event JSON cannot carry the subscription set (the task's own "with a
  hypothetical subscription set"), so it comes from flags.
- `--resolved` overlays the workspace `<cwd>/.qwen/routing.yaml` on top
  of the user file (mirrors `routing rules --resolved`); default is
  user-only.
- Loads via the SAME `loadLayeredRoutingMatcher` the gateway boot uses
  (FAIL-OPEN: a malformed file is logged + ignored), so the dry-run
  reflects real boot behavior.

## Deviation / honesty (the must-get-right)

The gateway's implemented routing matcher honors only `route.drop` rules
(event-global on `kind`/`sessionTag`, per-subscription on
`scopeIn`/`tokenIdsIn`); urgency/digest/mentions/policy-awareness are
deferred. So this inspector evaluates ONLY the routing.yaml DROP layer.

**A `would_send` here is NOT a delivery verdict.** snooze (live state),
per-subscription `prefs`, `quietHours`, working-device suppression, and
the rate limiter are all DOWNSTREAM notifier gates with live/persisted
state a daemon-free CLI cannot see — any of them can still drop a push
this tool reports as `routing-layer: would_send`. Every verdict is
therefore prefixed `routing-layer:` and the output carries a prominent
NOTE listing the gates NOT considered. A confidently-wrong inspector is
worse than none; this framing is the cycle's load-bearing requirement.

## Shape

Pure trio (unit-tested), mirroring `policy explain`'s parse/format split:

- `parseRoutingTest(argv, stdin)` → `{ok, request}` | `{ok:false, error}`.
  Separates the positional event JSON from `--sub`/`--resolved`; uses
  `stdin` when no positional. Errors (→ exit 2): no event, unparseable
  JSON, missing/non-string `kind`. LENIENT on flags (matching
  `parseExplainArgs`): an unknown flag is ignored and a `--sub=` with no
  scopes yields an empty-scope sub (which simply matches no `scopeIn`
  rule) — neither is an error.
- `evaluateRoutingTest(matcher, request, ruleCount)` → `RoutingTestResult`.
  `firstDrop` decides event-global suppression (suppresses ALL subs);
  else per-sub `firstDropForSubscription`. No `--sub` → a single
  event-global row + `perSubEvaluated:false`. `matcher` undefined (no
  files) → all-send with a "no rules loaded" note.
- `formatRoutingTest(result)` → the table + the scope NOTE.

argv glue in `cli.ts` (`routing test` branch): read stdin only when it is
piped (`!isTTY`) so a positional invocation never blocks; parse → on
error print to stderr + `exit(2)`; else load the layered matcher
(`--resolved` ⇒ pass `process.cwd()`) → evaluate → print → `exit(0)`.

## Exit codes (INSPECTOR family)

`0` success (including all-send and no-rules-loaded); `2` usage/parse
error (no event, bad JSON, no `kind`, bad flag). No `1` — the routing
config FAIL-OPENS (a malformed file is never a hard error here), matching
`routing rules`.

## Decisions

1. Event from positional-or-stdin JSON (task-faithful), `--sub` from
   flags (the JSON can't carry the hypothetical subscription set).
2. Every verdict `routing-layer:`-prefixed + a NOT-considered NOTE —
   the inspector must never read as a delivery guarantee.
3. Drop-only model (the only routing layer implemented); urgency/digest/
   mentions/policy-awareness explicitly deferred.
4. `--resolved` overlays the workspace file (mirrors `routing rules`).
5. Pure parse/evaluate/format trio unit-tested; the argv branch + stdin
   read are glue, dist-smoke-tested (not e2e-reachable — the e2e mounts
   `createGatewayApp`, not `cli.ts`).

## Deferred

- `routing_decision` SSE event (could ride cycle-49's `/rc/events`),
  urgency/mentions/policy-awareness rule fields, a "why no push" web UI,
  `push_routed`/`push_suppressed` audit advertisement (task 5.2) — all
  unchanged from the add-notification-routing deferred set.
