# remote-session-host — spec delta

## ADDED Requirements

### Requirement: Daemon owns session lifecycle

The daemon SHALL be the sole process holding a remotely-attachable
session. Sessions SHALL NOT be embedded in the interactive TUI process.
The TUI MUST connect to a daemon to participate in a remotely-attachable
session.

#### Scenario: Terminal exit does not end the session

- **GIVEN** a paired `qwen rc` terminal client attached to session `S`
- **WHEN** the user closes the terminal
- **THEN** the daemon retains session `S` with no degradation of the
  agent's in-flight work
- **AND** other paired clients continue to receive `session_update` events

#### Scenario: Daemon-less mode preserved for non-remote use

- **GIVEN** a user runs plain `qwen` (no `rc`, no daemon)
- **WHEN** they perform their normal workflow
- **THEN** behavior is unchanged from upstream qwen-code
- **AND** no daemon process is started

### Requirement: One daemon per workspace

The daemon SHALL host sessions for exactly one workspace at a time,
determined by the daemon's `--workspace` flag (default: process cwd).

#### Scenario: Second session for same workspace attaches to existing

- **GIVEN** the daemon hosts session `S1` for workspace `W`
- **WHEN** any client posts `POST /session { cwd: W }`
- **THEN** the response returns `{ sessionId: "S1", attached: true }`

#### Scenario: Different workspace requires a different daemon

- **GIVEN** the daemon hosts session for workspace `W1`
- **WHEN** any client posts `POST /session { cwd: W2 }` where `W2 ≠ W1`
- **THEN** the response is `400 Bad Request` with code `workspace_mismatch`
- **AND** the body advises running a second daemon

### Requirement: Per-session FIFO preserved

The daemon SHALL queue prompts for a session in FIFO order. A new prompt
MUST NOT begin until the previous prompt returns a `stopReason` or is
cancelled.

#### Scenario: Concurrent prompts queue

- **GIVEN** session `S` is processing prompt `P1`
- **WHEN** client `C2` posts `P2` to `/session/S/prompt`
- **THEN** the request blocks until `P1` completes
- **AND** the order of completion matches submission order

### Requirement: Explicit session termination

The daemon SHALL accept `POST /session/:id/end` from any client with
`write` scope.

#### Scenario: End emits terminal frame and flushes WAL

- **WHEN** a write-scope client posts `/session/S/end`
- **THEN** all subscribers receive a `session_died` event with
  `data.reason = "ended_by_client"` and `data.tokenId`
- **AND** the WAL is flushed and segment-rotated
- **AND** further requests to `/session/S/prompt` return `410 Gone`

### Requirement: Idle-session garbage collection

The daemon SHALL automatically end sessions that have had zero attached
clients for `gcAfterSec` seconds (default 14 400) AND zero in-flight
prompts.

#### Scenario: Active prompt prevents GC even with no clients

- **GIVEN** session `S` has no attached clients
- **AND** a long-running prompt is in flight
- **WHEN** `gcAfterSec` seconds elapse
- **THEN** the session is NOT ended
- **AND** the session is reconsidered for GC after the prompt completes

#### Scenario: Per-session opt-out

- **WHEN** a write-scope client posts
  `/session/S/config { gc: { enabled: false } }`
- **THEN** the daemon retains `S` indefinitely until explicit end

### Requirement: Durable event WAL with bounded retention

The daemon SHALL mirror every emitted SSE event to a per-session
write-ahead log on disk at `~/.qwen/rc/wal/<sessionId>.log`. The WAL
MUST be bounded by both event count (default 10 000) and wall-clock
horizon (default 24 h); the older bound wins.

#### Scenario: Reconnect after daemon restart replays from WAL

- **GIVEN** a client received event id `100` before the daemon restarted
- **WHEN** the client reconnects with `Last-Event-ID: 100`
- **AND** events `101..150` are within the WAL horizon
- **THEN** the daemon replays events `101..150` from the WAL in order
- **AND** then transitions to live in-memory streaming

#### Scenario: Replay older than WAL horizon returns 412

- **GIVEN** the WAL's earliest retained event id is `200`
- **WHEN** a client reconnects with `Last-Event-ID: 150`
- **THEN** the response is `412 Precondition Failed`
- **AND** the response body is a single `replay_truncated` event
  indicating the client must resync state

### Requirement: Transcript persistence unchanged

The daemon SHALL continue to write the canonical agent transcript as
JSONL at `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`,
identical in format to upstream Stage 1, so that `qwen --continue` and
`qwen --resume` retain compatibility.

#### Scenario: Transcript readable by upstream tooling

- **GIVEN** a session has produced transcript `T`
- **WHEN** the user runs upstream `qwen --resume <sessionId>` (without
  the daemon)
- **THEN** the transcript loads without modification
