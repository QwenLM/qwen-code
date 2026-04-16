# Dual Output

Dual Output is a sidecar mode for the interactive TUI: while Qwen Code keeps
rendering normally on `stdout`, it concurrently emits a structured JSON event
stream to a separate channel so an external program — an IDE extension, a web
frontend, a CI pipeline, an automation script — can observe and steer the
session.

It also provides a reverse channel: an external program can write JSONL
commands into a file that the TUI watches, allowing it to submit prompts and
respond to tool-permission requests as if a human were at the keyboard.

Dual Output is fully optional. When the flags below are absent the TUI behaves
exactly as before with no extra I/O and no behavioral changes.

## Flags

| Flag                  | Type             | Purpose                                                                                                                                    |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--json-fd <n>`       | number, `n >= 3` | Write structured JSON events to file descriptor `n`. The caller must provide this fd via spawn `stdio` configuration or shell redirection. |
| `--json-file <path>`  | path             | Write structured JSON events to a file. The path can be a regular file, a FIFO (named pipe), or `/dev/fd/N`.                               |
| `--input-file <path>` | path             | Watch this file for JSONL commands written by an external program.                                                                         |

`--json-fd` and `--json-file` are mutually exclusive. fds 0, 1, and 2 are
rejected to prevent corrupting the TUI's own output.

## Quick start

Run Qwen Code with all three channels enabled:

```bash
mkfifo /tmp/qwen-events.jsonl /tmp/qwen-input.jsonl
qwen \
  --json-file /tmp/qwen-events.jsonl \
  --input-file /tmp/qwen-input.jsonl
```

In a second terminal, tail the event stream:

```bash
cat /tmp/qwen-events.jsonl
```

In a third terminal, push a prompt into the running TUI:

```bash
echo '{"type":"submit","text":"Explain this repo"}' >> /tmp/qwen-input.jsonl
```

The prompt appears in the TUI exactly as if the user typed it, and the
streaming response is mirrored on `/tmp/qwen-events.jsonl`.

## Output event schema

Events are emitted as JSON Lines (one object per line). The schema is the same
one used by the non-interactive `--output-format=stream-json` mode, with
`includePartialMessages` always enabled.

The first event on the channel is always `system` / `session_start`, emitted
when the bridge is constructed. Use it to correlate the channel with a
session id before any other event arrives.

```jsonc
// Session lifecycle
{
  "type": "system",
  "subtype": "session_start",
  "uuid": "...",
  "session_id": "...",
  "data": { "session_id": "...", "cwd": "/path/to/cwd" }
}

// Streaming events for an in-progress assistant turn
{ "type": "stream_event", "event": { "type": "message_start", "message": { ... } }, ... }
{ "type": "stream_event", "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "text" } }, ... }
{ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hello" } }, ... }
{ "type": "stream_event", "event": { "type": "content_block_stop", "index": 0 }, ... }
{ "type": "stream_event", "event": { "type": "message_stop" }, ... }

// Completed messages
{ "type": "user", "message": { "role": "user", "content": [...] }, ... }
{ "type": "assistant", "message": { "role": "assistant", "content": [...], "usage": { ... } }, ... }
{ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", ... }] } }

// Permission control plane (only when a tool needs approval)
{
  "type": "control_request",
  "request_id": "...",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "run_shell_command",
    "tool_use_id": "...",
    "input": { "command": "rm -rf /tmp/x" },
    "permission_suggestions": null,
    "blocked_path": null
  }
}
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "...",
    "response": { "allowed": true }
  }
}
```

`control_response` is emitted whether the decision was made in the TUI
(native approval UI) or by an external `confirmation_response` (see below).
Either way, all observers see the final outcome.

## Input command schema

Two command shapes are accepted on `--input-file`:

```jsonc
// Submit a user message into the prompt queue
{ "type": "submit", "text": "What does this function do?" }

// Reply to a pending control_request
{ "type": "confirmation_response", "request_id": "...", "allowed": true }
```

Behavior:

- `submit` commands are queued. If the TUI is busy responding, they are
  retried automatically the next time the TUI returns to the idle state.
- `confirmation_response` commands are dispatched immediately and never
  queued, because a tool call is blocking and the response must reach the
  underlying `onConfirm` handler without waiting for any earlier `submit`.
- Whichever side approves a tool first wins; the other side's late response
  is harmlessly dropped.
- Lines that fail to parse as JSON are logged and skipped — they do not
  stop the watcher.

## Latency notes

The input file is observed with `fs.watchFile` at a 500 ms polling interval,
so worst-case round-trip latency for a remote `submit` is about half a
second. This is intentional: polling is portable across platforms and
filesystems (including macOS / network mounts), and matches the typical
human-in-the-loop pacing the feature targets. The output channel has no
polling — events are written synchronously as the TUI emits them.

## Failure modes

- **Bad fd.** If the fd passed to `--json-fd` is not open or is one of
  0/1/2, the TUI prints a warning to `stderr` and continues without dual
  output enabled.
- **Bad path.** If the file passed to `--json-file` cannot be opened, the
  TUI prints a warning and continues without dual output.
- **Consumer disconnect.** If the reader on the other side of the channel
  goes away (`EPIPE`), the bridge silently disables itself and the TUI
  keeps running. No retry.
- **Adapter exception.** Any exception thrown while emitting an event is
  caught, logged, and disables the bridge. The TUI is never crashed by a
  dual-output failure.

## Spawn example

A typical embedding parent process spawns Qwen Code with both channels:

```ts
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

const eventsFd = openSync('/tmp/qwen-events.jsonl', 'w');
const child = spawn(
  'qwen',
  ['--json-fd', '3', '--input-file', '/tmp/qwen-input.jsonl'],
  { stdio: ['inherit', 'inherit', 'inherit', eventsFd] },
);
```

The TUI still owns the user's terminal on stdio 0/1/2, while the embedder
reads structured events on the file backing fd 3 and pushes commands by
appending JSONL lines to `/tmp/qwen-input.jsonl`.
