# ACP host turn inputs

[English](2026-11-13-acp-host-turn-inputs.md) | [简体中文](2026-11-13-acp-host-turn-inputs.zh-CN.md)

- **Status**: Implementation and test updates are prepared for the ACP second row of #17045. Tests have been added/updated but not executed yet.
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
  record:
    | { kind: 'recorded'; record: UserTurnRecord }
    | { kind: 'existing'; promptId: string; taskId?: string }
    | { kind: 'deferred'; record: UserTurnRecord };
  todoWorkChain?: { promptId: string; continuedFrom?: string };
  fileHistory?: {
    promptId: string;
    outcome: 'attempted' | 'restore-omitted';
  };
};
```

`UserTurnRecord` is typed data for `user`, `goal`, `cron`, or `notification` records. The three `record` variants describe whether core records now, the host already has a record, or recording is deferred with its record payload.

## Recording and phase ownership

Core exports `recordUserTurn(config, record)`. It writes the record at the host's existing timing and returns a recorded receipt. The receipt is not a durability guarantee: the legacy writer remains best effort.

`todoWorkChain` and `fileHistory` describe setup already completed by ACP; ACP still owns when todo and snapshot work happens. Core skips recording, chain creation, and snapshot work independently only when the supplied phase `promptId` matches. One matching phase does not suppress another, and ordinary callers retain their existing defaults.

## Span ownership

`interactionSpan` is caller-owned. Core joins or touches the existing trace and propagates it through continuations, but never closes it. This makes ownership explicit while preserving the ACP span lifecycle.

## Preserved behavior

- Early raw-user recording keeps display text, attachments, resource references, and `daemonPromptId` before slash-command handling; `/clear` still replaces the recorder, with the resolved `/advisor` exception.
- The file-history snapshot is attempted before sending, even when the turn is cancelled.
- Retry, continue, and restore use an existing record; Goal permit behavior remains intact.
- Deferred cron recording remains conditional on keeping history, including retained unsent input.
- Notification records retain task metadata and prior persistence behavior.

## Validation and acceptance

Implementation and tests have been added/updated, but have not been executed yet.

Acceptance requires preserving record metadata, independent recording/chain/snapshot phase handling, and proof that an external span is never closed by the client. Existing tests are updated for these behaviors; their execution remains pending.
