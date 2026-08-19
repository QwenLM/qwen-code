# Tool Output Offload/Preview: State Transitions and Privacy Model

> Design note required by [#4184](https://github.com/QwenLM/qwen-code/issues/4184)
> (acceptance criterion: "A design note documents the offload/preview state
> transition and privacy model"). Mitigation implemented in #4880; retention
> diagnostics added in the accompanying `/doctor memory` change.

## 1. Problem

In long sessions, OOM risk comes from oversized tool outputs being retained in
conversation history and taxing every later turn, and from duplicate copies of
history during compression — not just from traditional leaks. The goal is to
keep structured metadata and a bounded preview in the hot path, persist large
payloads out of it, and make diagnostics show where memory is retained.

## 2. State Transitions

A tool output moves through the following states before it can enter
conversation history:

```mermaid
graph TB
    A[Raw tool output] --> S{Already truncated? (prefix, marker, or stub)}
    S -- yes --> J[Metadata appended after truncation, never bisected]
    S -- no --> G{Persistence gate: over configured threshold + 3k headroom, and not exempt?}
    G -- yes --> F[Full payload persisted to session temp file, mode 0o600]
    G -- no --> B{Per-tool budget declared?}
    B -- yes --> C[Scheduler per-tool bound, e.g. grep 20k]
    B -- no --> D[Scheduler gate: global threshold 25k chars + 1000 lines]
    C --> H[Enters history as-is]
    D --> H
    F --> I2[History retains preview + metadata + read_file pointer]
    I2 --> I[Model recovers full output on demand via read_file]
    H --> J
    I2 --> J
    J -->|non-sentinel body| K{Assembled string over 2x budget?}
    J -->|sentinel body (skip)| M[Per-message batch budget 200k across parallel calls]
    K -- yes --> L[Second pass bounds it once more]
    K -- no --> M
    L --> M
    M --> N[Final tool result recorded in history]
```

Key properties:

- **Persistence gate first** (for tools without in-tool truncation).
  `maybePersistLargeToolResult` runs before the scheduler's per-tool/global
  truncation: any non-exempt result over the configured threshold + 3k headroom
  (default 28k) is persisted and stubbed to a preview right away. Exempt:
  `read_file`, `read_mcp_resource`, `enter_plan_mode` (self-managed).
  Shell output over 30k and MCP output over 500k truncate in-tool during
  `execute()` before the gate sees the result; the sentinel check at entry
  then routes them past the gate. Results below those in-tool thresholds
  pass through the gate normally. Consequently, per-tool budgets above 28k
  (agent 32k, web-search 102k) are second-level bounds — the gate offloads
  first.
- **Bounded before history.** Every layer acts before the result is recorded,
  so history never holds an unbounded payload.
- **Recoverable, never dropped.** Oversized output is persisted to a session
  temp file: the gate writes `tool-results/<callId>.txt`, while in-tool
  truncation (shell, MCP) writes `~/.qwen/tmp/<project-hash>/<tool>_<hex>.output`.
  The retained preview carries a pointer; the model can read the full payload
  back with `read_file`. Truncation keeps head and tail (`keep: 'both'`)
  because shell failure summaries appear at the end.
- **Re-entrancy guard.** A truncated result carries a sentinel — either the
  `TOOL_OUTPUT_TRUNCATED_PREFIX` at the start, the `... [CONTENT TRUNCATED] ...`
  marker within, or a `<persisted-output>` stub prefix. Later passes detect
  any of these and skip re-truncation, so truncation headers never nest.
- **Metadata integrity.** PostToolUse/skill metadata and system reminders are
  appended only after the raw body is bounded, then the assembled string is
  re-checked against a doubled budget — unless the body already carries the
  truncation sentinel (re-entrancy skip), in which case only the batch budget
  bounds it.
- **Batch-level bound.** After all parallel calls in one message complete, the
  aggregate is reduced to `toolOutputBatchBudget` (default 200k chars) by
  offloading the largest results — covering the case where many individually
  legal results explode together.

## 3. Thresholds

| Layer            | Budget                                                                                                  | Configurable                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Persistence gate | configured threshold + 3k headroom (default 28k); exempt: read_file, read_mcp_resource, enter_plan_mode | `settings.tools.truncateToolOutputThreshold`                             |
| Per-tool         | shell 30k, grep 20k, mcp 500k, agent 32k/tail, web-search 102k, read-file self-managed                  | No (declared by tool)                                                    |
| Global           | 25k chars + 1000 lines                                                                                  | `settings.tools.truncateToolOutputThreshold` / `truncateToolOutputLines` |
| Combined pass    | 2x of the applicable budget                                                                             | No                                                                       |
| Per-message      | 200k chars                                                                                              | `settings.tools.toolOutputBatchBudget`                                   |
| Disk persistence | 50MB per file, 500MB per session                                                                        | No                                                                       |

Per-tool budgets are char-only: when a tool declares one, the global line cap
is disabled for it so self-managed paging (read-file) and char budgets (grep)
are not silently undercut.

## 4. Privacy Model

Maps directly to the non-goals in #4184:

| Non-goal                                                | Enforcement                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do not upload tool results                              | Offload target is a local file under the session temp dir only; no network path exists in the truncation code                                                     |
| Do not include private content in diagnostics           | `/doctor memory` retention section reports sizes and counts only, never content; safe to paste in bug reports (also in `--json`)                                  |
| Do not silently drop data without a retrievable pointer | Oversized payloads are persisted with a preview + `read_file` pointer; if persistence is impossible (see below), the bounded preview still explains what happened |
| Owner-only artifacts                                    | Persisted files are written with mode `0o600`; the shared temp directory itself is not loosened                                                                   |

Disk persistence failure modes (all fail toward bounded memory, never toward
unbounded retention or data exposure):

- Output larger than 50MB: persistence skipped, in-memory truncation still
  bounds the result.
- Session budget (500MB) exhausted: persistence skipped, same in-memory bound.
- Truncation/IO error: the successful tool call is never demoted to an error.
  On a primary persist failure, the code falls back to `truncateAndSaveToFile`
  into the project temp dir — the full payload is retained with a `read_file`
  pointer. Only if the fallback also fails is the result degraded to a
  pointerless bounded preview with a warning logged.

## 5. Diagnostics (phase 1 signals)

`/doctor memory` now reports, live and by reference (no history clone):

- Tool results in history, total retained chars, largest result. Sizes reuse
  the compression pipeline's `estimatePartChars` model with the same
  `imageTokenEstimate` (resolved via `resolveSlimmingConfig` from env >
  settings > default), so diagnostics and compression agree about the same
  history: string outputs are measured as raw chars (no JSON-escaping
  inflation) and nested media parts are billed at the image token estimate.
- Oversized results, counted against each result's own tool budget (resolved
  from the tool registry by canonicalized `functionResponse.name`, mirroring
  the scheduler; tools declaring none fall back to the configured global
  threshold). Results already carrying a truncation sentinel (prefix or
  `<persisted-output>` stub) are skipped — a layer bounded them — and the remaining results are only flagged beyond the combined-pass 2x
  tolerance plus a small envelope slack, matching the headroom the scheduler
  itself allows. A retained result past that bound means a truncation layer
  was bypassed — the counter doubles as a regression alarm.
- Whether oversized outputs are also rendered in UI history (scanned in
  `tool_group` items' `resultDisplay`, compared per display against the same
  per-tool budget — UI history stores display names, not registry keys, so a
  display-name → budget map is built from the tool registry at scan time) and
  in compression input (yes by construction, but compression reads history by
  reference via `getHistoryShallow`, so no extra copy is held). Phase-1 scope:
  only string `resultDisplay` values are measured; structured display objects
  (file diffs, ANSI captures, agent result summaries) carry their own
  rendering contracts and are not char-comparable in the same way — they are
  left for a follow-up PR.

## 6. Alternatives Considered

- **Summarize instead of truncate.** Adds a model round-trip on the hot path
  and complicates the privacy model; the pointer-based recovery achieves the
  same goal deterministically.
- **Lazy-load history from disk.** Changes the conversation contract and
  provider payload shape; the preview + pointer keeps the contract intact.
