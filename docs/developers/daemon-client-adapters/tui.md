# TUI Daemon Adapter Draft

> **⚠️ 已过时**：本文档描述的是早期 `DaemonTuiAdapter` spike。该 legacy adapter 仍在 `packages/cli/src/ui/daemon/` 中，但新的可复用方向是 SDK 里的共享 UI Transcript 层。当前架构请参考 [`../daemon/14-cli-tui-adapter.md`](../daemon/14-cli-tui-adapter.md)。

---

## Goal (historical)

Add a flag-gated TUI transport that talks to `qwen serve` through
`DaemonSessionClient` instead of creating an in-process `Config` + agent
runtime.

This is a dogfood path for Mode B client migration. It must not replace the
default TUI path until output sinks, typed daemon events, session-scoped
permission, and lifecycle diagnostics are stable.

## Proposed Entry Point

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
8. Route permission votes through `session.respondToPermission()`.

## Rendering Contract

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

Unknown events must be ignored, not fatal. Typed event reducers will land in a
later protocol PR.

The adapter is not wired into the default Ink app yet. Existing interactive TUI,
JSONL, stream-json, and dual-output behavior remains unchanged.

## Explicit Non-Goals

- Do not remove the current TUI in-process runtime.
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

## Blockers Before Default Migration

- Typed daemon event schema.
- Session-scoped permission route.
- Output sink refactor for JSONL / stream-json / dual-output parity.
- Session lifecycle close/delete semantics.
- Runtime diagnostics for MCP, skills, providers, and workspace env.
