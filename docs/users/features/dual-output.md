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

## Use cases

Dual Output is a low-level plumbing primitive. These are concrete integrations
it unlocks:

### Terminal + Chat dual-mode real-time sync

The flagship use case. A web or desktop ChatUI hosts the TUI inside a PTY
and renders a parallel conversation view driven by the structured event
stream:

- User can type in either surface — the TUI (for terminal-native power-users)
  or the web UI (for richer UX, shareable links, mobile). Both views stay
  in sync because every message flows through the same JSON events.
- Tool-approval prompts appear in both places; whoever approves first wins.
- Session history is captured verbatim from `--json-file`, so the server
  side has a canonical machine-readable transcript without parsing ANSI.

### IDE extensions (VS Code / JetBrains / Cursor / Neovim)

Embed Qwen Code inside the IDE. The TUI runs in the editor's integrated
terminal panel for users who want it, while the extension consumes
`--json-fd` / `--json-file` events to drive:

- Inline diff overlays when the agent touches files.
- A webview side panel with formatted markdown, syntax-highlighted tool
  calls, and clickable citations.
- Status bar indicators (thinking / responding / awaiting approval).
- Programmatic `confirmation_response` writes when the user clicks a
  native IDE approval button.

### Browser-based Chat frontends

A Node/Bun server spawns the TUI in a PTY for its rendering semantics but
exposes a WebSocket channel to the browser. Events on `--json-file` are
forwarded to the client; user messages typed in the browser are injected
via `--input-file`. No ANSI parsing on either side.

### CI / automation observers

A CI job runs Qwen Code with a task prompt. The human sees the TUI in the
job log; the CI system tails `--json-file` to:

- Fail the job if a `result` event reports an error.
- Push `token usage` / `duration_ms` / `tool_use` counts to metrics.
- Archive the full transcript as a build artifact.

### Multi-agent orchestration

A supervisor agent spawns multiple TUI workers, each with its own pair of
event/input files. It watches progress, injects follow-up prompts, and
enforces global budget / safety policies by approving or denying tool
calls across all workers.

### Session recording, audit, and replay

Tee every TUI session to a regular file with `--json-file`. Later:

- Compliance audits can reconstruct exactly what was executed.
- Automated regression tests can compare runs across model versions.
- A replay tool can re-emit events through the same protocol to feed
  visualization dashboards.

### Observability dashboards

Stream `--json-file` into Loki / OTEL / any pipeline that accepts JSONL.
Extract `usage.input_tokens`, `tool_use.name`, `result.duration_api_ms`
as first-class metrics in Grafana. No need for log-parsing regex.

### Testing and QA

Integration tests spawn Qwen Code headlessly, drive it with `--input-file`
scripts, and assert on `--json-file` events. Unlike parsing stdout ANSI,
assertions are stable across UI refactors.

## Flags

| Flag                  | Type             | Purpose                                                                                                                                    |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--json-fd <n>`       | number, `n >= 3` | Write structured JSON events to file descriptor `n`. The caller must provide this fd via spawn `stdio` configuration or shell redirection. |
| `--json-file <path>`  | path             | Write structured JSON events to a file. The path can be a regular file, a FIFO (named pipe), or `/dev/fd/N`.                               |
| `--input-file <path>` | path             | Watch this file for JSONL commands written by an external program.                                                                         |

`--json-fd` and `--json-file` are mutually exclusive. fds 0, 1, and 2 are
rejected to prevent corrupting the TUI's own output.

## Why two output flags? (`--json-fd` vs `--json-file`)

At first glance `--json-fd` looks sufficient — the caller spawns Qwen Code
with an extra file descriptor, the TUI writes events to it, done. In
practice, fd passing breaks down under the most important embedding
scenario: running the TUI inside a pseudo-terminal (PTY). That is why
this feature also exposes a path-based alternative.

### When `--json-fd` works

Pure `child_process.spawn` with a `stdio` array:

```ts
const child = spawn('qwen', ['--json-fd', '3'], {
  stdio: ['inherit', 'inherit', 'inherit', eventsFd],
});
```

Node's spawn supports arbitrary `stdio` entries; fd 3 is inherited by the
child, which can write to it directly. Zero-copy, zero-buffer, zero
filesystem — the fastest path.

### Why `--json-fd` does **not** work under PTY

PTY wrappers like [`node-pty`](https://github.com/microsoft/node-pty) and
[`bun-pty`](https://github.com/oven-sh/bun) are how any serious embedder
(IDE extensions, web terminals, tmux-like multiplexers) hosts an
interactive TUI. They cannot forward extra fds to the child, for three
reinforcing reasons:

1. **API surface.** `node-pty.spawn(file, args, options)` accepts `cwd`,
   `env`, `cols`, `rows`, `encoding`, etc. — but **no `stdio` array**. There
   is simply no place in the API to say "also attach this fd as fd 3 in
   the child". `bun-pty` exposes the same shape.
2. **`forkpty(3)` semantics.** Under the hood, PTY wrappers call
   `forkpty(3)` (or the equivalent `posix_openpt` + `login_tty` dance).
   That syscall allocates a master/slave pseudo-terminal pair and
   redirects the child's fds 0/1/2 to the slave side so the child thinks
   it is attached to a real terminal. Any fds above 2 in the parent are
   closed by `login_tty`, which calls `close(fd)` for `fd >= 3` before
   `exec`. Extra fds are actively wiped, not inherited.
3. **Controlling-terminal side effect.** Even if you hacked an extra fd
   through, it would not be a terminal, so the child's TUI renderer
   (which writes escape sequences assuming a TTY on fd 1) would still
   need the slave for its output. You would end up with two independent
   transports anyway.

In short: the moment an embedder needs a real TTY for TUI rendering —
which is every IDE extension, every web terminal, every desktop chat
app — fd inheritance is off the table.

### `--json-file` fills the gap

A file path is passed as an ordinary CLI argument, so it survives every
spawn model:

```ts
import { spawn } from 'node-pty';

const pty = spawn(
  'qwen',
  [
    '--json-file',
    '/tmp/qwen-events.jsonl',
    '--input-file',
    '/tmp/qwen-input.jsonl',
  ],
  { cols: 120, rows: 40 },
);
```

The child opens the file itself and writes events there; the embedder
tails the same path with `fs.watch` + incremental reads. Three things to
note:

- **Regular file**, FIFO (named pipe), or `/dev/fd/N` all work. FIFO is
  the lowest-latency option when both sides are on the same host.
- The bridge opens FIFOs with `O_NONBLOCK` and falls back to blocking
  mode on `ENXIO` (no reader yet), so PTY startup is never deadlocked
  waiting for a consumer.
- For multi-session isolation, use per-session paths under
  `$XDG_RUNTIME_DIR` or a `mkdtemp`'d directory with mode `0700`.

### Which flag should I use?

| Embedding style                                   | Use                  |
| ------------------------------------------------- | -------------------- |
| `child_process.spawn` with plain stdio            | `--json-fd`          |
| `node-pty` / `bun-pty` / any PTY host             | `--json-file`        |
| Shell redirection / manual pipeline testing       | either               |
| CI log collection (regular file, read after exit) | `--json-file`        |
| Lowest possible latency on same host              | `--json-file` + FIFO |

The general rule: **if you need the TUI to render correctly, you need a
PTY, which means you need `--json-file`.** `--json-fd` is for simpler
embedders that do not care about TUI fidelity — typically programmatic
wrappers that throw away stdout anyway.

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

## Settings-based configuration

For long-lived embedders it is often inconvenient to thread CLI flags
through every launch. The same channels can be configured in
`settings.json` under the top-level `dualOutput` key:

```jsonc
// ~/.qwen/settings.json  (user-level)
// or <workspace>/.qwen/settings.json  (workspace-level)
{
  "dualOutput": {
    "jsonFile": "/tmp/qwen-events.jsonl",
    "inputFile": "/tmp/qwen-input.jsonl",
  },
}
```

Precedence rules:

- CLI flag **wins** over settings. Passing `--json-file /foo` on the
  command line overrides `dualOutput.jsonFile` in settings.
- `--json-fd` has no settings equivalent — fd passing is a spawn-time
  concern that cannot be statically declared.
- If neither flag nor setting is present, dual output stays disabled
  (identical to today's default).

The `requiresRestart: true` flag means changes only take effect on the
next Qwen Code launch, since the bridge is constructed once during
startup.

## Runnable demos

Every script below is copy-paste ready. Start with POC&nbsp;1 to verify
the build has dual output; POC&nbsp;4 is the closest analogue to a real
IDE-extension integration.

### POC 1 — observe the event stream

Watch every structured event the TUI emits while a human uses it
normally:

```bash
# Terminal A
mkfifo /tmp/qwen-events.jsonl
cat /tmp/qwen-events.jsonl | jq -c 'select(.type != "stream_event") | {type, subtype}'

# Terminal B
qwen --json-file /tmp/qwen-events.jsonl
# ...then chat normally; terminal A shows session_start,
# user/assistant/result/control_request lifecycle in real time.
```

Expected first line in terminal A:

```json
{ "type": "system", "subtype": "session_start" }
```

### POC 2 — inject prompts from outside

Drive the TUI from a second terminal without touching the keyboard of
the first:

```bash
# Terminal A
touch /tmp/qwen-in.jsonl
qwen --input-file /tmp/qwen-in.jsonl

# Terminal B — the TUI responds as if you typed it
echo '{"type":"submit","text":"list files in the current directory"}' \
  >> /tmp/qwen-in.jsonl
```

### POC 3 — remote tool-permission bridge

Approve or deny tool calls from a separate process:

```bash
# Terminal A — observe control_requests
mkfifo /tmp/qwen-out.jsonl
touch /tmp/qwen-in.jsonl
(cat /tmp/qwen-out.jsonl \
  | jq -c 'select(.type == "control_request")') &

# Terminal B
qwen --json-file /tmp/qwen-out.jsonl --input-file /tmp/qwen-in.jsonl
# Ask Qwen to do something that needs approval, e.g.
# "run `ls -la /tmp`". A control_request will appear in terminal A.
# Copy the request_id, then in a third terminal:
echo '{"type":"confirmation_response","request_id":"<paste-id>","allowed":true}' \
  >> /tmp/qwen-in.jsonl
# The TUI confirmation prompt dismisses and the tool executes.
```

If you reply with an unknown `request_id`, the bridge emits a
`control_response` with `subtype: "error"` on the output channel so your
consumer can log it or retry:

```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "...",
    "error": "unknown request_id (already resolved, cancelled, or never issued)"
  }
}
```

### POC 4 — Node embedder (IDE-like)

The most realistic shape: a parent process spawns Qwen Code, tails
events, and injects prompts on its own schedule.

```ts
// demo-embedder.ts
import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const events = join(tmpdir(), `qwen-events-${process.pid}.jsonl`);
const input = join(tmpdir(), `qwen-input-${process.pid}.jsonl`);
writeFileSync(events, '');
writeFileSync(input, '');

const child = spawn('qwen', ['--json-file', events, '--input-file', input], {
  stdio: 'inherit',
});

// Tail the output channel. In production you'd use a proper
// byte-offset tail; this one re-streams from 0 for brevity.
const rl = createInterface({
  input: createReadStream(events, { encoding: 'utf8' }),
});
rl.on('line', (line) => {
  if (!line.trim()) return;
  const ev = JSON.parse(line);
  if (ev.type === 'system' && ev.subtype === 'session_start') {
    console.log('[embedder] handshake:', {
      protocol_version: ev.data.protocol_version,
      version: ev.data.version,
      supported_events: ev.data.supported_events,
    });
    // Feature-detect before using a capability
    if (ev.data.supported_events.includes('control_request')) {
      console.log('[embedder] permission control-plane available');
    }
  }
  if (ev.type === 'assistant') {
    console.log(
      '[embedder] assistant turn ended, tokens =',
      ev.message.usage?.output_tokens,
    );
  }
  if (ev.type === 'system' && ev.subtype === 'session_end') {
    console.log('[embedder] session ended cleanly');
  }
});

// After 2s, inject a prompt as if the user typed it
setTimeout(() => {
  appendFileSync(
    input,
    JSON.stringify({ type: 'submit', text: 'hello from embedder' }) + '\n',
  );
}, 2000);

child.on('exit', () => process.exit(0));
```

Run with:

```bash
npx tsx demo-embedder.ts
# Qwen Code TUI opens in the current terminal; the embedder logs
# handshake + turn-end + session_end events to the parent's stdout.
```

### POC 5 — capability handshake feature detection

Older Qwen Code versions won't emit `protocol_version`. Treat the field
as optional and feature-detect:

```ts
rl.on('line', (line) => {
  const ev = JSON.parse(line);
  if (ev.type === 'system' && ev.subtype === 'session_start') {
    const v = ev.data?.protocol_version ?? 0;
    if (v < 1) {
      console.error(
        'qwen-code dual output is present but protocol < 1; ' +
          'falling back to best-effort behavior',
      );
    } else {
      console.log('qwen-code dual output protocol v' + v);
    }
  }
});
```

### POC 6 — session_end as a clean termination signal

```ts
rl.on('line', (line) => {
  const ev = JSON.parse(line);
  if (ev.type === 'system' && ev.subtype === 'session_end') {
    console.log('[embedder] clean shutdown, session', ev.data.session_id);
    // Flush metrics, close WebSockets, etc.
  }
});
```

If the TUI crashes before `session_end`, the output stream closes
(`EPIPE` on next write); embedders should handle both paths.

### POC 7 — failure drills (prove the flags never break the TUI)

```bash
qwen --json-fd 1
# stderr: "Warning: dual output disabled — ..."
# TUI still launches normally.

qwen --json-fd 9999
# stderr: "Warning: dual output disabled — fd 9999 not open"
# TUI still launches normally.

qwen --json-fd 3 --json-file /tmp/x.jsonl
# yargs rejects: "--json-fd and --json-file are mutually exclusive."
# Process exits before TUI starts.

qwen --json-file /nonexistent/dir/x.jsonl
# stderr warning; TUI still launches.
```

## Relation to Claude Code

Claude Code exposes a similar stream-json event format under
`--print --output-format stream-json`, but only in non-interactive mode
— it has no equivalent of running the TUI and a structured sidecar
channel at the same time. Dual Output fills that gap.
