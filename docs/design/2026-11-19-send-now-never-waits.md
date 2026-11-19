# Send now never waits for tools

[English](2026-11-19-send-now-never-waits.md) | [简体中文](2026-11-19-send-now-never-waits.zh-CN.md)

Status: decided; implemented in two PRs.

This design revises two decisions in
[Send queued mid-turn messages now](2026-10-08-send-mid-turn-messages-now.md),
"a response that started a tool call is not cut" and "running tools are not
interrupted", and carries out the "move a running shell to the background" item
that design's Risks section left for later. Everything else stays as it is:
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
  is left when the turn ends, the daemon promotes to the next prompt through
  `settleUndrainedMidTurnMessages`. After a Goal turn,
  `settleMidTurnQueueAfterAutomaticTurn` promotes it, and the promoted prompt
  runs as the next Goal turn.
- Send now: `Session.sendMidTurnInputNow()` records the request, and the `pull`
  in `#openResponseInterrupt` drains and then cuts only while the response has
  no tool call (`hasFunctionCalls()` is false).
- Both ACP paths (the legacy loop and the shared round) run tools through
  `Session.runTool`. `runTool` calls
  `invocation.execute(signal, onProgress, shellConfig)` without
  `setPromoteAbortControllerCallback`, so ACP cannot move a foreground shell to
  the background today; the TUI's Ctrl+B already does it through
  `CoreToolScheduler`.
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

- Send now hands the queued user messages to the model within one round trip,
  whatever the turn is doing.
- A running shell command that can move to the background is not killed.
- The interrupt ends only the current turn: cron keeps running, background
  notifications are not paused, and the Goal is not paused.

Out of scope: moving subagents to the background (only shells can move
mid-run in qwen-code today); Send now during cron and background-notification
turns (they have no `pendingPrompt`; they keep today's behavior of delivery at
the tool boundary); a TUI shortcut for Send now; telling "preparing" from
"running" in the tool row.

## Design

When the agent receives a Send now request, it acts on what the turn is doing:

| What the turn is doing                                                       | Action                                                                                          | Turn that answers  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| Model writing text or thinking, no tool call yet                             | Existing: drain, then cut the response                                                          | Same turn          |
| Only foreground shells left running in the batch                             | Move them to the background (PR 2); the batch ends and the tool boundary drains                 | Same turn          |
| Anything else: response started a tool call, tools running, approval pending | Abort the turn with `MID_TURN_SEND_NOW_ABORT_REASON`; the daemon promotes the queue to a prompt | Next turn, at once |

For a batch with foreground shells and other tools: PR 1 interrupts the whole
batch (the shells are cancelled too); from PR 2 on, the shells move to the
background first and then the other tools are interrupted.

### Interrupt (PR 1)

1. `sendMidTurnInputNow()` first lets an open response drain and cut, as
   today. If no drain started (the response has a tool call, tools are running,
   approval is pending, between two model requests, and so on) and no drain
   request is in flight, it aborts the turn's `pendingPrompt` with
   `MID_TURN_SEND_NOW_ABORT_REASON`.
2. The reason is a controlled cancellation like Stop, so the turn ends as
   `cancelled`. It skips the session-wide steps of `cancelPendingPrompt`: the
   cron scheduler keeps running, the cron queue is kept, and background
   notifications are not paused.
3. Goal: an interrupted Goal turn (including a user turn while a Goal is
   active) is a handoff, the same as being preempted by a new prompt. The turn
   ends and the Goal is not paused. The daemon promotes the message, which runs
   as the next Goal turn, and the Goal then continues on its own.
4. The interrupt does not drain first. The messages stay with the daemon and
   are promoted when the turn ends, so a message is never taken and then left
   unanswered.
5. Race: the daemon sends the request only while the queue holds user
   messages, and it sends the request and answers drains on the same ordered
   channel. If a drain request is in flight when the agent handles the request,
   that drain brings the messages into the same turn, so the agent does not
   interrupt. With no drain in flight the messages are still with the daemon,
   and interrupting is safe. A request stays bound to its turn as today.
6. Text already written stays; an unfinished tool call is dropped; a running
   tool is recorded as cancelled, as on Stop, but its result does not use
   Stop's "the user cancelled; await instructions; do not retry" wording: it
   says the user interrupted the call to send a message, which follows, and to
   read it before deciding whether to run the tool again. A pending approval
   request is cancelled with the turn, does not run, and is not recorded as a
   user rejection.

### Move shells to the background (PR 2)

1. `runTool` passes `setPromoteAbortControllerCallback` to shell calls and keeps
   the session's handles for running foreground shells.
2. When a Send now request arrives, each handle gets
   `abort({ kind: 'background' })`. If only those shells were left in the batch,
   the batch ends, the tool boundary drains, and the same turn answers; if other
   tools remain, the turn is then interrupted as in PR 1.
3. The tool result carries the background id and the output location, and says
   why: the command moved to the background so a user message could arrive, and
   it was not interrupted (unlike a manual move by the user).
4. When such a shell ends later, ACP's existing background shell notification
   reports it.
5. If the user presses Stop later in the same turn, the shells moved for the
   message are stopped too; once the next turn starts they get no special
   treatment.

### Web Shell

Only the tooltip changes: "Send queued messages now. Interrupts the model if it
is responding or calling tools", with "running commands move to the background
and keep running" added in PR 2. No new row state: after the interrupt the
message soon appears as the next turn, and the queued row goes away. While an
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
  nothing" first; moving shells to the background wires a new execution
  parameter and gets its own review.

## Constraints

- The changes are in the `Session` layer that both ACP paths share
  (`sendMidTurnInputNow`, the abort reason classification, `#settleGoalTurn`,
  `runTool`), not in the shared round itself; tests cover both paths. The
  shared path's tool results come from `CoreToolScheduler`, so the abort reason
  `USER_MESSAGE_INTERRUPT_ABORT_REASON` and its tool result text live in core,
  shared by both paths. This does not wait for #17744.
- The `sendMidTurnMessagesNow` route and capability stay the same, but SDK
  callers see the new behavior, so the release notes need a line.

## Risks

- The interrupt discards tool arguments the model already generated, and
  generating them again costs tokens. This follows from an explicit click.
- An interrupted tool may be half done (a command stopped midway). This is the
  same as Stop, and the tooltip says it interrupts.
- The interrupt relies on "with no drain in flight, the messages are still with
  the daemon", that is, the request and drain answers arrive in order on one
  channel; this needs a dedicated test. If the user deletes every queued
  message right after the click, the turn is interrupted with no message to
  follow; this is unlikely and acceptable.
- The daemon promotes the queue only when the turn ends with no other prompt in
  its FIFO. If the user has also queued an ordinary prompt, the click still ends
  the turn, but the message waits for that prompt's tool boundary.
- An interrupt during a pending approval abandons that request on the agent
  side; whether the daemon clears its pending approval when the turn ends is not
  verified yet. Web Shell cannot click in that phase, so only other clients are
  affected.

## Validation plan

- Unit tests (`Session.test.ts`): each of the three cases; the interrupt
  neither stops cron nor pauses notifications; an interrupted Goal turn leaves
  the Goal active and is not recorded as a user interrupt; no interrupt while a
  drain is in flight; the request is bound to its turn; no-op without a turn; an
  interrupt during a pending approval is not recorded as a user rejection; both
  loop paths covered; (PR 2) same-turn delivery after the move, the tool result
  states the reason, and a later Stop stops those shells.
- Daemon: promoted messages keep their order and originating client after the
  interrupt.
- E2E (`qwen serve` + Web Shell + a scripted provider): reuse the old doc's
  latency table and add four rows: "streaming `write_file` arguments", "shell
  running", "mixed batch" and "Goal turn".

## Acceptance criteria

- In every case below, the model request carrying the message starts within
  1 s of the click:

| State at the click        | Today              | Target                                            |
| ------------------------- | ------------------ | ------------------------------------------------- |
| Model writing text        | about 15 ms        | Unchanged                                         |
| Model streaming tool args | Waits for the tool | Next turn, < 1 s (PR 1)                           |
| Foreground shell running  | 6.1 s              | PR 1: next turn; PR 2: same turn, command running |
| Non-backgroundable tool   | Waits for the tool | Next turn, < 1 s (PR 1)                           |

- After the interrupt the Goal stays active and continues; cron and
  notifications run as usual.
- The guarantees of the old doc that this design keeps are still covered by
  tests.

## Open questions

None. Decided on 2026-11-19: interrupt and answer in the next turn; keep the
same-turn cut while text streams; in a mixed batch move shells first, then
interrupt (PR 2); the Goal continues on its own; two PRs, not waiting for
#17744.
