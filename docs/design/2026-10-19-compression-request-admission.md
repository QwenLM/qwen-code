# Compression request admission

[English](2026-10-19-compression-request-admission.md) | [简体中文](2026-10-19-compression-request-admission.zh-CN.md)

Status: implemented for [#9455](https://github.com/QwenLM/qwen-code/issues/9455).

## Problem

Compression sends the whole history to a summarizer. The longer a session gets, the more it needs compressing, and the larger that request becomes, until the request no longer fits the model's own window. Automatic, reactive, and manual `/compress` compaction then fail the same way the main request did, and an oversized session cannot recover.

The cold path clamps its output budget to the room the estimate leaves (#7960), but floors it at 1. Once the estimated input fills the window it still sends the request, now with `max_tokens: 1`, which the provider rejects or answers with a one-token fragment. The only size check covered a distinct compaction model. When the main model also compresses, nothing stopped the request.

## Current state before this change

- The cold request is the slimmed history (media stripped) plus the compression prompt and directive. Its size is a char/4 estimate.
- `computeCompactionOutputBudget` returns `min(20K, window − estimate − 1K)`, floored at 1.
- A failed side-query returns `COMPRESSION_FAILED_API_ERROR`. It is tried once (`maxAttempts: 1`).
- The local estimator counted a thought part's `text` and ignored a `thoughtSignature` on the same part.

## Goals

- Never send a compression request that cannot leave the summary a usable output budget.
- When the history does not fit, reduce it in bounded stages that keep complete tool interactions, the user's original request, and the newest context.
- Stop locally with a clear input-too-large status when no reduction fits.
- Keep conversations that already fit on the same single-pass path.

## Non-goals

- A more accurate estimator. A fixed per-language multiplier over-counts dense CJK text by roughly 2× (measured in #9541) and refuses sessions that would compress, so the estimator is unchanged.
- The cache-sharing request. If it fails, compression falls back to the cold path, which this change covers.
- Compacting with the previous model after a model switch.

## Design

### Admission

A cold request is sent as today when its output budget is at least the minimum: `MIN_COMPACTION_OUTPUT_TOKENS` (4,096), or a quarter of the window when that is smaller. A fixed 4,096 would take half of an 8K window and all of a 4K one, which self-hosted deployments do run. Below the minimum, the request is reduced first.

### Reduction stages

Each stage stops as soon as the estimate fits the target. The target leaves the summary a quarter of the window, up to 20,000 tokens. That is never below the minimum.

1. **Truncate tool payloads.** Tool results, tool-call arguments, and model text are cut to 4,000 characters, reusing the payload-overflow cap (#10380). With `preserveUserText`, the user's own text parts stay whole.
2. **Condense older turns to the user's messages.** `condenseToUserMessages` keeps the newest turns intact. They start on a model turn, so no function call is separated from its response and roles keep alternating. Everything older becomes one user message that quotes the user's messages verbatim:
   - the first message is always kept; after an earlier compaction it holds that summary, so it may take up to 32,000 characters, at least half the quote budget when newer messages need the rest;
   - the rest fill newest-first;
   - every other quote is capped at 8,000 characters, and all quotes together at 64,000;
   - user text that rides a tool-result turn (input steered in while tools ran) is quoted, the tool output is not;
   - injected `<system-reminder>` blocks are not the user's words and are left out, so they cannot fill a capped quote ahead of the prompt;
   - a note says how many assistant and tool messages, and how many middle user messages, were left out;
   - when the budget cannot hold any of the first message, it returns nothing, so no request goes out without the user's words.

   Assistant replies and tool output are dropped first because files can be re-read and commands re-run, while the user's words exist nowhere else. The summary prompt already asks for `primary_request_and_intent` and `all_user_messages`, and the quotes feed both.

If the reduced request still cannot leave the minimum, compression returns `COMPRESSION_FAILED_INPUT_TOO_LARGE` without sending anything. It counts toward the failure breaker like other failures.

### One retry after a context-length rejection

The estimate can still run low, notably for dense CJK text. When the provider rejects the cold request for context length (`getContextLengthExceededInfo`), compression retries once with a smaller request, sized from the rejection itself:

- **Window.** When the rejection names the whole context window (`limitKind: 'total'`) and it is smaller than the configured one, the retry uses it. A self-hosted server can run a smaller window than the model's own, and the rejection is the first place it shows.
- **Ratio.** When the rejection reports the request's real size, the ratio of that size to the request's estimate (never below 1) scales the estimate on both sides. The input is sized to leave a quarter of the window, up to 20,000 tokens, and `max_tokens` is computed from the scaled estimate. Scaling only the input would leave `max_tokens`, computed from the uncorrected estimate, sized for room the request does not have. The ratio comes from the request just rejected, not from an earlier turn.
- **No counts.** The retry aims at 60% of the rejected request's estimate.
- **No fit.** When no reduction leaves the minimum in that window, the retry is not sent and compression returns `COMPRESSION_FAILED_INPUT_TOO_LARGE`.

A second failure, or any other error, returns `COMPRESSION_FAILED_API_ERROR` as before.

`getContextLengthExceededInfo` now reads the input count from vLLM's wording ("your prompt contains N input tokens"), so the retry gets a ratio there. Its "contains at least N" form is where tokenization stopped, not the prompt's size, and stays limit-only.

### Truncated summaries

A summary that opens `<state_snapshot>` and never closes it is dropped as `COMPRESSION_FAILED_OUTPUT_TRUNCATED`, whatever count it reports. vLLM serves `prompt + max_tokens > window` by lowering `max_tokens` to the room the prompt leaves rather than rejecting the request, so the reported output count stays below the budget requested and the existing threshold check cannot see the cut. A summary without the tags is unaffected.

### Accounting

A reduced request no longer describes the history it replaces. Its reported usage is therefore not used to derive the post-compression count. The visible-history estimate path is used instead, as it already is for payload-overflow compactions.

### Thought signatures

`estimatePartChars` now counts a `thoughtSignature` together with the thought text. Every consumer of the shared estimator sees slightly larger, more conservative counts.

## Decisions and rationale

| Decision                                             | Rationale                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the char/4 estimator                            | It under-counts, so a refusal based on it only happens when the request cannot fit. #9541 replaced it with a byte-weighted estimate and refused Chinese sessions from about 50% of the window.                |
| Drop assistant and tool content before user messages | Files can be re-read and commands re-run. The user's words exist nowhere else (Codex keeps them verbatim for the same reason).                                                                                |
| Cut at a model turn                                  | Keeps function calls and responses paired, and keeps roles alternating after the quote block, without parsing turn structure.                                                                                 |
| A single retry                                       | Compression stays best-effort and does not block the user. The rejection's own numbers make one well-sized retry enough in the common case.                                                                   |
| New failure status                                   | Users and telemetry can tell "too large to compress" apart from an API error.                                                                                                                                 |
| A quarter of the window as the minimum below 16K     | A fixed 4,096 leaves an 8K window little room for history and a 4K one none. A summary that does not fit the smaller budget is dropped as truncated, and the history is kept.                                 |
| Scale the retry's input and output alike             | `max_tokens` is computed from the estimate. A retry that corrects only its input still asks for output the window cannot hold.                                                                                |
| Drop an unclosed snapshot whatever the count         | A server that lowers `max_tokens` silently reports a count below the budget, so the unclosed tag is the only sign of the cut. Summaries without tags are left alone, since weaker models may skip the format. |

## Risks

- A summary written from condensed input knows less about assistant work in the condensed part than a full-history summary would.
- Quoted user messages can include injected reminders that ride user turns. Each quote is capped.
- Without counts in the rejection, a 60% retry may still be too large for very dense text. Compression then fails as before, without sending a third request.
- The ratio comes from the rejected request. The retry keeps the user's text and cuts tool output, so its own ratio can be higher. The 1,024-token margin and the 60% cap absorb part of that; past it, compression fails after the one retry.
- On windows below about 16K a reduced request leaves the summary a quarter of the window, which a long summary may not fit. It is then dropped as truncated, and the history is kept. At 4K the condensed input is little more than the first request.

## Validation

- Unit tests in `compactionInputSlimming.test.ts`: thought signature counting, `preserveUserText`, and `condenseToUserMessages` (pinning, ordering, caps including the larger first-message cap, user text riding a tool-result turn, model boundary, oversize tail, immutability, no block without the user's words).
- Unit tests in `contextLengthError.test.ts` for vLLM's input count and its "contains at least" form.
- Unit tests in `chatCompressionService.test.ts` (`issue #9455`), against a backend that enforces `prompt + max_tokens <= window` and can count above the local estimate:
  - fitting requests unchanged;
  - truncation only;
  - condensing;
  - local refusal;
  - post-compression accounting;
  - a CJK session admitted unchanged;
  - retry with counts, retry without counts, giving up after one retry, no retry for other errors, and an abort that lands on a rejected request;
  - a payload-overflow (413) compaction condensed from its already-capped input;
  - a 4K window compressed with a quarter-window budget, and a 2K window refused locally;
  - a 16K window billing 2.5× the estimate, whose retry keeps the user's messages and fits;
  - a retry sized for a smaller window the rejection reports, and a local refusal when that window cannot hold one.
- Unit tests in `chatCompressionService.test.ts` (`issue #7960`): a summary cut off mid-snapshot under a reported count below the budget is dropped, and a complete summary without tags is kept.
- CLI tests for the new status text.
- An 18-mutant sweep over the new logic (admission threshold, local refusal, retry count, retry sizing and progress check, abort handling, accounting gate, 413 input, output reserve, user-text preservation, system-reminder stripping, signature counting, model-turn cut, first-message pinning and cap, steered text), and an 8-mutant sweep over the review fixes (ratio in `max_tokens`, reported window, quarter-window retry reserve, unclosed-snapshot check, quarter-window minimum, retry refusal status, vLLM count, user-text guard): every mutant fails at least one test.

## Acceptance criteria

- No cold compression request is sent with an output budget below 4,096 tokens, or a quarter of the window when that is smaller.
- A request that fits is sent unchanged.
- A reduced request keeps the first and newest user messages verbatim, starts its kept turns on a model turn, and keeps every function response after its call.
- No compression request is sent without the user's words when the history has any.
- An irreducible request returns `COMPRESSION_FAILED_INPUT_TOO_LARGE` with no request sent, and the CLI shows a non-empty message for it.
- A context-length rejection leads to at most one smaller retry. When the rejection reports a window or a token count, the retry's input and `max_tokens` are both sized from them.
- A summary cut off inside its `<state_snapshot>` is never persisted.

## Follow-ups

- Cache-sharing admission against an anchor from another route.
- Compacting with the previous model before switching to a smaller window.
- vLLM's "`max_tokens` cannot be greater than" rejection is not recognized as a context overflow. Classifying it would change the main chat path too.
- A server that drops messages from the front instead of rejecting (Ollama's default) sends nothing to retry from, and the condensed quote block is the first message it drops.
- A CJK-aware upper-bound estimate to size the first request's output budget, so dense sessions are not rejected before the retry corrects them.
