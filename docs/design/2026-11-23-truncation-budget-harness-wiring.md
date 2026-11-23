# Carry the truncation output budget into every harness

[English](2026-11-23-truncation-budget-harness-wiring.md) | [简体中文](2026-11-23-truncation-budget-harness-wiring.zh-CN.md)

## Problem

When the output limit cuts a response in the middle of a tool call, the main loop's rejection tells the model what the cut spent of the limit, so it can size the parts of a split write (#16417, #16632). Two harness surfaces settle for the truncation boolean alone: the subagent runtime, which builds its own tool requests in place of the `Turn`'s, and the ACP session's own executor, which applies the scheduler's partial-edit guard itself for daemon and IDE sessions that send through the session's chat. A truncated `write_file` from a subagent or from such a session is rejected without the numbers (#17306).

## Design

- Extract the two pieces every surface needs, unchanged, from where they already live: the budget derived from the response's usage and the send layer's limit (`outputBudgetAtTruncation` in `core/turn.ts`), and the sentence a rejection adds for a known budget (`truncationBudgetNote` in `core/coreToolScheduler.ts`). The `Turn` and the scheduler call them, so every surface derives and phrases the same thing.
- Subagent runtime. The shared loop records the budget beside its truncation mark when a round's response finishes with `MAX_TOKENS`, clears both when an attempt is retried or replaced, and `settle` stamps it on the agent's requests next to the mark. The current loop keeps the usage of the chunk that reported the cut and hands the budget to `processFunctionCalls`, which puts it on each request it builds.
- ACP session. The per-response facts gain the budget. The own-chat send wrapper derives it as the `Turn` does; the shared-round wrapper takes it from the round's requests, which the client has already recorded. The session's own partial-edit guard appends the budget note on the same arm as the scheduler: the refusals before the retry directive takes over.
- No new derivation. The budget stays absent whenever either number was not measured (zeroed or missing usage, no limit), and a retried attempt never inherits the cut attempt's budget.

## Validation

Unit, on all three agent loops (current, shared, and shared on the event-bus kernel): a cut-off round's scheduled request carries `{ usedTokens: 4096, limitTokens: 8192 }` for a usage of 12288 total and 8192 prompt against an 8192 limit, and the scheduler's real refusal of a cut-off edit contains `used 4096 of the 8192-token output limit`; a cut that reports zeroed counts, an uncut response, and a retried attempt carry no budget. In the ACP session, the own executor's refusal of a cut-off `write_file` names the budget and leaves it out for zeroed counts, and the shared tool batch names it without further wiring because it schedules the client's own requests. The scheduler's and the `Turn`'s existing budget tests pass unchanged.

Manual: with a small output limit, have a subagent and a daemon (`qwen acp`) session each attempt a `write_file` larger than the limit. Both refusals should state the tokens used and the limit.
