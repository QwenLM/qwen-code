# Design — add-remote-control

## Context

Stage 1 of `qwen serve` (PRs #3889, #4113) defined a usable HTTP+SSE
session daemon: bearer auth, `POST /session` attach, `POST
/session/:id/prompt` with per-session FIFO, `GET /session/:id/events` SSE
with `Last-Event-ID` replay (4000-event ring), `POST
/permission/:requestId` first-responder voting, and JSONL transcripts at
`~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`. The protocol
is documented at `docs/developers/qwen-serve-protocol.md` and implemented
in `packages/cli/src/serve/{server,httpAcpBridge,eventBus,inMemoryChannel}.ts`.

What Stage 1 is missing for a Claude-Code-style remote control UX:

- The interactive TUI process cannot be reached over HTTP. Upstream's
  Mode A proposal (issue #4156, abandoned PRs #3929–#3931) tried to fix
  this by embedding the HTTP server in the TUI process. We deliberately
  reject that approach (see Decision D1).
- One shared bearer token per process. No per-client identity, no
  scopes, no revocation, no audit-by-identity.
- The SSE replay ring is in memory; daemon restart wipes it.
- CORS is denied for browsers — phone PWAs cannot reach the daemon
  directly without a reverse proxy that strips the daemon's CORS-deny.
- No shipped client beyond `curl` and the TS `DaemonClient` SDK.

## Goals / Non-Goals

**Goals:**

- Start a session on the workstation, drive it from any paired device.
- Multi-client sync: messages, tool-call proposals, approvals, results
  appear on every attached client.
- Reconnect-after-disconnect that survives both client sleep (in-memory
  ring) and short daemon restarts (on-disk WAL).
- Per-client identity strong enough to answer "who approved that bash
  call?" in an audit log and to revoke one client without disrupting
  others.
- Browser-first second client — phone is a first-class target.

**Non-Goals:**

- Mode A (in-process TUI daemon). The TUI is a client of the daemon.
- Self-discovery across the public internet (no relay, no DNS magic).
  Reachability is the operator's problem.
- Multi-tenant or federated identity. One daemon, one owner.
- End-to-end encryption beyond TLS. Operator trusts the host they run
  the daemon on.
- Native mobile apps (Phase 6+ at earliest).

## Architecture

```
                                    ┌─────────────────────────────────┐
                                    │  Workstation (pkix-server)      │
                                    │                                 │
                                    │  ┌──────────────────────────┐   │
                                    │  │ qwen serve (daemon)      │   │
                                    │  │                          │   │
                                    │  │   ┌──────────────────┐   │   │
                                    │  │   │ HTTP + SSE/WS    │   │   │
                                    │  │   │ + CORS allowlist │   │   │
                                    │  │   └────────┬─────────┘   │   │
                                    │  │            │             │   │
                                    │  │   ┌────────┴─────────┐   │   │
                                    │  │   │ Pairing & Auth   │   │   │
                                    │  │   │ - codes (TTL)    │   │   │
                                    │  │   │ - client tokens  │   │   │
                                    │  │   │ - scopes/revoke  │   │   │
                                    │  │   │ - audit log      │   │   │
                                    │  │   └────────┬─────────┘   │   │
                                    │  │            │             │   │
                                    │  │   ┌────────┴─────────┐   │   │
                                    │  │   │ Session manager  │   │   │
                                    │  │   │ - per workspace  │   │   │
                                    │  │   │ - FIFO prompts   │   │   │
                                    │  │   │ - perm-vote      │   │   │
                                    │  │   └────────┬─────────┘   │   │
                                    │  │            │             │   │
                                    │  │   ┌────────┴─────────┐   │   │
                                    │  │   │ Event bus        │   │   │
                                    │  │   │ - in-mem ring    │   │   │
                                    │  │   │ - durable WAL ───┼───┼───┼──▶ ~/.qwen/rc/wal/<sid>.log
                                    │  │   └────────┬─────────┘   │   │
                                    │  │            │             │   │
                                    │  │   ┌────────┴─────────┐   │   │
                                    │  │   │ qwen --acp child │───┼───┼──▶ ~/.qwen/projects/<cwd>/chats/<sid>.jsonl
                                    │  │   │ (the agent)      │   │   │
                                    │  │   └──────────────────┘   │   │
                                    │  └──────────────────────────┘   │
                                    │              ▲                  │
                                    │              │ loopback         │
                                    │  ┌───────────┴──────────────┐   │
                                    │  │ qwen rc  (terminal       │   │
                                    │  │ client, Ink/React TUI)   │   │
                                    │  └──────────────────────────┘   │
                                    └────────────┬────────────────────┘
                                                 │ TLS via Tailscale /
                                                 │ Cloudflare Tunnel /
                                                 │ reverse proxy
                          ┌──────────────────────┼──────────────────────┐
                          │                      │                      │
                ┌─────────┴────────┐   ┌─────────┴────────┐   ┌────────┴─────────┐
                │ Laptop browser   │   │ Phone browser /  │   │ Other paired     │
                │ (HedyLamarr/WSL) │   │ PWA              │   │ device           │
                └──────────────────┘   └──────────────────┘   └──────────────────┘
```

Key points the diagram encodes:

- The daemon is the only process that holds a session. The terminal client
  on the workstation is a peer of the laptop browser, not a privileged
  host.
- The `qwen --acp` agent child stays on the daemon side. No code or
  filesystem access leaves the workstation.
- The WAL on disk is what makes daemon restart survivable.
- Reachability across machines is delegated entirely to the operator's
  network layer (Tailscale, CF Tunnel, plain LAN, etc.).

## Wire protocol — overview

Normative details are in `specs/wire-protocol/spec.md`. Summary of the
shape (additive to Stage 1's protocol):

### Endpoints

| Method | Path                        | Purpose                                       | Auth                |
| ------ | --------------------------- | --------------------------------------------- | ------------------- |
| GET    | `/health`                   | liveness                                      | none on loopback    |
| GET    | `/capabilities`             | feature flags + `remoteControl` block         | any token           |
| POST   | `/rc/pair`                  | mint a one-time pairing code                  | owner scope         |
| POST   | `/rc/pair/redeem`           | exchange code for client token                | none (code carries) |
| GET    | `/rc/tokens`                | list paired clients                           | owner scope         |
| DELETE | `/rc/tokens/:id`            | revoke a paired client                        | owner scope         |
| GET    | `/rc/audit?since=…&limit=…` | audit log query                               | owner+read scopes   |
| POST   | `/session`                  | create or attach session                      | session scope       |
| GET    | `/workspace/:cwd/sessions`  | list sessions for workspace                   | session scope       |
| POST   | `/session/:id/prompt`       | send user prompt                              | write scope         |
| POST   | `/session/:id/cancel`       | cancel active prompt                          | write scope         |
| POST   | `/session/:id/model`        | switch model                                  | write scope         |
| GET    | `/session/:id/events`       | SSE event stream                              | read scope          |
| GET    | `/session/:id/ws`           | optional WS upgrade (same events)             | read scope          |
| POST   | `/permission/:requestId`    | vote on tool approval                         | approve scope       |
| GET    | `/files?glob=…`             | read-only file enumeration for @-autocomplete | read scope          |
| GET    | `/files/content?path=…`     | read-only file content for diff/view          | read scope          |
| GET    | `/ui/*`                     | static web client                             | any token           |

Stage 1's existing endpoints retained verbatim where possible to keep the
TS SDK's `DaemonClient` source-compatible.

### SSE event envelope

```jsonc
{
  "id":   "0000000000000123",       // monotonic per-session, hex
  "v":    1,                         // protocol version
  "type": "session_update" | "permission_request" | ...,
  "originatorClientId": "tkn_abc",   // null if from agent or system
  "data": { /* type-specific payload */ }
}
```

Event types (additive to Stage 1):

- `session_update`, `permission_request`, `permission_resolved`,
  `model_switched`, `model_switch_failed`, `session_died`,
  `client_evicted`, `stream_error` — unchanged from Stage 1.
- `client_joined` / `client_left` — new; clients render presence.
- `audit_event` — new; mirrored from audit log so all clients can see
  who approved what in real time (subject to scope).
- `ui_command` — new; carries slash-command outcomes that need
  cross-client rendering (`/compact`, `/clear`, `/usage`).

### Versioning

`v: 1` for this change. `/capabilities` returns `remoteControl.version`
and `supportedTransports: ["sse", "ws"]` so a client can negotiate.
Breaking changes bump `v` and the daemon will reject mismatched clients
with a 426 Upgrade Required.

## Auth & threat model

### Pairing flow

1. Owner (workstation user with shell access to the daemon process)
   creates a pairing code: `POST /rc/pair { name, scope, ttlSec }` →
   `{ code: "xxxx-yyyy-zzzz", expiresAt }`. Codes are 9 chars of
   base32-Crockford, single-use, default TTL 90 seconds. Code is shown
   on stdout and (optionally) as a QR for phone scanning.

2. New client opens the daemon URL, posts the code: `POST /rc/pair/redeem
{ code, name?, userAgent }` → `{ tokenId, token, scopes, expiresAt
}`. Token is base64url(32 random bytes), prefixed `qwk_`. Default
   lifetime 30 days, sliding renewal on use.

3. Client stores `token` and sends `Authorization: Bearer <token>` on
   every request. Tokens MUST NOT appear in URLs; the web client stores
   them in `localStorage` namespaced by daemon origin.

### Scopes

| Scope   | Permissions                                                           |
| ------- | --------------------------------------------------------------------- |
| owner   | All. Mint/list/revoke tokens. Read audit. Implies write+read+approve. |
| write   | Send prompts, cancel, switch model. Implies read.                     |
| approve | Vote on permission requests. Implies read.                            |
| read    | Subscribe to events, read files for view, list sessions.              |

Owner scope is bootstrapped exactly once at daemon startup: the daemon
prints a one-time `owner-bootstrap` code to stdout (or to a file
`~/.qwen/rc/owner-bootstrap.code` mode 0600), valid until first use.
After redemption the bootstrap path is closed; further owner tokens are
minted only from an existing owner-scope client.

### Audit

Every request is logged with `{timestamp, tokenId, clientName,
ip, method, path, sessionId?, action, outcome}`. Permission votes,
prompts, and revocations are flagged `material: true` and replicated as
`audit_event` SSE frames to all clients with `read` scope (so the
workstation operator can see actions in real time even without opening
the web UI).

Audit log is append-only JSONL at `~/.qwen/rc/audit.log` with daily
rotation. Retention default 30 days; configurable.

### Threat model

| Attacker                             | Capability                             | Mitigation                                                                                                                                  |
| ------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Network passive (no TLS terminator)  | Read traffic                           | Operator MUST terminate TLS upstream. Daemon SHOULD refuse non-loopback bind without `--tls` or a documented opt-out.                       |
| Network active (proxy in path)       | Modify traffic                         | TLS as above. Tokens are bearer-only, no replay defense beyond TLS; reauthentication after revocation is fast.                              |
| LAN attacker, no token               | Probe daemon                           | All endpoints except `/health` on loopback require bearer. CORS denies unrecognized origins.                                                |
| Bootstrap code leak before first use | Become owner                           | Bootstrap code TTL 5 min (configurable); printed to console + restrictive-mode file only; first-use closes the path.                        |
| Pairing code leak in 90 s window     | Become a paired client of stated scope | Codes single-use; default TTL 90 s; owner-scope codes require an interactive confirm at the daemon's controlling tty if `--strict-pairing`. |
| Long-lived token leak                | Drive sessions until revoked           | Per-client revocation (`DELETE /rc/tokens/:id`); audit log records what the token did; sliding renewal stops on revoke.                     |
| Compromised paired client device     | Same as token leak                     | Revoke. Audit log gives blast-radius bound.                                                                                                 |
| Local process on workstation         | Read tokens from disk                  | Tokens stored hashed (Argon2id) — daemon never persists plaintext after issue. Clients persist their own token in OS-appropriate storage.   |
| Operator (daemon host)               | All. Out of scope.                     | The daemon trusts the host; this is by design.                                                                                              |

### What leaks if `qwk_*` leaks

- Attacker can act with that token's scope (no privilege escalation) on
  any session in the workspace, until the token is revoked.
- Attacker can see audit events for sessions in scope.
- Attacker cannot mint new tokens (unless scope is `owner`).
- Attacker cannot read non-workspace files; file endpoints are
  workspace-rooted.

## Session lifecycle

```
   create ──▶ active ◀──▶ idle (no prompts in flight)
                 │
                 ├──▶ ended (POST /session/:id/end)
                 ├──▶ died (agent child crash → terminal SSE frame)
                 └──▶ gc (no clients attached + idle > gcAfterSec)
```

- **create**: `POST /session`. Default scope `single` per workspace — a
  second call returns the same `sessionId` with `attached: true` (Stage
  1 behavior, preserved).
- **active**: at least one prompt in flight or queued. FIFO.
- **idle**: no prompts; clients may still be attached. WAL still
  flushing.
- **ended**: explicit `POST /session/:id/end` from a write-scope client.
  Final `session_died` frame; JSONL transcript closed; WAL flushed and
  retained per retention policy.
- **gc**: opportunistic. If no clients attached and idle longer than
  `gcAfterSec` (default 4 h) and the agent child has been idle, the
  session is marked ended automatically. The user can disable GC per
  session.

Reconnection:

- Client reconnects to `GET /session/:id/events` with `Last-Event-ID:
<hex>`. Daemon replays from in-memory ring if present; if id is older
  than the ring's earliest, falls back to WAL replay; if older than WAL
  horizon, returns `412 Precondition Failed` and the client begins fresh
  with a `replay_truncated` event.

## Persistence

| File                                       | Format                        | Purpose                                  | Retention                                         |
| ------------------------------------------ | ----------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `~/.qwen/projects/<cwd>/chats/<sid>.jsonl` | JSONL                         | Canonical agent transcript (Stage 1)     | Inherits qwen-code default                        |
| `~/.qwen/rc/wal/<sid>.log`                 | Length-prefixed CBOR or JSONL | Durable SSE event ring                   | Bounded: max 10 k events or 24 h, whichever first |
| `~/.qwen/rc/tokens.db`                     | SQLite                        | Token store (hashed), pairing codes      | Until revoke / expiry                             |
| `~/.qwen/rc/audit.log` (daily-rotated)     | JSONL                         | Audit events                             | 30 days, configurable                             |
| `~/.qwen/rc/config.toml`                   | TOML                          | Daemon CORS allowlist, scopes, GC config | Persistent                                        |

SQLite is chosen for `tokens.db` for transactional safety with concurrent
pairing flows; everything else is append-friendly flat files.

## Decisions

### D1 — Daemon-hosted session, terminal-as-client (over Mode A)

**Choice**: The session always lives in `qwen serve`. The workstation
terminal (`qwen rc`) is a thin client of that daemon over the same
HTTP+SSE protocol the phone uses.

**Alternative considered**: Upstream's Mode A (embed HTTP server inside
the interactive TUI process so external clients can attach to it
directly). Tried by abandoned PR stack #3929–#3931.

**Why**: (1) Mode A re-implements multi-client semantics in the TUI
process, duplicating logic that already exists in `qwen serve`. (2)
Mode A entangles UI rendering with network I/O, making the TUI's state
machine more complex. (3) Daemon-as-host gives "session survives terminal
close" for free. (4) Symmetric clients (terminal == phone) means we
implement reconnect, replay, and approval-voting once.

**Cost**: Terminal-only users pay a small loopback HTTP cost. `qwen`
standalone (no daemon) still works for users who never want remote
access; this change does not deprecate it.

### D2 — Per-client pairing tokens over shared bearer

**Choice**: Each client (workstation TUI, laptop, phone, partner's
viewer) gets its own `qwk_*` token via a pairing flow. Scopes are
distinct (owner/write/approve/read). Tokens are revocable individually.

**Alternative considered**: Keep `QWEN_SERVER_TOKEN` and add an audit
log on top. Cheaper, no schema, but no per-identity audit and a leak
forces full rotation.

**Why**: The user explicitly opted in to this depth in the design
interview, and the threat model section above gives concrete blast-
radius reduction. The shared-bearer path is preserved as a fallback for
operators who don't enable pairing (back-compat with Stage 1 scripts).

**Cost**: A token store (SQLite), a pairing endpoint pair, audit-log
plumbing. Phase 2 of the implementation plan.

### D3 — Durable WAL behind the in-memory ring

**Choice**: Mirror SSE events to an on-disk WAL bounded by event count
and time horizon. On reconnect, prefer in-memory ring, fall back to WAL,
return `412` if older than WAL.

**Alternative considered**: Replay from the JSONL transcript directly.
JSONL is the agent transcript, not the SSE event stream; reconstructing
event envelopes (especially `permission_request` mid-flight)
post-hoc is awkward.

**Why**: Decouples "what the agent wrote to history" from "what events
the protocol emitted." Lets us evolve the SSE event types without
disturbing the transcript schema. Bounded WAL keeps disk usage
predictable.

**Cost**: A second on-disk artifact per session. Mitigated by tight
bounds and automatic rotation.

### D4 — SSE first, WS optional

**Choice**: SSE is the default and the spec-of-record. WebSocket upgrade
is offered at `GET /session/:id/ws` for environments where SSE through
proxies misbehaves (notably some corporate proxies and older CDN edges).
The event envelope and types are identical; only the framing differs.

**Alternative considered**: WS as primary, SSE as fallback. WS is more
flexible but has more failure modes (binary vs text framing, ping/pong
timeouts, harder reverse-proxy compatibility). SSE through Nginx /
Caddy / Cloudflare Tunnel "just works" with `proxy_buffering off;`.

**Why**: Optimize for the common operator path (Tailscale + reverse
proxy). WS is there when SSE breaks for a specific operator.

**Cost**: Two code paths to test for the multi-client reconnect feature.

### D5 — Tokens in `Authorization` header only, never in URL

**Choice**: All token-bearing requests use `Authorization: Bearer`.
Never as query parameter, never as path segment.

**Alternative considered**: Allow `?token=…` for browser EventSource
clients (since the browser EventSource API has no header customization).

**Why**: Tokens in URLs leak via referrer headers, proxy logs, browser
history, server access logs. The cost of avoiding this is using `fetch`

- a streaming reader (or the `EventSource` polyfill with header support)
  in the web client, which is well-trodden ground.

**Cost**: Web client cannot use the native `EventSource` class as-is.
Mitigation: ship a small `fetch`-based SSE reader (~80 LoC).

### D6 — One daemon = one workspace (preserve Stage 1 invariant)

**Choice**: Inherit Stage 1's `1 daemon = 1 workspace` rule (PR #4113).
Users who want to remote-control multiple projects run one daemon per
project on different ports.

**Alternative considered**: Multi-workspace daemon.

**Why**: Multi-workspace adds significant complexity to pairing
(workspace-scoped tokens?), audit (which workspace did this client
act in?), and CORS (per-workspace allowlists?). Not worth it for this
change.

**Cost**: Operators with N projects run N daemons. Acceptable.

## Risks / Trade-offs

| Risk                                                 | Likelihood | Impact | Mitigation                                                                                                                                                  |
| ---------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE through reverse proxy buffers / fails            | M          | H      | Phase 1 test plan exercises Caddy + Nginx + Cloudflare Tunnel against a long-running session before shipping. WS fallback in Phase 4 covers residual cases. |
| Pairing UX clunky on phone (typing 9 chars)          | M          | M      | QR code path on TUI side; web pairing page can deep-link from QR scan.                                                                                      |
| Upstream `qwen serve` API changes mid-build          | M          | M      | Pin to a known Stage 1 commit during Phase 1; track upstream issue #4175 (Mode B roadmap) and #4156 (Mode A) for divergence.                                |
| Web client supply-chain bloat                        | L          | M      | Vanilla TS, no framework, single build step (esbuild). No npm dep on React/Vue.                                                                             |
| Token store migration when scopes evolve             | L          | M      | SQLite with a `schema_version` row; migrations are append-only.                                                                                             |
| WAL growth on long sessions                          | M          | M      | Strict bounds; rotate when full; old segments deleted on horizon roll.                                                                                      |
| Approval race (two clients vote near-simultaneously) | L          | L      | Stage 1's first-responder-wins handles this; losers get a 404 and re-render with the resolved state.                                                        |
| Terminal client diverges from upstream TUI           | M          | M      | Lift shared rendering into `packages/cli/src/ui/` so both upstream TUI and `qwen rc` consume it.                                                            |

## Deferred decisions

These are intentionally not resolved in this change. Each will need a
follow-up OpenSpec change before implementation.

- **Push notifications**: PWA can install but native push (APNs/FCM)
  needs a separate, optional, opt-in store-bought service or self-hosted
  WebPush. Not in this change.
- **mDNS / Bonjour discovery on LAN** (Stage 2 upstream item). Useful
  but orthogonal to the auth/transport core.
- **Workspace trust prompt** (Anthropic equivalent: "do you trust this
  directory"). qwen-code does not currently have this concept; we don't
  add it in this change.
- **Python and Java daemon SDKs**. TS gets full coverage; others stay
  subprocess-only for now.
- **Rate limiting beyond Stage 1's per-session FIFO**. Token-bucket per
  client is plausible but not specified here.
- **Multi-workspace daemon** (see D6).
- **Cross-session multiplex in one SSE stream** (e.g.
  `GET /events?session=…&session=…`). Stage 1 is one stream per session;
  we keep it that way.

## Open questions

1. **Should we expose `/files/content` (read-only) under `read` scope or
   require a separate `files` scope?** Leaning toward `read` for
   simplicity, since the web client needs it for diff preview before
   approval, but it's an information leak vector if `read` tokens are
   widely shared. The capability spec currently puts it under `read`;
   alignment phase of Phase 2 should revisit.

2. **Should the daemon refuse to bind a non-loopback address without
   TLS?** Strong default: yes. Override: `--insecure-no-tls`. Want
   confirmation before locking this in.

3. **Pairing-code length and TTL defaults.** 9 chars Crockford / 90 s is
   a guess. Should we follow Anthropic's apparent QR-deeplink pattern
   (very short window, single use) or favor manual-typing humans (longer
   TTL, more chars)? Phase 2 prototype + measurement.

4. **Audit log scope for read-scope clients.** Today the design pushes
   `audit_event` to anyone with `read`. Should `read` see all audits, or
   only audits about sessions they have observed? Conservative: only
   sessions they have observed. Open for debate.

5. **Does `qwen rc` deprecate plain `qwen` for interactive use, or
   coexist forever?** Coexist is the current answer; revisit after
   Phase 3 once we have user feedback.
