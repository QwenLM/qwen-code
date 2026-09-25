---
title: 'BUG: --resume Can Reintroduce the Dangling-Unsigned-Thought Hazard PR #8260 Fixed'
date: '2026-08-04'
status: 'confirmed'
---

# `--resume` Can Reintroduce the Dangling-Unsigned-Thought Hazard PR #8260 Fixed

> Companion to [`2026-08-04-reasoning-episode-invariants.md`](./2026-08-04-reasoning-episode-invariants.md)
> and [#8533](https://github.com/QwenLM/qwen-code/issues/8533). Filed as
> [#8535](https://github.com/QwenLM/qwen-code/issues/8535). Verdict reached independently by four reviewers on
> different model families, cross-checked against each other, and verified
> directly by the consolidator against
> [`fix/geminichat-thought-consolidation`](https://github.com/QwenLM/qwen-code/tree/fix/geminichat-thought-consolidation)
> @ [`f907a0f5c`](https://github.com/QwenLM/qwen-code/commit/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e)
> (PR #8260's tip commit at audit time; the branch has since moved).

## Verdict: **BUG**

`--resume` (and `--continue`) can reconstruct the exact "dangling unsigned
thinking part immediately preceding a `tool_use`" hazard that PR #8260's
[`dropDanglingUnsignedTrailingThought`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L1045-L1054)
was built to prevent on the live path. The mechanism is not "the resume path
re-runs stale logic" — it's that the resume path runs **no** reasoning-episode
consolidation at all, and the resulting un-coalesced `Content[]` shape is
independently re-merged by the Anthropic converter's own
`mergeConsecutiveAssistantMessages`, which runs **before** the unsigned-
thinking guard in the request-conversion pipeline.

**Severity is backend-dependent**: proxy-routed, adaptive-thinking Anthropic-
compatible backends get a controlled, diagnostic local `throw`. **Native
Anthropic base URLs get no local guard at all** (`dropUnsignedAssistantThinking`
is explicitly gated `!isAnthropicNativeBaseUrl(...)` at
[`anthropicContentGenerator.ts:736-740`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts#L736-L740)),
so the malformed request ships straight to the wire and — per Anthropic's own
documented replay contract — is expected to be rejected with a raw 400
directly from Anthropic's API. This specific native-Anthropic outcome was not
verified against a live API by any reviewer; everything else in this document
is a direct, static trace of the actual code.

## How this was corrected mid-review

The initial investigation prompt (written by the consolidator, based on an
earlier session's analysis) stated as "confirmed fact" that a MAX_TOKENS
recovery persists **three** separate JSONL records: the truncated attempt, a
synthetic recovery user message, and the continuation. **That premise was
wrong**, and it drove one reviewer (independently corroborated by a second
before the error was caught) to an initial verdict of BENIGN, reasoning that
the synthetic recovery message's absence of a `tool_result` block would break
the Anthropic converter's backward "active tool-use chain" scan before it
ever reached the truncated turn's dangling thought.

Direct verification (grepping every `chatRecordingService` call in
`geminiChat.ts`) found exactly five call sites: `recordChatCompression`
(×3) and `recordAssistantTurn` (×2) — **no call anywhere persists the
synthetic `OUTPUT_RECOVERY_MESSAGE` user turn**. It is pushed only to
in-memory `self.history`, never to disk. Once this was corrected, all four
independent reviewers converged on **BUG** via the same mechanism, described
below. This correction — and the discipline of catching a wrong "confirmed
fact" via independent grep rather than trusting it — is itself evidence for
the broader pattern this document and #8533 describe: claims about this
subsystem's behavior are easy to get wrong even when made in good faith,
because the invariant is enforced by convention and pattern-matching, not by
the type system.

## The mechanism, traced end to end

### 1. What PR #8260's fix actually does — and its scope

[`coalesceRecoveryPairs`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L5097-L5139)
re-runs `dropDanglingUnsignedTrailingThought` on the truncated turn's parts
immediately before merging in a recovery continuation that carries a
`functionCall`. This closes the hazard for the **live, in-memory** session.
It mutates only `this.history` — it has no reference to `chatRecordingService`
anywhere in its body.

### 2. What is actually on disk, regardless of the fix

- `recordAssistantTurn` is called from `processStreamResponse` at
  [`geminiChat.ts:4963`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L4963),
  and from a deferred-partial-flush path at
  [`geminiChat.ts:3809`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L3809).
  Both write to the on-disk JSONL transcript **before** `coalesceRecoveryPairs`
  ever runs — `coalesceRecoveryPairs` is invoked only after the entire
  recovery loop completes.
- The MAX_TOKENS-truncated turn that starts a recovery sequence, by
  construction, has **no** `functionCall` of its own (recovery is skipped
  entirely if it does — the `hasFunctionCall` guard in the recovery loop).
  So Site 1's own per-stream `dropDanglingUnsignedTrailingThought` call never
  fires for this record (its `hasToolCall` is `false`), and `recordAssistantTurn`
  writes the truncated turn to JSONL **with its dangling unsigned thought
  intact**.
- The synthetic `OUTPUT_RECOVERY_MESSAGE` user turn
  (`recoveryUserContent`, pushed to `self.history` at
  [`geminiChat.ts:3417-3493`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L3417-L3493))
  is **never persisted** — confirmed by grepping every `chatRecordingService`
  call in the file.

**Net result: the on-disk JSONL for a MAX_TOKENS recovery where the
continuation calls a tool has exactly two adjacent `model`-role records**
(the truncated attempt, ending in an unsigned dangling thought; then the
continuation, carrying the `functionCall`), with nothing between them — not
three records as originally assumed, and not the merged, clean single record
the in-memory fix produces.

### 3. The resume/load code path re-runs no consolidation

Traced in full, from `--resume` to rehydrated `Content[]`:

1. [`GeminiClient.initialize()`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/client.ts#L429-L441)
   calls `buildApiHistoryFromConversation(resumedSessionData.conversation)`
   and passes the result directly into `startChat(...)`.
2. [`buildApiHistoryFromConversation`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/sessionService.ts#L2197-L2251)
   walks the persisted `ChatRecord[]` and calls
   [`appendApiHistoryRecord`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/sessionService.ts#L2171-L2184)
   once per record: `history.push(copyContentForApiHistory(record.message))`,
   with one special case (merging consecutive `mid_turn_user_message`
   records into the previous **user** turn — irrelevant here, since these
   are both `model`-role records).
   [`copyContentForApiHistory`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/sessionService.ts#L2143-L2169)
   copies every part verbatim via `{ ...part }` — no branch special-cases
   `thought` or `thoughtSignature`.
3. `startChat()` runs exactly one repair pass on the resumed history:
   [`repairOrphanedToolUseTurnsInHistory()`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/client.ts#L1561-L1563),
   scoped entirely to `functionCall`/`functionResponse` pairing. It never
   reads or writes `part.thought`/`part.thoughtSignature`.

**Grep-confirmed**: no call to `coalesceRecoveryPairs`,
`appendRecoveryContinuationParts`, or `dropDanglingUnsignedTrailingThought`
exists anywhere in `sessionService.ts`, `session-recovery.ts`, or `client.ts`.
The two on-disk records are loaded **as-is**.

### 4. The hazard reconstruction

On the next Anthropic-routed request built from this resumed history:

1. `processContents` emits one Anthropic message per `Content` — so the
   truncated attempt and the continuation become two separate assistant
   messages.
2. [`mergeConsecutiveAssistantMessages`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1405-L1448)
   runs at [`converter.ts:285` and `:287`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L285-L287) —
   **before**
   [`dropUnsignedThinkingFromAssistantMessages`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L300-L301) —
   and concatenates the two adjacent assistant messages' content blocks in
   original order, with **no thinking/signature awareness at all** (dedup is
   keyed only on `tool_use` id). Its own doc comment
   ([`converter.ts:1379-1385`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1379-L1385))
   names "max_tokens recovery" as one of the exact scenarios producing the
   consecutive-model-turn shape it exists to merge.
3. The two on-disk records are now **one single Anthropic message**
   containing both the unsigned dangling thought and the `functionCall` —
   the identical corrupted shape PR #8260's live-path fix was written to
   prevent, reconstructed one pipeline stage upstream of the guard that
   would have caught it had it arrived as a single stream turn.
4. `dropUnsignedThinkingFromAssistantMessages`'s backward "active tool-use
   chain" walk then either includes this merged message (if the conversation
   progressed further with a matching `tool_result`) and **throws** (proxy
   path) — or, for native Anthropic, the guard never runs at all and the
   malformed message ships straight to the wire.

### A second hazard shape (Race B)

`geminiChat.ts`'s own canonical note documents a second, distinct hazard shape: a
process crash or OOM leaves a dangling `model[fc]` in the JSONL transcript which
`--resume` then rehydrates. If this `functionCall` turn also contains an unsigned thought
(e.g., via a proxy-dropped signature, the accepted residual risk documented in Site 1),
they are **already in the same JSONL record** — no merge needed. On resume, `repairOrphanedToolUseTurns` (Site 4
of the companion inventory) synthesizes an error `functionResponse` for the
orphaned `functionCall`, which makes this turn **active** again (a `tool_use`
immediately followed by a `tool_result`) — without ever inspecting or fixing
the preceding, still-unsigned thought part. The repair pass that exists
specifically for this documented race has a total blind spot for the exact
hazard class PR #8260 was written to close.

## What was verified vs. not verified

**Verified by direct code read** (by all four independent reviewers,
cross-checked, and by the consolidator): the full resume call chain from
`client.ts:initialize()` through `GeminiChat`'s constructor and `startChat()`;
every mutation point along that chain; `coalesceRecoveryPairs`'s in-memory-only
scope; the absence of any JSONL persistence call for the recovery message;
the Anthropic converter's full pipeline order; both `mergeConsecutiveAssistantMessages`
and `dropUnsignedThinkingFromAssistantMessages`'s implementations; the
native-vs-proxy gating of the local guard.

**Not verified**: no reviewer executed an end-to-end reproduction (force a
MAX_TOKENS recovery with a tool call in the continuation, kill the process,
`--resume`, inspect the raw on-disk JSONL bytes, and observe the actual
Anthropic API response). This is a static-analysis trace, not an observed 400. Given the significance of this finding, an executed repro is the
recommended confirming next step before broader remediation work begins —
and a natural first test case for whatever fix lands, since no existing test
in the repo currently exercises the resume-time reconstruction of a
MAX_TOKENS-recovered turn.

Native-Anthropic's exact server-side rejection behavior (as opposed to our
own code's model of "active chain") was also not verified against a live
API by any reviewer — flagged explicitly rather than asserted.

## Relationship to #8533 and the invariants inventory

This is the concrete instance the companion inventory document's Site 3
refers to, and it is presented here as its own document because it is an
actionable, scoped bug — not a philosophical question — with a clear next
step. Two changes are needed, and they are complementary rather than
alternatives:

1. **Consumer side** — reasoning-episode consolidation must happen at a layer
   every transcript→`Content[]` reader passes through (background-agent/fork
   transcript recovery, ACP replay/restore; see Site 11 of the inventory).
   Fixing resume-time rehydration alone is insufficient, since it leaves the
   other consumers exposed to the identical hazard.
2. **Producer side** — the persistence layer should write the coalesced
   shape, so newly written transcripts are correct at rest.

Neither substitutes for the other. A producer-only fix is inert for every
transcript already on disk, and those are precisely the sessions a user
resumes; a consumer-only fix leaves the on-disk record permanently divergent
from live history, so any future reader inherits the same hazard. No fix is
proposed in detail here, consistent with this being a
documentation-and-verdict deliverable, not an implementation PR.
