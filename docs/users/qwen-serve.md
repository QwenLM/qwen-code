# Daemon mode (`qwen serve`)

Run Qwen Code as a local HTTP daemon so multiple clients (IDE plugins, web UIs, CI scripts, custom CLIs) share one agent session over HTTP + Server-Sent Events instead of each spawning their own subprocess.

> **Status:** Stage 1 (experimental). The protocol surface is locked at the §04 routes table from issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803). Stage 1.5 (`qwen --serve` flag — TUI co-hosts the same HTTP server) and Stage 2 (in-process refactor + `mDNS`/OpenAPI/WebSocket/Prometheus polish) are immediately downstream.
>
> **Scope honesty:** Stage 1 is sized for **developers prototyping clients against the protocol surface** and for **local single-user / small-team collaboration**. Production-grade multi-client / long-running / network-flaky workloads (mobile companions, IM bots reaching 1000+ chats, IDE extensions across many windows) need Stage 1.5+ guarantees that aren't in this release — see the [Stage 1.5+ runtime guarantees](#stage-15-runtime-guarantees) section below for the gap list and #3803 for the convergence roadmap.

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
#   data: {"id":1,"v":1,"type":"session_update","data":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}}
```

The `data:` line is the **full event envelope** — `{id?, v, type, data, originatorClientId?}` — JSON-stringified on a single line. The ACP payload (the `sessionUpdate` block in this example) sits under `data` inside that envelope. The SSE-level `id:` / `event:` lines are convenience for EventSource clients; the same values appear inside the JSON envelope so raw-`fetch` consumers get them too.

Open this **before** sending the prompt — the SSE replay buffer holds the
last 4000 events so a late subscriber can catch up via `Last-Event-ID`,
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

```bash
curl -H "Authorization: Bearer $QWEN_SERVER_TOKEN" http://your-host:4170/capabilities
# → {"v":1,"mode":"http-bridge","features":[...],"modelServices":[]}
# Wrong token → 401
```

The token comparison is constant-time (SHA-256 + `crypto.timingSafeEqual`); 401 responses are uniform across "missing header", "wrong scheme", and "wrong token" so a side-channel can't distinguish.

## CLI flags

| Flag                    | Default     | Purpose                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`            | `4170`      | TCP port. `0` = OS-assigned ephemeral port.                                                                                                                                                                                                                                                                                                         |
| `--hostname <addr>`     | `127.0.0.1` | Bind interface. Anything beyond loopback requires a token.                                                                                                                                                                                                                                                                                          |
| `--token <str>`         | —           | Bearer token. Falls back to `QWEN_SERVER_TOKEN` env var (with leading/trailing whitespace stripped — handy for `$(cat token.txt)`).                                                                                                                                                                                                                 |
| `--max-sessions <n>`    | `20`        | Cap on concurrent live sessions. New `POST /session` requests that would spawn a fresh child return `503` (with `Retry-After: 5`) when the cap is hit; attaches to existing sessions are NOT counted. Set to `0` to disable. Sized for single-user / small-team usage; raise it if your deployment has the RAM/FD headroom (~30–50 MB per session). |
| `--max-connections <n>` | `256`       | Listener-level TCP connection cap (`server.maxConnections`). Bounds raw socket count irrespective of session count — slow / phantom SSE clients get rejected at accept time once full. Raise alongside `--max-sessions` if your deployment expects many SSE subscribers per session.                                                                |
| `--http-bridge`         | `true`      | Stage 1 mode: per-session `qwen --acp` child process. Stage 2 native in-process becomes available later.                                                                                                                                                                                                                                            |

> **Sizing the load knobs.** `--max-sessions` is the **new-child** cap.
> Three other layers also limit load — when sizing for a high-concurrency
> deployment, tune them together:
>
> - **listener-level**: `--max-connections` / `server.maxConnections=256`
>   bounds raw TCP connections (slow-client back-pressure).
> - **per-session subscribers**: the EventBus caps SSE subscribers at
>   64 per session by default; the 65th client gets a terminal
>   `stream_error` and is closed.
> - **per-subscriber backlog**: a 256-frame queue per SSE client; an
>   over-capacity client gets a terminal `client_evicted` frame and is
>   closed (one slow consumer can't pin the daemon).
>
> The four caps interact: `--max-sessions × 64 subscribers × 256 frames`
> is the worst-case in-flight memory at the EventBus layer. Default
> sizing assumes single-user / small-team load; raise progressively
> (and watch RSS) for multi-tenant deployments.

## Default deployment threat model

- **127.0.0.1 only** — loopback bind, no auth needed.
- **`--hostname 0.0.0.0` requires a token** — boot refuses without one.
- **`LOOPBACK_BINDS` includes IPv6** — `::1` and `[::1]` count as loopback for the no-token rule.
- **Host header allowlist** — on **loopback** binds the daemon checks `Host:` matches `localhost:port` / `127.0.0.1:port` / `[::1]:port` / `host.docker.internal:port` (case-insensitive per RFC 7230 §5.4) to defend against DNS rebinding. **Non-loopback binds (`--hostname 0.0.0.0`) intentionally bypass the Host allowlist** — the operator has chosen the surface area, so the bearer-token gate is the sole authentication layer; reverse proxies / SNI / client cert pinning are the operator's responsibility, not the daemon's. If you need Host-based isolation on a non-loopback bind, terminate TLS + check Host at a front proxy.
- **CORS denies any browser Origin** — returns `403` JSON.
- **Spawned `qwen --acp` child inherits the daemon's environment** with one explicit scrub: `QWEN_SERVER_TOKEN` is removed before the child starts (the daemon's own bearer; the agent doesn't need it). Everything else — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `QWEN_*` / `DASHSCOPE_API_KEY` / your custom `modelProviders[].envKey` / etc. — passes through, because the agent legitimately needs those to authenticate to the LLM. **This is intentional, not a sandbox.** The agent runs as the same UID with shell-tool access, so anything in `~/.bashrc` / `~/.aws/credentials` / `~/.npmrc` is reachable by prompt injection regardless. The env passthrough is not the security boundary; the user-as-trust-root is. Don't run `qwen serve` under an identity that has env-resident credentials you wouldn't trust the agent with.
- **Per-subscriber bounded SSE queues** — a slow client that overflows its queue gets a `client_evicted` terminal frame and is closed; one stuck consumer can't pin the daemon.
- **Graceful shutdown** — SIGINT/SIGTERM drain the agent children before closing the listener (10s deadline per child).

> ⚠️ **Stage 1 known gap — phantom SSE connections behind NAT.** The
> daemon detects dead clients via TCP back-pressure on heartbeats
> (15s interval). A client that vanishes WITHOUT a TCP RST (e.g. a
> NAT box silently dropping idle flows) keeps the kernel-level socket
> "alive" until Node's keepalive probes time out — typically ~2 hours
> on Linux defaults. On `--hostname 0.0.0.0` deployments behind such
> NATs, phantom SSE connections can accumulate and eventually hit the
> 256 `server.maxConnections` ceiling. Stage 2 will add an
> application-level idle deadline (last-byte-written tracking +
> per-connection timeout). Until then, operators on networks that
> swallow RSTs may want to lower `server.keepAliveTimeout` via a
> reverse proxy or accept periodic daemon restarts.

## Multi-session & remote deployment

A single `qwen serve` process can manage sessions for any workspace path passed via `cwd` on `POST /session` — under the default `sessionScope: 'single'` it keeps one ACP session per canonicalized workspace, sharing it across every client that posts the same `cwd`. So one daemon will happily host sessions for many workspaces at once.

> **Subscribe BEFORE posting `modelServiceId` on attach.** When a client `POST /session` with a `modelServiceId` and the workspace already has a session running a different model, the daemon issues an internal `setSessionModel` call — failures are NOT propagated as an HTTP error (the session stays operational on its current model). The visible failure signal is a `model_switch_failed` event on the session's SSE stream. If you call `POST /session` and only THEN open `GET /session/:id/events`, you'll miss the failure event and silently keep talking to the wrong model. Open the SSE stream first, or pass `Last-Event-ID: 0` on subscribe to replay the ring's oldest available event.

To handle multiple **users** (each with their own quota, audit log, sandbox) or to scale beyond one process's reach (cold-start budget, FD count, RSS), you spawn multiple daemon instances behind an external orchestrator. That orchestrator (multi-tenancy / OIDC / Quota / Audit / k8s) is **out of scope** for the qwen-code project — see issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803) "External Reference Architecture" for the design pointers.

## Durability model

**Sessions are ephemeral in Stage 1.** Plan accordingly:

- A child process crash publishes `session_died` and removes the session from the daemon's maps. There is **no resume** — clients must `POST /session` again.
- A daemon restart loses every in-flight session. ACP's `loadSession` / `unstable_resumeSession` are **not exposed via HTTP** in Stage 1; sessions don't outlive the daemon.
- Long client disconnects (>5 min on a chatty turn) can outrun the SSE replay ring (default 4000 frames) — `Last-Event-ID` reconnect succeeds but state may be incoherent. For mobile / flaky-network clients, plan to re-create the session and re-open SSE on long drops.
- File operations (`writeTextFile`) are atomic across crashes (write-then-rename); they aren't atomic across daemon restarts in the sense of replaying — the file write either landed or it didn't.

If your integration needs cross-restart durability, you need either Stage 1.5+ (`loadSession` over HTTP, persistence layer) or your own application-level state recovery. Don't hold long-running, restart-sensitive state inside the daemon's session.

## Stage 1.5+ runtime guarantees

Stage 1's contract is sized for prototyping. Per [#3889 chiga0 downstream-consumer review](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427875644), the following are **not** in Stage 1 — production-grade integrations need Stage 1.5+ before relying on them:

**Blockers for serious downstream use:**

1. **Per-request `sessionScope` override** on `POST /session` — today the daemon-wide default is the only setting; a VSCode extension can't say "I want a private session for this window" against a daemon configured for shared sessions.
2. **`loadSession` / `unstable_resumeSession` over HTTP** — without this, no integration can survive a child crash or daemon restart, and the "1 daemon = 1 session, just spawn another" model is internally inconsistent (orchestrators can't recover state either).
3. **Persistent client identity (pair tokens + per-client revocation)** — Stage 1 uses one shared bearer; a leaked token revokes everyone, and `originatorClientId` is client-self-declared rather than daemon-stamped from authenticated identity.

**Reliability baseline:**

4. **Client-initiated heartbeat path** — distinguish "agent thinking" from "daemon dead" without waiting for the 15s server heartbeat.
5. **`permission_already_resolved` event** when a vote loses the first-responder race — currently UIs have to infer state from a `404`.
6. **Larger / per-session-configurable replay ring** — default 4000 covers short drops; mobile / chatty-turn workloads need 8000+ or per-session config.
7. **`slow_client_warning` event before `client_evicted`** — soft backpressure so well-behaved slow clients can self-throttle (trim render depth, drop chunks) before being terminated.

**Integration ergonomics:**

8. **`POST /session/:id/_meta` for IM-style context** — per-session key-value attached to subsequent prompts (chat id, sender, thread id) replaces the per-channel improvisation.
9. **`/capabilities` actual feature negotiation** — `protocol_versions: { acp: '0.14.x', daemon_envelope: 1 }` so clients can detect drift instead of falling through to "unknown frame, ignore".
10. **First-class durability documentation** (this section) — already shipped above.

The full convergence roadmap is tracked on [#3803](https://github.com/QwenLM/qwen-code/issues/3803).

## What's next

- **Build a client?** See the [DaemonClient TypeScript quickstart](../developers/examples/daemon-client-quickstart.md) and the [HTTP protocol reference](../developers/qwen-serve-protocol.md).
- **Reading the source?** Bridge code lives at `packages/cli/src/serve/`; SDK client at `packages/sdk-typescript/src/daemon/`.
- **Tracking the roadmap?** Stage 1.5 / Stage 2 progress is tracked on issue [#3803](https://github.com/QwenLM/qwen-code/issues/3803).
