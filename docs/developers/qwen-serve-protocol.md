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

`WorkspaceMismatchError` for a `POST /session` whose `cwd` doesn't canonicalize to a registered workspace returns `400` with:

```json
{
  "error": "Workspace mismatch: daemon is bound to \"…\"",
  "code": "workspace_mismatch",
  "boundWorkspace": "/path/the/daemon/uses/as-primary",
  "requestedWorkspace": "/path/in/the/request"
}
```

Use this to detect mismatch pre-flight: read `workspaceCwd` off `/capabilities` and omit `cwd` from `POST /session` (it falls back to the primary workspace), or when `multi_workspace_sessions` is advertised choose one of `workspaces[].cwd`.

`POST /session` past the daemon's `--max-sessions` cap returns `503` with a `Retry-After: 5` header and:

```json
{
  "error": "Session limit reached (20)",
  "code": "session_limit_exceeded",
  "limit": 20,
  "scope": "workspace"
}
```

When `--max-total-sessions` rejects a fresh session, the same response shape is returned with `"scope": "total"`.

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

`SessionWorkspaceConflictError` — emitted by `POST /session/:id/load` and `POST /session/:id/resume` when the requested `cwd` targets one registered workspace but the same session id is already live or being restored by another runtime — returns `409` with:

```json
{
  "error": "Session \"<sid>\" is already live or restoring in another workspace runtime.",
  "code": "session_workspace_conflict",
  "sessionId": "<sid>",
  "workspaceCwd": "/requested/workspace",
  "workspaceId": "requested-workspace-id",
  "liveWorkspaceCwd": "/live/owner/workspace",
  "liveWorkspaceId": "live-owner-workspace-id"
}
```

Clients should retry with the owning workspace or wait for the in-flight restore to finish before restoring the id into a different workspace. Same-workspace restore races continue to use the bridge's `restore_in_progress` / coalescing behavior.

`SessionArchivedError` is emitted when a caller tries to load or resume a session whose JSONL is under `chats/archive/`:

```json
{
  "error": "Session \"<sid>\" is archived. Unarchive it before loading.",
  "code": "session_archived",
  "sessionId": "<sid>"
}
```

with status `409`.

`SessionArchivingError` is emitted when a session archive or unarchive transition is already in flight for the same id:

```json
{
  "error": "Session \"<sid>\" is being archived or unarchived; retry later.",
  "code": "session_archiving",
  "sessionId": "<sid>"
}
```

with status `409` and `Retry-After: 5`.

## Capabilities

The daemon advertises its supported feature tags from the serve capability
registry. Clients **must** gate UI off `features`, not off `mode` (per design
§10).

```
['health', 'capabilities', 'session_create', 'session_scope_override',
 'session_load', 'session_resume', 'session_transcript',
 'unstable_session_resume',
 'session_list', 'session_info', 'session_prompt', 'session_cancel', 'session_events',
 'slow_client_warning', 'typed_event_schema',
 'session_set_model', 'client_identity', 'client_heartbeat',
 'session_permission_vote', 'permission_vote', 'workspace_mcp', 'workspace_skills',
 'workspace_providers', 'workspace_acp_preheat', 'workspace_acp_status',
 'auth_provider_install', 'workspace_memory',
 'workspace_agents', 'workspace_agent_generate', 'workspace_env',
 'workspace_preflight', 'session_context', 'session_context_usage',
 'session_supported_commands', 'session_tasks', 'session_stats',
 'session_lsp', 'session_status',
 'session_close', 'session_metadata', 'session_organization',
 'session_archive', 'mcp_guardrails',
 'workspace_mcp_manage', 'mcp_guardrail_events',
 'mcp_server_runtime_mutation',
 'workspace_file_read', 'workspace_file_bytes', 'workspace_file_write',
 'session_approval_mode_control', 'workspace_tool_toggle', 'workspace_skill_toggle',
 'workspace_settings', 'workspace_init', 'workspace_mcp_restart',
 'session_recap', 'session_generation', 'session_btw', 'session_shell_command',
 'mcp_workspace_pool', 'mcp_pool_restart',
 'require_auth', 'allow_origin', 'auth_device_flow',
 'permission_mediation', 'prompt_absolute_deadline', 'writer_idle_timeout',
 'non_blocking_prompt', 'session_language', 'session_rewind',
 'workspace_hooks', 'session_hooks', 'workspace_extensions',
 'session_branch', 'rate_limit', 'workspace_reload',
 'multi_workspace_sessions', 'multi_workspace_session_rewind',
 'multi_workspace_session_shell', 'persistent_workspace_registration',
 'workspace_display_name',
 'workspace_qualified_rest_core', 'workspace_qualified_voice',
 'extension_management_v2', 'workspace_persisted_transcript',
 'workspace_session_export', 'workspace_archived_session_export',
 'client_mcp_over_ws', 'cdp_tunnel_over_ws', 'browser_automation_mcp']
```

> Conditional tags appear only when their matching deployment toggle is on (see the table below). F3's `permission_mediation` tag is always-on and carries `modes: ['first-responder', 'designated', 'consensus', 'local-only']` so SDK clients can introspect the build-supported set; the runtime-active strategy is at `body.policy.permission`.

`session_scope_override` is the negotiation handle for the per-request `sessionScope` field on `POST /session` (see below). Older daemons silently ignore the field, so SDK clients should pre-flight `caps.features` for this tag before sending it.

`persistent_workspace_registration` advertises durable registration for workspaces added at runtime. `POST /workspaces` accepts `{ "cwd": "/absolute/path", "persist": true }`; success includes `persisted: true`. Registrations are scoped to the daemon's canonical primary workspace under the user's Qwen home and are restored on the next daemon start. Omitting `persist` preserves process-local registration. `GET /workspace-registrations` lists the stored desired set, and `DELETE /workspace-registrations/:id` forgets an entry for the next restart without hot-removing an active runtime.

`workspace_display_name` advertises optional `displayName` input on `POST /workspaces`, workspace metadata updates through `PATCH /workspaces/:workspace`, and optional display-name fields in workspace projections. Names do not participate in lookup or routing: `id` and canonical `cwd` remain the only selectors, and duplicate names are allowed.

`workspace_runtime_removal` advertises synchronous hot removal through `DELETE /workspaces/:workspace`. Capability workspace entries add optional `removable`; only rows with `removable: true` may be removed. Removal also forgets every persistent registration alias for the runtime, but never deletes files, settings, transcripts, or archives.

`session_load` and `session_resume` advertise the explicit-restore routes (`POST /session/:id/load` and `POST /session/:id/resume`). Older daemons return `404` for these paths, so SDK clients should pre-flight `caps.features` before calling. `unstable_session_resume` is still advertised as a deprecated alias for compatibility with SDKs that shipped while the underlying ACP method was named `connection.unstable_resumeSession`; new clients should gate on `session_resume`.

`session_transcript` advertises `GET /session/:id/transcript`, a read-only paged replay view over the persisted active-session JSONL. It is separate from `/load`: it does not attach a client, seed the live EventBus, create a live session, or change the live replay window. Clients should use it when they need the complete on-disk transcript for a long session, and continue using `/load` only for bounded live replay during cold UI restore.

`workspace_persisted_transcript` advertises `GET /workspaces/:workspace/session/:id/transcript`, a daemon-local persisted-only pager that does not start ACP, query live bridge state, load settings, discover project capabilities, or create the legacy persisted cursor key. The tag is unconditional because trusted single-workspace primaries can use the plural route; per-workspace trust authorization is still evaluated on every request. Registered untrusted secondary workspaces may read, while an untrusted primary remains rejected.

`workspace_session_export` advertises `GET /workspaces/:workspace/session/:id/export`, a trusted-only full export of the selected workspace's active persisted session. It is independent of `session_export` and `workspace_qualified_rest_core`: released daemons can advertise both older tags without implementing the plural route, so clients must pre-flight this tag directly. The tag is unconditional because a trusted single-workspace primary can use the route by id or cwd. The export does not resolve a live owner, start ACP, attach a client, or fall back to another workspace.

`workspace_archived_session_export` advertises `GET /workspaces/:workspace/session/:id/archive/export`, a trusted-only full export from the selected workspace's archived persisted storage. It is independent of `workspace_session_export` and `workspace_qualified_rest_core`; clients must pre-flight this tag directly. A distinct route prevents an older daemon from ignoring archive intent and returning an active transcript with the same id.

`slow_client_warning` covers SSE backpressure behavior: (a) the daemon emits a `slow_client_warning` synthetic event-stream frame when a subscriber's live frame backlog or live serialized-byte backlog crosses 75% full, once per overflow episode (rearmed after both measurements drain below 37.5%); (b) `GET /session/:id/events` accepts a `?maxQueued=N` query param (range `[16, 2048]`) to pre-size the per-subscriber frame backlog for cold reconnects against a large replay ring. The serialized-byte cap is daemon-owned (default **2 MiB** per subscriber), live-only, and intentionally has no query parameter. The daemon-wide ring size is controlled by `--event-ring-size` (default **8000**, per #3803 §02). Old daemons silently lack the warning/query behavior — pre-flight this tag before opting in.

`typed_event_schema` advertises daemon event payloads that match the SDK's `KnownDaemonEvent` schema. Older daemons may still stream compatible frames, but SDK clients should pre-flight this tag before assuming typed event coverage.

`client_heartbeat` advertises `POST /session/:id/heartbeat`. Older daemons return `404`; pre-flight this tag before issuing periodic heartbeats.

`session_close` and `session_metadata` advertise `DELETE /session/:id` and `PATCH /session/:id/metadata`. Older daemons return `404`; pre-flight these tags before exposing close or rename affordances.

`session_organization` advertises custom session groups and pinning. It adds `GET/POST/PATCH/DELETE /workspace/:id/session-groups`, `PATCH /session/:id/organization`, and the opt-in organized list view `GET /workspace/:id/sessions?view=organized`. When both `session_organization` and `workspace_qualified_rest_core` are advertised, the workspace-qualified organization mutation `PATCH /workspaces/:workspace/session/:id/organization` is also available. The legacy mutation remains primary-workspace-only. Older daemons return `404` for the mutation/group routes and ignore the organized view contract, so WebShell/SDK clients must pre-flight these tags before showing the matching grouping or pinning UI.

`session_archive` advertises the v1 directory-state archive API: `POST /sessions/archive`, `POST /sessions/unarchive`, and `GET /workspace/:id/sessions?archiveState=active|archived`. Archived sessions cannot be loaded or resumed until they are unarchived.

`workspace_qualified_rest_core` advertises plural core REST routes under `/workspaces/:workspace/...`. The selector resolves as exact workspace id first, then as a URL-encoded absolute cwd after canonicalization. Newer single-workspace daemons include the primary runtime in `workspaces[]` even when `multi_workspace_sessions` is absent, allowing clients to discover the id required by workspace-qualified routes; clients should fall back to `capabilities.workspaceCwd` for older daemons that omit the array. Trust status and trust request routes are available for registered untrusted workspaces; file read routes follow the existing filesystem read policy. Registered untrusted secondary workspaces also expose persisted-only session and session-group catalogs: these reads do not attach to a session, start ACP, or merge live bridge state. File writes, catalog mutations, and other plural core routes require a trusted workspace unless a separate capability explicitly defines a narrower read-only policy, such as `workspace_persisted_transcript`. An untrusted primary continues to receive `403 { code: "untrusted_workspace" }` from the plural catalog and transcript routes; legacy singular primary routes keep their existing compatibility behavior. This tag covers the core file, status, settings, permissions, trust, lifecycle, MCP control, tool and skill toggles, memory, workspace agent CRUD, and session storage surfaces. It does not cover auth, voice, extensions, ACP/WebSocket transport, channel-worker routing, or workspace-qualified session export; pre-flight `workspace_session_export` or `workspace_archived_session_export` separately. Workspace trust is not an ACL: a client holding the daemon token can read every registered workspace surface allowed by this policy.

`workspace_qualified_voice` advertises Voice routes selected by a trusted workspace runtime: `GET` and `POST /workspaces/:workspace/voice`, `POST /workspaces/:workspace/voice/transcribe`, and `WS /workspaces/:workspace/voice/stream`. It is advertised only when multi-workspace runtimes and the shared ACP/Voice WebSocket listener are both enabled. The selector follows the same id-or-encoded-absolute-cwd rules as other plural routes. For REST, an unknown selector returns `400 { code: "workspace_mismatch" }` and an untrusted selector returns `403 { code: "untrusted_workspace" }`; WebSocket upgrade rejection exposes the corresponding HTTP 400/403 status without a structured JSON envelope. Neither transport falls back to primary. Legacy `/workspace/voice`, `/workspace/voice/transcribe`, and `/voice/stream` remain primary-only. Clients use `workspace_qualified_voice` for all qualified Voice modalities and let the selected runtime report configuration-specific errors. The legacy `workspace_voice`, `workspace_voice_transcription`, and `voice_transcribe` tags describe only the primary-bound routes and must not hide a qualified secondary configuration.

`session_lsp` advertises `GET /session/:id/lsp`, the read-only structured LSP status snapshot for daemon clients. Older daemons return `404`; pre-flight this tag before exposing remote LSP status.

`session_status` advertises `GET /session/:id/status`, the live bridge summary for a single session by id. In addition to `clientCount` and `hasActivePrompt`, live sessions expose `isWaitingForPermission`, `isWaitingForUserQuestion`, `pendingInteractionCount`, and a retained `turnError` after a failed turn. The error clears when the next prompt actually starts. Both the single-session status response and workspace session lists include `turnError` and `pendingInteractions`: render-ready permission actions or `ask_user_question` questions plus the `requestId` and selectable options required by the existing permission vote routes. Each user question has an `answerKey`; vote with `answers`, for example `{ "0": "Polling" }`, keyed by that value. Persisted-only sessions omit runtime state because no runtime exists. Older daemons return `404`; pre-flight this tag before polling a single session's status instead of scanning the full session list.

`session_info` advertises `GET /workspace/:id/session-info` and its `/workspaces/:workspace/session-info` twin. The response aggregates persisted active and archived session counts without hydrating list metadata. It is an explicit O(n) disk scan and must not be polled; clients should treat `truncated: true` as a lower-bound result.

`session_approval_mode_control`, `workspace_tool_toggle`, `workspace_skill_toggle`, `workspace_init`, and `workspace_mcp_restart` advertise the mutation control routes documented below. They are strict-gated by the mutation gate (a daemon configured without a bearer token rejects them with 401 `token_required`). Older daemons return `404`; pre-flight each tag before exposing the corresponding affordance.

`mcp_guardrails` (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14) covers the MCP budget surface: the `clientCount` / `clientBudget` / `budgetMode` / `budgets[]` fields on `GET /workspace/mcp`, the `disabledReason` field on per-server cells, and the `--mcp-client-budget` / `--mcp-budget-mode` CLI flags. Older daemons omit the new fields entirely; SDK clients pre-flight this tag before relying on `budgets[]` semantics. The registry descriptor also carries `modes: ['warn', 'enforce']` for future feature-modes exposure — for now, clients infer mode from the snapshot's `budgetMode` field. Server refusal under `enforce` mode is deterministic by `Object.entries(mcpServers)` declaration order; a future scope-precedence layer (if qwen-code adopts one) would shift this to "lowest-precedence first" to mirror claude-code's `plugin < user < project < local` convention.

> **Scope is capability-driven.** With `mcp_workspace_pool`, sessions inside one workspace runtime share a transport pool and `WorkspaceMcpBudget`, and the snapshot emits `budgets[0].scope: 'workspace'`. Different workspace runtimes own independent pools. Without the tag, each ACP session uses its legacy `McpClientManager`, the snapshot emits `scope: 'session'`, and N sessions may each consume the configured cap.

`workspace_file_read` covers the text/list/stat/glob workspace file routes
(`GET /file`, `GET /list`, `GET /glob`, `GET /stat`). `workspace_file_bytes`
covers `GET /file/bytes`, which was added later so clients can pre-flight raw
byte-window support against PR19-era daemons. `workspace_file_write` covers
the hash-aware text mutation routes (`POST /file/write`, `POST /file/edit`).
The write tag means the route contract exists; it does not mean the current
deployment is open for anonymous mutation. Write/edit are strict mutation
routes and require a configured bearer token even on loopback.

When `workspace_qualified_rest_core` is advertised, the same file surface is also available at `/workspaces/:workspace/file`, `/workspaces/:workspace/file/bytes`, `/workspaces/:workspace/stat`, `/workspaces/:workspace/list`, `/workspaces/:workspace/glob`, `/workspaces/:workspace/file/write`, and `/workspaces/:workspace/file/edit`.

The same tag also exposes workspace-qualified project-agent CRUD at `/workspaces/:workspace/agents` and `/workspaces/:workspace/agents/:agentType`. These plural routes only read or mutate project-level agents for the selected workspace; `global` and `user` scope requests return `400 { code: "global_scope_not_supported_for_workspace_route" }`. Workspace-less `/workspace/agents` routes retain their existing primary-workspace behavior and remain the only REST surface for user-level agent scope.

`extension_management_v2` advertises a user-level extension catalog and mutation surface at `/extensions/*`, plus workspace activation projections at `/workspaces/:workspace/extensions/*`. Artifacts are global; workspace routes expose only projection reads, exact activation overrides, and runtime refresh. Reads may target an untrusted registered workspace, while activation, refresh, and workspace-scoped install require a trusted target. Slow mutations use daemon-local operations at `/extensions/operations/:operationId`; store generation, not operation history, is authoritative across restart and across daemons. The published `workspace_extensions` capability and `/workspace/extensions/*` routes remain a primary-workspace compatibility adapter. Clients must preflight `extension_management_v2` and must not infer it from daemon mode or `workspace_qualified_rest_core`.

### Extension Management V2 wire contract

All routes use the daemon bearer authentication rules above. `X-Qwen-Client-Id` is optional for the V2 mutation routes; when supplied, it must identify a client registered with one of the mutation's target workspace runtimes. `:extensionId` is the lowercase 64-hex extension identity. `:workspace` resolves as an exact workspace id first and otherwise as a URL-encoded absolute cwd after canonicalization.

| Method and path                                                    | Success                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `GET /extensions`                                                  | `200` global artifact catalog                                               |
| `PUT /extensions/:extensionId/activation`                          | `202` global default-activation operation                                   |
| `POST /extensions/install`                                         | `202` install operation                                                     |
| `POST /extensions/check-updates`                                   | `202` update-check operation                                                |
| `POST /extensions/:extensionId/update`                             | `202` update operation                                                      |
| `DELETE /extensions/:extensionId`                                  | `202` uninstall operation, or idempotent `204` when the extension is absent |
| `GET /extensions/operations/:operationId`                          | `200` operation snapshot                                                    |
| `GET /workspaces/:workspace/extensions`                            | `200` workspace activation projection                                       |
| `PUT /workspaces/:workspace/extensions/:extensionId/activation`    | `202` exact workspace-activation operation                                  |
| `DELETE /workspaces/:workspace/extensions/:extensionId/activation` | `202` clear-override operation                                              |
| `POST /workspaces/:workspace/extensions/refresh`                   | `202` runtime-refresh operation                                             |

The global catalog response is:

```json
{
  "v": 1,
  "generation": 12,
  "extensions": [
    {
      "id": "<64 lowercase hex characters>",
      "name": "demo",
      "version": "1.2.3",
      "installType": "npm",
      "defaultActivation": "enabled",
      "workspaceOverrideCount": 1
    }
  ]
}
```

`installType` is omitted when no install metadata is available. `defaultActivation` is `enabled` or `disabled`. `workspaceOverrideCount` excludes stored `inherit` entries.

The workspace projection response is:

```json
{
  "v": 1,
  "workspaceId": "workspace-id",
  "workspaceCwd": "/absolute/workspace",
  "trusted": true,
  "desiredGeneration": 12,
  "appliedGeneration": 11,
  "extensions": [
    {
      "extensionId": "<64 lowercase hex characters>",
      "name": "demo",
      "version": "1.2.3",
      "defaultActivation": "enabled",
      "workspaceActivation": "disabled",
      "effectiveActivation": "disabled",
      "activationSource": "workspace_override"
    }
  ]
}
```

`workspaceActivation` is `enabled`, `disabled`, or `null` for inheritance. `activationSource` is `default`, `workspace_override`, `legacy_path_rule`, or `cli_override`. `desiredGeneration` is the durable store generation; `appliedGeneration` is the latest generation the controller recorded as applied to that workspace runtime and can temporarily lag.

Install requires explicit consent and an initial activation:

```json
{
  "source": "@scope/demo",
  "consent": true,
  "activation": { "scope": "user" },
  "ref": "optional-git-ref",
  "autoUpdate": true,
  "allowPreRelease": false,
  "registry": "https://registry.npmjs.org"
}
```

For workspace-only initial activation use `{ "scope": "workspace", "workspaceId": "target-workspace-id" }`; the target must exist and be trusted. Daemon installs accept GitHub, Git, and npm sources. `ref` does not apply to npm, and `registry` applies only to npm. `ref`, `autoUpdate`, `allowPreRelease`, and `registry` are optional.

Global and workspace activation `PUT` requests use the same body:

```json
{ "state": "enabled" }
```

`state` is `enabled` or `disabled`. Update, uninstall, check-updates, clear-activation, and refresh requests have no required body.

Every accepted asynchronous mutation returns:

```http
HTTP/1.1 202 Accepted
Location: /extensions/operations/<operation-id>
Retry-After: 1
Content-Type: application/json

{"accepted":true,"operationId":"<operation-id>"}
```

Workspace-qualified mutations use the same global `/extensions/operations/:operationId` polling path. Operation history is process-local, keeps only a bounded number of terminal entries, and is lost on daemon restart; clients must re-read the catalog or workspace projection and compare generations when an operation id disappears.

An operation snapshot has this shape:

```json
{
  "v": 1,
  "operationId": "<operation-id>",
  "operation": "install",
  "status": "running",
  "phase": "preparing",
  "createdAt": 1750000000000,
  "updatedAt": 1750000000100,
  "source": "owner/repository",
  "name": "demo"
}
```

`status` transitions from `queued` to `running`, then to `succeeded`, `succeeded_with_warnings`, or `failed`. While running, `phase` is `preparing`, `committing`, or `reconciling`. Terminal success may include `result` with `status` equal to `installed`, `enabled`, `disabled`, `updated`, `uninstalled`, `checked`, or `refreshed`; reconciliation results can additionally contain `refreshed`, `failed`, and `error`. Update checks return `result.states`, keyed by extension name, with values such as `checking for updates`, `update available`, `up to date`, `not updatable`, or `error`.

A durable commit followed by incomplete cleanup or runtime reconciliation is not reported as a failed mutation. It returns `succeeded_with_warnings` and preserves the committed result:

```json
{
  "v": 1,
  "operationId": "<operation-id>",
  "operation": "activation",
  "status": "succeeded_with_warnings",
  "createdAt": 1750000000000,
  "updatedAt": 1750000000200,
  "result": {
    "status": "disabled",
    "name": "demo",
    "refreshed": 1,
    "failed": 1
  },
  "warnings": [
    {
      "workspaceId": "workspace-id",
      "workspaceCwd": "/absolute/workspace",
      "code": "reconcile_slow",
      "error": "Runtime reconciliation took 31000ms."
    }
  ]
}
```

Warning `workspaceId` and `code` are optional; `workspaceCwd` and `error` are always present. Clients should display warnings, refresh their catalog/projection, and must not retry the durable mutation blindly.

Validation and authorization failures are synchronous HTTP errors using `{ "error": "...", "code": "..." }` when a stable code exists. Important cases are `400 invalid_extension_id`, `400 invalid_extension_activation`, `400 workspace_mismatch`, `403 untrusted_workspace`, `404 extension_operation_not_found`, and `429 extension_queue_full`. Install validation also returns `400` for invalid source/ref/registry options, missing consent, or missing/invalid initial activation. A mutation that fails after `202` is represented, while retained in operation history, with `status: "failed"`, `error`, and an optional stable `code`; common codes include `extension_prepare_timeout` and `extension_conflict`. HTTP `404` for an operation does not imply rollback because operation history is not durable.

`daemon_status` advertises `GET /daemon/status`, the consolidated read-only
operator diagnostic snapshot documented below.

**Conditional tags.** These feature tags are advertised only when their deployment toggle, runtime wiring, or availability condition is active. Tag presence means the documented behavior is available; absence means either an older daemon predating the tag or a current daemon where that condition is false. Currently:

<!-- conditional-serve-features:start -->

| Tag                                 | Advertised when …                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require_auth`                      | the daemon was started with `--require-auth` (or `requireAuth: true` via the embedded API). Bearer token is mandatory on every route, including `/health` on loopback binds.                                                                                                                                                                                                                                                                                                                                    |
| `mcp_workspace_pool`                | the shared MCP transport pool is active. Omitted when `QWEN_SERVE_NO_MCP_POOL=1` disables the pool.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mcp_pool_restart`                  | the shared MCP transport pool is active; restart responses may include pool-aware multi-entry shapes.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `allow_origin`                      | T2.4 ([#4514](https://github.com/QwenLM/qwen-code/issues/4514)). The daemon was started with at least one `--allow-origin <pattern>` (or `allowOrigins: [...]` via the embedded API). Cross-origin requests from matched origins receive proper CORS response headers; unmatched origins still get the default 403. The configured pattern list is intentionally NOT echoed in `/capabilities` to avoid leaking the trusted-origin set to unauthenticated readers — browser webui already knows its own origin. |
| `prompt_absolute_deadline`          | `--prompt-deadline-ms` / `QWEN_SERVE_PROMPT_DEADLINE_MS` / `ServeOptions.promptDeadlineMs` is set to a positive integer.                                                                                                                                                                                                                                                                                                                                                                                        |
| `writer_idle_timeout`               | `--writer-idle-timeout-ms` / `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` / `ServeOptions.writerIdleTimeoutMs` is set to a positive integer.                                                                                                                                                                                                                                                                                                                                                                             |
| `workspace_settings`                | the daemon was created with settings persistence available.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `workspace_voice`                   | settings persistence is available, so the legacy primary workspace Voice settings routes are active.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workspace_voice_transcription`     | the primary workspace has a configured Voice transcription model.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `session_shell_command`             | session shell execution is explicitly enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session_artifacts_persistence`     | session artifact persistence is wired for the runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `session_generation`                | session generation helpers are available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `rate_limit`                        | `--rate-limit` / `QWEN_SERVE_RATE_LIMIT=1` / `ServeOptions.rateLimit` is enabled.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `workspace_reload`                  | workspace reload support is available in the embedded route configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `channel_reload`                    | a daemon-managed channel worker manager is enabled and can reload its current selection.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `channel_control`                   | daemon-managed channel worker runtime control is wired.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `channel_management`                | workspace-scoped Channel configuration and instance lifecycle management are wired.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `multi_workspace_sessions`          | more than one workspace runtime is registered, so session creation can select a trusted runtime by cwd.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `multi_workspace_session_rewind`    | more than one workspace runtime is registered; singular live-session rewind routes resolve the owning runtime.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `multi_workspace_session_shell`     | more than one workspace runtime is registered and session shell execution is explicitly enabled; singular REST shell resolves the owning runtime.                                                                                                                                                                                                                                                                                                                                                               |
| `dynamic_workspace_registration`    | a workspace runtime factory is wired into the daemon, so an existing trusted directory can be registered as a secondary runtime at runtime.                                                                                                                                                                                                                                                                                                                                                                     |
| `persistent_workspace_registration` | a workspace registration store is wired into the daemon. Production `runQwenServe` supplies the user-level store automatically; direct `createServeApp` embeds must inject one explicitly and own startup restoration of their workspace registry.                                                                                                                                                                                                                                                              |
| `scratch_workspace_registration`    | managed scratch workspace creation is available — a runtime factory, a validated managed scratch root, and runtime disposal are wired, and every managed runtime respects the scratch root boundary.                                                                                                                                                                                                                                                                                                            |
| `workspace_runtime_removal`         | removable dynamic or persistence-restored secondary runtimes can be drained and removed through the management route.                                                                                                                                                                                                                                                                                                                                                                                           |
| `workspace_qualified_acp`           | ACP HTTP and multi-workspace runtimes are active, so the plural ACP endpoint can select a secondary runtime.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `workspace_qualified_voice`         | multi-workspace runtimes and the shared ACP/Voice WebSocket listener are active, so every workspace-qualified Voice modality is reachable for a secondary runtime.                                                                                                                                                                                                                                                                                                                                              |
| `client_mcp_over_ws`                | the daemon accepts client-hosted MCP servers over the ACP WebSocket. This is an explicit opt-in, not required for the CDP tunnel path.                                                                                                                                                                                                                                                                                                                                                                          |
| `cdp_tunnel_over_ws`                | the daemon exposes the reverse `/cdp` WebSocket tunnel, either by explicit opt-in or because a Chrome extension origin is allowed. This only means the tunnel exists; it does not mean Chrome DevTools MCP tools are registered.                                                                                                                                                                                                                                                                                |
| `browser_automation_mcp`            | ACP HTTP is enabled, `cdp_tunnel_over_ws` is active, no bearer token blocks `/cdp`, and `QWEN_CDP_MCP_COMMAND` names an external stdio MCP adapter. The main CLI package does not bundle a browser automation adapter; without this tag, Chrome extension side-panel chat may still work, but console/network/screenshot/click tools are not registered by default.                                                                                                                                             |
| `voice_transcribe`                  | the Voice WebSocket endpoint is mounted; a configured Voice model is still required for a successful transcription.                                                                                                                                                                                                                                                                                                                                                                                             |

<!-- conditional-serve-features:end -->

`mcp_guardrails` is **not** in this conditional table — it's an always-on tag, advertised whenever the binary supports the new `/workspace/mcp` budget fields, regardless of whether the operator configured a budget. Operators who haven't set `--mcp-client-budget` still get the new fields (with `budgetMode: 'off'`, `budgets: []`).

`mcp_guardrail_events` (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14b) advertises the typed SSE push events that surface MCP budget state crossings without a poll loop. Two frame types arrive on `GET /session/:id/events`:

- `mcp_budget_warning` — fires once on the upward 75% crossing of `reservedSlots.size / clientBudget`. Re-arms only after the ratio drops below 37.5% (`MCP_BUDGET_REARM_FRACTION`). Mirrors PR 10's `slow_client_warning` hysteresis, but at the manager level rather than the per-subscriber backlog level. Payload: `{ liveCount, reservedCount, budget, thresholdRatio: 0.75, mode: 'warn' | 'enforce' }`. Fires under both `warn` and `enforce` modes; never under `off`.
- `mcp_child_refused_batch` — fires at end of each `discoverAllMcpTools*` pass when one or more servers were refused, AND as a length-1 batch on the `readResource` lazy-spawn refusal path. Payload: `{ refusedServers: [{ name, transport, reason: 'budget_exhausted' }, ...], budget, liveCount, reservedCount, mode: 'enforce' }`. `mode` is the literal `'enforce'` because `warn` mode never refuses.

Both events live in the per-session SSE replay ring (they carry an `id`) so a client reconnecting with `Last-Event-ID` resumes through them; the snapshot at `GET /workspace/mcp` is still the source-of-truth for state-after-extended-disconnect. Always-on once advertised — there is no conditional toggle. SDK reducer state (`DaemonSessionViewState`) exposes `mcpBudgetWarningCount`, `lastMcpBudgetWarning`, `mcpChildRefusedBatchCount`, `lastMcpChildRefusedBatch` for adapters that want simple lag-style UI.

## Routes

### `GET /health`

Liveness probe. Default form returns `200 {"status":"ok"}` if the listener is up — cheap, no bridge access, suitable for high-frequency k8s/Compose liveness probes.

Pass `?deep=1` (also accepts `?deep=true` or bare `?deep`) for a daemon-wide probe that aggregates bridge **counters** across every managed workspace runtime, including a workspace that is still draining (informational only, not a true liveness check):

```json
{
  "status": "ok",
  "workspaceCount": 2,
  "sessions": 3,
  "pendingPermissions": 1,
  "activePrompts": 1,
  "connectedClients": 2,
  "channelAlive": true,
  "lastActivityAt": "2026-07-15T08:30:00.000Z",
  "idleSinceMs": 120000
}
```

`sessions`, `pendingPermissions`, and `activePrompts` are sums. `lastActivityAt` is the latest non-null workspace activity time and `idleSinceMs` is derived from that same snapshot. `channelAlive` means at least one managed workspace channel is live; it does not mean every workspace is healthy. `connectedClients` and the optional `rateLimitHits` remain daemon-wide counters rather than per-workspace sums.

> ⚠️ The deep probe is **informational**, not a real liveness verification or an atomic reclaim lease. It reads counter accessors which don't ping individual child processes / channels and so won't detect a wedged-but-still-counted session. `connectedClients` counts REST SSE connections, not every ACP transport. Use repeated samples and graceful shutdown for idle reclamation; use authenticated `/daemon/status` for transport and per-workspace diagnostics. If any managed runtime getter throws, deep health fails closed with `503 {"status":"degraded","reason":"aggregation_failed"}` rather than returning partial totals, and the daemon log identifies the failing workspace runtime. During bootstrap, before the runtime registry is ready, it returns `503 {"status":"degraded","reason":"bootstrap"}` with `Retry-After: 1`. For listener liveness, use the default `/health` without `?deep`.

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
    "maxTotalSessions": null,
    "maxPendingPromptsPerSession": 5,
    "listenerMaxConnections": 256,
    "eventRingSize": 8000,
    "compactedReplayMaxBytes": 4194304,
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
    "channelWorker": {
      "enabled": false,
      "state": "disabled",
      "channels": []
    },
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
    },
    "perf": {
      "eventLoop": { "meanMs": 0, "p50Ms": 0, "p99Ms": 0, "maxMs": 0 },
      "promptQueueWait": {
        "count": 0,
        "meanMs": 0,
        "maxMs": 0,
        "lastMs": null
      },
      "pipe": {
        "inbound": { "count": 0, "totalBytes": 0, "maxBytes": 0 },
        "outbound": { "count": 0, "totalBytes": 0, "maxBytes": 0 }
      }
    },
    "activity": {
      "activePrompts": 0,
      "pendingPrompts": 0,
      "queuedPrompts": 0,
      "lastActivityAt": null,
      "idleSinceMs": null
    }
  }
}
```

Multi-workspace responses also include top-level `workspaces[]` rows with
`{ id, cwd, displayName?, primary, trusted }`. The optional display name is
omitted when unset and remains presentation-only; status consumers must keep
using `id` or `cwd` to correlate runtimes.

`runtime.perf` is optional. When present, it reports daemon-process event loop
lag, prompt FIFO queue wait samples, and daemon-child pipe byte counters only;
ACP child event loop lag is not included in `/daemon/status`.

`status` is `error` if any issue has error severity, `warning` if any issue has
warning severity, otherwise `ok`. Issue codes are stable and include
`session_capacity_high`, `connection_capacity_high`, `pending_permissions`,
`acp_channel_down`, `preflight_error`, `mcp_budget_warning`,
`mcp_budget_exhausted`, `rate_limit_hits`, `channel_worker_exited`, and
`channel_worker_partial_connect`, and `workspace_status_unavailable`. During
the short window after the listener is ready but before the full runtime is
mounted, `/daemon/status` may report `daemon_runtime_starting`; if the async
runtime mount fails, it reports `daemon_runtime_failed` while non-status
runtime routes return `503`.

`runtime.activity` reports daemon-wide prompt activity. `activePrompts` counts sessions with an in-flight prompt. `pendingPrompts` counts all accepted prompts that have not settled yet, including the running prompt and FIFO-waiting prompts. `queuedPrompts` counts FIFO-waiting prompts that have been accepted but not dispatched. `lastActivityAt` is the ISO 8601 timestamp of the last prompt start/end or session spawn; `null` when the daemon has never processed any activity since boot. `idleSinceMs` is computed from `lastActivityAt` at response generation time.

`limits.maxTotalSessions` is additive. `null` means the effective daemon-wide fresh-session cap is disabled. When several startup/restored workspaces are present, `--max-total-sessions` is omitted, and `maxSessionsPerWorkspace` is finite, the daemon derives the effective total cap once as `maxSessionsPerWorkspace * startupWorkspaceCount`; later dynamic registration does not recompute it. When set, it limits fresh session creation across the daemon and reports total-limit failures with the existing `session_limit_exceeded` error shape plus `scope: "total"`.

`runtime.channel.live` reports the ACP bridge channel inside the daemon. It is
not the channel-adapter worker. Daemon-managed channels use
`runtime.channelWorker`, whose `state` is one of `disabled`, `starting`,
`running`, `exited`, `failed`, or `stopped`. When a worker reaches `running`
and then exits, `/daemon/status` keeps the daemon online and reports warning
issue code `channel_worker_exited`.

Daemon-managed channel worker startup remains fail-fast: if `qwen serve
--channel ...` cannot start a worker that reaches ready, serve startup fails.
After a worker has reached ready, unexpected exits are restarted by the serve
supervisor within a bounded policy: up to 3 restart attempts in a 5 minute
window, with 1s, 5s, then 15s backoff. The worker sends IPC heartbeats every
15s; if no heartbeat is observed for 45s, the supervisor treats the worker as
stale, kills it, records `staleHeartbeatAt`, and uses the same restart path.

`runtime.channelWorker` may include additive operational fields:
`requestedChannels`, `pid`, `startedAt`, `exitCode`, `signal`, `error`,
`restartCount`, `lastExitAt`, `lastRestartAt`, `nextRestartAt`,
`lastHeartbeatAt`, `staleHeartbeatAt`, `startupFailures`, and
`startupFailuresTruncated`. Each startup failure has `channel`, `phase`
(currently `connect`), optional adapter-provided `code`, and a credential-
redacted `message`. At most 64 failures are retained for the current worker
generation; the truncation flag means more failures were observed. `code` is
diagnostic and is not a stable cross-adapter classification. `restartCount` is the lifetime
number of restart attempts made by this serve process; a running worker with
`restartCount > 0` is healthy unless another issue applies. A running worker
whose `requestedChannels` include names missing from `channels` reports
`channel_worker_partial_connect`.

On a multi-workspace daemon (`--workspace` repeated), `runtime` additionally
includes `channelWorkers[]` — one entry per owning workspace, each a
`channelWorker` snapshot annotated with `workspaceId`, `workspaceCwd`, and
`primary`. `channelWorker` stays populated as the primary workspace's snapshot
for compatibility. Single-workspace daemons omit `channelWorkers[]`.

### Daemon-managed channel control

The `channel_control` capability advertises the runtime selection resource.
The resource is daemon-wide even though its compatibility path uses the
singular `/workspace` prefix. Runtime selections are not persisted and do not
modify the daemon's boot-time `--channel` option.

`GET /workspace/channel` returns an immutable manager snapshot:

```json
{
  "enabled": true,
  "selection": { "mode": "names", "names": ["telegram", "feishu"] },
  "pendingSelection": { "mode": "names", "names": ["telegram"] },
  "transition": "reconciling",
  "workers": [
    {
      "workspaceId": "primary-id",
      "workspaceCwd": "/work/primary",
      "primary": true,
      "enabled": true,
      "state": "running",
      "channels": ["telegram"],
      "pid": 1234
    }
  ]
}
```

`selection` is `null` while disabled. `pendingSelection` is present only during
a mutation. `transition` is one of `idle`, `starting`, `reconciling`,
`stopping`, or `rolling_back`.

`PUT /workspace/channel` is strict-gated and accepts exactly one selection:

```json
{ "selection": { "mode": "all" } }
```

```json
{ "selection": { "mode": "names", "names": ["telegram", "feishu"] } }
```

Names are trimmed and deduplicated without sorting; an empty names array is
invalid. `all` remains primary-workspace-only. A disabled-to-enabled change
returns `201`; an idempotent PUT or replacement returns `200`. The response is
`{ changed, replaced, partial, state }`. An equal selection keeps healthy
workers in place, but recovers an equal selection whose worker is stopped or
failed.

`DELETE /workspace/channel` is strict-gated and idempotent. It returns
`{ changed, state }`; a successful state is disabled. `POST
/workspace/channel/reload` is also strict-gated and re-reads settings,
re-resolves workspace groups, and force-reconciles the committed selection.
It returns `409 channel_worker_not_enabled` while disabled. The
`channel_reload` capability is advertised dynamically only while the manager
has a committed, reloadable selection.

Every enable, replace, reload, stop, and daemon shutdown enters one FIFO
lifecycle lane. GET does not wait for that lane. Workspace groups whose ordered
selection did not change remain online. Replacement failures attempt to stop
newly started workers and restore the previous committed selection. Clients
must inspect `rolledBack`, `rollbackError`, and `state` because cleanup or
restoration can also fail. The daemon keeps the channel-service PID lease
throughout a transaction and does not release it until every relevant child
exit is confirmed.

Stable control errors are:

- `400 invalid_channel_selection`, `channel_workspace_mismatch`, or `ambiguous_channel_workspace`
- `403 untrusted_workspace`
- `409 channel_service_conflict` or `channel_worker_not_enabled`
- `500 channel_worker_stop_failed`
- `502 channel_worker_start_failed`, with `rolledBack` and an optional credential-redacted `rollbackError`
- `503 daemon_draining`

Strict writes against a daemon without a configured token return `401
token_required` before control code runs. Once a request begins, disconnecting
the HTTP client does not cancel the lifecycle transaction; clients may retry
the same PUT safely.

For `502 channel_worker_start_failed`, the response may also include
`startupFailures[]` and `startupFailuresTruncated`. Each failure adds the
trusted `workspaceCwd` of the attempted worker. These fields describe the
failed transaction, while `state` describes the current state after rollback;
a later GET does not retain the failed attempt. A partially connected worker
instead returns success and exposes its failures in the worker snapshot. Boot-
time all-failure still aborts `qwen serve` before a queryable daemon exists.

`qwen channel status` without `--daemon-url` continues to read pidfile metadata;
with `--daemon-url` it reads `GET /workspace/channel`. During a restart
window the serve-owned pidfile remains reserved, but `workerPid` is omitted so
clients do not display a stale worker process. On a multi-workspace daemon the
pidfile also carries an additive `workers[]` array (per-workspace
`workspaceId` / `workspaceCwd` / `channels` / live `workerPid`) while the
top-level `channels` (union) and `workerPid` (primary) stay populated for older
readers; single-workspace daemons keep the original single-worker shape. Worker
stdout/stderr are forwarded into the daemon log with bearer tokens, sensitive
worker environment values, and proxy URL credentials redacted.

Security: the response never includes bearer tokens, client ids, full ACP
connection ids, device-flow user codes, or verification URLs. Both detail
levels may include additive `daemon.runId`, `daemon.logMode`, and
`daemon.logHealth`. `summary` omits the daemon log path and loss details;
`full` may include `logPath`, `logIssues`, `logDroppedRecords`, and
`logDroppedBytes` for authenticated operators. Degraded file logging adds the
path-free `daemon_log_degraded` warning to the normal status rollup.

### `GET /capabilities`

```json
{
  "v": 1,
  "protocolVersions": {
    "current": "v1",
    "supported": ["v1"]
  },
  "mode": "http-bridge",
  "features": [
    "health",
    "daemon_status",
    "capabilities",
    "multi_workspace_sessions",
    "..."
  ],
  "limits": {
    "maxPendingPromptsPerSession": 5,
    "maxSessionsPerWorkspace": 20,
    "maxTotalSessions": 40
  },
  "modelServices": [],
  "workspaceCwd": "/canonical/path/to/primary-workspace",
  "workspaces": [
    {
      "id": "stable-workspace-id",
      "cwd": "/canonical/path/to/primary-workspace",
      "primary": true,
      "trusted": true
    },
    {
      "id": "stable-secondary-workspace-id",
      "cwd": "/canonical/path/to/secondary-workspace",
      "displayName": "Payments Production",
      "primary": false,
      "trusted": true
    }
  ]
}
```

Stable contract: when `v` increments the frame layout has changed in a backwards-incompatible way.

> **`protocolVersions`** describes the serve protocol versions the daemon can speak. `current` is the daemon's preferred protocol version and `supported` is the compatible set. Clients that require a specific protocol should check `supported`; feature-specific UI should still gate on `features`. Additive to v=1: older v=1 daemons omit this field, so SDK clients that target older builds should treat it as optional.

> **`modelServices` is always `[]` in Stage 1.** The agent uses its single default model service and doesn't enumerate it over the wire. Stage 2 will populate this from registered model adapters so SDK clients can build service-pickers; until then, do NOT rely on this field being non-empty.

> **`workspaceCwd`** is the canonical absolute path for the daemon's primary workspace. Use it to omit `cwd` on `POST /session` (the route falls back to this primary path) and to keep old single-workspace clients compatible. Additive to v=1: pre-§02 v=1 daemons omit the field — clients that target older builds should null-check before consuming it.

> **`workspaces[]`** lists every registered runtime. Newer single-workspace daemons include the primary runtime even when `multi_workspace_sessions` is absent so clients can discover the stable id required by workspace-qualified routes; older daemons may omit the array. Each entry is `{ id, cwd, displayName?, primary, trusted, removable? }`. `displayName` is presentation-only and omitted when unset. The first/primary workspace remains mirrored by `workspaceCwd`; new clients choose a non-primary runtime by passing that entry's `cwd` to `POST /session`. Untrusted workspaces are advertised for diagnostics but reject fresh session creation with `403 untrusted_workspace` until trust changes. `removable` is present on daemons that support runtime removal and is true only for process-dynamic or persistence-restored secondary runtimes.

The workspace feature tags and `workspaces[]` are dynamic. Clients that add a workspace must fetch `/capabilities` again after the mutation completes; the daemon does not broadcast capability changes to clients that cached an earlier response. Forgetting persistence does not unload an active runtime, so that runtime remains advertised until restart.

### `POST /workspaces`

Register an additional workspace runtime. The path must be an existing, accessible, absolute directory that does not duplicate or nest with another registered workspace. Registration is process-local unless the client sends `persist: true`; clients must pre-flight `persistent_workspace_registration` before requesting persistence. When `workspace_display_name` is advertised, the request may also include an optional `displayName`.

```json
{
  "cwd": "/canonical/path/to/secondary-workspace",
  "persist": true,
  "displayName": "Payments Production"
}
```

A newly created runtime returns `201`; promoting an already-active secondary workspace to persistent returns `200`. Persistent success includes `persisted: true`:

```json
{
  "id": "stable-workspace-id",
  "cwd": "/canonical/path/to/secondary-workspace",
  "displayName": "Payments Production",
  "primary": false,
  "trusted": true,
  "persisted": true
}
```

`displayName` must be a string no longer than 256 characters after surrounding whitespace is trimmed. An empty result is treated as no name, and internal C0 (`U+0000`–`U+001F`) or DEL (`U+007F`) control characters are rejected. JSON `null` is not a creation value and returns `400 invalid_display_name`; omit the field to supply no initial name. Duplicate display names are allowed. A name supplied with a process-local registration lasts only for that daemon process; `persist: true` stores it with the persistent registration so it can be restored after restart. Repeating the request for an already-persistent workspace is idempotent and does not rename it.

Errors include `400 invalid_path` / `invalid_persist_flag` / `invalid_persist_target` / `invalid_display_name`, `409 workspace_exists` / `workspace_nested` / `workspace_limit_reached`, `500 workspace_registration_store_error` / `runtime_creation_failed`, and `501 persistence_not_available` / `not_implemented`.

### `PATCH /workspaces/:workspace`

Update an active workspace resource selected by workspace ID or URL-encoded absolute cwd. The endpoint currently supports only display-name metadata:

```json
{ "displayName": "Payments Production" }
```

Send `{ "displayName": null }` to clear the name. Here `null` is an update-only deletion sentinel; non-null values follow the same string normalization rules as `POST /workspaces`. The response is the updated `{ id, cwd, displayName?, primary, trusted, removable? }` workspace projection. Runtime metadata is always updated. If the runtime has matching persistent registration identities, every alias is updated atomically through the existing schema-v1 registration store; the endpoint never creates or promotes a persistent registration.

Unsupported fields fail closed rather than being silently ignored. Errors include `400 empty_patch` / `invalid_display_name` / `unsupported_field` / `workspace_mismatch`, `409 workspace_registration_in_progress`, `500 workspace_registration_store_error`, and `503 daemon_shutting_down`.

### `DELETE /workspaces/:workspace`

Remove one removable secondary runtime. The selector follows the plural workspace routing rules and accepts either a workspace ID or a URL-encoded absolute cwd. The optional JSON body is `{ "force": boolean }`; omitting it requests non-force removal.

Non-force removal returns `409 workspace_busy` with an `activity` snapshot when the frozen runtime has sessions, prompts, pending starts, ACP connections, memory tasks, or workspace channel workers. Sending `{ "force": true }` requests termination of those resources. Persistence removal is the commit point: subsequent cleanup is bounded and best-effort, cleanup failures are logged, and logical removal still converges instead of restoring the runtime. A successful response is:

```json
{
  "removed": true,
  "workspaceId": "stable-workspace-id",
  "workspaceCwd": "/canonical/path/to/secondary-workspace",
  "forced": true,
  "persistedRegistrationRemoved": true,
  "activity": {
    "sessions": 2,
    "activePrompts": 1,
    "pendingSessionStarts": 0,
    "acpConnections": 1,
    "memoryTasks": 0,
    "channelWorkers": 0,
    "voiceSessions": 0
  }
}
```

An immediately busy non-force request returns a fast pre-drain activity snapshot. Once drain starts, the busy or success response contains the final snapshot taken after admission and ACP drain gates close and before cleanup begins. Errors include `400 invalid_force_flag` / `workspace_mismatch`, `409 workspace_busy` / `primary_workspace_removal_forbidden` / `static_workspace_removal_forbidden` / `workspace_removal_in_progress` / `workspace_registration_in_progress`, `500 workspace_persist_failed` / `workspace_runtime_removal_failed`, `501 workspace_runtime_removal_unsupported`, and `503 daemon_shutting_down`.

### `GET /workspace-registrations`

List the persisted desired workspace set for this primary workspace. Entries remain visible with `active: false` when a stored directory could not be restored during the current start.
An entry remains `active: true` while its runtime is draining because the runtime still owns live resources until removal completes.
Entries include optional `displayName` when the persistent registration has one.

```json
{
  "schemaVersion": 1,
  "primaryWorkspace": "/canonical/path/to/primary-workspace",
  "entries": [
    {
      "id": "stable-registration-id",
      "cwd": "/canonical/path/to/secondary-workspace",
      "displayName": "Payments Production",
      "active": true,
      "persisted": true
    }
  ]
}
```

Returns `501 persistence_not_available` when no registration store is configured and `500 workspace_registration_store_error` when the store cannot be read.

### `DELETE /workspace-registrations/:id`

Forget one persisted registration. This does not unload an active runtime or terminate its sessions; `restartRequired: true` means the active runtime disappears on the next daemon restart.

```json
{ "removed": true, "active": true, "restartRequired": true }
```

Returns `404 workspace_registration_not_found`, `500 workspace_registration_store_error`, or `501 persistence_not_available`. Like other mutation routes, this endpoint requires mutation authentication when daemon authentication is enabled.

### Read-only runtime status routes

These routes report daemon-side runtime snapshots. They are additive v1 routes,
do not mutate state, and do not change the serve protocol version. Workspace
status routes intentionally do **not** start the ACP child process just because
a client polls a GET route: if the daemon is idle, they return
`initialized: false` with an empty snapshot. Session status routes require a
live session and return `404 { code: "session_not_found", ... }` for unknown
ids.

Capability tags:

- `workspace_mcp` → `GET /workspace/mcp`
- `workspace_skills` → `GET /workspace/skills`
- `workspace_providers` → `GET /workspace/providers`
- `workspace_acp_status` → `GET /workspace/acp/status`
- `workspace_env` → `GET /workspace/env`
- `workspace_preflight` → `GET /workspace/preflight`
- `session_context` → `GET /session/:id/context`
- `session_supported_commands` → `GET /session/:id/supported-commands`
- `session_tasks` → `GET /session/:id/tasks`
- `session_status` → `GET /session/:id/status`
- `session_info` → `GET /workspace/:id/session-info` and `GET /workspaces/:workspace/session-info`
- `session_transcript` → `GET /session/:id/transcript`
- `workspace_persisted_transcript` → `GET /workspaces/:workspace/session/:id/transcript`
- `workspace_session_export` → `GET /workspaces/:workspace/session/:id/export`
- `workspace_archived_session_export` → `GET /workspaces/:workspace/session/:id/archive/export`

`workspace_acp_status` reports the primary workspace ACP channel's
point-in-time liveness as `{ channelLive: boolean }`. The handler does not
create a channel, but reaching a runtime route can first start a deferred daemon
runtime, whose configured startup policy may independently preheat ACP. The
snapshot is not a lease: clients must let Session creation revalidate or start
the channel.

### ACP preheat

Capability tag: `workspace_acp_preheat`.

`POST /workspace/acp/preheat?timeoutMs=N` best-effort initializes the primary
workspace ACP channel. `timeoutMs` defaults to 5000 and must be a positive
integer no greater than 60000. Concurrent callers and Session creation share
the same bridge initialization. A request timeout ends only that HTTP wait; it
does not cancel the shared initialization.

```ts
interface WorkspaceAcpPreheatResult {
  ready: boolean;
  channelLive: boolean;
  durationMs: number;
  reason?: 'timeout' | 'error';
  error?: string;
}
```

`ready` always equals `channelLive`. A live response omits `reason` and
`error`; otherwise `reason` is `timeout` or `error`. `durationMs` measures the
current HTTP call, not the full lifetime of an initialization the call joined.
Operational timeout or failure returns HTTP 200. Invalid `timeoutMs` returns
400, while authentication, rate limiting, and deferred-runtime failures retain
their normal responses.

Both ACP workspace routes are singular and primary-workspace-only. Clients
must not use them for a secondary workspace or interpret either response as a
durable readiness guarantee.

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

**MCP client guardrails (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175)).** Current daemons extend the payload with four additive fields and a capability-scoped budget cell:

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
      "scope": "workspace",
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

`budgetMode` is one of `enforce`, `warn`, or `off`. `clientBudget` is absent when no budget was set. `budgets[]` is **always an array** on daemons advertising `mcp_guardrails` (possibly empty when `budgetMode === 'off'`); older daemons omit the field entirely. When `mcp_workspace_pool` is advertised, the cell has `scope: 'workspace'` and covers the selected workspace runtime's shared pool. When that tag is absent, including under `QWEN_SERVE_NO_MCP_POOL=1`, the legacy manager emits `scope: 'session'`. Consumers MUST tolerate additional unrecognized scope values.

`disabledReason` on per-server cells distinguishes operator-disabled (`'config'` — `disabledMcpServers` config list) from budget-refused (`'budget'` — discovered but never connected due to `enforce` mode). Refusals are deterministic by `Object.entries(mcpServers)` declaration order. The per-server `status: 'error', errorKind: 'budget_exhausted'` shadows the raw `mcpStatus: 'disconnected'` (which is true but not the operator-facing severity).

Budget enforcement is capability-driven. With `mcp_workspace_pool`, sessions inside one workspace runtime share transports and one `WorkspaceMcpBudget`; different workspace runtimes never share a pool or budget. Without the tag, each ACP session's `McpClientManager` enforces its own copy of the cap and the snapshot represents that legacy session view.

**Detecting budget pressure.** Two surfaces, both populated post-PR-14b:

- **Push events** (advertised via `mcp_guardrail_events`): subscribe to `GET /session/:id/events` and narrow `mcp_budget_warning` / `mcp_child_refused_batch` frames through `KnownDaemonEvent`. The state machine fires once per upward 75% crossing (re-armed below 37.5%); refusals are coalesced once per discovery pass under `enforce` mode.
- **Snapshot poll** (advertised via `mcp_guardrails`): `GET /workspace/mcp` and inspect the budget cell (`budgets[0]`) together with `mcp_workspace_pool` to determine its scope:

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
      "userInvocable": false,
      "installedPath": "/home/alice/project/.qwen/skills/review/SKILL.md",
      "argumentHint": "[path]"
    }
  ]
}
```

`level` is one of `project`, `user`, `extension`, or `bundled`.
`userInvocable` (boolean, optional) is omitted for normal skills (meaning
`true`) and is present only as `false` when the skill cannot be invoked manually
or toggled through the skill API. `modelInvocable` is independent: `false`
means the skill remains manually available but is hidden from model invocation.
`installedPath` is the existing absolute path to the skill's `SKILL.md`; the
daemon returns it as stored without separately resolving symlinks or
canonicalizing it. Current daemons emit it for every skill, while clients must
tolerate its absence from older v1 daemons. Skill bodies, hooks, `skillRoot`,
and other skill configuration remain excluded. `errors` is omitted when
discovery succeeds.

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

All file paths are resolved through the daemon's primary workspace. Responses use
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
    },
    {
      "kind": "agent",
      "id": "agent-2",
      "label": "general-purpose: run the failing test",
      "description": "run the failing test",
      "status": "running",
      "startTime": 1699999999500,
      "runtimeMs": 500,
      "outputFile": "/tmp/agent-2.jsonl",
      "isBackgrounded": false,
      "subagentType": "general-purpose",
      "parentAgentId": "agent-1",
      "parentName": "reviewer",
      "depth": 1
    }
  ]
}
```

This route is a read-only out-of-band snapshot. It is intentionally not a
prompt and can be queried while the session is streaming. The response only
contains whitelisted metadata from the agent, shell, and monitor task
registries; controllers, timers, offsets, pending messages, and raw registry
objects are never exposed.

Agent tasks spawned by another sub-agent (nested sub-agents, bounded by
`maxSubagentDepth`) carry three optional lineage fields: `parentAgentId` (the
spawning agent task's `id`), `parentName` (the spawning agent's
`subagentType`, captured at registration so it survives the parent's eviction
from the registry), and `depth` (0-based launch depth; 0 = spawned by the
top-level session). Agents launched by the top-level session omit
`parentAgentId` and `parentName`; clients should treat all three fields as
optional and fall back to a flat list when they are absent.

### `GET /session/:id/lsp`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "workspaceCwd": "/canonical/path",
  "enabled": true,
  "configuredServers": 1,
  "readyServers": 1,
  "failedServers": 0,
  "inProgressServers": 0,
  "notStartedServers": 0,
  "servers": [
    {
      "name": "typescript",
      "status": "READY",
      "languages": ["typescript", "javascript"],
      "transport": "stdio",
      "command": "typescript-language-server"
    }
  ]
}
```

`status` is one of `NOT_STARTED`, `IN_PROGRESS`, `READY`, or `FAILED`.
Optional `error` is present on failed servers when available. Disabled LSP
(including bare mode) returns HTTP 200 with `enabled: false`, zero counts, and
`servers: []`. LSP enabled with no configured servers returns `enabled: true`,
`configuredServers: 0`, and `servers: []`. If initialization fails before the
client exists, the response may include `initializationError`; if a live client
cannot provide a snapshot, the response includes `statusUnavailable: true`.

This route exposes only stable client-facing fields. It intentionally omits
debug internals such as process IDs, spawn args, stderr tails, root URIs, and
workspace-folder paths.

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
| `cwd`            | no       | Absolute path matching one registered workspace. If omitted, the route falls back to the primary workspace (read it off `/capabilities.workspaceCwd`). A mismatched non-empty `cwd` returns `400 workspace_mismatch`. When `features` contains `multi_workspace_sessions`, clients may pass any trusted `workspaces[].cwd`; otherwise only the primary workspace is accepted. Workspace paths are canonicalized via `realpathSync.native` (with a resolve-only fallback for non-existent paths) so case-insensitive filesystems don't reject sessions per spelling.                                                      |
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

Multi-client integrations that want independent conversations should send
`sessionScope: "thread"` on each `POST /session`. Use the default `single`
scope only when clients intentionally share one collaborative session; shared
sessions serialize prompts through one FIFO, visible through
`/daemon/status` as `runtime.activity.pendingPrompts` and
`runtime.activity.queuedPrompts`.

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

| Field | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd` | no       | Same canonicalization + `workspace_mismatch` rules as `POST /session`. Omit to inherit `/capabilities.workspaceCwd`. When `features` contains `multi_workspace_sessions`, callers may pass any trusted registered `workspaces[].cwd`; untrusted non-primary workspaces return `403 untrusted_workspace`. `mcpServers` is intentionally NOT accepted here — daemon-wide MCP is settings-driven (matches `POST /session`). |

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

**History replay over SSE.** While `loadSession` is in flight on the agent side, the agent may emit `session_update` notifications for persisted turns, or return bulk replay updates in the response metadata. The daemon seeds those events into the session's bounded replay snapshot window before the route response returns. For live sessions, `POST /session/:id/load` only promises that bounded window (`compactedReplay`, `liveJournal`, `lastEventId`), not the full transcript. The window is byte-capped by `--compacted-replay-max-bytes` (default 4 MiB, maximum 256 MiB); if older replay entries were dropped, `compactedReplay[0]` is an id-less `history_truncated` marker. Clients should render that marker as status and continue applying retained events. Full persisted transcript access is exposed separately through `GET /session/:id/transcript`.

**Errors:**

- `404` — persisted session id doesn't exist (`SessionNotFoundError`).
- `400` — `workspace_mismatch` (same shape as `POST /session`).
- `403` — `untrusted_workspace` when `cwd` targets an untrusted non-primary workspace.
- `503` — `session_limit_exceeded` (counts against `--max-sessions`; in-flight restores are accounted for too).
- `409` — `restore_in_progress` (a `session/resume` for the same id is already in flight). `Retry-After: 5`. Same-action races (two concurrent `session/load` for the same id) coalesce — exactly one returns `attached: false`, the rest return `attached: true` with the same `state`.
- `409` — `session_workspace_conflict` when the same session id is already live or being restored by another workspace runtime.
- `409` — `session_archived` when the id exists only under `chats/archive/`; call `POST /sessions/unarchive` before `load` or `resume`.
- `409` — `session_archiving` when archive or unarchive is in flight for the same id. `Retry-After: 5`.
- `409` — `session_conflict` when the id exists in both `chats/` and `chats/archive/`; delete the session with `POST /sessions/delete` before loading.

### `GET /session/:id/transcript`

Return one page of id-less `session_update` replay frames reconstructed from the active persisted JSONL transcript. Pre-flight `caps.features.session_transcript` — older daemons return `404` for this route.

Query parameters:

| Field    | Required | Notes                                                                                                                                                                                                                                                                                                                                                    |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor` | no       | Opaque base64url cursor returned by the previous page. Omit for the first page. The cursor is daemon-issued and tamper-checked; modifying it returns `400 invalid_transcript_cursor`. It binds to the transcript file identity and frozen first-page byte size; deleting, truncating, replacing, or archiving the file invalidates it and returns `409`. |
| `limit`  | no       | Number of active `ChatRecord`s to include in the page. Defaults to `100`, maximum `500`. One record can produce multiple replay frames, so `events.length` may be larger than `limit`. Invalid values return `400 invalid_transcript_limit`.                                                                                                             |

Response:

```json
{
  "v": 1,
  "sessionId": "persisted-1",
  "events": [
    {
      "v": 1,
      "type": "session_update",
      "data": {
        "sessionUpdate": "user_message_chunk",
        "content": { "type": "text", "text": "..." }
      }
    }
  ],
  "nextCursor": "opaque",
  "hasMore": true,
  "startTime": "2026-07-08T00:00:00.000Z",
  "lastUpdated": "2026-07-08T00:01:00.000Z"
}
```

`events` are replay frames only: `{ v: 1, type: "session_update", data: SessionUpdate }`. They do not carry EventBus ids, and the response never includes `lastEventId`. Calling this route does not call `/load`, attach a client, seed the live EventBus, create a live session, or change the current live replay window. Live and inactive active sessions are both reconstructed by the child-side read-only status method so replay uses the same workspace settings, runtime output directory, emitters, and `/load` history semantics without mutating daemon session state.

The first page freezes the current JSONL snapshot size. Later pages read only that byte prefix, so appends after page 1 do not change the result set. If the file disappears, is truncated below the frozen size, is replaced with a different inode, or is moved to archive, the next page returns `409` and the client should restart from page 1 or ask the user to reopen the transcript.

To protect daemon memory and latency, snapshots above the transcript indexing cap fail before the daemon scans the JSONL. Clients receive `413 transcript_too_large` and should fall back to export/offline processing or ask the user to shorten/archive older history.

`partial: true` and `replayError` may appear if replay conversion fails after producing some frames. Partial responses never include `nextCursor`, so clients cannot silently paginate past records that were not converted.

**Errors:**

- `400` — invalid `limit`, `cursor`, or session id shape.
- `404` — active persisted session id does not exist on the first page request.
- `409` — `session_archived`, `session_archiving`, or `session_conflict` from the same loadability checks as `/load`.
- `409` — transcript snapshot is unavailable because the file was deleted, truncated, replaced, or archived after the cursor was issued; this also applies when preflight can no longer find the active file for a cursor request.
- `413` — `transcript_too_large` when the frozen transcript snapshot exceeds the daemon indexing cap.
- `413` — `transcript_page_too_large` when one aggregate record exceeds the workspace-qualified page budget or the serialized page exceeds its response budget.

### `GET /workspaces/:workspace/session/:id/transcript`

Return the same `DaemonSessionTranscriptPage` projection as the singular route from the selected registered workspace's active persisted JSONL. Pre-flight `workspace_persisted_transcript`; this capability is independent of `multi_workspace_sessions` and works for a trusted single-workspace primary selected by id or cwd.

The selector and query parameters follow the existing plural workspace and transcript rules. Trusted primary and secondary runtimes and untrusted secondary runtimes may read. An untrusted primary returns `403 untrusted_workspace`. Archived content is not returned.

For this workspace-qualified route, `limit` is the maximum record count. A page may stop earlier at the 4 MiB persisted-source budget and return a continuation cursor. Serialized responses are capped at 32 MiB and cursors at 64 KiB. If replay state would exceed the cursor cap, the page returns its successfully converted events with `partial: true`, `hasMore: false`, and no `nextCursor`.

Unlike the legacy singular route, this path is implemented entirely inside the daemon process. It does not call the workspace bridge, start ACP, load settings, parse project-defined agents or skills, or create/repair `session-transcript-cursor-key`. Tool frames use persisted tool names and descriptions without consulting the runtime tool registry. Its HMAC cursor key exists only in daemon memory, is isolated per workspace, and rotates on restart; a cursor from a previous daemon process returns `400 invalid_transcript_cursor`.

### `GET /workspaces/:workspace/session/:id/export`

Export the selected registered workspace's active persisted session as an attachment. Pre-flight `workspace_session_export`; do not infer support from `session_export` or `workspace_qualified_rest_core`. The selector resolves as exact workspace id first, then as a URL-encoded absolute cwd after canonicalization. Both primary and secondary runtimes must be trusted. An untrusted runtime returns `403 untrusted_workspace` before session or format validation.

The optional `format` query is `html` (default), `md`, `json`, or `jsonl`. The body, MIME type, filename sanitization, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and attachment disposition match `GET /session/:id/export`. The legacy route remains bound to primary storage.

The plural route reads only the selected workspace's active persisted JSONL under the existing shared archive coordinator. It does not scan other workspace stores, fall back to primary, resolve a live owner, call the workspace bridge, start ACP, attach a client, or load settings. A session id that exists only in another workspace returns `404 { code: "session_not_found" }`; archived sessions return `409 session_archived`. Invalid formats return `400 invalid_export_format`, and storage races retain the existing `session_archiving` and `session_conflict` errors.

### `GET /workspaces/:workspace/session/:id/archive/export`

Export the selected registered workspace's archived persisted session as an attachment. Pre-flight `workspace_archived_session_export`; support cannot be inferred from active export or plural core capabilities. Workspace selector resolution and trust checks run before session-id and format validation.

TypeScript SDK callers use `WorkspaceDaemonClient.exportArchivedSession(sessionId, options)`. The method always uses native REST and returns the existing `DaemonSessionExportResult` attachment projection.

The optional `format` query, response body, MIME type, sanitized filename, cache policy, security header, and attachment disposition are identical to the active workspace export. Archived source JSONL is capped at 256 MiB before reconstruction; a larger file returns `413 transcript_too_large` with `sessionId`, `snapshotSize`, and `maxBytes`. The active export keeps its existing size behavior.

The route reads only `chats/archive/<id>.jsonl` in the selected trusted workspace under a shared archive-coordinator lease. It does not inspect active content for fallback, scan another workspace, resolve a live owner, call a bridge, start ACP, attach a client, or load settings. An active-only id returns `409 { code: "session_not_archived" }`; a missing id returns `404 { code: "session_not_found" }`; simultaneous active and archived files return `409 session_conflict`; and an archive transition returns `409 session_archiving` with `Retry-After: 5`.

### `POST /session/:id/resume`

Restore a persisted ACP session by id WITHOUT replaying history through SSE. The model context is restored internally on the agent side (via `geminiClient.initialize` reading `config.getResumedSessionData`); the SSE stream stays clean for clients that already have history rendered. Pre-flight `caps.features.session_resume`; `unstable_session_resume` remains a deprecated compatibility alias for older clients.

Same request shape as `/load`. Same response shape — `state` mirrors ACP's `ResumeSessionResponse`. Same error envelope, including `409 restore_in_progress` (which fires when a `session/load` is in flight; `session/resume` racing behind another `session/resume` coalesces).

Use `/load` when the client has no history rendered (cold reconnect, picker → open). Use `/resume` when the client already has the turns on screen and only needs the daemon-side handle back.

> ⚠️ **Why is `unstable_session_resume` still advertised?** The daemon's HTTP route and `session_resume` capability are stable for v1, but the bridge still calls ACP's `connection.unstable_resumeSession`. The old tag remains only so SDKs that shipped before `session_resume` can keep working.

### `GET /workspace/:id/session-info` and `GET /workspaces/:workspace/session-info`

Return aggregate persisted session counts for the selected workspace without changing the paginated session-list path:

```json
{
  "active": 450,
  "archived": 30,
  "total": 480,
  "live": 2,
  "expensive": true,
  "cost": "disk_scan"
}
```

`active`, `archived`, and `total` count local JSONL sessions. `live` is the matching in-memory bridge count and is omitted for a registered untrusted secondary workspace because that persisted-only read must not query live state. `expensive` is always `true` and `cost` is always `"disk_scan"`; clients must call this endpoint infrequently rather than poll it. If the scan reaches its safety limit or cannot classify every candidate file, the response adds `"truncated": true` and the persisted counts are lower bounds. Missing storage returns zero persisted counts. The plural route uses the same workspace selector and trust policy as the plural session catalog; an untrusted primary still returns `403 untrusted_workspace`.

The TypeScript daemon SDK exposes the plural route through `workspaceById(...)` or `workspaceByCwd(...)`, followed by `getWorkspaceSessionInfo()`.

### `GET /workspace/:id/sessions` and `GET /workspaces/:workspace/sessions`

List sessions whose canonical workspace matches `:id` or `:workspace`. The path parameter first resolves as an exact workspace id and then as a URL-encoded absolute cwd. Primary workspaces include the existing persisted/live merge: the default list is active sessions from `chats/`; pass `archiveState=archived` to list archived sessions from `chats/archive/`. Trusted non-primary workspaces include active persisted sessions from their own `chats/` store and merge matching live summaries without duplicates; if no active persisted sessions exist, the route preserves the previous live-only cursor behavior. Trusted non-primary workspaces also support `archiveState=archived`, the organized `view=organized` list, and `group` filters, reading from their own `chats/`, `chats/archive/`, and session-organization stores; a combined `view=organized&archiveState=archived` query returns only archived sessions without a live merge. Registered untrusted non-primary workspaces support the same list, filter, and pagination shapes but return persisted entries only: the daemon does not query the live bridge or populate pending interactions, turn errors, or client state from the runtime. Persisted defaults such as `clientCount: 0` and `hasActivePrompt: false` remain present for wire compatibility. Missing storage returns an empty list. The plural route still returns `403 { code: "untrusted_workspace" }` for an untrusted primary; legacy primary routes keep their existing compatibility behavior. `archiveState=all` is not supported in v1. Primary and persisted-backed lists keep the existing numeric `cursor` semantics; the no-persisted trusted non-primary live fallback keeps its existing opaque live cursor.

```bash
curl http://127.0.0.1:4170/workspace/$(jq -rn --arg c "$PWD" '$c|@uri')/sessions
curl http://127.0.0.1:4170/workspace/$(jq -rn --arg c "$PWD" '$c|@uri')/sessions?archiveState=archived
curl http://127.0.0.1:4170/workspaces/<workspace-id>/sessions
```

When `workspace_qualified_rest_core` is advertised, workspace-scoped session batch operations, group CRUD, and session organization mutation are available under `/workspaces/:workspace/sessions/{delete,archive,unarchive}`, `/workspaces/:workspace/session-groups`, and `/workspaces/:workspace/session/:id/organization`. For an untrusted secondary, group GET remains available; every group, session, and organization mutation remains trust-gated. Workspace-less batch and organization mutation routes remain primary-workspace-only for compatibility.

Query parameters:

| Field          | Required | Notes                                                                                                                                                                                           |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archiveState` | no       | `active` (default) or `archived`. Any other value returns `400 { code: "invalid_archive_state" }`.                                                                                              |
| `cursor`       | no       | Pagination cursor from the previous response.                                                                                                                                                   |
| `size`         | no       | Page size. Invalid values return `400 { code: "invalid_cursor" }` or the existing page-size validation.                                                                                         |
| `view`         | no       | Omit for the legacy recent list. `organized` opts into server-side pinned/group ordering and adds optional organization fields. Any other value returns `400 { code: "invalid_session_view" }`. |
| `group`        | no       | Only meaningful with `view=organized`. `all` (default), `pinned`, `ungrouped`, or a custom group id. Unknown group ids return `404 { code: "group_not_found" }`.                                |

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
      "hasActivePrompt": false,
      "isArchived": false
    }
  ],
  "nextCursor": 1772251200000
}
```

With `view=organized`, the daemon reads `<Storage.getProjectDir(cwd)>/session-organization.v1.json`, returns pinned sessions first, then activity time descending, and then `sessionId` for stable ties. The organized cursor is opaque base64url JSON and must not be reused with the legacy recent list. `pinned` is a virtual filter, not a group. `groupId: null` means ungrouped. Archived sessions keep their organization metadata, but `archiveState=archived&view=organized` still returns only archived sessions.

Additional fields may appear on each session when `view=organized`:

```json
{
  "isPinned": true,
  "pinnedAt": "2026-07-04T12:00:00.000Z",
  "groupId": "018f..."
}
```

Trusted active lists include live daemon overlay fields such as `clientCount` and `hasActivePrompt`. Untrusted-secondary and archived lists are storage-only: live overlay fields remain absent or false, and archived entries set `isArchived` to `true`. Empty array (not 404) when no sessions exist — a session-picker UI shouldn't error just because the workspace is idle.

### `GET /workspace/:id/session-groups`

List user-defined session groups for a workspace. The singular GET selector accepts any registered workspace id or URL-encoded canonical cwd. The plural GET alias is also available to an untrusted secondary and reads only the organization sidecar. Plural group mutations remain trust-gated, while singular group mutations retain their primary-only compatibility behavior. Pre-flight `caps.features.includes('session_organization')`.

Response:

```json
{
  "groups": [
    {
      "id": "018f...",
      "name": "Frontend",
      "color": "blue",
      "order": 0,
      "createdAt": "2026-07-04T12:00:00.000Z",
      "updatedAt": "2026-07-04T12:00:00.000Z"
    }
  ],
  "colorOptions": ["red", "orange", "yellow", "green", "blue", "purple"]
}
```

Colors are protocol tokens only; clients localize display names. No default color-named groups are created.

### `POST /workspace/:id/session-groups`

Create a custom session group. Strict mutation gate. Pre-flight `caps.features.includes('session_organization')`.

Request:

```json
{ "name": "Frontend", "color": "blue" }
```

`name` is trimmed, must be 1-64 characters, cannot contain control characters, and is unique within the workspace by case-insensitive trimmed comparison. Duplicate names return `409 { code: "group_name_conflict" }`. `color` must be one of the returned `colorOptions`.

Response:

```json
{
  "group": {
    "id": "018f...",
    "name": "Frontend",
    "color": "blue",
    "order": 0,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

### `PATCH /workspace/:id/session-groups/:groupId`

Update a custom session group. Strict mutation gate. Pre-flight `caps.features.includes('session_organization')`. Body fields are optional: `{ "name"?: string, "color"?: string, "order"?: number }`. Unknown group ids return `404 { code: "group_not_found" }`; duplicate/invalid names and colors use the same errors as create.

### `DELETE /workspace/:id/session-groups/:groupId`

Delete a custom session group. Strict mutation gate. Pre-flight `caps.features.includes('session_organization')`. Sessions referencing the group are cleared to `groupId: null`; pinned state is preserved. Response is `{ "deleted": true }` when a group was removed and `{ "deleted": false }` when the id did not exist.

### `POST /sessions/delete`

Hard-delete one or more persisted session JSONL files. The daemon first best-effort closes live sessions, then removes the active or archived JSONL. If both active and archived copies exist for the same id, both are removed. Worktree sidecars on both sides are cleaned; file history, subagent transcripts, and runtime sidecars are intentionally preserved.

Request:

```json
{ "sessionIds": ["<uuid>"] }
```

Response:

```json
{
  "removed": ["<uuid>"],
  "notFound": [],
  "errors": []
}
```

### `POST /sessions/archive`

Archive one or more sessions. Archive is a state transition, not deletion: the JSONL moves from `chats/<id>.jsonl` to `chats/archive/<id>.jsonl`. File history, subagent transcripts, and runtime sidecars stay in place. If a session is live, the daemon first performs a strict close and requires the ACP agent's close handler to flush the chat recording; if close or flush fails, the JSONL is not moved. Pre-flight `caps.features.session_archive`.

Request:

```json
{ "sessionIds": ["<uuid>"] }
```

`sessionIds` must be a non-empty string array with at most 100 ids. Duplicates are collapsed.

Response:

```json
{
  "archived": ["<uuid>"],
  "alreadyArchived": [],
  "notFound": [],
  "errors": []
}
```

`errors` entries have `{ "sessionId": "<uuid>", "error": "message" }`. Active and archived files with the same id are treated as a conflict and reported in `errors`; no file is overwritten.

### `POST /sessions/unarchive`

Restore archived sessions to the active directory. This does not resume the session by itself; it only moves `chats/archive/<id>.jsonl` back to `chats/<id>.jsonl`. After unarchive succeeds, clients may call `POST /session/:id/load` or `POST /session/:id/resume`.

Request:

```json
{ "sessionIds": ["<uuid>"] }
```

Response:

```json
{
  "unarchived": ["<uuid>"],
  "alreadyActive": [],
  "notFound": [],
  "errors": []
}
```

If an active JSONL already exists for the id, unarchive reports a conflict in `errors` and does not overwrite it. Archive or unarchive in flight for the same id returns `409 session_archiving` before starting the batch.

ACP-over-HTTP uses the same request and response bodies through vendor methods `_qwen/sessions/archive` and `_qwen/sessions/unarchive`. The REST route table maps `POST /sessions/archive` and `POST /sessions/unarchive` to those methods for ACP transports.

### Multi-workspace live-session routing

When `multi_workspace_sessions` is advertised, live-session operations identify their workspace from the `sessionId`; clients do not add a workspace selector to the URL. In addition to the existing owner-routed lifecycle operations, this applies to `PATCH /session/:id/metadata`, `POST /session/:id/recap`, `POST /session/:id/generate`, `POST /session/:id/btw`, `POST /session/:id/mid-turn-message`, `POST /session/:id/tasks/:taskId/cancel`, `POST /session/:id/goal/clear`, `POST /session/:id/continue`, `POST /session/:id/language`, `POST /session/:id/artifacts`, and `DELETE /session/:id/artifacts/:artifactId`. The daemon routes each request to the trusted runtime that owns the live session. An untrusted non-primary owner returns `403 untrusted_workspace`, a missing live owner returns `404 session_not_found`, and an ambiguous owner fails closed with `500 ambiguous_session_owner`.

This rule is live-session-only and does not make every workspace-less session route multi-workspace-aware. Persisted or archived operations use their documented workspace-qualified routes. `POST /session/:id/branch`, `POST /session/:id/fork`, and `POST /session/:id/cd` intentionally remain primary-only and return `non_primary_session_route_not_supported` for non-primary owners.

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

If queued prompts are unexpected in a multi-client deployment, first confirm
whether callers are sharing a default `sessionScope: "single"` session. For
independent per-thread conversations, create sessions with
`sessionScope: "thread"` so prompts serialize only within that thread.

### `DELETE /session/:id`

Explicitly close a live session. Force-closes even when other clients are attached — cancels any active prompt, resolves pending permissions as cancelled, publishes `session_closed` event, closes the EventBus, and removes the session from daemon maps. On-disk persisted sessions are NOT deleted — they can be reloaded via `POST /session/:id/load`. Pre-flight `caps.features.session_close`.

```bash
curl -X DELETE http://127.0.0.1:4170/session/$SID
# → 204 No Content
```

Idempotent: returns `404` for unknown sessions (same `SessionNotFoundError` shape as other routes).

> **`session_closed` event.** SSE subscribers receive a terminal `session_closed` event with `{ sessionId, reason: 'client_close', closedBy?: '<clientId>' }` before the stream ends. SDK reducers treat this identically to `session_died` (sets `alive: false`, clears `pendingPermissions`).

### `PATCH /session/:id/metadata`

Update mutable session metadata. Currently supports `displayName` only. Pre-flight `caps.features.session_metadata`. Grouping and pinning are intentionally not part of this route; use `PATCH /session/:id/organization` under `session_organization`.

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

### `PATCH /session/:id/organization` and `PATCH /workspaces/:workspace/session/:id/organization`

Update local session organization state through the existing mutation gate. Pre-flight `caps.features.includes('session_organization')`; the plural route additionally requires `workspace_qualified_rest_core`. On the plural route, `:workspace` resolves as an exact registered workspace id first and then as a URL-encoded canonical absolute cwd. The selected runtime must be trusted. Session existence and non-null `groupId` validation are scoped to that runtime's active persisted, archived persisted, and live session state and group store, with no fallback to the primary or another workspace. The legacy route remains primary-workspace-only.

Request:

```json
{ "isPinned": true, "groupId": "018f..." }
```

| Field      | Required | Notes                                                                                                |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `isPinned` | no       | Boolean. `true` sets `pinnedAt` if it was not already pinned; `false` clears `pinnedAt`.             |
| `groupId`  | no       | Custom group id or `null` for ungrouped. Unknown group ids return `404 { code: "group_not_found" }`. |
| `color`    | no       | A supported session color token, or `null` to clear the session color.                               |

Response:

```json
{
  "sessionId": "<uuid>",
  "groupId": "018f...",
  "color": "blue",
  "isPinned": true,
  "pinnedAt": "2026-07-04T12:00:00.000Z",
  "updatedAt": "2026-07-04T12:00:00.000Z"
}
```

This state is stored in the project-level session organization sidecar under the daemon runtime storage directory. It is not transcript content, does not update transcript `mtime`, is not exported with transcripts, and is preserved across archive/unarchive.

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

### `POST /session/:id/generate`

Capability tag: `session_generation`.

Run request-scoped text generation from a caller-supplied prompt. The request
does not read or mutate conversation history and exposes no tools. It prefers
the configured fast model, falling back to the session's main model if the fast
model is missing or cannot be resolved. The endpoint is task-agnostic;
translation is only one possible caller-defined prompt.

Request:

```json
{ "prompt": "Translate into Chinese: Hello" }
```

The response is `text/event-stream`. The server writes an initial SSE comment
immediately, followed by `started`, an optional `thinking` progress event, zero
or more `delta` events, and `done`. The `thinking` event carries no reasoning
content. A model failure after streaming starts produces an `error` event; it
does not retry with another model. Prompts are limited to 32 KiB of UTF-8 text.
Disconnecting the HTTP client cancels the generation request.

### Mutation: approval, tools, skills, init, MCP restart

The daemon exposes five mutation control routes that let remote clients change runtime posture without touching the daemon host's CLI. All five:

- Are gated by the **strict** mutation gate from PR 15. A daemon configured without a bearer token rejects them with `401 {code: 'token_required'}`. Configure `--token` (or `QWEN_SERVER_TOKEN`) before opting in.
- Accept and stamp the `X-Qwen-Client-Id` header (PR 7 audit chain). When the header carries a trusted id, the daemon emits `originatorClientId` on the corresponding SSE event so cross-client UIs can suppress echoes of their own mutations.
- Pre-flight each per-tag capability before exposing the affordance. Older daemons return `404` for the route.

The tool toggle, skill toggle, init, and MCP restart routes emit **workspace-scoped** events: every active session SSE bus receives the event, regardless of which session was attached when the mutation was triggered. `approval-mode` emits a **session-scoped** event because the change is local to one session's `Config`.

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

#### `POST /workspace/skills/:name/enable`

Capability tag: `workspace_skill_toggle`. The workspace-qualified form is `POST /workspaces/:workspace/skills/:name/enable`.

Toggle a loaded, user-invocable skill through the workspace `skills.disabled` list, matching the CLI `/skills` panel's Space-key behavior. Lookup is case-insensitive, while persistence and the response use the skill's canonical name. Existing disabled entries for skills that are no longer loaded are preserved, and duplicate/case-variant entries for the target are collapsed. A disable entry inherited from system defaults, user, or system scope locks the skill: workspace scope cannot override the merged union.

This is different from the ACP `qwen/skills/setEnabled` managed-skill operation and the `disable-model-invocation` frontmatter field. `skills.disabled` removes the skill from slash-command/model availability and rejects later skill execution. `disable-model-invocation: true` keeps direct user invocation available and only hides the skill from model invocation.

Request:

```json
{ "enabled": false }
```

Response (200):

```json
{
  "skillName": "review",
  "enabled": false,
  "changed": true,
  "activation": "applied",
  "sessionsRefreshed": 2,
  "sessionsFailed": 0
}
```

`activation` is `applied` when every active session refreshed, `deferred` when no ACP child exists (the persisted setting is used when one starts), and `partial` when at least one active session failed to refresh. Busy sessions are included. The daemon reloads workspace settings for the ACP child and every active session, notifies SkillManager consumers, and pushes `available_commands_update`. A request already sent to the model is not rewritten; subsequent validation, command snapshots, and model contexts use the new state. If persistence fails, no refresh or event is emitted. If a session refresh fails, the committed setting is retained. When the child returns per-session results, the session counts are exact. If the refresh control itself fails before returning those results, `sessionsFailed: 1` is a conservative lower bound indicating that the refresh request failed.

Errors:

- `400 {code: 'invalid_skill_name'}` — empty path parameter, or more than 256 characters.
- `400 {code: 'invalid_enabled_flag'}` — `enabled` missing or non-boolean.
- `403 {code: 'untrusted_workspace'}` — the selected workspace is not trusted.
- `404 {code: 'skill_not_found'}` — no loaded skill matches the name.
- `409 {code: 'skill_not_toggleable', reason: 'not_user_invocable' | 'inactive_extension' | 'locked', lockedScope?: 'system' | 'user' | 'systemDefaults'}` — the CLI panel would not allow the target to be toggled. `lockedScope` is present only when `reason` is `locked`.

The mutation reuses the workspace-scoped `settings_changed` event with `key: 'skills.disabled'`; it does not add a new event type.

#### `POST /workspace/init`

Capability tag: `workspace_init`. Pure file IO — no ACP roundtrip, **no LLM invocation**.

Scaffold an empty `QWEN.md` (or whatever `getCurrentGeminiMdFilename()` returns under `--memory-file-name` overrides) at the daemon's primary workspace root. Mechanical only — for AI-driven content fill, follow up with `POST /session/:id/prompt`.

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

#### `POST /workspace/mcp/reload`

Reload persisted MCP settings into the workspace discovery config and every
active session. The workspace-qualified form is
`POST /workspaces/:workspace/mcp/reload`.

Request body:

```json
{ "forceReconnectAll": true }
```

`forceReconnectAll` is optional and defaults to `false`, preserving
incremental reconciliation. When true, the daemon reconnects every eligible
configured MCP server after the settings reconciliation. Alternatively, pass
`forceReconnectWhich: ["server-a", "server-b"]` to reconnect only named
servers. The options are mutually exclusive. A forced reconnect causes each
transport to read credentials that another local Qwen Code process may have
written to token storage; it does not start an OAuth authorization flow.

The route returns `202 { "accepted": true }`; poll `GET /workspace/mcp` for
the final connection status. Invalid option values return 400.

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

| Param       | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxQueued` | no       | Per-subscriber **live frame backlog** cap. Range `[16, 2048]`, default 256. Replay frames force-pushed at subscribe time are exempt from the frame and byte caps; what actually consumes them is live events that arrive while the subscriber is still draining a large `Last-Event-ID: 0` replay. Bump for cold reconnects so the live tail doesn't trip the slow-client warning / eviction before the consumer catches up. The live serialized-byte cap is fixed daemon-side (default 2 MiB) and has no query parameter. Out-of-range / non-decimal / present-but-empty values return `400 invalid_max_queued` before the SSE handshake opens. Pre-flight `caps.features.slow_client_warning` — old daemons silently ignore the param. |

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
data: {"v":1,"type":"client_evicted","data":{"reason":"queue_overflow","droppedAfter":42,"queueSize":256,"maxQueued":256,"queuedBytes":1800000,"maxQueuedBytes":2097152}}

event: client_evicted    ← terminal frame for byte overflow, no id (synthetic)
data: {"v":1,"type":"client_evicted","data":{"reason":"queue_bytes_overflow","droppedAfter":43,"queueSize":1,"maxQueued":256,"queuedBytes":1900000,"maxQueuedBytes":2097152,"eventBytes":300000}}
```

The SSE-level `id:` / `event:` lines duplicate `envelope.id` / `envelope.type` for EventSource compatibility. Raw-`fetch` consumers (the SDK's `parseSseStream`) read everything off the JSON envelope and ignore the SSE preamble lines.

| Event type                | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_update`          | Any ACP `sessionUpdate` notification (LLM chunks, tool calls, usage)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `permission_request`      | Agent asked for tool approval                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `permission_resolved`     | Some client voted on a permission via `POST /permission/:requestId`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `permission_partial_vote` | (consensus only) A vote was recorded but quorum not yet reached. Carries `{requestId, sessionId, votesReceived, votesNeeded, quorum, optionTallies}`. Pre-flight `caps.features.permission_mediation`.                                                                                                                                                                                                                                                                                |
| `permission_forbidden`    | A vote was rejected by the active policy (`designated` mismatch, `local-only` non-loopback, or `consensus` voter not in snapshot). Carries `{requestId, sessionId, clientId?, reason}`. Pre-flight `caps.features.permission_mediation`.                                                                                                                                                                                                                                              |
| `model_switched`          | `POST /session/:id/model` succeeded                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `model_switch_failed`     | `POST /session/:id/model` rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session_died`            | Agent child crashed unexpectedly. **Terminal: SSE stream closes after this frame; the session is gone from `byId`.** Subscribers should reconnect via `POST /session` to spawn a fresh one.                                                                                                                                                                                                                                                                                           |
| `slow_client_warning`     | Subscriber-local: live frame backlog or live serialized-byte backlog ≥ 75% full. **Non-terminal** — the stream continues; the warning is a heads-up before eviction. Carries `{queueSize, maxQueued, lastEventId, queuedBytes?, maxQueuedBytes?, threshold?}` where `threshold` is `frames`, `bytes`, or `frames_and_bytes`. Fires ONCE per overflow episode; re-arms after both measurements drain below 37.5%. No `id` (synthetic). Pre-flight `caps.features.slow_client_warning`. |
| `client_evicted`          | Subscriber-local: queue overflow. `reason` is `queue_overflow` for the live frame cap and `queue_bytes_overflow` for the live serialized-byte cap. **Terminal: SSE stream closes after this frame** (no `id` — synthetic). Other subscribers on the same session continue.                                                                                                                                                                                                            |
| `stream_error`            | Daemon-side error during fan-out. **Terminal: SSE stream closes after this frame** (no `id` — synthetic).                                                                                                                                                                                                                                                                                                                                                                             |

Reconnect semantics:

- Send `Last-Event-ID: <n>` to replay events with `id > n` from the per-session ring (default depth **8000**, tunable via `qwen serve --event-ring-size <n>`).
- **Gap detection:** if `<n>` predates the oldest event still in the ring, the daemon emits an id-less `state_resync_required` frame before replaying the surviving suffix. The SDK latches `awaitingResync`; clients should call `POST /session/:id/load` and rebuild from the current bounded replay snapshot window. That snapshot may itself start with `history_truncated` when older in-memory replay entries were dropped; this marker is informational and must not start another resync loop.
- IDs are monotonic per session, starting at 1
- Synthetic frames (`client_evicted`, `slow_client_warning`, `stream_error`) intentionally omit `id` so they don't burn a sequence slot for other subscribers

Backpressure:

- Per-subscriber queue defaults to `maxQueued: 256` live items plus a daemon-owned 2 MiB live serialized-byte cap. Replay frames during reconnect, `slow_client_warning`, and `client_evicted` bypass both caps.
- Override only the frame cap via `?maxQueued=N` (range `[16, 2048]`) on the SSE request. There is deliberately no `?maxQueuedBytes`; clients cannot raise daemon memory budget.
- When a subscriber's live frame backlog or live byte backlog crosses 75% full the bus force-pushes a `slow_client_warning` synthetic frame to that subscriber (once per overflow episode; re-armed after both measurements drain below 37.5%). The stream stays open — the warning is a heads-up so the client can drain faster or detach + reconnect cleanly.
- If the live frame cap overflows, the bus emits `client_evicted` with `reason: "queue_overflow"`. If the live byte cap overflows, it emits `reason: "queue_bytes_overflow"`. In both cases the terminal frame is force-pushed and the subscription closes.

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

Capability tag: `auth_device_flow` (always advertised). Supported providers in
v1: `qwen-oauth`.

> [!note]
>
> Qwen OAuth free tier was discontinued on 2026-04-15. Treat `qwen-oauth` as the
> legacy v1 provider identifier in this protocol; new clients should prefer a
> currently supported auth provider when one is available.

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
| `packages/cli/src/serve/server.ts`                   | Express app assembly, middleware ordering, and remaining direct routes                                     |
| `packages/cli/src/serve/routes/*.ts`                 | Focused Express route groups, including session, SSE, workspace auth, workspace status, and file routes    |
| `packages/cli/src/serve/auth.ts`                     | bearer + Host allowlist + CORS deny                                                                        |
| `packages/cli/src/serve/acp-session-bridge.ts`       | CLI-local bridge compatibility facade for spawn-or-attach, per-session FIFO, and permission registry       |
| `packages/acp-bridge/src/status.ts`                  | read-only daemon status wire types + `ServeErrorKind` + `BridgeTimeoutError` + `mapDomainErrorToErrorKind` |
| `packages/cli/src/serve/env-snapshot.ts`             | pure helper that builds `/workspace/env` payloads from `process.*` state, including credential redaction   |
| `packages/acp-bridge/src/eventBus.ts`                | bounded async queue + replay ring                                                                          |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | TS client                                                                                                  |
| `packages/sdk-typescript/src/daemon/sse.ts`          | EventSource frame parser                                                                                   |
| `integration-tests/cli/qwen-serve-routes.test.ts`    | 18 cases, no LLM                                                                                           |
| `integration-tests/cli/qwen-serve-streaming.test.ts` | 3 cases, real `qwen --acp` child backed by the local fake OpenAI server (POSIX only; skipped on Windows)   |
