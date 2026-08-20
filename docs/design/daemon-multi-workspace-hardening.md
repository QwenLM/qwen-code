# Daemon multi-workspace hardening baseline

Status: current implementation baseline and review contract for issue
[#6378](https://github.com/QwenLM/qwen-code/issues/6378). This document closes
the hardening phase; it is not a roadmap for adding new daemon features.

## Ownership model

Every daemon route and downstream operation belongs to exactly one of these
ownership classes:

| Ownership           | Meaning                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process-global      | One listener/process resource shared by every runtime, such as authentication, HTTP rate limits, connection limits, metrics, and shutdown.                                               |
| Legacy-primary      | A compatibility route whose contract intentionally targets the primary runtime. Omitting a workspace selector is not permission to guess another owner.                                  |
| Workspace-qualified | A route resolves an explicit workspace id first, then an encoded canonical absolute cwd, and dispatches only to that selected runtime.                                                   |
| Live-session-owner  | A singular live-session route scans registered runtimes for the unique bridge that owns the session and dispatches only there.                                                           |
| Persisted-workspace | A route resolves the workspace before reading its persisted session or organization storage; it may expose a declared read-only surface for an untrusted secondary without starting ACP. |

The primary workspace is the first startup runtime and the compatibility
default for routes that explicitly document that fallback. It is not a generic
fallback when resolution fails.

## Failure semantics

| State                        | Required behavior                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown workspace or session | Fail closed with the route's stable mismatch/not-found response. Do not probe or execute against primary.                                                                                                                                                                                          |
| Untrusted workspace          | Reject runtime-backed execution and mutation. An untrusted secondary may use only explicitly documented read-only surfaces, including bounded filesystem and persisted catalog/transcript reads, without starting ACP or writing repair state. Legacy primary preheat does not authorize requests. |
| Ambiguous live-session owner | Return a server error because dispatch cannot be made safely. Execute on no bridge.                                                                                                                                                                                                                |
| Bootstrapping runtime        | Keep process-global liveness responsive; runtime-backed work waits for or reports the declared startup failure. Deep health returns `503` with a reason while aggregation is unavailable.                                                                                                          |
| Draining runtime             | Refuse new work with the stable draining response. A non-forced removal rolls back with `workspace_busy` if activity exists; a forced removal requests termination and bounded cleanup of active resources. The runtime remains in daemon-global accounting until removal completes.               |
| Removed runtime              | Treat it as unknown. It must disappear from capabilities, routing, and health aggregation before the same workspace can be re-added. Cleanup after the persistence commit point is best-effort; failures are logged and do not restore routing.                                                    |

## Invariants

- Workspace resolution never falls back to primary after an unknown,
  untrusted, ambiguous, draining, or removed result.
- Workspace ids take precedence over encoded cwd selectors. Cwd selectors must
  be absolute and canonicalize to a registered runtime.
- Each active workspace runtime owns its environment snapshot, bridge, workspace
  services, filesystem/trust boundary, Voice state, and ACP/MCP resource
  boundary. Production attempts to preheat the primary bridge for compatibility
  and retries on first use after a preheat failure. A trusted secondary starts
  its ACP child on demand and, when `mcp_workspace_pool` is enabled, owns the
  pool inside that child; an untrusted secondary must not start either. Primary
  preheat does not bypass route trust gates. A
  process-global Voice coordinator enforces the shared admission cap while
  tracking leases by owning runtime. Same-named environment keys must not cross
  runtimes, and a workspace overlay must not mutate the parent process
  environment.
- A single daemon token authenticates the process; it is not a per-workspace
  ACL. HTTP rate limits, listener caps, total-session admission, metrics,
  shutdown, and the process fault radius are also daemon-global.
- When `mcp_workspace_pool` is advertised, MCP transports and budget accounting
  are shared by sessions inside one workspace runtime, never across runtimes.
  Without the tag, clients must accept the legacy per-session manager and
  `scope: 'session'` status.
- Explicit startup/static runtimes, including primary, are not removable.
  Dynamic or persisted secondary runtimes follow add, drain, remove, and re-add
  lifecycle rules. Draining runtimes stay visible to daemon-global health until
  logical removal completes. Forced removal aborts active resources and
  performs bounded best-effort teardown; a cleanup timeout is logged rather
  than rolling the logical removal back.
- Shallow `GET /health` remains exactly `200 {"status":"ok"}`. Deep health
  aggregates active and draining runtimes, returns a reason-bearing `503` for
  bootstrap or aggregation failure, and never exposes workspace paths. See
  [daemon-global deep health](./daemon-global-deep-health.md), implemented by
  [PR #6961](https://github.com/QwenLM/qwen-code/pull/6961).

## Review contract

For every new or changed daemon route, reviewers must name the ownership class
and follow the request through environment, bridge, service, filesystem, trust,
and failure handling. A route is incomplete if any downstream consumer can
silently use primary state after ownership resolution failed.

Review findings are classified as follows:

- Correctness, security, data-loss, isolation, or fail-open regressions belong
  in hardening and block the affected change.
- A new capability or migration of an intentional primary-only contract gets a
  separate issue and design; it does not expand this closeout.
- A refactor with no concrete defect does not enter the hardening scope.

After roughly five review rounds, only correctness, security, data-loss, and
regression fixes should expand an active hardening PR. Other valid suggestions
are recorded as follow-ups so the umbrella does not remain open indefinitely.

## Explicit current limits

- `POST /session/:id/branch`, `POST /session/:id/fork`, and
  `POST /session/:id/cd` remain legacy-primary for a secondary-owned live
  session and return `non_primary_session_route_not_supported`.
- Named daemon-managed channels are grouped by owning workspace and run one
  worker per owning runtime. `--channel all` intentionally remains
  primary-only.
- The daemon does not provide per-workspace authentication, rate limiting, or
  process fault isolation. Deploy separate daemons when those boundaries are
  required.

## Exit rule

This baseline, its contract tests, the route/environment guards, and daemon-wide
deep health are the fixed closeout for #6378. Branch/fork routing and `cd`
semantics remain independent feature work. After the closeout PRs land, future
review findings should be filed as focused issues instead of reopening an
unbounded hardening bucket.
