# Channel And Web Backend Daemon Adapter Spike

## Goal

Document the default-off `DaemonChannelBridge` spike for server-side channel
and web backends.

As of the 2026-05-19 architecture decision, web chat / web terminal are the
first daemon-native client targets. Channel adapters should continue to use the
existing ACP subprocess behavior by default; daemon channel integration remains
future / behind-flag evaluation.

This draft covers server-side clients only:

- Channel bot backend -> `qwen serve`
- Web browser -> web backend / BFF -> `qwen serve`

It explicitly does not allow browser JavaScript to call the daemon directly.
The daemon currently rejects browser `Origin` requests by design.

## Proposed Entry Points

Proposed historical channel backend experiment, not a wired command today:

```bash
QWEN_CHANNEL_DAEMON_URL=http://127.0.0.1:4170 qwen channel start telegram
```

Web backend / BFF target:

```bash
QWEN_WEB_DAEMON_URL=http://127.0.0.1:4170 qwen web-chat-backend
```

Shared optional variables:

```bash
QWEN_DAEMON_TOKEN=...
QWEN_DAEMON_WORKSPACE=/repo
```

## Minimal Channel Flow

This PR adds `DaemonChannelBridge`, a locally verifiable server-side bridge for
channel and web-backend adapters. It keeps the existing ACP bridge as the
default and owns daemon session state inside the backend process.

1. Resolve channel sender/thread to a channel session key.
2. Use `DaemonClient` + `DaemonSessionClient.createOrAttach()`.
3. Submit inbound user text with `session.prompt()`.
4. Subscribe to `session.events()` and collect assistant text chunks.
5. Send final text back through the platform adapter.
6. Cast permission votes through `session.respondToSessionPermission()` when
   `caps.features.session_permission_vote` is advertised; use the legacy
   request-id route only for explicitly single-user or older-daemon fallback.
7. Cancel active work through `session.cancel()`.

## Minimal Web Backend Flow

1. Browser opens a websocket or HTTP stream to the web backend.
2. Backend owns `DaemonSessionClient`.
3. Backend translates browser messages to daemon prompts.
4. Backend translates daemon SSE events to browser-safe app events.
5. Backend stores the daemon `sessionId` and last seen event id server-side.

Browser clients must not receive daemon bearer tokens.

## Session Isolation Constraint

Multi-user channel or web deployments must explicitly isolate sessions. Use
per-request `sessionScope: 'thread'` when supported; otherwise choose one of
these safe shapes:

- one daemon per channel thread / web room
- one daemon per user workspace
- single-user demo only

Do not silently multiplex unrelated channel threads into one daemon session.

## Event Mapping Contract

| Daemon event                             | Channel/web backend handling           |
| ---------------------------------------- | -------------------------------------- |
| `session_update` / `agent_message_chunk` | Append assistant text                  |
| `session_update` / `agent_thought_chunk` | Optional hidden/debug stream           |
| `session_update` / `tool_call`           | Emit tool status card/message          |
| `permission_request`                     | Platform-specific approval interaction |
| `permission_resolved`                    | Close/update approval interaction      |
| `model_switched`                         | Update backend session metadata        |
| `session_died`                           | Notify user and stop stream            |

Unknown daemon events must be ignored or forwarded as debug metadata, not fatal.

The bridge is not wired into `qwen channel start` by default. Existing Telegram,
Weixin, Dingtalk, plugin channel, and browser behavior remains unchanged.

## Explicit Non-Goals

- No browser direct-to-daemon fetch or EventSource.
- No CORS relaxation in this adapter PR.
- No default migration of Telegram, Weixin, Dingtalk, or plugin channels.
- No file CRUD, memory CRUD, MCP restart, or provider mutation.
- No sessionScope emulation in the client when daemon-side support is absent.

## Merge Safety

- Default off.
- Existing ACP channel bridge remains the default.
- Web backend is an explicit BFF layer, not a daemon security change.
- No channel adapter should import daemon tokens into frontend/browser code.

## Validation Plan

- Unit-test channel session-key to daemon-session binding.
- Unit-test daemon event to channel/web message mapping.
- Unit-test prompt, cancel, model switch, and permission response forwarding.
- Smoke-test one single-user channel backend against local `qwen serve`.
- Smoke-test browser -> BFF -> daemon without exposing daemon token.

## Current Follow-Up Direction

- Prioritize web chat / web terminal daemon integration first.
- Keep channel adapters on the existing ACP bridge by default.
- Revisit daemon channel integration only after web contract, runtime
  diagnostics, identity, permission, and session lifecycle semantics are stable.
- Treat this spike as a server-side bridge reference, not a default migration
  checklist.
