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
- Keep a compression record's counts describing what it stores: the compacted history plus the pending turn as the request carries it.

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

Only the original count changes. The compression gate still reads the effective count, pending content included (`precomputedEffectiveTokens`), and so does the size check of the cache-sharing request. A send whose baseline is below the auto threshold, but whose pending message takes it over, still compacts.

The cold path derives the compacted count from the side query's input count, and since #17141 that formula has two branches:

- **No retained tail.** The side query carries the pending tool result, and the service subtracts that result from the input count.
- **Retained tail.** The side query stops before the retained operation and carries no pending result, so nothing is subtracted.

In both branches the compacted count is the original count, minus the summarized history, plus the summary (and, with a tail, the note that introduces it). A baseline without the pending message therefore keeps the message out of the compacted count on both branches.

### Compression records

Records still store the pending message in their snapshot, and resume seeds its count from the record when no later response reported usage. So a record adds the pending turn back to both of its counts, at both places that write one: the automatic compaction and the deferred hard-tier record. It adds the turn as the request after compaction carries it, which is what resume replays. The compacted history holds no memory snapshot, so the send attaches the current catalog's snapshot when there is one; with no catalog the request strips a replayed snapshot, which then adds nothing, although the record still stores the replay as it was. The effective count estimated before compaction cannot stand in for this: when the catalog is already in the history it attaches no snapshot, and compaction then drops that snapshot, so the send attaches it again. Without a memory snapshot in play the persisted values match what is stored today; with one they now count the snapshot the resumed history holds, and not one it does not.

The add-back builds a new record payload and leaves the compression result alone. The count the chat adopts after compaction and the `COMPRESSED` event both keep the compacted count without the pending message. Adding the message into the result instead would bring the double count back, because the chat adopts the result's count after it writes the record.

### Overhead pad and output floor

`clampOutputTokensToWindow` accepts an optional prompt size for the floor, which defaults to the prompt it is sizing:

```
room      = window − paddedPrompt − margin
floor     = max(1, min(4,000, window − floorPrompt))
maxTokens = min(ceiling, max(floor, room))
```

- **First send.** Only an estimated count is padded. When that count is positive (a compacted count, or a resume seeded from an estimate), the floor prompt is the unpadded estimate. At count 0 the estimate is a fresh history walk, and the floor keeps the padded estimate. A provider count is not padded, so its floor does not change. The relaxation therefore applies only to `count > 0 && isEstimated`.
- **Recovery send.** Every recovery send pads its history walk, whatever the count's provenance. The floor prompt is the count-based estimate, from a provider count or a compacted count, when it covers the walk. Otherwise, including at count 0, it is the padded walk.
  - This covers the continuation after `MAX_TOKENS` on a small window that was reported on #15486. At 32,768 tokens, with a usage-based estimate of about 22.8K and a walk of about 14.5K, the padded walk is about 34.5K, and the continuation went out with `max_tokens: 1`. It now gets 4,000. A usage-based estimate that fills the window still gets 1.
- **Room.** The room always comes from the padded estimate, so the pad still shrinks every grant above the floor.

### Window invariant (#5950)

The clamp was built so that `prompt + max_tokens ≤ window` holds on every main-turn request whose estimated prompt fits the window (#5950). #13252 then capped the 4,000-token floor by `window − prompt`, so that a small window keeps the invariant too.

This change deliberately relaxes that invariant for count-based estimates. Their floor is capped by the window minus the unpadded estimate, so the padded estimate plus `max_tokens` can exceed the window by up to the pad. The invariant now holds against the unpadded count-based estimate rather than the padded one. Fresh walks at count 0 keep the padded cap, and on the first send a provider count was never padded.

Without the relaxation, a small window is left with no output room after a compaction. On a 32,768-token window, the window minus the pad leaves 12,768 tokens, so any post-compaction estimate above that gets `max_tokens: 1`, even with the double count fixed.

The window clamp has no design document of its own under `docs/design/`. This section records the change, and the comments on `MIN_CLAMPED_OUTPUT_TOKENS` and `clampOutputTokensToWindow` in `tokenLimits.ts` state the same scope.

## Decisions and rationale

| Decision                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix the caller, not the compression service          | The service follows its documented contract. One caller passed a count that broke it. Manual `/compress`, reactive compaction, `/compress-fast` and the hosted compaction pass no pending message and stay as they are.                                                                                                                                                                  |
| Pass the baseline instead of subtracting the message | The effective count can include a memory snapshot sent with this message. The same estimate without the pending content cancels exactly, whatever it holds.                                                                                                                                                                                                                              |
| Records count the pending turn as it is sent         | The record's snapshot stores the message, and resume seeds its count from the record. A record without it would start the resumed session one message short. Counting the turn as the request after compaction carries it keeps a memory snapshot the resumed history holds and leaves out one the request strips.                                                                       |
| Cap the floor, keep the pad                          | A fresh walk really misses about 18K tokens of overhead. A grant above the floor overflows by exactly the overhead the pad and the margin leave uncovered. A quarter-window pad plus the 10K margin covers the 18,359 tokens of the dry run only from about a 33K window up, so smaller fresh sessions would overflow. Capping the floor changes only grants that fall below the floor.  |
| Count-based estimates only                           | On a fresh walk the pad stands for real overhead. An unpadded cap there opens a band where today's grant of about 2K fits but 4K would not: window minus estimate between 20K and about 22.4K, with the 18,359-token overhead from the dry run.                                                                                                                                          |
| A recovery send needs a covering count               | When the walk exceeds the count, the extra may be real growth that the count missed, for example a response without usage. The padded cap stays.                                                                                                                                                                                                                                         |
| Relax the #5950 invariant for count-based estimates  | A count-based estimate already carries the overhead the pad stands for, and capping its floor by the padded estimate leaves a small window no room after a compaction. The cost is a possible 400 instead of a `max_tokens: 1` reply that ends the turn. On a first send reactive overflow recovery handles it; a recovery send ends the reply with the text written so far (see Risks). |
| Keep the gate on the effective count                 | Only the count that sizes the compacted count changes. Compaction still triggers on the prompt this send will carry, so it triggers no later than before.                                                                                                                                                                                                                                |

## Risks

- The relaxed floor (see "Window invariant") can exceed the room that is really left when a count-based estimate misses overhead, for example a compacted count whose baseline was itself a fresh walk, or a resume seeded from an estimate. Only a real prompt above `window − 4,000` is affected, inside a band at most 4,000 tokens wide. The provider rejects the request as a context overflow, and the existing reactive overflow recovery compacts and retries. Before this change the same case sent `max_tokens: 1`, and the turn ended without output, so this failure is strictly better.
  - Measured on a 16K window: a resumed session re-adds about 3K tokens of startup context that the count seeded from the compression record does not include. The follow-up after `/compress` overflowed by 639, and recovery compacted and completed the turn. The same flow on a 20K window fits.
  - A recovery send after a truncated reply relaxes the floor only when the count-based estimate covers the history walk, which rules out a count that missed more than the overhead it carries. A count that went stale by less, because a response in the loop reported no usage, still passes, and that send can exceed the window by at most `min(4,000, the content the count missed)`. The recovery loop does not run reactive overflow recovery: the rejected send is rolled back and the reply ends with the text written so far. Before this change that send got the padded floor, which is smaller and often 1 on a small window.
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
  - **End to end through the real compression service:**
    - the C1 case, for a pending tool result and pending text, on both the cache-sharing and the cold accounting paths. The turn is sent, and the compacted count is smaller than the pending message;
    - both branches of the cold formula, with and without a retained tail. The compacted count is exactly the baseline minus the summarized history plus the summary (and the note before a retained tail), and the side query carries the pending result only without a tail;
    - the gate: a 165K baseline is below the 170K auto threshold, and a 10K pending message takes the effective count to 175K. Compaction runs through the real gate, with the full count passed as `precomputedEffectiveTokens`.
  - **Records:** the hard-tier and auto compression records count the pending message, while the adopted count and the `COMPRESSED` event keep the compacted count. On both record paths the record adds exactly the turn the request carried: with a fresh memory snapshot, with a snapshot that compaction dropped from the history and the send attached again, and without a replayed snapshot the request strips, which the record still stores.
  - **First send:** a 16K window after a compaction gets 4,000 instead of 1, and a fresh session keeps the padded cap (1,999 on a 32K window).
  - **Recovery:**
    - a 16K window with a provider count gets 4,000;
    - on a 32,768-token window, fresh usage that leaves room gets 4,000, and fresh usage that fills the window gets 1;
    - without a covering count the padded cap stays, including a positive count below the walk;
    - a count-based estimate equal to the walk caps the floor: the check is inclusive.
- Existing tests updated: two expected original counts now leave out the pending message, and one expected record count includes it.
- Mutation check: 14 hand-written mutants, each undoing one decision above (the record add-back, the adopted count, the gate input, the floor's scope on the first send and on recovery sends, either cold-path branch, the baseline itself), each make at least one of these tests fail. Five more for the round-one fixes do too: each record path adding the raw message, the auto record adding the pre-compaction effective count minus the baseline (which misses a snapshot compaction drops), and the recovery check written as `>` or as `> 0`.
- End-to-end runs against a mock provider and a real provider are reported on the PR.

## Acceptance criteria

- After a compaction with a pending message, the hard-tier guard and the output clamp count the pending content once.
- A count-based estimate that fits never gets `max_tokens` below `min(4,000, window − unpadded estimate)` because of the pad.
- Fresh-session grants, and every grant at or above the floor, are unchanged.
- A compression record counts the compacted history plus the pending turn exactly as the request after compaction carries it.

## Follow-ups

- Dropping the pad for counts anchored on provider usage, as the triage of #15486 suggests, would also raise grants above the floor. It is left as a separate decision.
- Sizing the post-compaction file restoration budget to the window (#15487).
