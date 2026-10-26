# Post-compaction prompt count

[English](2026-10-25-post-compaction-prompt-count.md) | [简体中文](2026-10-25-post-compaction-prompt-count.zh-CN.md)

Status: implemented for [#15486](https://github.com/QwenLM/qwen-code/issues/15486).

## Problem

Automatic compaction can run while a message is still pending. This happens in the hard-tier rescue, or in auto compaction in the middle of a tool loop, when a tool result has arrived but has not been sent yet. The compaction succeeds, but the estimate for the next request comes out too large, for two reasons:

1. **The pending message is counted twice.** It stays inside the compacted count, and the next estimate adds it again.
2. **The overhead pad defeats the output floor.** Every compaction leaves an estimated count, and an estimated count is padded by 20,000 tokens. The floor that guarantees the reply some room is capped by the window minus the padded estimate. On a window smaller than the pad, that cap is negative, and the floor drops to 1.

Depending on which check reads the estimate, the turn then fails in one of two ways:

- the hard-tier guard stops it ("Context is too large to send safely after automatic compression … compression status: COMPRESSED");
- or the request goes out with `max_tokens: 1` and ends with "Model stream ended after a tool result without visible progress".

Measured cases:

- **Released 0.24.6, 64K window, mock provider.** The hard-tier compaction succeeded with a compacted count of 25,225, which already included the pending result. The guard's estimate was 45,241 against a hard limit of 41,000, and the turn was stopped.
- **Real provider, 262,144-token window.** After a 476K-character `read_file`, the next request was about 126K tokens and went out five times with `max_tokens: 1`.
- **16K window.** After `/compress`, the count was 4,805 and the clamp's estimate 24,903, so `max_tokens` was 1 while about 8K tokens were free.

## Current state before this change

- For auto compaction and the hard-tier rescue, the caller passes its effective estimate as the compression's original count. That estimate is the prior count, plus the previous output, plus the pending message, plus a memory snapshot when the memory catalog changed on this send.
- The compression service documents that count as the prompt _before_ the pending message. It derives the compacted count by replacing the history's share of the original count with the summary, so whatever the caller folded in stays in the compacted count.
- After a compaction, the chat stores that count as estimated. Both the hard-tier guard and the output clamp add the pending content on top of it; the clamp also multiplies it by 1.5.
- The clamp pads estimated counts by 20,000 tokens. A recovery send pads its history walk by the same amount.
- The output floor is `min(4,000, window − prompt)`, where `prompt` is the padded estimate (#13252).
- A compression record stores the compacted history with the pending message appended, so that resume keeps the turn the compaction happened in. It also stores the compacted count, which today includes the pending message only because of the double count above.

## Goals

- After a compaction, count the pending content exactly once.
- Give a prompt that fits at least the floor, or all the room left when that is smaller, whenever its estimate already includes the fixed overhead.
- Keep fresh-session grants, and every grant at or above the floor, unchanged.
- Keep the counts persisted in compression records unchanged.

## Non-goals

- Removing or resizing the pad. A fresh history walk misses the instructions and tool definitions: an existing dry run measured a real 18,359-token prompt against a 1-token estimate.
- The budget for restoring files after compaction (#15487).
- Sizing the compression request itself (#14953, #9455).
- Escalating `max_tokens` after a truncated reply.

## Design

### Baseline passed into compression

The send path computes the same estimate twice: once with this send's pending content (the effective count) and once without it (the baseline). It passes both. Compression uses the baseline as its original count, which is what the compression service already documents. The compacted count is then the compacted history plus the fixed overhead the baseline carries, and the hard-tier guard and the output clamp each add the pending content once.

Fallbacks:

- A caller that passes only the effective count gets the pending message's estimate subtracted from it.
- Without a precomputed count, the local estimate walks the history without the pending message.

### Compression records

Records still store the pending message in their snapshot, and resume seeds its count from the record when no later response reported usage. So a record adds the pending message's estimate back to both of its counts. The persisted values therefore match what is stored today. Only the live counts change.

### Overhead pad and output floor

`clampOutputTokensToWindow` accepts an optional prompt size for the floor, which defaults to the prompt it is sizing:

```
room      = window − paddedPrompt − margin
floor     = max(1, min(4,000, window − floorPrompt))
maxTokens = min(ceiling, max(floor, room))
```

- **First send.** When the estimate is count-based, so that it starts from a provider count or a compacted count, the floor prompt is the unpadded estimate. A fresh history walk still uses the padded estimate.
- **Recovery send.** The floor prompt is the count-based estimate when that estimate covers the history walk; otherwise it is the padded walk.
- **Room.** The room always comes from the padded estimate, so the pad still shrinks every grant above the floor.

## Decisions and rationale

| Decision                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix the caller, not the compression service          | The service follows its documented contract. One caller passed a count that broke it. Manual `/compress`, reactive compaction, `/compress-fast` and the hosted compaction pass no pending message and stay as they are.                                                                                                                                                                 |
| Pass the baseline instead of subtracting the message | The effective count can include a memory snapshot sent with this message. The same estimate without the pending content cancels exactly, whatever it holds.                                                                                                                                                                                                                             |
| Records keep counting the pending message            | The record's snapshot stores the message, and resume seeds its count from the record. A record without it would start the resumed session one message short.                                                                                                                                                                                                                            |
| Cap the floor, keep the pad                          | A fresh walk really misses about 18K tokens of overhead. A grant above the floor overflows by exactly the overhead the pad and the margin leave uncovered. A quarter-window pad plus the 10K margin covers the 18,359 tokens of the dry run only from about a 33K window up, so smaller fresh sessions would overflow. Capping the floor changes only grants that fall below the floor. |
| Count-based estimates only                           | On a fresh walk the pad stands for real overhead. An unpadded cap there opens a band where today's grant of about 2K fits but 4K would not: window minus estimate between 20K and about 22.4K, with the 18,359-token overhead from the dry run.                                                                                                                                         |
| A recovery send needs a covering count               | When the walk exceeds the count, the extra may be real growth that the count missed, for example a response without usage. The padded cap stays.                                                                                                                                                                                                                                        |

## Risks

- A count-based estimate can still miss overhead, for example a compacted count whose baseline was itself a fresh walk, or a resume seeded from an estimate. Inside a band at most 4K wide, the floor may then exceed the room that is really left. The provider rejects the request, and reactive overflow recovery handles it. Today the same case sends `max_tokens: 1`, and the turn ends.
  - Measured on a 16K window: a resumed session re-adds about 3K tokens of startup context that the count seeded from the compression record does not include. The follow-up after `/compress` overflowed by 639, and recovery compacted and completed the turn. The same flow on a 20K window fits.
- After an automatic compaction with a pending message, the "Context compressed (A -> B)" banner and the compression telemetry show both numbers without the pending message. The ACP session count also leaves it out until the next response reports usage.
- Escalation after a truncated reply stays off when the floor lifts the grant, as it is today.
- On a 16K window the request is partly unsatisfiable either way, because the real fixed overhead can approach the window.

## Validation

- Unit tests in `tokenLimits.test.ts`:
  - the floor is capped by the unpadded estimate;
  - the padded room is unchanged where it reaches the floor;
  - the #13252 cap holds against the unpadded estimate;
  - an explicit ceiling below the floor is respected.
- Unit tests in `llm-chat.test.ts` (`#15486`):
  - **Baseline:**
    - it leaves out the pending message and keeps the previous output;
    - it also leaves out a memory snapshot sent with the message;
    - it leaves out the pending message without a precomputed count.
  - **End to end through the real compression service:** the C1 case, for a pending tool result and pending text, on both the cache-sharing and the cold accounting paths. The turn is sent, and the compacted count is smaller than the pending message.
  - **Records:** the hard-tier and auto compression records count the pending message.
  - **First send:** a 16K window after a compaction gets 4,000 instead of 1, and a fresh session keeps the padded cap (1,999 on a 32K window).
  - **Recovery:** a 16K window with a provider count gets 4,000, and without a covering count the padded cap stays.
- Existing tests updated: two expected original counts now leave out the pending message, and one expected record count includes it.
- An 11-mutant sweep is killed in full. It covers the baseline passed in, the baseline with pending content, the subtraction fallback, the walk fallback, the clamp's floor argument, the first send's count-based condition both ways, the recovery's covering-count condition both ways, and both record sites.
- End-to-end runs against a mock provider and a real provider are reported on the PR.

## Acceptance criteria

- After a compaction with a pending message, the hard-tier guard and the output clamp count the pending content once.
- A count-based estimate that fits never gets `max_tokens` below `min(4,000, window − unpadded estimate)` because of the pad.
- Fresh-session grants, and every grant at or above the floor, are unchanged.
- The counts persisted in compression records are unchanged.

## Follow-ups

- Dropping the pad for counts anchored on provider usage, as the triage of #15486 suggests, would also raise grants above the floor. It is left as a separate decision.
- Sizing the post-compaction file restoration budget to the window (#15487).
