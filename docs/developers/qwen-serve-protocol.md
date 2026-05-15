# `qwen serve` HTTP protocol reference

Stage 1 of the [qwen-code daemon design](https://github.com/QwenLM/qwen-code/issues/3803). All routes live under the daemon's base URL (default `http://127.0.0.1:4170`).

## Authentication

When the daemon was started with `--token` or `QWEN_SERVER_TOKEN`, **every route except `/health` on loopback binds** must carry:

```
Authorization: Bearer <token>
```

Without a configured token (loopback dev default) the header is optional. Token comparison is constant-time. 401 responses are uniform across `missing header` / `wrong scheme` / `wrong token`.

**`/health` exemption** (Bctum): on loopback binds (`127.0.0.1` / `localhost` / `::1` / `[::1]`) `/health` is registered BEFORE the bearer middleware, so liveness probes inside the pod don't need to carry the token even when the daemon was started with `--token`. Non-loopback binds (`--hostname 0.0.0.0` etc.) gate `/health` behind the bearer like every other route — see the [`GET /health`](#get-health) section for the rationale.

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

## Capabilities

Every Stage 1 daemon advertises 9 feature tags. Clients **must** gate UI off `features`, not off `mode` (per design §10).

```
['health', 'capabilities', 'session_create', 'session_list',
 'session_prompt', 'session_cancel', 'session_events',
 'session_set_model', 'permission_vote']
```

## Routes

> **Stage 1 limitation — no `DELETE /session/:id`.** Sessions live until
> the agent child crashes (`session_died`), the daemon process exits, or
> a server-side `killSession` (used internally by orphan-cleanup) fires.
> HTTP clients have no explicit "close one session" route in Stage 1.
> An explicit `DELETE /session/:id` is on the Stage 2 polish list.

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
  "mode": "http-bridge",
  "features": ["health", "capabilities", "..."],
  "modelServices": [],
  "workspaceCwd": "/canonical/path/to/workspace"
}
```

Stable contract: when `v` increments the frame layout has changed in a backwards-incompatible way.

> **`modelServices` is always `[]` in Stage 1.** The agent uses its single default model service and doesn't enumerate it over the wire. Stage 2 will populate this from registered model adapters so SDK clients can build service-pickers; until then, do NOT rely on this field being non-empty.

> **`workspaceCwd`** is the canonical absolute path this daemon binds to (#3803 §02 — 1 daemon = 1 workspace). Use it to (a) detect mismatch before posting `/session` and (b) omit `cwd` on `POST /session` (the route falls back to this path). Multi-workspace deployments expose multiple daemons on different ports, each with its own `workspaceCwd`. Additive to v=1: pre-§02 v=1 daemons omit the field — clients that target older builds should null-check before consuming it.

### `POST /session`

Spawn a new agent or attach to an existing one (under `sessionScope: 'single'`, the default).

Request:

```json
{
  "cwd": "/absolute/path/to/workspace",
  "modelServiceId": "qwen-prod"
}
```

| Field            | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`            | no       | Absolute path matching the daemon's bound workspace. If omitted, the route falls back to `boundWorkspace` (read it off `/capabilities.workspaceCwd`). A mismatched non-empty `cwd` returns `400 workspace_mismatch` (#3803 §02 — 1 daemon = 1 workspace). Workspace paths are canonicalized via `realpathSync.native` (with a resolve-only fallback for non-existent paths) so case-insensitive filesystems don't reject sessions per spelling.                                                                                                                                                                          |
| `modelServiceId` | no       | Selects which configured _model service_ the agent will route through (the back-end provider — Alibaba ModelStudio, OpenRouter, etc). If omitted the agent uses its default. If the workspace already has a session, this calls `setSessionModel` on the existing one and broadcasts `model_switched`. Distinct from `modelId` on `POST /session/:id/model`, which selects the model **within** an already-bound service. The `modelServices` array on `/capabilities` is reserved for advertising configured services; in Stage 1 it is always `[]` (the agent's default service is used and not enumerated over HTTP). |

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

### `GET /workspace/:id/sessions`

List all live sessions whose canonical workspace matches `:id` (URL-encoded absolute cwd).

```bash
curl http://127.0.0.1:4170/workspace/$(jq -rn --arg c "$PWD" '$c|@uri')/sessions
```

Response:

```json
{
  "sessions": [{ "sessionId": "<uuid>", "workspaceCwd": "/canonical/path" }]
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

| Event type            | Trigger                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_update`      | Any ACP `sessionUpdate` notification (LLM chunks, tool calls, usage)                                                                                                                        |
| `permission_request`  | Agent asked for tool approval                                                                                                                                                               |
| `permission_resolved` | Some client voted on a permission via `POST /permission/:requestId`                                                                                                                         |
| `model_switched`      | `POST /session/:id/model` succeeded                                                                                                                                                         |
| `model_switch_failed` | `POST /session/:id/model` rejected                                                                                                                                                          |
| `session_died`        | Agent child crashed unexpectedly. **Terminal: SSE stream closes after this frame; the session is gone from `byId`.** Subscribers should reconnect via `POST /session` to spawn a fresh one. |
| `client_evicted`      | Subscriber-local: queue overflow. **Terminal: SSE stream closes after this frame** (no `id` — synthetic). Other subscribers on the same session continue.                                   |
| `stream_error`        | Daemon-side error during fan-out. **Terminal: SSE stream closes after this frame** (no `id` — synthetic).                                                                                   |

Reconnect semantics:

- Send `Last-Event-ID: <n>` to replay events with `id > n` from the per-session ring (default depth 4000)
- **Gap detection (client-side):** if `<n>` predates the oldest event still in the ring (e.g. you reconnect with `Last-Event-ID: 50` but the ring now holds 200–1199), the daemon replays from the oldest available event without raising. Compare the first replayed event's `id` against `n + 1`; any difference is the size of the lost window. Stage 2 will inject an explicit `stream_gap` synthetic frame on the daemon side; in Stage 1 detection is the client's responsibility.
- IDs are monotonic per session, starting at 1
- Synthetic terminal frames (`client_evicted`, `stream_error`) intentionally omit `id` so they don't burn a sequence slot for other subscribers

Backpressure:

- Per-subscriber queue defaults to `maxQueued: 256` live items (replay frames during reconnect bypass the cap)
- On overflow the bus emits the `client_evicted` terminal frame and closes the subscription

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
| `packages/cli/src/serve/eventBus.ts`                 | bounded async queue + replay ring                                  |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | TS client                                                          |
| `packages/sdk-typescript/src/daemon/sse.ts`          | EventSource frame parser                                           |
| `integration-tests/cli/qwen-serve-routes.test.ts`    | 18 cases, no LLM                                                   |
| `integration-tests/cli/qwen-serve-streaming.test.ts` | 3 cases, real `qwen --acp` child (skipped when `SKIP_LLM_TESTS=1`) |
