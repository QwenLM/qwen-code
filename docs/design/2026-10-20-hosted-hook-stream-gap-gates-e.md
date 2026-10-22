# Hosted Hook stream-gap gates FG13e

[English](2026-10-20-hosted-hook-stream-gap-gates-e.md) | [简体中文](2026-10-20-hosted-hook-stream-gap-gates-e.zh-CN.md)

> Tracks #14449. The FG12f stream-gap class covers an MCP tool call; this
> layer adds the Hook arm the tracker lists under FG13e.

## Problem and scope

A `PreToolUse` Hook is a decision gate with a process behind it. While that
process runs, the turn produces public events (the tool call is announced,
then settles) that both the public and the WebShell streams must serve
exactly once. A client cut during the Hook's hold reconnects with a cursor:
`Last-Event-ID` on the public route, `afterSequence` on the WebShell route.

FG13e asks that a disconnect during a held Hook lose nothing and duplicate
nothing on either route, and that a denial is delivered once. The Hook state
itself is not on the public stream, so the gate is about the ledger and the
cut, not about a Hook-specific frame.

## Case

`bothStreamsResumeTheHeldHookTurnOnMySql` in
`HostedHookStreamGapIT`, one cold boot on the `hosted-harness-mysql` lane:

| Step | What happens                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------- |
| 1    | A `PreToolUse` command Hook is held in the Runtime worker until the test releases it, then denies. |
| 2    | Both clients read the Session stream from the start: public (SSE) and WebShell (JSON cursor).      |
| 3    | Once the Hook is holding and both clients have read a frame, both clients are cut.                 |
| 4    | The Hook's deny lands while neither client is connected; the turn completes.                       |
| 5    | Each client reconnects with its own cursor and reads to the ledger's tail.                         |

The tool-call start frame is emitted only when the call leaves the Hook, so
the cut deliberately happens before it: the frames written during the hold
are exactly the ones a cut client misses.

Expectations:

- Each resumed view is the ledger prefix byte-for-byte: sequence `1..n` with
  no gap and no duplicate (`continueFrom`), on both surfaces.
- The union carries at least one frame past the cut position — the frames
  written while both clients were disconnected — and exactly one
  `turn.completed` for the Turn.
- One physical Hook call (`hook.call`), one deny (`hook.deny`), and the tool
  never ran: the model sees exactly one tool result for the emitted call
  carrying the denial reason, and never the proof file's contents.

## Coverage

Already on main:

- `HostedMcpStreamGapIT` pins both cursors on a held MCP tool call.
- `ManagedEventReplayTest` pins `Last-Event-ID`, `afterSequence`, catch-up to
  live handover and store fallback with no gaps or duplicates.

This cell adds the Hook-held turn: the gate is cut while a Runtime worker
process is holding the decision, so the ledger rows that land during the cut
are the tool call's terminal state and the Turn's completion, not an MCP
result. The cursor machinery is shared; the Hook lane is the new subject.

## Mutation witnesses

- Ignore the cursor (serve from the start): each view replays the cut
  client's frames and the union's sequence list reddens on the duplicate.
- Serve only live frames to a resumed client: the turn is already complete,
  so that client never reaches the ledger tail; `continueFrom`'s 90 s wait
  exhausts and the case reddens on that timeout (the union's gap check is
  never reached).
- Let the tool run despite the deny: the model request contains the proof
  file's contents and `doesNotContain(PROOF)` reddens.

## Non-goals

- Stop or `MessageDisplay` suppressed text in a replay: suppression is a
  decision/output property, tracked as FG13f `message-display-reload`.
- FG13a store acks and store-side faults stay on #14449.
- Moving the shared machinery into `HostedGateTestSupport` is a follow-up
  sweep tracked in #14921, not part of this cell: the stream and ledger
  helpers (`Observer`, `ledger`, `served`, `camel`, `continueFrom`), the
  Spring boot block (`startSpring`, `stop`), and the request/wait helpers
  (`api`, `waitFor`, `quote`, `events`, `createSession`, `submit`,
  `turnStatus`, `awaitCompleted`).

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. `managed-agent-gate.yml` selects the `fast`
tier on `pull_request`; the full suite runs on the first maintainer approval
of the head commit, so a skipped lane is not a passing gate. This cell adds
150 s; with main's FG12f delivery entry (30 s to 50 s, +20 s) and the FG11d
retire-at-intent cell (+18 s), the merged ledger is healthy 9668 s, fork
10268 s, Verify 182 minutes.
