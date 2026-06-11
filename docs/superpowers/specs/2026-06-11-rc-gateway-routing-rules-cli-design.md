# rc-gateway — `qwen-rc routing rules [--resolved]` CLI (cycle 41)

## Context

`add-notification-routing` spec (`specs/notification-routing/spec.md:321-352`):
the CLI SHALL expose `qwen rc routing rules`, and the "Operator inspects effective
ruleset" scenario:

> `qwen rc routing rules --resolved` → the output lists workspace rules first,
> then daemon rules, AND each rule shows its source file path.

Cycle 25/36 shipped the user-level `~/.qwen/rc/routing.yaml` and the
`<workspace>/.qwen/routing.yaml` override (prepended). There is no way for an
operator to SEE the effective merged ruleset. This adds the read-only inspector,
the second `qwen rc` subcommand (after cycle 40's `policy lint`), reusing that
cycle's argv-dispatch seam. A DIFFERENT proposal from the last three policy cycles
(heeding the cycle-40 "don't over-focus one surface" lesson).

## Deviation from the daemon-centric spec

The spec frames the CLI as a thin wrapper over a daemon endpoint
(`GET /rc/routing/rules?resolved=`). We implement it DAEMON-FREE: it loads and
merges the static config files directly (exactly as `policy lint` does — no
running gateway/daemon needed to inspect static config). Two consequences,
documented:

- **D1 — workspace root = `process.cwd()`.** Without a running daemon there is no
  `capabilities().workspaceCwd`; the natural standalone behavior is to treat the
  directory the operator runs the command in as the workspace (so they `cd` to a
  workspace and inspect its effective rules). `--resolved` includes the
  `<cwd>/.qwen/routing.yaml` layer; without the flag, only the user-level file is
  shown (mirrors the endpoint's `resolved=true|false`).
- **D2 — no daemon/HTTP, no auth.** It is local operator tooling reading local
  files; the daemon endpoint's owner-gating is N/A here (a local shell already has
  the operator's file access).

## Decisions

- **D3 — Reuse the cycle-36 per-file FAIL-OPEN load.** A new private
  `loadBothRoutingLayers(userPath, workspaceCwd, warn)` extracts the two
  `loadOneFailOpen` calls that `loadLayeredRoutingMatcher` already does, so the
  matcher path and the inspector path share ONE loader (no drift). A malformed
  file at either layer is logged + skipped (the rules from that file simply don't
  appear) — consistent with cycle 36's runtime fail-open.
- **D4 — `loadResolvedRoutingRules(userPath, workspaceCwd?, warn?) →
ResolvedRoutingRule[]`** where `ResolvedRoutingRule = { source: string; rule:
RoutingRule }` and `source` is the FILE PATH (spec: "each rule shows its source
  file path"). Order: workspace rules first (tagged with the workspace path), then
  user rules (tagged with the user path) — matching cycle-36's prepend + the
  spec's "workspace first". `workspaceCwd` undefined → user rules only.
- **D5 — `formatResolvedRouting(rules) → string`** — one line per rule: source
  path, id (`<unnamed>` when absent), a compact match summary (kind / sessionTag /
  scopeIn / tokenIdsIn, omitting absent fields; an empty `match: {}` renders
  `match: any`, never a blank), and `drop` (every shipped rule is a drop rule, but
  print it for forward-clarity). An empty list → `(no routing rules)`. Pure, no
  I/O.
- **D6 — argv dispatch** in cli.ts: `argv[2]==='routing' && argv[3]==='rules'` →
  `const resolved = argv.includes('--resolved')` →
  `loadResolvedRoutingRules(userPath, resolved ? process.cwd() : undefined, warn)`
  → print `formatResolvedRouting` → `process.exit(0)`. **ALWAYS exit 0 — this is
  an INSPECTOR, not a LINTER (loud rationale so it isn't "fixed" later):** its
  contract is "show what the gateway actually uses," and the gateway fail-opens on
  a malformed routing file (cycle 36, routing is suppress-only). So a malformed
  file is faithfully reflected as a stderr warning + omission of that file's rules
  - exit 0 — NOT exit 1. Mirroring `policy lint`'s exit-1-on-invalid here would be
    WRONG: that is policy's fail-CLOSED posture; routing is fail-OPEN.

## Safety / fail-safe

- Read-only, daemon-free, no hot path, no audit, no AuditAction change. The
  runtime notifier/matcher path is UNTOUCHED — `loadLayeredRoutingMatcher` keeps
  its exact behavior; the refactor only extracts a shared private loader it
  already performed inline.
- Fail-safe commit order: docs → extract `loadBothRoutingLayers` +
  `loadResolvedRoutingRules` + `formatResolvedRouting` + barrel + unit tests
  (INERT — cli.ts doesn't call them yet; `loadLayeredRoutingMatcher` behavior
  unchanged, asserted by its existing cycle-36 tests) → cli.ts argv dispatch LAST.

## Tests

- `loadResolvedRoutingRules` (temp files): user-only (no workspaceCwd) → user
  rules tagged with the user path; both layers → workspace rules FIRST (tagged
  workspace path) then user; malformed workspace → logged + skipped, user rules
  still listed; neither file → `[]`.
- `formatResolvedRouting`: empty → `(no routing rules)`; a rule renders its
  source path + id + match summary + drop; an id-less rule → `<unnamed>`.
- Regression: `loadLayeredRoutingMatcher` still behaves identically (its cycle-36
  tests must stay green after the shared-loader extraction).

## Deferred (routing CLI, unchanged)

`qwen rc routing reload` (needs a running-gateway IPC surface — none exists),
`qwen rc routing test <file.json>` + the `GET /rc/routing/rules` /
`POST /rc/routing/test` HTTP endpoints (daemon dry-run surface), plus the larger
urgency/mentions/hot-reload/`routing_decision` SSE / "why no push" UI items.
