# `qwen serve` HTTP protocol reference

Stage 1 of the [qwen-code daemon design](https://github.com/QwenLM/qwen-code/issues/3803). All routes live under the daemon's base URL (default `http://127.0.0.1:4170`).

## Authentication

When the daemon was started with `--token` or `QWEN_SERVER_TOKEN`, **every route except `/health` on loopback binds** must carry:

```
Authorization: Bearer <token>
```

Without a configured token (loopback dev default) the header is optional. Token comparison is constant-time. 401 responses are uniform across `missing header` / `wrong scheme` / `wrong token`.

**`/health` exemption** (Bctum): on loopback binds (`127.0.0.1` / `localhost` / `::1` / `[::1]`) `/health` is registered BEFORE the bearer middleware, so liveness probes inside the pod don't need to carry the token even when the daemon was started with `--token`. Non-loopback binds (`--hostname 0.0.0.0` etc.) gate `/health` behind the bearer like every other route — see the [`GET /health`](#get-health) section for the rationale.

**`--require-auth` (#4175 PR 15).** Pass this flag at boot to extend the "must have a token" rule to loopback as well. Boot fails without a token; the `/health` exemption is dropped (so `/health` also requires `Authorization: Bearer …`).

When the flag is on, the global `bearerAuth` middleware gates **every** route — including `/capabilities`. An **unauthenticated** client therefore cannot pre-flight `caps.features` to discover that auth is required: the discovery surface for that case is the **401 response body** itself (uniform across all routes per the [Authentication](#authentication) section). The `require_auth` capability tag is a **post-authentication confirmation** — once a client successfully authenticates and reads `/capabilities`, the tag's presence confirms the daemon was started with `--require-auth` (useful for audit / compliance UIs and for SDK clients to surface "this deployment is hardened" in a settings panel). Mutation routes that opt into per-route strict mode (Wave 4 follow-ups) refuse with `401 { code: "token_required", error: "…" }` when reached on a no-token loopback default — but with `--require-auth` enabled the global bearer middleware short-circuits the request before the per-route gate, so the legacy `Unauthorized` body is what unauthenticated callers actually see.

**`--allow-origin <pattern>` (T2.4 [#4514](https://github.com/QwenLM/qwen-code/issues/4514)).** Browser webuis hitting the daemon cross-origin are blocked by default — any request carrying an `Origin` header returns `403 {"error":"Request denied by CORS policy"}` because CLI/SDK clients never send `Origin` and the daemon treats its presence as a sign the request came from a browser context the operator has not opted into. Pass `--allow-origin <pattern>` (repeatable) at boot to install an allowlist instead of the wall. Each pattern is either:

- The literal `*` — admit any origin. **Risky**: boot refuses when `*` is configured but no bearer token is set (any source: `--token`, `QWEN_SERVER_TOKEN`, or `--require-auth` which mandates a token at boot). The boot breadcrumb emits a stderr warning when `*` is in the list. **Recommendation**: pair with `--require-auth` on loopback binds so `/health` and `/demo` are also gated by the bearer — they're registered before the bearer middleware on loopback by default (so k8s/Compose probes can reach `/health` without a token), and a `*` allowlist makes them reachable from any cross-origin browser. On non-loopback binds the bearer is already mandatory at boot, so the `*` exposure surface is just `/health` (status JSON) and `/demo` (a static page whose JS still calls token-gated routes) — the actual API surface is gated regardless.
- A canonical URL origin — `<scheme>://<host>[:<port>]`. **No trailing slash, no path, no userinfo, no query.** Boot refuses with `InvalidAllowOriginPatternError` if the entry fails the round-trip `new URL(pattern).origin === pattern`; the error message names the bad pattern and the canonical form. Strict-by-intent: silent normalization (e.g. trimming a trailing `/`) would let typos slip through and accept ambiguous input.

Matched origins receive the standard CORS response headers on every request:

```
Access-Control-Allow-Origin: <echoed origin>
Vary: Origin
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-Qwen-Client-Id, Last-Event-ID
Access-Control-Max-Age: 86400
Access-Control-Expose-Headers: Retry-After
```

`Access-Control-Allow-Origin` echoes the request's origin verbatim (lowercase / uppercase as the browser sent it) rather than the literal `*`, even under the `*` pattern — browser caches key responses on it paired with `Vary: Origin`, and echoing leaves room to add `Access-Control-Allow-Credentials` in a later release without a schema change. `Access-Control-Expose-Headers: Retry-After` lets browser webuis honor daemon retry hints from `429` / `503` responses. `Access-Control-Allow-Credentials` is **NOT** sent today: the daemon authenticates via bearer-in-`Authorization`, which works cross-origin without `credentials: 'include'`.

OPTIONS preflight requests (OPTIONS with `Access-Control-Request-Method` or `Access-Control-Request-Headers`) short-circuit with `204 No Content` plus the headers above. This is the conventional CORS pattern and is safe — the preflight only confirms which methods/headers the daemon will accept; the actual subsequent request still runs the full chain (host allowlist → bearer auth → routes), so anti-DNS-rebinding and bearer enforcement still fire before any state is read or mutated. Plain OPTIONS requests from matched origins keep flowing downstream with CORS headers attached.

Origins that don't match the allowlist still get `403 {"error":"Request denied by CORS policy"}` — same envelope as the default wall, so clients that already parsed the wall's response don't have to special-case allowlist-deployed daemons. The reject path **does not** emit any `Access-Control-*` headers (the browser would ignore them, and emitting would indirectly advertise the allowlist size through header presence).

The configured pattern list is intentionally NOT echoed in `/capabilities` — browser webui already knows its own origin (it called the daemon, after all), and surfacing the list would let an unauthenticated reader of `/capabilities` enumerate every trusted origin (useful recon for a misconfigured deployment). SDK clients gate on the `caps.features.allow_origin` tag for "this daemon honors cross-origin browser hits" without needing to know which specific origins.

Loopback self-origin requests (e.g. the `/demo` page calling the daemon at the same `127.0.0.1:port`) are handled by a **separate** Origin-strip shim that runs BEFORE the CORS middleware and removes the `Origin` header for `127.0.0.1:port` / `localhost:port` / `[::1]:port` / `host.docker.internal:port`. So they pass through regardless of `--allow-origin` configuration — operators don't need to list the daemon's own port to make the demo page work.

## Common error shape

5xx responses carry the original error's `code` and `data` when present (JSON-RPC style — the ACP SDK forwards `{code, message, data}` from the agent):

```json
{
  "error": "Internal error",
  "code": -32000,
  "data": { "reason": "model quota exceeded" }
}
```

Malformed JSON in a request body returns:

```json
{ "error": "Invalid JSON in request body" }
```

with status `400`.

`SessionNotFoundError` for an unknown session id returns:

```json
{ "error": "No session with id \"<sid>\"", "sessionId": "<sid>" }
```

with status `404`.

`WorkspaceMismatchError` for a `POST /session` whose `cwd` doesn't canonicalize to the daemon's bound workspace (#3803 §02 — 1 daemon = 1 workspace) returns `400` with:

```json
{
  "error": "Workspace mismatch: daemon is bound to \"…\" but request asked for \"…\". …",
  "code": "workspace_mismatch",
  "boundWorkspace": "/path/the/daemon/binds",
  "requestedWorkspace": "/path/in/the/request"
}
```

Use this to detect mismatch pre-flight: read `workspaceCwd` off `/capabilities` and omit `cwd` from `POST /session` (it falls back to the bound workspace), or route the request to a daemon bound to `requestedWorkspace`.

`POST /session` past the daemon's `--max-sessions` cap returns `503` with a `Retry-After: 5` header and:

```json
{
  "error": "Session limit reached (20)",
  "code": "session_limit_exceeded",
  "limit": 20
}
```

Attaches to existing sessions are NOT counted toward the cap, so an idle daemon's reconnects keep working even when at-capacity.

`RestoreInProgressError` — only emitted by `POST /session/:id/load` and `POST /session/:id/resume` — returns `409` with a `Retry-After: 5` header (matching `session_limit_exceeded`) and:

```json
{
  "error": "Session \"<sid>\" is already being restored via session/<resume|load>; retry session/<load|resume> after it completes",
  "code": "restore_in_progress",
  "sessionId": "<sid>",
  "activeAction": "load",
  "requestedAction": "resume"
}
```

Fired when a `session/load` is issued for an id that already has a `session/resume` in flight (or vice versa). Wait at least `Retry-After` seconds and retry — the underlying restore completes within `initTimeoutMs` (default 10s). Same-action races (`load` vs `load`, `resume` vs `resume`) coalesce instead of erroring.

## Capabilities

The daemon advertises its supported feature tags from the serve capability
registry. Clients **must** gate UI off `features`, not off `mode` (per design
§10).

```
['health', 'capabilities', 'session_create', 'session_scope_override',
 'session_load', 'session_resume',
 'unstable_session_resume',
 'session_list', 'session_prompt', 'session_cancel', 'session_events',
 'slow_client_warning', 'typed_event_schema',
 'session_set_model', 'client_identity', 'client_heartbeat',
 'session_permission_vote', 'permission_vote', 'workspace_mcp', 'workspace_skills',
 'workspace_providers', 'auth_provider_install', 'workspace_memory',
 'workspace_agents', 'workspace_agent_generate', 'workspace_env',
 'workspace_preflight', 'session_context', 'session_context_usage',
 'session_supported_commands', 'session_tasks', 'session_stats',
 'session_close', 'session_metadata', 'mcp_guardrails',
 'workspace_mcp_manage', 'mcp_guardrail_events',
 'mcp_server_runtime_mutation',
 'workspace_file_read', 'workspace_file_bytes', 'workspace_file_write',
 'session_approval_mode_control', 'workspace_tool_toggle',
 'workspace_settings', 'workspace_init', 'workspace_mcp_restart',
 'session_recap', 'session_btw', 'session_shell_command',
 'mcp_workspace_pool', 'mcp_pool_restart',
 'require_auth', 'allow_origin', 'auth_device_flow',
 'permission_mediation', 'prompt_absolute_deadline', 'writer_idle_timeout',
 'non_blocking_prompt', 'session_language', 'session_rewind',
 'workspace_hooks', 'session_hooks', 'workspace_extensions',
 'session_branch', 'rate_limit', 'workspace_reload']
```

> Conditional tags appear only when their matching deployment toggle is on (see the table below). F3's `permission_mediation` tag is always-on and carries `modes: ['first-responder', 'designated', 'consensus', 'local-only']` so SDK clients can introspect the build-supported set; the runtime-active strategy is at `body.policy.permission`.

`session_scope_override` is the negotiation handle for the per-request `sessionScope` field on `POST /session` (see below). Older daemons silently ignore the field, so SDK clients should pre-flight `caps.features` for this tag before sending it.

`session_load` and `session_resume` advertise the explicit-restore routes (`POST /session/:id/load` and `POST /session/:id/resume`). Older daemons return `404` for these paths, so SDK clients should pre-flight `caps.features` before calling. `unstable_session_resume` is still advertised as a deprecated alias for compatibility with SDKs that shipped while the underlying ACP method was named `connection.unstable_resumeSession`; new clients should gate on `session_resume`.

`slow_client_warning` covers two co-released SSE backpressure knobs introduced in #4175 Wave 2.5 PR 10: (a) the daemon emits a `slow_client_warning` synthetic event-stream frame when a subscriber's queue crosses 75% full, once per overflow episode (rearmed after the queue drains below 37.5%); (b) `GET /session/:id/events` accepts a `?maxQueued=N` query param (range `[16, 2048]`) to pre-size the per-subscriber backlog for cold reconnects against a large replay ring. The daemon-wide ring size is controlled by `--event-ring-size` (default **8000**, per #3803 §02). Old daemons silently lack both — pre-flight this tag before opting in.

`typed_event_schema` advertises daemon event payloads that match the SDK's `KnownDaemonEvent` schema. Older daemons may still stream compatible frames, but SDK clients should pre-flight this tag before assuming typed event coverage.

`client_heartbeat` advertises `POST /session/:id/heartbeat`. Older daemons return `404`; pre-flight this tag before issuing periodic heartbeats.

`session_close` and `session_metadata` advertise `DELETE /session/:id` and `PATCH /session/:id/metadata`. Older daemons return `404`; pre-flight these tags before exposing close or rename affordances.

`session_approval_mode_control`, `workspace_tool_toggle`, `workspace_init`, and `workspace_mcp_restart` (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 17) advertise the four mutation control routes documented under "Mutation: approval, tools, init, MCP restart" below. All four are strict-gated by the PR 15 mutation gate (a daemon configured without a bearer token rejects them with 401 `token_required`). Older daemons return `404`; pre-flight each tag before exposing the corresponding affordance.

`mcp_guardrails` (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14) covers the MCP budget surface: the `clientCount` / `clientBudget` / `budgetMode` / `budgets[]` fields on `GET /workspace/mcp`, the `disabledReason` field on per-server cells, and the `--mcp-client-budget` / `--mcp-budget-mode` CLI flags. Older daemons omit the new fields entirely; SDK clients pre-flight this tag before relying on `budgets[]` semantics. The registry descriptor also carries `modes: ['warn', 'enforce']` for future feature-modes exposure — for now, clients infer mode from the snapshot's `budgetMode` field. Server refusal under `enforce` mode is deterministic by `Object.entries(mcpServers)` declaration order; a future scope-precedence layer (if qwen-code adopts one) would shift this to "lowest-precedence first" to mirror claude-code's `plugin < user < project < local` convention.

> ⚠️ **PR 14 v1 scope: per-session, not per-workspace.** Each ACP session inside the daemon constructs its own `Config` + `McpClientManager` (via `acpAgent.newSessionConfig`). The budget caps live MCP clients **per session**; each session independently reads `QWEN_SERVE_MCP_CLIENT_BUDGET` from the forwarded env. With `--mcp-client-budget=10` and 5 concurrent ACP sessions, the actual live MCP client count can reach 5 × 10 = 50 across the daemon. The `GET /workspace/mcp` snapshot reads the **bootstrap session's** `McpClientManager` accounting only — the `budgets[0].scope: 'session'` value is the honest signal that this is per-session, not aggregated. **Wave 5 PR 23 (shared MCP pool)** will introduce a workspace-scoped manager and add a `scope: 'workspace'` cell alongside the per-session cell for true cross-session aggregation. v1 is the in-process counter + soft enforcement foundation that PR 23 builds on.

`workspace_file_read` covers the text/list/stat/glob workspace file routes
(`GET /file`, `GET /list`, `GET /glob`, `GET /stat`). `workspace_file_bytes`
covers `GET /file/bytes`, which was added later so clients can pre-flight raw
byte-window support against PR19-era daemons. `workspace_file_write` covers
the hash-aware text mutation routes (`POST /file/write`, `POST /file/edit`).
The write tag means the route contract exists; it does not mean the current
deployment is open for anonymous mutation. Write/edit are strict mutation
routes and require a configured bearer token even on loopback.

`daemon_status` advertises `GET /daemon/status`, the consolidated read-only
operator diagnostic snapshot documented below.

**Conditional tags.** A small number of feature tags are advertised only when the matching deployment toggle is on. Tag presence = behavior is on; absence = either an older daemon predating the tag, OR a current daemon where the operator did not opt in. Currently:

| Tag                        | Advertised when …                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require_auth`             | the daemon was started with `--require-auth` (or `requireAuth: true` via the embedded API). Bearer token is mandatory on every route, including `/health` on loopback binds.                                                                                                                                                                                                                                                                                                                                    |
| `mcp_workspace_pool`       | the shared MCP transport pool is active. Omitted when `QWEN_SERVE_NO_MCP_POOL=1` disables the pool.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mcp_pool_restart`         | the shared MCP transport pool is active; restart responses may include pool-aware multi-entry shapes.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `allow_origin`             | T2.4 ([#4514](https://github.com/QwenLM/qwen-code/issues/4514)). The daemon was started with at least one `--allow-origin <pattern>` (or `allowOrigins: [...]` via the embedded API). Cross-origin requests from matched origins receive proper CORS response headers; unmatched origins still get the default 403. The configured pattern list is intentionally NOT echoed in `/capabilities` to avoid leaking the trusted-origin set to unauthenticated readers — browser webui already knows its own origin. |
| `prompt_absolute_deadline` | `--prompt-deadline-ms` / `QWEN_SERVE_PROMPT_DEADLINE_MS` / `ServeOptions.promptDeadlineMs` is set to a positive integer.                                                                                                                                                                                                                                                                                                                                                                                        |
| `writer_idle_timeout`      | `--writer-idle-timeout-ms` / `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` / `ServeOptions.writerIdleTimeoutMs` is set to a positive integer.                                                                                                                                                                                                                                                                                                                                                                             |
| `workspace_settings`       | the daemon was created with settings persistence available.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `session_shell_command`    | session shell execution is explicitly enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rate_limit`               | `--rate-limit` / `QWEN_SERVE_RATE_LIMIT=1` / `ServeOptions.rateLimit` is enabled.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `workspace_reload`         | workspace reload support is available in the embedded route configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`mcp_guardrails` is **not** in this conditional table — it's an always-on tag, advertised whenever the binary supports the new `/workspace/mcp` budget fields, regardless of whether the operator configured a budget. Operators who haven't set `--mcp-client-budget` still get the new fields (with `budgetMode: 'off'`, `budgets: []`).

`mcp_guardrail_events` (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14b) advertises the typed SSE push events that surface MCP budget state crossings without a poll loop. Two frame types arrive on `GET /session/:id/events`:

- `mcp_budget_warning` — fires once on the upward 75% crossing of `reservedSlots.size / clientBudget`. Re-arms only after the ratio drops below 37.5% (`MCP_BUDGET_REARM_FRACTION`). Mirrors PR 10's `slow_client_warning` hysteresis, but at the manager level rather than the per-subscriber backlog level. Payload: `{ liveCount, reservedCount, budget, thresholdRatio: 0.75, mode: 'warn' | 'enforce' }`. Fires under both `warn` and `enforce` modes; never under `off`.
- `mcp_child_refused_batch` — fires at end of each `discoverAllMcpTools*` pass when one or more servers were refused, AND as a length-1 batch on the `readResource` lazy-spawn refusal path. Payload: `{ refusedServers: [{ name, transport, reason: 'budget_exhausted' }, ...], budget, liveCount, reservedCount, mode: 'enforce' }`. `mode` is the literal `'enforce'` because `warn` mode never refuses.

Both events live in the per-session SSE replay ring (they carry an `id`) so a client reconnecting with `Last-Event-ID` resumes through them; the snapshot at `GET /workspace/mcp` is still the source-of-truth for state-after-extended-disconnect. Always-on once advertised — there is no conditional toggle. SDK reducer state (`DaemonSessionViewState`) exposes `mcpBudgetWarningCount`, `lastMcpBudgetWarning`, `mcpChildRefusedBatchCount`, `lastMcpChildRefusedBatch` for adapters that want simple lag-style UI.

## Routes

### `GET /health`

Liveness probe. Default form returns `200 {"status":"ok"}` if the listener is up — cheap, no bridge access, suitable for high-frequency k8s/Compose liveness probes.

Pass `?deep=1` (also accepts `?deep=true` or bare `?deep`) for a probe that exposes bridge **counters** (informational only, not a true liveness check):

```json
{ "status": "ok", "sessions": 3, "pendingPermissions": 1 }
```

> ⚠️ The deep probe is **informational**, not a real liveness verification. It reads counter accessors (`bridge.sessionCount`, `bridge.pendingPermissionCount`) which are simple Map-size getters; they don't ping individual child processes / channels and so won't detect a wedged-but-still-counted session. Use it for capacity dashboards (current concurrency vs. `--max-sessions`, queue depth) rather than as the trigger for "pull this daemon out of rotation". A `503 {"status":"degraded"}` response is theoretically possible if a custom bridge implementation's getters throw, but the real bridge's getters never do — under normal operation the deep probe always returns 200. For real liveness, rely on whether the listener accepts a TCP connection at all (i.e. the default `/health` without `?deep`).

**Auth:** required **only on non-loopback binds**. On loopback (`127.0.0.1`, `::1`, `[::1]`) `/health` is registered before the bearer middleware so k8s/Compose probes inside the pod don't need to carry the token. On non-loopback (`--hostname 0.0.0.0` etc.) the route is registered after the bearer middleware and returns 401 without a valid token — otherwise an unauthenticated caller could probe arbitrary addresses to confirm a `qwen serve` exists, a low-severity info leak that combines poorly with port scanning. CORS deny + Host allowlist still apply on the loopback exemption.

### `GET /daemon/status`

Read-only operator diagnostics. Unlike `/health`, this is a normal daemon API:
it is registered after bearer auth and rate limiting, including on loopback
binds. Query parameter:

- `detail=summary` (default) reads only in-memory daemon state.
- `detail=full` also includes live session diagnostics, ACP connection
  diagnostics, auth device-flow counts, and workspace status sections.
- any other `detail` returns `400 { "code": "invalid_detail" }`.

`summary` intentionally does not query workspace status methods, start an ACP
child, or spawn a session. `full` queries each workspace section independently;
a timeout or exception marks only that section as `unavailable` and adds a
`workspace_status_unavailable` issue.

Response shape:

```json
{
  "v": 1,
  "detail": "summary",
  "generatedAt": "2026-06-16T00:00:00.000Z",
  "status": "ok",
  "issues": [],
  "daemon": {
    "pid": 12345,
    "uptimeMs": 3600000,
    "mode": "http-bridge",
    "workspaceCwd": "/repo",
    "qwenCodeVersion": "0.18.1",
    "daemonId": "serve-..."
  },
  "security": {
    "tokenConfigured": true,
    "requireAuth": false,
    "loopbackBind": true,
    "allowOriginConfigured": false,
    "allowOriginMode": "none",
    "sessionShellCommandEnabled": false
  },
  "limits": {
    "maxSessions": 20,
    "maxPendingPromptsPerSession": 5,
    "listenerMaxConnections": 256,
    "eventRingSize": 8000,
    "promptDeadlineMs": null,
    "writerIdleTimeoutMs": null,
    "channelIdleTimeoutMs": 0,
    "sessionIdleTimeoutMs": 1800000,
    "acpConnectionCap": 64
  },
  "runtime": {
    "sessions": { "active": 0 },
    "permissions": { "pending": 0, "policy": "first-responder" },
    "channel": { "live": false },
    "transport": {
      "restSseActive": 0,
      "acp": {
        "enabled": true,
        "connections": 0,
        "connectionStreams": 0,
        "sessionStreams": 0,
        "sseStreams": 0,
        "wsStreams": 0,
        "pendingClientRequests": 0
      }
    }
  }
}
```

`status` is `error` if any issue has error severity, `warning` if any issue has
warning severity, otherwise `ok`. Issue codes are stable and include
`session_capacity_high`, `connection_capacity_high`, `pending_permissions`,
`acp_channel_down`, `preflight_error`, `mcp_budget_warning`,
`mcp_budget_exhausted`, `rate_limit_hits`, and
`workspace_status_unavailable`.

Security: the response never includes bearer tokens, client ids, full ACP
connection ids, device-flow user codes, or verification URLs. `summary` omits
the daemon log path; `full` may include it for authenticated operators.

### `GET /capabilities`

```json
{
  "v": 1,
  "protocolVersions": {
    "current": "v1",
    "supported": ["v1"]
  },
  "mode": "http-bridge",
  "features": ["health", "daemon_status", "capabilities", "..."],
  "modelServices": [],
  "workspaceCwd": "/canonical/path/to/workspace"
}
```

Stable contract: when `v` increments the frame layout has changed in a backwards-incompatible way.

> **`protocolVersions`** describes the serve protocol versions the daemon can speak. `current` is the daemon's preferred protocol version and `supported` is the compatible set. Clients that require a specific protocol should check `supported`; feature-specific UI should still gate on `features`. Additive to v=1: older v=1 daemons omit this field, so SDK clients that target older builds should treat it as optional.

> **`modelServices` is always `[]` in Stage 1.** The agent uses its single default model service and doesn't enumerate it over the wire. Stage 2 will populate this from registered model adapters so SDK clients can build service-pickers; until then, do NOT rely on this field being non-empty.

> **`workspaceCwd`** is the canonical absolute path this daemon binds to (#3803 §02 — 1 daemon = 1 workspace). Use it to (a) detect mismatch before posting `/session` and (b) omit `cwd` on `POST /session` (the route falls back to this path). Multi-workspace deployments expose multiple daemons on different ports, each with its own `workspaceCwd`. Additive to v=1: pre-§02 v=1 daemons omit the field — clients that target older builds should null-check before consuming it.

### Read-only runtime status routes

These routes report daemon-side runtime snapshots. They are additive v1 routes,
do not mutate state, and do not change the serve protocol version. Workspace
status routes intentionally do **not** start the ACP child process just because
a client polls a GET route: if the daemon is idle, they return
`initialized: false` with an empty snapshot. Session status routes require a
live session and use the standard `404 SessionNotFoundError` shape for unknown
ids.

Capability tags:

- `workspace_mcp` → `GET /workspace/mcp`
- `workspace_skills` → `GET /workspace/skills`
- `workspace_providers` → `GET /workspace/providers`
- `workspace_env` → `GET /workspace/env`
- `workspace_preflight` → `GET /workspace/preflight`
- `session_context` → `GET /session/:id/context`
- `session_supported_commands` → `GET /session/:id/supported-commands`
- `session_tasks` → `GET /session/:id/tasks`

Common status cell:

```ts
type DaemonStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'not_started'
  | 'unknown';

type DaemonErrorKind =
  | 'missing_binary'
  | 'blocked_egress'
  | 'auth_env_error'
  | 'init_timeout'
  | 'protocol_error'
  | 'missing_file'
  | 'parse_error';

interface DaemonStatusCell {
  kind: string;
  status: DaemonStatus;
  error?: string;
  errorKind?: DaemonErrorKind;
  hint?: string;
}
```

`errorKind` is a closed enum shared by `/workspace/preflight`,
`/workspace/env`, and (eventually) MCP guardrails so SDK clients can render
remediation per category instead of parsing free-form messages. PR 13
(#4175) introduced the seven literals listed above; PR 14 will populate
`blocked_egress` once the egress probe lands.

Status payloads never expose MCP env values, headers, OAuth/service-account
details, provider API keys, provider `baseUrl` / `envKey`, skill body, skill
filesystem paths, hook definitions, or values of secret environment
variables. `/workspace/env` reports the **presence** of whitelisted env
vars only; proxy URLs are stripped of credentials and reduced to
`host:port` before they hit the wire.

### `GET /workspace/mcp`

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "discoveryState": "completed",
  "servers": [
    {
      "kind": "mcp_server",
      "status": "ok",
      "name": "docs",
      "mcpStatus": "connected",
      "transport": "stdio",
      "disabled": false,
      "description": "Documentation server",
      "extensionName": "docs-ext"
    }
  ]
}
```

`discoveryState` is one of `not_started`, `in_progress`, or `completed`.
`transport` is one of `stdio`, `sse`, `http`, `websocket`, `sdk`, or
`unknown`. `errors` is omitted when discovery succeeds.

**MCP client guardrails (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14).** Post-PR-14 daemons extend the payload with four additive fields and one workspace-level cell:

```jsonc
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "discoveryState": "completed",
  "clientCount": 3,
  "clientBudget": 2,
  "budgetMode": "enforce",
  "budgets": [
    {
      "kind": "mcp_budget",
      "scope": "session",
      "status": "error",
      "errorKind": "budget_exhausted",
      "hint": "Raise --mcp-client-budget or remove servers from mcpServers config.",
      "liveCount": 2,
      "budget": 2,
      "mode": "enforce",
      "refusedCount": 1,
    },
  ],
  "servers": [
    {
      "kind": "mcp_server",
      "status": "ok",
      "name": "a",
      "mcpStatus": "connected",
      "transport": "stdio",
      "disabled": false,
    },
    {
      "kind": "mcp_server",
      "status": "ok",
      "name": "b",
      "mcpStatus": "connected",
      "transport": "stdio",
      "disabled": false,
    },
    {
      "kind": "mcp_server",
      "status": "error",
      "name": "c",
      "mcpStatus": "disconnected",
      "transport": "stdio",
      "disabled": false,
      "disabledReason": "budget",
      "errorKind": "budget_exhausted",
      "hint": "...",
    },
  ],
}
```

`budgetMode` is one of `enforce`, `warn`, or `off`. `clientBudget` is absent when no budget was set. `budgets[]` is **always an array** on post-PR-14 daemons (possibly empty when `budgetMode === 'off'`); pre-PR-14 daemons omit the field entirely. v1 emits one cell with `scope: 'session'` (per-session enforcement — see the capabilities section above for why). Consumers MUST tolerate additional `budgets[]` entries with unrecognized `scope` values — Wave 5 PR 23 will add `scope: 'workspace'` (or `'pool'`) alongside the per-session cell without a schema bump.

`disabledReason` on per-server cells distinguishes operator-disabled (`'config'` — `disabledMcpServers` config list) from budget-refused (`'budget'` — discovered but never connected due to `enforce` mode). Refusals are deterministic by `Object.entries(mcpServers)` declaration order. The per-server `status: 'error', errorKind: 'budget_exhausted'` shadows the raw `mcpStatus: 'disconnected'` (which is true but not the operator-facing severity).

Budget enforcement in PR 14 v1 is **per-session, not per-workspace**. Although Mode B daemons are `1 daemon = 1 workspace × N sessions` post-#4113 at the process level, the `McpClientManager` is constructed inside each ACP session's `Config` via `acpAgent.newSessionConfig`, so N sessions each enforce their own copy of the cap. The snapshot represents the bootstrap session's view. Wave 5 PR 23 introduces a workspace-scoped shared MCP pool that graduates this to true per-workspace enforcement.

**Detecting budget pressure.** Two surfaces, both populated post-PR-14b:

- **Push events** (advertised via `mcp_guardrail_events`): subscribe to `GET /session/:id/events` and narrow `mcp_budget_warning` / `mcp_child_refused_batch` frames through `KnownDaemonEvent`. The state machine fires once per upward 75% crossing (re-armed below 37.5%); refusals are coalesced once per discovery pass under `enforce` mode.
- **Snapshot poll** (advertised via `mcp_guardrails`): `GET /workspace/mcp` and inspect the per-session budget cell (`budgets[0]`):

- `budgets[0].status === 'warning'` ⇔ `liveCount >= 0.75 * clientBudget` (matches the hysteresis threshold PR 14b's push event will use).
- `budgets[0].status === 'error'` ⇔ `refusedCount > 0` (one or more servers refused this discovery pass).
- `budgets[0].status === 'ok'` ⇔ below the 75% threshold AND no refusals.

Recommended poll cadence: aligned with whatever already polls `/workspace/mcp`; the snapshot is cheap and the budget cell carries no extra discovery cost. SDK clients that subscribe to push events still benefit from the snapshot for state-after-extended-disconnect (the SSE replay ring depth is finite — `--event-ring-size`, default 8000 — so a client offline longer than the ring's coverage falls back to snapshot resync).

### `GET /workspace/skills`

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "skills": [
    {
      "kind": "skill",
      "status": "ok",
      "name": "review",
      "description": "Review code",
      "level": "project",
      "modelInvocable": true,
      "argumentHint": "[path]"
    }
  ]
}
```

`level` is one of `project`, `user`, `extension`, or `bundled`. `errors` is
omitted when discovery succeeds.

### `GET /workspace/providers`

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "current": { "authType": "qwen", "modelId": "qwen3(qwen)" },
  "providers": [
    {
      "kind": "model_provider",
      "status": "ok",
      "authType": "qwen",
      "current": true,
      "models": [
        {
          "modelId": "qwen3(qwen)",
          "baseModelId": "qwen3",
          "name": "Qwen 3",
          "description": null,
          "contextLimit": 4096,
          "isCurrent": true,
          "isRuntime": false
        }
      ]
    }
  ]
}
```

Models are grouped by auth type. Provider connection diagnostics live on
`/workspace/preflight`'s `providers` cell; environment preflight lives on
`/workspace/preflight` and `/workspace/env` (below). `errors` is omitted
when snapshot construction succeeds.

### `GET /workspace/env`

Reports the daemon process's runtime, platform, sandbox, proxy, and the
**presence** of whitelisted secret environment variables. Always answers
from `process.*` state — the daemon never spawns an ACP child to serve
this route, and the response is identical whether ACP is up or idle. The
`acpChannelLive` field is informational only.

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "acpChannelLive": false,
  "cells": [
    { "kind": "runtime", "name": "node", "status": "ok", "value": "22.4.0" },
    { "kind": "platform", "name": "darwin", "status": "ok", "value": "arm64" },
    {
      "kind": "sandbox",
      "name": "SANDBOX",
      "status": "disabled",
      "present": false
    },
    {
      "kind": "proxy",
      "name": "HTTPS_PROXY",
      "status": "ok",
      "present": true,
      "value": "proxy.internal:1080"
    },
    {
      "kind": "proxy",
      "name": "NO_PROXY",
      "status": "disabled",
      "present": false
    },
    {
      "kind": "env_var",
      "name": "OPENAI_API_KEY",
      "status": "ok",
      "present": true
    },
    {
      "kind": "env_var",
      "name": "ANTHROPIC_BASE_URL",
      "status": "disabled",
      "present": false
    }
  ]
}
```

Cell shape:

```ts
type DaemonEnvKind =
  | 'runtime' // name: 'node' | 'bun' | 'unknown'; value: process.versions.node
  | 'platform' // name: process.platform; value: process.arch
  | 'sandbox' // name: 'SANDBOX' | 'SEATBELT_PROFILE'; value optional
  | 'proxy' // name: HTTP_PROXY | HTTPS_PROXY | NO_PROXY | ALL_PROXY; value: redacted host
  | 'env_var'; // presence-only; value field is ALWAYS omitted

interface DaemonEnvCell extends DaemonStatusCell {
  kind: DaemonEnvKind;
  name: string;
  present?: boolean;
  value?: string;
}
```

**Redaction policy.** `kind: 'env_var'` cells never include a `value`
field; clients see `present: boolean` only. `kind: 'proxy'` cells run the
raw env value through credential redaction (`redactProxyCredentials`) and
then through `URL` parsing so the wire only carries `host:port`. `NO_PROXY`
is passed through redaction verbatim because it is a host list rather than
a URL. The whitelist of enumerated secret env vars currently includes
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY`, and `QWEN_SERVER_TOKEN`. Other
env vars are not enumerated, so accidentally-set secrets stay invisible.

### `GET /workspace/preflight`

Reports daemon readiness checks. **Daemon-level cells** (`node_version`,
`cli_entry`, `workspace_dir`, `ripgrep`, `git`, `npm`) are always
populated from `process.*` and `node:fs`. **ACP-level cells** (`auth`,
`mcp_discovery`, `skills`, `providers`, `tool_registry`, `egress`)
require a live ACP child — when the daemon is idle they emit
`status: 'not_started'` placeholders. The route never spawns ACP solely
to populate cells; the corresponding cells fall back to `not_started`.

Idle response (no ACP child):

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "acpChannelLive": false,
  "cells": [
    {
      "kind": "node_version",
      "status": "ok",
      "locality": "daemon",
      "detail": { "version": "22.4.0", "required": ">=22" }
    },
    {
      "kind": "cli_entry",
      "status": "ok",
      "locality": "daemon",
      "detail": { "path": "/usr/local/bin/qwen", "source": "process.argv[1]" }
    },
    {
      "kind": "workspace_dir",
      "status": "ok",
      "locality": "daemon",
      "detail": { "path": "/canonical/path" }
    },
    { "kind": "ripgrep", "status": "ok", "locality": "daemon" },
    {
      "kind": "git",
      "status": "ok",
      "locality": "daemon",
      "detail": { "version": "2.45.0" }
    },
    {
      "kind": "npm",
      "status": "ok",
      "locality": "daemon",
      "detail": { "version": "10.7.0" }
    },
    {
      "kind": "auth",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "mcp_discovery",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "skills",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "providers",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "tool_registry",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "egress",
      "status": "not_started",
      "locality": "acp",
      "hint": "egress probing lands in PR 14 (#4175)"
    }
  ]
}
```

Cell shape:

```ts
type DaemonPreflightKind =
  | 'node_version'
  | 'cli_entry'
  | 'workspace_dir'
  | 'ripgrep'
  | 'git'
  | 'npm'
  | 'auth'
  | 'mcp_discovery'
  | 'skills'
  | 'providers'
  | 'tool_registry'
  | 'egress';

interface DaemonPreflightCell extends DaemonStatusCell {
  kind: DaemonPreflightKind;
  locality: 'daemon' | 'acp';
  detail?: Record<string, unknown>;
}
```

`errorKind` semantics:

- `missing_binary` — Node version below required, missing `QWEN_CLI_ENTRY`,
  ripgrep / git / npm not on PATH (warnings rather than errors for the
  optional binaries).
- `missing_file` — `boundWorkspace` does not exist or is not a directory;
  skill parse error pointing at a missing or unreadable file.
- `parse_error` — `SKILL.md` parse failure, malformed config JSON.
- `auth_env_error` — `validateAuthMethod` returned a non-null failure
  string, or a `ModelConfigError` subclass propagated from provider
  resolution.
- `init_timeout` — `withTimeout` reject in the bridge (an actual timeout
  while waiting on an ACP roundtrip). Recognized via the
  `BridgeTimeoutError` typed class. Note: a transient `mcp_discovery`
  `warning` cell with `connecting > 0` does NOT carry this kind — that's
  a normal handshake-in-progress state, distinct from a real timeout.
- `protocol_error` — ACP `extMethod` rejected because the channel closed
  mid-request, or because tool registry was unexpectedly absent.
- `blocked_egress` — reserved for PR 14 (#4175). PR 13 leaves the
  `egress` cell as `status: 'not_started'`.

If the bridge fails to reach the ACP child while serving a preflight
request (e.g. a mid-request channel close), the envelope's `errors` array
carries a single `ServeStatusCell` describing the failure and the cells
fall back to `not_started` ACP placeholders. Daemon-level cells are still
returned.

### Workspace file routes

All file paths are resolved through the daemon's bound workspace. Responses use
workspace-relative paths and never return absolute filesystem paths for normal
success cases. Successful file responses include:

```http
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

Filesystem errors use this JSON shape:

```json
{
  "errorKind": "hash_mismatch",
  "error": "expected sha256:..., found sha256:...",
  "hint": "re-read the file and retry with the latest hash",
  "status": 409
}
```

`errorKind` values include `path_outside_workspace`, `symlink_escape`,
`path_not_found`, `binary_file`, `file_too_large`, `untrusted_workspace`,
`permission_denied`, `parse_error`, `hash_mismatch`,
`file_already_exists`, `text_not_found`, and `ambiguous_text_match`.

#### `GET /file`

Reads a text file. Query params: `path` (required), `maxBytes`, `line`, and
`limit`. The daemon rejects binary files and files above the text read cap.
The response includes `hash`, a SHA-256 digest over the raw on-disk bytes for
the whole file, even when `line`, `limit`, or `maxBytes` returned a slice.

```json
{
  "kind": "file",
  "path": "src/index.ts",
  "content": "export {};\n",
  "encoding": "utf-8",
  "bom": false,
  "lineEnding": "lf",
  "sizeBytes": 11,
  "returnedBytes": 11,
  "truncated": false,
  "hash": "sha256:...",
  "matchedIgnore": null,
  "originalLineCount": null
}
```

#### `GET /file/bytes`

Reads raw bytes from a file without decoding. Query params: `path` (required),
`offset` (default `0`), and `maxBytes` (default `65536`, max `262144`). This
route supports bounded windows on large binary files without slurping the whole
file. The response includes `hash` only when the returned window covers the
entire file.

```json
{
  "kind": "file_bytes",
  "path": "assets/logo.png",
  "offset": 0,
  "sizeBytes": 3912,
  "returnedBytes": 3912,
  "truncated": false,
  "contentBase64": "...",
  "hash": "sha256:..."
}
```

#### `POST /file/write`

Creates or replaces a text file. This is a strict mutation route: on loopback
without a configured token it returns `401 { "code": "token_required" }`.
With `--require-auth`, the global bearer middleware rejects unauthenticated
requests before the route runs.

Body:

```json
{
  "path": "src/new.ts",
  "content": "export const value = 1;\n",
  "mode": "create"
}
```

```json
{
  "path": "src/existing.ts",
  "content": "export const value = 2;\n",
  "mode": "replace",
  "expectedHash": "sha256:..."
}
```

`mode` must be `create` or `replace`. `create` never overwrites an existing
file (`409 file_already_exists`). `replace` requires `expectedHash`; missing or
malformed hashes are `400 parse_error`, and stale hashes are
`409 hash_mismatch`. `expectedHash` is `sha256:` plus 64 lowercase hex
characters, computed over raw on-disk bytes.

`bom`, `encoding`, and `lineEnding` may be supplied. Replacement preserves the
existing file's encoding profile by default; explicit fields override it.
Binary writes are out of scope.

The daemon writes to a random temp file in the target directory, fsyncs where
supported, re-checks the current hash immediately before `rename()`, then
renames into place. This prevents partial-file observation and serializes
daemon-originated writes to the same file, but it is not a cross-process
kernel compare-and-swap: an external editor can still race in the tiny window
between final hash check and rename.

```json
{
  "kind": "file_write",
  "path": "src/existing.ts",
  "mode": "replace",
  "created": false,
  "sizeBytes": 24,
  "hash": "sha256:...",
  "encoding": "utf-8",
  "bom": false,
  "lineEnding": "lf",
  "matchedIgnore": null
}
```

#### `POST /file/edit`

Applies one exact text replacement to an existing text file. This is also a
strict mutation route and requires `expectedHash`.

```json
{
  "path": "src/config.ts",
  "oldText": "timeout: 30000",
  "newText": "timeout: 60000",
  "expectedHash": "sha256:..."
}
```

`oldText` must be non-empty and occur exactly once. No match returns
`422 text_not_found`; multiple matches return `422 ambiguous_text_match`.
The route preserves encoding, BOM, and line endings, and re-checks
`expectedHash` immediately before the atomic rename.

Explicit writes/edits to ignored paths are allowed because the authenticated
caller named the path. Success responses and audit events include
`matchedIgnore: "file" | "directory" | null`.

```json
{
  "kind": "file_edit",
  "path": "src/config.ts",
  "replacements": 1,
  "sizeBytes": 128,
  "hash": "sha256:...",
  "encoding": "utf-8",
  "bom": false,
  "lineEnding": "lf",
  "matchedIgnore": null
}
```

### `GET /session/:id/context`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "workspaceCwd": "/canonical/path",
  "state": {
    "models": {},
    "modes": {},
    "configOptions": []
  }
}
```

`state` mirrors the same ACP model/mode/config-option shapes used by
`POST /session`, `POST /session/:id/load`, and `POST /session/:id/resume`.

### `GET /session/:id/supported-commands`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "availableCommands": [
    {
      "name": "init",
      "description": "Initialize the project",
      "input": null,
      "_meta": { "source": "builtin" }
    }
  ],
  "availableSkills": ["review"]
}
```

`availableCommands` is the same command snapshot used by the
`available_commands_update` SSE notification. `availableSkills` lists skill
names only; clients must not expect skill bodies or paths over this route.

### `GET /session/:id/tasks`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "now": 1700000000000,
  "tasks": [
    {
      "kind": "agent",
      "id": "agent-1",
      "label": "reviewer: check failure",
      "description": "check failure",
      "status": "running",
      "startTime": 1699999999000,
      "runtimeMs": 1000,
      "outputFile": "/tmp/agent-1.jsonl",
      "isBackgrounded": true,
      "subagentType": "reviewer"
    }
  ]
}
```

This route is a read-only out-of-band snapshot. It is intentionally not a
prompt and can be queried while the session is streaming. The response only
contains whitelisted metadata from the agent, shell, and monitor task
registries; controllers, timers, offsets, pending messages, and raw registry
objects are never exposed.

### `POST /session`

Spawn a new agent or attach to an existing one (under `sessionScope: 'single'`, the default).

Request:

```json
{
  "cwd": "/absolute/path/to/workspace",
  "modelServiceId": "qwen-prod",
  "sessionScope": "thread"
}
```

| Field            | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`            | no       | Absolute path matching the daemon's bound workspace. If omitted, the route falls back to `boundWorkspace` (read it off `/capabilities.workspaceCwd`). A mismatched non-empty `cwd` returns `400 workspace_mismatch` (#3803 §02 — 1 daemon = 1 workspace). Workspace paths are canonicalized via `realpathSync.native` (with a resolve-only fallback for non-existent paths) so case-insensitive filesystems don't reject sessions per spelling.                                                                                                                                                                          |
| `modelServiceId` | no       | Selects which configured _model service_ the agent will route through (the back-end provider — Alibaba ModelStudio, OpenRouter, etc). If omitted the agent uses its default. If the workspace already has a session, this calls `setSessionModel` on the existing one and broadcasts `model_switched`. Distinct from `modelId` on `POST /session/:id/model`, which selects the model **within** an already-bound service. The `modelServices` array on `/capabilities` is reserved for advertising configured services; in Stage 1 it is always `[]` (the agent's default service is used and not enumerated over HTTP). |
| `sessionScope`   | no       | Per-request override for session sharing. `'single'` (the daemon-wide default) makes a second same-workspace `POST /session` reuse the existing session (`attached: true`); `'thread'` forces a fresh distinct session every call. Omit to inherit the daemon-wide default. Values outside the enum return `400 { code: 'invalid_session_scope' }`. Old daemons (pre-#4175 PR 5) silently ignore the field — pre-flight `caps.features.session_scope_override` before sending. The daemon-wide default is hardcoded to `'single'` in production today; #4175 may add a `--sessionScope` CLI flag in a follow-up.         |

Response:

```json
{
  "sessionId": "<uuid>",
  "workspaceCwd": "/canonical/path",
  "attached": false
}
```

`attached: true` means a session for that workspace already existed and you're now sharing it.

Concurrent `POST /session` calls for the same workspace are **coalesced** to one spawn — both callers get the same `sessionId`, exactly one reports `attached: false`. If the underlying spawn fails (init timeout, malformed agent output, OOM), **all coalesced callers receive the same error** — the in-flight slot is cleared so a follow-up call can retry from scratch.

> ⚠️ **`modelServiceId` rejection on a fresh session is silent on the
> HTTP response.** A bad `modelServiceId` (typo, unconfigured service)
> does NOT 500 the create — the session stays operational on the
> agent's default model so the caller still gets a `sessionId` they
> can retry the model switch against (via `POST /session/:id/model`).
> The visible failure signal is a `model_switch_failed` event on the
> session's SSE stream, fired between the spawn handshake and your
> first subscribe. **Subscribers that need to observe this event
> should pass `Last-Event-ID: 0` on their first `GET
/session/:id/events`** to replay from the ring's oldest available
> event (covers the spawn-time `model_switch_failed` even if the
> subscribe lands a few ms after the create response).

### `POST /session/:id/load`

Restore a persisted ACP session by id and replay its history through SSE. The path id is authoritative; any `sessionId` field in the body is ignored. Pre-flight `caps.features.session_load` — older daemons return `404` for this route.

Request:

```json
{
  "cwd": "/absolute/path/to/workspace"
}
```

| Field | Required | Notes                                                                                                                                                                                                                                |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd` | no       | Same canonicalization + `workspace_mismatch` rules as `POST /session`. Omit to inherit `/capabilities.workspaceCwd`. `mcpServers` is intentionally NOT accepted here — daemon-wide MCP is settings-driven (matches `POST /session`). |

Response:

```json
{
  "sessionId": "persisted-1",
  "workspaceCwd": "/canonical/path",
  "attached": false,
  "state": {
    "models": { ... },
    "modes": { ... },
    "configOptions": [ ... ]
  }
}
```

`state` mirrors ACP's `LoadSessionResponse` — `models` is a `SessionModelState`, `modes` a `SessionModeState`, `configOptions` an array of `SessionConfigOption`. Missing fields are agent-decided. Late attachers (the `attached: true` paths below) get the SAME `state` snapshot the original load caller saw — the daemon caches it on the entry; runtime mutations (e.g. `model_switched`) are delivered on the SSE stream, not on subsequent attach responses.

`attached: true` means the session was already live (either from a prior `session/load`/`session/resume`, or because a coalesced concurrent caller raced just ahead).

**History replay over SSE.** While `loadSession` is in flight on the agent side, the agent emits `session_update` notifications for every persisted turn. The daemon buffers them onto the session's event-bus before the route response returns, so subscribers that immediately call `GET /session/:id/events` with `Last-Event-ID: 0` see the full replay. **The replay ring is bounded** (default 8000 frames per session). Long histories with many tool-call / thought-stream turns can exceed that — the oldest frames are dropped silently. Clients that need full history should subscribe immediately after `load` returns; alternatively they can persist the SSE event ids and use `Last-Event-ID` to resume from a later turn boundary.

**Errors:**

- `404` — persisted session id doesn't exist (`SessionNotFoundError`).
- `400` — `workspace_mismatch` (same shape as `POST /session`).
- `503` — `session_limit_exceeded` (counts against `--max-sessions`; in-flight restores are accounted for too).
- `409` — `restore_in_progress` (a `session/resume` for the same id is already in flight). `Retry-After: 5`. Same-action races (two concurrent `session/load` for the same id) coalesce — exactly one returns `attached: false`, the rest return `attached: true` with the same `state`.

### `POST /session/:id/resume`

Restore a persisted ACP session by id WITHOUT replaying history through SSE. The model context is restored internally on the agent side (via `geminiClient.initialize` reading `config.getResumedSessionData`); the SSE stream stays clean for clients that already have history rendered. Pre-flight `caps.features.session_resume`; `unstable_session_resume` remains a deprecated compatibility alias for older clients.

Same request shape as `/load`. Same response shape — `state` mirrors ACP's `ResumeSessionResponse`. Same error envelope, including `409 restore_in_progress` (which fires when a `session/load` is in flight; `session/resume` racing behind another `session/resume` coalesces).

Use `/load` when the client has no history rendered (cold reconnect, picker → open). Use `/resume` when the client already has the turns on screen and only needs the daemon-side handle back.

> ⚠️ **Why is `unstable_session_resume` still advertised?** The daemon's HTTP route and `session_resume` capability are stable for v1, but the bridge still calls ACP's `connection.unstable_resumeSession`. The old tag remains only so SDKs that shipped before `session_resume` can keep working.

### `GET /workspace/:id/sessions`

List all live sessions whose canonical workspace matches `:id` (URL-encoded absolute cwd).

```bash
curl http://127.0.0.1:4170/workspace/$(jq -rn --arg c "$PWD" '$c|@uri')/sessions
```

Response:

```json
{
  "sessions": [
    {
      "sessionId": "<uuid>",
      "workspaceCwd": "/canonical/path",
      "createdAt": "2026-05-17T08:30:00.000Z",
      "displayName": "My Session",
      "clientCount": 2,
      "hasActivePrompt": false
    }
  ]
}
```

Empty array (not 404) when no sessions exist — a session-picker UI shouldn't error just because the workspace is idle.

### `POST /session/:id/prompt`

Forward a prompt to the agent. Multi-prompt callers FIFO-queue per session (ACP guarantees one active prompt per session).

Request:

```json
{
  "prompt": [{ "type": "text", "text": "What does src/main.ts do?" }]
}
```

Validation: `prompt` must be a non-empty array of objects. Other failures return `400` before reaching the bridge.

Response:

```json
{ "stopReason": "end_turn" }
```

Other stop reasons: `cancelled`, `max_tokens`, `error`, `length` (per ACP spec).

If the HTTP client disconnects mid-prompt, the daemon sends an ACP `cancel` notification to the agent, which winds the prompt down with `stopReason: "cancelled"`.

> **Stage 1 limitation — no server-side prompt timeout.** The bridge
> only races the agent's `prompt()` against `transportClosedReject`
> (the agent child crashing) and the caller's HTTP-disconnect
> AbortSignal. A wedged-but-alive agent (e.g. a model call that
> hangs) blocks the per-session FIFO until the HTTP client times out
> on its end and disconnects. Long-running prompts are legitimate
> (deep research, large-codebase analysis) so a default deadline is
> deliberately not set; Stage 2 will expose a configurable
> `promptTimeoutMs` opt-in. Until then, callers should set their own
> client-side timeout and disconnect (or call
> `POST /session/:id/cancel`) on expiry.

### `POST /session/:id/cancel`

Cancel the **currently active** prompt on the session. ACP-side this is a notification, not a request — the agent acknowledges by resolving the active `prompt()` with `cancelled`.

```bash
curl -X POST http://127.0.0.1:4170/session/$SID/cancel
# → 204 No Content
```

> **Multi-prompt contract:** cancel only affects the active prompt. Any prompts the same client previously POSTed and are still queued behind the active one will continue to execute. Multi-prompt queueing is a daemon-introduced behavior (not in ACP spec); the contract for queued prompts is "they keep running unless you cancel each, or kill the session via channel exit".

### `DELETE /session/:id`

Explicitly close a live session. Force-closes even when other clients are attached — cancels any active prompt, resolves pending permissions as cancelled, publishes `session_closed` event, closes the EventBus, and removes the session from daemon maps. On-disk persisted sessions are NOT deleted — they can be reloaded via `POST /session/:id/load`. Pre-flight `caps.features.session_close`.

```bash
curl -X DELETE http://127.0.0.1:4170/session/$SID
# → 204 No Content
```

Idempotent: returns `404` for unknown sessions (same `SessionNotFoundError` shape as other routes).

> **`session_closed` event.** SSE subscribers receive a terminal `session_closed` event with `{ sessionId, reason: 'client_close', closedBy?: '<clientId>' }` before the stream ends. SDK reducers treat this identically to `session_died` (sets `alive: false`, clears `pendingPermissions`).

### `PATCH /session/:id/metadata`

Update mutable session metadata. Currently supports `displayName` only. Pre-flight `caps.features.session_metadata`.

Request:

```json
{ "displayName": "My Investigation Session" }
```

| Field         | Required | Notes                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `displayName` | no       | String, max 256 characters. Empty string clears the name. Omit to leave as-is. |

Response:

```json
{ "sessionId": "<uuid>", "displayName": "My Investigation Session" }
```

Publishes a `session_metadata_updated` event on the session's SSE stream with `{ sessionId, displayName }`.

### `POST /session/:id/heartbeat`

Bump the daemon's last-seen bookkeeping for this session. Long-lived adapters (TUI/IDE/web) ping this on an interval so future revocation policy (Wave 5 PR 24) can distinguish dead clients from quiet ones.

Headers:

| Header             | Required | Notes                                                                                                                                                                                                                                   |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Qwen-Client-Id` | no       | Echoes the daemon-issued id from `POST /session`. Identified clients also bump their per-client timestamp; anonymous heartbeats only bump the per-session watermark. Must satisfy the same `[A-Za-z0-9._:-]{1,128}` shape as elsewhere. |

Request body is empty (`{}` is fine — no fields are read today).

Response:

```json
{
  "sessionId": "<sid>",
  "clientId": "<cid>",
  "lastSeenAt": 1700000000123
}
```

`clientId` is echoed only when a trusted `X-Qwen-Client-Id` was supplied. `lastSeenAt` is the daemon-side `Date.now()` epoch (ms) the bridge stored.

Errors:

- `400` — `{ code: 'invalid_client_id' }` when the header is malformed (header-shape rule) or when it carries a `clientId` that isn't registered for this session (the bridge throws `InvalidClientIdError` before bumping any timestamp).
- `404` — unknown session.

Capability gating: pre-flight `caps.features.client_heartbeat`. Older daemons return `404` for this path.

### `POST /session/:id/model`

Switch the active model **within** the session's currently bound model service. Serialized through the per-session model-change queue.

(For switching the _service_ itself — Alibaba ModelStudio vs OpenRouter etc — pass `modelServiceId` on `POST /session` for a fresh session. Stage 1 has no live service-switch route.)

Request:

```json
{ "modelId": "qwen-staging" }
```

Response:

```json
{ "modelId": "qwen-staging" }
```

On success, publishes `model_switched` to the SSE stream. On failure, publishes `model_switch_failed` (so passive subscribers see the failure, not just the caller). Races against the agent channel exit so a wedged child can't block the HTTP handler.

### `POST /session/:id/recap`

Capability tag: `session_recap`. Bridge → ACP extMethod `qwen/control/session/recap`.

Generate a one-sentence "where did I leave off" summary of the session. Wraps core's `generateSessionRecap` (`packages/core/src/services/sessionRecap.ts`), which runs a side-query against the fast model with tools disabled, `maxOutputTokens: 300`, and a strict `<recap>...</recap>` output format. The side-query reads the session's existing GeminiClient chat history and does **not** add to it.

Request body is ignored (send `{}` or empty). Non-strict mutation gate — posture mirrors `/session/:id/prompt` (the call costs tokens but mutates no state). No SSE event is published.

Response (200):

```json
{
  "sessionId": "sess:42",
  "recap": "Debugging the auth retry race. Next: add deterministic timing to the integration test."
}
```

`recap` is `null` (a normal 200, not an error) when:

- the session has fewer than two dialog turns yet,
- the side-query returned no extractable `<recap>...</recap>` payload,
- or any underlying model error occurred (the core helper is best-effort and never throws).

Errors:

- `400 {code: 'invalid_client_id'}` — malformed `X-Qwen-Client-Id` header.
- `404` — session unknown.

Cancellation: **none in v1**. The route does not listen for HTTP client disconnect, no `AbortSignal` is plumbed into the bridge, and the ACP child runs the side-query to completion regardless of whether the caller has disconnected. The only ceilings are the bridge's 60s backstop timeout (`SESSION_RECAP_TIMEOUT_MS`) and the transport-closed race against ACP channel death. This is acceptable because recap is short (single-attempt, `maxOutputTokens: 300`, ~1–5s typical); a request-id-based cancel ext-method can plumb full end-to-end cancellation in a future release if the bandwidth cost ever justifies it.

### Mutation: approval, tools, init, MCP restart

Issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) Wave 4 PR 17 adds four mutation control routes that let remote clients change runtime posture without touching the daemon host's CLI. All four:

- Are gated by the **strict** mutation gate from PR 15. A daemon configured without a bearer token rejects them with `401 {code: 'token_required'}`. Configure `--token` (or `QWEN_SERVER_TOKEN`) before opting in.
- Accept and stamp the `X-Qwen-Client-Id` header (PR 7 audit chain). When the header carries a trusted id, the daemon emits `originatorClientId` on the corresponding SSE event so cross-client UIs can suppress echoes of their own mutations.
- Pre-flight each per-tag capability before exposing the affordance. Older daemons return `404` for the route.

Three of the four routes (`tools/:name/enable`, `init`, `mcp/:server/restart`) emit **workspace-scoped** events: every active session SSE bus receives the event, regardless of which session was attached when the mutation was triggered. `approval-mode` emits a **session-scoped** event because the change is local to one session's `Config`.

#### `POST /session/:id/approval-mode`

Capability tag: `session_approval_mode_control`. Bridge → ACP extMethod `qwen/control/session/approval_mode`.

Change the approval mode of a live session. The new mode lands inside the ACP child's per-session `Config` immediately. Settings are NOT written to disk by default — pass `persist: true` to also write `tools.approvalMode` to workspace settings.

Request:

```json
{ "mode": "auto-edit", "persist": false }
```

`mode` must be one of `'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo'` (mirror of core's `ApprovalMode` enum; the SDK exports `DAEMON_APPROVAL_MODES` for runtime validation). `persist` defaults to `false`.

Response (200):

```json
{
  "sessionId": "sess:42",
  "mode": "auto-edit",
  "previous": "default",
  "persisted": false
}
```

Errors:

- `400 {code: 'invalid_approval_mode', allowed: [...]}` — unknown mode literal.
- `400 {code: 'invalid_persist_flag'}` — `persist` is non-boolean.
- `403 {code: 'trust_gate', errorKind: 'auth_env_error'}` — the requested mode requires a trusted folder (privileged modes in untrusted workspaces are rejected by core's `Config.setApprovalMode`).
- `404` — session unknown.

SSE event (session-scoped): `approval_mode_changed` with `{sessionId, previous, next, persisted, originatorClientId?}`.

#### `POST /workspace/tools/:name/enable`

Capability tag: `workspace_tool_toggle`. Pure file IO — no ACP roundtrip.

Toggle a tool name in the workspace's `tools.disabled` settings list. Tools listed there are **not registered** at all (distinct from `permissions.deny`, which keeps the tool registered and rejects invocation). Both built-in tools and MCP-discovered tools flow through `ToolRegistry.registerTool`, which consults the disabled set.

> ⚠️ **Names must match the registry's exposed identifier exactly.** No alias resolution happens — the route stores whatever string is in the path parameter into `tools.disabled`, and the next ACP child compares against `tool.name` at register time. Built-ins use their canonical registry name (snake_case verb form): `run_shell_command`, `read_file`, `write_file`, `list_directory`, `glob`, `grep_search`, `web_fetch`, etc. — NOT the display labels (`Shell`, `Read`, `Write`) that the CLI surfaces. MCP-discovered tools use the qualified `mcp__<server>__<name>` form (which is also the form `tool_toggled` events broadcast and what `GET /workspace/mcp` lists). Disabling `Bash` will NOT prevent `run_shell_command` from registering on the next session.

Live ACP children retain already-registered tools — the toggle takes effect on the **next** ACP child spawn. Combine with `POST /workspace/mcp/:server/restart` (for MCP-sourced tools) or new-session creation to make the change effective in the current daemon.

Unknown tool names are accepted: pre-disabling a not-yet-installed MCP tool is a legitimate use case.

Request:

```json
{ "enabled": false }
```

Response (200):

```json
{ "toolName": "run_shell_command", "enabled": false }
```

Errors:

- `400 {code: 'invalid_tool_name'}` — empty path parameter, or path parameter exceeds the 256-character cap.
- `400 {code: 'invalid_enabled_flag'}` — `enabled` missing or non-boolean.

SSE event (workspace-scoped): `tool_toggled` with `{toolName, enabled, originatorClientId?}`.

#### `POST /workspace/init`

Capability tag: `workspace_init`. Pure file IO — no ACP roundtrip, **no LLM invocation**.

Scaffold an empty `QWEN.md` (or whatever `getCurrentGeminiMdFilename()` returns under `--memory-file-name` overrides) at the daemon's bound workspace root. Mechanical only — for AI-driven content fill, follow up with `POST /session/:id/prompt`.

Default refuses to overwrite when the target file exists with non-whitespace content. Whitespace-only files are treated as absent (matches the local `/init` slash command).

Request:

```json
{ "force": false }
```

Response (200):

```json
{ "path": "/work/bound/QWEN.md", "action": "created" }
```

`action` is `'created'` for fresh creates, `'noop'` when an existing whitespace-only file was left untouched (no write performed), and `'overwrote'` when `force: true` replaced non-empty content. The `workspace_initialized` SSE event mirrors the response action — observers can filter for `action !== 'noop'` to react only to actual on-disk changes.

Errors:

- `400 {code: 'invalid_force_flag'}` — `force` is non-boolean.
- `409 {code: 'workspace_init_conflict', path, existingSize}` — file exists with non-whitespace content and `force` is omitted/false. Body carries the absolute path and size (bytes) so SDK clients can render an "overwrite N bytes?" prompt without re-stat'ing.

SSE event (workspace-scoped): `workspace_initialized` with `{path, action, originatorClientId?}`.

#### `POST /workspace/mcp/:server/restart`

Capability tag: `workspace_mcp_restart`. Bridge → ACP extMethod `qwen/control/workspace/mcp/restart`.

Restart a configured MCP server through the ACP child's `McpClientManager.discoverMcpToolsForServer` (disconnect + reconnect + rediscover). Pre-checks the live budget snapshot from PR 14 v1's accounting so a restart on a budget-saturated workspace returns a soft refusal rather than triggering a `BudgetExhaustedError` cascade.

Request body is empty (`{}`). The path parameter is the URL-encoded server name as it appears in `mcpServers` config.

Response (200) — discriminated union on `restarted`:

```json
{ "serverName": "docs", "restarted": true, "durationMs": 1234 }
```

```json
{
  "serverName": "docs",
  "restarted": false,
  "skipped": true,
  "reason": "budget_would_exceed"
}
```

Soft skip reasons (all return 200):

| `reason`                | Meaning                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'in_flight'`           | Another discovery / restart for this server is already in progress. The route returns immediately rather than awaiting the original promise. Caller should retry after a short delay. |
| `'disabled'`            | Server is configured but listed in `excludedMcpServers`. Re-enable before restart.                                                                                                    |
| `'budget_would_exceed'` | Daemon is `--mcp-budget-mode=enforce`, the target server is not currently in `reservedSlots`, and the live total has reached `clientBudget`. Caller should free a slot first.         |

Errors (non-2xx):

- `400 {code: 'invalid_server_name'}` — empty path parameter.
- `404` — server name not in `mcpServers` config, or no live ACP channel exists (restart inherently requires a live `McpClientManager` instance).
- `500` — internal error (e.g. `ToolRegistry` not initialized).

SSE events (workspace-scoped): `mcp_server_restarted` with `{serverName, durationMs, originatorClientId?}` on success; `mcp_server_restart_refused` with `{serverName, reason, originatorClientId?}` on soft skip.

### `GET /session/:id/events` (SSE)

Subscribe to the session's event stream.

Headers:

```
Accept: text/event-stream
Last-Event-ID: 42        ← optional, replays from after id 42
```

Query params:

| Param       | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxQueued` | no       | Per-subscriber **live-backlog** cap. Range `[16, 2048]`, default 256. Replay frames force-pushed at subscribe time are exempt from the cap; what actually consumes it is live events that arrive while the subscriber is still draining a large `Last-Event-ID: 0` replay. Bump for cold reconnects so the live tail doesn't trip the slow-client warning / eviction before the consumer catches up. Out-of-range / non-decimal / present-but-empty values return `400 invalid_max_queued` before the SSE handshake opens. Pre-flight `caps.features.slow_client_warning` — old daemons silently ignore the param. |

Frame format. The `data:` line is the **full event envelope**, JSON-stringified on a single line — `{id?, v, type, data, originatorClientId?}`. The ACP-specific payload (`sessionUpdate`, `requestPermission` arguments, etc.) sits under the envelope's `data` field; the envelope's own `type` matches the SSE `event:` line.

```
id: 7
event: session_update
data: {"id":7,"v":1,"type":"session_update","data":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}}

id: 8
event: permission_request
data: {"id":8,"v":1,"type":"permission_request","data":{"requestId":"<uuid>","sessionId":"<sid>","toolCall":{...},"options":[...]}}

: heartbeat              ← every 15s, no payload

event: client_evicted    ← terminal frame, no id (synthetic)
data: {"v":1,"type":"client_evicted","data":{"reason":"queue_overflow","droppedAfter":42}}
```

The SSE-level `id:` / `event:` lines duplicate `envelope.id` / `envelope.type` for EventSource compatibility. Raw-`fetch` consumers (the SDK's `parseSseStream`) read everything off the JSON envelope and ignore the SSE preamble lines.

| Event type                | Trigger                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_update`          | Any ACP `sessionUpdate` notification (LLM chunks, tool calls, usage)                                                                                                                                                                                                                                                     |
| `permission_request`      | Agent asked for tool approval                                                                                                                                                                                                                                                                                            |
| `permission_resolved`     | Some client voted on a permission via `POST /permission/:requestId`                                                                                                                                                                                                                                                      |
| `permission_partial_vote` | (consensus only) A vote was recorded but quorum not yet reached. Carries `{requestId, sessionId, votesReceived, votesNeeded, quorum, optionTallies}`. Pre-flight `caps.features.permission_mediation`.                                                                                                                   |
| `permission_forbidden`    | A vote was rejected by the active policy (`designated` mismatch, `local-only` non-loopback, or `consensus` voter not in snapshot). Carries `{requestId, sessionId, clientId?, reason}`. Pre-flight `caps.features.permission_mediation`.                                                                                 |
| `model_switched`          | `POST /session/:id/model` succeeded                                                                                                                                                                                                                                                                                      |
| `model_switch_failed`     | `POST /session/:id/model` rejected                                                                                                                                                                                                                                                                                       |
| `session_died`            | Agent child crashed unexpectedly. **Terminal: SSE stream closes after this frame; the session is gone from `byId`.** Subscribers should reconnect via `POST /session` to spawn a fresh one.                                                                                                                              |
| `slow_client_warning`     | Subscriber-local: queue ≥ 75% full. **Non-terminal** — the stream continues; the warning is a heads-up before eviction. Carries `{queueSize, maxQueued, lastEventId}`. Fires ONCE per overflow episode; re-arms after the queue drains below 37.5%. No `id` (synthetic). Pre-flight `caps.features.slow_client_warning`. |
| `client_evicted`          | Subscriber-local: queue overflow. **Terminal: SSE stream closes after this frame** (no `id` — synthetic). Other subscribers on the same session continue.                                                                                                                                                                |
| `stream_error`            | Daemon-side error during fan-out. **Terminal: SSE stream closes after this frame** (no `id` — synthetic).                                                                                                                                                                                                                |

Reconnect semantics:

- Send `Last-Event-ID: <n>` to replay events with `id > n` from the per-session ring (default depth **8000**, tunable via `qwen serve --event-ring-size <n>`)
- **Gap detection (client-side):** if `<n>` predates the oldest event still in the ring (e.g. you reconnect with `Last-Event-ID: 50` but the ring now holds 200–1199), the daemon replays from the oldest available event without raising. Compare the first replayed event's `id` against `n + 1`; any difference is the size of the lost window. Stage 2 will inject an explicit `stream_gap` synthetic frame on the daemon side; in Stage 1 detection is the client's responsibility.
- IDs are monotonic per session, starting at 1
- Synthetic frames (`client_evicted`, `slow_client_warning`, `stream_error`) intentionally omit `id` so they don't burn a sequence slot for other subscribers

Backpressure:

- Per-subscriber queue defaults to `maxQueued: 256` live items (replay frames during reconnect bypass the cap). Override via `?maxQueued=N` (range `[16, 2048]`) on the SSE request.
- When a subscriber's queue crosses 75% full the bus force-pushes a `slow_client_warning` synthetic frame to that subscriber (once per overflow episode; re-armed after drain below 37.5%). The stream stays open — the warning is a heads-up so the client can drain faster or detach + reconnect cleanly.
- If the queue actually overflows the warning, the bus emits the `client_evicted` terminal frame and closes the subscription.

### `POST /permission/:requestId`

Cast a vote on a pending `permission_request`. The active **mediation policy** decides who wins:

| Policy                      | Behavior                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first-responder` (default) | Any validated voter wins; later voters get `404`. Pre-F3 baseline.                                                                                                                                    |
| `designated`                | Only the prompt originator (`originatorClientId`) decides; non-originators get `403 permission_forbidden / designated_mismatch`. Falls back to first-responder for anonymous prompts.                 |
| `consensus`                 | N-of-M voters must agree (default `N = floor(M/2) + 1`, override via `policy.consensusQuorum`). First option to reach `N` wins. Non-resolving votes get `200` + `permission_partial_vote` SSE frames. |
| `local-only`                | Only loopback voters decide; remote callers get `403 permission_forbidden / remote_not_allowed`.                                                                                                      |

The active policy is configured in `settings.json` under `policy.permissionStrategy` and surfaced on `/capabilities` at `body.policy.permission`. Pre-flight `caps.features.permission_mediation` (with `modes: [...]`) for the build-supported set.

> **F3 (#4175): multi-client permission coordination.** F3 added the four policies above. Pre-F3 daemons hardcoded first-responder; the wire shape stays bit-for-bit unchanged when the configured policy is `first-responder`. New events (`permission_partial_vote`, `permission_forbidden`) are additive — old SDKs see them as `unrecognized_known_event` and gracefully ignore.

> **Permission timeout (default 5 minutes).** A `permission_request`
> stays pending until: (a) some client votes here, (b) `POST /session/:id/cancel`
> fires, (c) the HTTP client driving the prompt disconnects
> (mid-prompt cancel resolves outstanding permissions as `cancelled`),
> (d) the session is killed, (e) the daemon shuts down, **or
> (f) the per-session permission timeout fires** (`DEFAULT_PERMISSION_TIMEOUT_MS`,
> 5 minutes). On timeout fire the agent's `requestPermission` resolves
> as `{outcome: 'cancelled'}`, the audit ring records a
> `permission.timeout` entry, daemon stderr emits a one-line
> breadcrumb, and the SSE bus fans out the standard
> `permission_resolved` cancelled frame so subscribers clean up. The
> timeout is configurable via `BridgeOptions.permissionResponseTimeoutMs`;
> headless callers running long-form prompts may want to extend it.

Request:

```json
{
  "outcome": {
    "outcome": "selected",
    "optionId": "proceed_once"
  }
}
```

Outcomes:

- `{ "outcome": "selected", "optionId": "<one-of-the-options>" }` — accept / reject / proceed-once / etc, per the agent's offered choices
- `{ "outcome": "cancelled" }` — drop the request (matches what `cancelSession` / `shutdown` do internally)

Response:

- `200 {}` — your vote was accepted (resolved OR recorded under consensus quorum)
- `403 { "code": "permission_forbidden", "reason": "designated_mismatch" | "remote_not_allowed", "requestId", "sessionId" }` — F3: the active policy rejected your vote
- `404 { "error": "..." }` — the requestId is unknown (already resolved, never existed, or session torn down)
- `500 { "code": "cancel_sentinel_collision", ... }` — F3: the agent's `allowedOptionIds` contains the reserved sentinel `'__cancelled__'`; agent / daemon contract violation
- `501 { "code": "permission_policy_not_implemented", "policy": "<name>" }` — F3 forward-compat: a policy literal landed in the schema but its mediator branch isn't built yet (currently unreachable; reserved for future policies)

After a successful vote, every connected client sees `permission_resolved` with the same `requestId` and the chosen `outcome`. Under `consensus`, intermediate votes additionally fan out `permission_partial_vote` until quorum.

### Auth device-flow routes (issue #4175 PR 21)

The daemon brokers an OAuth 2.0 Device Authorization Grant (RFC 8628) so a remote SDK client can trigger a login whose tokens land on the **daemon** filesystem — not on the client. The daemon polls the IdP itself; the client's only job is to display the verification URL + user code and (optionally) subscribe to SSE for completion events.

Capability tag: `auth_device_flow` (always advertised). Supported providers in v1: `qwen-oauth`.

**Runtime locality.** The daemon never spawns a browser — even if it can. The client decides whether to call `open(verificationUri)` locally; on a headless pod (the canonical Mode B deployment) the user opens the URL on whatever device they have a browser on. See `docs/users/qwen-serve.md` for the recommended UX.

**No token leakage in events.** `auth_device_flow_started` carries `{deviceFlowId, providerId, expiresAt}` only. The user code and verification URL come back point-to-point in the POST 201 body and via `GET /workspace/auth/device-flow/:id`; they are never broadcast on SSE.

**Per-provider singleton.** A second `POST` for the same provider while a flow is pending is an idempotent take-over — it returns the existing entry with `attached: true` rather than starting a fresh IdP request.

#### `POST /workspace/auth/device-flow`

Strict mutation gate: requires a bearer token even on token-less loopback defaults (`401 token_required`).

Request:

```json
{ "providerId": "qwen-oauth" }
```

Response (`201` fresh start, `200` idempotent take-over):

```json
{
  "deviceFlowId": "fa07c61b-…",
  "providerId": "qwen-oauth",
  "status": "pending",
  "userCode": "USER-1",
  "verificationUri": "https://chat.qwen.ai/api/v1/oauth2/device",
  "verificationUriComplete": "https://chat.qwen.ai/api/v1/oauth2/device?user_code=USER-1",
  "expiresAt": 1700000600000,
  "intervalMs": 5000,
  "attached": false
}
```

Errors:

- `400 unsupported_provider` — unknown `providerId` (response includes `supportedProviders`)
- `409 too_many_active_flows` — workspace cap (4) reached; cancel one with `DELETE`
- `401 token_required` — strict gate denied a token-less request
- `502 upstream_error` — IdP returned an unexpected error

#### `GET /workspace/auth/device-flow/:id`

Read the current state. Pending entries echo `userCode/verificationUri/expiresAt/intervalMs`; terminal entries (5-min grace) drop them and surface `status` + optional `errorKind/hint`.

Returns `404 device_flow_not_found` for unknown ids and post-grace evicted entries.

#### `DELETE /workspace/auth/device-flow/:id`

Idempotent cancel:

- pending entry → `204` + emit `auth_device_flow_cancelled`
- terminal entry → `204` no-op (no event re-emit)
- unknown id → `404`

#### `GET /workspace/auth/status`

Snapshot of pending flows + supported providers:

```json
{
  "v": 1,
  "workspaceCwd": "/work/bound",
  "providers": [],
  "pendingDeviceFlows": [
    {
      "deviceFlowId": "fa07c61b-…",
      "providerId": "qwen-oauth",
      "expiresAt": 1700000600000
    }
  ],
  "supportedDeviceFlowProviders": ["qwen-oauth"]
}
```

#### Device-flow SSE events

Five typed events (workspace-scoped, fanned out to every active session bus):

- `auth_device_flow_started` `{deviceFlowId, providerId, expiresAt}` — POST succeeded; SDK should subscribe (no userCode here, fetch via GET if needed)
- `auth_device_flow_throttled` `{deviceFlowId, intervalMs}` — daemon honored upstream `slow_down`; clients polling GET should bump their interval to match
- `auth_device_flow_authorized` `{deviceFlowId, providerId, expiresAt?, accountAlias?}` — credentials persisted; `accountAlias` is a non-PII label (never email/phone)
- `auth_device_flow_failed` `{deviceFlowId, errorKind, hint?}` — terminal; `errorKind` is one of `expired_token | access_denied | invalid_grant | upstream_error | persist_failed`. `persist_failed` is daemon-internal: the IdP exchange succeeded but the daemon couldn't durably store credentials (EACCES / EROFS / ENOSPC). The user should retry once the underlying disk condition is fixed.
- `auth_device_flow_cancelled` `{deviceFlowId}` — DELETE succeeded against a pending entry

> **Not MCP-compatible.** The MCP authorization spec (2025-06-18) mandates OAuth 2.1 + PKCE auth-code with a redirect callback, which doesn't work for headless-pod daemons. Mode B's device-flow surface is daemon-private — clients targeting MCP-compliant servers should use a different auth path.

## Streaming wire format

Events are emitted as standard EventSource frames. The daemon writes one `data:` line per frame (the JSON has no embedded newlines after `JSON.stringify`); the SDK parser at `packages/sdk-typescript/src/daemon/sse.ts` handles both that and the spec-allowed multi-`data:` form on the receive side.

## Error frames during streaming

If the bridge iterator throws while serving an SSE subscriber, the daemon emits a terminal `stream_error` frame (no `id`). The `data:` line is the full envelope (same shape as every other SSE frame in this doc); the actual error message lives under `envelope.data.error`:

```
event: stream_error
data: {"v":1,"type":"stream_error","data":{"error":"<message>"}}
```

The connection then closes.

## Environment variables

| Var                 | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `QWEN_SERVER_TOKEN` | Bearer token. Stripped of leading/trailing whitespace at boot. |

## Source layout

| Path                                                 | Purpose                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/commands/serve.ts`                 | yargs command + flag schema                                                                                |
| `packages/cli/src/serve/run-qwen-serve.ts`           | listener lifecycle + signal handling                                                                       |
| `packages/cli/src/serve/server.ts`                   | Express routes + middleware                                                                                |
| `packages/cli/src/serve/auth.ts`                     | bearer + Host allowlist + CORS deny                                                                        |
| `packages/cli/src/serve/httpAcpBridge.ts`            | spawn-or-attach + per-session FIFO + permission registry                                                   |
| `packages/cli/src/serve/status.ts`                   | read-only daemon status wire types + `ServeErrorKind` + `BridgeTimeoutError` + `mapDomainErrorToErrorKind` |
| `packages/cli/src/serve/env-snapshot.ts`             | pure helper that builds `/workspace/env` payloads from `process.*` state, including credential redaction   |
| `packages/acp-bridge/src/eventBus.ts`                | bounded async queue + replay ring                                                                          |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | TS client                                                                                                  |
| `packages/sdk-typescript/src/daemon/sse.ts`          | EventSource frame parser                                                                                   |
| `integration-tests/cli/qwen-serve-routes.test.ts`    | 18 cases, no LLM                                                                                           |
| `integration-tests/cli/qwen-serve-streaming.test.ts` | 3 cases, real `qwen --acp` child backed by the local fake OpenAI server (POSIX only; skipped on Windows)   |
