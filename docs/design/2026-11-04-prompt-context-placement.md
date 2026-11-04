# Prompt Context Placement

[English](2026-11-04-prompt-context-placement.md) | [简体中文](2026-11-04-prompt-context-placement.zh-CN.md)

**Status:** Implemented

**Issue:** [#16259](https://github.com/QwenLM/qwen-code/issues/16259)

## Problem

A user submitted one complete 2461-character task with seven numbered steps.
The model answered "I have not received a specific task yet", and its reasoning
read "The user only provided a system reminder about available skills ... no
specific task."

The instruction reached the provider intact. Its position did not survive
assembly. A fresh turn's user entry is built from independent sources:

1. Per-turn `<system-reminder>` parts, prepended ahead of the prompt (plan mode,
   arena, output style, workflow mode, one-shot notices, recalled memory).
2. The user's own parts.
3. The `<qwen:user-prompt-submit-context>` block carrying hook and Mod context,
   appended after the prompt.
4. The memory catalog snapshot, appended after that.

The real instruction therefore sits mid-entry, with injected context on both
sides. Three independent caps (`MAX_SKILL_LISTING_CHARS = 8000`,
`MAX_INDEX_CHARS = 25_000` per index with two indexes injected, plus unbounded
hook context) let the surrounding blocks reach tens of kilobytes, at which point
a flash-class model reads the envelopes and misses the task.

## Design

Reorder the outgoing request so the user's own text is the last content of the
pending turn. `LlmChat.getRequestHistoryForRoute()` already produces a
request-only copy of history; a new `movePromptContextAheadOfUserText()` pass
runs on that copy, moving the injected run that trails the user's text to just
ahead of it.

Injected parts are recognized as a wrapped `<system-reminder>`, a whole
`<qwen:user-prompt-submit-context>` block, or a part marked
`AUTO_MEMORY_SNAPSHOT_METADATA`. Everything else is the caller's own content and
keeps its relative order.

Only the contiguous injected run after the caller's LAST own part moves. The
pass walks back over a contiguous run of own parts, so a reminder the caller
placed between two of its own parts bounds that run and keeps its position.

Three cases are left untouched:

- Leading `functionResponse` parts. A `tool_result` block must immediately
  follow the model's `tool_use`; Anthropic-compatible backends reject text ahead
  of it.
- A `functionResponse` that is not in the leading run. That position is the
  caller's own ordering, so the entry is returned unchanged rather than hoisting
  the tool result to the front.
- The volatile tail from the first `REATTACH_BOUNDARY_METADATA` marker onward.
  That is one contiguous region — a marker, then a label and an image per
  replayed image — and the provider cache passes count it as trailing blocks to
  place their per-turn breakpoint before it (#11627). Splitting or relocating it
  would anchor the breakpoint on a block no later request contains.

## Design decisions

**Request-only, not history.** The trailing position of the hook block is
load-bearing for stored history. `projectUserTranscriptForDisplay()` treats a
complete final tagged part as pairing evidence for `displayText`, and
`restoreUserPromptSubmitContextReceipt()` re-stamps only the final part on
resume. Reordering the stored entry would break the display projection and
re-deliver already-delivered hook context every turn. Only the request copy
changes, so the transcript, resume, deduplication, and rewind contracts are
untouched.

**One pass at the send boundary, not per producer.** Reminders, hook context,
IDE context and the catalog are injected by different modules on different
frontends (TUI, headless, ACP, the shared agent loop). Fixing the order at the
single point where every main-turn request is assembled covers all of them
without four parallel edits that can drift.

**No budget change.** This addresses position only. The aggregate cap across
injected blocks, moving the catalog off the user tail entirely, and the CJK
token undercount in the always-on-context warning remain separate work
(#16184, #14976).

## Constraints

- A turn whose parts are all tool results, all injected context, or already
  ordered is returned unchanged.
- User-authored text shaped like a reminder is only ever classified within the
  trailing run, so a prompt typed in that shape keeps its own order.
- Side queries (`getRequestHistoryForRoute` without a pending user turn) are
  unaffected.

## Validation

- A multi-part prompt with a leading reminder, a trailing hook block and a
  catalog snapshot is sent as `[reminder, hook, catalog, ...prompt]`, while
  stored history keeps `[reminder, ...prompt, hook, catalog]`.
- A tool-result turn keeps its `functionResponse` first and its reattach region
  (marker, label, image) intact and last.
- A prompt with no injected parts keeps its original part order.
- A reminder the caller placed between two of its own parts stays there; only
  the appended block after the last own part moves.
- Existing catalog budget, deduplication, and cache-boundary assertions still
  hold. Two assertions that pinned the old order were updated: the pending-turn
  check now asserts the catalog is present and the user text is last, and the
  durable-recovery check now asserts the request holds the same entries and
  parts as history with the catalog moved ahead of the recovery prompt.

`packages/core/src/core/llm-chat.test.ts`: 716 passed.

## Open questions

Whether the catalog belongs in the user entry at all, and what aggregate budget
and eviction order the per-turn blocks should share, are tracked separately.
