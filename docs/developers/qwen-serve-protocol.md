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
 'session_load', 'unstable_session_resume',
 'session_list', 'session_prompt', 'session_cancel', 'session_events',
 'slow_client_warning', 'typed_event_schema',
 'session_set_model', 'client_identity', 'client_heartbeat',
 'session_permission_vote', 'permission_vote', 'workspace_mcp', 'workspace_skills',
 'workspace_providers', 'session_context', 'session_supported_commands',
 'session_close', 'session_metadata', 'mcp_guardrails']
```

`session_scope_override` is the negotiation handle for the per-request `sessionScope` field on `POST /session` (see below). Older daemons silently ignore the field, so SDK clients should pre-flight `caps.features` for this tag before sending it.

`session_load` and `unstable_session_resume` advertise the explicit-restore routes (`POST /session/:id/load` and `POST /session/:id/resume`). Older daemons return `404` for these paths, so SDK clients should pre-flight `caps.features` before calling. The `unstable_` prefix on `unstable_session_resume` mirrors the underlying ACP method (`connection.unstable_resumeSession`) — the daemon's wire shape is committed for v1, but the ACP method name itself may change before ACP marks resume stable.

`slow_client_warning` covers two co-released SSE backpressure knobs introduced in #4175 Wave 2.5 PR 10: (a) the daemon emits a `slow_client_warning` synthetic event-stream frame when a subscriber's queue crosses 75% full, once per overflow episode (rearmed after the queue drains below 37.5%); (b) `GET /session/:id/events` accepts a `?maxQueued=N` query param (range `[16, 2048]`) to pre-size the per-subscriber backlog for cold reconnects against a large replay ring. The daemon-wide ring size is controlled by `--event-ring-size` (default **8000**, per #3803 §02). Old daemons silently lack both — pre-flight this tag before opting in.

`typed_event_schema` advertises daemon event payloads that match the SDK's `KnownDaemonEvent` schema. Older daemons may still stream compatible frames, but SDK clients should pre-flight this tag before assuming typed event coverage.

`client_heartbeat` advertises `POST /session/:id/heartbeat`. Older daemons return `404`; pre-flight this tag before issuing periodic heartbeats.

`session_close` and `session_metadata` advertise `DELETE /session/:id` and `PATCH /session/:id/metadata`. Older daemons return `404`; pre-flight these tags before exposing close or rename affordances.

`mcp_guardrails` (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14) covers the MCP budget surface: the `clientCount` / `clientBudget` / `budgetMode` / `budgets[]` fields on `GET /workspace/mcp`, the `disabledReason` field on per-server cells, and the `--mcp-client-budget` / `--mcp-budget-mode` CLI flags. Older daemons omit the new fields entirely; SDK clients pre-flight this tag before relying on `budgets[]` semantics. The registry descriptor also carries `modes: ['warn', 'enforce']` for future feature-modes exposure — for now, clients infer mode from the snapshot's `budgetMode` field. Server refusal under `enforce` mode is deterministic by `Object.entries(mcpServers)` declaration order; a future scope-precedence layer (if qwen-code adopts one) would shift this to "lowest-precedence first" to mirror claude-code's `plugin < user < project < local` convention.

> ⚠️ **PR 14 v1 scope: per-session, not per-workspace.** Each ACP session inside the daemon constructs its own `Config` + `McpClientManager` (via `acpAgent.newSessionConfig`). The budget caps live MCP clients **per session**; each session independently reads `QWEN_SERVE_MCP_CLIENT_BUDGET` from the forwarded env. With `--mcp-client-budget=10` and 5 concurrent ACP sessions, the actual live MCP client count can reach 5 × 10 = 50 across the daemon. The `GET /workspace/mcp` snapshot reads the **bootstrap session's** `McpClientManager` accounting only — the `budgets[0].scope: 'session'` value is the honest signal that this is per-session, not aggregated. **Wave 5 PR 23 (shared MCP pool)** will introduce a workspace-scoped manager and add a `scope: 'workspace'` cell alongside the per-session cell for true cross-session aggregation. v1 is the in-process counter + soft enforcement foundation that PR 23 builds on.

**Conditional tags.** A small number of feature tags are advertised only when the matching deployment toggle is on. Tag presence = behavior is on; absence = either an older daemon predating the tag, OR a current daemon where the operator did not opt in. Currently:

| Tag            | Advertised when …                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require_auth` | the daemon was started with `--require-auth` (or `requireAuth: true` via the embedded API). Bearer token is mandatory on every route, including `/health` on loopback binds. |

`mcp_guardrails` is **not** in this conditional table — it's an always-on tag, advertised whenever the binary supports the new `/workspace/mcp` budget fields, regardless of whether the operator configured a budget. Operators who haven't set `--mcp-client-budget` still get the new fields (with `budgetMode: 'off'`, `budgets: []`).

## Routes

### `GET /health`

Liveness probe. Default form returns `200 {"status":"ok"}` if the listener is up — cheap, no bridge access, suitable for high-frequency k8s/Compose liveness probes.

Pass `?deep=1` (also accepts `?deep=true` or bare `?deep`) for a probe that exposes bridge **counters** (informational only, not a true liveness check):

```json
{ "status": "ok", "sessions": 3, "pendingPermissions": 1 }
```

> ⚠️ The deep probe is **informational**, not a real liveness verification. It reads counter accessors (`bridge.sessionCount`, `bridge.pendingPermissionCount`) which are simple Map-size getters; they don't ping individual child processes / channels and so won't detect a wedged-but-still-counted session. Use it for capacity dashboards (current concurrency vs. `--max-sessions`, queue depth) rather than as the trigger for "pull this daemon out of rotation". A `503 {"status":"degraded"}` response is theoretically possible if a custom bridge implementation's getters throw, but the real bridge's getters never do — under normal operation the deep probe always returns 200. For real liveness, rely on whether the listener accepts a TCP connection at all (i.e. the default `/health` without `?deep`).

**Auth:** required **only on non-loopback binds**. On loopback (`127.0.0.1`, `::1`, `[::1]`) `/health` is registered before the bearer middleware so k8s/Compose probes inside the pod don't need to carry the token. On non-loopback (`--hostname 0.0.0.0` etc.) the route is registered after the bearer middleware and returns 401 without a valid token — otherwise an unauthenticated caller could probe arbitrary addresses to confirm a `qwen serve` exists, a low-severity info leak that combines poorly with port scanning. CORS deny + Host allowlist still apply on the loopback exemption.

### `GET /capabilities`

```json
{
  "v": 1,
  "protocolVersions": {
    "current": "v1",
    "supported": ["v1"]
  },
  "mode": "http-bridge",
  "features": ["health", "capabilities", "..."],
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
- `session_context` → `GET /session/:id/context`
- `session_supported_commands` → `GET /session/:id/supported-commands`

Common status cell:

```ts
type DaemonStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'not_started'
  | 'unknown';

interface DaemonStatusCell {
  kind: string;
  status: DaemonStatus;
  error?: string;
  errorKind?: string;
  hint?: string;
}
```

Status payloads never expose MCP env values, headers, OAuth/service-account
details, provider API keys, provider `baseUrl` / `envKey`, skill body, skill
filesystem paths, or hook definitions.

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

**Detecting budget pressure in v1 (no push events yet).** PR 14 v1 is snapshot-only — typed SSE push events (`mcp_budget_warning` + `mcp_child_refused_batch`) ship in PR 14b. Until then, operator dashboards poll `GET /workspace/mcp` and inspect the per-session budget cell (`budgets[0]`):

- `budgets[0].status === 'warning'` ⇔ `liveCount >= 0.75 * clientBudget` (matches the hysteresis threshold PR 14b's push event will use).
- `budgets[0].status === 'error'` ⇔ `refusedCount > 0` (one or more servers refused this discovery pass).
- `budgets[0].status === 'ok'` ⇔ below the 75% threshold AND no refusals.

Recommended poll cadence: aligned with whatever already polls `/workspace/mcp`; the snapshot is cheap and the budget cell carries no extra discovery cost.

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

Models are grouped by auth type. Provider connection diagnostics and environment
preflight checks are intentionally out of scope here; deeper preflight/env
checks belong to a later daemon status wave. `errors` is omitted when snapshot
construction succeeds.

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

**History replay over SSE.** While `loadSession` is in flight on the agent side, the agent emits `session_update` notifications for every persisted turn. The daemon buffers them onto the session's event-bus before the route response returns, so subscribers that immediately call `GET /session/:id/events` with `Last-Event-ID: 0` see the full replay. **The replay ring is bounded** (default 4000 frames per session). Long histories with many tool-call / thought-stream turns can exceed that — the oldest frames are dropped silently. Clients that need full history should subscribe immediately after `load` returns; alternatively they can persist the SSE event ids and use `Last-Event-ID` to resume from a later turn boundary.

**Errors:**

- `404` — persisted session id doesn't exist (`SessionNotFoundError`).
- `400` — `workspace_mismatch` (same shape as `POST /session`).
- `503` — `session_limit_exceeded` (counts against `--max-sessions`; in-flight restores are accounted for too).
- `409` — `restore_in_progress` (a `session/resume` for the same id is already in flight). `Retry-After: 5`. Same-action races (two concurrent `session/load` for the same id) coalesce — exactly one returns `attached: false`, the rest return `attached: true` with the same `state`.

### `POST /session/:id/resume`

Restore a persisted ACP session by id WITHOUT replaying history through SSE. The model context is restored internally on the agent side (via `geminiClient.initialize` reading `config.getResumedSessionData`); the SSE stream stays clean for clients that already have history rendered. Pre-flight `caps.features.unstable_session_resume`.

Same request shape as `/load`. Same response shape — `state` mirrors ACP's `ResumeSessionResponse`. Same error envelope, including `409 restore_in_progress` (which fires when a `session/load` is in flight; `session/resume` racing behind another `session/resume` coalesces).

Use `/load` when the client has no history rendered (cold reconnect, picker → open). Use `/resume` when the client already has the turns on screen and only needs the daemon-side handle back.

> ⚠️ **Why `unstable_` on the capability tag?** The route is wire-stable for the daemon's v1, but it's backed by ACP's `connection.unstable_resumeSession` which is still subject to ACP-side breaking changes. The daemon insulates the wire shape from those changes; the prefix is a courtesy signal so SDK consumers know the underlying agent contract is not yet locked.

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

| Event type            | Trigger                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_update`      | Any ACP `sessionUpdate` notification (LLM chunks, tool calls, usage)                                                                                                                                                                                                                                                     |
| `permission_request`  | Agent asked for tool approval                                                                                                                                                                                                                                                                                            |
| `permission_resolved` | Some client voted on a permission via `POST /permission/:requestId`                                                                                                                                                                                                                                                      |
| `model_switched`      | `POST /session/:id/model` succeeded                                                                                                                                                                                                                                                                                      |
| `model_switch_failed` | `POST /session/:id/model` rejected                                                                                                                                                                                                                                                                                       |
| `session_died`        | Agent child crashed unexpectedly. **Terminal: SSE stream closes after this frame; the session is gone from `byId`.** Subscribers should reconnect via `POST /session` to spawn a fresh one.                                                                                                                              |
| `slow_client_warning` | Subscriber-local: queue ≥ 75% full. **Non-terminal** — the stream continues; the warning is a heads-up before eviction. Carries `{queueSize, maxQueued, lastEventId}`. Fires ONCE per overflow episode; re-arms after the queue drains below 37.5%. No `id` (synthetic). Pre-flight `caps.features.slow_client_warning`. |
| `client_evicted`      | Subscriber-local: queue overflow. **Terminal: SSE stream closes after this frame** (no `id` — synthetic). Other subscribers on the same session continue.                                                                                                                                                                |
| `stream_error`        | Daemon-side error during fan-out. **Terminal: SSE stream closes after this frame** (no `id` — synthetic).                                                                                                                                                                                                                |

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

Cast a vote on a pending `permission_request`. **First responder wins** — once one client answers, every other client trying to answer the same id gets `404`.

> **Stage 1 limitation — no permission timeout.** A `permission_request`
> stays pending until: (a) some client votes here, (b) `POST /session/:id/cancel`
> fires, (c) the HTTP client driving the prompt
> disconnects (mid-prompt cancel resolves outstanding permissions as
> `cancelled`), (d) the session is killed, or (e) the daemon shuts
> down. **In a fully-headless deployment with no SSE subscriber,
> `requestPermission` blocks the agent indefinitely** — there's nothing
> to time out the wait. Stage 2 will add a configurable
> `permissionTimeoutMs`. Until then, headless callers should keep an
> SSE subscription open or wrap their prompt loop in their own timeout
>
> - `POST /session/:id/cancel` on expiry.

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

- `200 {}` — your vote was accepted
- `404 { "error": "..." }` — the requestId is unknown (already resolved, never existed, or session torn down)

After a successful vote, every connected client sees `permission_resolved` with the same `requestId` and the chosen `outcome`.

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

| Var                 | Purpose                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QWEN_SERVER_TOKEN` | Bearer token. Stripped of leading/trailing whitespace at boot.                                                                                                      |
| `SKIP_LLM_TESTS`    | Set to `1` to **skip** LLM-required integration tests in `integration-tests/cli/qwen-serve-streaming.test.ts` (default-on for CI envs that lack provider API keys). |

## Source layout

| Path                                                 | Purpose                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/cli/src/commands/serve.ts`                 | yargs command + flag schema                                        |
| `packages/cli/src/serve/runQwenServe.ts`             | listener lifecycle + signal handling                               |
| `packages/cli/src/serve/server.ts`                   | Express routes + middleware                                        |
| `packages/cli/src/serve/auth.ts`                     | bearer + Host allowlist + CORS deny                                |
| `packages/cli/src/serve/httpAcpBridge.ts`            | spawn-or-attach + per-session FIFO + permission registry           |
| `packages/cli/src/serve/status.ts`                   | read-only daemon status wire types + ACP ext method names          |
| `packages/cli/src/serve/eventBus.ts`                 | bounded async queue + replay ring                                  |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | TS client                                                          |
| `packages/sdk-typescript/src/daemon/sse.ts`          | EventSource frame parser                                           |
| `integration-tests/cli/qwen-serve-routes.test.ts`    | 18 cases, no LLM                                                   |
| `integration-tests/cli/qwen-serve-streaming.test.ts` | 3 cases, real `qwen --acp` child (skipped when `SKIP_LLM_TESTS=1`) |
