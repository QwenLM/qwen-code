# `qwen serve` HTTP protocol reference

Stage 1 of the [qwen-code daemon design](https://github.com/QwenLM/qwen-code/issues/3803). All routes live under the daemon's base URL (default `http://127.0.0.1:4170`).

## Authentication

When the daemon was started with `--token` or `QWEN_SERVER_TOKEN`, every request must carry:

```
Authorization: Bearer <token>
```

Without a configured token (loopback dev default) the header is optional. Token comparison is constant-time. 401 responses are uniform across `missing header` / `wrong scheme` / `wrong token`.

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

## Capabilities

Every Stage 1 daemon advertises 9 feature tags. Clients **must** gate UI off `features`, not off `mode` (per design §10).

```
['health', 'capabilities', 'session_create', 'session_list',
 'session_prompt', 'session_cancel', 'session_events',
 'session_set_model', 'permission_vote']
```

## Routes

### `GET /health`

Liveness probe. Returns `200 {"status":"ok"}` if the listener is up. No auth required even when a token is configured (heartbeat-friendly).

### `GET /capabilities`

```json
{
  "v": 1,
  "mode": "http-bridge",
  "features": ["health", "capabilities", "..."],
  "modelServices": []
}
```

Stable contract: when `v` increments the frame layout has changed in a backwards-incompatible way.

### `POST /session`

Spawn a new agent or attach to an existing one (under `sessionScope: 'single'`, the default).

Request:

```json
{
  "cwd": "/absolute/path/to/workspace",
  "modelServiceId": "qwen-prod"
}
```

| Field            | Required | Notes                                                                                                                                                                                                                           |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`            | yes      | Absolute path. Relative paths return `400`. Workspace paths are canonicalized via `realpathSync.native` (with a resolve-only fallback for non-existent paths) so case-insensitive filesystems don't fork sessions per spelling. |
| `modelServiceId` | no       | If omitted the agent uses its default model. If the workspace already has a session, this calls `setSessionModel` on the existing one and broadcasts `model_switched`.                                                          |

Response:

```json
{
  "sessionId": "<uuid>",
  "workspaceCwd": "/canonical/path",
  "attached": false
}
```

`attached: true` means a session for that workspace already existed and you're now sharing it.

Concurrent `POST /session` calls for the same workspace are **coalesced** to one spawn — both callers get the same `sessionId`, exactly one reports `attached: false`.

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

### `POST /session/:id/cancel`

Cancel the **currently active** prompt on the session. ACP-side this is a notification, not a request — the agent acknowledges by resolving the active `prompt()` with `cancelled`.

```bash
curl -X POST http://127.0.0.1:4170/session/$SID/cancel
# → 204 No Content
```

> **Multi-prompt contract:** cancel only affects the active prompt. Any prompts the same client previously POSTed and are still queued behind the active one will continue to execute. Multi-prompt queueing is a daemon-introduced behavior (not in ACP spec); the contract for queued prompts is "they keep running unless you cancel each, or kill the session via channel exit".

### `POST /session/:id/model`

Switch the active model for an existing session. Serialized through the per-session model-change queue.

Request:

```json
{ "modelId": "qwen-staging" }
```

Response:

```json
{ "modelId": "qwen-staging" }
```

On success, publishes `model_switched` to the SSE stream. On failure, publishes `model_switch_failed` (so passive subscribers see the failure, not just the caller). Re-races against the agent channel exit so a wedged child can't block the HTTP handler.

### `GET /session/:id/events` (SSE)

Subscribe to the session's event stream.

Headers:

```
Accept: text/event-stream
Last-Event-ID: 42        ← optional, replays from after id 42
```

Frame format:

```
id: 7
event: session_update
data: {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}

id: 8
event: permission_request
data: {"requestId":"<uuid>","sessionId":"<sid>","toolCall":{...},"options":[...]}

: heartbeat              ← every 15s, no payload

event: client_evicted    ← terminal frame, no id (synthetic)
data: {"reason":"queue_overflow","droppedAfter":42}
```

| Event type            | Trigger                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `session_update`      | Any ACP `sessionUpdate` notification (LLM chunks, tool calls, usage) |
| `permission_request`  | Agent asked for tool approval                                        |
| `permission_resolved` | Some client voted on a permission via `POST /permission/:requestId`  |
| `model_switched`      | `POST /session/:id/model` succeeded                                  |
| `model_switch_failed` | `POST /session/:id/model` rejected                                   |
| `session_died`        | Agent child crashed unexpectedly                                     |
| `client_evicted`      | Subscriber-local: queue overflow (terminal, no id)                   |
| `stream_error`        | Daemon-side error during fan-out (terminal, no id)                   |

Reconnect semantics:

- Send `Last-Event-ID: <n>` to replay events with `id > n` from the per-session ring (default depth 1000)
- IDs are monotonic per session, starting at 1
- Synthetic terminal frames (`client_evicted`, `stream_error`) intentionally omit `id` so they don't burn a sequence slot for other subscribers

Backpressure:

- Per-subscriber queue defaults to `maxQueued: 256` live items (replay frames during reconnect bypass the cap)
- On overflow the bus emits the `client_evicted` terminal frame and closes the subscription

### `POST /permission/:requestId`

Cast a vote on a pending `permission_request`. **First responder wins** — once one client answers, every other client trying to answer the same id gets `404`.

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

If the bridge iterator throws while serving an SSE subscriber, the daemon emits a terminal `stream_error` frame (no `id`):

```
event: stream_error
data: {"error":"<message>"}
```

The connection then closes.

## Environment variables

| Var                 | Purpose                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `QWEN_SERVER_TOKEN` | Bearer token. Stripped of leading/trailing whitespace at boot.                                               |
| `QWEN_E2E_LLM`      | Set to `1` to enable LLM-required integration tests in `integration-tests/cli/qwen-serve-streaming.test.ts`. |

## Source layout

| Path                                                 | Purpose                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `packages/cli/src/commands/serve.ts`                 | yargs command + flag schema                              |
| `packages/cli/src/serve/runQwenServe.ts`             | listener lifecycle + signal handling                     |
| `packages/cli/src/serve/server.ts`                   | Express routes + middleware                              |
| `packages/cli/src/serve/auth.ts`                     | bearer + Host allowlist + CORS deny                      |
| `packages/cli/src/serve/httpAcpBridge.ts`            | spawn-or-attach + per-session FIFO + permission registry |
| `packages/cli/src/serve/eventBus.ts`                 | bounded async queue + replay ring                        |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | TS client                                                |
| `packages/sdk-typescript/src/daemon/sse.ts`          | EventSource frame parser                                 |
| `integration-tests/cli/qwen-serve-routes.test.ts`    | 18 cases, no LLM                                         |
| `integration-tests/cli/qwen-serve-streaming.test.ts` | 4 cases, real `qwen --acp` child (`QWEN_E2E_LLM=1`)      |
