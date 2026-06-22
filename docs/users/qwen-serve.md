# Daemon mode (`qwen serve`)

Run Qwen Code as a local HTTP daemon so multiple clients (IDE plugins, web UIs, CI scripts, custom CLIs) share one agent session over HTTP + Server-Sent Events instead of each spawning their own subprocess.

> **🚧 v0.16-alpha**: `qwen serve` first ships to npm in v0.16-alpha as **text-only chat / coding** with **local-only deployment**. Image / file attachments on the prompt path, containerized deployment (Docker / k8s / nginx reverse-proxy), and remote / multi-daemon hardening land in a follow-up patch when an enterprise pilot is committed. See [v0.16-alpha known limits](#v016-alpha-known-limits) for the full deferred list.

> **Status:** Stage 1 (experimental). The protocol surface is locked at the §04 routes table from issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803). Stage 1.5 (`qwen --serve` flag — TUI co-hosts the same HTTP server) and Stage 2 (in-process refactor + `mDNS`/OpenAPI/WebSocket/Prometheus polish) are immediately downstream.
>
> **Scope honesty:** Stage 1 is sized for **developers prototyping clients against the protocol surface** and for **local single-user / small-team collaboration**. Production-grade multi-client / long-running / network-flaky workloads (mobile companions, IM bots reaching 1000+ chats) need Stage 1.5+ guarantees that aren't in this release. See [Stage 1.5+ runtime guarantees](#stage-15-runtime-guarantees) for the full gap list and #3803 for the convergence roadmap.

## What it gives you

- **Built-in Web Shell UI** — `qwen serve` serves the browser-based Web Shell at its root (`http://127.0.0.1:4170/`) out of the box; run `qwen serve --open` to launch it in your browser automatically. It is served on the same origin as the API, so no second port or reverse proxy is needed. Pass `--no-web` for an API-only daemon.
- **One agent process, many clients** — under the default `sessionScope: 'single'`, every client connecting to the daemon shares one ACP session. Live cross-client collaboration on the same conversation, the same file diffs, the same permission prompts.
- **Reconnect-safe streaming** — SSE with `Last-Event-ID` reconnect lets a client drop and pick up exactly where it left off (within the ring's replay window).
- **First-responder permissions** — when the agent asks for permission to run a tool, every connected client sees the request; whichever client answers first wins.
- **One daemon, one workspace** — each `qwen serve` process binds to exactly one workspace at boot (per [#3803](https://github.com/QwenLM/qwen-code/issues/3803) §02). Multi-workspace deployments run one daemon per workspace on separate ports (or behind an orchestrator).
- **Remote runtime control** ([#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 17) — change a session's approval mode (`POST /session/:id/approval-mode`), toggle a tool per workspace (`POST /workspace/tools/:name/enable`), scaffold an empty `QWEN.md` (`POST /workspace/init`, mechanical only — does NOT call the model; for AI-fill, follow up with `POST /session/:id/prompt`), restart a single MCP server with a budget pre-check (`POST /workspace/mcp/:server/restart`), or add/remove MCP servers at runtime without a daemon restart (`POST /workspace/mcp/servers`, `DELETE /workspace/mcp/servers/:name`). All strict-gated — configure `--token` first.
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
- ❌ **Multi-daemon coordination on one host** — `1 daemon = 1 workspace × N sessions` is enforced. Cross-host federation, instance-path token keying, and stale-token cleanup defer to v0.16.x.
- ❌ **Auto-generated daemon tokens** — alpha is BYO-token (one `openssl rand -hex 32` away). Auto-gen + token-store infrastructure defers to v0.16.x.

**Hardening — minimum viable for local single-user:**

- ✅ Boot-time security gate (refuses non-loopback bind without a token, [PR 15 / #4236](https://github.com/QwenLM/qwen-code/pull/4236))
- ✅ Mutation-route auth gate, session-scoped permission routing (Wave 4 PRs)
- ✅ MCP guardrails + multi-client permission coordination (F2 / F3)
- ✅ **Prompt absolute deadline + SSE writer idle timeout** — opt-in via `--prompt-deadline-ms` and `--writer-idle-timeout-ms`; advertised through `prompt_absolute_deadline` and `writer_idle_timeout` when enabled.
- ✅ **HTTP rate limiting** — opt-in via `--rate-limit` and per-tier thresholds; advertised through `rate_limit` when enabled.
- ⏸️ **Prometheus metrics + load test harness** — defers to v0.17 F4 Phase-1 scale instrumentation when 30-50 active sessions becomes a real target.
- ⏸️ **`--max-body-size` CLI flag** — daemon enforces `express.json({ limit: '10mb' })` by default which comfortably covers text-only prompts (model context windows are well under 10 MiB of chars). Tunable via flag in v0.16.x.

For the deeper "what we won't fix in Stage 1" enumeration (single-host session-state mutation model + N-parallel-sessions sharing one ACP child), see [Stage 1 scope boundaries](#stage-1-scope-boundaries--what-we-wont-fix-in-stage-15) below.

## Quickstart

### 1. Start the daemon (loopback, no auth)

```bash
cd your-project/
qwen serve
# → qwen serve listening on http://127.0.0.1:4170 (mode=http-bridge, workspace=/path/to/your-project)
# → qwen serve: bearer auth disabled (loopback default). Set QWEN_SERVER_TOKEN to enable.
```

The default bind is `127.0.0.1:4170`. Bearer auth is **off** on loopback so local development "just works". The daemon binds to the current working directory; use `--workspace /path/to/dir` to override.

**Open the Web Shell UI.** Browse to `http://127.0.0.1:4170/` (or start the daemon with `qwen serve --open` to launch it automatically) for the full browser terminal — chat, diffs, tool calls, and permission prompts. The UI is served at the daemon root on the same origin as the API. The rest of this guide uses raw HTTP so you can script against the API directly.

### 2. Sanity-check it

```bash
curl http://127.0.0.1:4170/health
# → {"status":"ok"}

curl http://127.0.0.1:4170/capabilities
# → {"v":1,"mode":"http-bridge","features":["health","daemon_status","capabilities","session_create",...],"workspaceCwd":"/path/to/your-project"}

curl http://127.0.0.1:4170/daemon/status
# → {"v":1,"detail":"summary","status":"ok","runtime":{...}}
```

The `workspaceCwd` field surfaces the bound workspace so clients can pre-flight check + omit `cwd` on `POST /session`.
The `limits.maxPendingPromptsPerSession` field advertises the active per-session prompt admission cap; `null` means the cap is disabled.

The daemon also exposes read-only runtime snapshots for client UIs and
operators: `GET /daemon/status`, `GET /workspace/mcp`,
`GET /workspace/skills`, `GET /workspace/providers`, `GET /workspace/env`,
`GET /workspace/preflight`,
`GET /session/:id/context`, `GET /session/:id/supported-commands`, and
`GET /session/:id/tasks`.

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
`auth_env_error`, `init_timeout`, `protocol_error`, `missing_file`,
`parse_error`, `blocked_egress`) so client UIs can render structured
remediation.

The daemon also exposes workspace file helpers:

- `GET /file` reads text files and returns a raw-byte `sha256:<hex>` hash.
- `GET /file/bytes` reads bounded raw byte windows and returns base64 content.
- `POST /file/write` creates or replaces text files.
- `POST /file/edit` applies one exact text replacement.

Write/edit are **strict mutation routes**: even on loopback they require a
configured bearer token, otherwise they return `token_required`. Replacements
and edits require the latest `expectedHash` from `GET /file` (or a full-window
`GET /file/bytes`). `create` never overwrites. Explicit writes to ignored paths
are allowed but audited. Binary writes, delete/move/mkdir, and recursive parent
creation are not part of this surface.

### 3. Open a session

```bash
curl -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -d '{}'
# → {"sessionId":"<uuid>","workspaceCwd":"…","attached":false}
```

`cwd` may be omitted — the route falls back to the daemon's bound workspace. Posting a `cwd` that doesn't match the bound workspace returns `400 workspace_mismatch` (the daemon is bound to exactly one workspace; start a separate daemon for a different one).

A second client posting to `/session` (any matching `cwd` or none) gets `"attached": true` — they're now sharing the agent.

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

## CLI flags

| Flag                                    | Default         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`                            | `4170`          | TCP port. `0` = OS-assigned ephemeral port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--hostname <addr>`                     | `127.0.0.1`     | Bind interface. Anything beyond loopback requires a token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--token <str>`                         | —               | Bearer token. Falls back to `QWEN_SERVER_TOKEN` env var (with leading/trailing whitespace stripped — handy for `$(cat token.txt)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--require-auth`                        | `false`         | Refuse to start without a bearer token, even on loopback. Hardens the `127.0.0.1` developer default for shared dev hosts / CI runners / multi-tenant workstations where any local user can hit the listener. Boots only with `--token` or `QWEN_SERVER_TOKEN` set; gates `/health` behind the bearer too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--max-sessions <n>`                    | `20`            | Cap on concurrent live sessions. New `POST /session` requests that would spawn a fresh child return `503` (with `Retry-After: 5`) when the cap is hit; attaches to existing sessions are NOT counted. Set to `0` to disable. Sized for single-user / small-team usage; raise it if your deployment has the RAM/FD headroom (~30–50 MB per session).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--max-pending-prompts-per-session <n>` | `5`             | Per-session cap on prompts accepted by `POST /session/:id/prompt` but not yet settled, including queued prompts and the active prompt. The bridge rejects overflow synchronously with `503`, `Retry-After: 5`, and `code: "prompt_queue_full"` before returning a `promptId`. Set to `0` to disable. `branchSession` serializes on the same FIFO but does not count against this prompt cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--workspace <path>`                    | `process.cwd()` | Absolute workspace path this daemon binds to (per [#3803](https://github.com/QwenLM/qwen-code/issues/3803) §02 — 1 daemon = 1 workspace). `POST /session` requests with a mismatched `cwd` return `400 workspace_mismatch`. For multi-workspace deployments, run one `qwen serve` per workspace on separate ports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--max-connections <n>`                 | `256`           | Listener-level TCP connection cap (`server.maxConnections`). Bounds raw socket count irrespective of session count — slow / phantom SSE clients get rejected at accept time once full. Raise alongside `--max-sessions` if your deployment expects many SSE subscribers per session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--event-ring-size <n>`                 | `8000`          | Per-session SSE replay ring depth (#3803 §02 target). Sets the backlog available to `GET /session/:id/events` with `Last-Event-ID: N`. Larger = more reconnect headroom at the cost of a few hundred KB extra RAM per session. SDK clients can additionally request a larger per-subscriber backlog cap on a specific subscription via `?maxQueued=N` (range `[16, 2048]`, default 256). Daemons also emit a non-terminal `slow_client_warning` SSE frame at 75% queue fill so clients can drain / reconnect before getting evicted. Pre-flight `caps.features.slow_client_warning`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--mcp-client-budget <n>`               | —               | Positive integer cap on live MCP clients **per ACP session** (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14 v1; PR 23 graduates this to per-workspace via the shared MCP pool). Combine with `--mcp-budget-mode`. When unset, no accounting-driven enforcement (but `GET /workspace/mcp` still reports `clientCount`). Distinct from claude-code's `MCP_SERVER_CONNECTION_BATCH_SIZE` which gates startup concurrency, not the total client count. Pre-flight `caps.features.mcp_guardrails`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--mcp-budget-mode <m>`                 | `warn` / `off`  | How `--mcp-client-budget` is enforced. `warn` (default when budget set): no refusal, snapshot's `budgets[0].status` flips to `warning` at ≥75% of budget. `enforce`: connects past the cap are refused, per-server cell shows `disabledReason: 'budget'`, deterministic by `mcpServers` declaration order. `off` (default when budget unset): pure observability. Boot rejects `enforce` without a budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--http-bridge`                         | `true`          | Stage 1 mode: one `qwen --acp` child per daemon (bound to one workspace at boot, per [#3803](https://github.com/QwenLM/qwen-code/issues/3803) §02); N sessions multiplex onto that child via ACP `newSession()`. Stage 2 native in-process becomes available later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--allow-origin <pat>`                  | —               | T2.4 ([#4514](https://github.com/QwenLM/qwen-code/issues/4514)). Cross-origin allowlist for browser webui clients. Repeatable. Each value is `*` (any origin — boot refuses if no bearer token is configured; `--require-auth` on loopback is recommended so `/health` and `/demo` are also bearer-gated, since both are pre-auth on loopback by default) or a canonical URL origin (`<scheme>://<host>[:<port>]`, no trailing slash / path / userinfo / query). **Subdomain wildcards (`https://*.example.com`) are intentionally unsupported** — list each subdomain explicitly, or use `*` with a configured token (and `--require-auth` for full hardening). Matched origins receive CORS response headers (`Access-Control-Allow-Origin`, `Vary: Origin`, methods, headers, max-age, and exposed `Retry-After`); unmatched origins still get a 403 with the same envelope as today's wall. `Origin: null` (sandboxed iframes, file:// docs) is always rejected, even under `*`. Pre-flight via `caps.features.allow_origin`. Loopback self-origin hits are unaffected. |
| `--web` / `--no-web`                    | `true`          | Serve the built Web Shell SPA at the daemon root (`GET /`, `/assets/*`, and SPA deep-link fallback). The static shell is registered **before** the bearer-auth gate — a browser can't attach a token to a `<script>` subresource or an address-bar navigation, the shell carries no secrets, and every API route stays token-gated regardless. On non-loopback binds a one-line stderr warning notes the UI is reachable without auth. Use `--no-web` for an API-only daemon. No effect when the build omits the Web Shell assets (the daemon logs a breadcrumb and runs API-only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--open`                                | `false`         | After the listener is up, open the Web Shell in your default browser at the daemon URL (with `#token=` appended as a URL fragment when a token is configured — a fragment is never sent to the server, keeping the token out of access logs and Referer headers). No-op with `--no-web`, or in headless / CI / SSH environments where no browser is available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

> **Sizing the load knobs.** `--max-sessions` is the **new-child** cap.
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
> - **per-subscriber backlog**: a 256-frame queue per SSE client; an
>   over-capacity client gets a terminal `client_evicted` frame and is
>   closed (one slow consumer can't pin the daemon).
>
> These caps interact: `--max-sessions × 64 subscribers × 256 frames`
> is the worst-case in-flight memory at the EventBus layer, while
> `--max-sessions × --max-pending-prompts-per-session` bounds accepted
> prompt work at the admission layer. Default sizing assumes single-user /
> small-team load; raise progressively (and watch RSS) for multi-tenant
> deployments.

> **MCP client guardrails (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14).** A workspace declaring 30 MCP servers in `mcpServers` will start 30 clients with no upstream cap unless you set one. `--mcp-client-budget=N` caps the live MCP client count; `--mcp-budget-mode={enforce,warn,off}` chooses the behavior. Default is `warn` when a budget is set (snapshot surfaces the warning but no client is refused — useful for measuring real-world fanout before flipping on enforcement). Refused servers under `enforce` mode get `disabledReason: 'budget'` on their per-server cell, and the `budgets[0]` cell shows `status: 'error'` + `errorKind: 'budget_exhausted'`. Slot reservation is by server name and survives reconnects / discovery timeouts — a refused server can't take a slot from a healthy one.
>
> ⚠️ **v1 scope: per-session, not per-workspace.** Each ACP session inside the daemon has its own `Config`/`McpClientManager` (created via `newSessionConfig` per session). The budget caps live MCP clients **per session**, not aggregated across all sessions in the workspace. Snapshot at `GET /workspace/mcp` reflects the bootstrap session's view (the cell carries `scope: 'session'` for honesty). If you run 5 concurrent ACP sessions with `--mcp-client-budget=10`, you may have up to 50 live MCP clients across the daemon — the cap holds per session. **Wave 5 PR 23 (shared MCP pool)** introduces a workspace-scoped manager and graduates this to true per-workspace enforcement.
>
> ```sh
> qwen serve --mcp-client-budget=10 --mcp-budget-mode=warn
> # later, after telemetry shows your real-world distribution:
> qwen serve --mcp-client-budget=10 --mcp-budget-mode=enforce
> ```
>
> This is **not** the same as claude-code's `MCP_SERVER_CONNECTION_BATCH_SIZE` (which gates startup concurrency); they're orthogonal. PR 23 will add a real shared MCP pool (a `scope: 'workspace'` cell in `budgets[]` alongside the per-session cell); PR 14 v1 is the in-process counter + soft enforcement on the existing per-session manager.
>
> **Push events (issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) PR 14b).** SDK clients subscribed to `GET /session/:id/events` receive typed frames when budget thresholds cross — `mcp_budget_warning` (synthetic, fires once per upward 75% crossing with hysteresis re-arm at 37.5%, advertised via `mcp_guardrail_events`) and `mcp_child_refused_batch` (coalesced once per discovery pass under `enforce` mode; length-1 from `readResource` lazy-spawn refusal). The snapshot at `GET /workspace/mcp` is still the source-of-truth for state-after-reconnect; events are change-edges. Useful when dashboarding in real-time without polling.

## Default deployment threat model

- **127.0.0.1 only** — loopback bind, no auth needed.
- **`--hostname 0.0.0.0` requires a token** — boot refuses without one.
- **`LOOPBACK_BINDS` includes IPv6** — `::1` and `[::1]` count as loopback for the no-token rule.
- **Host header allowlist** — on **loopback** binds the daemon checks `Host:` matches `localhost:port` / `127.0.0.1:port` / `[::1]:port` / `host.docker.internal:port` (case-insensitive per RFC 7230 §5.4) to defend against DNS rebinding. **Non-loopback binds (`--hostname 0.0.0.0`) intentionally bypass the Host allowlist** — the operator has chosen the surface area, so the bearer-token gate is the sole authentication layer; reverse proxies / SNI / client cert pinning are the operator's responsibility, not the daemon's. If you need Host-based isolation on a non-loopback bind, terminate TLS + check Host at a front proxy.
- **CORS denies any browser Origin by default** — returns `403` JSON. Pass **`--allow-origin <pattern>`** (repeatable, T2.4 #4514) to opt specific browser origins through. Each value is either the literal `*` (any origin — boot refuses if no bearer token is configured; `--require-auth` on loopback is recommended for full hardening since `/health` and `/demo` remain pre-auth on loopback by default) or a canonical URL origin (`<scheme>://<host>[:<port>]`, no trailing slash / path / userinfo). Matched origins receive proper CORS response headers (`Access-Control-Allow-Origin: <echoed>`, `Vary: Origin`, plus standard methods / headers / max-age and exposed `Retry-After`); unmatched origins still get a 403 with the same envelope as the default wall. `caps.features.allow_origin` is advertised conditionally so SDK / webui clients can pre-flight whether the daemon honors cross-origin hits before issuing them. Example: `qwen serve --allow-origin http://localhost:3000 --allow-origin http://localhost:5173`. Loopback self-origin hits (e.g. the `/demo` page) are unaffected — a separate Origin-strip shim handles them regardless of `--allow-origin`. **Browser webuis without `--allow-origin` configured** still fall back to the same Stage 1 options as before: package as a native shell (Electron/Tauri) so no `Origin` header is sent, or front the daemon with a same-origin reverse proxy.
- **Spawned `qwen --acp` child inherits the daemon's environment** with one explicit scrub: `QWEN_SERVER_TOKEN` is removed before the child starts (the daemon's own bearer; the agent doesn't need it). Everything else — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `QWEN_*` / `DASHSCOPE_API_KEY` / your custom `modelProviders[].envKey` / etc. — passes through, because the agent legitimately needs those to authenticate to the LLM. **This is intentional, not a sandbox.** The agent runs as the same UID with shell-tool access, so anything in `~/.bashrc` / `~/.aws/credentials` / `~/.npmrc` is reachable by prompt injection regardless. The env passthrough is not the security boundary; the user-as-trust-root is. Don't run `qwen serve` under an identity that has env-resident credentials you wouldn't trust the agent with.
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

Issue [#4514](https://github.com/QwenLM/qwen-code/issues/4514) T2.9 ships two opt-in flags that close the long-running / remote-deployment gaps the 15s heartbeat + AbortSignal don't cover. Both are off by default — single-user loopback workflows stay bit-for-bit unchanged.

| Flag                           | Env var                             | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--prompt-deadline-ms <n>`     | `QWEN_SERVE_PROMPT_DEADLINE_MS`     | unset   | Server-side wallclock cap on a single `POST /session/:id/prompt`. On expiry the daemon aborts the prompt's AbortController and returns HTTP `504` with `{code:"prompt_deadline_exceeded", errorKind:"prompt_deadline_exceeded", deadlineMs:n}`. A per-prompt request body field `deadlineMs` can SHORTEN the effective deadline below the flag but never extend it. Capability tag (conditional): `prompt_absolute_deadline`.                                                                                                                                                                                                |
| `--writer-idle-timeout-ms <n>` | `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` | unset   | Per-SSE-connection idle deadline. When no write has SUCCESSFULLY flushed for `n` ms — neither a real event nor the 15s heartbeat — the daemon emits a terminal `client_evicted` frame with `data.reason = 'writer_idle_timeout'` (mirrored on `data.errorKind`) and closes the stream. **Pick a value comfortably above the 15s heartbeat** (e.g. `30000`–`300000`) so legitimate idle streams aren't evicted; values `< 15000` WILL evict otherwise-healthy idle connections before the first heartbeat fires (intentional only for tests / short-lived dev sessions). Capability tag (conditional): `writer_idle_timeout`. |

Both flags accept a positive integer in milliseconds; `0`, `NaN`, non-integer, or negative values are rejected at boot with a clear error message. CLI flag wins over env var; explicit `ServeOptions` field (embedded callers) wins over env. SDK consumers should pre-flight the matching capability tag before relying on either behavior — daemons predating this PR omit both tags and the request `deadlineMs` field is silently dropped.

## Multi-session & multi-workspace deployment

Per [#3803](https://github.com/QwenLM/qwen-code/issues/3803) §02, each `qwen serve` process binds to **one workspace** at boot. Within that workspace it multiplexes N sessions onto a single `qwen --acp` child via the agent's native session map — sessions share the child's process / OAuth state / file-read cache / hierarchy-memory parse.

To host **multiple workspaces** (one user, several repos; or several users on the same host), run **multiple daemon processes** — one per workspace, each on its own port, supervised by systemd / docker-compose / k8s / a `qwen-coordinator` reference orchestrator. The trade-off is intentional: one workspace per child means `loadSettings(cwd)` / OAuth / MCP server scope stay aligned with the bound directory and don't drift across requests.

> **Subscribe BEFORE posting `modelServiceId` on attach.** When a client `POST /session` with a `modelServiceId` and the workspace already has a session running a different model, the daemon issues an internal `setSessionModel` call — failures are NOT propagated as an HTTP error (the session stays operational on its current model). The visible failure signal is a `model_switch_failed` event on the session's SSE stream. If you call `POST /session` and only THEN open `GET /session/:id/events`, you'll miss the failure event and silently keep talking to the wrong model. Open the SSE stream first, or pass `Last-Event-ID: 0` on subscribe to replay the ring's oldest available event.

To handle multiple **users** (each with their own quota, audit log, sandbox) or to scale beyond one process's reach (cold-start budget, FD count, RSS), spawn one daemon per workspace per user behind an external orchestrator. That orchestrator (multi-tenancy / OIDC / Quota / Audit / k8s) is **out of scope** for the qwen-code project — see issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803) "External Reference Architecture" for the design pointers.

## Loading and resuming a persisted session

The daemon exposes ACP's `session/load` and resume flow over HTTP via two routes:

| Route                      | Use when                                                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /session/:id/load`   | The client has **no** history rendered (cold reconnect, picker-then-open). The daemon replays every persisted turn through SSE so subscribers see the full transcript. Capability tag: `session_load`.                                                                                        |
| `POST /session/:id/resume` | The client already has the turns on screen and only needs the daemon-side handle back. Model context is restored on the agent side without UI replay — the SSE stream stays clean. Capability tag: `session_resume` (`unstable_session_resume` remains a deprecated alias for older clients). |

The TypeScript SDK exposes both as static factories on `DaemonSessionClient`:

```ts
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk';

const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:4170' });

// Cold reconnect — daemon will replay history through SSE.
const session = await DaemonSessionClient.load(client, 'persisted-id');

// Or, if your UI already has the history, skip the replay:
// const session = await DaemonSessionClient.resume(client, 'persisted-id');

for await (const event of session.events()) {
  // First the replayed `session_update` frames (load only),
  // then live events.
}
```

Pre-flight `caps.features.session_load` / `caps.features.session_resume` before calling — older daemons return `404`. `unstable_session_resume` is still advertised as a deprecated compatibility alias. Concurrent same-action requests for the same id coalesce; cross-action races (a `load` racing a `resume`) get `409 restore_in_progress` with `Retry-After: 5`. See the [protocol reference](../developers/qwen-serve-protocol.md) for the full error envelope.

Note: history replay is bounded by the SSE ring (default 8000 frames). Long histories with chatty turns can exceed that — earliest frames are dropped silently. For very long sessions, prefer `resume` and rely on the client's local persisted UI.

## Durability model

**Sessions are still ephemeral in Stage 1 across daemon restarts**, but persisted sessions on disk can be reloaded:

- A child process crash publishes `session_died` and removes the live session from the daemon's maps. The persisted on-disk session **can** be reloaded via `POST /session/:id/load` if a fresh agent child is spawnable.
- A daemon restart loses every in-flight live session. The persisted sessions remain on disk and can be loaded against a new daemon process, subject to the same workspace binding rules.
- Long client disconnects (>5 min on a chatty turn) can outrun the SSE replay ring (default 8000 frames) — `Last-Event-ID` reconnect succeeds but state may be incoherent. For mobile / flaky-network clients, plan to re-open SSE on long drops or call `POST /session/:id/load` to replay from disk.
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

### N parallel sessions share one `qwen --acp` child

Multiple sessions on the same workspace **share one `qwen --acp` child process** via the agent's native multi-session support (`packages/cli/src/acp-integration/acpAgent.ts:194: private sessions: Map<string, Session>`). The bridge calls `connection.newSession({cwd, mcpServers})` for each session — the agent stores them in its sessions map and demultiplexes per-call sessionId.

Concrete cost at N=5 sessions on the same workspace:

| Resource                             | Per session | At N=5                       |
| ------------------------------------ | ----------- | ---------------------------- |
| Daemon Node process                  | one         | **30–50 MB** (one daemon)    |
| `qwen --acp` child                   | shared      | **60–100 MB** (one child)    |
| MCP server children                  | per-session | 3×N if configs differ        |
| `FileReadCache` (in-child heap)      | shared      | parsed once                  |
| `CLAUDE.md` / hierarchy memory parse | shared      | parsed once                  |
| OAuth refresh-token state            | shared      | **one refresh path**         |
| Auto-memory learned facts            | shared      | one knowledge base per child |
| Cold start                           | first only  | <200 ms after first session  |

The bridge keeps **one channel per daemon** (one daemon per workspace, per §02). The channel stays alive while at least one session is live; the last `killSession` (or a channel-level crash) kills the child.

**MCP server children** are still per-session today — each session's config can specify different servers, so they're independently spawned. Stage 1.5 follow-up: refcount MCP server children by `(workspace, config-hash)` so identical configs share. Not in scope for this PR.

**Peer agents (Cursor / Continue / Claude Code / OpenCode / Gemini CLI) all do single-process multi-session.** qwen-code matches them at the agent layer; the Stage 1 bridge in this PR makes the same architecture visible over HTTP.

## Logging in to a remote daemon (issue #4175 PR 21)

When the daemon runs on a remote pod (no shared display with you), you can still log in to a Qwen account by triggering an OAuth device flow over HTTP. The daemon polls the IdP itself; your job is just to open a URL on whatever device has a browser.

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

**`--require-auth` and dev convenience.** The device-flow routes use the strict mutation gate (PR 15), which means a token-less loopback default returns `401 token_required`. Locally, the simplest way around this during development is `qwen serve --token=dev-token`; you don't need `--require-auth` unless you're hardening the loopback default.

**Cross-daemon limitation.** `oauth_creds.json` is daemon-shared (`~/.qwen/oauth_creds.json`), so a successful login in daemon A is automatically picked up by daemon B's next token refresh — but daemon B's SDK clients won't receive the `auth_device_flow_authorized` event (events are per-daemon).

**Cross-client take-over.** Two SDK clients on the same daemon that both `POST /workspace/auth/device-flow` for the same provider get the per-provider singleton: the first call starts a fresh IdP request and returns `attached: false`; the second call returns the EXISTING in-flight entry with `attached: true`. The take-over is recorded on the audit trail (under the second client's `X-Qwen-Client-Id`) but does NOT emit a separate event — both clients eventually observe the SAME `auth_device_flow_authorized` once the user finishes the IdP page. If your UI distinguishes "I started this" from "someone else's flow I joined", branch on the `attached` field returned by `start()`.

## Daemon log file

`qwen serve` writes a per-process diagnostic log to:

```
${QWEN_RUNTIME_DIR or ~/.qwen}/debug/daemon/serve-<pid>-<workspaceHash>.log
```

A `latest` symlink in the same directory always points at the current process's log, so `tail -f ~/.qwen/debug/daemon/latest` will follow whichever daemon is running.

The log captures lifecycle messages, route errors (with `route=` and `sessionId=` context), ACP child stderr, and — when `QWEN_SERVE_DEBUG=1` is set — extra bridge breadcrumbs. Lines that go to stderr today still go to stderr; the file log is **additive**, not a replacement.

### Disabling

Set `QWEN_DAEMON_LOG_FILE=0` (or `false`/`off`/`no`) to skip file logging entirely. Stderr output is unaffected.

### Relation to session debug logs

Session-scoped debug logs (`~/.qwen/debug/<sessionId>.txt` and the `~/.qwen/debug/latest` symlink) are independent. The daemon log lives in a sibling `daemon/` subdirectory; per-session debug semantics are unchanged by this feature.

### No rotation

The daemon log appends indefinitely. Rotate manually if it grows large. A future enhancement may add automatic rotation; track via [#4548](https://github.com/QwenLM/qwen-code/issues/4548) follow-ups.

## Runtime MCP server management (issue [#4514](https://github.com/QwenLM/qwen-code/issues/4514))

Add or remove MCP servers at runtime without restarting the daemon. Runtime entries live in an ephemeral overlay that **shadows** settings-defined servers of the same name; the underlying `settings.json` / `mcpServers` config is never written to.

**Pre-flight:** check `caps.features` for `mcp_server_runtime_mutation` before calling either route. Older daemons without this tag return `404`.

### `POST /workspace/mcp/servers` — add a runtime MCP server

Strict-gated (bearer token required). Connects the server immediately via the live `McpClientManager` and discovers its tools.

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
| `401`  | `token_required`          | No bearer token configured (strict gate)                                                           |
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
| `401`  | `token_required`          | No bearer token configured (strict gate)                                      |
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
