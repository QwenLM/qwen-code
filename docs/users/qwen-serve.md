# Daemon mode (`qwen serve`)

Run Qwen Code as a local HTTP daemon so multiple clients (IDE plugins, web UIs, CI scripts, custom CLIs) share one agent session over HTTP + Server-Sent Events instead of each spawning their own subprocess.

> **🚧 v0.16-alpha**: `qwen serve` first ships to npm in v0.16-alpha as **text-only chat / coding** with **local-only deployment**. Image / file attachments on the prompt path, containerized deployment (Docker / k8s / nginx reverse-proxy), and remote / multi-daemon hardening land in a follow-up patch when an enterprise pilot is committed. See [v0.16-alpha known limits](#v016-alpha-known-limits) for the full deferred list.

> **Status:** Stage 1 (experimental). The protocol surface is locked at the §04 routes table from issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803). Stage 1.5 (`qwen --serve` flag — TUI co-hosts the same HTTP server) and Stage 2 (in-process refactor + `mDNS`/OpenAPI/WebSocket/Prometheus polish) are immediately downstream.
>
> **Scope honesty:** Stage 1 is sized for **developers prototyping clients against the protocol surface** and for **local single-user / small-team collaboration**. Production-grade multi-client / long-running / network-flaky workloads (mobile companions, IM bots reaching 1000+ chats) need Stage 1.5+ guarantees that aren't in this release. See [Stage 1.5+ runtime guarantees](#stage-15-runtime-guarantees) for the full gap list and #3803 for the convergence roadmap.

## What it gives you

- **Built-in Web Shell UI** — `qwen serve` serves the browser-based Web Shell at its root (`http://127.0.0.1:4170/`) out of the box; run `qwen serve --open` to launch it in your browser automatically. It is served on the same origin as the API, so no second port or reverse proxy is needed. Pass `--no-web` for an API-only daemon.
- **Up to one primary ACP child plus one on-demand child per trusted secondary, many clients** — production attempts to preheat the primary bridge and retries on first use after failure; trusted secondary runtimes start their own child on demand, while untrusted secondaries never start one. Under the default `sessionScope: 'single'`, clients targeting the same workspace share one ACP session and collaborate on the same conversation, file diffs, and permission prompts.
- **Reconnect-safe streaming** — SSE with `Last-Event-ID` reconnect lets a client drop and pick up exactly where it left off (within the ring's replay window).
- **Paged persisted transcripts** — `GET /session/:id/transcript` returns the complete active on-disk transcript as replay pages without attaching a client or changing the live SSE replay window.
- **First-responder permissions** — when the agent asks for permission to run a tool, every connected client sees the request; whichever client answers first wins.
- **One daemon, one or more workspaces** — repeat `--workspace` to register isolated workspace runtimes under one listener. The first workspace is primary and remains the default for requests that omit `cwd`.
- **Experimental daemon-managed channels** — start with `qwen serve --channel <name>`, or start without a channel and select one later with `qwen channel set`. Workers are separate processes owned by the daemon lifecycle. Their selection can be queried, replaced, reloaded, and stopped without restarting the daemon.
- **Remote runtime control** — change a session's approval mode (`POST /session/:id/approval-mode`), toggle a tool (`POST /workspace/tools/:name/enable`) or loaded skill (`POST /workspace/skills/:name/enable`) per workspace, scaffold an empty `QWEN.md` (`POST /workspace/init`, mechanical only — does NOT call the model; for AI-fill, follow up with `POST /session/:id/prompt`), restart a single MCP server with a budget pre-check (`POST /workspace/mcp/:server/restart`), or add/remove MCP servers at runtime without a daemon restart (`POST /workspace/mcp/servers`, `DELETE /workspace/mcp/servers/:name`). The default token-less loopback listener can use all of them; the strict workspace mutations additionally require operator credentials in other deployment modes.
- **Session recap** ([#4175](https://github.com/QwenLM/qwen-code/issues/4175) follow-up) — fetch a one-sentence "where did I leave off" summary of an active session (`POST /session/:id/recap`). Wraps core's `generateSessionRecap` as a side-query against the fast model; pollutes neither the main chat history nor the SSE stream. Non-strict gate (same posture as `/prompt`); SDK helper `client.recapSession(sessionId)`.
  - **Known limit — token-cost amplification:** the route is a pure-cost endpoint (each call is an LLM side-query, no state benefit) and the daemon has no per-route rate limit in v1. On a no-token loopback default a buggy or malicious local client can spam it to burn tokens. Configure `--token` (and optionally `--require-auth`) on shared dev hosts before exposing the daemon.
  - **Concurrent recap safety:** two simultaneous `/recap` calls on the same session run two independent side-queries. `generateSessionRecap` reads a snapshot of the chat history via `GeminiClient.getChat().getHistory()` and feeds it to a separate `BaseLlmClient.generateText` call (via `runSideQuery`); it never appends to or mutates the session's `GeminiChat`. Safe to call from multiple clients without coordination.

## v0.16-alpha known limits

The first npm release of `qwen serve` (v0.16-alpha) is intentionally narrow — text-only chat / coding for developers running the daemon on their own machine. The list below makes the deferred surface explicit so adopters can plan around it; everything here is on the v0.16.x patch roadmap or a near-term follow-up release.

**Product surface — text-only:**

- ✅ Text prompts and text responses (chat, coding, tool calls, MCP integration)
- ❌ **Image / file attachments on the prompt path** — `MessageEmitter` currently only renders text; multimodal echo lands when an alpha target with image needs is committed (#4175 chiga0 #27 P0 item)
- ❌ **Streaming uploads** — same gating as multimodal

**Deployment surface — local-only:**

- ✅ Loopback (`127.0.0.1`, default) — no auth required, suitable for dev workstations
- ✅ Local launch via `systemd` / `launchd` / `nohup &` / `tmux` — see [Local launch templates](./qwen-serve-deploy-local.md)
- ✅ Bring-your-own bearer token via `QWEN_SERVER_TOKEN` env var ([Authentication](#authentication) for setup)
- ❌ **Containerized deployment** — Docker / Compose / Kubernetes / nginx reverse-proxy with TLS termination NOT in v0.16-alpha. Defers to v0.16.x once an enterprise pilot is committed (would otherwise rot from no-one-validating).
- ❌ **Multi-daemon coordination on one host** — one daemon can host several explicitly registered workspaces, but daemons do not coordinate with each other. Cross-host federation, instance-path token keying, and stale-token cleanup defer to v0.16.x.
- ✅ **Revocable Local Control pairing tokens** — `--local-control` mints a separate LAN pairing token owned by the daemon. General daemon token storage remains BYO-token.

**Hardening — minimum viable for local single-user:**

- ✅ Boot-time security gate (refuses non-loopback bind without a token, [PR 15 / #4236](https://github.com/QwenLM/qwen-code/pull/4236))
- ✅ Mutation-route auth gate, session-scoped permission routing (Wave 4 PRs)
- ✅ MCP guardrails + multi-client permission coordination (F2 / F3)
- ✅ **Prompt absolute deadline + SSE writer idle timeout** — opt-in via `--prompt-deadline-ms` and `--writer-idle-timeout-ms`; advertised through `prompt_absolute_deadline` and `writer_idle_timeout` when enabled.
- ✅ **HTTP rate limiting** — opt-in via `--rate-limit` and per-tier thresholds; advertised through `rate_limit` when enabled.
- ⏸️ **Prometheus metrics + load test harness** — defers to v0.17 F4 Phase-1 scale instrumentation when 30-50 active sessions becomes a real target.
- ⏸️ **`--max-body-size` CLI flag** — daemon enforces `express.json({ limit: '10mb' })` by default which comfortably covers text-only prompts (model context windows are well under 10 MiB of chars). Tunable via flag in v0.16.x.

For the deeper "what we won't fix in Stage 1" enumeration (single-host session-state mutation model + N parallel sessions sharing one ACP child inside each workspace runtime), see [Stage 1 scope boundaries](#stage-1-scope-boundaries--what-we-wont-fix-in-stage-15) below.

## Quickstart

### 1. Start the daemon (loopback, no auth)

```bash
cd your-project/
qwen serve
# → qwen serve listening on http://127.0.0.1:4170 (mode=http-bridge, workspace=/path/to/your-project)
# → qwen serve: trusted loopback mode; local callers have full API access without bearer authentication. Use --require-auth with QWEN_SERVER_TOKEN on shared or untrusted hosts.
```

The default bind is `127.0.0.1:4170`. Bearer auth is **off** and the primary listener is trusted, so local callers can use the full operator API. Route-specific workspace trust, session ownership, `X-Qwen-Client-Id`, permission, feature, validation, and resource checks still apply. The daemon registers the current working directory as its primary workspace; use an absolute `--workspace /path/to/dir` to override it, and repeat the flag to register additional isolated runtimes.

**Open the Web Shell UI.** Browse to `http://127.0.0.1:4170/` (or start the daemon with `qwen serve --open` to launch it automatically) for the full browser terminal — chat, diffs, commit history, tool calls, and permission prompts. The UI is served at the daemon root on the same origin as the API. The rest of this guide uses raw HTTP so you can script against the API directly.

For an authenticated single-user launch without manually creating a token, opt in explicitly:

```bash
qwen serve --open-with-auth
```

This loopback-only mode generates a 256-bit bearer token when neither `--token` nor `QWEN_SERVER_TOKEN` supplies one, then gives it to the opened Web Shell as a `#token=` URL fragment. The shell removes the fragment and keeps the credential in that tab's `sessionStorage`; refresh works, but closing the tab or restarting the daemon loses the credential. In CI, SSH, or another environment where auto-open is unavailable, the daemon starts and prints the fragment URL for manual opening. The printed URL is secret-bearing.

The flag is default-off, includes the browser-opening behavior, and requires the Web Shell, built Web Shell assets, and a loopback bind. Bare `qwen serve --open` remains token-less on loopback. In authenticated-open mode, normal API routes reject other local clients without the bearer; static Web Shell assets and loopback `/health` keep their existing pre-authentication behavior unless `--require-auth` is also set. For multiple clients or a reopenable Web Shell, use a stable shared token instead:

```bash
export QWEN_SERVER_TOKEN="$(openssl rand -hex 32)"
qwen serve --open
```

### 2. Sanity-check it

```bash
curl http://127.0.0.1:4170/health
# → {"status":"ok"}

curl http://127.0.0.1:4170/capabilities
# → {"v":1,"mode":"http-bridge","features":["health","daemon_status","capabilities","session_create",...],"workspaceCwd":"/path/to/your-project"}

curl http://127.0.0.1:4170/daemon/status
# → {"v":1,"detail":"summary","status":"ok","runtime":{...}}
```

The `workspaceCwd` field surfaces the primary compatibility workspace so clients can intentionally omit `cwd` on `POST /session`. Current clients should select a trusted entry from `workspaces[]` and send that entry's `cwd` when targeting a runtime explicitly.
The `limits.maxPendingPromptsPerSession` field advertises the active per-session prompt admission cap; `null` means the cap is disabled. `limits.maxTotalSessions` advertises the optional daemon-wide fresh-session cap; `null` means unlimited.

### Run channels from the daemon

```bash
# Start one configured channel under qwen serve
qwen serve --channel telegram

# Start several configured channels under daemon-owned workspace workers
qwen serve --channel telegram --channel feishu

# Start all configured channels
qwen serve --channel all

# Or start a token-protected daemon with no channel worker
QWEN_SERVER_TOKEN=secret qwen serve

# Enable or replace its runtime selection later
qwen channel set telegram --token secret
qwen channel set telegram feishu --token secret
qwen channel set all --token secret

# Inspect or stop daemon-managed channels
qwen channel status --daemon-url http://127.0.0.1:4170 --token secret
qwen channel stop --daemon-url http://127.0.0.1:4170 --token secret
```

This mode is experimental and daemon-managed. It does not replace the standalone `qwen channel start` command: without `--daemon-url`, existing `qwen channel start`, `stop`, and `status` behavior remains standalone. With `qwen serve --channel`, the daemon reserves the channel-service lease before listening and fails startup if the initial worker cannot become ready. Without `--channel`, it loads no channel runtime and reserves no channel-service lease until the first runtime PUT. If a ready worker later crashes, the daemon keeps running, relaunches it under a bounded restart policy, and reports its state (including `channel_worker_exited` warnings) in `GET /daemon/status`.

Runtime control is exposed as `GET`, `PUT`, and `DELETE /workspace/channel`; SDK helpers are `getChannelWorkerControl()`, `setChannelWorkerSelection()`, and `stopChannelWorker()`. PUT/DELETE/reload use the strict mutation gate: trusted-loopback primary callers may use them without a token, while other deployments require operator credentials. Runtime selections are deliberately ephemeral: PUT does not edit settings or the boot options, and a restart returns to the `qwen serve --channel` selection (or disabled when that flag is omitted). Named selections are trimmed and deduplicated in first-occurrence order; order is preserved because the first channel can affect shared model selection.

Daemon-backed `qwen channel set` and `qwen channel reload`, plus `status` and `stop` with `--daemon-url`, cannot discover a token generated by `--open-with-auth`. Use `QWEN_SERVER_TOKEN` and pass the same value with `--token` to those clients, or omit authenticated-open mode.

The daemon reads each channel's settings (tokens, `proxy`, per-channel `model`) when its worker starts. To re-read settings without changing the committed selection, call `POST /workspace/channel/reload` (SDK `client.reloadChannelWorker()`, or `qwen channel reload`). Reload re-resolves workspace ownership and restarts selected workers through the same rollback-safe reconcile path. The `channel_control` capability is present whenever runtime control is wired; `channel_reload` is present only while the manager is enabled. Persisted threads are restored from disk.

Each selected channel's `cwd` must resolve to a registered workspace, and channels are grouped by that owning workspace: a single-workspace daemon runs one worker (unchanged from before); a multi-workspace daemon (`--workspace` repeated) runs one worker per workspace that owns a selected channel, each bound to that workspace's cwd, `QWEN_DAEMON_WORKSPACE`, and env overlay. To host a channel in a non-primary workspace, define it in that workspace's own `.qwen/settings.json` (no `cwd` needed) or set an explicit `cwd` equal to the workspace path; a channel defined only in user/system scope with no `cwd` is ambiguous across workspaces and causes a boot error. `--channel all` stays primary-only (it hosts the primary workspace's channels) and cannot be combined with named channels.

Replacing a selection preflights configuration, ownership, and trust before stopping anything. It keeps workspace workers whose ordered selection is unchanged. If a changed worker cannot start, the daemon stops new workers and restores the old selection. If the daemon cannot confirm that an old child exited even after SIGKILL, it keeps the PID lease and refuses to create a duplicate worker. A worker is still considered ready when at least one requested adapter connects; PUT then returns `partial: true`, and `/daemon/status` reports `channel_worker_partial_connect` for the missing adapters.

When an adapter rejects `connect()`, current worker snapshots may include `startupFailures` entries with the channel, `phase: "connect"`, an optional adapter code, and a credential-redacted message. `qwen channel set`, `qwen channel reload`, and remote `qwen channel status --daemon-url …` print these reasons. If every adapter fails during a dynamic set or reload, the command receives `502 channel_worker_start_failed`; the response reasons describe that attempt and its `state` describes the result after rollback. The failed attempt is not retained by later status requests. At most 64 reasons are retained per worker startup, and adapter codes should be treated as diagnostic rather than stable categories. Initial `qwen serve --channel …` startup still exits when no adapter connects.

The daemon also exposes read-only runtime snapshots for client UIs and
operators: `GET /daemon/status`, `GET /workspace/mcp`,
`GET /workspace/skills`, `GET /workspace/providers`, `GET /workspace/env`,
`GET /workspace/preflight`,
`GET /workspace/:id/session-info`,
`GET /session/:id/status`, `GET /session/:id/context`,
`GET /session/:id/supported-commands`, and
`GET /session/:id/tasks`, `GET /session/:id/lsp`, and
`GET /session/:id/transcript`.

`GET /workspace/:id/session-info` (and the plural
`GET /workspaces/:workspace/session-info` twin) returns aggregate session
counts for a workspace: persisted `active` / `archived` / `total`, plus the
current in-memory `live` count when live state is available. Registered
untrusted secondary workspaces omit `live` because their catalog reads do not
query the live bridge. The paginated `GET /workspace/:id/sessions` list does
not include a total, so this is the dedicated surface for “how many sessions
exist?” — useful when scheduled or recurring tasks leave a large local store.

> ⚠️ **Disk scan — do not poll.** This endpoint walks local session JSONL
> files under the workspace chats directory. Responses always include
> `expensive: true` and `cost: "disk_scan"`. Call it infrequently (manual
> refresh, operator tooling, occasional UI load) — never on a tight timer or
> on every sidebar render. Prefer `GET /workspace/:id/sessions` for browsing
> pages and `GET /daemon/status` for live in-memory session counts. A response
> with `truncated: true` means the scan hit its safety limit or could not
> classify every candidate file, so persisted counts are lower bounds.

```bash
curl http://127.0.0.1:4170/workspace/$(python3 -c "import urllib.parse,os; print(urllib.parse.quote(os.getcwd(), safe=''))")/session-info
# → {"active":450,"archived":30,"total":480,"live":2,"expensive":true,"cost":"disk_scan"}
```

`GET /session/:id/status` returns the live bridge summary for a single session:
`sessionId`, `workspaceCwd`, `createdAt`, optional `displayName`, `clientCount`,
and `hasActivePrompt`. It answers `200` with the summary when the daemon holds a
live session with that id, and `404` (body `{ "error": …, "sessionId": … }`)
otherwise. Use it to poll whether one known session is still running
(`hasActivePrompt`) or how many clients are attached (`clientCount`) without
fetching and scanning the whole paginated session list:

```bash
curl http://127.0.0.1:4170/session/$SESSION_ID/status
# → {"sessionId":"…","workspaceCwd":"…","createdAt":"…","clientCount":1,"hasActivePrompt":false}
```

This is the raw live-session view, so `clientCount` and `hasActivePrompt` match
the corresponding entry in `GET /workspace/:id/sessions` — but the two routes
are not byte-identical. The list endpoint enriches each item with persisted
session-store data: its `createdAt` is the persisted first-prompt time, and it
adds `updatedAt` plus a `displayName` derived from the stored title or first
prompt. `/status` instead reports the live session's own `createdAt`, omits
`updatedAt`, and returns `displayName` only when one is set on the live session.

`GET /session/:id/lsp` returns structured per-session LSP status. Start the
daemon with `--experimental-lsp` to enable LSP in spawned agent sessions;
otherwise the route returns `enabled: false` with no servers.

`GET /daemon/status` is the consolidated troubleshooting snapshot. The default
`detail=summary` reads only in-memory daemon state (sessions, permissions,
SSE/ACP transport counts, rate limit rejects, process memory, resolved limits)
and does not start the ACP child. Use `GET /daemon/status?detail=full` for
per-session diagnostics, ACP connection details, auth device-flow counts, and
workspace status sections when you are actively investigating a problem.

`GET /workspace/mcp`, `GET /workspace/skills`, and `GET /workspace/providers`
report the live ACP runtime and do not start the ACP child when idle; an
idle daemon returns `initialized: false` with an empty snapshot. Once a
session is alive they switch to `initialized: true` and surface the real
state.

To update workspace Skill settings by name, call `POST /workspace/skills/:name/enable` with `{ "enabled": true | false }` after checking the `workspace_skill_settings_toggle` capability. To change several names, check `workspace_skill_settings_batch_toggle` and call `POST /workspace/skills/enable` with `{ "skillNames": ["review", "deploy"], "enabled": false }`; it processes every structurally valid name together, persists all resulting declaration changes in at most one locked settings write, and refreshes active ACP sessions once when anything changed. These routes write workspace `skills.disabled` and `skills.enabled` without consulting the loaded Skill catalog, so names may be disabled before installation or while their Extension is inactive. Enabling a name before installation can remove a matching workspace disable, normalize an existing workspace `skills.enabled` declaration to the requested casing, or write an explicit opt-in when an effective `skills.defaultDisabled` entry applies; with no existing workspace declaration and no such entry, enable is a no-op (`changed: false`). Their paths and request bodies are unchanged; the settings-specific capabilities replace the retired catalog-validated Skill toggle tags. The batch `errors` array remains for wire compatibility and is empty for structurally valid names. A hard `skills.disabled` entry inherited from a higher scope remains authoritative for effective availability, but does not block the workspace from recording or removing its own declaration. Skill status cells expose `disabledReason` (`hard`, `default`, or `inactive_extension`) and an optional `lockedScope`. Untrusted workspace writes are still rejected. A `deferred` response means no child was live at the liveness check or a changed request lost its child/session during the required refresh; when `changed` is true, the persisted declaration applies when a child starts. Whether a declaration actually changed is reported by `changed` (on each result for a batch request). `skills.disabled` disables both manual and model use, unlike `disable-model-invocation: true`, which keeps direct `/skill-name` invocation available. For V2 Extension batches, check `extension_batch_activation_v2`: `PUT /extensions/activation` changes global defaults, while `PUT /workspaces/:workspace/extensions/activation` changes exact overrides for the selected workspace and accepts `"inherit"` to clear them. Both accept names in `extensionNames`; `enabled` and `disabled` may be declared before installation, while `inherit` for an unknown name is a no-op. Each request returns one operation to poll.

`GET /workspace/env` and `GET /workspace/preflight` always answer with
`initialized: true` regardless of ACP state. `env` never consults ACP
(daemon-process info only); `preflight` answers daemon-level cells from
`process.*` and emits `status: 'not_started'` placeholders for ACP-level
cells when the child is idle.

`GET /workspace/env` reports the daemon process's runtime, platform, sandbox,
proxy, and the **presence** (never the value) of whitelisted secret env vars
such as `OPENAI_API_KEY`. Proxy URLs are stripped of credentials and reduced
to `host:port` before they hit the wire. The route always answers from the
daemon process directly and never spawns an ACP child.

`GET /workspace/preflight` returns a list of readiness checks. **Daemon-level
cells** (Node version, CLI entry, workspace directory, ripgrep, git, npm)
always render. **ACP-level cells** (auth, MCP discovery, skills, providers,
tool registry, egress) require a live ACP child — when the daemon is idle
they emit `status: 'not_started'` placeholders rather than spawning ACP just
to populate them. Failures map to a closed `errorKind` enum (`missing_binary`,
`auth_env_error`, `init_timeout`, `restore_timeout`, `protocol_error`, `missing_file`,
`parse_error`, `blocked_egress`) so client UIs can render structured
remediation.

The daemon also exposes workspace file helpers:

- `GET /file` reads text files. Full-snapshot responses return a raw-byte
  `sha256:<hex>` hash; finite-line windows from files above 256 KiB omit it.
- `GET /file/bytes` reads bounded raw byte windows and returns base64 content.
- `POST /file/write` creates or replaces text files.
- `POST /file/edit` applies one exact text replacement.

Write/edit are **strict mutation routes**: the token-less trusted-loopback
primary listener grants operator authority; non-trusted embeds without a
credential return `token_required`. Replacements
and edits require the latest `expectedHash` from a full-snapshot `GET /file`
(or a full-window `GET /file/bytes`). A partial large-file window cannot be
used as an optimistic-concurrency token. `create` never overwrites. Explicit
writes to ignored paths are allowed but audited. Binary writes,
delete/move/mkdir, and recursive parent creation are not part of this surface.

### 3. Open a session

```bash
curl -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -d '{}'
# → {"sessionId":"<uuid>","workspaceCwd":"…","attached":false}
```

`cwd` may be omitted — the route falls back to the daemon's primary workspace. Posting a `cwd` that does not canonicalize to any registered workspace returns `400 workspace_mismatch`.

A second client posting to `/session` for the same resolved workspace runtime gets `"attached": true` under the default `sessionScope: 'single'` — they are now sharing that runtime's agent session. Omitting `cwd` resolves to primary; selecting another registered workspace creates or attaches to that runtime's separate default session.

### 4. Subscribe to the event stream (in another terminal first)

```bash
SESSION_ID="<from step 3>"
curl -N http://127.0.0.1:4170/session/$SESSION_ID/events
# → id: 1
#   event: session_update
#   data: {"id":1,"v":1,"type":"session_update","data":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}}
```

The `data:` line is the **full event envelope** — `{id?, v, type, data, originatorClientId?}` — JSON-stringified on a single line. The ACP payload (the `sessionUpdate` block in this example) sits under `data` inside that envelope. The SSE-level `id:` / `event:` lines are convenience for EventSource clients; the same values appear inside the JSON envelope so raw-`fetch` consumers get them too.

Open this **before** sending the prompt — the SSE replay buffer holds the
last 8000 events so a late subscriber can catch up via `Last-Event-ID`,
but for the simple "watch a single prompt" case it's easiest to subscribe
first and let it stream live.

The stream emits `session_update` (LLM chunks, tool calls, usage),
`permission_request` (tool needs approval), `permission_resolved`
(someone voted), `model_switched`, `model_switch_failed`, and the terminal
frames `session_died` (agent child crashed — SSE then closes) and
`client_evicted` (your queue overflowed — SSE then closes).

### 5. Send a prompt (back in the original terminal)

```bash
curl -X POST http://127.0.0.1:4170/session/$SESSION_ID/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":[{"type":"text","text":"What does src/main.ts do?"}]}'
# → {"stopReason":"end_turn"}
```

The `curl -N` from step 4 will print frames as they arrive.

### Optional Todo Stop Guard

Long-running daemon clients can opt into a bounded continuation when the
current work chain successfully writes a top-level Todo list and then stops
with items still pending or in progress. Add this to `settings.json` and
restart the daemon:

```json
{
  "experimental": {
    "todoStopGuard": true
  }
}
```

The guard adds at most two consecutive primary-model calls without new user
input. A mid-turn user message runs first and starts a fresh two-attempt stage;
retry/continue and related background results retain the current stage's
budget. Every call and the final exhaustion state appear as replayable
`session_update` events with `_meta.source: "todo_stop_guard"`; the metadata
includes the attempt and unfinished count but never Todo text. A queued full
prompt also runs first, and existing permission/cancellation rules are
unchanged.

While an armed chain waits on related background work, unrelated cron/loop
fires and old-task notifications are deferred. Recurring work is bounded and
coalesced per task until the chain yields.

The option defaults to `false`, requires restart, and is forced off in safe
mode, bare mode, and Approval `plan` mode. It is in-memory only: loading Todo
state from disk or restarting the daemon does not arm it. A new ordinary prompt
must successfully run its own top-level `todo_write`; retry/continue and live
client reattach keep the current in-memory work chain. Successfully changing
the session working directory clears it so an old Todo cannot resume in a new
workspace.

## Authentication

For anything beyond loopback, you **must** pass a bearer token:

```bash
export QWEN_SERVER_TOKEN="$(openssl rand -hex 32)"
qwen serve --hostname 0.0.0.0 --port 4170
# → boot refuses without QWEN_SERVER_TOKEN
```

Clients then send `Authorization: Bearer $QWEN_SERVER_TOKEN` on every request. `/health` is exempted **only on loopback binds** so k8s/Compose liveness probes inside the pod (where the daemon listens on `127.0.0.1`) don't need credentials. On non-loopback binds (`--hostname 0.0.0.0` etc.) `/health` requires the token like every other route — otherwise an attacker can probe arbitrary addresses to confirm the daemon's existence. Use `/capabilities` to verify your token is correct end-to-end (it always requires auth):

> **Hardened loopback (`--require-auth`).** The default loopback no-token behavior is fine for a single-user laptop but unsafe on shared dev hosts, CI runners, or multi-tenant workstations where any local user can `curl 127.0.0.1:4170`. Pass `--require-auth` to make the bearer token mandatory on every route — including `/health` and `/capabilities` — even when bound to `127.0.0.1`. Boot fails without a token. With the flag on, an **unauthenticated** client can't read `/capabilities` to discover that auth is required; the discovery surface is the 401 response body itself. Once authenticated, the `caps.features.require_auth` tag is a post-auth confirmation that the deployment is hardened (useful for audit / compliance UIs):
>
> ```bash
> qwen serve --require-auth --token "$(openssl rand -hex 32)"
> # → /health, /capabilities, /session, … all require Authorization: Bearer …
> curl http://127.0.0.1:4170/health
> # → 401
> curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4170/capabilities | jq '.features | index("require_auth")'
> # → 13   (or whatever index — non-null after authenticating means the tag is present)
> ```

```bash
curl -H "Authorization: Bearer $QWEN_SERVER_TOKEN" http://your-host:4170/capabilities
# → {"v":1,"mode":"http-bridge","features":[...],"modelServices":[],"workspaceCwd":"/path/to/your-project"}
# Wrong token → 401
```

The token comparison is constant-time (SHA-256 + `crypto.timingSafeEqual`); 401 responses are uniform across "missing header", "wrong scheme", and "wrong token" so a side-channel can't distinguish.

`--open-with-auth` is a CLI-owned convenience, not another daemon token source: it selects `--token` when that option is defined (even if blank), otherwise `QWEN_SERVER_TOKEN`, then trims the selected value and generates only if the result is empty. The daemon does not persist the generated value or export it as `QWEN_SERVER_TOKEN`; the existing internal authenticated-child handoff remains unchanged. The Web Shell stores its browser copy only in the receiving tab's `sessionStorage`; this mode adds no cross-tab or external-client credential discovery mechanism. The token is not independently revocable or tied to a client identity. Possession grants the same daemon authority as any other bearer token. See the [authenticated Web Shell launch design](../design/2026-08-22-serve-open-with-auth.md) and related future work in [#4514](https://github.com/QwenLM/qwen-code/issues/4514).

## HTTPS / TLS (for mobile / cross-device access)

By default the daemon serves plain HTTP. That's fine on `localhost`, but a phone or tablet hitting a LAN IP (`https://192.168.x.x:4170`) is **not** a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) over `http://` — so browsers block `getUserMedia` (voice input), WebRTC, and other secure-context-only APIs. Pass `--tls-cert` + `--tls-key` to serve the Web Shell over HTTPS and unlock them:

```bash
# 1. Install a local CA and trust it (one-time). The mobile device must
#    also trust this CA — mkcert prints where the root cert lives.
mkcert -install

# 2. Generate a cert for your machine's LAN IP. Add localhost / 127.0.0.1 to
#    the SANs too: with `--open`, the daemon rewrites the browser URL to
#    127.0.0.1, so a cert scoped to only the LAN IP would be rejected with
#    ERR_CERT_COMMON_NAME_INVALID. (mkcert names the output after all hosts.)
mkcert 192.168.1.100 localhost 127.0.0.1

# 3. Start the daemon over HTTPS. Non-loopback binds still require a token,
#    and the browser Origin must be allowed through CORS.
qwen serve \
  --hostname 0.0.0.0 \
  --token "$(openssl rand -hex 32)" \
  --tls-cert "./192.168.1.100+2.pem" \
  --tls-key "./192.168.1.100+2-key.pem" \
  --allow-origin "https://192.168.1.100:4170"
# → qwen serve listening on https://0.0.0.0:4170
```

Notes:

- **Both flags or neither** — boot fails if only one is given (a cert with no key can't start an HTTPS listener).
- **TLS is orthogonal to auth** — HTTPS encrypts the transport; when a bearer token is configured, it still gates every API route. Non-loopback binds require a token with or without TLS.
- **Scope is TLS termination only** — no auto-generation, no ACME / Let's Encrypt. This is a LAN / dev convenience; for internet-facing deployments terminate TLS at a reverse proxy (see the threat model below).
- **Channel workers dial the daemon back over `https://`** — so they need to trust the serving certificate too. A self-signed cert (or a fullchain that carries its own root) needs nothing: the daemon injects it into each worker's `NODE_EXTRA_CA_CERTS`. The mkcert flow above is **CA-issued**, so the leaf alone cannot anchor the chain — export `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` in the daemon's launch environment before starting with `--channel`. An operator-set value is _merged_ with the daemon cert, not replaced. Without it the daemon boots green while every channel worker restart-loops on `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; the daemon log names the gap at boot.
- **An IPv6 wildcard bind is dialled back on the loopback this host actually assigns** — `--hostname ::` (or `[::]`) binds an IPv6 socket, and an empty `--hostname` binds one too when IPv6 is available (when it is not, Node falls back to binding `0.0.0.0`). That socket is dual-stack (Node pins `IPV6_V6ONLY=0` on it, so the `net.ipv6.bindv6only` sysctl does not change this), and both loopbacks usually reach it — but a host with no IPv4 at all has only `::1`, while a host that binds `::` yet carries no `::1` on its loopback (for example `net.ipv6.conf.lo.disable_ipv6=1`) has only `127.0.0.1`. Workers are sent to `[::1]` when this host assigns it and to `127.0.0.1` otherwise. A serving certificate for an IPv6 wildcard bind should carry both loopbacks in its SANs (`mkcert localhost 127.0.0.1 ::1` covers it); the boot trust diagnostic inspects the exact URL workers will dial and names the gap. `--hostname 0.0.0.0` is unchanged and still needs `127.0.0.1`.
- **Rotating `--tls-cert` in place needs a daemon restart** — the daemon serves the bytes it read at boot, so until it restarts, respawned workers can load newer contents than the daemon presents and their handshakes fail.

## CLI flags

| Flag                                    | Default            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`                            | `4170`             | TCP port. `0` = OS-assigned ephemeral port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--hostname <addr>`                     | `127.0.0.1`        | Bind interface. Anything beyond loopback requires a token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--local-control`                       | `false`            | Share the Web Shell on one selected private IPv4 interface with a daemon-owned revocable pairing token, terminal QR code, exact browser origin, and best-effort sleep inhibition. Composes with `--token`, `--allow-origin`, and `--port 0`; conflicts with `--no-web` and non-default `--hostname`. Use `--local-control-address` when multiple LAN candidates are available, and add `--tls-cert` + `--tls-key` for secure-context browser APIs such as voice input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--local-control-address <ip>`          | —                  | Which LAN IPv4 address to share when the host has more than one candidate. Only needed if `--local-control` reports an ambiguous choice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--token <str>`                         | —                  | Bearer token. Falls back to `QWEN_SERVER_TOKEN` env var (with leading/trailing whitespace stripped — handy for `$(cat token.txt)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--require-auth`                        | `false`            | Refuse to start without a bearer token, even on loopback. Hardens the `127.0.0.1` developer default for shared dev hosts / CI runners / multi-tenant workstations where any local user can hit the listener. Boots only with `--token` or `QWEN_SERVER_TOKEN` set; gates `/health` behind the bearer too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--enable-session-shell`                | `false`            | Enable direct session shell execution. Effective with either a configured bearer token or trusted-loopback mode; calls still require a valid session-bound `X-Qwen-Client-Id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--tls-cert <path>`                     | —                  | Path to a PEM certificate file. Serve over **HTTPS** instead of HTTP. Must be paired with `--tls-key` (boot fails if only one is given). Unlocks secure-context browser APIs — voice input (`getUserMedia`), WebRTC — over a LAN IP, which browsers otherwise block on plain `http://`. TLS termination only; no auto-generation / ACME. See [HTTPS / TLS](#https--tls-for-mobile--cross-device-access) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--tls-key <path>`                      | —                  | Path to a PEM private key file. Must be paired with `--tls-cert`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--max-sessions <n>`                    | `32`               | Cap on concurrent live sessions. New `POST /session` requests that would spawn a fresh child return `503` (with `Retry-After: 5`) when the cap is hit; attaches to existing sessions are NOT counted. Set to `0` to disable. Sized for single-user / small-team usage; raise it if your deployment has the RAM/FD headroom (~30–50 MB per session).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--max-total-sessions <n>`              | derived            | Optional non-negative integer daemon-wide cap on fresh session creation across all registered workspace runtimes. It applies to new child sessions, session restore, and branch/fork-created sessions; attaching to an existing live session does not consume a slot. Set to `0` for unlimited. When omitted with several startup/restored workspaces, the daemon derives a fixed cap from the per-workspace limit and the startup workspace count; later dynamic registration does not recompute it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--max-pending-prompts-per-session <n>` | `5`                | Per-session cap on prompts accepted by `POST /session/:id/prompt` but not yet settled, including queued prompts and the active prompt. The bridge rejects overflow synchronously with `503`, `Retry-After: 5`, and `code: "prompt_queue_full"` before returning a `promptId`. Set to `0` to disable. `branchSession` serializes on the same FIFO but does not count against this prompt cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--workspace <path>`                    | `process.cwd()`    | Absolute workspace directory registered by this daemon. Repeat the flag to host multiple workspaces in one process; the first is primary and remains the default when a request omits `cwd`. Relative values are rejected. Session requests whose canonical `cwd` is not registered return `400 workspace_mismatch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--memory-project-scope <mode>`         | `workspace`        | Project-memory partitioning mode. `workspace` (default) keys memory by the exact registered workspace directory so each daemon workspace gets its own isolated memory; `git-root` is the legacy compatibility mode shared by workspaces resolved to the same Git root. Overrides `QWEN_CODE_MEMORY_PROJECT_SCOPE` when provided; a blank env value is treated as unset, while an unrecognized non-empty value is ignored with a one-time warning and retains the legacy `git-root` behavior. The new default does not migrate existing git-root project memory — use an explicit `git-root` scope to read those entries during migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--channel <name\|all>`                 | —                  | Experimental daemon-managed channel worker. Repeat the flag to select multiple configured channels, or pass `all` to start every configured channel. `all` cannot be combined with named channels. Selected channel `cwd` values must resolve to a registered workspace; a multi-workspace daemon runs one worker per owning workspace. The worker is owned by `qwen serve`; stop the daemon to stop serve-managed channels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--max-connections <n>`                 | `256`              | Listener-level TCP connection cap (`server.maxConnections`). Bounds raw socket count irrespective of session count — slow / phantom SSE clients get rejected at accept time once full. Raise alongside `--max-sessions` if your deployment expects many SSE subscribers per session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--memory-budget-mb <n>`                | 50% of cgroup/host | Total memory budget in MB for the whole daemon process tree. When unset, derived as 50% of the cgroup limit or host memory; either way the effective value is capped at resolved available memory, and both the configured and effective figures are reported. It does not change how any `qwen --acp` child is sized; the one consumer today is adaptive live-journal growth: one daemon-wide growth pool derived as 5% of the effective budget (capped at `1024` MB; on hosts reporting `insufficientMemory` the pool is 0 and adaptive growth is disabled) is shared by every workspace bridge — see `--max-journal-bytes`. Resolved figures appear under `limits.memory` in `GET /daemon/status`, alongside registered and live child counts and advisory per-child shares under `runtime.memory`. A host too small for the minimum reports `insufficientMemory` rather than being clamped upward; because the derived fraction is 50%, any host under ~2 GB trips this. Pass an explicit `--memory-budget-mb 1024` on such a host to override the derived figure (the flag still requires at least 1024 MB of available memory to clear the warning). Must be an integer in `[1024, 1048576]`.                                                                                                |
| `--memory-pressure-mode <mode>`         | `observe`          | Whether the daemon turns its own memory reading into a verdict. `observe` (default) reports the pressure level under `runtime.memory.pressure` in `GET /daemon/status` and raises a `daemon_memory_pressure` issue — a `warning`, so the overall `status` leaves `ok` — whenever the level leaves `normal`. `off` still reports every figure, including the level, but raises no issue, so the overall `status` is unchanged; use it while calibrating, or if you alert on the top-level status. The level is the worse of two ratios: RSS against available memory (what the cgroup OOM killer watches) and V8 heap used against this process's heap ceiling. It covers the daemon root process only; compare it against `runtime.memory.children.rssBytes` for the children. Nothing remediates in either mode. One of `off`, `observe`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--child-heap-mode <mode>`              | `observe`          | Whether the daemon models a per-child heap partition of `--memory-budget-mb`. `observe` (default) reports what it would apply — `limits.memory.childHeap.perChildCeilingMb` and `maxConcurrentChildren` — and counts spawns that would have exceeded the limit. **Nothing is applied**: no child is sized from the budget and no spawn is refused. `off` models nothing, and says so on the wire: `maxConcurrentChildren` and `perChildCeilingMb` are both `null` rather than carrying a partition you switched off. A refusal count of 0 does **not** mean the partition would be safe to apply: children still run on the much larger host-derived ceiling, so a workload needing more old space than the modeled ceiling looks perfectly healthy here. Applying the partition ships with the measurement that can answer that.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--event-ring-size <n>`                 | `8000`             | Per-session SSE replay ring depth (#3803 §02 target). Sets the backlog available to `GET /session/:id/events` with `Last-Event-ID: N`. Larger = more reconnect headroom at the cost of a few hundred KB extra RAM per session. SDK clients can additionally request a larger per-subscriber backlog cap on a specific subscription via `?maxQueued=N` (range `[16, 2048]`, default 256). Daemons also emit a non-terminal `slow_client_warning` SSE frame at 75% queue fill so clients can drain / reconnect before getting evicted. Pre-flight `caps.features.slow_client_warning`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--compacted-replay-max-bytes <n>`      | `4194304`          | Per-live-session byte cap for the retained replay events in the bounded snapshot returned by `POST /session/:id/load`. The cap applies to `compactedReplay`; the current in-flight `liveJournal` is separately capped by `--max-journal-events` and `--max-journal-bytes` (baseline caps that adaptive growth can raise — see `--max-journal-bytes`). Values must be positive safe integers; invalid values fail at boot, and the hard ceiling is 256 MiB. When older retained replay is dropped, the snapshot begins with `history_truncated`. This does not limit the on-disk transcript.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--max-journal-events <n>`              | `10000`            | Per-session baseline cap on replay entries retained in the in-flight `liveJournal` for the current unfinished turn. Consecutive compatible text or thought chunks share an entry, with at most 256 source events per entry; other event boundaries are preserved. When exceeded, the daemon first tries adaptive growth (see `--max-journal-bytes`); if no headroom is granted or the grant does not cover the overshoot, the oldest entries are dropped and a `history_truncated` marker is prepended. The marker's `truncatedEvents` and `retainedEvents` counts describe source events. Must be a positive safe integer. Pinning this flag (or `--max-journal-bytes`) disables adaptive growth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--max-journal-bytes <n>`               | `8388608`          | Per-session baseline byte cap on the in-flight `liveJournal`, accounted from the serialized source events even when compatible chunks share a replay entry. When a turn outgrows the cap, adaptive growth raises the session's caps toward double (up to a per-session hard cap of 256 MiB, limited by the remaining pool headroom) while the growth granted across all of the daemon's live sessions fits in one shared growth pool sized at 5% of the daemon's effective memory budget — the `--memory-budget-mb` value when passed, capped at resolved available memory, otherwise 50% of auto-detected memory (see `--memory-budget-mb`) — capped at `1024` MB; on hosts reporting `insufficientMemory` the pool is 0 and adaptive growth is disabled. Growth happens on demand, and only as far as the pool allows; when it is refused, the pool is exhausted, or a grant does not cover the overshoot, the oldest entries are dropped whole (at least one entry is always kept), so the retained tail can be much smaller than the cap. Pinning this flag (or `--max-journal-events`) disables adaptive growth. Must be a positive safe integer. Defaults to 8 MiB.                                                                                                                          |
| `--mcp-client-budget <n>`               | —                  | Positive integer cap on live MCP clients. When `mcp_workspace_pool` is advertised, the cap and transports are shared per workspace runtime; when the tag is absent, the legacy per-session manager enforces it. Combine with `--mcp-budget-mode`. When unset, no accounting-driven enforcement (but `GET /workspace/mcp` still reports `clientCount`). Distinct from claude-code's `MCP_SERVER_CONNECTION_BATCH_SIZE`, which gates startup concurrency rather than total live clients. Pre-flight `caps.features.mcp_guardrails` and `caps.features.mcp_workspace_pool`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--mcp-budget-mode <m>`                 | `warn` / `off`     | How `--mcp-client-budget` is enforced. `warn` (default when budget set): no refusal, snapshot's `budgets[0].status` flips to `warning` at ≥75% of budget. `enforce`: connects past the cap are refused, per-server cell shows `disabledReason: 'budget'`, deterministic by `mcpServers` declaration order. `off` (default when budget unset): pure observability. Boot rejects `enforce` without a budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--external-tool-guard-mode <m>`        | `off`              | Managed ACP external pre-execution policy. `off` makes no provider calls and advertises no capability. `required` fails startup unless a compatible provider completes the v1 handshake, then fails every supported top-level tool invocation closed unless its single prepare request is allowed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--external-tool-guard-endpoint <url>`  | —                  | Origin-only loopback HTTP(S) provider URL used in `required` mode, for example `http://127.0.0.1:8787`. Paths, URL credentials, redirects, non-loopback hosts, and proxy routing are not accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--external-tool-guard-timeout-ms <n>`  | `3000`             | Integer `100..30000`; applies independently to the startup handshake and each prepare request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--http-bridge`                         | `true`             | Stage 1 mode: production attempts to preheat one primary `qwen --acp` child for compatibility and retries on first use after failure, while each trusted secondary can start one child on demand. Sessions targeting a runtime multiplex onto its child via ACP `newSession()`; untrusted secondaries cannot start ACP. Stage 2 native in-process becomes available later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--initialize-timeout-ms <n>`           | `10000`            | ACP child request timeout, including the `initialize` handshake (ms). Must be a positive integer up to `2147483647`. Values above the JS timer ceiling (`2^31-1`) are rejected at boot because Node silently compresses them to 1 ms. Cold-container deployments that need extra headroom for child startup can raise this; the same value governs `newSession`, workspace-status polls, and other ACP ext-method deadlines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--session-restore-timeout-ms <n>`      | `60000`            | ACP session load/resume deadline in milliseconds. Must be a positive integer up to `2147483647`; `0` is invalid. If omitted, the default is 60 seconds, raised to an explicitly supplied `--initialize-timeout-ms` when that value is larger; a shorter initialize timeout never lowers the restore budget. The SDK and WebUI add 10 and 15 seconds of client headroom. A timeout returns retryable `504 session_restore_timeout`; it does not imply that the daemon itself exited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--allow-origin <pat>`                  | —                  | T2.4 ([#4514](https://github.com/QwenLM/qwen-code/issues/4514)). Cross-origin allowlist for browser webui clients. Repeatable. Each value is `*` (any origin — boot refuses if no bearer token is configured; `--require-auth` on loopback is recommended so `/health` is also bearer-gated, since it is pre-auth on loopback by default; the Web Shell static assets stay pre-auth in every mode, so pass `--no-web` to remove them) or a canonical URL origin (`<scheme>://<host>[:<port>]`, no trailing slash / path / userinfo / query). **On token-less trusted loopback, every specifically allowed origin receives full operator API authority and startup warns about that grant.** Subdomain wildcards (`https://*.example.com`) are intentionally unsupported — list each subdomain explicitly, or use `*` with a configured token (and `--require-auth` for full hardening). Matched origins receive CORS response headers (`Access-Control-Allow-Origin`, `Vary: Origin`, methods, headers, max-age, and exposed `Retry-After`); unmatched origins still get a 403 with the same envelope as today's wall. `Origin: null` (sandboxed iframes, file:// docs) is always rejected, even under `*`. Pre-flight via `caps.features.allow_origin`. Loopback self-origin hits are unaffected. |
| `--web` / `--no-web`                    | `true`             | Serve the built Web Shell SPA at the daemon root (`GET /`, `/assets/*`, and `GET /session/<id>` document navigations). These entry points are registered **before** the bearer-auth gate — a browser can't attach a token to a `<script>` subresource or an address-bar navigation, and the shell carries no secrets. API requests follow the daemon's normal authority policy: configured tokens gate every route, while the token-less trusted-loopback primary listener has full operator access. The SPA deep-link fallback for all other paths sits behind the bearer middleware. On non-loopback binds a one-line stderr warning notes the UI is reachable without auth. Use `--no-web` for an API-only daemon. No effect when the build omits the Web Shell assets (the daemon logs a breadcrumb and runs API-only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--open`                                | `false`            | After the listener is up, open the Web Shell in your default browser at the daemon URL (with `#token=` appended as a URL fragment when a token is configured — a fragment is never sent to the server, keeping the token out of access logs and Referer headers). No-op with `--no-web`, or in headless / CI / SSH environments where no browser is available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--open-with-auth`                      | `false`            | Open the Web Shell with bearer authentication on loopback. Requires an enabled Web Shell and built assets. Reuses a configured token or generates a process-lifetime 256-bit bearer and delivers it in the Web Shell fragment. Browser-ineligible environments print the secret-bearing manual URL. Other clients need the same explicitly configured shared token instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

> **Memory project scope caveats.**
>
> - **Daemon vs. standalone CLI.** The flag or daemon launch environment sets
>   one frozen scope for every runtime owned by that daemon. A workspace `.env`
>   or `settings.env` cannot override it for one registered workspace. A
>   standalone `qwen` TUI still defaults to git-root scope; to keep both entry
>   points consistent, export `QWEN_CODE_MEMORY_PROJECT_SCOPE` in the shell or
>   service environment that launches them.
> - **Directory-name collisions.** The storage key is derived by
>   `sanitizeCwd`, which replaces every non-alphanumeric character with
>   `-`. Sibling directories that differ only in punctuation (e.g.
>   `feature_1` and `feature-1`) map to the same memory directory even
>   under `workspace` scope. Avoid such naming when relying on workspace
>   isolation.
> - **Normalization differs between flag and env var.** The environment variable
>   is trimmed and lowercased (`"  Workspace  "` works); the CLI flag is
>   matched case-sensitively by yargs `choices` (`--memory-project-scope
Workspace` is rejected). Use lowercase values when copying between the two.

### Built-in daemon Git relocation guard

Every managed daemon ACP session applies a built-in pre-execution guard for
model shell commands, independent of `--external-tool-guard-mode` and without
any capability advertisement. The daemon owns the bound workspace and the
session's current effective working directory; both are supplied from trusted
session state and never accepted from the ACP child.

The guard inspects the tools that run a shell command line — `run_shell_command`
and `monitor` — and denies a mutating Git
command before execution when its repository location resolves outside the
session's effective working directory. Relocation is recognized for literal
forms of `git -C <path>`, `git --git-dir[=]<path>`,
`git --work-tree[=]<path>`, leading
`GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_INDEX_FILE` assignments (also
when made through `export`/`declare`/`readonly`, which keep them in the
environment of every later command in the chain),
directory-shifting wrapper flags (`env -C`, `sudo -D`), and `cd`, `pushd`, or
`popd` builtins earlier in the same command chain. Common wrapper prefixes
(`sh -c`, `bash -c`, `eval`, `sudo`, `nohup`, `timeout`, `exec`, `command`,
`builtin`,
`env`, path-qualified `git` binaries, and `{ …; }` / `! …` shell syntax) are
unwrapped so the same policy applies to the inner Git invocation, and `$(…)`
or backtick substitution bodies are analyzed as commands of their own.

A sub-agent pinned to its own worktree is contained to that worktree rather
than to the session's directory; a shell call whose execution directory the
daemon cannot place is denied.

Relative targets resolve from the command's effective starting directory
(`arguments.directory` when present, otherwise the session's current effective
working directory) after canonical path resolution, including `.git` gitfile
redirects, symlinks, and per-worktree administrative directories. A relocated
target that cannot be fully resolved before execution — a dynamic target
(`$VAR`, backticks, `~`, globs), a path that does not exist yet, or an
unreadable indirection — is denied for mutating or unclassifiable subcommands.
A relocated target that cannot be resolved is denied whatever the subcommand
is — including the read-only ones. Relocated commands whose subcommand is one
of a small verified read-only set (`rev-parse`, `cat-file`) remain allowed
once the target resolves, unless the command carries command-executing `-c`
config, or
it carries a `--output`, `--textconv`, or `--filters` flag: those write a file
or run the target repository's configured drivers. Commands with no recognized
relocation keep their existing behavior.
Denials are final and are reported to the model as
`Daemon shell guard denied a mutating Git command…` for a resolved, dynamic,
or unresolvable repository location, and as
`Daemon shell guard denied a shell command…` when the command could not be
parsed, its payload could not be resolved, or an unrecognized program may run
a relocated Git command.

The guard is reliable against Git relocation written in the literal forms
above — the mis-targeted command this control exists for — and is
**best-effort, not a boundary**, against shell text written to defeat it:
constructions that hide the relocation from a static reader may pass, and new
ones will keep being found. Do not grant a daemon broader trust on the
strength of it. It does not interpret script files,
track environment variable values across commands, or analyze heredoc bodies
(Git-shaped text inside a heredoc can be denied even though the shell never
executes it). `/fork` and agent-backed workspace memory remember/dream remain
available under the built-in guard; they are only restricted while the
external provider mode below is active. An optional external tool guard
remains an additional policy and receives the same request only after the
built-in policy allows it.

### Required external Tool Guard

This opt-in is for managed ACP deployments that need an external allow/deny
decision at the final tool-executor boundary. It is fully dark unless
`--external-tool-guard-mode=required` is present:

```sh
export QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN='replace-with-local-secret'

qwen serve \
  --external-tool-guard-mode=required \
  --external-tool-guard-endpoint=http://127.0.0.1:8787 \
  --external-tool-guard-timeout-ms=3000
```

The provider must expose `POST /v1/handshake` and `POST /v1/prepare`, require
`Authorization: Bearer <token>`, return JSON, echo the supplied nonce or
request ID, and use protocol version `1`. The token must be non-blank, at most
8192 UTF-16 code units, and contain no control characters. Requests are limited
to 1 MiB, responses to 64 KiB, and optional denial reasons to 500 UTF-16 code
units without control characters. A successful prepare response is:

```json
{ "protocolVersion": 1, "requestId": "<echo>", "allowed": true }
```

A denial uses `allowed:false` and may add a short `reason`. For each supported
top-level tool invocation that passes existing permission and `PreToolUse`
gates and reaches the final execution boundary, Qwen Code sends one prepare
request and never retries it. An earlier permission/hook denial sends no
prepare request. Timeout, cancellation, transport failure, malformed or
mismatched responses, and explicit denial prevent the executor from running.
Each spawned ACP channel must also acknowledge that it installed the required
callback; a missing or incompatible acknowledgement rejects the channel before
Session creation.
The provider request carries `sessionId`, `promptId`, `toolCallId`, canonical
`toolName`, and final `arguments`; `toolCallId` is a correlation label, not an
authentication identity or standalone idempotency key.

Final arguments can contain sensitive application data. Treat them as such in
provider logs and audit storage.

`PreToolUse` hooks run before this final executor decision. Required Guard mode
does not authorize or sandbox hook behavior; deployments that need a boundary
around every possible side effect must disable hooks or govern their
implementations separately.

Slash-command actions also run before model/tool scheduling and are not Guard
invocations. Some built-ins can directly change files or settings. A managed
deployment that needs an all-effects boundary must reject slash-command input
or disable every non-approved command through `slashCommands.disabled` or
`--disabled-slash-commands`.

The v1 managed scope is top-level tools invoked by an active foreground
managed Prompt. Nested or delegating `agent`, `workflow`,
`create_sub_session`, `send_message`, direct `/fork`, and agent-backed
workspace memory remember/dream controls are rejected while required mode is
active. A top-level background shell or monitor start is still one guarded
invocation and its final arguments reach the provider, but this feature does
not continuously authorize the process or add a process-completion audit
protocol; a policy that requires foreground completion should deny those
shapes. Guarded MCP calls also disable automatic reconnect/replay after a
transport error. After a successful startup handshake, `/capabilities`
advertises `external_tool_guard`; its absence means clients must not assume
enforcement.

This feature does not authorize explicit daemon REST/ACP management calls;
those continue to use the daemon's existing authentication and route
contracts. It also does not make an allowed tool or shell command
deterministic or sandbox its internals; managed deployments must combine the
provider decision with their normal tool policy and isolation boundary.

> **Sizing the load knobs.** `--max-sessions` is the per-workspace fresh-session cap. `--max-total-sessions`, when set, is the daemon-wide fresh-session cap.
> Three other layers also limit load — when sizing for a high-concurrency
> deployment, tune them together:
>
> - **listener-level**: `--max-connections` / `server.maxConnections=256`
>   bounds raw TCP connections (slow-client back-pressure).
> - **per-session subscribers**: the EventBus caps SSE subscribers at
>   64 per session by default; the 65th client gets a terminal
>   `stream_error` and is closed.
> - **per-session prompt admissions**:
>   `--max-pending-prompts-per-session=5` bounds queued + active prompts
>   accepted for one session. Overflow gets `503` with `Retry-After: 5`.
> - **daemon-wide fresh sessions**: `--max-total-sessions=N` bounds fresh
>   session creation across the daemon. Overflow gets the same
>   `session_limit_exceeded` shape with `scope: "total"`.
> - **per-subscriber backlog**: a 256-frame queue per SSE client; an
>   over-capacity client gets a terminal `client_evicted` frame and is
>   closed (one slow consumer can't pin the daemon).
>
> These caps interact: each runtime is bounded by `--max-sessions`, while
> `--max-total-sessions` bounds their aggregate. The effective session ceiling
> is the lower of any finite daemon-wide cap and the aggregate per-runtime cap
> (treat that aggregate as unlimited if the per-workspace cap is unlimited). If
> neither is finite, there is no finite session ceiling. A finite ceiling × 64
> subscribers × 256 frames is the worst-case in-flight memory at the EventBus
> layer; multiplying it by
> `--max-pending-prompts-per-session` bounds accepted prompt work at the
> admission layer. Default sizing assumes single-user / small-team load; raise
> progressively (and watch RSS) for larger deployments.

> **MCP client guardrails (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14).** A workspace declaring 30 MCP servers in `mcpServers` will start 30 clients with no upstream cap unless you set one. `--mcp-client-budget=N` caps the live MCP client count; `--mcp-budget-mode={enforce,warn,off}` chooses the behavior. Default is `warn` when a budget is set (snapshot surfaces the warning but no client is refused — useful for measuring real-world fanout before flipping on enforcement). Refused servers under `enforce` mode get `disabledReason: 'budget'` on their per-server cell, and the `budgets[0]` cell shows `status: 'error'` + `errorKind: 'budget_exhausted'`. Slot reservation is by server name and survives reconnects / discovery timeouts — a refused server can't take a slot from a healthy one.
>
> **Current scope is capability-driven.** When `mcp_workspace_pool` is present, all sessions in one workspace runtime share its MCP transport pool and budget controller; `GET /workspace/mcp` emits `scope: 'workspace'`. A second workspace has an independent pool and budget. When the tag is absent (including `QWEN_SERVE_NO_MCP_POOL=1`), the daemon uses the legacy per-session `McpClientManager` and emits `scope: 'session'`; in that fallback, N sessions can each consume the configured cap.
>
> ```sh
> qwen serve --mcp-client-budget=10 --mcp-budget-mode=warn
> # later, after telemetry shows your real-world distribution:
> qwen serve --mcp-client-budget=10 --mcp-budget-mode=enforce
> ```
>
> This is **not** the same as claude-code's `MCP_SERVER_CONNECTION_BATCH_SIZE` (which gates startup concurrency); they are orthogonal. Clients must branch on `mcp_workspace_pool`, not assume a scope from the protocol version alone.
>
> **Push events (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14b).** SDK clients subscribed to `GET /session/:id/events` receive typed frames when budget thresholds cross — `mcp_budget_warning` (synthetic, fires once per upward 75% crossing with hysteresis re-arm at 37.5%, advertised via `mcp_guardrail_events`) and `mcp_child_refused_batch` (coalesced once per discovery pass under `enforce` mode; length-1 from `readResource` lazy-spawn refusal). The snapshot at `GET /workspace/mcp` is still the source-of-truth for state-after-reconnect; events are change-edges. Useful when dashboarding in real-time without polling.

## Default deployment threat model

- **127.0.0.1 only** — loopback bind, no auth needed.
- **`--hostname 0.0.0.0` requires a token** — boot refuses without one.
- **`LOOPBACK_BINDS` includes IPv6** — `::1` and `[::1]` count as loopback for the no-token rule.
- **Host header allowlist** — on **loopback** binds the daemon checks `Host:` matches `localhost:port` / `127.0.0.1:port` / `[::1]:port` / `host.docker.internal:port` (case-insensitive per RFC 7230 §5.4) to defend against DNS rebinding. **Non-loopback binds (`--hostname 0.0.0.0`) intentionally bypass the Host allowlist** — the operator has chosen the surface area, so the bearer-token gate is the sole authentication layer; reverse proxies / SNI / client cert pinning are the operator's responsibility, not the daemon's. If you need Host-based isolation on a non-loopback bind, terminate TLS + check Host at a front proxy.
- **CORS denies any browser Origin by default** — returns `403` JSON. Pass **`--allow-origin <pattern>`** (repeatable, T2.4 #4514) to opt specific browser origins through. Each value is either the literal `*` (any origin — boot refuses if no bearer token is configured; `--require-auth` on loopback is recommended for full hardening since `/health` remains pre-auth on loopback by default — note that the Web Shell static assets (`/`, `/assets/*`, `/session/:id` document navigations) are mounted before the bearer in every mode and stay pre-auth even under `--require-auth`, so use `--no-web` when the residual browser surface matters) or a canonical URL origin (`<scheme>://<host>[:<port>]`, no trailing slash / path / userinfo). Matched origins receive proper CORS response headers (`Access-Control-Allow-Origin: <echoed>`, `Vary: Origin`, plus standard methods / headers / max-age and exposed `Retry-After`); unmatched origins still get a 403 with the same envelope as the default wall. `caps.features.allow_origin` is advertised conditionally so SDK / webui clients can pre-flight whether the daemon honors cross-origin hits before issuing them. Example: `qwen serve --allow-origin http://localhost:3000 --allow-origin http://localhost:5173`. Loopback self-origin hits (e.g. the Web Shell UI) are unaffected — a separate Origin-strip shim handles them regardless of `--allow-origin`. **Browser webuis without `--allow-origin` configured** still fall back to the same Stage 1 options as before: package as a native shell (Electron/Tauri) so no `Origin` header is sent, or front the daemon with a same-origin reverse proxy.
- **Chrome extension browser automation is separate from framing.** `qwen serve --allow-origin chrome-extension://<id>` lets the extension frame the Web Shell and connect to the daemon. Console/network/screenshot/click tools require an external CDP MCP adapter command: `QWEN_CDP_MCP_COMMAND=/path/to/cdp-mcp-adapter qwen serve --allow-origin chrome-extension://<id>`. The main CLI package does not bundle a browser automation adapter; clients can check `caps.features.includes('browser_automation_mcp')` before presenting those tools as available.
- **A spawned `qwen --acp` child receives its owning runtime's effective environment.** The daemon freezes a process-env base, applies that workspace's settings/env-file overlay to a runtime-local snapshot, and never writes the overlay back to `process.env`; same-named keys in another runtime do not cross over. `QWEN_SERVER_TOKEN` is scrubbed before spawn because the agent does not need the daemon bearer. Loader-affecting variables (`NODE_OPTIONS`, `npm_config_node_options` and npm's config-file redirects, `NODE_PATH`, `OPENSSL_CONF`, `NODE_REPL_EXTERNAL_MODULE`, `npm_config_node_gyp`, `npm_config_init_module`, `LD_PRELOAD`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES`, `BASH_ENV`, `ZDOTDIR`, exported bash function definitions `BASH_FUNC_*`) are likewise never passed to session subprocesses — the daemon scrubs them from its own `process.env` and from the frozen base env that session-hosting children spawn with (the base env keeps them only under the `DEV=true` harness, whose `.ts` entries still need the tsx loader), and `.env` / `settings.json` `env` sources reject them (see [settings](./configuration/settings.md)); this applies to every session the daemon hosts. Base credentials such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `QWEN_*`, and `DASHSCOPE_API_KEY` otherwise pass through unless the runtime overlay changes them. **This is intentional, not a sandbox.** The agent runs as the same UID with shell-tool access, so anything in `~/.bashrc`, `~/.aws/credentials`, or `~/.npmrc` is reachable by prompt injection regardless. Environment isolation between runtimes is not an operating-system security boundary; do not run `qwen serve` under an identity that has credentials you would not trust the agent with.
- **Agent text reads are child-local and follow the regular CLI permission rules, not the workspace filesystem boundary.** Direct `read_file` can reach host text paths outside every registered workspace: external paths default to confirmation, and allow rules or approval modes may approve them automatically. Approved reads use the configurable CLI output limits rather than the workspace filesystem's returned-output, full-snapshot, and large-text scan caps. This applies to every shared text-read consumer, so the pre-reads performed by write, edit, notebook, sed, and artifact operations lose those caps together with the workspace filesystem's read audit, symlink rejection, and read-side TOCTOU protections — see [the read design](../design/daemon-local-text-reads.md) for the exact list. Because a confirmation payload is built by reading the file, an out-of-workspace diff is fanned out to **every** attached SSE subscriber before anyone approves it — in the interactive CLI that content is seen only by the person at the terminal. Treat authenticated daemon clients as the same security principal. HTTP filesystem routes remain workspace-scoped and agent discovery-tool behavior is unchanged.
- **Approved final writes from built-in text tools have a narrow same-host route.** `write_file`, `edit`, `notebook_edit`, and the shell tool's simulated sed editor attach internal provenance only after the existing permission policy allows execution. Their final ACP text write can therefore target an absolute path outside the owning workspace without a second confirmation; allow rules, AUTO/AUTO_EDIT and YOLO behave like the CLI, while rejection, Plan, Hook/Guard refusal and pre-execution cancellation do not send the final write. Cancellation after a tool has already entered a non-cancellable filesystem operation keeps that tool's existing behavior. Workspace targets still use WFS. External targets use a daemon host writer with the same trust snapshot, 5 MiB encoded limit, leaf-symlink rejection, canonical path lock, atomic rename, mode preservation, `0600` new-file mode by default (configurable — see [New-file mode for agent text writes](#new-file-mode-for-agent-text-writes)), generation guard and filesystem audit. HTTP writes, generic or unmarked ACP writes, injected bridge/workspace-registry/factory integrations and arbitrary shell redirection do not receive this exception. See [the external-write design](../design/daemon-external-tool-text-writes.md).
- **Per-subscriber bounded SSE queues** — a slow client that overflows its queue gets a `client_evicted` terminal frame and is closed; one stuck consumer can't pin the daemon.
- **Per-session prompt admission cap** — defaults to 5 accepted-but-unsettled prompts per session. A buggy client cannot enqueue unbounded prompt promises or temporary SSE waits for one session.
- **Graceful shutdown** — SIGINT/SIGTERM drain the agent children before closing the listener (10s deadline per child).

> ⚠️ **Stage 1 known gap — permissions are daemon-global, not per-session (BUy4H).** `pendingPermissions` lives at daemon scope; any client holding the bearer token can vote on any `requestId` for any session it can see (and SSE `permission_request` events carry the requestId in their payload). This is acceptable under the single-user / small-team trust model where every authenticated client is the same human or collaborators they trust. Stage 1.5 will move to `POST /session/:id/permission/:requestId` + session-scoped pending map + per-client identity (must-have #3 from the downstream review); until then, don't run `qwen serve` behind a bearer shared with untrusted parties.
>
> ⚠️ **Stage 1 known gap — `POST /session/:id/prompt` body capped at 10 MB (BUy4L).** Multimodal prompts containing images / PDFs / audio that exceed 10 MB will fail at body-parse time before route logic runs (no streaming, no mid-upload abort). Workaround: shrink the content client-side, or pass a path reference and let the agent read the file via `readTextFile`. Stage 1.5 will accept `multipart/form-data` or chunked encoding on `/prompt` so large prompts don't hit a cliff.
>
> ⚠️ **Stage 1 known gap — phantom SSE connections behind NAT.** The
> daemon detects dead clients via TCP back-pressure on heartbeats
> (15s interval). A client that vanishes WITHOUT a TCP RST (e.g. a
> NAT box silently dropping idle flows) keeps the kernel-level socket
> "alive" until Node's keepalive probes time out — typically ~2 hours
> on Linux defaults. On `--hostname 0.0.0.0` deployments behind such
> NATs, phantom SSE connections can accumulate and eventually hit the
> 256 `server.maxConnections` ceiling.
>
> Set [`--writer-idle-timeout-ms <n>`](#deadlines-and-writer-idle-timeout)
> (issue [#4514](https://github.com/QwenLM/qwen-code/issues/4514) T2.9)
> to close the gap with an explicit application-level idle deadline:
> when no write has successfully flushed for `n` ms the daemon emits
> a terminal `client_evicted` frame with
> `reason: 'writer_idle_timeout'` and closes the stream. The flag is
> off by default to preserve the legacy contract — operators on
> networks that swallow RSTs should pick a value well above the 15s
> heartbeat interval (e.g. `60000`–`300000`) so legitimate idle
> connections aren't evicted while genuinely stuck writers are
> reaped promptly. Pre-flight `caps.features.includes('writer_idle_timeout')`
> from your SDK to confirm the daemon supports it.

### Deadlines and writer idle timeout

Issue [#4514](https://github.com/QwenLM/qwen-code/issues/4514) T2.9 ships two opt-in flags that close the long-running / remote-deployment gaps the 15s heartbeat + AbortSignal don't cover. The shared permission-response timeout is listed here as well. All three are off by default.

| Flag                                   | Env var                             | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--prompt-deadline-ms <n>`             | `QWEN_SERVE_PROMPT_DEADLINE_MS`     | unset   | Server-side wallclock cap on a single `POST /session/:id/prompt`. On expiry the daemon aborts the prompt's AbortController and returns HTTP `504` with `{code:"prompt_deadline_exceeded", errorKind:"prompt_deadline_exceeded", deadlineMs:n}`. A per-prompt request body field `deadlineMs` can SHORTEN the effective deadline below the flag but never extend it. Capability tag (conditional): `prompt_absolute_deadline`.                                                                                                                                                                                                |
| `--writer-idle-timeout-ms <n>`         | `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` | unset   | Per-SSE-connection idle deadline. When no write has SUCCESSFULLY flushed for `n` ms — neither a real event nor the 15s heartbeat — the daemon emits a terminal `client_evicted` frame with `data.reason = 'writer_idle_timeout'` (mirrored on `data.errorKind`) and closes the stream. **Pick a value comfortably above the 15s heartbeat** (e.g. `30000`–`300000`) so legitimate idle streams aren't evicted; values `< 15000` WILL evict otherwise-healthy idle connections before the first heartbeat fires (intentional only for tests / short-lived dev sessions). Capability tag (conditional): `writer_idle_timeout`. |
| `--permission-response-timeout-ms <n>` | —                                   | `0`     | Shared wallclock for ordinary permission and `ask_user_question` responses in daemon mode. `0` or an omitted flag waits indefinitely; a positive integer imposes a deadline on both. Voter cancellation, session cancellation, and daemon shutdown still resolve pending interactions when the timer is disabled.                                                                                                                                                                                                                                                                                                            |

The prompt and writer flags accept a positive integer in milliseconds; `0`, `NaN`, non-integer, or negative values are rejected at boot with a clear error message. The permission-response timeout accepts `0` or a positive integer. For the two environment-backed deadlines, explicit `ServeOptions` fields win over env values. SDK consumers should pre-flight the matching capability tag before relying on the prompt and writer behaviors.

### New-file mode for agent text writes

Agent text writes (`write_file`, `edit`, `notebook_edit`, and the shell tool's simulated sed editor) publish through the daemon's atomic writer, which preserves an existing target's mode and — for **new** files — defaults to owner-only `0600`, ignoring the daemon process's umask. This fail-closed default is intentional: a fresh agent-created file is never group/world readable by accident, no matter how permissive the supervisor umask is.

Operators whose deployment convention is umask-driven (e.g. a systemd unit with `UMask=0002`, shared-group repositories) can opt new files into the standard POSIX handling with:

| Env var                    | Values              | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QWEN_SERVE_NEW_FILE_MODE` | `owner` \| `system` | `owner` | `system` creates NEW files at `0o666 & ~umask`, so agent-created files follow the daemon process's umask like any other process on the machine. `owner` keeps the umask-independent `0600` default. Values are case-insensitive; the literal `0600` is accepted as an alias for `owner` (no other octal modes are supported), and any other value is rejected with a stderr warning and the `0600` default is kept. |

Scope and limits:

- Applies to NEW files created by the text-write routes (workspace targets, the same-host external host writer, and HTTP text writes). Existing files always keep their on-disk mode — editing a `0600` secret keeps it `0600`, an executable keeps `+x`.
- Binary uploads (`POST /file/upload`) always create at `0600` regardless of this setting.
- The daemon reads the variable at workspace-filesystem construction; restart the daemon after changing it.

## Multi-session & multi-workspace deployment

Pass `--workspace` more than once to register several non-overlapping workspaces in one `qwen serve` process. The first path is primary. Each registered workspace owns an isolated runtime boundary, while the daemon-wide listener, authentication policy, and total-session limit are shared. Production attempts to preheat the primary ACP child for compatibility and retries on first use after failure; trusted secondaries start their own child on demand, and untrusted secondaries do not start ACP. Requests may select a registered workspace by canonical `cwd`; requests that omit `cwd` use the primary workspace. Use one daemon per user or security principal; workspace trust is an execution gate, not an ACL.

An untrusted secondary workspace is visible in Web Shell as `untrusted` and `read-only`. It can be expanded to inspect the persisted session catalog, but it cannot yet be selected or opened in Web Shell, resumed, used to create sessions, or fully exported. The REST API follows the existing bounded filesystem read policy and also exposes its persisted session-group catalog and, when `workspace_persisted_transcript` is advertised, its active persisted transcript through the bounded workspace-qualified pager. These reads do not include live runtime state or start an ACP child. Full workspace-qualified export requires a trusted workspace and the separate `workspace_session_export` capability. Trust the workspace and restart the daemon before using execution, mutation, or export features. An untrusted primary remains disabled in Web Shell.

Use separate daemon processes when you need a smaller fault or security boundary, independent bearer tokens, quotas, audit boundaries, operating-system isolation, or independent resource supervision. Multi-workspace mode is intended for one operator hosting several repos; it is not a multi-tenant isolation boundary. A single daemon token authorizes every route the daemon exposes, including the allowed read-only catalog for all registered workspaces.

> **Subscribe BEFORE posting `modelServiceId` on attach.** When a client `POST /session` with a `modelServiceId` and the workspace already has a session running a different model, the daemon issues an internal `setSessionModel` call — failures are NOT propagated as an HTTP error (the session stays operational on its current model). The visible failure signal is a `model_switch_failed` event on the session's SSE stream. If you call `POST /session` and only THEN open `GET /session/:id/events`, you'll miss the failure event and silently keep talking to the wrong model. Open the SSE stream first, or pass `Last-Event-ID: 0` on subscribe to replay the ring's oldest available event.

To handle multiple **users or security principals** (each with an independent token, quota, audit log, sandbox, or process fault boundary) or to scale beyond one process's reach (cold-start budget, FD count, RSS), spawn one daemon per principal behind an external orchestrator. Each such daemon may still host several workspaces for that principal. The orchestrator (multi-tenancy / OIDC / Quota / Audit / k8s) is **out of scope** for the qwen-code project — see issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803) "External Reference Architecture" for the design pointers.

## Loading and resuming a persisted session

The daemon exposes ACP's `session/load` and resume flow over HTTP, plus a separate read-only transcript pager:

| Route                                                   | Use when                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /session/:id/load`                                | The client has **no** useful local history rendered (cold reconnect, picker-then-open). For a live session, the daemon returns and injects the current bounded replay snapshot window; if older replay was dropped, the snapshot begins with `history_truncated`. Capability tag: `session_load`. |
| `POST /session/:id/resume`                              | The client already has the turns on screen and only needs the daemon-side handle back. Model context is restored on the agent side without UI replay — the SSE stream stays clean. Capability tag: `session_resume` (`unstable_session_resume` remains a deprecated alias for older clients).     |
| `GET /session/:id/transcript`                           | The client needs the complete active persisted transcript. It returns id-less replay frames in cursor pages and does not call `/load`, attach a client, seed the live EventBus, create a live session, or change the live replay window. Capability tag: `session_transcript`.                    |
| `GET /workspaces/:workspace/session/:id/transcript`     | The client needs an active persisted transcript from a selected workspace without starting ACP or loading workspace settings. Registered untrusted secondary workspaces may use this read-only path. Capability tag: `workspace_persisted_transcript`.                                            |
| `GET /workspaces/:workspace/session/:id/export`         | The client needs a complete `html`, `md`, `json`, or `jsonl` attachment from a selected trusted workspace. It reads active persisted storage without starting ACP or falling back to primary. Capability tag: `workspace_session_export`.                                                         |
| `GET /workspaces/:workspace/session/:id/archive/export` | The client needs the same attachment formats from archived persisted storage in a selected trusted workspace. It does not unarchive, start ACP, or fall back to an active or primary session. Capability tag: `workspace_archived_session_export`.                                                |

For load and resume, the TypeScript SDK exposes static factories on
`DaemonSessionClient`:

```ts
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk';

const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:4170' });

// Cold reconnect — daemon will replay the bounded snapshot window through SSE.
const session = await DaemonSessionClient.load(client, 'persisted-id');

// Or, if your UI already has the history, skip the replay:
// const session = await DaemonSessionClient.resume(client, 'persisted-id');

for await (const event of session.events()) {
  // First the replayed `session_update` frames (load only),
  // then live events.
}
```

Pre-flight `caps.features.session_load`, `caps.features.session_resume`, or `caps.features.session_transcript` before calling the matching route — older daemons return `404`. `unstable_session_resume` is still advertised as a deprecated compatibility alias. Concurrent same-action requests for the same id coalesce; cross-action races (a `load` racing a `resume`) and caller-supplied-id spawns racing a restore get `409 restore_in_progress` with `Retry-After: 5`. A restore that exceeds `limits.sessionRestoreTimeoutMs` gets retryable `504 session_restore_timeout` with a budget-derived `Retry-After` (clamped to 5-120s); the still-running child request remains fenced until cleanup settles, and same-id retries during that window get `409 restore_in_progress` with `reason: awaiting_abandoned_cleanup` and a budget-derived `Retry-After` clamped to 5-120 seconds instead of a fixed 5-second delay. If cleanup is uncertain, or the abandoned restore has still not settled a full restore budget after its deadline, fresh session work temporarily gets `503 acp_channel_unavailable` with `reason: restore_cleanup_failed` or `restore_settlement_overdue`, while already-live sessions remain usable. See the [protocol reference](../developers/qwen-serve-protocol.md) for the full error envelope.

For full persisted replay, page with `DaemonClient.getSessionTranscriptPage(sessionId, { cursor, limit })` or the raw REST route:

```bash
curl "http://127.0.0.1:4170/session/$SESSION_ID/transcript?limit=100"
```

For a registered workspace, use `client.workspaceById(workspaceId).getSessionTranscriptPage(sessionId, { cursor, limit })` or `/workspaces/:workspace/session/:id/transcript`. The workspace-qualified method always uses native REST even when the SDK client has a replaceable ACP transport. Its cursors are daemon-lifetime-only and must be restarted from page one after a daemon restart.

For a full attachment from a trusted registered workspace, pre-flight `workspace_session_export` and call `client.workspaceById(workspaceId).exportSession(sessionId, { format: 'html' })` or the raw `/workspaces/:workspace/session/:id/export` route. Do not infer support from `session_export` or `workspace_qualified_rest_core`: older daemons can advertise both while retaining primary-only export. The current Web Shell export action remains primary-only; use the SDK or REST route for another workspace.

For an archived attachment, pre-flight `workspace_archived_session_export` and call `client.workspaceById(workspaceId).exportArchivedSession(sessionId, { format: 'html' })` or `/workspaces/:workspace/session/:id/archive/export`. This path reads archived storage in place and returns `409 session_not_archived` for an active-only id; it does not unarchive the session. Web Shell exposes the same export for archived rows in trusted primary and secondary workspaces when the capability is present.

`limit` counts active chat records, not emitted replay frames; one record can produce several `session_update` events. The first response freezes the JSONL snapshot size and returns `nextCursor` while `hasMore` is true. Later pages ignore appends after page 1, but return `409` if the file is deleted, truncated, replaced, archived, or otherwise conflicts with the frozen cursor. Very large snapshots return `413 transcript_too_large` before indexing so the daemon does not scan unbounded transcript files on the request path.

For repeated paging through the legacy singular route, set `--channel-idle-timeout-ms` to a positive value. With the default `0`, an idle workspace's ACP child — and the in-process transcript index cache it holds — is reaped after every page, so each page re-spawns the child and rebuilds the index by re-scanning the whole frozen prefix (`O(snapshotSize)` per page). A positive timeout keeps the child alive across the cursor walk so it reuses its cached transcript index and replay config. The workspace-qualified persisted route never starts an ACP child and is unaffected by this timeout.

Note: live-session history replay is bounded twice: by the SSE ring for `Last-Event-ID` reconnects and by `--compacted-replay-max-bytes` for the snapshot returned by `POST /session/:id/load`. Long histories with chatty turns can exceed either bound. The daemon surfaces snapshot truncation with `history_truncated`; use `/transcript` when you need the complete active persisted history.

## Durability model

**Sessions are still ephemeral in Stage 1 across daemon restarts**, but persisted sessions on disk can be reloaded:

- A child process crash publishes `session_died` and removes the live session from the daemon's maps. The persisted on-disk session **can** be reloaded via `POST /session/:id/load` if a fresh agent child is spawnable.
- A daemon restart loses every in-flight live session. The persisted sessions remain on disk and can be loaded against a new daemon process, subject to the same workspace binding rules.
- Long client disconnects (>5 min on a chatty turn) can outrun the SSE replay ring (default 8000 frames) — `Last-Event-ID` reconnect triggers `state_resync_required`. For mobile / flaky-network clients, plan to re-open SSE on long drops or call `POST /session/:id/load` to recover the current bounded replay snapshot; do not assume that route returns the full transcript.
- File operations (`writeTextFile`) are atomic across crashes (write-then-rename); they aren't atomic across daemon restarts in the sense of replaying — the file write either landed or it didn't.

If your integration needs server-side cross-restart durability beyond what `session/load` covers (e.g. server-managed retry queues), you still need application-level state recovery. Don't hold long-running, restart-sensitive state inside the daemon's session.

## Stage 1.5+ runtime guarantees

Stage 1's contract is sized for prototyping. Per [#3889 chiga0 downstream-consumer review](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427875644), the following are **not** in Stage 1 — production-grade integrations need Stage 1.5+ before relying on them:

**Blockers for serious downstream use:**

1. **`loadSession` / `unstable_resumeSession` over HTTP** — without this, no integration can survive a child crash or daemon restart, and any orchestrator coordinating the daemon can't recover state either.
2. **Persistent client identity (pair tokens + per-client revocation)** — Stage 1 uses one shared bearer; a leaked token revokes everyone, and `originatorClientId` is client-self-declared rather than daemon-stamped from authenticated identity.

**Reliability baseline:**

3. ~~**Client-initiated heartbeat path**~~ — shipped via [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 9. `POST /session/:id/heartbeat` records last-seen timestamps on the daemon (capability tag `client_heartbeat`); SDK helpers are `DaemonClient.heartbeat()` / `DaemonSessionClient.heartbeat()`.
4. **`permission_already_resolved` event** when a vote loses the first-responder race — currently UIs have to infer state from a `404`.
5. ~~**Larger replay ring**~~ — bumped to 8000. **Per-session-configurable ring** still open — mobile / chatty-turn workloads may need per-session overrides.
6. **`slow_client_warning` event before `client_evicted`** — soft backpressure so well-behaved slow clients can self-throttle (trim render depth, drop chunks) before being terminated.

**Integration ergonomics:**

7. **`POST /session/:id/_meta` for IM-style context** — per-session key-value attached to subsequent prompts (chat id, sender, thread id) replaces the per-channel improvisation.
8. **`/capabilities` actual feature negotiation** — `protocol_versions: { acp: '0.14.x', daemon_envelope: 1 }` so clients can detect drift instead of falling through to "unknown frame, ignore".
9. **First-class durability documentation** (this section) — already shipped above.

The full convergence roadmap is tracked on [#3803](https://github.com/QwenLM/qwen-code/issues/3803).

## Stage 1 scope boundaries — what we won't fix in Stage 1.5

Two structural choices are explicit non-goals for the Stage 1 / 1.5 / 2 main-line roadmap. If your use case depends on either, plan around them rather than waiting for us.

### Session state is local-mutation-only (per [LaZzyMan review #4270256721](https://github.com/QwenLM/qwen-code/pull/3889#pullrequestreview-4270256721))

The Stage 1.5 plan describes TUI as an in-process EventBus subscriber. In practice **TUI UI is strictly larger than the wire protocol**:

- **Local-only UI** — the ~15 Ink dialog components (`ModelDialog`, `MemoryDialog`, `PermissionsDialog`, `SessionPicker`, `WelcomeBackDialog`, `FolderTrustDialog`, …) and the `local-jsx` slash commands (`/ide`, `/auth`, `/init`, `/resume`, `/rename`, `/delete`, `/language`, `/arena`, …) render terminal-specific Ink JSX. Remote clients on HTTP/SSE can't equivalently render Ink, and these flows emit no wire event.
- **Session-state mutations without wire events** — `/approval-mode`, `/memory add`, `/mcp add-server`, `/agents`, `/tools enable/disable`, `/auth`, `/init` (writing `CLAUDE.md`) all change agent behavior, but only `/model` currently publishes an event (`model_switched`).

**Stage 1 choice — option (A) from the review**: don't promote these mutations to wire events. The two deployment modes have different consequences.

#### Mode 1 — headless `qwen serve` (this PR)

No TUI shell runs inside the daemon. The slash commands listed above **don't exist** in this mode — there's no terminal UI to issue them from. Session state is therefore:

- **Boot-time-frozen** for `approval-mode` / `memory` / `agents` / `tools` allowlist / `auth` — all loaded from settings + disk when the daemon's `qwen --acp` child starts; immutable for the session's lifetime. Settings-defined MCP servers are likewise frozen at boot, but **runtime-added servers** (via `POST /workspace/mcp/servers`) can be added or removed without restart.
- **Mutable over HTTP** via `POST /session/:id/model` (publishes `model_switched`), `POST /workspace/mcp/servers` / `DELETE /workspace/mcp/servers/:name` (publishes `mcp_server_added` / `mcp_server_removed`), and permission votes (`POST /permission/:requestId`).

**Consequence:** remote clients in headless mode see the **full session state**. No TUI hides additional state; no drift is possible. If you want to change `approval-mode`, restart the daemon with new settings. MCP servers can now be added/removed at runtime via the mutation routes (`POST /workspace/mcp/servers`, `DELETE /workspace/mcp/servers/:name`) — see [Runtime MCP server management](#runtime-mcp-server-management-issue-4514).

#### Mode 2 — Stage 1.5 `qwen --serve` co-hosted TUI (not in this PR)

When Stage 1.5 lands `qwen --serve` (TUI process co-hosts the same HTTP server), the TUI **does** exist alongside remote clients. A local operator typing `/approval-mode yolo` or `/mcp add-server` mutates session state, and remote clients on HTTP have no event to observe the change.

In this mode, TUI is a **"super-client"** — it observes the same agent conversation remote clients see, AND can mutate session state remote clients can't. The asymmetry is:

- ✅ Both TUI and remote clients see the same agent messages, tool calls, file diffs, permission prompts.
- ❌ Only TUI sees / mutates approval-mode / memory / MCP server list / agents / tools allowlist / auth state.

**Consequence in Mode 2:** if a remote-client UI tries to mirror session settings, it can drift after any TUI slash command. Remote clients should **re-fetch state on attach / reconnect** (use `Last-Event-ID: 0` to replay the ring's oldest event for things like `model_switched`); they should NOT rely on incremental events for TUI-side mutations.

#### Why (A) and not (B) (promote mutations to `session_state_changed` event family)

(B) is the more ambitious answer but locks Stage 1.5 into a substantially larger wire surface that must also pass cleanly through the planned in-process refactor. We'd rather walk the smaller scope honestly. The session-state-event taxonomy work — enumerating which TUI flows are local-only by design vs. could plausibly graduate to wire under a future opt-in (B)-flavor extension — moves to [#3803](https://github.com/QwenLM/qwen-code/issues/3803), not Stage 1.5 code.

### N parallel sessions share one `qwen --acp` child per workspace runtime

Multiple sessions on the same trusted workspace **share that runtime's `qwen --acp` child process** via the agent's native multi-session support (`packages/cli/src/acp-integration/acpAgent.ts:194: private sessions: Map<string, Session>`). The bridge calls `connection.newSession({cwd, mcpServers})` for each session — the agent stores them in its sessions map and demultiplexes per-call sessionId. Production can own up to one primary child (preheat attempted by default) plus one on-demand child per trusted secondary; untrusted secondaries own none.

Concrete cost at N=5 sessions on the same workspace:

| Resource                             | Per session                                           | At N=5                                                           |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Daemon Node process                  | one                                                   | **30–50 MB** (one daemon)                                        |
| `qwen --acp` child                   | shared                                                | **60–100 MB** (one child)                                        |
| MCP server children                  | workspace pool when advertised; otherwise per-session | shared by matching pool entries, or up to 3×N in legacy fallback |
| `FileReadCache` (in-child heap)      | shared                                                | parsed once                                                      |
| `CLAUDE.md` / hierarchy memory parse | shared                                                | parsed once                                                      |
| OAuth refresh-token state            | shared                                                | **one refresh path**                                             |
| Auto-memory learned facts            | shared                                                | one knowledge base per child                                     |
| Cold start                           | first only                                            | <200 ms after first session                                      |

Each active workspace runtime keeps **one bridge boundary**. Production attempts to preheat the primary channel and retries on first use after failure; a trusted secondary opens its channel and child on demand, while an untrusted secondary never does. A channel stays alive while at least one session is live. After the last `killSession`, the runtime kills its child immediately by default or after the configured channel idle grace; a channel-level crash also tears it down without selecting another runtime.

**MCP server children** use the workspace-scoped transport pool when `mcp_workspace_pool` is advertised: matching `(workspace runtime, server name, config fingerprint)` entries are refcounted across sessions. If the capability is absent, the legacy per-session manager independently spawns them.

**Peer agents (Cursor / Continue / Claude Code / OpenCode / Gemini CLI) all do single-process multi-session.** qwen-code matches them at the agent layer; the Stage 1 bridge in this PR makes the same architecture visible over HTTP.

## Logging in to a remote daemon (issue #4175 PR 21)

When the daemon runs on a remote pod (no shared display with you), a client can
trigger an OAuth device flow over HTTP. The daemon polls the IdP itself; your job
is just to open a URL on whatever device has a browser.

> [!note]
>
> Qwen OAuth free tier was discontinued on 2026-04-15. The `qwen-oauth`
> examples below document the device-flow protocol shape and legacy provider
> identifier; new setups should use a currently supported auth provider.

```bash
# 1. Start a flow. The daemon contacts the IdP, returns a code + URL.
curl -X POST http://127.0.0.1:4170/workspace/auth/device-flow \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providerId":"qwen-oauth"}'
# → 201 {
#     "deviceFlowId": "fa07c61b-…",
#     "userCode": "USER-1",
#     "verificationUri": "https://chat.qwen.ai/api/v1/oauth2/device",
#     "verificationUriComplete": "https://chat.qwen.ai/...?user_code=USER-1",
#     "expiresAt": 1700000600000,
#     "intervalMs": 5000,
#     "attached": false
#   }

# 2. Visit the URL on your phone / laptop, enter the user code.
# 3. Poll for completion (or subscribe to SSE for the auth_device_flow_authorized event):
curl http://127.0.0.1:4170/workspace/auth/device-flow/fa07c61b-… \
  -H "Authorization: Bearer $TOKEN"
# → status transitions: pending → authorized
```

The TypeScript SDK wraps both steps into a single helper:

```ts
import { DaemonClient } from '@qwen-code/sdk';

const client = new DaemonClient({ baseUrl, token });
const flow = await client.auth.start({ providerId: 'qwen-oauth' });
console.log(`Open ${flow.verificationUri}\nCode: ${flow.userCode}`);
const result = await flow.awaitCompletion({ signal: abortCtrl.signal });
// result.status === 'authorized'
```

**The daemon never opens a browser on your behalf.** Even when running locally, the daemon stays passive — it returns the URL and lets the SDK / user choose where to open it. This is intentional: a daemon on a headless pod that called `xdg-open` would silently fail, masking the actual auth surface. Mirror `gh auth login`'s "Press Enter to open browser" UX in your client.

**`--require-auth` and dev convenience.** Device-flow routes use the strict mutation gate. The token-less trusted-loopback default may start and manage a flow directly; a non-trusted embed without credentials returns `401 token_required`. Set a managed `QWEN_SERVER_TOKEN` and pass `--require-auth` on shared hosts, CI runners, remote development machines, or anywhere local processes are not mutually trusted.

**Cross-daemon limitation.** `oauth_creds.json` is daemon-shared (`~/.qwen/oauth_creds.json`), so a successful login in daemon A is automatically picked up by daemon B's next token refresh — but daemon B's SDK clients won't receive the `auth_device_flow_authorized` event (events are per-daemon).

**Cross-client take-over.** Two SDK clients on the same daemon that both `POST /workspace/auth/device-flow` for the same provider get the per-provider singleton: the first call starts a fresh IdP request and returns `attached: false`; the second call returns the EXISTING in-flight entry with `attached: true`. The take-over is recorded on the audit trail (under the second client's `X-Qwen-Client-Id`) but does NOT emit a separate event — both clients eventually observe the SAME `auth_device_flow_authorized` once the user finishes the IdP page. If your UI distinguishes "I started this" from "someone else's flow I joined", branch on the `attached` field returned by `start()`.

## Daemon log file

`qwen serve` appends diagnostic records across normal restarts at the stable
active path:

```
${QWEN_RUNTIME_DIR or ~/.qwen}/debug/daemon/daemon.log
```

Every file record includes a random per-start `runId` and the daemon PID. A
successful stable owner also updates `debug/daemon/latest` to `daemon.log` on
platforms that support symlinks. On macOS/Linux, follow rotation with:

```bash
tail -F ~/.qwen/debug/daemon/daemon.log
```

On other platforms, configure the viewer to reopen the pathname after it is
replaced. A viewer that keeps only the old file handle will remain on the
archive after rotation.

The log captures lifecycle messages, route errors (with `route=` and `sessionId=` context), ACP child stderr, and — when `QWEN_SERVE_DEBUG=1` is set — extra bridge breadcrumbs. Lines that go to stderr today still go to stderr; the file log is **additive**, not a replacement.

The active file rotates before it would exceed 10 MiB. Each family retains
four archives under `archive/`, and each file record is capped at 256 KiB. The
in-memory queue accepts at most 4 MiB of unsettled file payload. Queue pressure,
rotation failures, or filesystem failures can therefore drop file copies;
`GET /daemon/status?detail=full` exposes logger health, issues, and dropped
record/byte counters.

Only one daemon may own the stable family in a log namespace. A concurrent
daemon writes to `debug/daemon/runs/run-<runId>/daemon.log`; the startup banner
and full status contain the authoritative path. `runs/recent-fallback` is a
best-effort locator for a recent fallback family and may point to one that is
still live. A healthy namespace converges to roughly 100 MiB: about 50 MiB for
stable plus one inactive fallback family. Live or not-yet-stale fallback
families are retained, so concurrent daemons or crash/restart storms can
temporarily use more.

One runtime directory is one ownership and retention namespace. Use distinct
`QWEN_RUNTIME_DIR` values when daemons need independent history. New daemon log
directories are private to the user (`0700`) and new files use `0600` on POSIX.
There is no age-based expiry.

### Disabling

Set `QWEN_DAEMON_LOG_FILE=0` (or `false`/`off`/`no`) to skip file logging entirely. Stderr output is unaffected.

### Relation to session debug logs

Session-scoped debug logs (`~/.qwen/debug/<sessionId>.txt` and the `~/.qwen/debug/latest` symlink) are independent. The daemon log lives in a sibling `daemon/` subdirectory; per-session debug semantics are unchanged by this feature.

### External rotation

Do not point an external logrotate rule at the active `daemon.log`. The daemon
is the sole supported writer and rotator; external rename, deletion, or
truncation invalidates its size model. Copying or shipping records without
mutating the family is safe. Older `serve-<pid>.log` and
`serve-<pid>-<workspaceHash>.log` files are left untouched and are not counted
by the new retention policy.

## Runtime MCP server management (issue [#4514](https://github.com/QwenLM/qwen-code/issues/4514))

Add or remove MCP servers at runtime without restarting the daemon. Runtime entries live in an ephemeral overlay that **shadows** settings-defined servers of the same name; the underlying `settings.json` / `mcpServers` config is never written to.

**Pre-flight:** check `caps.features` for `mcp_server_runtime_mutation` before calling either route. Older daemons without this tag return `404`.

### `POST /workspace/mcp/servers` — add a runtime MCP server

Strict-gated (trusted-loopback primary or operator credentials required). Connects the server immediately via the live `McpClientManager` and discovers its tools.

Request:

```json
{
  "name": "my-server",
  "config": {
    "command": "npx",
    "args": ["-y", "@my-org/mcp-server"]
  }
}
```

`name` must be alphanumeric plus `_` and `-` (max 256 characters). `config` is the same MCP server configuration object used in `settings.json` `mcpServers` entries (transport-dependent fields: `command`/`args` for stdio, `url` for SSE/HTTP). Security-sensitive fields (`trust`, `env`, `cwd`, `oauth`, `headers`, `authProviderType`, `includeTools`, `excludeTools`, `type`) are stripped by the daemon and ignored.

Response (200) — success:

```json
{
  "name": "my-server",
  "transport": "stdio",
  "replaced": false,
  "shadowedSettings": false,
  "toolCount": 3,
  "originatorClientId": "client-1"
}
```

- `replaced: true` — a runtime entry with the same name already existed and the config fingerprint differs; old connection torn down, new one established. When the fingerprint matches (idempotent re-add), `replaced` is `false`.
- `shadowedSettings: true` — a settings-defined server with the same name exists; the runtime entry now shadows it. The settings entry is untouched and re-emerges if the runtime entry is later removed.
- `toolCount` — number of tools discovered on the newly connected server.

Response (200) — soft refuse (budget warning mode):

```json
{
  "name": "my-server",
  "skipped": true,
  "reason": "budget_warning_only"
}
```

Returned when `--mcp-budget-mode=warn` and adding the server would exceed the configured `--mcp-client-budget`. The server is NOT connected. Callers should surface the budget pressure to the user.

Errors:

| Status | Code                      | When                                                                                               |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_server_name`     | Name empty, exceeds 256 chars, or contains characters outside `[A-Za-z0-9_-]`                      |
| `400`  | `missing_required_field`  | `config` missing or not a non-null object                                                          |
| `400`  | `invalid_client_id`       | `X-Qwen-Client-Id` header present but not registered for this workspace                            |
| `400`  | `invalid_config`          | Config shape rejected by the MCP transport validator                                               |
| `401`  | `token_required`          | Non-trusted token-less request denied by the strict gate                                           |
| `409`  | `mcp_budget_would_exceed` | `--mcp-budget-mode=enforce` and budget is full                                                     |
| `502`  | `mcp_server_spawn_failed` | Server process exited or timed out during connect; body carries `serverName`, `exitCode`, `stderr` |
| `503`  | `acp_channel_unavailable` | No live ACP child (no session has been created yet)                                                |

### `DELETE /workspace/mcp/servers/:name` — remove a runtime MCP server

Strict-gated. Disconnects the server and removes it from the runtime overlay. Idempotent — removing a name that was never added returns a skip response (not an error).

The `:name` path parameter is the URL-encoded server name.

Response (200) — success:

```json
{
  "name": "my-server",
  "removed": true,
  "wasShadowingSettings": false,
  "originatorClientId": "client-1"
}
```

- `wasShadowingSettings: true` — the removed runtime entry was shadowing a settings-defined server of the same name. That settings entry is now un-shadowed and will be used on next discovery/restart.

Response (200) — idempotent skip:

```json
{
  "name": "ghost",
  "skipped": true,
  "reason": "not_present"
}
```

Returned when the name was not in the runtime overlay (it may still exist in settings — settings entries cannot be removed via this route).

Errors:

| Status | Code                      | When                                                                          |
| ------ | ------------------------- | ----------------------------------------------------------------------------- |
| `400`  | `invalid_server_name`     | Name empty, exceeds 256 chars, or contains characters outside `[A-Za-z0-9_-]` |
| `400`  | `invalid_client_id`       | `X-Qwen-Client-Id` header present but not registered for this workspace       |
| `401`  | `token_required`          | Non-trusted token-less request denied by the strict gate                      |
| `503`  | `acp_channel_unavailable` | No live ACP child                                                             |

### Shadow semantics

Runtime entries form an ephemeral overlay on top of settings-defined MCP servers:

- **Adding** a runtime server with the same name as a settings entry **shadows** it — the runtime config takes precedence. The original settings entry is not modified.
- **Removing** a runtime server that was shadowing a settings entry **un-shadows** it — the settings-defined config becomes active again on next connection.
- **Daemon restart** loses all runtime entries. Only settings-defined servers survive across restarts. Runtime servers are session-lifetime scoped.
- **`GET /workspace/mcp`** reports the merged view — both settings-defined and runtime servers appear in the `servers[]` array. There is no wire-level distinction between the two origins in the snapshot today.

### Events

Both routes emit **workspace-scoped** SSE events (all active session buses receive them):

| Event                | Emitted when                    | Payload fields                                                                         |
| -------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `mcp_server_added`   | `POST` succeeds (not skipped)   | `name`, `transport`, `replaced`, `shadowedSettings`, `toolCount`, `originatorClientId` |
| `mcp_server_removed` | `DELETE` succeeds (not skipped) | `name`, `wasShadowingSettings`, `originatorClientId`                                   |

Skipped responses (`budget_warning_only`, `not_present`) do NOT emit events.

Budget-related events from the existing `mcp_guardrail_events` surface (`mcp_budget_warning`, `mcp_child_refused_batch`) also fire when runtime additions cross the budget threshold.

## What's next

- **Setting up a long-running daemon?** [Local launch templates (systemd / launchd / nohup / tmux)](./qwen-serve-deploy-local.md) for v0.16-alpha (local-only).
- **Build a client?** See the [DaemonClient TypeScript quickstart](../developers/examples/daemon-client-quickstart.md) and the [HTTP protocol reference](../developers/qwen-serve-protocol.md).
- **Reading the source?** Bridge code lives at `packages/cli/src/serve/`; SDK client at `packages/sdk-typescript/src/daemon/`.
- **Tracking the roadmap?** Stage 1.5 / Stage 2 progress is tracked on issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803).
