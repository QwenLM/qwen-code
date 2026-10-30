# Compression request admission

[English](2026-10-19-compression-request-admission.md) | [简体中文](2026-10-19-compression-request-admission.zh-CN.md)

Status: implemented for [#9455](https://github.com/QwenLM/qwen-code/issues/9455). Keeping the user's messages whole in a reduced request is a follow-up ([#14953](https://github.com/QwenLM/qwen-code/pull/14953)).

## Problem

Compression sends the whole history to a summarizer. The longer a session gets, the more it needs compressing, and the larger that request becomes, until the request no longer fits the model's own window. Automatic, reactive, and manual `/compress` compaction then fail the same way the main request did, and an oversized session cannot recover.

The cold path clamps its output budget to the room the estimate leaves (#7960), but floors it at 1. Once the estimated input fills the window it still sends the request, now with `max_tokens: 1`, which the provider rejects or answers with a one-token fragment. The only size check covered a distinct compaction model. When the main model also compresses, nothing stopped the request.

## Current state before this change

- The cold request is the slimmed history (media stripped) plus the compression prompt and directive. Its size is a char/4 estimate.
- `computeCompactionOutputBudget` returns `min(20K, window − estimate − 1K)`, floored at 1.
- A failed side-query returns `COMPRESSION_FAILED_API_ERROR`. It is tried once (`maxAttempts: 1`).

## Goals

- Never send a compression request that cannot leave the summary a usable output budget.
- When the history does not fit, reduce it without dropping a turn, so every tool call keeps its response.
- Stop locally with a clear input-too-large status when the reduced request does not fit either.
- Keep conversations that already fit on the same single-pass path.

## Non-goals

- A more accurate estimator. A fixed per-language multiplier over-counts dense CJK text by roughly 2× (measured in #9541) and refuses sessions that would compress, so the estimator is unchanged.
- Keeping the user's messages whole in a reduced request, or dropping older turns to make room. Both need to know which text the user typed, and are left to a follow-up (#14953).
- The cache-sharing request. If it fails, compression falls back to the cold path, which this change covers.
- Compacting with the previous model after a model switch.

## Design

### Admission

A cold request is sent as today when its output budget is at least the minimum: `MIN_COMPACTION_OUTPUT_TOKENS` (4,096), or a quarter of the window when that is smaller. A fixed 4,096 would take half of an 8K window and all of a 4K one, which self-hosted deployments do run. Below the minimum, the request is reduced first.

### Reduction

The reduced request cuts every text part (tool results, tool-call arguments, model text and the user's messages) to 4,000 characters, reusing the payload-overflow cap (#10380). A cut part keeps its start. No turn is dropped, so every function call keeps its response and roles keep alternating. A wrapped `<system-reminder>` part longer than the cap has its body cut the same way and its closing tag added back: cut like other text, it would lose that tag and read as open over the text after it.

If the reduced request still cannot leave the minimum, compression returns `COMPRESSION_FAILED_INPUT_TOO_LARGE` without sending anything. It counts toward the failure breaker like other failures.

### One retry after a context-length rejection

The estimate can still run low, notably for dense CJK text. When the provider rejects the cold request for context length (`getContextLengthExceededInfo`), compression retries once, sized from the rejection itself:

- **Window.** When the rejection names the whole context window (`limitKind: 'total'`) and it is smaller than the configured one, the retry uses it. A limit whose wording leaves its kind open ("prompt is too long: N tokens > M maximum") is used the same way once the rejection's own prompt count is past it; a model inferred at 1M and served at 200K first shows its real window there. A self-hosted server can run a smaller window than the model's own, and the rejection is the first place it shows.
- **Prompt count.** The retry takes the rejected prompt's own size from the rejection. "You requested N tokens" with no breakdown counts the requested output too; that total is taken as an upper bound on the prompt, since the transport can lower `max_tokens` below the budget compression asked for (a configured or model output cap), and subtracting that budget could undercount the prompt. A count far below the request's estimate, or one under which the request would have fit the limit the same message states, describes some other request and is ignored.
- **Only the output overran.** When the prompt leaves the summary its reserve (a quarter of the window, up to 20,000 tokens), the same request is sent again with `max_tokens` lowered to the room the count leaves, which is never below the reserve. When that room is no smaller than the budget sent, the count says the request fit this window, so the server's window is smaller by an amount the message does not state, and the reduced request is sent instead, as when the rejection has no counts.
- **The overflow is cut.** Otherwise the retry needs the estimate to drop by the overflow: prompt count + reserve + 1,024 − window, or prompt count + 1,024 − the input limit when the rejection states one and that is larger. When the reduced request drops that much, it is sent with the reserve as its output budget. char/4 usually under-counts, so an estimated token removed takes at least one real token with it, and the prompt fits whatever mix of dense and sparse text remains. A ratio of the count to the estimate would not: the text the reduction keeps, such as CJK messages under the cap, can be denser than the tool output it cuts, so the ratio underrates what is left. When the count runs below the estimate (sparse ASCII), an estimated token removed takes less than one real token with it, so the drop needed grows by that ratio.
- **The overflow is not cut.** When the reduced request drops less than that, less suffices if the removed text is as dense as the rest. Rather than refuse, the retry's output budget is then sized by the rejected prompt's average density, its count over its estimate. It overruns only when the text kept is denser than the text removed, and then fails like any second rejection.
- **No counts.** The reduced request is sent, its output budget sized from its own estimate.
- **No fit.** When the reduced request cannot leave the minimum in that window, or is no smaller than the rejected one, the retry is not sent and compression returns `COMPRESSION_FAILED_INPUT_TOO_LARGE`. A retry rejected for context length again returns the same status, not an API error.

A second failure, or any other error, returns `COMPRESSION_FAILED_API_ERROR` as before.

`getContextLengthExceededInfo` reports the prompt's own size (`promptTokens`) only from wording that states it apart from the output budget: OpenAI's "resulted in N tokens", the completion broken out of "you requested N tokens (… in the completion)" (OpenAI, DeepSeek, older vLLM, OpenRouter), Anthropic's "prompt is too long", vLLM's "your prompt contains N input tokens" and "your request has N input tokens", Gemini's older wording, llama.cpp and SGLang. A "you requested N tokens" total with no breakdown is reported as `requestedTokens`; one that names only the output ("you requested N tokens in the completion") gives no count. Each wording is matched within a single fragment of the error, so a number from a sibling field is never paired with it. `actualTokens` keeps the figure the reactive path has always read. vLLM's "contains at least N" is where tokenization stopped, not the prompt's size, and stays limit-only.

### Truncated summaries

A summary that opens `<state_snapshot>` and never closes it is dropped as `COMPRESSION_FAILED_OUTPUT_TRUNCATED` when the reported usage shows its request filled the window it was sized for: prompt plus output count within 1,024 tokens of that window. A server can stop the output where its window ends instead of rejecting `prompt + max_tokens > window` (llama.cpp's server does), so the reported output count stays below the budget requested and the existing threshold check cannot see the cut; the prompt and output counts still add up to the window. Without that sign the summary is kept, as before this change: a model can end without closing the tag, and dropping every such summary would trip the failure breaker. After a retry sized for a smaller window the rejection reported, that window is the one checked. A summary without the tags is unaffected. Only closed `<analysis>` blocks are set aside before the check: real models often quote the compression directive, `<analysis>` tag included, inside the snapshot, and stripping from that quote to the end would take the closing tag too. The first opening tag that starts a line is the one checked: a tag named mid-sentence, before the snapshot or after it, opens nothing. The cost is the opposite shape: a summary that first quotes a complete example snapshot and is then cut inside its real one passes. The usage-based guard missed that shape before this change too.

### Accounting

A reduced request no longer describes the history it replaces. Its reported usage is therefore not used to derive the post-compression count. The visible-history estimate path is used instead, as it already is for payload-overflow compactions.

## Decisions and rationale

| Decision                                              | Rationale                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the char/4 estimator                             | It under-counts, so a refusal based on it only happens when the request cannot fit. #9541 replaced it with a byte-weighted estimate and refused Chinese sessions from about 50% of the window.                                                                                                                                                      |
| Cut every text part, keep every turn                  | It reuses the payload-overflow cut (#10380) and keeps function calls paired without parsing turn structure. Keeping the user's messages whole needs to know which text the user typed, which the follow-up adds.                                                                                                                                    |
| A single retry                                        | Compression stays best-effort and does not block the user. The rejection's own numbers make one well-sized retry enough in the common case.                                                                                                                                                                                                         |
| New failure status                                    | Users and telemetry can tell "too large to compress" apart from an API error.                                                                                                                                                                                                                                                                       |
| A quarter of the window as the minimum below 16K      | A fixed 4,096 leaves an 8K window little room for history and a 4K one none. A summary that does not fit the smaller budget is dropped as truncated, and the history is kept.                                                                                                                                                                       |
| Cut the overflow rather than scale by a ratio         | A ratio assumes every part of the request is equally dense. The text the reduction keeps can be denser than the tool output it cuts, so a ratio underrates what is left. Requiring the overflow's drop at one real token per estimated token fits whatever remains, and the retry's `max_tokens` comes from the count, not the estimate.            |
| Drop an unclosed snapshot only when the window filled | A server that stops the output at the end of its window reports a count below the budget, so the filled window is the sign of the cut. Without it, an unclosed tag may only mean the model skipped it, and dropping those summaries would trip the failure breaker. Summaries without tags are left alone, since weaker models may skip the format. |

## Risks

- A reduced request cuts the user's messages to 4,000 characters like tool output, keeping their start, so the summary can miss the end of a long request. The follow-up keeps them whole.
- The reduction only cuts parts longer than 4,000 characters. A session made of many shorter messages does not get smaller, and is refused with `COMPRESSION_FAILED_INPUT_TOO_LARGE` rather than compressed.
- Without counts in the rejection, the reduced request may still be too large for very dense text. Compression then fails after the one retry, without sending a third request.
- When the reduced request does not drop the whole overflow, its output budget comes from the average density, which can overrun if the text kept is denser than the text removed; compression then fails after the one retry.
- On windows below about 16K a reduced request leaves the summary a quarter of the window, which a long summary may not fit. It is then dropped as truncated, and the history is kept.
- A server that stops the output at a window smaller than the one the request was sized for, or a transport output cap below the budget, can cut a summary mid-snapshot without the usage reaching that window. Such a summary is kept, as it was before this change.

## Validation

- Unit tests in `compactionInputSlimming.test.ts`: a long reminder cut and closed again at a 500- and a 4,000-character cap.
- Unit tests in `contextLengthError.test.ts`: the prompt count read from each supported wording, a total with no breakdown reported as requested, no count from a tokenization cut-off, a limit-only message, a bare comparison or a wording that names only the output, and `actualTokens` unchanged.
- Unit tests in `chatCompressionService.test.ts` (`issue #9455`), against a backend that enforces `prompt + max_tokens <= window` (and an input limit where a test sets one) and can count above the local estimate:
  - fitting requests unchanged;
  - a reduced request when truncation is enough;
  - local refusal;
  - post-compression accounting, for a reduced request and for a reduced retry;
  - a CJK session admitted unchanged;
  - retry with counts, retry without counts, giving up after one retry, no retry for other errors, and an abort that lands on a rejected request;
  - an 8K window compressed with a quarter-window budget, and a 2K window refused locally;
  - a retry sized for a smaller window the rejection reports, a local refusal when that window cannot hold one, and a retry the server cuts off at the end of that window dropped;
  - the same request resent with less output room when only the output overran, for a rejection that breaks the completion out, for one that gives only the total, and for a compaction model smaller than the main one;
  - a retry that fits when the text it keeps (CJK messages under the cap, billed as dense) is denser than the tool output it cuts;
  - the overflow past an input limit the rejection states;
  - a count ignored when it is far below the estimate or contradicts the limit in the same message;
  - a total with no breakdown taken as an upper bound, when the transport capped the output below the budget and when nothing did;
  - a bare "N tokens > M" rejection from a server whose window is below the configured one;
  - the reduced request when the count says the request should have fit (SGLang's wording, with no parsed limit);
  - a retry that fits when the provider counts fewer tokens than the estimate, and none sent when that count shows the reduced request cannot fit;
  - a session whose one user message is larger than the window, compacted instead of refused.
- Unit tests in `chatCompressionService.test.ts` (`issue #7960`): a window-filling turn reduced instead of sent with a budget floored at 1, a summary cut off mid-snapshot by a server that stopped at the end of its window dropped, an unclosed snapshot kept when the usage leaves the window room, a complete summary without tags kept, and a complete summary that names the tag after closing it kept.
- CLI tests for the new status text.
- A 25-mutant sweep over the new logic (admission reduction, local refusal, the quarter-window minimum, the reported window, the untyped limit, the window held to the configured one, the cut grown for a sparse count, the output-only resend, both count sanity checks, the requested total taken whole and not reduced by the budget sent, density sizing, the second rejection's status, the must-be-smaller check, both accounting flags, the unclosed-snapshot check, the filled window it requires and the window that is measured against, the input-limit term, the retry's minimum, the should-have-fit fallback, and a long reminder cut like plain text or replaced whole instead of cut and closed again): every mutant fails at least one test.

## Acceptance criteria

- No cold compression request is sent with an output budget below 4,096 tokens, or a quarter of the window when that is smaller.
- A request that fits is sent unchanged.
- A reduced request keeps every turn, so every function response stays after its call.
- An irreducible request returns `COMPRESSION_FAILED_INPUT_TOO_LARGE` without sending it, or without its retry when a rejection showed that no retry fits, or after its retry was rejected for context length too, and the CLI shows a non-empty message for it.
- A context-length rejection leads to at most one retry. When the rejection reports a window, the retry fits it. When it reports the prompt's size, the retry either resends the same input with less output room, never below the reserve, or sends the reduced input.
- A summary cut off inside its `<state_snapshot>` is not persisted when its reported usage reaches the window its request was sized for.

## Follow-ups

- Keep the user's messages whole in a reduced request, and condense older turns to them when truncation is not enough (#14953).
- Cache-sharing admission against an anchor from another route.
- Compacting with the previous model before switching to a smaller window.
- vLLM's "`max_tokens` cannot be greater than" rejection is not recognized as a context overflow. Classifying it would change the main chat path too.
- A server that drops messages from the front instead of rejecting (Ollama's default) sends nothing to retry from.
- A CJK-aware upper-bound estimate to size the first request's output budget, so dense sessions are not rejected before the retry corrects them.
- A per-part density floor (for example, ASCII at one token per four characters and CJK at one per two) would let the overflow check accept a reduced request whose removed text is dense.
- Anthropic's "input length and `max_tokens` exceed context limit: P + C > L" is not recognized as a context overflow. Recognizing it would change the main chat path too; for a retry it states the prompt's size directly.
