# Daemon-global deep health

## Problem

`GET /health?deep=1` was introduced when a daemon owned one workspace runtime.
The route was still wired to the primary bridge after multi-workspace support
landed, so its counters could report the daemon as idle while a secondary
workspace had sessions, prompts, or pending permissions.

The shallow endpoint is intentionally different: `GET /health` only proves
that the listener can respond. It must remain cheap and must not access runtime
state.

## Decision

Deep health is a daemon-wide informational snapshot. It aggregates every
runtime returned by `WorkspaceRegistry.listManaged()`, including workspaces
that are draining but have not completed bridge cleanup.

| Field                | Aggregation                                              |
| -------------------- | -------------------------------------------------------- |
| `workspaceCount`     | Number of managed runtimes in the snapshot               |
| `sessions`           | Sum                                                      |
| `pendingPermissions` | Sum                                                      |
| `activePrompts`      | Sum                                                      |
| `connectedClients`   | Existing daemon-wide REST SSE count                      |
| `channelAlive`       | True when any managed runtime channel is live            |
| `lastActivityAt`     | Latest non-null bridge activity time                     |
| `idleSinceMs`        | One `Date.now()` snapshot minus the latest activity time |
| `rateLimitHits`      | Existing optional daemon-wide rate-limit counts          |

The route reads each runtime's required getters before combining the values.
It does not short-circuit channel reads. If the registry or any getter throws,
the whole deep probe fails with
`503 {"status":"degraded","reason":"aggregation_failed"}` rather than
returning a partial snapshot. Getter failures identify the workspace runtime in
the daemon stderr log without exposing that identifier in the HTTP response.

While the bootstrap listener is up but the runtime registry is not ready, a
deep request returns a degraded body with `reason: "bootstrap"` and
`Retry-After: 1`. In the health-first startup mode, completing that response
still triggers runtime startup. The shallow bootstrap response remains
`200 {"status":"ok"}`.

## Compatibility and boundaries

- `deep=1`, `deep=true`, and bare `deep` enable the snapshot; all other values
  use shallow health.
- Single-workspace deep responses retain their existing values and add
  `workspaceCount: 1`.
- Authentication, Host allowlist, CORS, and rate-limit behavior do not change.
- The response exposes no workspace IDs, paths, trust state, or per-workspace
  details.
- No capability or SDK change is required. `workspaceCount` lets consumers
  identify the daemon-global contract.

Deep health is not an all-workspace readiness check and not an atomic reclaim
lease. Counter accessors do not ping child processes, and `connectedClients`
only represents REST SSE. A reclaimer should require repeated idle samples and
graceful shutdown; operators needing transport or per-workspace diagnostics
should use the authenticated `/daemon/status` endpoint.

## Alternatives rejected

- Aggregating only `WorkspaceRegistry.list()` would hide draining runtimes
  before their bridge cleanup finished and could report idle too early.
- Reusing `/daemon/status` would make health depend on a heavier snapshot with
  a different active-workspace scope and failure contract.
- Adding a workspace selector would preserve a caller-side fan-out problem and
  would not satisfy daemon-level idle detection.
- Defining `channelAlive` as “all channels live” would silently change its
  existing daemon-status-compatible meaning. Per-workspace failures belong in
  `/daemon/status`.
