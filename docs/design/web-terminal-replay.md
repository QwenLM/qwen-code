# Web terminal replay and query ownership

[English](web-terminal-replay.md) | [简体中文](web-terminal-replay.zh-CN.md)

## Goal and scope

PR #11643 switches Windows web-terminal PTYs to bundled ConPTY to avoid the
inbox backend's natural-exit host leak. Its review follow-up #11734 requires
preserving live terminal answers without answering old queries on reconnect.
The cross-package correction was approved on 2026-09-13.

Remove the server's escape-sequence filters. This does not change POSIX PTY
backend selection, add dependencies, or broaden agent-view behavior. The replay
boundary applies to Web Shell terminals on all hosts, not only VS Code.

## Ownership

The Windows headless terminal parses the original stream but forwards only its
primary DA answer, including before a browser attaches. Snapshot metadata tells
the browser to consume primary DA through xterm's native CSI handler in that
case. When headless cannot load, the browser owns live DA; a startup probe before
attachment may time out. The existing inbox spawn-failure retry remains.

Colors, modes and cursor/geometry queries belong to the browser that renders the
live output. Headless does not supply those answers. PTY output and bounded
scrollback retain their original bytes, including split escape sequences.

## Transport and compatibility

The workspace-resolved `/terminal` connection requests `replay=1`. Before the
initial binary output, the server sends a NUL-prefixed JSON control frame:

```json
{ "type": "snapshot", "replay": true, "handlesPrimaryDa": true }
```

The next binary frame is the snapshot; later binary frames are live output.
Keeping output binary preserves its size bound and prevents PTY bytes from being
interpreted as control frames. A newly created PTY uses `replay:false`: its
buffered startup queries have not been answered by a browser yet.

Legacy clients are rejected before PTY creation with a reload message. The new
client rejects an unmarked binary snapshot from an older daemon. Both must be
updated together; release-only connections still work. Workspace validation,
ownership checks, heartbeat and output/input backpressure remain unchanged.

## Browser restoration

Restore history into a terminal opened on a detached DOM host without an input
forwarder. Keep the old visible terminal forwarding keyboard/paste/IME input.
The snapshot write callback installs the new forwarder and swaps the visible
host before queued live writes parse. Dispose the old terminal after the swap.
Fresh startup output gets its forwarder before parsing. A retryable disconnection
or unmount disposes an unfinished restore; a stale callback cannot replace a
newer connection's view. This uses public xterm APIs, not a global flag that drops
both replies and user input.

## Verification and acceptance

- Registry: original live/snapshot bytes survive; only primary DA is answered.
- Route: snapshot metadata precedes binary history; fresh and reconnect paths
  differ; old clients fail clearly without spawning.
- Browser: replay produces no outgoing answers, queued live color/mode queries
  do, and typing during replay still reaches stdin. Initial queries work;
  primary DA has one owner; interrupted replay cannot replace the current view.
- Run focused tests and a mounted real-browser check after implementation.
  Native Windows process counts, fallback DLL loading and interactive rendering
  require separate Windows acceptance. Browser evidence is not proof of the
  original native leak fix.
