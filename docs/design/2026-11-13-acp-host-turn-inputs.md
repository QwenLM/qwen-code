# ACP host turn inputs

[English](2026-11-13-acp-host-turn-inputs.md) | [简体中文](2026-11-13-acp-host-turn-inputs.zh-CN.md)

- **Status**: Implementation and test updates are prepared for the ACP second row of #17045. The updated tests pass locally.
- **Date**: 2026-11-13.
- **Related**: #17045 and [Unified agent loop](2026-10-23-unified-agent-loop.md).

## Problem

The unified loop still models ACP ownership with `SendMessageOptions.userTurnRecordedByHost` and `interactionSpanByHost`. These switches hide which phase was completed, make prompt identity implicit, and risk treating a host-owned trace as client-owned.

## Goals and scope

- Replace `userTurnRecordedByHost` with `userTurn: UserTurnInput`.
- Replace `interactionSpanByHost` with `interactionSpan: Span`.
- Preserve ACP timing, record metadata, independent phase handling, and normal behavior for callers without these inputs.

Out of scope: other ACP tool batches, a full per-round `runAgentLoop` migration, changing defaults, the M block, and provider or session layers.

## API

```ts
type UserTurnInput = {
  promptId: string;
  todoWorkChain?: { promptId: string };
  // Present when the host ran the snapshot phase for this turn: taken,
  // deliberately skipped for a restore, or attempted and failed. Core never
  // snapshots on its own and never retries a failed one.
  fileHistory?: { promptId: string };
};
```

`UserTurnRecord` is typed data for `user`, `goal`, `cron`, or `notification` records. It is not part of the input: the host writes it through `recordUserTurn` at the point its own semantics call for — before the send, or, for a deferred cron round, once the block reached history — and `userTurn.promptId` only tells core not to record the turn itself. A receipt on the input would be a value core never reads.

## Recording and phase ownership

Removing `userTurnRecordedByHost` means two things: the host writes its record through core's `recordUserTurn` at the timing it already had, and it tells core with `userTurn.promptId` not to record the turn itself. `recordUserTurn(config, record)` writes the record and returns nothing; the legacy writer remains best effort.

`todoWorkChain` and `fileHistory` describe setup already completed by ACP; ACP still owns when todo and snapshot work happens. Core skips recording, chain creation, and snapshot work independently only when the supplied phase `promptId` matches. One matching phase does not suppress another, and ordinary callers retain their existing defaults.

## Span ownership

`interactionSpan` is caller-owned. Core joins or touches the existing trace and propagates it through continuations, but never closes it. This makes ownership explicit while preserving the ACP span lifecycle.

When the host supplies the span, the host is also its single attribute writer: core does not add the input-message or resolved-request attributes, so the host's recorded display text is not replaced by the raw submitted prompt.

## Preserved behavior

- Early raw-user recording keeps display text, attachments, resource references, and `daemonPromptId` before slash-command handling; `/clear` still replaces the recorder, with the resolved `/advisor` exception.
- The file-history snapshot is attempted before sending, even when the turn is cancelled.
- Retry, continue, and restore record nothing new: their message is already in history or recorded before the send, so the record phase carries only `promptId`; the turn still carries the todo-chain and snapshot inputs the host already applied. Goal permit behavior remains intact.
- Deferred cron recording still happens only once the block reached the model, and remains conditional on keeping history, including retained unsent input.
- Notification records retain task metadata and prior persistence behavior; a background notification that was already persisted is not recorded twice.

## Validation and acceptance

Implementation and tests are in place, and pass locally: core `client.test.ts` 640 passed, core `client-goal.test.ts` 59 passed, and `Session.test.ts` 1447 tests with no failures. The base before this change runs the same test counts, so the suite did not shrink to go green.

Acceptance requires preserving record metadata, independent recording/chain/snapshot phase handling, and proof that an external span is never closed by the client. The tests cover these behaviors.
