# Peer session collaboration for Qwen Code

> Status: Board layer implemented by #9402; not a standalone collaboration milestone
> Tracking: [#8724](https://github.com/QwenLM/qwen-code/issues/8724)

## Decision

The product path and the portable board are separate layers. The original #8724 milestone is
Qwen-to-Qwen collaboration: already-running Qwen Code sessions discover each other and use
`send_message` with a receiver-side consent gate. Agent Team already owns the simpler case
where one session spawns and coordinates an in-process Qwen teammate.

Independently started or non-Qwen agents can additionally collaborate through a durable board
on disk. Every participant uses the same pull-based CLI. Qwen-specific delivery, terminal
hosting, and UI do not define the board contract, but delivery or orchestration is required
before the project can claim a user-visible delegation milestone.

The first release has three rules:

1. **No membership.** There is no join, leave, participant record, roster, heartbeat, or name
   claim. Reading or writing a named board is participation.
2. **No implicit identity or scope.** Commands require `--board <name>` and mutations require
   `--as <name>`. These values label records; they do not authenticate the caller.
3. **Pull is the contract.** Work becomes visible on the board. Nothing is delivered into a
   running agent process.

This is the smallest storage model shared by Qwen Code, Codex, shell scripts, scheduled jobs,
and other tools that can run a command. It is not by itself a scheduler, launcher, or inbox.

## Product sequence

The user-visible collaboration route is:

1. **Spawned Qwen teammates.** Existing Agent and Agent Team tools cover delegation to a
   Qwen worker managed by the current session.
2. **Already-running Qwen sessions.** The session registry discovers peers; the inbound gate
   lets a peer refuse or hold work; sender addressing completes the original #8724 flow.
3. **Independent process launch.** A launcher is needed only when a separate long-lived Qwen
   Code process is required instead of an in-process teammate.
4. **Foreign runtimes.** A concrete runner, such as a Codex runner, turns one board task into
   a real process invocation and returns its result.

Stages 1 and 2 of the board implementation below prove the portable storage contract. They
must not be presented as completion of this product sequence, and the board should not block
the Qwen-to-Qwen sender path.

## Why a board

An already-running process can receive unsolicited input only if it voluntarily exposes an
inbound channel. Foreign CLIs do not expose a common one. They can all run a command, so
fetching shared state is the portable operation.

Qwen Code already has the pieces needed for a filesystem-backed implementation:

- atomic JSON writes;
- `proper-lockfile` for cross-process locking;
- task ownership and state-transition patterns;
- process-liveness discovery for features that need it later.

The board reuses the locking and state-transition patterns. It does not reuse Agent Team's
storage or scheduler because those are scoped to a spawned, in-process team.

## MVP contract

### Scope and identity

`--board` is required on every command. It is a logical name, not a path. The implementation
validates it before resolving the directory under `~/.qwen/boards/`.

`--as` is required when creating or changing an item. Read-only commands may omit it unless
they request an identity-filtered view. The value is written into fields such as `createdBy`,
`owner`, or `from`.

There is deliberately no default derived from the current directory, environment variable,
global process state, or live-session registry. Those shortcuts can be added after one
unambiguous contract ships.

### Storage

```
~/.qwen/boards/{board}/
    tasks/{id}.json
    asks/{id}.json
```

Directories use mode `0700`; files use `0600`. Each item is one versioned JSON object.
Identifiers have a type prefix and UUID suffix. Creating an item never scans for or reuses a
numeric id.

All read-modify-write transitions and pruning use the same per-item lock discipline. Creation
uses exclusive semantics. A command must not decide that a target is stale and then mutate
it after releasing the lock.

Readers validate each record. A list operation reports and skips malformed records so one
bad file does not hide the rest of the board. A mutation targeting a malformed record fails
without rewriting it.

### Items

| Item   | Purpose                                  | Terminal states                   |
| ------ | ---------------------------------------- | --------------------------------- |
| `task` | Work with an owner, status, and notes    | pending / in_progress / completed |
| `ask`  | A question addressed to a declared label | answered / declined / timeout     |

An `ask` is addressed to a label, not a registered session. A receiver chooses the same
label with `--as` and answers it. If nobody does, its deadline determines `timeout`; no
background sweeper is required.

There is no generic message. Status belongs on a task and information requests are asks.

### CLI

The MVP surface is non-interactive and machine-readable:

```text
qwen board show --board <board> [--as <name>] [--json]
qwen board task --board <board> --as <name> <subject> [--owner <name>]
qwen board claim --board <board> --as <name> <task-id>
qwen board done --board <board> --as <name> <task-id> [--note <text>]
qwen board ask --board <board> --as <name> <to> <question> [--wait] [--timeout <duration>]
qwen board answer --board <board> --as <name> <ask-id> <answer>
qwen board decline --board <board> --as <name> <ask-id> <reason>
qwen board prune --board <board> --as <name> --older-than <duration>
```

`--json` produces stable data without ANSI output. Human output may be formatted but must not
truncate identifiers or state needed to act. `--wait` uses bounded polling, returns a
distinct timeout exit code, and does not start a daemon or socket.

Unknown ids, invalid transitions, invalid names, malformed target records, and lock failures
are errors. An absent board is an empty result for `show` and an error for mutations that
need an existing item.

## Authority and security boundary

The local OS account is the access boundary. File permissions prevent other local users from
reading the board. `--as` is self-declared and must never authorize filesystem access,
dangerous tools, approval mode, or sandbox changes.

Board text is untrusted input. Consumers display or summarize it as data; they do not inject
it as a user message or automatically execute instructions from it.

Push delivery, if added, requires a receiver-side consent gate before the first send path.
That later gate must fail closed and cannot trust the sender's declared `--as` value.

## Board implementation stages

### Stage 1 — storage primitives

Add versioned task and ask records with validation, secure permissions, one lock discipline,
random ids, and focused transition tests.

Observable result: two processes can safely create, claim, answer, and prune items on the
same named board without lost updates or id reuse.

### Stage 2 — CLI

Expose the storage primitives through the explicit `--board` / `--as` commands above.

Observable result: two independently started agents, including a non-Qwen agent, can share
work by running commands and can distinguish completed, declined, and timed-out outcomes
from exit status and JSON.

### Stage 3 — Qwen-native consumer

After the CLI contract is stable, a Qwen-native tool, slash command, footer indicator, or
turn-boundary poll may consume it. Every native action must map exactly to an existing CLI
operation.

Observable result: Qwen users get lower-friction access without changing board semantics or
excluding foreign agents.

### Stage 4 — orchestration or push

Fleet/tmux startup, a Codex runner, and Qwen-to-Qwen wake delivery are separate features.
Fleet may pass explicit board and identity arguments to child commands; it does not create
membership. Push lands only with its receiver-side consent gate and remains a latency
optimization for board correctness, while still being necessary for low-latency delegation
to an already-running Qwen session.

Observable result: a user can ask a lead agent to start or address a worker and receive its
result without manually operating the board CLI. Removing this stage leaves the Stage 2
storage contract correct, but removes the user-visible delegation experience.

## Explicit non-goals for the MVP

- membership, participant records, join/leave, roster, name claiming, or liveness coupling;
- implicit project boards, ambient identity, or process-global board context;
- `/board`, footer badges, background polling, or native agent tools;
- fleet/tmux orchestration, PTY attachment, or lifecycle management;
- push, broadcast, remote access, or cross-machine synchronization;
- multiple agents writing the same checkout;
- a public compatibility promise for the on-disk format.

The existing agent-view PR series (#7799–#7803) owns supervised terminals and roster UI. It
is independent of this board and is neither removed nor extended by the MVP.

## Board implementation acceptance gate

The MVP is ready only when:

- its implementation contains no participant or join/leave subsystem;
- every mutation has explicit board and actor arguments;
- concurrent creators cannot reuse ids or overwrite each other;
- pruning cannot delete an item changed after eligibility was checked;
- malformed records cannot crash or hide a healthy board;
- human output preserves actionable ids and JSON output remains parseable;
- focused unit tests cover the above, followed by package typecheck and build.

Passing this gate means the board implementation is technically sound. It does not by itself
mean the cross-session collaboration product is complete or that this layer must land before
the Qwen-to-Qwen sender path. A standalone merge requires an explicit maintainer decision to
ship the low-level CLI; otherwise it should land with a concrete native consumer or runner.
