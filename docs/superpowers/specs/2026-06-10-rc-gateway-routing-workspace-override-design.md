# rc-gateway — workspace `routing.yaml` override (cycle 36)

## Context

`add-notification-routing` spec (`specs/notification-routing/spec.md:8-10`):

> The routing engine SHALL load `~/.qwen/rc/routing.yaml`. If
> `<workspace>/.qwen/routing.yaml` exists, its rules SHALL be prepended to the
> daemon-global rules (workspace rules evaluate first; both sets active).

Design D7 ("Workspace override is rule-level, not file-replace"): the workspace
file's rules are PREPENDED to the daemon-global rules; both active; workspace
evaluates first; a full-replace was considered and rejected (operators want
workspace-specific exceptions, not a rewrite).

Cycle 25 shipped the user-level `~/.qwen/rc/routing.yaml` (event-global `drop`
rules) and cycle 33 the per-subscription `scopeIn`/`tokenIdsIn`. This cycle adds
the second config layer: `<workspaceCwd>/.qwen/routing.yaml`.

## Deviation from the daemon-centric spec

The spec says "the routing engine" (daemon-side) loads both files. We load+merge
gateway-side at boot in `cli.ts` and pass the compiled matcher into the existing
`createGatewayApp({ routing })` (cycle 25's seam). No upstream edit.

## Decisions

- **D1 — PREPEND, merge-then-compile.** `mergeRoutingConfigs(workspace, user)`
  returns `{ rules: [...workspace.rules, ...user.rules] }`, then a SINGLE
  `compileRouting` runs over the concatenated list. Merge-then-compile (not
  compile-each-then-combine) is what preserves document-order first-match across
  the layer boundary — so when a workspace drop rule and a user drop rule both
  match the same event, `firstDrop` reports the WORKSPACE rule's id (the spec's
  observable for "workspace evaluates first").
- **D2 — Suppress-only is preserved.** Both layers contribute only `route.drop`
  rules through the same cycle-25/33 partitioning (`globalDropRules` /
  `perSubDropRules`). A workspace rule can only ADD a silence; it cannot widen
  the fan-out or un-set a user silence (spec D7's documented cost — un-silencing
  needs an explicit future override field, deferred).
- **D3 — Workspace cwd resolved once at boot via `daemon.capabilities()`.**
  1-daemon-1-workspace ⇒ the cwd is stable for the process, matching the
  compile-once architecture (the pump already calls `capabilities()`; a second
  fail-open call is harmless). The call lives in `cli.ts`; the loader takes an
  already-resolved `workspaceCwd: string | undefined`. A `capabilities()` failure
  is caught in `cli.ts` → workspace layer skipped (user layer still applies).
- **D4 — Per-file FAIL-OPEN (intentional deviation from cycle 25).** Cycle 25
  wrapped the whole routing load in one try/catch: a malformed user file disabled
  ALL routing. Now each layer is loaded independently and a malformed file at
  either layer is logged + ignored, the OTHER layer still applies. This is
  strictly more robust (a teammate-committed malformed `<workspace>/.qwen/
routing.yaml` no longer nukes the operator's user-level silences) and still
  fail-open in the safe direction (routing only suppresses → a dropped layer =
  MORE notifications, never a missed prompt). `loadLayeredRoutingMatcher` is
  therefore **never-throw** (per-file `loadOneFailOpen` catches ANY error —
  `RoutingError`, YAML parse error, or fs EACCES/EISDIR; `compileRouting` is
  total — it only filters/maps). Because that contract holds, cli.ts does NOT
  wrap the loader call in a redundant outer try/catch (it would be dead code);
  the only genuine throw source at boot is `capabilities()`, which cli.ts catches
  separately to skip just the workspace layer.
- **D5 — `warnedDeferred` module-global is unchanged.** Loading two files per
  boot means the once-per-process "ignoring not-yet-supported field" warning can
  fire on whichever layer trips it first; an unhonored field in the other file is
  then silent (advisory only, acceptable). Consequence for tests: the new test
  file must NOT assert that deferred-field warning (it is module-global and would
  be order-dependent/flaky across the file's tests; it is already covered by
  cycle-25/33 tests).

## Safety / fail-safe

- The runtime hot path (notifier) is untouched: it still receives a single
  `RoutingMatcher | undefined` of the exact cycle-33 shape. Only the BOOT-time
  construction of that matcher changes.
- `loadLayeredRoutingMatcher` never throws; `mergeRoutingConfigs` is pure; the
  workspace layer is skipped on any `capabilities()`/parse failure → worst case
  is "workspace silences not applied" = more pushes, never fewer/none-missed.
- Fail-safe commit order: docs → pure `mergeRoutingConfigs` +
  `loadLayeredRoutingMatcher` (exported, INERT — cli.ts still uses the old inline
  block) + unit tests + barrel → wire cli.ts to the new loader (boot-only, not
  request-hot) LAST.

## Tests

- `mergeRoutingConfigs`: null+null→null; one-null passthrough; both→concatenated
  with workspace first; **order proof** — a workspace drop rule and a user drop
  rule both matching one event → compiled `firstDrop` returns the WORKSPACE id.
- `loadLayeredRoutingMatcher`: neither file → `{undefined, 0}`; user-only;
  workspace-only; both → ruleCount sums + workspace-first id; malformed workspace
  → ignored, user rules still compile (warn emitted); malformed user → ignored,
  workspace rules still compile; both malformed → `{undefined, 0}`; never throws.
  (Per D5, do NOT assert the deferred-field warning here.)
- No new e2e push-suppression assertion — suppression needs a real
  `permission.required` event (a model turn), not reproducible headless. The boot
  path is exercised by the existing e2e (gateway boots clean). Stated for honesty.

## Deferred (routing, unchanged)

`qwen rc routing rules --resolved` (prints the merged list), hot-reload
(fsnotify), `routing_decision` SSE, "why no push" UI, urgency/mentions/
policy-meta matching, `deviceTagsIn`, unify-existing-gates refactor.
