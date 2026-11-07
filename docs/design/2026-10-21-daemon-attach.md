# Daemon attach

Status: implemented.

[English](2026-10-21-daemon-attach.md) | [简体中文](2026-10-21-daemon-attach.zh-CN.md)

## Scope

`qwen attach` is a text terminal client for an existing session on a local daemon. It loads the session through the TypeScript SDK, renders normalized assistant/thought text, and forwards each stdin line as a prompt. The first version requires the session id; it does not list sessions and does not answer permission requests interactively.

## Command

```bash
qwen attach --session <session-id> [--port <port>] [--workspace <path>] [--token <token>]
```

`--port` selects one daemon when more than one discovery record exists. `--workspace` names the registered workspace that owns the session; when the daemon serves one workspace, it is selected automatically. A bearer daemon needs `--token`, `QWEN_SERVER_TOKEN`, or a sidecar written by `daemon start --save-token`.

## Behavior

- Select exactly one discovery record. No daemon or several daemons without `--port` is an error.
- Load the session with `DaemonSessionClient.load`, passing the target workspace when it is known.
- Render the load replay snapshot (`compactedReplay` and `liveJournal`) before starting the SSE subscription, so history and an in-flight turn are visible on attach.
- Subscribe to `GET /session/:id/events` before accepting stdin, so model-switch, lifecycle, and prompt response events are not missed.
- Render sanitized `assistant.text.delta` and `thought.text.delta` to stdout; turn settlement (`turn_complete`/`turn_error`) and prompt settlement end the line; normalized errors go to stderr.
- Other normalized event types (tool calls, file diffs, lifecycle notices) are intentionally not rendered; attach is a text-only terminal client, not a full Web Shell transcript.
- Each non-empty stdin line is sent as a single text content block through `POST /session/:id/prompt`.
- Ctrl+C or Ctrl+D closes the local subscription, releases this client's daemon registration, and exits. Detaching does not cancel an already accepted prompt; an in-flight turn continues server-side. When this is the last client and no turn is pending, the daemon may close the session.

## Security

- The token is resolved from the explicit flag, the environment, or the pid-scoped sidecar; it is never printed.
- Ambient `QWEN_SERVER_TOKEN` and sidecar tokens are sent only after `listenerIdentityVerified` confirms the recorded daemon owns the listener; an explicit `--token` is operator-supplied and remains allowed. An `auth: none` daemon is never sent an ambient token.
- Assistant, thought, permission, and error text is passed through `sanitizeTerminalText` before terminal output, so model-provided escape sequences cannot clear the screen or write the clipboard. Server-derived error messages written to stderr are sanitized the same way.
- The command uses the SDK's bearer-aware HTTP/SSE transport, so redirects and daemon auth follow the existing client contract.

## Limitations and follow-up

- Session discovery/listing is not included; the operator needs the id from Web Shell or another client.
- Permission requests are not answered by this text client yet. The session can still require approval through Web Shell; interactive permission selection is a follow-up.
- Rendering is text-only: tool cards, diffs, images, and attachments are not rendered.

## Verification

- Unit: target selection, token resolution, command registration.
- Live: attach against a daemon session created by Web Shell/SDK; verify assistant text and prompt round-trip.
