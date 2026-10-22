# Daemon attach

Status: implemented.

[English](2026-10-21-daemon-attach.md) | [简体中文](2026-10-21-daemon-attach.zh-CN.md)

## Scope

`qwen attach` is a text terminal client for an existing session on a local daemon. It loads the session through the TypeScript SDK, renders normalized assistant/thought text, and forwards each stdin line as a prompt. The first version requires the session id; it does not list sessions and does not answer permission requests interactively.

## Command

```bash
qwen attach --session <session-id> [--port <port>] [--token <token>]
```

`--port` selects one daemon when more than one discovery record exists. A bearer daemon needs `--token`, `QWEN_SERVER_TOKEN`, or a sidecar written by `daemon start --save-token`.

## Behavior

- Select exactly one discovery record. No daemon or several daemons without `--port` is an error.
- Load the session with `DaemonSessionClient.load`, which seeds the subscription from the daemon replay ring and restores the transcript.
- Subscribe to `GET /session/:id/events` before sending any prompt, so model-switch and lifecycle events are not missed.
- Render normalized `assistant.text.delta` and `thought.text.delta` to stdout; `assistant.done` ends the line; normalized errors go to stderr.
- Each non-empty stdin line is sent as a single text content block through `POST /session/:id/prompt`.
- Ctrl+C closes the local terminal and exits without closing the daemon session.

## Security

- The token is resolved from the explicit flag, the environment, or the pid-scoped sidecar; it is never printed.
- The command uses the SDK's bearer-aware HTTP/SSE transport, so redirects and daemon auth follow the existing client contract.

## Limitations and follow-up

- Session discovery/listing is not included; the operator needs the id from Web Shell or another client.
- Permission requests are not answered by this text client yet. The session can still require approval through Web Shell; interactive permission selection is a follow-up.
- Rendering is text-only: tool cards, diffs, images, and attachments are not rendered.

## Verification

- Unit: target selection, token resolution, command registration.
- Live: attach against a daemon session created by Web Shell/SDK; verify assistant text and prompt round-trip.
