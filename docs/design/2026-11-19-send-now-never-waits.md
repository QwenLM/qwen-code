# Send now never waits for tools

[English](2026-11-19-send-now-never-waits.md) | [简体中文](2026-11-19-send-now-never-waits.zh-CN.md)

Status: decided; implemented in two PRs (PR 1: #17825).

[Send queued mid-turn messages now](2026-10-08-send-mid-turn-messages-now.md)
includes the decision "No cut once a tool call starts" and guarantees that
running tools are never interrupted. This design revises both and carries out
the "move a running shell to the background" item that design's Risks section
left for later. Everything else stays as it is:
Enter queues, delivery at tool boundaries, session scope, a request bound to its
turn, and draining before cutting.

## Problem

When the user clicks Send now in Web Shell after the model's response has
started a tool call (its arguments still streaming, or the tool running), the
daemon returns `{ requested: true }` but the agent does nothing. The queued row
still reads "Queued...", the button is still there, and the message waits for
the batch to finish. A real case: the model streamed the arguments of a large
`write_file` for 13 minutes, and that write was exactly what the user wanted to
correct.

Measured (`qwen serve` + Web Shell + a scripted provider, 2026-11-19):

| State at the click                     | Today                                    |
| -------------------------------------- | ---------------------------------------- |
| Model writing text                     | Delivered in about 50 ms, same turn      |
| Model streaming `write_file` arguments | Waits for the arguments and tool (~16 s) |
| Shell command running (8 s in old doc) | Waits for the command (6.1 s)            |

The button promises "now", but what it does depends on an internal phase the
user cannot see, so the user can only read it as a click that did nothing.

## Current state

- Mid-turn messages live in the daemon's `midTurnMessageQueue`. The agent
  drains it after each tool batch (`#buildNextMessageAfterToolRun`); whatever
  is left when the turn ends can be promoted through
  `settleUndrainedMidTurnMessages` when the prompt FIFO allows it. The daemon
  uses `settleMidTurnQueueAfterAutomaticTurn` for autonomous Goal turns.
- Send now: `Session.sendMidTurnInputNow()` records the request, and the `pull`
  in `#openResponseInterrupt` drains and then cuts only while the response has
  no tool call (`hasFunctionCalls()` is false).
- The legacy ACP loop executes tools through `Session.runTool`, which calls
  `invocation.execute(signal, onProgress, shellConfig)`. The shared round uses
  `runAcpToolBatch` and `CoreToolScheduler`. The scheduler already passes
  `setPromoteAbortControllerCallback` to shell invocations and stores the
  controller on the executing tool call. The TUI reads that state for Ctrl+B.
  ACP's Send now handler still needs access to those controllers.
- Stop (`cancelPendingPrompt`) does more than end the turn: it stops the cron
  scheduler and clears the cron queue, pauses background notifications, and
  pauses the Goal as a user interrupt (`#settleGoalTurn` records
  `USER_CANCEL_ABORT_REASON` as a user interrupt). A Goal turn preempted by a
  new prompt (`NEW_PROMPT_ABORT_REASON`) is a handoff, and the Goal is not
  paused.
- Measured: pressing Stop while tool arguments stream or a shell runs delivers
  the queued messages in the next turn, with a valid role order in the request.
  The unfinished tool call is dropped, and a cancelled shell is recorded as a
  cancelled tool result.

## Prior art

Claude Code has two send keys. Enter queues, delivered at the tool boundary.
Ctrl+Enter sends now: backgroundable work (shells, subagents) moves to the
background and keeps running while the model reads the messages in the same
turn; otherwise it interrupts the turn and sends the messages next. A shell
moved this way says in its tool result that it was moved so a message could
arrive and was not interrupted. Codex interrupts by default. This design splits
the work the same way as the former (Enter unchanged, Send now never waits); the
reasons are under "Decisions and rationale".

## Goals and scope

- Send now targets delivery within one round trip when earlier prompts, an
  in-flight drain, or tool cancellation do not delay delivery.
- A running shell command that can move to the background is not killed.
- The interrupt ends only the current turn: cron keeps running, background
  notifications are not paused, and the Goal is not paused.

Out of scope: moving subagents to the background (only shells can move
mid-run in qwen-code today); Send now during cron and background-notification
turns (they have no `pendingPrompt`; they keep today's behavior of delivery at
the tool boundary); a TUI shortcut for Send now; telling "preparing" from
"running" in the tool row.

## Design

When the agent receives a Send now request, it acts on what the turn is doing.
The table assumes no ordinary prompt is already queued ahead of the message.

| What the turn is doing                                                       | Action                                                                                          | Turn that answers  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| Model writing text or thinking, no tool call yet                             | Existing: drain, then cut the response                                                          | Same turn          |
| Only foreground shells eligible to move left running in the batch            | Move them to the background (PR 2); the batch ends and the tool boundary drains                 | Same turn          |
| Anything else: response started a tool call, tools running, approval pending | Abort the turn with `MID_TURN_SEND_NOW_ABORT_REASON`; the daemon promotes the queue to a prompt | Next turn, at once |

For a batch with eligible foreground shells and other tools, PR 1 interrupts
the whole batch. PR 2 moves the eligible shells to the background first and
then interrupts the other tools.

### Interrupt (PR 1)

1. `sendMidTurnInputNow()` first lets an open response drain and cut, as
   today. While the turn is calling tools (the response has a tool call, or the
   batch it called has not settled, running or waiting for approval) and no
   drain request is in flight, it aborts the turn's `pendingPrompt` with
   `MID_TURN_SEND_NOW_ABORT_REASON`. The tool phase ends when the batch
   settles: a later request waits for the tool-boundary drain or a cut of the
   next response, and never ends a turn that is already finishing.
2. The reason is a controlled cancellation like Stop, so the turn ends as
   `cancelled`. The cron scheduler keeps running and retains queued fires.
   The agent holds automatic Goal and cron turns and independent background
   notifications until the daemon's prompt FIFO settles, including attachment
   resolution or withdrawal. A waiting `per_task` channel prompt can still
   process notifications from its own work chain and settle.
3. Goal: an interrupted Goal turn (including a user turn while a Goal is
   active) is a handoff, the same as being preempted by a new prompt. The turn
   ends and the Goal stays active. If the FIFO allows promotion at settlement,
   the promoted prompt runs as the next Goal turn. Earlier ordinary prompts
   keep their place and can drain the message at a tool boundary.
   The interrupted turn still counts toward usage. Its work is exempt from
   adding to the no-progress streak, since the host can submit the queued
   message only after settlement.
4. The interrupt leaves messages with the daemon for draining or promotion
   in FIFO order, so it cannot consume a message and leave it unanswered.
5. Race: the daemon sends the request only while the queue holds user
   messages. While a drain that took messages is still resolving attachments
   and has not answered, the daemon holds the request, and forwards it after
   that answer only if the queue still holds user messages. The request and
   drain answers travel on the same ordered channel. If a drain request is in
   flight when the agent handles the request, that drain brings the messages
   into the same turn, so the agent does not interrupt. With no drain in flight
   the messages are still with the daemon, and interrupting is safe. Messages a
   timed-out drain handed over late wait for the tool boundary; the agent does
   not interrupt then either, and the newer messages arrive with them at the
   boundary, in order. An interrupted turn takes nothing more from the daemon.
   A request stays bound to its turn as today.
6. Text already written stays; an unfinished tool call is dropped; a running
   tool is recorded as cancelled, as on Stop, but its result does not use
   Stop's "the user cancelled; await instructions; do not retry" wording: it
   says the user interrupted the call to send a message, which follows, and to
   read it before deciding whether to run the tool again. A pending approval
   request is cancelled with the turn, does not run, and is not recorded as a
   user rejection.

### Move shells to the background (PR 2)

1. Expose the promotion controller once a top-level local foreground shell
   process starts. In the legacy loop, `runTool` passes
   `setPromoteAbortControllerCallback` for these calls. In the shared round,
   `runAcpToolBatch` forwards controller updates and settlements for top-level
   calls. The shell withdraws the controller as soon as its process settles,
   even while `PostToolUse` is still running. Shells awaiting spawn, shells
   whose process has exited, calls nested in `exec`, simulated `sed` edits,
   and Managed runtime calls follow the PR 1 interrupt path.
2. When a Send now request arrives, each handle gets
   `abort({ kind: 'background', forUserMessage: true, onRegistered })`. Core
   assigns a `bg_` ID and returns it to the session through `onRegistered`
   once the task is in the registry. The batch counts pending top-level
   executable calls, including scheduled calls awaiting execution. Nested
   calls and replays are excluded. If only shells being moved remain, the
   batch ends, the tool boundary drains, and the same turn answers. If other
   tools remain, the PR 1 interrupt waits for the moved shells' tool calls to
   settle. An earlier interrupt would replace their results with the
   interrupt text. The model would lose the background ID and might run the
   command again. The drain and
   late-message checks of PR 1 apply to that interrupt only, and are checked
   again when it fires. A second request while shells are moving moves nothing
   more and does not interrupt early.
3. The tool result gives the background ID, output location and status. It
   tells the model that the command kept running in the background to make
   room for the user's message. If `PostToolUse` rejects the tool result,
   the agent requests cancellation of the promoted process.
4. When such a shell ends later, ACP's existing background shell notification
   reports it.
5. Stop cancels the shells moved by its turn. It requests cancellation
   immediately for registered tasks and at registration for moves still in
   progress. This also applies if Send now has already interrupted the turn
   and it is still settling. The next turn treats those tasks as ordinary
   background jobs.

### Web Shell

The tooltip explains that the current response or tools may be interrupted
and that eligible shell commands continue in the background. After an interrupt,
the message soon appears as the next turn and the queued row goes away. While an
approval is pending, Web Shell replaces the composer and the queued rows with
the approval panel, so only other clients (such as the SDK) can ask to send now
in that phase.

## Decisions and rationale

- **"Now" means now.** A user who clicks the button has decided the message
  matters more than the current work. Behavior that changes with a phase the
  user cannot see costs more than an interrupt: the user clicks again, or waits.
- **Do not kill what can move to the background.** Killing a long command
  midway is expensive to redo and can leave half-done side effects; moving it
  loses no work and still delivers the message at once.
- **Otherwise end the turn and answer in the next one, rather than cancel
  tools inside the same turn.** The Stop path already handles this: it drops
  the unfinished call, records cancelled tools, and promotes the queue when the
  turn ends, and the resulting request was measured valid. Continuing the same
  turn needs a new batch-level abort, synthesized results for calls that never
  ran, and approval-prompt handling, each done in both loops: much more
  complexity to save one turn.
- **Keep the same-turn cut while the model writes text.** That path is built
  and tested; what the model sees is almost the same as with a next turn, and
  staying in the turn avoids an extra `cancelled` turn, which keeps SDK callers
  and Goal simpler.
- **A dedicated abort reason.** Stop stops cron, pauses notifications and
  pauses the Goal, none of which the user asks for by clicking Send now.
- **The Goal continues on its own.** A user who cuts in is correcting the
  course, not stopping the objective; treating it as a handoff matches a new
  prompt preempting a Goal turn.
- **No drain before the interrupt.** Draining and then ending the turn would
  record a message without answering it; leaving it with the daemon to be
  promoted at turn end is shorter and already verified.
- **Two PRs.** The interrupt works on its own and fixes "the click does
  nothing" first. Moving shells to the background requires separate wiring for
  the two tool execution paths and gets its own review.

## Constraints

- Both ACP paths use the same `Session` logic for the Send now interrupt, abort
  reason classification, and Goal settlement. The abort reason
  `USER_MESSAGE_INTERRUPT_ABORT_REASON` and its tool result text live in core
  so both `Session.runTool` and `CoreToolScheduler` can use them. PR 2 connects
  both tool execution paths to the session, and tests cover both paths. This
  does not wait for #17744.
- The `sendMidTurnMessagesNow` route and capability stay the same, but SDK
  callers see the new behavior, so the release notes need a line.

## Risks

- The interrupt discards tool arguments the model already generated, and
  generating them again costs tokens. This follows from an explicit click.
- An interrupted tool may be half done (a command stopped midway). This is the
  same as Stop, and the tooltip says it interrupts.
- Some tools finish their current operation before cancellation settles. A
  directory scan in `record_artifact` or a worktree mutation already in progress
  can delay the next prompt. When a shell moves to the background, a slow
  `PostToolUse` hook can delay delivery while the tool result settles.
- The interrupt relies on "with no drain in flight, the messages are still with
  the daemon", that is, the request and drain answers arrive in order on one
  channel; this needs a dedicated test. If the user deletes every queued
  message right after the click, the turn is interrupted with no message to
  follow; this is unlikely and acceptable.
- The daemon promotes the queue only when the turn ends with no other prompt in
  its FIFO. If the user has also queued an ordinary prompt, the click still ends
  the turn, but the message waits for that prompt's tool boundary.
- An interrupt during a pending approval abandons that request on the agent
  side. At settlement, the daemon cancels approvals owned by the ending prompt
  or autonomous Goal turn. Autonomous Goal approvals use the Goal turn ID, so
  the daemon can clear their cards when it starts writing a replacement prompt
  to the agent. A replacement rejected before the write leaves the live Goal's
  approvals in place. A held send-now request remains revocable until it is
  forwarded. When its turn ends, the daemon discards it even if the drain has
  already scheduled the forwarding.

## Validation plan

- Unit tests (`Session.test.ts`) cover all three delivery cases on both loop
  paths. Queued cron fires run after the handoff without stopping the scheduler.
  Related notifications let a `per_task` channel prompt settle while
  independent notifications stay queued.
  An interrupted Goal stays active and has no user-interrupt record. A request
  stays bound to its turn, does nothing without a turn, and avoids interrupting
  a turn with a drain in flight. An interrupted approval has no rejection
  record. PR 2 tests cover same-turn delivery after moving a shell to the
  background, the tool result's explanation, batch accounting for nested calls
  and replays, Send now after process exit, and stopping promoted shells
  during post-processing.
- Daemon: promoted messages keep their order and originating client after the
  interrupt.
- E2E (`qwen serve` + Web Shell + a scripted provider): reuse the old doc's
  latency table and add four rows: "streaming `write_file` arguments", "shell
  running", "mixed batch" and "Goal turn".

## Acceptance criteria

- When no earlier ordinary prompt, in-flight drain, or tool settlement delays
  delivery, the model request carrying the message starts within 1 s of the
  click in the cases below:

| State at the click                | Today              | Target                                            |
| --------------------------------- | ------------------ | ------------------------------------------------- |
| Model writing text                | about 50 ms        | Unchanged                                         |
| Model streaming tool args         | Waits for the tool | Next turn, < 1 s (PR 1)                           |
| Eligible foreground shell running | 6.1 s              | PR 1: next turn; PR 2: same turn, command running |
| Tool that can cancel promptly     | Waits for the tool | Next turn, < 1 s (PR 1)                           |

- The Goal stays active after the interrupt. Queued automatic turns resume
  after the handoff.
- The guarantees of the old doc that this design keeps are still covered by
  tests.

## Open questions

None. Decided on 2026-11-19: interrupt and answer in the next turn; keep the
same-turn cut while text streams; in a mixed batch move shells first, then
interrupt (PR 2); the Goal continues on its own; two PRs, not waiting for
#17744.
