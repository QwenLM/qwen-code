# Native Memory Recall Reliability

## Problem

Managed-memory recall starts asynchronously for each user query. The initial
request currently performs a zero-wait consume, so a useful selector result can
miss the first prompt because of incidental scheduling. If the turn has no tool
call, that result has no later safe delivery point.

The model selector remains the normal precision gate. Its failure fallback has
two independent correctness problems: it tokenizes only ASCII text and gives
every non-empty document a positive score even without a lexical match.

## Decision

Keep the existing single-result recall lifecycle and model-primary selection.

- Give user-query recall a fixed 100 ms initial wait budget.
- Deliver a result that settles inside the budget in the initial prompt.
- If the budget expires, leave recall pending for the existing same-query
  ToolResult delivery point.
- Do not abort recall or run heuristic fallback merely because the initial
  budget expires.
- Preserve the existing cancellation and exactly-once terminal telemetry paths.

The 100 ms budget stays internal. It leaves margin under the RFC's 150 ms
initial-turn overhead target while telemetry can show whether a later change is
justified.

Improve only the existing failure fallback:

- normalize query and document text with Unicode NFKC;
- keep ASCII alphanumeric tokens of at least three characters;
- generate Unicode code-point bigrams for Han, Hiragana, Katakana, and Hangul
  runs;
- ignore isolated CJK characters;
- require a title, description, or body lexical match before applying a type
  boost;
- weight title and description matches above body-only matches.

## Non-goals

- No Fast/Refined two-stage architecture.
- No public recall timing or retrieval-mode setting.
- No new tokenizer or retrieval dependency.
- No change to memory writes, scopes, extraction, DREAM, forget, or compaction.
- No removal of the shared scanner's 200-document cap. Recall-specific broad
  candidate selection needs its own bounded manifest design and remains a
  separate change.

## Verification

- Recall settling inside the budget is delivered initially.
- A deadline miss leaves recall alive for later ToolResult delivery.
- Cancellation ends the bounded wait and prevents stale delivery.
- Slow recall is released by the fixed-budget timer before the initial request.
- A labeled set covers Chinese, English, Japanese, Korean, mixed text,
  NFKC normalization, body-only matches, and no-result queries.
- Existing active-tool noise filtering and model-selector fallback behavior
  remain unchanged.
