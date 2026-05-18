# TUI Daemon Adapter Spike

## Goal

Document the default-off `DaemonTuiAdapter` spike that was added while
evaluating Mode B client integration.

As of the 2026-05-19 architecture decision, native local TUI is not planned to
default-migrate to daemon HTTP/SSE. The normal `qwen` terminal path remains a
long-term direct runtime / streamJson / Ink path because it avoids an extra
localhost HTTP server hop and keeps the local UX simpler and more reliable.

The useful follow-up from this spike is source-adapter / reducer / terminal
render-core extraction so native TUI and web terminal can share view-model and
rendering logic without forcing native TUI through daemon transport.

## Historical Experimental Entry Point

```bash
QWEN_DAEMON_URL=http://127.0.0.1:4170 qwen --experimental-daemon-tui
```

Optional:

```bash
QWEN_DAEMON_TOKEN=... QWEN_DAEMON_WORKSPACE=/repo qwen --experimental-daemon-tui
```

The CLI should refuse this mode unless both are true:

- `QWEN_DAEMON_URL` or `--daemon-url` is set.
- `GET /capabilities` advertises `session_create`, `session_prompt`, and
  `session_events`.

## Minimal Flow

1. Create `DaemonClient` with daemon URL and token.
2. Fetch `/capabilities`.
3. Create or attach with `DaemonSessionClient.createOrAttach()`.
4. Subscribe to `session.events()`.
5. Submit user prompts through `session.prompt()`.
6. Route cancel through `session.cancel()`.
7. Route model switch through `session.setModel()`.
8. Route permission votes through `session.respondToSessionPermission()` when
   advertised; fall back to the legacy permission route only for older daemons.

## Rendering Contract Reference

The first implementation adds `DaemonTuiAdapter`, a locally verifiable reducer
and transport spike. It maps only these daemon events:

| Daemon event                             | TUI handling                                 |
| ---------------------------------------- | -------------------------------------------- |
| `session_update` / `agent_message_chunk` | Append assistant text                        |
| `session_update` / `agent_thought_chunk` | Append thinking text                         |
| `session_update` / `tool_call`           | Show tool call lifecycle                     |
| `permission_request`                     | Show existing confirmation UI where possible |
| `permission_resolved`                    | Close or update confirmation UI              |
| `model_switched`                         | Update footer/model display                  |
| `session_died`                           | Show disconnected state and stop streaming   |

Unknown events must be ignored, not fatal. Typed event reducers should stay in
the daemon client/protocol layer, not in server internals, so server transport
code does not grow UI-specific state machines.

The adapter is not wired into the default Ink app. Existing interactive TUI,
JSONL, stream-json, and dual-output behavior remains unchanged.

## Explicit Non-Goals

- Do not remove the current TUI in-process runtime.
- Do not make daemon transport the default native TUI path.
- Do not change JSONL, stream-json, or dual-output behavior in this PR.
- Do not expose file CRUD, MCP management, memory CRUD, or provider/auth
  mutation through TUI yet.
- Do not make browser/web direct-to-daemon assumptions; this is terminal only.

## Merge Safety

- Default off.
- Additive code path.
- No existing CLI flags change behavior.
- If the daemon is unavailable, the experimental path fails before starting the
  TUI and tells the user to run `qwen serve`.

## Validation Plan

- Unit-test event-to-TUI-state mapping with synthetic daemon events.
- Unit-test prompt, cancel, model switch, and permission vote forwarding.
- Unit-test flag/env parsing when the feature flag is wired.
- Smoke-test against a local `qwen serve`:
  - prompt text streams into the TUI
  - cancel resolves the active prompt
  - permission request can be accepted or rejected
  - reconnect sends the tracked `Last-Event-ID`

## Current Follow-Up Direction

- Keep native TUI direct by default.
- Extract source adapters and a shared terminal render core that can be reused
  by native TUI and web terminal.
- Prioritize web terminal as the daemon-native terminal surface.
- Treat this spike as future-migration reference, not an active default
  migration checklist.
