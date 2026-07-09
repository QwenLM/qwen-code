# Protocol Leak Retry Guard

Status: WIP

Issue: #6595

## Problem

Some long-context `qwen3.7-max` sessions can emit internal protocol-style tags
such as `<analysis>` and `<summary>` in a normal main assistant response. When
that response is treated as ordinary assistant text, it can be recorded into
JSONL, pushed into chat history, and replayed into later prompts.

The primary risk is context contamination. Once the bad response enters history,
future turns and compaction can preserve or amplify the wrong summary-style
mode.

## Proposed Direction

Treat visible protocol tags in normal main assistant text as invalid model
output, not as content to sanitize in place.

The first implementation should:

1. Detect protocol-tag leakage on the main assistant response path before the
   response is recorded or pushed into history.
2. Discard the entire abnormal assistant response when the detector fires.
3. Retry once from the original history before the bad response.
4. Keep any corrective instruction request-only so it does not persist into the
   conversation.
5. Scope the initial guard to pure-text assistant responses to avoid replaying
   tool calls after side-effecting tools may have executed.
6. Leave expected compression side-query behavior unchanged, since compaction
   can intentionally use `<analysis>` as internal scratchpad text.

Compact fallback can be considered after a failed retry, but compaction should
not be the first response because it can lose useful context.

## Validation Plan

- Unit-test protocol leak detection for `<analysis>`, `<summary>`, and related
  internal tags.
- Cover false positives such as fenced code blocks and valid HTML
  `<details><summary>...</summary></details>`.
- Add a stream/retry test where the first response leaks tags and the retry
  succeeds.
- Assert the rejected response is not recorded to JSONL and is not present in
  chat history.
- Assert compression side-query responses are not blocked by the main-turn
  guard.
