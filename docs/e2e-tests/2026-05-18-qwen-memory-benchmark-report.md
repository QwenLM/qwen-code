# Qwen Code Runtime Memory Benchmark Report

Date: 2026-05-18

## Summary

This report records local memory benchmarks for Qwen Code runtime behavior. It
compares Qwen Code across models and compares Qwen Code with Claude Code on the
same task shapes where equivalent model endpoints were available.

The headline result is consistent across the latest matrix (single run per cell,
not statistically repeated):

- Qwen Code process-tree RSS peak: about `852-1062 MiB` (`0.83-1.04 GiB`).
- Claude Code process-tree RSS peak: about `279-366 MiB` (`0.27-0.36 GiB`).
- Qwen Code was about `2.3x-3.6x` higher in the tested
  non-interactive CLI task benchmarks.

Note: process-tree RSS includes MCP child processes (~350 MiB overhead on the
Qwen side). This inflates the absolute numbers but the relative comparison
remains informative since both CLIs were measured the same way.

The difference reproduced in small PR review, code navigation, and synthetic
diff workloads. It is therefore unlikely to be explained only by one large PR
or by one model provider.

This report is intended to make the current performance investigation visible:
what has been measured, what conclusion is already supported, what remains
unknown, and what diagnostics should be added next.

## Test Environment

| Item                                          | Value                                      |
| --------------------------------------------- | ------------------------------------------ |
| Date                                          | 2026-05-18                                 |
| Platform                                      | macOS local development machine            |
| Qwen Code version                             | `0.15.11`                                  |
| Qwen Code binary                              | PATH-resolved `qwen` binary                |
| Claude Code version used in the latest matrix | `2.1.129`                                  |
| Claude Code binary used in the latest matrix  | PATH-resolved `claude` binary              |
| Node.js version                               | v22.x (default system install)             |
| Sampling method                               | External `ps` RSS sampling once per second |
| Headline metric                               | Process-tree RSS peak                      |

Process-tree RSS is used as the headline metric because Qwen Code launches a
root wrapper and a child Node/Qwen worker. Looking only at the root process can
understate the memory footprint seen by users.

Temporary CLI config directories were used for matrix runs so the benchmarks
did not depend on global CLI state.

## Benchmark Artifacts

Five local reports were produced before this consolidated report:

1. Qwen Code PR review memory run.
2. Qwen Code model comparison run.
3. Strict Qwen Code vs Claude Code comparison with `pai/glm-5`.
4. Qwen Code vs Claude Code, two CLIs by two models.
5. Qwen Code vs Claude Code, five-case matrix.

This consolidated report covers the conclusions and headline metrics from all
five reports. It does not embed every raw sample row, terminal transcript, or
temporary runner artifact. Those raw artifacts stayed in local `tmp/`
directories because they are experiment outputs rather than stable repository
fixtures.

The latest matrix is the strongest evidence because it covers multiple task
shapes rather than only one PR review workload.

## Preliminary Conclusion

The current data is strong enough to say that Qwen Code has a higher runtime
memory footprint than Claude Code in these local non-interactive CLI task
benchmarks. It is not strong enough to name one final root cause yet.

The leading explanation is a Qwen Code runtime/path difference rather than a
model provider difference:

- the gap reproduces with both `pai/glm-5` and `qwen3.6-plus`;
- the gap reproduces in small PR and code-navigation tasks, not only in large
  diff tasks;
- Qwen Code repeatedly sends or accounts for more tokens than Claude Code for
  similar work;
- Qwen Code's largest observed component is the child Node/Qwen worker process,
  which points toward task-time process footprint, module loading, context
  assembly, live history, tool-result retention, or subagent/saved-output
  paths.

The most useful next measurement is therefore not another external RSS-only
run. The next measurement should split RSS into V8 heap, native memory,
session/history size, retained tool-result size, and subagent/process-tree
activity.

## Initial Cause Analysis

The benchmark does not yet prove one root cause, but it does narrow the likely
problem area.

| Signal                                                                                       | What it suggests                                                                           | What it does not prove                                                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Qwen remains near `1 GiB` in small PR and code-navigation cases                              | A high non-interactive task-time runtime cost is likely involved                           | It does not identify whether the footprint is V8 heap, native memory, module loading, or retained state |
| Diff size from 100 KiB to 5 MiB does not scale linearly with RSS                             | Raw diff bytes alone are probably not the primary driver                                   | Large outputs can still amplify memory in real PR review flows                                          |
| Qwen uses more tokens than Claude in every matrix cell                                       | Qwen likely constructs or retains larger prompt/context/tool-result state for similar work | Token count is not the same as process memory and may be an effect rather than the cause                |
| Tool call counts are similar, and Claude sometimes uses more turns/tool calls with lower RSS | A longer tool-call chain is unlikely to be the main explanation by itself                  | Tool output size and retention still need to be measured                                                |
| Earlier large PR runs showed saved-output recovery and subagent amplification                | Tool-output truncation and saved-output paths are likely heavy-workload amplifiers         | They do not explain the entire small-task execution footprint                                           |

The current best explanation is therefore:

1. **Task-time runtime cost first**: Qwen Code likely initializes or retains
   more runtime state during non-interactive CLI task execution than Claude
   Code. This may include agent runtime, tool registry, provider adapters,
   session services, or UI/history structures that are not strictly needed for
   a short non-interactive task.
2. **Context/tool-result volume second**: Qwen Code appears to carry larger
   model-facing or session-facing context for similar work. The token gap makes
   context assembly, tool result normalization, and history retention important
   suspects.
3. **Large-output amplification third**: Large PR review can trigger additional
   saved-output and subagent paths. These are probably not the only cause, but
   they can make memory and token pressure worse in realistic review tasks.

The next diagnostic run should answer where the `~1 GiB` sits:

- high immediately after startup: module/runtime startup cost;
- jumps after tool execution: tool-output retention or result normalization;
- jumps during request assembly: context construction or duplicated histories;
- grows after streaming/compression: response retention or compression state;
- mostly RSS outside V8 heap: native buffers, loaded modules, or external
  memory.

## Latest Matrix

The latest benchmark ran:

- 2 CLIs: Qwen Code and Claude Code.
- 2 model labels: `pai/glm-5` and `qwen3.6-plus`.
- 5 cases:
  - small PR review: PR `#4268`, one-line change
  - code navigation: `rg` plus `sed` on compression-related files
  - synthetic local diff, about 100 KiB
  - synthetic local diff, about 1 MiB
  - synthetic local diff, about 5 MiB

All 20 runs exited `0` with no timeout.

## Matrix Results

| Case             | Model          | Qwen tree peak | Claude tree peak | Qwen / Claude |
| ---------------- | -------------- | -------------: | ---------------: | ------------: |
| small PR `#4268` | `pai/glm-5`    |     1032.7 MiB |        357.8 MiB |         2.89x |
| small PR `#4268` | `qwen3.6-plus` |      852.2 MiB |        365.5 MiB |         2.33x |
| code navigation  | `pai/glm-5`    |      993.1 MiB |        359.6 MiB |         2.76x |
| code navigation  | `qwen3.6-plus` |      996.9 MiB |        349.0 MiB |         2.86x |
| diff 100 KiB     | `pai/glm-5`    |     1012.1 MiB |        350.8 MiB |         2.89x |
| diff 100 KiB     | `qwen3.6-plus` |     1001.1 MiB |        336.2 MiB |         2.98x |
| diff 1 MiB       | `pai/glm-5`    |     1008.3 MiB |        278.8 MiB |         3.62x |
| diff 1 MiB       | `qwen3.6-plus` |     1003.3 MiB |        340.5 MiB |         2.95x |
| diff 5 MiB       | `pai/glm-5`    |      858.8 MiB |        323.2 MiB |         2.66x |
| diff 5 MiB       | `qwen3.6-plus` |     1062.0 MiB |        331.2 MiB |         3.21x |

Average process-tree RSS peak by case:

| Case             | Avg Qwen tree peak | Avg Claude tree peak |
| ---------------- | -----------------: | -------------------: |
| small PR `#4268` |          942.5 MiB |            361.6 MiB |
| code navigation  |          995.0 MiB |            354.3 MiB |
| diff 100 KiB     |         1006.6 MiB |            343.5 MiB |
| diff 1 MiB       |         1005.8 MiB |            309.6 MiB |
| diff 5 MiB       |          960.4 MiB |            327.2 MiB |

## Runtime And Token Signals

The same matrix also showed Qwen Code using more model-side tokens in every
tested case.

Selected examples:

| Case            | Model          | CLI    | Duration | Turns | Total tokens | Tool calls |
| --------------- | -------------- | ------ | -------: | ----: | -----------: | ---------: |
| small PR        | `pai/glm-5`    | Qwen   |    25.2s |     2 |       32,567 |          3 |
| small PR        | `pai/glm-5`    | Claude |    21.1s |     4 |        7,899 |          3 |
| code navigation | `qwen3.6-plus` | Qwen   |    25.2s |     2 |       38,151 |          3 |
| code navigation | `qwen3.6-plus` | Claude |    46.9s |     6 |       25,861 |          5 |
| diff 100 KiB    | `qwen3.6-plus` | Qwen   |    16.5s |     3 |       57,185 |          2 |
| diff 100 KiB    | `qwen3.6-plus` | Claude |    17.2s |     3 |        6,377 |          2 |
| diff 5 MiB      | `pai/glm-5`    | Qwen   |    23.2s |     2 |       38,574 |          2 |
| diff 5 MiB      | `pai/glm-5`    | Claude |     9.8s |     3 |        5,285 |          2 |

This token gap does not prove that token volume is the memory root cause, but it
does suggest that context assembly, tool result retention, or response
normalization should be measured alongside RSS and V8 heap statistics.

## Token Usage Analysis

The token gap is one of the strongest clues, but it needs internal request
metrics before it can be treated as a root cause.

What the data supports today:

- Qwen Code used more total tokens than Claude Code in every matrix cell.
- The gap appears even when tool-call counts are similar.
- Claude sometimes used more turns or tool calls while still using less memory.

What this suggests:

- The token delta is unlikely to come only from a longer tool-call chain.
- Qwen may be carrying larger static prompt/context state, larger tool schemas,
  larger serialized tool results, or more retained conversation/session content.
- Large-output flows may add another layer through truncation, saved-output
  recovery, or subagent paths.

What is still missing:

- per-request input token breakdown;
- system prompt and tool schema token sizes;
- retained message and tool-result sizes before each model request;
- whether large outputs are retained in multiple places, such as model history,
  UI history, session recording, or saved-output storage.

Those missing metrics are why the next step should add internal diagnostics
rather than only repeat the external RSS benchmark.

## Earlier Large PR Review Signal

An earlier strict PR review benchmark used PR `#4186` and showed the same broad
shape:

| Model          | CLI         | Process-tree RSS peak |
| -------------- | ----------- | --------------------: |
| `pai/glm-5`    | Qwen Code   |            1000.7 MiB |
| `pai/glm-5`    | Claude Code |             349.0 MiB |
| `qwen3.6-plus` | Qwen Code   |            1095.8 MiB |
| `qwen3.6-plus` | Claude Code |             341.1 MiB |

That earlier run was not enough by itself because a large PR can trigger unusual
tool-output and saved-output paths. The latest five-case matrix makes the
finding stronger because small PR and code-navigation tasks also reproduce the
gap.

## Working Hypothesis

The current evidence supports these hypotheses, in priority order:

1. Qwen Code has a higher non-interactive task-time process footprint than
   Claude Code. The Qwen child Node worker was typically the largest process in
   local sampling, often around `0.7-0.8 GiB`.
2. Model choice is not the main explanation. Both `pai/glm-5` and
   `qwen3.6-plus` showed the same broad Qwen-vs-Claude gap.
3. Large diff size alone is not the main explanation. The synthetic diff size
   did not scale linearly from 100 KiB to 5 MiB, likely because tool-output
   truncation caps how much output reaches the model.
4. Context/tool-result handling is still a likely contributor. Qwen Code used
   more tokens than Claude Code in every matrix cell, and earlier large-PR runs
   showed saved tool-output recovery and subagent amplification paths.
5. The next diagnostic layer should separate V8 heap, native RSS, loaded
   module/runtime startup cost, session history, UI history, tool-result
   retention, and subagent activity. External RSS alone cannot distinguish
   those causes.

## Caveats

- These are single runs per matrix cell, not repeated statistical samples.
- RSS is external process RSS. It cannot distinguish V8 heap, native buffers,
  module loading, retained tool output, UI state, or session history.
- Claude Code and Qwen Code use different runtime implementations and protocol
  adapters, even when the model labels are the same.
- The benchmark was run locally on macOS. Linux servers should be tested before
  drawing deployment-specific conclusions.

## Recommended Follow-Up Measurements

The next local investigation branch should add or use diagnostics for:

- `process.memoryUsage()` before and after startup, tool execution, streaming,
  compression, and session finalization.
- V8 heap statistics and heap spaces.
- Active handles and requests.
- Session message count and approximate retained character/token volume.
- Tool result count, total retained tool-result size, largest tool-result size,
  and whether large outputs are retained by UI history or model history.
- Subagent count and child process/process-tree RSS.
- Tool-output truncation and saved-output recovery events.

These measurements should be collected with the same benchmark matrix so the
current RSS comparison can be connected to internal Qwen Code state.
