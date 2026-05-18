# IDE Daemon Adapter Spike

## Goal

Document the default-off IDE daemon adapter spike.

As of the 2026-05-19 architecture decision, the VS Code companion should keep
the existing `--acp` child path as its default integration. A daemon-backed IDE
adapter remains future / behind-flag evaluation after the web chat / web
terminal contract and daemon control-plane parity are stable.

The webview must not call the daemon directly. The extension host owns daemon
URL, token, session id, and SSE replay state, then forwards sanitized app events
to the webview.

## Historical Experimental Entry Point

VS Code settings:

```json
{
  "qwen-code.experimentalDaemon.enabled": true,
  "qwen-code.experimentalDaemon.url": "http://127.0.0.1:4170",
  "qwen-code.experimentalDaemon.token": ""
}
```

Environment fallback for local dogfood:

```bash
QWEN_IDE_DAEMON_URL=http://127.0.0.1:4170 code .
```

## Minimal Flow

1. Extension host creates `DaemonClient`.
2. Fetch `/capabilities` and verify workspace compatibility.
3. Create or attach with `DaemonSessionClient.createOrAttach()`.
4. Subscribe to `session.events()` in the extension host.
5. Translate daemon events into existing webview messages.
6. Send user prompts through `session.prompt()`.
7. Route cancel/model switch through `session.cancel()` and
   `session.setModel()`.
8. Route permission decisions through `session.respondToSessionPermission()`
   when advertised; fall back to the legacy permission route only for older
   daemons.

## Relationship To Existing ACP Connection

The first implementation introduces a sibling connection path, not replace
`AcpConnection`:

```text
QwenAgentManager
  current default -> AcpConnection -> qwen --acp child
  experimental    -> DaemonIdeConnection -> qwen serve HTTP/SSE
```

Both paths should feed the same higher-level webview callbacks where practical.
If an event cannot be faithfully mapped yet, the daemon path should surface a
clear unsupported-state warning rather than silently pretending parity.

This PR adds `DaemonIdeConnection` as the locally verifiable extension-host
adapter spike. It is not wired into the default `QwenAgentManager` path.
Existing VS Code behavior remains ACP subprocess based.

## Event Mapping Contract

| Daemon event                             | IDE handling                                 |
| ---------------------------------------- | -------------------------------------------- |
| `session_update` / `agent_message_chunk` | Existing assistant stream callback           |
| `session_update` / `agent_thought_chunk` | Existing thinking stream callback            |
| `session_update` / `tool_call`           | Existing tool-call update callback           |
| `permission_request`                     | Existing approval UI callback                |
| `permission_resolved`                    | Close/update approval UI                     |
| `model_switched`                         | Existing model-state callback where possible |
| `session_died`                           | Disconnect UI + reconnect affordance         |

Unknown events must be ignored or logged as debug metadata.

## Runtime Locality UX

The extension must make daemon locality visible:

- workspace/files are daemon-host paths
- MCP servers run on the daemon host
- skills load from the daemon filesystem
- provider credentials are resolved in the daemon process environment

Do not imply that local VS Code extensions, local browser profile, local
localhost services, or local SSH/kube credentials are automatically available to
the daemon.

## Explicit Non-Goals

- No default migration away from `AcpConnection`.
- No webview direct-to-daemon transport.
- No daemon-side file CRUD through the IDE until file service boundaries land.
- No reverse RPC for editor/browser/clipboard yet.
- No full remote-control integration.

## Merge Safety

- Default off behind setting/env.
- Additive sibling connection path.
- Existing VS Code ACP subprocess path unchanged.
- Daemon token never crosses into webview JavaScript.

## Validation Plan

- Unit-test daemon session factory connection and SSE event consumption.
- Unit-test daemon event to existing extension-host callback mapping.
- Unit-test prompt, cancel, model switch, and permission response forwarding.
- Unit-test settings/env resolution when the feature flag is wired.
- Smoke-test local extension host against `qwen serve`:
  - prompt streams into chat
  - cancel works
  - permission UI can resolve a request
  - SSE reconnect uses tracked `Last-Event-ID`

## Current Follow-Up Direction

- Keep the existing ACP subprocess path as the default IDE path.
- Revisit daemon IDE integration later in phases:
  1. web contract plus workspace/path identity checks
  2. editor-context routing plus auth/status UI
  3. control-plane parity
- Treat this spike as future-migration reference, not an active default
  migration checklist.
