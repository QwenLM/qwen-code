# add-remote-control

## Why

A qwen-code session today is bound to the terminal that started it. The
agent process, the filesystem, and the GPU all live on one machine, and
the only interface to that session is the local TUI. The user can neither
walk away from the workstation nor hand off the conversation to another
device. Anthropic ships this UX for Claude Code via a vendor-hosted relay
(see `code.claude.com/docs/en/remote-control`); no equivalent exists for
qwen-code that does not depend on a third party.

`qwen serve` Stage 1 (PRs #3889, #4113) already exposes a long-lived HTTP+SSE
daemon with multi-client session attach, permission voting, and event
replay. The remaining gaps are: (a) the daemon is headless-only — no way to
drive it from a familiar TUI; (b) auth is a single shared bearer with no
per-client identity, no revocation, and no audit; (c) the SSE replay ring is
in-memory only and does not survive daemon restart; (d) the daemon refuses
browser origins via CORS; (e) there is no shipped web client. This change
fills those gaps.

## What Changes

- **Daemon-hosted session model.** The daemon (`qwen serve`, optionally
  renamed/wrapped as `qwen rc serve`) owns the session lifecycle. The
  workstation terminal, laptop browser, and phone are peer clients of
  that daemon. `qwen` standalone (no daemon) remains supported for users
  who never want remote access.
- **Per-client pairing.** Workstation owner generates a short-lived pairing
  code; each client (terminal, web, phone PWA) trades it for a long-lived,
  named, revocable per-client token with explicit scopes. All actions are
  audit-logged with the originating client identity.
- **Durable event replay.** Per-session event ring is mirrored to a
  bounded on-disk WAL so that `Last-Event-ID` reconnect works across daemon
  restarts up to a configurable horizon.
- **Browser-safe transport.** CORS allowlist driven by the pairing system;
  optional WebSocket upgrade for environments where SSE-through-proxy is
  flaky.
- **Thin terminal client `qwen rc`.** Renders the existing Ink/React chat
  surface but uses the daemon's HTTP+SSE protocol instead of in-process
  ACP. Detach-on-exit; reattach with `qwen rc attach [name]`.
- **Mid-scope web client.** Static HTML/JS, no separate backend. Chat
  transcript, tool-call cards with diff viewer, approve/deny buttons,
  read-only file tree, slash-command palette.
- **Capability advertisement and audit endpoints.** `/capabilities`
  extended with `remoteControl: { version, transports, scopes }`. New
  endpoints for token issuance, listing, revocation, and audit log query.

## Capabilities

### New Capabilities

- `remote-session-host` — daemon-owned session lifecycle, persistence, and
  event replay durability semantics for sessions that are remotely
  attachable.
- `wire-protocol` — HTTP+SSE (and optional WS) endpoints, event envelope
  shapes, error model, and protocol versioning for remote-control clients.
- `pairing-auth` — short-lived pairing codes, long-lived per-client tokens
  with scopes, revocation, audit log, and CORS allowlist derived from
  paired origins.
- `clients` — behavioral requirements for the terminal client (`qwen rc`)
  and the web/PWA client, including reconnect, approval UX, and offline
  handling.

## User Stories

**S1. Start on workstation, continue on phone.** I start `qwen rc` at my
desk, work for ten minutes, then need to leave. I open the daemon URL on
my phone (already paired), see the live transcript, and continue the
conversation while walking to lunch. The terminal on my desk reflects
each new message as I type it from the phone.

**S2. Approve a bash command from anywhere.** The agent proposes a
destructive `git reset --hard` while I'm away from the workstation. My
phone gets a push (or vibrates from the PWA) showing the proposed
command and its diff context. I approve from the phone; the workstation
terminal, the open laptop browser tab, and the phone all show the same
approval landing and the tool result streaming in.

**S3. Reattach after laptop sleep.** My laptop sleeps for twenty
minutes. On wake, the browser tab silently reconnects via
`Last-Event-ID`; missed messages stream in chronological order. If the
daemon restarted while I was asleep, the on-disk WAL still replays up to
the configured horizon (default 24 h, 10 000 events).

**S4. Pair a new device.** I want to add my partner's laptop as a
read-only viewer. From the workstation I run `qwen rc pair --scope read`
and get a 60-second code. They open the daemon URL, paste the code, and
their browser receives a long-lived `read` token. They can see the
session but cannot send messages or approve tool calls. I can revoke
their token later from the workstation or the web client.

**S5. Audit what happened overnight.** I left the agent running a long
task. In the morning I list the audit log: which client sent which
message, which client approved which tool call, which tool calls were
denied or timed out.

**S6. The bearer token leaks.** I accidentally paste a pairing token
into a Slack channel. From any paired client I revoke that one token.
Other clients keep working. Audit log shows the last actions taken with
the leaked token. Daemon-wide rotation is not required.

## Impact

- **qwen-code repo**: new package `packages/cli/src/serve/remoteControl/`
  (pairing, audit, durable WAL, CORS), extensions to `serve/server.ts`,
  new command `qwen rc` (`packages/cli/src/commands/rc/`), shared
  client-rendering code lifted into `packages/cli/src/ui/` so it can be
  driven by either in-process ACP or HTTP+SSE.
- **New artifact**: web client under `packages/web-client/` (vanilla
  TS/HTML, build output served by the daemon at `/ui` behind the same
  bearer-token check).
- **No SDK breakage**: existing TS `DaemonClient` extended with pairing
  and audit methods; Python/Java SDKs unchanged (Phase 5 may add a daemon
  client for Python).
- **Upstream compatibility**: changes are additive to Stage 1; existing
  `QWEN_SERVER_TOKEN` continues to work as a single-bearer fallback when
  pairing is disabled, so existing scripts do not break.
- **Out of scope** (deliberately):
  - Vendor-hosted relay or any service that bridges across NATs on the
    user's behalf. Reachability is the operator's problem (Tailscale,
    Cloudflare Tunnel, reverse proxy).
  - Federated multi-user / multi-tenant operation. One daemon = one
    workspace = one human owner. Paired collaborators are second-class
    by design.
  - End-to-end encryption beyond TLS termination. Operator is trusted
    relative to clients; daemon-on-disk state is not encrypted by this
    spec.
  - Mode A (in-process TUI daemon, upstream issue #4156). This change
    deliberately avoids embedding HTTP in the interactive TUI process;
    instead it makes the TUI itself a client.
  - Mobile-native applications (iOS/Android). The web client is a PWA;
    native shells are a follow-up.
