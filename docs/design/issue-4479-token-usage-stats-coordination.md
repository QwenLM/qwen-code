# Issue #4479 token usage stats coordination

## Context

Issue #4479 asks for daily Qwen Code token-consumption visibility. The scope was
clarified in the issue thread to prefer a CLI command, export support, monthly
summaries, and per-model token consumption. A maintainer comment also called out
coordination with adjacent statistics work:

- #4252: generation timing metrics in `/stats` such as TTFT, generation duration,
  and TPS.
- #4182: content-free session-scale counters for memory diagnostics.

## Coordination decisions

1. **Use `/stats`, not a new top-level command.**
   Token usage is exposed as `/stats daily`, `/stats monthly`, and
   `/stats export` so it shares the existing statistics command surface with
   session stats and future generation metrics.

2. **Persist token counters as local JSONL.**
   Each API response appends one content-free record to
   `usage/token-usage-YYYY-MM.jsonl` under the runtime directory. This satisfies
   daily/monthly aggregation without adding SQLite as a new dependency.

3. **Keep #4252 timing semantics separate.**
   Token usage summaries may include `apiDurationMs`, which is the existing
   end-to-end API response duration from telemetry. It is deliberately named as
   API duration and must not be presented as generation duration, TTFT, or TPS.
   #4252 remains the owner for generation timing metrics.

4. **Keep #4182 privacy and memory-diagnostic boundaries.**
   Usage records store aggregate counters and stable dimensions only: local date,
   month, session id, model, auth type, source, token counters, and API duration.
   They do not store prompt text, response text, tool content, project paths,
   prompt ids, or response ids.

5. **Export remains aggregate-only.**
   CSV and JSON exports are summaries, not raw transcript exports. They group by
   total, model, auth type, model/auth type, and source.

## Non-goals

- Do not implement #4252's TTFT/TPS/generation-duration instrumentation here.
- Do not extend `/doctor memory` or implement #4182 in this change.
- Do not add a separate token-usage top-level slash command.
