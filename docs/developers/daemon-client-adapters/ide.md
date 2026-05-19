# IDE Daemon Adapter Draft

## Goal

Let the VS Code companion extension dogfood Mode B by connecting from the
extension host to `qwen serve` through `DaemonSessionClient`.

The webview must not call the daemon directly. The extension host owns daemon
URL, token, session id, and SSE replay state, then forwards sanitized app events
to the webview.

## Proposed Entry Point

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
8. Route permission decisions through `session.respondToPermission()`.

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
adapter spike. It is not wired into the default `QwenAgentManager` path yet, so
existing VS Code behavior remains ACP subprocess based.

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

## Blockers Before Default Migration

- Typed daemon event schema.
- Daemon-stamped client identity.
- Session-scoped permission route.
- Read-only runtime diagnostics.
- FileSystemService boundary and safe file read routes.
- Output sink refactor for CLI/TUI parity.
