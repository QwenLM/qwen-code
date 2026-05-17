# Compaction Image Stripping + Token Estimation Fix

## Problem Statement

When `ChatCompressionService` triggers (auto or manual), it ships
`historyToCompress` to the summary model verbatim. Two related issues
degrade quality, accuracy, and cost:

1. **Inline image / document bytes leak into the summary prompt.**
   MCP tools that surface attachments (screenshots, design mockups,
   PDFs) place `inlineData` parts directly into the conversation. The
   compression pipeline does not strip them, so the summary model
   receives raw base64 it usually cannot interpret, and the side-query
   payload is needlessly inflated.

2. **`findCompressSplitPoint` token estimation is wrong for binary
   parts.** The split-point algorithm uses
   `JSON.stringify(content).length` to apportion chars across the
   history. A single 1 MB base64 image (~1.4 M chars) makes one entry
   look like ~350 K tokens, dwarfing actual text and biasing the cut
   toward the wrong place. The real token cost for a Qwen-VL image is
   at most a few thousand tokens. The estimator should treat binary
   parts as a small constant.

claude-code addresses (1) with `stripImagesFromMessages`. qwen-code has
neither this strip nor the corresponding char-counting fix.

This change adds both, scoped to the **compaction side-query input
only**. The live conversation history, persistence
(`chats/<sessionId>.jsonl`), and the prompt sent to the main model on
the next turn are untouched. Slimming applies only to the side-query
payload built inside `chatCompressionService`.

### Out of scope (deferred or rejected)

- **Large-paste externalization to a paste cache.** An earlier draft
  of this design proposed hashing oversize text into
  `~/.qwen/paste-cache/<sha>.txt` and substituting a placeholder. We
  rejected it after surveying claude-code's 2026-03 to 2026-05
  releases: the upstream direction is to keep user input visible to
  the model and amortize cost via prompt caching (1h TTL knobs, image
  downscaling) rather than externalize it. Putting verbatim user input
  behind a hash placeholder risks "intent drift" once compaction has
  collapsed the original text away. If we revisit this later, the
  right pattern is `read_paste(hash)` as a real tool the model can
  reach for, not silent rewriting.

## Current State vs Target

| Concern                          | qwen-code today                                      | claude-code reference                                            | Target after this change                                            |
| -------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Image/document in compact prompt | Sent verbatim                                        | `stripImagesFromMessages` replaces with `[image]` / `[document]` | Sent as `[image: mime]` / `[document: mime]` placeholder            |
| Binary part token estimation     | `JSON.stringify().length` (wildly off)               | Treated as fixed budget                                          | Configurable constant (default 1,600 tokens / ~6,400 chars)         |
| Microcompact image cleanup       | Not touched (only text tool results cleared on idle) | Time-based MC clears all                                         | Microcompact also clears stale inline images alongside tool results |

## Proposed Changes

### Layer 1: compaction input slimming (`services/compactionInputSlimming.ts`)

A new pure module that takes `Content[]` and returns a slimmed
`Content[]`. One transform: inline-media stripping. Walk every `Part`.
If the part has `inlineData` or `fileData` replace it with a `text`
part of form `[image: image/png]` (or `[document: application/pdf]`).

qwen-code attaches tool-returned media on `functionResponse.parts`
(an extension over the standard `@google/genai` `FunctionResponse`
schema; see `coreToolScheduler.createFunctionResponsePart`). The
slimmer recurses into that nested array so a base64 image returned by
`read_file` or any MCP attachment-emitting tool is also replaced.

The transform returns a fresh `Content[]` array; the original is never
mutated. If the transform produces zero changes the original array
reference is returned (identity-equal). The orchestrator calls
`slimCompactionInput` as the last step before `runSideQuery` in
`chatCompressionService.ts`.

### Layer 2: token estimation fix (`chatCompressionService.ts`)

`findCompressSplitPoint` currently uses `JSON.stringify(content).length`
for char-count apportionment. Replace this with an
`estimateContentChars` helper that:

- For `text` parts: `text.length`
- For `inlineData` / `fileData` parts: `imageTokenEstimate * 4` (default
  1,600 × 4 = 6,400 chars).
- For `functionCall` / `functionResponse` parts:
  `JSON.stringify(part).length` (unchanged behavior).

This is the same constant the slimming module uses, so the budget the
split-point algorithm sees matches what the slimmed prompt actually
consumes downstream. To avoid duplicate walks, `compress()` precomputes
`charCounts` once and passes them to `findCompressSplitPoint` (new
optional 4th argument); the same array is reused for the
`MIN_COMPRESSION_FRACTION` guard.

### Layer 3: microcompact image cleanup (`microcompaction/microcompact.ts`)

`collectCompactablePartRefs` now returns three groups:

- `tool` — `functionResponse` parts from compactable built-in tools.
  Cleared as a unit: response output replaced with the sentinel,
  `functionResponse.parts` dropped along with it.
- `media` — top-level `inlineData` / `fileData` parts under user-role
  messages (e.g. images pasted via `@reference`). Replaced with
  `[Old inline media cleared: <mime>]`.
- `nested-media` — `functionResponse` parts from **non-compactable**
  tools (e.g. MCP screenshot tools whose names are not in
  `COMPACTABLE_TOOLS`) that carry images / documents on the
  `functionResponse.parts` extension field. Only the nested media is
  dropped; the tool's text output is preserved.

Each kind has its own `keepRecent` budget. Setting
`toolResultsNumToKeep: 1` keeps the most recent of each category
(1 tool + 1 media + 1 nested-media), not 1 entry total across the
combined list.

mimeType values surfaced from MCP tool servers are passed through
`sanitizeMimeForPlaceholder` before being embedded in any placeholder
string. The slimmer and microcompact share this helper.

### Layer 4: configuration (`config/config.ts`)

One new field under `chatCompression` settings:

```json
{
  "chatCompression": {
    "contextPercentageThreshold": 0.7,
    "imageTokenEstimate": 1600
  }
}
```

Plus an env override for ops/debug: `QWEN_IMAGE_TOKEN_ESTIMATE`.

## Key Design Decisions

**Decision 1: `imageTokenEstimate = 1600`.**
Qwen-VL family caps at 1,280 visual tokens per image without
`vl_high_resolution_images`; with that flag, up to 16,384. 1,600 is a
conservative middle ground biased slightly high — overestimating leads
to earlier compaction (safe), underestimating leads to late compaction
(unsafe). For non-VL models (Qwen3-Coder, the qwen-code default) the
constant only matters for token-estimation correctness, since images
do not reach the model anyway.

**Decision 2: Strip the slimmed copy, not the live history.**
`slimCompactionInput` returns a fresh array; the chat history stored
in `GeminiChat` is untouched. Local persistence
(`.chats/<sessionId>.jsonl`) keeps the full conversation as the user
experienced it, so `--resume` works without loss.

**Decision 3: Microcompact treats images uniformly with old tool
results.** The time-based idle trigger already clears stale tool
output; extending it to inline images keeps the policy consistent and
reuses the existing keepRecent window.

**Decision 4: No paste-store / no text externalization.**
See Out-of-scope section. Upstream consensus (claude-code 2026-03 →
2026-05) is to keep verbatim user input visible and amortize via
prompt caching, not externalize.

## Files Affected

**New files**

- `packages/core/src/services/compactionInputSlimming.ts`
- `packages/core/src/services/compactionInputSlimming.test.ts`

**Modified files**

- `packages/core/src/config/config.ts` — extend `ChatCompressionSettings`
- `packages/core/src/services/chatCompressionService.ts` — call slimming
  before `runSideQuery`; replace char-count helper; precompute charCounts
  once for splitter + guard
- `packages/core/src/services/chatCompressionService.test.ts` — add a
  wire-up test asserting base64 never reaches the summary model
- `packages/core/src/services/microcompaction/microcompact.ts` — extend
  collection to inline images
- `packages/core/src/services/microcompaction/microcompact.test.ts` —
  test image clearing

## Scope Boundaries

**In scope**

- Strip inline media from compaction input
- Fix `findCompressSplitPoint` char estimation
- Microcompact image part cleanup on the idle trigger
- One setting + env override

**Deferred**

- Large-paste externalization (see Out-of-scope above)
- Reinflation tool (`read_paste(hash)` etc.)
- Persistence-layer dedup
- `/context` paste breakdown
- Telemetry events for slim stats

## Open Questions

1. **Should the placeholder text include a hash to allow future
   reinflation?** Today we emit just `[image: image/png]`. If/when a
   `read_paste`-style tool lands, we may want an ID. For now the
   placeholder is informational; the original image still exists in
   the live history and persistence.
2. **`imageTokenEstimate = 1600` correct for non-Qwen-VL models served
   via Anthropic / OpenAI proxies?** Likely a slight under-estimate
   for Claude (where images can be up to ~5K tokens) but harmless: it
   only affects the split-point heuristic, never the actual prompt
   the user-facing model sees.
3. **`MIN_COMPRESSION_FRACTION` gate is computed on pre-slim char
   counts.** An image-heavy slice can pass the 5% threshold (because
   images count as ~6,400 chars each in the estimator) and then
   shrink to `[image: …]` placeholders post-slim. The summary model
   then receives almost no textual context. This is intentional for
   now: the summary's job is to record "user shared an image of X"
   even when most of the slice was visual, and the gate's purpose is
   "is there enough to be worth summarizing" — which images
   reasonably satisfy. If quality regresses we can revisit by either
   re-checking post-slim or biasing the gate on
   `imagesStripped` proportion.
