---
title: 'Reasoning-Episode Invariants Across Content[]/Part[] Mutation Sites'
date: '2026-08-04'
status: 'draft'
---

# Reasoning-Episode Invariants Across `Content[]`/`Part[]` Mutation Sites

> This doc is a consolidated, code-grounded companion to
> [#8533](https://github.com/QwenLM/qwen-code/issues/8533) (the philosophical
> "is `Content[]`/`Part[]` the right shared representation" issue) and a
> concrete follow-up product of PR #8260. It was produced by four independent
> reviewers (different model families, working without coordination) auditing
> the same codebase, cross-checked against each other, and independently
> re-verified line-by-line by the consolidator against
> [`fix/geminichat-thought-consolidation`](https://github.com/QwenLM/qwen-code/tree/fix/geminichat-thought-consolidation)
> @ [`f907a0f5c`](https://github.com/QwenLM/qwen-code/commit/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e)
> (PR #8260's tip commit at audit time; the branch has since moved). All four reviewers independently discovered that
> the ambient checkout at review time (`dogfood/reasoning-fidelity`) predates
> PR #8260 and does not contain the fix chain at all — every citation below
> is against `f907a0f5c`, linked as a permanent GitHub blob URL so it resolves
> regardless of what branch is later checked out.

## Problem

qwen-code's shared internal chat history representation, `Content[]`/`Part[]`
(from `@google/genai`), is used across every content generator: Anthropic
(`USE_ANTHROPIC`, incl. DeepSeek's Anthropic-compatible backend), Gemini
(`USE_GEMINI`/`USE_VERTEX_AI`), OpenAI-compatible (`USE_OPENAI`), and
Qwen/DashScope (`QWEN_OAUTH`). Reasoning/thinking output
rides on exactly two fields on a `Part`: `thought: boolean` and
`thoughtSignature?: string`. Providers disagree sharply on how strict the
replay contract for these fields is:

- **Anthropic**: strict. Every `thinking` block belonging to a turn that is
  part of an unbroken, still-active tool-use chain reaching the end of
  history must be a byte-exact signed replay, or the request is permanently
  rejected — encoded directly in this codebase as a hard `throw` in
  [`dropUnsignedThinkingFromAssistantMessages`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1148-L1217).
- **Gemini**: forgiving. No client-side signature enforcement was found
  anywhere in the Gemini content-generator path.
- **DeepSeek**: no signature validation at all. Unsigned thinking immediately
  before a tool call is normal, valid wire shape —
  [`injectEmptyThinkingOnToolUseTurns`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1238-L1270)
  synthesizes an empty-signature placeholder specifically because DeepSeek
  undecodable signature falls back to a plain assistant message rather than
  guessing.

PR #8260 fixed a chain of four bugs where the live streaming path could leave
an **unsigned trailing thought episode** — a reasoning episode whose stream
was cut before its terminating signature-only chunk arrived (SSE drop,
MAX_TOKENS) — sitting in the same eventual wire message as a `functionCall`.
Once a `tool_result` for that call lands, Anthropic's replay rule permanently
wedges the session. This document states the invariant precisely and
inventories **every** place in the codebase that mutates `Content[]`/`Part[]`
history after a content generator originally produced it, so the invariant's
blast radius is explicit rather than rediscovered one bug at a time.

## The invariant, stated once

> For every `Content` entry with `role: 'model'` that contains, or later
> becomes adjacent (in the same eventual wire message) to, both a `Part` with
> `thought: true` and a `Part` with a `functionCall`, if that turn is or
> becomes part of an **active tool-use chain** at request-build time, then
> every `thought`-flagged part in it must carry a non-empty
> `thoughtSignature` that is byte-identical to what the provider originally
> emitted for that reasoning span.

"Active tool-use chain" is not a property of one `Content` entry in
isolation — it is this codebase's own operational definition, implemented as
a backward walk from the tail of the outgoing message list
([`converter.ts:1167-1186`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1167-L1186)):
consume trailing `user` messages, checking whether any carries a
`tool_result`; if the message before that run is an `assistant` message with
`tool_use`, mark it active and continue; the walk terminates the instant it
hits a `user` run with no `tool_result`, or a non-`tool_use` assistant turn.
Two corollaries follow directly from this definition and matter for the
inventory below:

1. **Wire-message adjacency, not `Content`-array adjacency, is what creates
   the hazard.** The Anthropic converter's
   [`mergeConsecutiveAssistantMessages`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1405-L1448)
   collapses **consecutive** `role: 'model'` `Content` entries (no `user`
   entry between them) into a single wire message, concatenating blocks in
   original order with no thinking-awareness. Its own doc comment
   ([`converter.ts:1379-1385`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1379-L1385))
   explicitly names _"streaming chunk-level recording, max_tokens recovery,
   or adaptive thinking splits"_ as producers of exactly this consecutive
   shape. A mutation site that leaves two `Content` entries adjacent — one
   ending in an unsigned thought, the next starting with (or containing) a
   `functionCall` — recreates the hazard just as surely as putting both in
   one `Content.parts` array would, one pipeline stage downstream of where
   an auditor looking only at `geminiChat.ts` would think to check.
2. **A signature-less thought part is not universally invalid.** It is
   DeepSeek's normal, complete wire shape. Any fix in this area must
   distinguish "truncated mid-episode" (hazardous) from "a provider that
   doesn't sign thinking" (normal) using only the shape of the array — this
   is why the live-path fix
   ([`dropDanglingUnsignedTrailingThought`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L1045-L1054))
   is trailing-position-only, not a whole-array scan — a whole-array scan was
   tried during PR #8260's review and reverted after it broke DeepSeek's test
   suite.

## Mutation-site inventory

| #   | Site                                                                                    | Location                                                                                                                                                                                                                                                                                                                                                       | Preserves the invariant?                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Live per-stream consolidation                                                           | [`geminiChat.ts:4760`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L4760) (call), [`:1045`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L1045-L1054) (def)                                               | **Yes**, as of `f907a0f5c`                                                                                                                                                                   |
| 2   | MAX_TOKENS recovery-coalescing                                                          | [`geminiChat.ts:5097-5139`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L5097-L5139) (`coalesceRecoveryPairs`), guard at [`:5126-5131`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L5126-L5131)         | **Yes, in memory only — never reaches the on-disk JSONL** (see §Site 2)                                                                                                                      |
| 3   | Session resume / JSONL→`Content[]` reconstruction                                       | [`sessionService.ts:2171-2251`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/sessionService.ts#L2171-L2251), reached from [`client.ts:429-441`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/client.ts#L429-L441)                  | **No — BUG.** Full trace in the companion document, [`2026-08-04-resume-jsonl-reasoning-divergence.md`](./2026-08-04-resume-jsonl-reasoning-divergence.md)                                   |
| 4   | Orphaned-tool-use repair (resume-adjacent)                                              | [`geminiChat.ts:1669-1704`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L1669-L1704) (`repairOrphanedToolUseTurns`)                                                                                                                                                                 | **Yes, by not touching the field** — but see the companion document's 'hazard shape (Race B)', where this repair actively re-activates a tool-use chain around an untouched dangling thought |
| 5   | Anthropic converter request-building pipeline                                           | [`converter.ts:262-335`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L262-L335)                                                                                                                                                                            | **Yes, per-request** — this is the last line of defense against every upstream gap, but is **disabled for native Anthropic base URLs** (see below)                                           |
| 6   | Chat compaction                                                                         | [`chatCompressionService.ts`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/chatCompressionService.ts), [`postCompactAttachments.ts:772-854`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/postCompactAttachments.ts#L772-L854) | **Partial — a real, previously-undocumented gap.** See below                                                                                                                                 |
| 7   | History-editing utilities (`setHistory`, `truncateHistory`, `stripThoughtsFromHistory`) | [`geminiChat.ts:4253-4287`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L4253-L4287)                                                                                                                                                                                                | `setHistory`/`truncateHistory` **inherit** whatever they're given; `stripThoughtsFromHistory` is safe by wholesale elimination                                                               |
| 8   | Rewind (two independent implementations, contradictory policies)                        | `packages/cli/src/ui/AppContainer.tsx` (interactive) vs. [`Session.ts:2243-2244`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/cli/src/acp-integration/session/Session.ts#L2243-L2244) (ACP/VSCode)                                                                                                              | **Contested — see "A currently-live contradiction" below**                                                                                                                                   |
| 9   | Tool scheduler call/result pairing                                                      | `packages/core/src/core/coreToolScheduler.ts`, `packages/cli/src/ui/hooks/useGeminiStream.ts`                                                                                                                                                                                                                                                                  | **Yes, by not touching the field**                                                                                                                                                           |
| 10  | Managed-memory microcompaction                                                          | `packages/core/src/services/microcompaction/microcompact.ts`                                                                                                                                                                                                                                                                                                   | **Yes, by not touching the field** — operates on `functionResponse` payloads only                                                                                                            |
| 11  | Fork/subagent history seeding, ACP history replay, background-agent transcript recovery | `packages/core/src/agents/runtime/`, `packages/core/src/agents/background-agent-resume.ts`, `packages/cli/src/acp-integration/session/history-replay-page.ts`                                                                                                                                                                                                  | **Uncertain — flagged, not traced to the same depth**                                                                                                                                        |

### Site 1 — Live per-stream consolidation

[`dropDanglingUnsignedTrailingThought`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L1045-L1054):

```ts
function dropDanglingUnsignedTrailingThought(
  parts: Part[],
  hasToolCall: boolean,
): void {
  if (!hasToolCall) return;
  const lastPart = parts[parts.length - 1];
  if (lastPart?.thought && lastPart.text && !lastPart.thoughtSignature) {
    parts.pop();
  }
}
```

Called once per stream, immediately after the final `flushThoughtEpisode()`
call, gated on that stream's own `hasToolCall`. Deliberately **trailing-only,
not whole-array**: a stream's own truncation can only ever leave the dangling
episode as the trailing element, so restricting to "trailing" is what
distinguishes "truncated mid-episode" from DeepSeek's legitimate
unsigned-thinking-before-`tool_use` shape. This same array reference is what
[`recordAssistantTurn`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L4963)
persists to JSONL, so the strip happens **before** the write for this
particular record shape. **Invariant holds.**

**Known, documented, accepted residual risk**: a non-compliant proxy that
drops a signature on a _non-trailing_ episode within a single stream (a
genuine wire-protocol violation, not a truncation) is indistinguishable from
DeepSeek's normal shape and is not caught here — this is an intentional
trade-off, stated in the code's own comments, not an oversight.

### Site 2 — MAX_TOKENS recovery-coalescing: fixed in memory, but the fix never reaches disk

This is the site PR #8260's final commit closed for the **live** path — and
the site whose on-disk counterpart is this doc's most significant finding.

The `MAX_TOKENS` recovery loop only proceeds when the truncated turn has
**no** `functionCall` of its own — exactly the precondition under which Site
1's `hasToolCall` was `false` and never fired for that specific record. If
the recovery **continuation** then calls a tool, [`coalesceRecoveryPairs`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L5097-L5139)
re-runs the same trailing-only check on the truncated turn's parts
**immediately before** merging in the continuation:

```ts
// f907a0f5c:geminiChat.ts:5126-5135
if (precedingModel.parts) {
  dropDanglingUnsignedTrailingThought(
    precedingModel.parts,
    (modelContinuation.parts ?? []).some((p) => p.functionCall),
  );
}
precedingModel.parts = appendRecoveryContinuationParts(
  precedingModel.parts,
  modelContinuation.parts,
);
```

Re-running the check **before**, not after, the merge is load-bearing:
`appendRecoveryContinuationParts`'s dedup anchor only inspects the last
plain-text part and is blind to `thought` parts, so post-merge the dangling
episode is no longer the trailing element and this check would miss it
entirely.

**This mutation is in-memory only.** `coalesceRecoveryPairs` mutates
`this.history` and never calls back into `chatRecordingService`.
[`recordAssistantTurn`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/geminiChat.ts#L3809)
already wrote the truncated turn — dangling unsigned thought and all — to
JSONL, chronologically **before** the recovery continuation that triggers
this guard even exists. Nothing ever revisits that JSONL record. **This is
precisely the mechanism the companion resume document traces to a confirmed
BUG**: the on-disk transcript for the exact turn shape PR #8260 was written
to fix is never itself fixed, and `--resume` reconstructs the pre-fix shape
from it.

### Site 3 — Session resume: see companion document

Full trace, all four reviewers' independent verdicts, and the corrected
mechanism are in [`2026-08-04-resume-jsonl-reasoning-divergence.md`](./2026-08-04-resume-jsonl-reasoning-divergence.md).
Summary for this inventory: `buildApiHistoryFromConversation` and
`appendApiHistoryRecord` load every JSONL record's `Content` verbatim. The
only `thought`-aware seam in the resume path is
`buildApiHistoryFromConversation`'s `stripThoughtsFromHistory` option
([`sessionService.ts:2119`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/sessionService.ts#L2119)),
which defaults to `false` and has no production caller — so no
dangling-thought consolidation runs on resume in practice. The
synthetic `OUTPUT_RECOVERY_MESSAGE` user turn is never persisted to disk at
all (grep-confirmed: the only `chatRecordingService` calls in `geminiChat.ts`
are `recordChatCompression` and `recordAssistantTurn` — no user-message
record call exists near the recovery message's `self.history.push`), so the
on-disk shape is two directly adjacent `model`-role records, not three. On
resume, `mergeConsecutiveAssistantMessages` — which runs _before_ the
signature guard — merges those two records into one wire message containing
both the unsigned thought and the later `functionCall`, exactly reproducing
the hazard PR #8260 fixed for the live path. **Verdict: BUG**, unanimous
across all four independent reviewers after correction.

### Site 4 — Orphaned-tool-use repair

`repairOrphanedToolUseTurns` only reads/writes `functionCall`/
`functionResponse`-shaped parts; no code path in it reads or writes
`part.thought` or `part.thoughtSignature`. **Invariant holds by
construction** for the field itself — but this repair is exactly what
reactivates a dangling-thought turn's tool-use chain in the resume scenario's
"Race B" (crash after `tool_use`, before `functionResponse`) — see the
companion document's "A second hazard shape (Race B)".

### Site 5 — Anthropic converter pipeline: the last line of defense, and its blind spot

The converter's guard,
[`dropUnsignedThinkingFromAssistantMessages`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/converter.ts#L1148-L1217),
is the only provider-side defense against every upstream mutation-site gap in
this document. It is gated by `dropUnsignedAssistantThinking`, computed at
[`anthropicContentGenerator.ts:736-740`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts#L736-L740):

```ts
const dropUnsignedAssistantThinking =
  !isDeepSeek &&
  !!thinking &&
  this.modelSupportsAdaptiveThinking() &&
  !isAnthropicNativeBaseUrl(this.contentGeneratorConfig);
```

**This is explicitly disabled for native Anthropic base URLs.** This means
every gap in this inventory is not equally dangerous across backends:
proxy-routed Anthropic-compatible adaptive-thinking backends get a
controlled, diagnostic `throw`; native Anthropic users get the malformed
request shipped straight to the wire, and — per Anthropic's own documented
replay contract — a raw 400 directly from Anthropic's API, with none of this
codebase's diagnostics.

### Site 6 — Chat compaction: a real, previously-undocumented gap

`ChatCompressionService.compress()` is documented as "Claude-Code-style
full-history compression": the entire curated history is summarized and the
post-compact history rebuilt from scratch via
[`composePostCompactHistory`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/core/src/services/postCompactAttachments.ts#L772-L854) —
summary + model ack + recent restores + (conditionally) the pre-compaction
history's **trailing** `model`+`functionCall` turn, so a pending
`functionResponse` still has a matching call. Two branches treat that
trailing turn very differently:

```ts
// postCompactAttachments.ts:833-839 — "with attachments" branch
out.push({ role: 'model', parts: ackParts });
out.push({ role: 'user', parts: postAckParts });
if (trailingFc) out.push(trailingFc);   // entire Content, incl. any thought parts, preserved

// postCompactAttachments.ts:840-848 — "no attachments" fold branch
} else if (trailingFc) {
  const fcParts = (trailingFc.parts ?? []).filter((p) => !!p.functionCall);
  out.push({ role: 'model', parts: [...ackParts, ...fcParts] });   // thought parts DROPPED
}
```

The **with-attachments branch is a pass-through, not an enforcement point**
— it copies whatever invariant state the trailing turn was already in,
signed or not, byte-exact. If the trailing turn were ever the Site-2 hazard
shape at the moment compaction ran, this branch would copy that hazardous
`Content` verbatim into the new compacted history's last turn — and, via the
`chat_compression` checkpoint that future `--resume` calls rebuild from,
that hazard would become the **permanent base state** for every future
resume of the session. No live exploit of this was found at `f907a0f5c` (it
requires Site 2's guard to fail or be bypassed first), but Site 6 offers
**zero independent defense** — the invariant holds here only as an inherited
property of clean input, not because this site checks anything.

The **fold branch** unconditionally drops every part except `functionCall`,
including any validly signed thinking block still needed by manual
(non-adaptive) thinking mode's requirement that a tool-use continuation
begin with a thinking block. This is not a wire-contract violation (Anthropic
allows a tool_use turn with no thinking block at all — the rule is "if you
have thinking, it must be exact," not "you must have thinking") but it is a
**real, silent reasoning-fidelity loss** in the same family as the
philosophical problem #8533 describes: a provider-agnostic layer discarding
an Anthropic-specific opaque replay credential because the layer has no
concept that the part it's dropping is special.

### Site 8 — A currently-live, dated, internally contradictory policy on rewind

Independent archaeology (see "Is this problem inherent to Gemini, or a
retrofit?" below) surfaced a concrete, currently-live instance of this same
invariant being handled two different ways nine days apart, in two different
code paths, with no cross-reference between them:

- [`2f1b52d3d`](https://github.com/QwenLM/qwen-code/commit/2f1b52d3d32827b78c0341491fd07c7c6ac2c8c0)
  (2026-04-30, "preserve `reasoning_content` in rewind, compression, and
  merge paths") **removed** the strip-thoughts-on-rewind call from the
  interactive double-ESC `/rewind` handler, with an explicit comment: _"Do
  NOT strip thought parts — reasoning models (e.g. DeepSeek) require
  `reasoning_content` continuity across all turns in the conversation."_
- Nine days later, [`825502742`](https://github.com/QwenLM/qwen-code/commit/8255027426e0b84a4038de6bb1d2d2dd730dc938)
  (2026-05-09, "add message edit/rewind... UI") added a **second,
  independent** rewind implementation for the ACP/VSCode path
  ([`Session.ts:2243-2244`](https://github.com/QwenLM/qwen-code/blob/f907a0f5c13cf5de1ad5c442b5ecefa6dceedb8e/packages/cli/src/acp-integration/session/Session.ts#L2243-L2244),
  confirmed still live today) that calls `chat.truncateHistory(...)`
  immediately followed by `chat.stripThoughtsFromHistory()` — silently
  reintroducing the exact behavior the first commit had just removed, with
  no reference to that decision.

Two rewind paths in the same repository, touching the same invariant, nine
days apart, with opposite policies — this is not merely historical churn; it
is the clearest available evidence that multi-provider reasoning-content
handling in this codebase is **contested and not centrally reconciled**,
today, not just historically.

## Is this problem inherent to Gemini's design, or a retrofit?

Traced against the actual upstream `google-gemini/gemini-cli` repository and
the `@google/genai` SDK changelog, not asserted:

- The SDK's own changelog states `thought_signature` was added at version
  **1.3.0 (2025-05-30)**, described purely as _"store the signature for
  thoughts"_ — zero replay-contract or cross-provider language.
- gemini-cli's own first reaction, three days later
  ([`8563e46ad`](https://github.com/google-gemini/gemini-cli/commit/8563e46ad), "React to Gemini API break - Thought Inclusion"),
  was to **discard** all thought content from consolidated history outright
  (`continue` in the loop) — the simplest possible policy, viable only
  because there was never a second provider that might need that content
  replayed later.
- gemini-cli has **zero** non-Gemini provider code today. `grep -ril
"anthropic\|deepseek"` at `ac42fb0a24` returns exactly two files, and
  neither is provider code: a third-party license notice
  (`packages/vscode-ide-companion/NOTICES.txt`) and a chat-session test
  fixture (`memory-tests/large-chat-session.json`). Its `AuthType` enum is
  correspondingly Google-family across all six members
  (`LOGIN_WITH_GOOGLE`/`USE_GEMINI`/`USE_VERTEX_AI`/`LEGACY_CLOUD_SHELL`/`COMPUTE_ADC`/`GATEWAY`).
- qwen-code's Anthropic provider was founded by `b931d28f3` (2025-12-24) —
  **208 days (nearly seven months) after** the field existed as a Gemini-internal
  accounting detail, and its subsequent history is a documented, multi-round,
  still-visibly-unsettled struggle to decide when reasoning content must
  survive a history mutation (`f7733cfc7` → `93cbad24b` → `d09c19c0c` →
  `2f1b52d3d` → `825502742`, five commits over three weeks, the last of
  which silently reverses the fourth — see Site 8 above).

**Conclusion: `thought`/`thoughtSignature` was designed and shipped as a
Gemini-native accounting mechanism with no multi-provider or strict-replay
intent. qwen-code's multi-provider work on top of it is a genuine retrofit
that has not yet converged on a single, consistent policy** — this doc's
mutation-site inventory is evidence of that same unsettled state at the
code level, not a claim made in the abstract.

## Prior art: how `opencode` handles the same problem

`opencode` ([`anomalyco/opencode`](https://github.com/anomalyco/opencode),
formerly `sst/opencode`) is a comparable multi-provider coding-agent project
facing the identical structural question — one shared internal message
representation across Gemini, Anthropic, OpenAI, and others, each with
incompatible reasoning-replay contracts. Its newer native `@opencode-ai/llm`
package (an Effect-TS rewrite, still gated behind an experimental flag and
coexisting with a legacy Vercel-AI-SDK-direct path) makes a **narrower, more
deliberate version of the same one-shape choice** qwen-code made, with one
structural difference worth naming precisely.

**It does have one closed, shared union type across every provider** —
[`ContentPart`](https://github.com/anomalyco/opencode/blob/aefaf140c19e25494da27739ae979f31b8cfe474/packages/llm/src/schema/messages.ts#L177-L180)
(`TextPart | MediaPart | ToolCallPart | ToolResultPart | ReasoningPart`) —
the same species of design as `Content[]`/`Part[]`, not a fundamentally
different architecture. **But no provider-specific replay token is ever a
field on that shared union.** Every member that needs provider round-trip
state carries an optional
[`providerMetadata: Record<providerNamespace, Record<string, unknown>>`](https://github.com/anomalyco/opencode/blob/aefaf140c19e25494da27739ae979f31b8cfe474/packages/schema/src/llm.ts#L6-L8)
bag — four of the five at this commit; `MediaPart`
([`messages.ts:34-40`](https://github.com/anomalyco/opencode/blob/aefaf140c19e25494da27739ae979f31b8cfe474/packages/llm/src/schema/messages.ts#L34-L40))
is the exception and has no such field. Each protocol adapter reads and
writes only its own namespaced key at the point of wire encoding — never a
shared boolean+string pair:

- Anthropic's signature:
  [`providerMetadata.anthropic.signature`](https://github.com/anomalyco/opencode/blob/aefaf140c19e25494da27739ae979f31b8cfe474/packages/llm/src/protocols/anthropic-messages.ts#L255-L258)
- Gemini's `thoughtSignature`: `providerMetadata.google.thoughtSignature`
  (`packages/llm/src/protocols/gemini.ts:193-197,239`)
- OpenAI's reasoning item id and encrypted content:
  `providerMetadata.openai.{itemId, reasoningEncryptedContent}`
  (`packages/llm/src/protocols/openai-responses.ts:283-297`)

This is a direct application of the Vercel AI SDK's own
`providerOptions`/`providerMetadata` convention (confirmed present, under
the same namespacing pattern, even on opencode's legacy AI-SDK-direct
path — `packages/opencode/src/provider/transform.ts:183`), and the design
choice is stated explicitly, not just observable from the types
([`packages/llm/DESIGN.md:806-826`](https://github.com/anomalyco/opencode/blob/aefaf140c19e25494da27739ae979f31b8cfe474/packages/llm/DESIGN.md#L806-L826)):

> "Normalized message/content/event unions remain closed and exhaustive.
> Unknown or provider-required round-trip data lives in caller-writable
> `providerMetadata`... Protocols validate metadata they consume. The field
> is an escape hatch, not a portable semantic guarantee."

**This does not mean opencode is immune to this bug class — it is direct
evidence the bug class is inherent to the problem, not to any one
representation.** Three pieces of evidence, all independently verified:

1. **The exact same failure mode, fixed on an unmerged branch as recently as
   2026-07-16.** [`origin/reasoning-replay@b6208a8c50`](https://github.com/anomalyco/opencode/commit/b6208a8c508d8c28b918c34d3a8fc7ebdcb914dd)
   ("fix(core): preserve compatible reasoning replay") fixes exactly
   qwen-code's shape of bug: before the fix, an unsigned reasoning part was
   still unconditionally lowered into an Anthropic
   `{ type: "thinking", signature: undefined }` block; after, every affected
   protocol (`anthropic-messages.ts`, `bedrock-converse.ts`, `gemini.ts`,
   `openai-responses.ts`) checks for a real signature first and downgrades
   to a plain text block if none is found — diffed directly:
   ```diff
   if (part.type === "reasoning") {
   +  const signature = part.encrypted ?? signatureFromMetadata(part.providerMetadata)
   +  if (!signature) {
   +    content.push({ type: "text", text: part.text })
   +    continue
   +  }
      content.push({
        type: "thinking",
        thinking: part.text,
   -    signature: part.encrypted ?? signatureFromMetadata(part.providerMetadata),
   +    signature,
      })
     continue
   }
   ```
   The same commit **moved the compatibility decision out of a single
   centralized `sameModel` gate** in session-history-to-request projection
   (`packages/core/src/session/runner/to-llm-message.ts`) and pushed it down
   into each protocol's own lowering step — the previous design decided
   "keep as reasoning vs. downgrade to text" once, centrally, based on
   whether the model changed; the new design always emits a reasoning part
   and lets the protocol that actually knows its own replay contract decide
   at the last possible moment. The repo's own architecture-invariants file
   was updated in the same commit to match
   ([`CONTEXT.md`](https://github.com/anomalyco/opencode/commit/b6208a8c508d8c28b918c34d3a8fc7ebdcb914dd) diff):
   from _"non-empty visible reasoning lowers to ordinary assistant text
   after a model switch"_ to _"protocols that require signed native
   reasoning lower unsigned reasoning to ordinary assistant text"_ — the
   same "push the decision to the point where the contract is actually
   known" lesson this document's mutation-site inventory argues for.
2. **A same-minute patch/revert/delete sequence** on 2026-06-03: a narrow
   fix, [`42173bca4b`](https://github.com/anomalyco/opencode/commit/42173bca4ba2f2c5e7faba827e1ade8a2a1b4b0a)
   (04:33:48 UTC, "preserve signed thinking during anthropic reorder"), was
   reverted 17 seconds later
   ([`a763a14d44`](https://github.com/anomalyco/opencode/commit/a763a14d44d894c54c6199bb171ca711d1e0ca24),
   04:34:05 UTC), followed 31 seconds after that by deleting the entire
   tool-reorder mechanism the patch had been trying to fix around
   ([`5940304098`](https://github.com/anomalyco/opencode/commit/59403040987137a367f259884766efc363725c39),
   04:34:36 UTC) — a real "we tried patching X, then decided the underlying
   hack shouldn't exist" transition, the same category of decision this
   document declines to make lightly for qwen-code's own mutation sites.
3. **A field-name migration that silently dropped signatures until
   patched** ([`61390dbb49`](https://github.com/anomalyco/opencode/commit/61390dbb49), #28678) — `native-request.ts` read only the
   legacy `providerOptions` field and silently ignored data already
   migrated to the new `providerMetadata` field name, until patched to
   check both. Confirms that even a namespaced-bag design is not immune to
   silent data loss across a refactor — it relocates the risk, it doesn't
   eliminate it.

**Reading for #8533's discussion questions**: opencode's `providerMetadata`
pattern is a concrete example of the "incremental, additive layer" solution
direction sketched in #8533 — a typed side-channel attached to existing
parts, validated per-protocol at the point of use, rather than a structural
change to the shared message type. It is evidence _for_ that direction being
viable (a real, shipping — if still experimental — codebase uses it), while
also being evidence that adopting it would not make this problem
disappear, only relocate where it has to be gotten right, and that even a
well-namespaced escape hatch still requires the same discipline
(per-protocol validation, careful handling across refactors) qwen-code's own
mutation-site inventory argues for.

## Cross-reference: issue #8533

This audit is a narrower, code-grounded companion to
[#8533](https://github.com/QwenLM/qwen-code/issues/8533)'s broader question:
whether `Content[]`/`Part[]` — a shape designed around Gemini's comparatively
forgiving replay contract — can keep absorbing point fixes for Anthropic's
much stricter contract, or whether the number and subtlety of mutation sites
found here (a fully-fixed live path, an in-memory fix that never reaches
disk, a confirmed resume-time bug, a compaction gap, and a currently-live
contradictory policy on rewind) is itself evidence that the representation
mismatch needs an architectural answer rather than another targeted patch.
This document does not take a position on that question; it exists to make
the current mutation-site surface area legible to whoever does.
