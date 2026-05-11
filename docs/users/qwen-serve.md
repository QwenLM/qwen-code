# Daemon mode (`qwen serve`)

Run Qwen Code as a local HTTP daemon so multiple clients (IDE plugins, web UIs, CI scripts, custom CLIs) share one agent session over HTTP + Server-Sent Events instead of each spawning their own subprocess.

> **Status:** Stage 1 (experimental). The protocol surface is locked at the §04 routes table from issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803). Stage 1.5 (`qwen --serve` flag — TUI co-hosts the same HTTP server) and Stage 2 (in-process refactor + `mDNS`/OpenAPI/WebSocket/Prometheus polish) are immediately downstream.

## What it gives you

- **One agent process, many clients** — under the default `sessionScope: 'single'`, every client connecting to the same workspace shares one ACP session. Live cross-client collaboration on the same conversation, the same file diffs, the same permission prompts.
- **Reconnect-safe streaming** — SSE with `Last-Event-ID` reconnect lets a client drop and pick up exactly where it left off (within the ring's replay window).
- **First-responder permissions** — when the agent asks for permission to run a tool, every connected client sees the request; whichever client answers first wins.

## Quickstart

### 1. Start the daemon (loopback, no auth)

```bash
cd your-project/
qwen serve
# → qwen serve listening on http://127.0.0.1:4170 (mode=http-bridge)
# → qwen serve: bearer auth disabled (loopback default). Set QWEN_SERVER_TOKEN to enable.
```

The default bind is `127.0.0.1:4170`. Bearer auth is **off** on loopback so local development "just works".

### 2. Sanity-check it

```bash
curl http://127.0.0.1:4170/health
# → {"status":"ok"}

curl http://127.0.0.1:4170/capabilities
# → {"v":1,"mode":"http-bridge","features":["health","capabilities","session_create",...]}
```

### 3. Open a session

```bash
curl -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -d '{"cwd":"'"$PWD"'"}'
# → {"sessionId":"<uuid>","workspaceCwd":"…","attached":false}
```

A second client posting to `/session` with the same `cwd` gets `"attached": true` — they're now sharing the agent.

### 4. Subscribe to the event stream (in another terminal first)

```bash
SESSION_ID="<from step 3>"
curl -N http://127.0.0.1:4170/session/$SESSION_ID/events
# → id: 1
#   event: session_update
#   data: {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}
```

Open this **before** sending the prompt — the SSE replay buffer holds the
last 1000 events so a late subscriber can catch up via `Last-Event-ID`,
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

Clients then send `Authorization: Bearer $QWEN_SERVER_TOKEN` on every request **except `/health`**, which is intentionally exempt so liveness probes (k8s, Compose, monitoring) work without credentials. Use `/capabilities` to verify your token is correct end-to-end:

```bash
curl -H "Authorization: Bearer $QWEN_SERVER_TOKEN" http://your-host:4170/capabilities
# → {"v":1,"mode":"http-bridge","features":[...],"modelServices":[]}
# Wrong token → 401
```

The token comparison is constant-time (SHA-256 + `crypto.timingSafeEqual`); 401 responses are uniform across "missing header", "wrong scheme", and "wrong token" so a side-channel can't distinguish.

## CLI flags

| Flag                | Default     | Purpose                                                                                                                             |
| ------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`        | `4170`      | TCP port. `0` = OS-assigned ephemeral port.                                                                                         |
| `--hostname <addr>` | `127.0.0.1` | Bind interface. Anything beyond loopback requires a token.                                                                          |
| `--token <str>`     | —           | Bearer token. Falls back to `QWEN_SERVER_TOKEN` env var (with leading/trailing whitespace stripped — handy for `$(cat token.txt)`). |
| `--http-bridge`     | `true`      | Stage 1 mode: per-session `qwen --acp` child process. Stage 2 native in-process becomes available later.                            |

## Default deployment threat model

- **127.0.0.1 only** — loopback bind, no auth needed.
- **`--hostname 0.0.0.0` requires a token** — boot refuses without one.
- **`LOOPBACK_BINDS` includes IPv6** — `::1` and `[::1]` count as loopback for the no-token rule.
- **Host header allowlist** — on loopback binds the daemon also checks `Host:` matches `localhost:port` / `127.0.0.1:port` / `[::1]:port` / `host.docker.internal:port` (case-insensitive per RFC 7230 §5.4) to defend against DNS rebinding.
- **CORS denies any browser Origin** — returns `403` JSON.
- **Spawned `qwen --acp` child runs with an allowlisted environment** — only HOME / PATH / USER / LOGNAME / LANG / LC\_\* / TMPDIR / TEMP / TMP / NODE_PATH (plus Windows essentials) are inherited. API keys / DB passwords / OAuth tokens / cloud credentials in the daemon's env are **not** passed to the agent — prompt-injected shell tools can't read what isn't there.
- **Per-subscriber bounded SSE queues** — a slow client that overflows its queue gets a `client_evicted` terminal frame and is closed; one stuck consumer can't pin the daemon.
- **Graceful shutdown** — SIGINT/SIGTERM drain the agent children before closing the listener (10s deadline per child).

## Multi-session & remote deployment

A single `qwen serve` process can manage sessions for any workspace path passed via `cwd` on `POST /session` — under the default `sessionScope: 'single'` it keeps one ACP session per canonicalized workspace, sharing it across every client that posts the same `cwd`. So one daemon will happily host sessions for many workspaces at once.

To handle multiple **users** (each with their own quota, audit log, sandbox) or to scale beyond one process's reach (cold-start budget, FD count, RSS), you spawn multiple daemon instances behind an external orchestrator. That orchestrator (multi-tenancy / OIDC / Quota / Audit / k8s) is **out of scope** for the qwen-code project — see issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803) "External Reference Architecture" for the design pointers.

## What's next

- **Build a client?** See the [DaemonClient TypeScript quickstart](../developers/examples/daemon-client-quickstart.md) and the [HTTP protocol reference](../developers/qwen-serve-protocol.md).
- **Reading the source?** Bridge code lives at `packages/cli/src/serve/`; SDK client at `packages/sdk-typescript/src/daemon/`.
- **Tracking the roadmap?** Stage 1.5 / Stage 2 progress is tracked on issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803).
