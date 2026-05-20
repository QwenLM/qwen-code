# Qwen Code Runtime Memory Investigation Plan

Date: 2026-05-18

## Context

Local benchmarks show Qwen Code using substantially more process-tree RSS than
Claude Code for similar non-interactive CLI task shapes. The latest five-case
matrix found Qwen Code peaking around `0.83-1.04 GiB` while Claude Code stayed
around `0.27-0.36 GiB`.

This document proposes a draft investigation and optimization direction. It is
not intended to claim a final root cause yet. The immediate goal is to make the
memory gap reviewable, reproducible, and explainable with internal diagnostics.

## Progress So Far

The investigation has reached the evidence-and-direction stage:

- A repeatable local matrix has been built for small PR review, code navigation,
  and synthetic diff workloads.
- Qwen Code has been compared across multiple models.
- Qwen Code and Claude Code have been compared on the same task shapes where
  equivalent model endpoints were available.
- The observed RSS gap is consistent enough to justify deeper runtime
  diagnostics.
- Related upstream work has been mapped so this effort can build on existing
  `/doctor memory` and memory-diagnostics follow-ups.

The investigation has not yet reached the final root-cause stage because
external process RSS cannot show whether the retained memory is V8 heap, native
memory, loaded modules, live history, tool results, or request assembly state.

## Current Evidence

The companion benchmark report is:

- `docs/e2e-tests/2026-05-18-qwen-memory-benchmark-report.md`

The main evidence is:

- The Qwen-vs-Claude RSS gap reproduced across small PR review, code
  navigation, and synthetic diff workloads.
- The gap reproduced with both `pai/glm-5` and `qwen3.6-plus`.
- Qwen Code used more tokens than Claude Code in every tested matrix cell.
- Large diff size did not produce a clean linear memory increase, which suggests
  the baseline and bounded/truncated output paths matter more than raw diff
  bytes alone.

## Related Work

Relevant upstream work already exists:

| Item    | Status                | Role in the memory work                                                                                         |
| ------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `#4180` | merged PR             | Adds baseline `/doctor memory` diagnostics. This is the first instrumentation slice.                            |
| `#4181` | open issue, no PR yet | Adds interpretation and pressure classification for `/doctor memory`.                                           |
| `#4182` | open issue, no PR yet | Adds structured `/doctor memory --json` output and safe session-scale stats.                                    |
| `#4183` | open issue, no PR yet | Adds opt-in heap snapshots and bounded memory timeline diagnostics.                                             |
| `#4184` | open issue, no PR yet | Adds large tool-result retention diagnostics and designs offload/preview mitigation.                            |
| `#4127` | open PR, conflicting  | Adds heap-pressure safety nets for long-session OOM prevention. Useful mitigation, not enough for attribution.  |
| `#4168` | open PR               | Redesigns auto-compaction thresholds. Useful for context pressure, not enough for task-time footprint analysis. |
| `#4172` | open PR               | Decouples auto-memory recall from the main request path. Useful for latency/blocking, not direct RSS proof.     |
| `#4188` | merged PR             | Bounds build/test caches to prevent OOM in parallel test runs. Important but separate from runtime benchmarks.  |

This investigation should build on that direction rather than wait for all
follow-up issues to land.

Most of the remaining work is instrumentation-first. The open diagnostics
issues are designed to make memory reports explainable before attempting a
runtime fix. The open mitigation PRs may reduce specific OOM paths, but they do
not yet explain why short non-interactive CLI tasks repeatedly peak near
`1 GiB`.

## Why This Draft Starts With Documentation

This draft intentionally starts with benchmark evidence and an investigation
plan instead of bundling a runtime code change.

Reasons:

1. The current goal is to make the performance problem and direction visible,
   not to claim a same-day fix.
2. Adding instrumentation and optimization in the same PR would make review
   harder because it mixes measurement, diagnosis, and behavior changes.
3. The existing benchmark already supports the need for deeper diagnostics.
4. The next PR can be narrower and easier to validate: diagnostics-only, then
   rerun the same matrix and compare internal metrics.

The next implementation PR should add the missing counters and timeline points,
then rerun the benchmark matrix. Only after that should a targeted optimization
PR attempt to reduce memory.

## Working Inference

The current data points toward a Qwen Code runtime/path issue more than a model
provider issue.

The strongest current inference is:

> Qwen Code appears to carry a high non-interactive CLI task execution
> footprint, likely amplified by larger context/tool-result/session handling.
> The likely problem area is the CLI runtime and agent data path, not the
> selected model alone.

More specifically, the evidence points away from "too many tool calls" as the
primary cause. Tool-call counts were similar across CLIs, and Claude sometimes
used more turns or tool calls while keeping lower RSS. The more plausible
problem is that Qwen Code initializes or retains heavier state for the same
short non-interactive CLI task, then amplifies that execution footprint with
larger context, tool-result, saved-output, or session-history data.

The most likely buckets are:

1. **Process and module startup/execution cost**: Qwen Code may initialize more
   runtime, tools, UI/session infrastructure, or provider machinery than needed
   for non-interactive CLI tasks.
2. **History and context assembly**: Qwen Code may retain or construct larger
   model-facing context than Claude Code for the same task shape.
3. **Tool-result retention**: large or repeated tool results may be retained in
   live history, UI history, chat recording, or saved-output recovery paths.
4. **Subagent and saved-output amplification**: previous large PR tests showed
   saved-output recovery and subagent activity, which can add memory and token
   pressure.
5. **MCP child processes**: the companion diagnostics report revealed that MCP
   servers (e.g. chrome-devtools) contribute ~350 MiB to process-tree RSS. This
   inflates the absolute numbers but is a constant overhead unrelated to session
   length.
6. **Native memory versus JS heap split**: external RSS cannot tell whether the
   pressure is V8 heap, native buffers, loaded modules, or retained data.

This is deliberately phrased as an inference. The next step is to add enough
internal measurements to confirm or rule out each bucket.

## Proposed Draft PR Scope

The first draft PR should be evidence and diagnostics focused:

1. Commit the benchmark report and investigation plan.
2. Add or extend local diagnostic output so Qwen Code can report:
   - V8 heap and heap-space statistics.
   - RSS versus heap split.
   - session message count and approximate retained size.
   - tool result count, total retained size, and largest retained result size.
   - truncation and saved-output recovery counters.
   - subagent/process-tree activity when available.
3. Re-run the existing matrix against:
   - current published Qwen Code,
   - current `main`,
   - diagnostics-only branch,
   - candidate optimization branch.
4. Use those measurements to choose one small optimization target.

The first PR should avoid mixing several unrelated optimizations. It should
either remain documentation-only or add diagnostics-only code. A separate PR
should carry the first runtime memory reduction once the cause is clearer.

## Candidate Optimization Directions

These are candidates, not conclusions:

1. **Bounded tool-output retention**: store large output out of the hot path and
   keep only preview, metadata, and retrieval pointers in live history.
2. **Non-interactive lazy loading**: avoid initializing TUI-only or
   interactive-only subsystems during non-interactive CLI task execution.
3. **Session/UI history caps**: degrade old or heavy history items into compact
   transcript entries.
4. **Context assembly accounting**: measure and cap large tool results before
   model request construction.
5. **Subagent accounting**: expose subagent lifecycle and memory impact in
   diagnostics.

Claude Code and OpenAI Codex (OpenAI's CLI coding agent) should be used as
design references for diagnostic separation, bounded output retention, and lazy
history loading. The implementation should still follow Qwen Code's own
architecture and tests.

## Validation Plan

The investigation should keep the same benchmark matrix so before/after results
remain comparable:

- small PR review
- code navigation
- synthetic diff about 100 KiB
- synthetic diff about 1 MiB
- synthetic diff about 5 MiB

For each run, record:

- process-tree RSS peak
- root process RSS peak
- V8 heap peak
- heap-space summary
- duration
- turns
- token count
- tool call count
- largest retained tool result
- total retained tool-result size
- session/history item counts
- subagent count

The minimum success condition for a candidate fix is not just "RSS went down".
It should also identify which internal metric changed and why.

## Next PR Candidate

The next PR should be diagnostics-only and should avoid changing runtime
behavior. A minimal useful slice would add:

- model request input-size accounting;
- system prompt and tool schema size accounting;
- retained message count and approximate retained character size;
- retained tool-result count, total size, and largest item size;
- lifecycle samples around startup, first request assembly, tool execution,
  streaming completion, compression, and final response;
- process memory samples that include RSS, heap used, heap total, external, and
  heap-space stats.

After that lands locally, rerun the same Qwen model matrix and compare:

- published Qwen Code;
- current `main`;
- diagnostics-only branch;
- candidate optimization branch.

## Non-Goals

This draft does not claim that:

- all memory pressure is caused by tool output;
- one existing open PR will solve the observed task-time footprint;
- model provider differences are irrelevant in every environment;
- single-run local measurements are sufficient for release-level performance
  claims.

The intended claim is narrower: Qwen Code shows a consistent local RSS gap in
the tested workloads, and the project needs internal diagnostics to explain and
reduce that gap.
