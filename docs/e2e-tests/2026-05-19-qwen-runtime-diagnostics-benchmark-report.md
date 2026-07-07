# Qwen Code Runtime Diagnostics Benchmark Report

Date: 2026-05-19

## Scope

This run repeats the previous Qwen Code benchmark shapes with the new opt-in
runtime diagnostics enabled. It only tests Qwen Code, not Claude Code.

Initial model matrix:

- `pai/glm-5`
- `qwen3.6-plus`

Additional PR-size follow-up:

- `DeepSeek/deepseek-v4-pro` through Anthropic-compatible protocol

Cases:

- small GitHub PR review: PR `#4268`
- code navigation: compression / compaction related code search and reads
- synthetic local diff: about 94.6 KiB
- synthetic local diff: about 968.5 KiB
- synthetic local diff: about 4.84 MiB

The run used the local bundled CLI from the diagnostics branch, with
`QWEN_CODE_PROFILE_RUNTIME=1` and a temporary CLI home. Global MCP servers and
hooks were not loaded for this benchmark.

Important caveat: these absolute RSS numbers are lower than the previous
PATH-resolved `qwen` runs because this run used `node dist/cli.js` from the
local branch plus a stripped temporary config. Treat this report as an internal
diagnostics distribution run, not a direct replacement for the earlier installed
CLI RSS comparison.

## Installed CLI vs Local Bundle Sanity Check

A follow-up sanity check used the same minimal prompt, model, and non-interactive
mode across the installed CLI and the local diagnostics bundle. The only
intentional variable was whether Qwen Code loaded a stripped temporary CLI home
or the normal user config.

| CLI                 | Config mode     | Total tokens | Tree RSS peak | Root RSS peak | Process count peak | Runtime diagnostics |
| ------------------- | --------------- | -----------: | ------------: | ------------: | -----------------: | ------------------- |
| PATH `qwen`         | stripped config |       33,965 |     542.4 MiB |     249.9 MiB |                  3 | no                  |
| local `dist/cli.js` | stripped config |       47,281 |     455.2 MiB |     214.2 MiB |                  4 | yes                 |
| PATH `qwen`         | normal config   |       97,615 |   1,099.9 MiB |     250.1 MiB |                  6 | no                  |
| local `dist/cli.js` | normal config   |       97,954 |   1,105.4 MiB |     212.7 MiB |                  8 | yes                 |

This check changes the attribution: the earlier 1 GiB user-visible peak is
reproducible with the normal config even on the local diagnostics bundle. It is
therefore not primarily explained by the local branch including PR `#4186`.

At the normal-config peak, the local process-tree sample was dominated by
multiple Node/MCP processes rather than the Qwen root process alone:

| Role  | Command shape             | RSS at tree peak |
| ----- | ------------------------- | ---------------: |
| child | Node process              |        252.9 MiB |
| child | Chrome DevTools MCP       |        219.7 MiB |
| child | Node process              |        219.2 MiB |
| root  | Qwen Node process         |        215.1 MiB |
| child | Chrome DevTools MCP setup |        175.2 MiB |

PR `#4186` is present in the local diagnostics branch, but it is a V8 heap
pressure auto-compaction safety net. It triggers at about 70% V8 heap pressure;
on this environment the Node heap limit is about 4.1 GiB, while the stripped
benchmark end heap was about 99-143 MiB. Based on these numbers, the lower
stripped-config RSS is not caused by `#4186` actively compressing context during
these benchmark runs.

### Bare Mode Config Attribution Check

A second follow-up used `qwen3.6-plus` with the same PR-review prompt shape on
both the installed CLI and the local bundle. This is not a normal end-to-end
business benchmark. It is a controlled attribution check for startup/config
memory only.

`--bare` changes the runtime inputs: it skips normal global settings discovery,
MCP startup, hooks, implicit context, skills, and other startup integrations. It
can therefore fail or behave differently when a model provider is configured
only in global settings. For this run, model credentials were supplied only
through the child-process environment because bare mode intentionally does not
load the normal provider settings. Nothing was written back to the user's global
config.

This run did not produce useful token/tool-call statistics: the model completed
in one turn and did not call the requested shell command. Do not use these rows
as normal task benchmark results, and do not compare their token/tool-call
behavior with the matrix above. They are only useful for estimating how much
process-tree RSS comes from normal config and configured child processes.

| CLI                 | Mode     | Wall | Turns | Tool uses | Tree RSS peak | Root RSS peak | Process count peak |
| ------------------- | -------- | ---: | ----: | --------: | ------------: | ------------: | -----------------: |
| PATH `qwen`         | normal   | 5.5s |     1 |         0 |   1,021.3 MiB |     251.5 MiB |                  5 |
| PATH `qwen`         | `--bare` | 2.4s |     1 |         0 |     525.7 MiB |     246.4 MiB |                  2 |
| local `dist/cli.js` | normal   | 4.9s |     1 |         0 |   1,046.2 MiB |     213.3 MiB |                  5 |
| local `dist/cli.js` | `--bare` | 2.3s |     1 |         0 |     454.3 MiB |     216.5 MiB |                  3 |

The result confirms the process-tree hypothesis for startup/config attribution.
On this machine, normal config adds roughly 0.50-0.59 GiB of user-visible
process-tree RSS over `--bare`, while root RSS stays in the same 0.21-0.25 GiB
band. At the normal-config peak, the extra RSS again came from additional
Node/MCP child processes, including a Chrome DevTools MCP process and its setup
wrapper. `--bare` removes those startup/config children and brings
installed/local runs back into the 0.45-0.53 GiB tree-RSS range.

### Temporary Settings MCP / Hooks Isolation

Because `--bare` changes too many runtime inputs to be treated as a normal
benchmark, a follow-up used temporary `QWEN_HOME` directories with generated
settings files derived from the normal settings. The run stayed on the normal
settings-loading path, but toggled only two config dimensions:

- MCP disabled: `mcpServers` cleared and MCP allow/exclude lists emptied.
- Hooks disabled: `disableAllHooks` set to true.

No global settings were modified. The case used `qwen3.6-plus` and a minimal
startup prompt, so it measures startup/config process-tree cost, not task
reasoning quality.

| CLI                 | Temporary config     | MCP servers | Tools | Tree RSS peak | Root RSS peak | Process count peak |
| ------------------- | -------------------- | ----------: | ----: | ------------: | ------------: | -----------------: |
| PATH `qwen`         | full                 |           4 |    46 |   1,017.4 MiB |     249.8 MiB |                  5 |
| PATH `qwen`         | MCP disabled         |           0 |    17 |     548.7 MiB |     252.4 MiB |                  2 |
| PATH `qwen`         | hooks disabled       |           4 |    46 |   1,003.8 MiB |     246.4 MiB |                  5 |
| PATH `qwen`         | MCP + hooks disabled |           0 |    17 |     542.5 MiB |     248.0 MiB |                  2 |
| local `dist/cli.js` | full                 |           4 |    48 |     865.9 MiB |     220.4 MiB |                  6 |
| local `dist/cli.js` | MCP disabled         |           0 |    19 |     442.9 MiB |     209.6 MiB |                  2 |
| local `dist/cli.js` | hooks disabled       |           4 |    48 |     848.3 MiB |     212.6 MiB |                  5 |
| local `dist/cli.js` | MCP + hooks disabled |           0 |    19 |     447.2 MiB |     217.8 MiB |                  2 |

Interpretation:

1. Disabling MCP is the dominant change. It removes 4 MCP servers, reduces the
   advertised tool count by about 29 tools, and lowers process-tree RSS by about
   0.42-0.47 GiB in this startup/config case.
2. Disabling hooks alone barely changes RSS in this case. That is expected
   because the prompt did not produce tool calls, so `PreToolUse` /
   `PostToolUse` hooks were not executed.
3. The root process stays around 0.21-0.25 GiB across all rows. The large
   difference is again process-tree composition, not root Qwen RSS.

Two attempted code-navigation follow-ups with `qwen3.6-plus` and `pai/glm-5`
also reproduced the same MCP-vs-no-MCP memory split, but neither model produced
tool calls in those runs. Those rows are therefore not used as hooks execution
evidence. A valid hooks benchmark still needs a task/model combination that
reliably emits tool calls.

### Per-MCP Isolation

The previous row showed MCP as a group is the dominant startup/config memory
factor. A follow-up isolated each configured MCP server while keeping hooks
disabled for all rows. This keeps the test on the normal settings-loading path
but changes only the MCP server subset.

Configured MCP server names:

- `approval-bridge`
- `env-center`
- `chrome-devtools`
- `code`

Single-pass isolation:

| Variant                   | Enabled MCPs                                       | Tools | MCP servers | Tree RSS peak | Root RSS peak | Interpretation                       |
| ------------------------- | -------------------------------------------------- | ----: | ----------: | ------------: | ------------: | ------------------------------------ |
| none                      | none                                               |    19 |           0 |     444.4 MiB |     211.7 MiB | baseline without MCP                 |
| full                      | all 4                                              |    48 |           4 |     857.3 MiB |     215.9 MiB | full MCP startup shape               |
| only `approval-bridge`    | `approval-bridge`                                  |    19 |           1 |     455.5 MiB |     214.0 MiB | near baseline                        |
| only `env-center`         | `env-center`                                       |    19 |           1 |     452.3 MiB |     214.4 MiB | near baseline                        |
| only `chrome-devtools`    | `chrome-devtools`                                  |    48 |           1 |     824.4 MiB |     209.5 MiB | large RSS increase and tool increase |
| only `code`               | `code`                                             |    19 |           1 |     452.1 MiB |     216.6 MiB | near baseline                        |
| without `approval-bridge` | `env-center`, `chrome-devtools`, `code`            |    48 |           3 |     997.1 MiB |     215.4 MiB | still high; run showed variance      |
| without `env-center`      | `approval-bridge`, `chrome-devtools`, `code`       |    48 |           3 |     863.8 MiB |     220.9 MiB | still high                           |
| without `chrome-devtools` | `approval-bridge`, `env-center`, `code`            |    19 |           3 |     463.4 MiB |     221.6 MiB | returns near baseline                |
| without `code`            | `approval-bridge`, `env-center`, `chrome-devtools` |    48 |           3 |     858.1 MiB |     219.5 MiB | still high                           |

Because startup RSS has some variance, the key variants were repeated twice:

| Variant                   | Samples | Tree RSS range      | Avg tree RSS | Result                         |
| ------------------------- | ------: | ------------------- | -----------: | ------------------------------ |
| none                      |       2 | 443.3-451.9 MiB     |    447.6 MiB | stable no-MCP baseline         |
| full                      |       2 | 856.1-922.8 MiB     |    889.5 MiB | stable high-MCP range          |
| only `chrome-devtools`    |       2 | 1,007.1-1,021.2 MiB |  1,014.2 MiB | enough alone to reproduce high |
| without `chrome-devtools` |       2 | 461.1-461.6 MiB     |    461.4 MiB | removes the high RSS           |
| only `approval-bridge`    |       2 | 449.1-449.9 MiB     |    449.5 MiB | near baseline                  |
| only `env-center`         |       2 | 438.7-449.5 MiB     |    444.1 MiB | near baseline                  |
| only `code`               |       2 | 450.6-451.3 MiB     |    451.0 MiB | near baseline                  |

Interpretation:

1. `chrome-devtools` is the dominant MCP contributor in this environment. It is
   sufficient by itself to reproduce the high process-tree RSS.
2. Removing `chrome-devtools` from the full MCP set returns RSS to the no-MCP
   band. Removing other MCPs while keeping `chrome-devtools` does not.
3. The advertised tool count follows the same pattern: baseline is 19 tools,
   while `chrome-devtools` raises the tool count to 48. That means this MCP is
   also likely to increase request tool schema size and token pressure, not just
   process-tree RSS.
4. `approval-bridge`, `env-center`, and `code` individually stay near the
   no-MCP baseline in these startup/config runs. They emitted startup warnings
   in this environment, so this result should be interpreted as "no persistent
   startup RSS owner observed" rather than proof that they have zero cost in all
   workflows.

## Runtime Summary

| Case             | Model          |  Wall | Turns | Total tokens | Tree RSS peak | Root RSS peak |  End heap |   End RSS |
| ---------------- | -------------- | ----: | ----: | -----------: | ------------: | ------------: | --------: | --------: |
| small PR `#4268` | `pai/glm-5`    | 20.1s |     7 |      173,216 |     362.1 MiB |     359.8 MiB | 103.1 MiB | 216.5 MiB |
| code navigation  | `pai/glm-5`    | 18.4s |     2 |       49,127 |     378.0 MiB |     376.0 MiB | 102.4 MiB | 313.4 MiB |
| diff 94.6 KiB    | `pai/glm-5`    | 16.6s |     6 |      135,716 |     367.9 MiB |     366.0 MiB |  99.1 MiB | 295.0 MiB |
| diff 968.5 KiB   | `pai/glm-5`    | 11.4s |     2 |       42,590 |     373.2 MiB |     362.5 MiB | 106.4 MiB | 345.6 MiB |
| diff 4.84 MiB    | `pai/glm-5`    | 12.0s |     4 |       95,119 |     414.2 MiB |     412.0 MiB | 123.6 MiB | 410.7 MiB |
| small PR `#4268` | `qwen3.6-plus` | 35.0s |     6 |      156,556 |     358.9 MiB |     356.9 MiB | 102.6 MiB | 293.1 MiB |
| code navigation  | `qwen3.6-plus` | 28.9s |     4 |       99,800 |     370.3 MiB |     368.3 MiB | 105.8 MiB | 298.2 MiB |
| diff 94.6 KiB    | `qwen3.6-plus` | 28.3s |     4 |       90,808 |     358.8 MiB |     356.9 MiB | 105.9 MiB | 307.0 MiB |
| diff 968.5 KiB   | `qwen3.6-plus` | 30.9s |     6 |      151,782 |     366.1 MiB |     364.1 MiB | 101.0 MiB | 316.9 MiB |
| diff 4.84 MiB    | `qwen3.6-plus` | 24.1s |     4 |       93,271 |     372.8 MiB |     366.0 MiB | 142.8 MiB | 366.0 MiB |

Average by model:

| Model          | Avg tree RSS peak | Avg root RSS peak | Avg turns | Avg total tokens | Avg max wire body | Avg total tool result |
| -------------- | ----------------: | ----------------: | --------: | ---------------: | ----------------: | --------------------: |
| `pai/glm-5`    |         379.1 MiB |         375.3 MiB |       4.2 |           99,154 |         111.8 KiB |             335.1 KiB |
| `qwen3.6-plus` |         365.4 MiB |         362.4 MiB |       4.8 |          118,443 |         119.3 KiB |             344.3 KiB |

Overlapping small PR `#4268` model snapshot:

| Model                      | Protocol  |  Wall | Turns | Total tokens | Tree RSS peak | Root RSS peak | Max wire body |
| -------------------------- | --------- | ----: | ----: | -----------: | ------------: | ------------: | ------------: |
| `pai/glm-5`                | OpenAI    | 20.1s |     7 |      173,216 |     362.1 MiB |     359.8 MiB |     113.8 KiB |
| `qwen3.6-plus`             | OpenAI    | 35.0s |     6 |      156,556 |     358.9 MiB |     356.9 MiB |     134.1 KiB |
| `DeepSeek/deepseek-v4-pro` | Anthropic | 39.7s |     2 |       43,362 |     346.9 MiB |     344.8 MiB |     103.0 KiB |

## Request And Tool Diagnostics

| Case             | Model          | Requests | Max wire body | Max system prompt | Max tool schema | Tool calls | Total tool result | Max tool result | Max function response in request |
| ---------------- | -------------- | -------: | ------------: | ----------------: | --------------: | ---------: | ----------------: | --------------: | -------------------------------: |
| small PR `#4268` | `pai/glm-5`    |        7 |     113.8 KiB |          51.4 KiB |        40.2 KiB |          9 |           4.7 KiB |         3.9 KiB |                         15.3 KiB |
| code navigation  | `pai/glm-5`    |        2 |     114.6 KiB |          51.5 KiB |        40.2 KiB |          3 |          17.5 KiB |         6.2 KiB |                         18.4 KiB |
| diff 94.6 KiB    | `pai/glm-5`    |        6 |     111.2 KiB |          39.1 KiB |        37.2 KiB |          9 |          94.9 KiB |        92.6 KiB |                         29.2 KiB |
| diff 968.5 KiB   | `pai/glm-5`    |        2 |     104.8 KiB |          39.1 KiB |        37.2 KiB |          2 |         772.1 KiB |       771.9 KiB |                         25.6 KiB |
| diff 4.84 MiB    | `pai/glm-5`    |        4 |     114.7 KiB |          39.1 KiB |        37.2 KiB |          4 |         786.3 KiB |       783.2 KiB |                         34.7 KiB |
| small PR `#4268` | `qwen3.6-plus` |        6 |     134.1 KiB |          51.4 KiB |        40.2 KiB |          5 |          34.6 KiB |        15.6 KiB |                         36.6 KiB |
| code navigation  | `qwen3.6-plus` |        4 |     114.9 KiB |          51.5 KiB |        40.2 KiB |          3 |          17.5 KiB |         6.2 KiB |                         18.4 KiB |
| diff 94.6 KiB    | `qwen3.6-plus` |        4 |     112.8 KiB |          39.1 KiB |        37.2 KiB |          3 |          92.9 KiB |        92.6 KiB |                         33.0 KiB |
| diff 968.5 KiB   | `qwen3.6-plus` |        6 |     113.1 KiB |          39.1 KiB |        37.2 KiB |          5 |         778.0 KiB |       771.9 KiB |                         32.1 KiB |
| diff 4.84 MiB    | `qwen3.6-plus` |        4 |     121.5 KiB |          39.1 KiB |        37.2 KiB |          4 |         798.5 KiB |       783.2 KiB |                         41.3 KiB |

## Observations

1. Process-tree RSS is almost the same as root RSS in this local bundle run.
   The root/tree gap is usually below 10 MiB. That means these runs did not
   show a persistent child-process memory owner. The dominant process is the
   main Node process.
2. The local bundle run peaks around 0.36-0.41 GiB, not the earlier
   0.83-1.04 GiB, because the matrix used a stripped temporary config. A
   follow-up normal-config sanity check reproduced about 1.1 GiB tree RSS on
   both PATH `qwen` and local `dist/cli.js`, with the extra memory coming from
   child MCP/Node processes in the process tree.
3. V8 heap is much smaller than RSS. End heap is about 99-143 MiB while end RSS
   is about 216-411 MiB. The remaining footprint is likely loaded modules,
   native allocations, external buffers, or runtime overhead outside live JS
   heap.
4. Static request overhead is large and repeated. The system prompt is about
   39-51 KiB per request, and tool schema is about 37-40 KiB per request. This
   explains why even small tasks can produce high accumulated token counts when
   the model takes several turns.
5. Large diff output is capped before it reaches the model request. The 968 KiB
   and 4.84 MiB diff cases produced around 772-799 KiB of captured tool result,
   but the largest model-facing function response in a request stayed around
   25-41 KiB, and max wire body stayed around 105-122 KiB. This points to
   truncation / saved-output handling working on the model-facing path.
6. Memory still increases on large-output cases even though wire body remains
   bounded. For example, the 4.84 MiB GLM run reached 414.2 MiB tree RSS and
   410.7 MiB end RSS, and the 4.84 MiB qwen3.6-plus run ended with 142.8 MiB
   heap. That suggests large tool output can still affect local capture,
   normalization, or retained runtime state even when the final request payload
   is capped.
7. Model choice changed turns and token totals more than RSS in this run.
   `qwen3.6-plus` averaged more tokens and turns than `pai/glm-5`, but its
   average tree RSS peak was slightly lower. This supports the earlier
   conclusion that model choice is not the main explanation for process memory.

## Updated Working Inference

The new diagnostics make the earlier hypothesis more precise:

- The installed-CLI user-visible 1 GiB peak is now reproducible with the normal
  config on the local diagnostics bundle. The stripped run should be used for
  internal Qwen runtime attribution; the normal-config run should be used for
  user-visible process-tree attribution.
- The largest observed difference between stripped and normal config is
  process-tree shape: normal config starts additional MCP/Node child processes.
  Those children explain most of the absolute jump from about 0.35-0.55 GiB to
  about 1.1 GiB in the minimal prompt sanity check.
- The `--bare` follow-up confirms the same direction on `qwen3.6-plus`: normal
  config costs about 0.50-0.59 GiB more process-tree RSS than bare mode for the
  same prompt shape, while root RSS changes only slightly.
- The temporary-settings isolation is a better attribution test than `--bare`:
  disabling MCP alone reduces process-tree RSS by about 0.42-0.47 GiB while
  keeping the normal settings-loading path. Disabling hooks alone does not show
  a meaningful RSS change in no-tool-call cases.
- Per-MCP isolation points to `chrome-devtools` as the dominant MCP contributor:
  it is enough by itself to reproduce the high RSS band, and removing it returns
  the run near the no-MCP baseline.
- Within the local Qwen runtime, the most suspicious areas are no longer "raw
  diff bytes sent to the model". The model-facing request body is bounded.
- The stronger suspects are static per-request context cost, repeated request
  rounds, tool schema size, and local retention/capture of large tool outputs
  before or outside model-facing truncation.
- Because RSS remains much higher than V8 heap, the next profiling layer should
  include module/startup accounting, external memory, and heap snapshots around
  tool execution and final response emission.

## RSS Attribution From Current Diagnostics

The current counters do not identify an exact retained object or source file,
but they do narrow what is and is not driving RSS in these local runs:

| Signal                       | Current evidence                                                                                                            | RSS implication                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Root RSS vs process-tree RSS | Root and tree peaks are usually within about 2-10 MiB; DeepSeek large PR is the widest gap at about 23.6 MiB                | No persistent child process explains the RSS in this local bundle run; the main Node process dominates                                    |
| Normal config process tree   | Minimal-prompt normal-config runs reach about 1.1 GiB tree RSS while root RSS stays about 213-250 MiB                       | User-visible 1 GiB peaks can be dominated by MCP/Node child processes rather than Qwen root RSS alone                                     |
| `--bare` comparison          | `qwen3.6-plus` normal runs peak around 1.02-1.05 GiB tree RSS; bare runs peak around 0.45-0.53 GiB                          | Loading normal config adds about 0.50-0.59 GiB process-tree RSS in this environment                                                       |
| Temporary MCP isolation      | Clearing MCP servers drops startup/config tree RSS from 865-1,017 MiB to 443-549 MiB                                        | MCP startup and MCP child processes explain about 0.42-0.47 GiB of process-tree RSS in the controlled config check                        |
| Per-MCP isolation            | `chrome-devtools` alone reaches about 1.0 GiB in repeated samples; without it the run stays around 461 MiB                  | `chrome-devtools` is the dominant MCP process-tree RSS contributor in this environment                                                    |
| Temporary hooks isolation    | `disableAllHooks=true` with MCP still enabled changes tree RSS by only about 13-18 MiB in no-tool-call cases                | Hook config alone is not a visible startup RSS driver here; hook execution still needs a tool-call benchmark                              |
| V8 heap vs RSS               | End heap is about 99-143 MiB while end RSS is about 216-411 MiB                                                             | Live JS heap is not the whole footprint; loaded modules, native allocations, external buffers, or runtime overhead are likely significant |
| PR/diff size vs RSS          | DeepSeek small/medium/large PRs scale from 1 to 4,750 changed lines, but tree RSS stays in a narrow 340.7-360.0 MiB band    | Raw PR size is not linearly driving RSS once tool output is bounded                                                                       |
| Tool output size             | Large diff runs capture about 772-799 KiB tool results and show some higher end RSS / heap, but RSS does not scale linearly | Tool result capture/normalization contributes pressure, especially large-output cases, but is unlikely to be the only RSS driver          |
| Request body size            | Max model-facing body ranges from about 103-289 KiB while RSS stays near the same band                                      | Request serialization size affects tokens and latency more clearly than RSS peak                                                          |
| Static per-request context   | System prompt is about 39-51 KiB and tool schema about 37-48 KiB per request                                                | Repeated rounds are a token/cost amplifier; this alone does not explain RSS but is a likely optimization target for token pressure        |

Working attribution: in the stripped local bundle benchmark, the RSS floor looks
mostly like task-time runtime/module/native footprint, with large tool output
adding incremental pressure. In the normal-config run, the user-visible 1 GiB
tree peak is mostly process-tree composition: Qwen root plus MCP/Node child
processes. The next targeted measurement should split Qwen root diagnostics
from configured MCP server diagnostics, then add startup/module/external-memory
checkpoints inside the Qwen root process.

## Progress Snapshot

Current confirmed signals:

1. The user-visible 1 GiB startup/config peak is reproducible with both the
   installed CLI and the local diagnostics bundle when the normal config is
   loaded. It is not primarily explained by the diagnostics branch or PR `#4186`.
2. In this environment, that 1 GiB peak is mostly process-tree composition:
   Qwen root process plus relaunch child process plus MCP child processes.
3. `chrome-devtools` is the dominant configured MCP contributor in the current
   config. It is enough by itself to reproduce the high process-tree RSS band,
   even when the prompt does not explicitly use that MCP.
4. The no-MCP normal relaunch shape still sits around 0.45 GiB process-tree RSS.
   A single Qwen runtime process without the relaunch parent is closer to
   0.22-0.24 GiB in the startup attribution check. This means the 0.45 GiB
   baseline is not a single-process root RSS number.
5. In stripped non-interactive task runs, model choice changes turns, token
   totals, latency, and request sizes more clearly than RSS. RSS stayed in a
   relatively narrow range across `pai/glm-5`, `qwen3.6-plus`, and
   `DeepSeek/deepseek-v4-pro`.
6. Current short-task diagnostics show model-facing tool/function responses are
   bounded, but local tool-result capture and runtime state can still increase
   heap/RSS on large-output cases. This keeps large-output retention on the
   investigation path.

Current gaps:

1. The short-task benchmark matrix is still short-lived. A later interactive
   long-review run did reproduce a 41.9 min failure, but it is still one sample
   and needs repeat runs plus heap/object attribution.
2. The current counters are enough to attribute process-tree RSS and request
   size, but not enough to name the retained JS object graph during long
   sessions.
3. Startup/config RSS and long-session OOM must remain separate tracks. MCP and
   relaunch explain a large idle/startup RSS band; they do not by themselves
   explain V8 heap OOM after long tasks.
4. Interactive TUI memory still needs a separate run from non-interactive mode,
   because UI history and Ink static output are not exercised the same way.

## Long-Task OOM Evidence From Issues And PRs

Issue/PR evidence points to several different OOM shapes, not one single
failure mode:

| Source                                                                                                                 | Evidence summary                                                                                                                                      | Hypothesis to test                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`#4309`](https://github.com/QwenLM/qwen-code/issues/4309)                                                             | User reports 5.84 GiB memory usage / 7.02 GiB warning with YOLO mode and DeepSeek backend; increasing Node memory to 8 GiB did not remove the symptom | Long autonomous tool loops can retain enough state that simply raising old-space limit is not a root fix                         |
| [`#4149`](https://github.com/QwenLM/qwen-code/issues/4149)                                                             | Multiple reports show `Ineffective mark-compacts near heap limit`, including 4 GiB and much larger heap-limit cases                                   | A large fraction of heap is reachable application state, not immediately collectible garbage                                     |
| [`#4116`](https://github.com/QwenLM/qwen-code/issues/4116)                                                             | OOM occurred while context display was around 9.5%; analysis points to `structuredClone`, UI history, Ink static tree, and large context windows      | Token usage can be low while JS heap pressure is high; token threshold alone is not a reliable memory guard                      |
| [`#4167`](https://github.com/QwenLM/qwen-code/issues/4167)                                                             | User says the crash happened while compressing; analysis identifies compression peak memory as a distinct shape                                       | Compression can itself create a peak when heap is already high, especially if history is cloned/stringified around the same time |
| [`#2128`](https://github.com/QwenLM/qwen-code/issues/2128)                                                             | Report identifies unbounded UI history, retained file diffs / terminal output, string-width caches, and checkpoint serialization                      | Interactive TUI long sessions may retain memory outside model history and outside non-interactive benchmarks                     |
| [`#2562`](https://github.com/QwenLM/qwen-code/issues/2562)                                                             | Report focuses on `GeminiChat.getHistory()` deep-cloning full history in long sessions                                                                | Full-history cloning can amplify memory peaks and should be measured separately from retained steady-state size                  |
| [`#4185`](https://github.com/QwenLM/qwen-code/issues/4185)                                                             | Tracks V8 heap pressure exceeding limit before token-based compaction runs                                                                            | Heap-pressure guard is necessary, but it only mitigates symptoms if retained data remains large                                  |
| [`#4184`](https://github.com/QwenLM/qwen-code/issues/4184)                                                             | Proposes diagnostics and offload/preview for large retained tool results                                                                              | Large tool output may be bounded for model requests while still retained in local hot memory                                     |
| [`#4186`](https://github.com/QwenLM/qwen-code/pull/4186)                                                               | Merged heap-pressure auto-compaction safety net and O(1) last-history access for `nextSpeakerChecker`                                                 | Covers part of heap-pressure and clone amplification, but does not claim to solve all OOM classes                                |
| [`#4127`](https://github.com/QwenLM/qwen-code/pull/4127), [`#4168`](https://github.com/QwenLM/qwen-code/pull/4168)     | Open compaction-threshold PRs; one uses fixed heap thresholds, the other redesigns token thresholds and compression behavior                          | Useful related work, but long-task testing must verify whether heap, token, and compression signals line up in real runs         |
| [`#3000`](https://github.com/QwenLM/qwen-code/issues/3000), [`#4183`](https://github.com/QwenLM/qwen-code/issues/4183) | Diagnostic roadmap calls out `/doctor memory`, heap snapshot, and bounded memory timeline                                                             | Snapshot/timeline support is needed to move from RSS attribution to retained-object attribution                                  |

Initial interpretation:

- Unused configured MCP can consume memory because normal startup connects to
  configured MCP servers and advertises their tools before the task needs them.
  In the measured config, `chrome-devtools` starts extra Node/npm MCP processes
  and also increases the tool schema count from 19 to 48. This explains a large
  startup/config RSS band and can also increase repeated request overhead.
- The long-session OOM reports are a different layer. GC logs where
  Mark-Compact frees very little memory suggest the heap is full of reachable
  state. The strongest candidates are retained history/tool/UI objects,
  full-history clones, compression intermediates, and streaming/logging
  accumulators.
- PR `#4186` is a useful mitigation because it can compact based on heap
  pressure before token thresholds trigger, and it removes one unnecessary
  full-history clone. It should not be treated as proof that large tool-output
  retention, UI history retention, or compression peak memory is already solved.

## Long-Task Validation Plan

The next benchmark should keep two tracks separate:

1. Startup/config attribution: normal config vs MCP-disabled vs
   `chrome-devtools`-only vs no-relaunch attribution. This explains what users
   see before meaningful work begins.
2. Long-task runtime growth: repeated tool calls, large outputs, compression,
   resume, and interactive UI history. This explains OOM after real work.

Recommended long-task cases:

| Case                          | Shape                                                                                                | Why it matters                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Long PR review loop           | Repeat medium/large PR review prompts for 30, 60, and 120 minutes, with fixed model and fixed config | Closest to reported agent workflows; captures turns, tool calls, token growth, and RSS/heap trend |
| Large tool-output retention   | Repeatedly produce bounded 1 MiB / 5 MiB / 20 MiB command outputs, then ask follow-up questions      | Tests whether raw output is retained locally after model-facing truncation                        |
| Compression pressure          | Use a lower controlled old-space limit and large-context prompts to trigger heap-pressure compaction | Verifies PR `#4186` triggers before OOM and whether compression itself creates a new peak         |
| Interactive TUI history       | Run the same long loop in tmux TUI mode and compare with non-interactive mode                        | Isolates UI history, Ink static output, rendered diffs, and terminal-output display retention     |
| Resume stress                 | Resume a large saved session and immediately continue work                                           | Targets `/resume` OOM reports and session reconstruction cost                                     |
| Streaming/logging accumulator | Force long streamed responses with telemetry/logging enabled vs disabled                             | Tests the suspected `collected responses` / logging-retention path from issue analysis            |
| MCP idle vs MCP active        | Run no-MCP, `chrome-devtools` configured-but-unused, and `chrome-devtools` actively used variants    | Separates idle MCP child RSS from actual MCP tool execution and tool schema/token overhead        |

Metrics that should be recorded per turn or per sampling interval:

- Root RSS current/peak and process-tree RSS current/peak.
- Child process count and top child command shapes.
- V8 `heapUsed`, `heapTotal`, `heap_size_limit`, `external`, and
  `arrayBuffers`.
- Turn count, request count, tool-call count, and tool-call rounds.
- Input/output/cache/total tokens by request and by whole task.
- Request body bytes, system prompt bytes, tool schema bytes, and function
  response bytes.
- Tool-result count, total captured tool-result bytes, max tool-result bytes,
  and retained tool-result bytes if available.
- Conversation history message count and approximate history byte size.
- Interactive-only UI history item count and approximate retained display size.
- Compression attempts, compression trigger reason, tokens before/after, heap
  pressure before/after, and compression failure status.
- Heap snapshot or bounded memory timeline artifacts when heap pressure crosses
  a configured threshold.

Validation criteria:

1. Repeat at least the key long-task cases twice. Startup RSS has visible
   variance, so single-run conclusions should be avoided.
2. Report root RSS and process-tree RSS separately. User-facing memory pressure
   can come from child processes, while V8 OOM comes from the Qwen root heap.
3. Treat a flat RSS line as important evidence. If tokens and tool calls grow
   but heap/RSS stays flat, the issue is likely elsewhere.
4. When RSS or heap grows, correlate the growth with a specific signal:
   tool-result bytes, history bytes, UI history count, compression event,
   streaming accumulator size, or MCP process start.
5. If a heap snapshot is taken, write a structured diagnostics JSON first, then
   the snapshot. Heap snapshots may be large and can contain sensitive strings,
   so they should remain opt-in and local.

## Interactive Long-Review Reproduction

After the short non-interactive prompts kept finishing before the target window,
an interactive TUI benchmark was run with remote input. The CLI process stayed
alive in one session while a controller submitted one real PR-review turn at a
time. The next turn was only submitted after the assistant emitted that turn's
completion marker. This avoids treating a short one-shot prompt as a long-task
reproduction.

Setup:

- Installed Qwen Code `0.15.11`, model `qwen-latest-series-invite-beta-v28`.
- Temporary CLI home derived from the normal settings, with MCP and hook config
  removed. No global config was modified.
- Interactive TUI mode with dual JSON event output and remote JSONL input.
- Static PR review only. The prompt disallowed dependency install, build, test,
  Playwright, Docker, and other long external build commands.
- External RSS samplers recorded both process-tree RSS and the Qwen Node root
  RSS every 5 seconds.

Outcome:

| Signal                        |       Value |
| ----------------------------- | ----------: |
| Wall time before exit         |    41.9 min |
| Exit status                   |           1 |
| Completed PR-review turns     |           6 |
| Main chat records             |       1,076 |
| API response telemetry        |         335 |
| Tool-call telemetry           |         607 |
| MCP tool-call telemetry       |           0 |
| Main/root API responses       |          36 |
| Subagent API responses        |         299 |
| Root total tokens             |       2.08M |
| Subagent total tokens         |      17.24M |
| Total API telemetry tokens    |      19.32M |
| Max root input tokens         |      85,655 |
| Max subagent input tokens     |     215,207 |
| `/usr/bin/time -l` max RSS    | 1,072.4 MiB |
| Sampled Qwen root RSS peak    | 1,028.2 MiB |
| Sampled process-tree RSS peak | 1,038.1 MiB |

The process exited with:

```text
libc++abi: terminating due to uncaught exception of type std::__1::system_error: thread constructor failed: Resource temporarily unavailable
```

This is a **thread exhaustion** error, not a V8 heap OOM. The failure mechanism
is distinct: the OS refused to create a new thread, likely due to per-process
resource limits (`RLIMIT_NPROC`) or memory fragmentation preventing stack
allocation. It is still relevant because it occurred in a disabled-MCP,
no-build/test, interactive long-session review where the Qwen Node process
itself crossed about 1 GiB RSS.
The failure happened during the final summary phase, after the controller had
already completed six review turns.

Turn timeline and sampled Qwen root RSS:

| Window        | Turn state           | Qwen root RSS max | Qwen root RSS at window end |
| ------------- | -------------------- | ----------------: | --------------------------: |
| 0.0-9.0 min   | turn 1 completed     |         701.2 MiB |                   255.3 MiB |
| 9.0-15.1 min  | turn 2 completed     |         503.2 MiB |                   494.4 MiB |
| 15.1-24.1 min | turn 3 completed     |         468.7 MiB |                   457.5 MiB |
| 24.1-31.9 min | turn 4 completed     |         619.3 MiB |                   602.3 MiB |
| 31.9-40.3 min | turn 5 completed     |         955.5 MiB |                   955.5 MiB |
| 40.3-40.4 min | turn 6 completed     |         988.6 MiB |                   988.6 MiB |
| 40.4-41.9 min | final summary / exit |       1,028.2 MiB |                 1,028.2 MiB |

Token and tool distribution:

| Owner        | API responses | Input tokens | Output tokens | Total tokens | Max input |
| ------------ | ------------: | -----------: | ------------: | -----------: | --------: |
| Root session |            36 |        2.06M |         22.2K |        2.08M |    85,655 |
| Subagents    |           299 |       17.08M |        154.6K |       17.24M |   215,207 |

Tool-call telemetry by function:

| Tool                | Calls | Captured content length |
| ------------------- | ----: | ----------------------: |
| `read_file`         |   271 |                 1.46 MB |
| `run_shell_command` |   181 |                164.4 KB |
| `web_fetch`         |    80 |                846.3 KB |
| `grep_search`       |    25 |                 15.0 KB |
| `glob`              |    15 |                 27.8 KB |
| `todo_write`        |    16 |                 16.1 KB |
| `list_directory`    |     8 |                  6.2 KB |
| `agent`             |    10 |                       0 |
| `tool_search`       |     1 |                  2.1 KB |

The top visible TUI token counter for a single agent reached about 3.83M
tokens. Telemetry also shows the heaviest subagent at about 4.05M total tokens
with a 215K-token max input request. That makes subagent amplification the
dominant signal in this reproduction.

Interpretation:

1. This run separates long-session growth from MCP startup/config memory. MCP
   was disabled and there were no MCP tool calls, yet the Qwen root process
   still reached about 1 GiB RSS.
2. The late memory peak aligns with subagent-heavy review turns and final
   summary/merge-back, not with external build/test child processes.
3. The RSS curve is not a simple linear leak. It falls after early turns, then
   rises sharply after later subagent turns and remains high near exit.
4. The failure mode is native resource exhaustion rather than a V8 heap-limit
   stack, so the next run should add heap/external/arrayBuffer/thread-count
   sampling. RSS alone cannot distinguish JS heap from native allocations or
   thread-resource pressure.
5. The strongest code paths to inspect remain subagent transcript retention,
   agent-result merge-back, full-history cloning, checkpoint/session recording,
   and final summary/history assembly.

## Deterministic Huge-Task Clone-Pressure Reproduction

A deterministic stress harness was added as
`scripts/memory-pressure-repro.mjs`. It does not call a model. Instead, it
constructs a Qwen-like long-session object graph with root review turns,
subagent transcripts, large tool results, checkpoint JSON, and retained
`structuredClone()` copies. This gives a repeatable reproduction for the clone
and checkpoint peak suspected from the user-provided OOM stack.

The harness has a lightweight script test:

```bash
npx vitest run --config ./scripts/tests/vitest.config.ts \
  scripts/tests/memory-pressure-repro.test.js
```

Result: passed, 1 test.

Controlled runs used `node --max-old-space-size=256` unless otherwise noted.

| Case                                              | History shape                                                           | Clone/checkpoint pressure                          | Result                            |   Max RSS |
| ------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------- | --------: |
| Small sanity                                      | 2 turns, 2 KiB tool result, 1 subagent                                  | 1 clone + 1 checkpoint                             | passed; 2.6 MiB history JSON      |  89.7 MiB |
| Huge build only                                   | 12 turns, 256 KiB tool result, 2 subagents x 12 subagent turns          | no retained clone/checkpoint                       | passed; 76.2 MiB history JSON     | 491.5 MiB |
| Huge + 1 clone                                    | same as above                                                           | 1 retained `structuredClone()`                     | passed                            | 569.6 MiB |
| Huge + 2 clones                                   | same as above                                                           | 2 retained `structuredClone()` copies              | OOM, exit 134                     | 496.5 MiB |
| Huge + 1 checkpoint                               | same as above                                                           | one checkpoint with original + cloned history JSON | passed; 152.5 MiB checkpoint JSON | 926.9 MiB |
| Huge + 2 checkpoints                              | same as above                                                           | two checkpoint copies                              | OOM, exit 134                     | 920.1 MiB |
| Huge + 2 clones, no retained subagent transcripts | same generated subagent output, but parent history keeps only summaries | passed; parent history JSON drops to 3.8 MiB       | 136.8 MiB                         |

The failing huge-clone run produced:

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The native stack included:

- `v8::internal::ValueDeserializer::ReadObjectInternal`
- `v8::internal::ValueDeserializer::ReadDenseJSArray`
- `node::worker::Message::Deserialize`
- `node::worker::StructuredClone`

This matches the same stack family as the user-provided OOM log. The controlled
reproduction also shows why 4 GiB / 8 GiB user reports are plausible: the
failure is not caused by a single large object, but by large retained
history/tool-result/subagent state plus one or more full-history clone or
checkpoint copies. Raising `--max-old-space-size` can delay the crash while
preserving the same amplification pattern.

Important attribution from this deterministic run:

1. Building a 76.2 MiB parent history JSON can succeed under the reduced heap.
   The OOM appears when additional full-history clone/checkpoint copies are
   retained.
2. A single checkpoint copy can push RSS close to 1 GiB even before OOM.
3. Removing retained subagent transcripts from the parent hot history changes
   the same generated workload from OOM to a small 136.8 MiB RSS run. That is
   the clearest mitigation signal so far.
4. This reproducer is synthetic and intentionally adversarial, but it exercises
   the same object-graph shape as the long interactive review: parent session,
   subagents, large tool outputs, transcript merge-back, and full-history clone
   pressure.

## DeepSeek PR-Size Follow-Up

After the initial model matrix, an additional Qwen Code-only run tested
`DeepSeek/deepseek-v4-pro` across three real PR sizes. This model is configured
through the Anthropic-compatible protocol; OpenAI-compatible execution returned
404 in a smoke check, so the successful benchmark uses `--auth-type anthropic`.

The diagnostics branch was extended to record Anthropic wire request summaries
with the same privacy rule as the OpenAI path: aggregate counts and byte sizes
only, no prompt text, diff content, tool arguments, headers, base URL, or API
key.

PR sizes:

| Size   | PR      | State  | Files | Changed lines | Title                                                                   |
| ------ | ------- | ------ | ----: | ------------: | ----------------------------------------------------------------------- |
| small  | `#4268` | merged |     1 |             1 | fix(serve): add mcp_guardrails to E2E capabilities expectation          |
| medium | `#4186` | merged |     6 |           494 | fix(core): add heap-pressure auto-compaction safety net                 |
| large  | `#4168` | open   |    25 |         4,750 | feat(core)!: redesign auto-compaction thresholds with three-tier ladder |

Runtime:

| Size   | PR      |   Wall | Turns | Total tokens | Cache-read tokens | Tree RSS peak | Root RSS peak |  End heap |   End RSS |
| ------ | ------- | -----: | ----: | -----------: | ----------------: | ------------: | ------------: | --------: | --------: |
| small  | `#4268` |  39.7s |     2 |       43,362 |            28,672 |     346.9 MiB |     344.8 MiB | 115.2 MiB | 304.3 MiB |
| medium | `#4186` | 142.6s |     4 |      135,120 |           115,840 |     340.7 MiB |     337.3 MiB | 103.5 MiB | 285.6 MiB |
| large  | `#4168` | 191.1s |     8 |      386,891 |           332,928 |     360.0 MiB |     336.3 MiB | 119.3 MiB | 237.9 MiB |

Request and tool diagnostics:

| Size   | PR      | Requests | Anthropic wire requests | Max Anthropic body | Max system | Max tool schema | Tool calls | Total tool result | Max tool result | Max function response in request |
| ------ | ------- | -------: | ----------------------: | -----------------: | ---------: | --------------: | ---------: | ----------------: | --------------: | -------------------------------: |
| small  | `#4268` |        2 |                       2 |          103.0 KiB |   50.8 KiB |        47.6 KiB |          3 |           0.6 KiB |         0.5 KiB |                          1.1 KiB |
| medium | `#4186` |        4 |                       4 |          159.8 KiB |   50.8 KiB |        47.6 KiB |          5 |          30.2 KiB |        29.3 KiB |                         56.7 KiB |
| large  | `#4168` |        8 |                       8 |          289.5 KiB |   50.8 KiB |        47.6 KiB |         11 |         235.0 KiB |       232.1 KiB |                        182.4 KiB |

DeepSeek observations:

1. PR size scaled turns, tokens, Anthropic wire body size, and tool result size
   clearly, but did not scale RSS proportionally. The small/medium/large tree
   RSS peaks stayed in a narrow `340.7-360.0 MiB` band.
2. The large PR was expensive mostly in model rounds and token volume:
   8 requests and 386,891 total tokens. Its max Anthropic body was 289.5 KiB,
   much larger than the OpenAI-compatible runs, but RSS still stayed near the
   same local-bundle band.
3. The static Anthropic request cost is also visible: system prompt is about
   50.8 KiB and tool schema about 47.6 KiB per request. Repeated rounds are
   therefore a major token amplifier.
4. The large PR produced 235.0 KiB of captured tool results and 182.4 KiB max
   function response in a request. This is higher than the earlier small PR /
   code-navigation cases and shows large PRs still put pressure on local
   tool-result handling and request assembly, even when RSS does not spike.
5. The DeepSeek run reinforces the model-choice conclusion: provider/model
   choice strongly changes turns, latency, token volume, and wire payload shape,
   but the local bundle RSS peak remains dominated by Qwen Code runtime shape
   rather than scaling linearly with PR size.

## Long-Review JSONL Replay: History Clone Pressure

A recent long PR-review chat record was analyzed as a post-mortem shape for
the reported OOM class. The raw JSONL is not included here because it contains
prompt and tool output text. The aggregate shape is:

| Signal                  | Value                         |
| ----------------------- | ----------------------------- |
| Duration                | 87.0 min                      |
| Qwen Code version       | 0.15.10                       |
| Model                   | qwen-latest-series beta model |
| API responses           | 380                           |
| Tool-call telemetry     | 507 events                    |
| MCP tool-call telemetry | 4 events                      |
| Subagent API responses  | 313                           |
| Root API responses      | 67                            |
| Root prompt growth      | 38,622 -> 168,555 tokens      |
| Max prompt tokens       | 168,555                       |
| Total response tokens   | 31.28M                        |

This shape does not support MCP as the primary OOM cause for this case. Only
4 of 507 tool-call telemetry events were MCP, and all four recorded
`content_length=0`. The dominant shape is long-session/subagent amplification:
15 `agent` calls produced 313 subagent API responses and 403 subagent tool-call
events.

The replay then rebuilt the chat `Content[]` message shape from the JSONL and
ran controlled clone/stringify pressure tests. The base retained message payload
is small, so it is not itself enough to OOM:

| Replay scale | Retained clones | History JSON | Checkpoint JSON | End heap |  End RSS |
| ------------ | --------------: | -----------: | --------------: | -------: | -------: |
| 1x           |               8 |      0.54 MB |         1.08 MB |  18.0 MB |  88.8 MB |
| 30x          |               8 |     14.46 MB |        28.92 MB | 260.0 MB | 577.8 MB |
| 60x          |               8 |     28.86 MB |        57.71 MB | 510.3 MB | 960.8 MB |

The scaled replay is not a user-data claim; it is a controlled amplification of
the observed JSONL shape to test whether full-history clone and checkpoint
serialization can create the same failure mode as the reports.

A low-heap reproduction with `--max-old-space-size=256` confirms the mechanism:

| Case                      | History JSON | Result                                                |
| ------------------------- | -----------: | ----------------------------------------------------- |
| Build history only        |      38.4 MB | Succeeded; heap 131.6 MB, RSS 378.2 MB                |
| Build + one clone         |      38.4 MB | Succeeded; heap 183.3 MB, RSS 463.4 MB                |
| Build + repeated clones   |      38.4 MB | OOM after several retained `structuredClone()` copies |
| Checkpoint double-history |      38.4 MB | OOM while holding history plus cloned client history  |

The repeated-clone OOM stack contains `ValueDeserializer::ReadObjectInternal`,
`ValueDeserializer::ReadDenseJSArray`,
`node::worker::Message::Deserialize`, and
`node::worker::StructuredClone`, matching the same stack family seen in the
user-provided OOM log. This proves that full-history `structuredClone()` can be
the immediate OOM trigger without any MCP server involvement.

Current working hypothesis for this JSONL class:

1. MCP can explain normal-config startup RSS in separate benchmarks, but it is
   not the likely trigger for this long-review OOM shape.
2. Long task growth comes from retained chat history, large tool outputs,
   subagent histories, observable agent messages, and UI/tool-result state.
3. The immediate OOM trigger can be a full-history clone or checkpoint-style
   double serialization after the heap is already high.
4. Compression can mitigate retained history, but compression itself may create
   a temporary peak if it first clones or serializes large history.

### Local Mitigation Validation: Disabled-MCP PR Review Case

Two targeted mitigations were applied locally and validated before rerunning a
disabled-MCP PR review case:

1. `checkNextSpeaker()` now reads only the last curated message with
   `getHistoryTail(1, true)` and sends only that message to the next-speaker
   side query. The next-speaker prompt only asks about the immediately previous
   model response, so sending full history was unnecessary clone and token
   pressure.
2. `AgentToolInvocation` no longer retains full `responseParts` arrays inside
   the live `task_execution.toolCalls` display. The real response parts still
   flow through transcript/history paths, but the parent UI display now keeps
   only a bounded text summary for nested tool-result streaming instead of
   holding another full copy of large subagent tool outputs during long runs.
3. `GeminiChat.sendMessageStream()` now builds model request contents through
   an internal curated-history view instead of calling public
   `getHistory(true)`. Public `getHistory()` still returns a defensive
   `structuredClone()` for external callers, but the request hot path no longer
   deep-clones the whole retained chat history before every model call.

TDD checks added for these mitigations:

| Test                                                                                                           | Expected protection                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `checkNextSpeaker > should send only the last curated model message to the side query`                         | Prevents full-history clone/send in next-speaker checks                                  |
| `AgentTool > should not retain responseParts in live tool call display after TOOL_RESULT`                      | Prevents live subagent display from retaining large tool responses                       |
| `AgentTool > should keep only a bounded result summary in live tool call display`                              | Preserves nested result readability without retaining the full response body             |
| `GeminiChat > sendMessageStream > does not deep-clone the full curated history when building request contents` | Prevents request setup from hitting the `ValueDeserializer` / `StructuredClone` OOM path |

Additional reproduction and fix validation:

| Step                                 | Command shape                                                                                                                                | Result                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-fix deterministic clone pressure | `node --max-old-space-size=256 scripts/memory-pressure-repro.mjs ... --clone-count=2 --mode=clone`                                           | OOM, exit 134; stderr contained `Reached heap limit` and `ValueDeserializer` / `StructuredClone`; max RSS 528.1 MiB in the repeat run |
| Red test                             | targeted `GeminiChat` test with `structuredClone` forced to throw during request setup                                                       | failed at `GeminiChat.getHistory()` before the mitigation                                                                             |
| Green test                           | same targeted `GeminiChat` test after the mitigation                                                                                         | passed                                                                                                                                |
| Built-code smoke                     | `node --max-old-space-size=256` against the built core package, with a 96-entry / about 48 MiB history and `structuredClone` forced to throw | passed; request had 97 contents; process RSS 161.4 MiB, `/usr/bin/time -l` max RSS 161.6 MiB                                          |

This narrows the earlier "same stack family" statement: the deterministic
synthetic OOM still proves retained full-history clones can fail in the same V8
stack family as the user log, while the new `GeminiChat` red/green test proves
one real production request-setup path no longer reaches that clone point.
Checkpoint/resume and compression internals still need separate long-run
validation because they can legitimately need durable copied history.

Verification commands:

| Command                                                                                                | Result                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run src/core/geminiChat.test.ts`                                                           | passed, 89 tests                                                                                                                            |
| `npx vitest run src/utils/nextSpeakerChecker.test.ts --coverage=false`                                 | passed, 13 tests                                                                                                                            |
| `npx vitest run src/tools/agent/agent.test.ts --coverage=false`                                        | passed, 77 tests                                                                                                                            |
| `npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/memory-pressure-repro.test.js` | passed, 1 test                                                                                                                              |
| `npm run build --workspace=packages/core`                                                              | passed                                                                                                                                      |
| `npm run build --workspace=packages/cli`                                                               | passed                                                                                                                                      |
| `npm run typecheck --workspace=packages/core`                                                          | passed                                                                                                                                      |
| `npm run typecheck --workspace=packages/cli`                                                           | passed                                                                                                                                      |
| `npm run bundle`                                                                                       | passed                                                                                                                                      |
| `npm run build`                                                                                        | failed in `packages/vscode-ide-companion` lint on existing internal-module import rules; core, CLI, bundle, and targeted tests above passed |

The full root `npm run build` was not clean in this worktree because the
`vscode-ide-companion` package hit pre-existing `import/no-internal-modules`
lint errors. The core/CLI build and bundle needed for the local runtime test
completed successfully.

The same PR review prompt was then run with a temporary config where MCP and
hooks were disabled. Both rows were interrupted after a bounded long-run window
instead of waiting for a full review to finish. **Caveat**: the two runs are
confounded by workload size (79K vs 390K tokens) and cannot be compared as a
controlled experiment. The comparison only shows directional evidence.

| Variant           | Runtime | MCP servers | Tools | Assistant messages | Tool use/result blocks | Parent tool ids | Total tokens | Max input tokens | Root max RSS |
| ----------------- | ------: | ----------: | ----: | -----------------: | ---------------------: | --------------: | -----------: | ---------------: | -----------: |
| before mitigation | 365.08s |           0 |    19 |                 42 |                42 / 42 |               3 |       79,439 |           26,807 |    357.7 MiB |
| after mitigation  | 404.52s |           0 |    19 |                 58 |                52 / 42 |               2 |      390,339 |           54,000 |    310.5 MiB |

This is not a deterministic apples-to-apples model benchmark: the patched run
did more work and consumed substantially more total tokens before the manual
cutoff. The useful signal is narrower: under a disabled-MCP review case with
more observed work, root max RSS did not increase and was about 47.2 MiB lower.
That supports the mitigation direction, but it does not prove the whole
long-task OOM class is fixed.

Remaining high-risk clone/retention paths to inspect next:

1. Compression still calls full `getHistory(true)` before summarization. If the
   heap is already high, the compression attempt can create the peak that trips
   OOM.
2. Checkpoint creation can hold original history, cloned client history, and a
   serialized checkpoint payload at the same time.
3. Fork subagents still seed from parent history with `getHistory(true)`.
4. ACP/history export/summary/copy paths still call full `getHistory()` and
   should be audited separately from the normal review loop.

Version timing:

| Issue | Created    | Reported version         | Signal                                   |
| ----- | ---------- | ------------------------ | ---------------------------------------- |
| #2128 | 2026-03-05 | not specified            | Long-session UI memory growth            |
| #2562 | 2026-03-21 | not specified            | `structuredClone` OOM in long sessions   |
| #2868 | 2026-04-03 | 0.13.2                   | Heap OOM                                 |
| #2945 | 2026-04-07 | 0.14.0                   | V8 heap OOM                              |
| #4116 | 2026-05-13 | 0.15.11                  | OOM with structured-clone-style analysis |
| #4134 | 2026-05-14 | 0.15.11                  | OOM                                      |
| #4149 | 2026-05-14 | 0.15.10-nightly.20260513 | V8 heap OOM                              |
| #4167 | 2026-05-15 | 0.15.11                  | Crash near compression                   |
| #4185 | 2026-05-15 | 0.15.11                  | Heap pressure before token compaction    |
| #4254 | 2026-05-17 | not specified            | Memory keeps rising                      |
| #4276 | 2026-05-18 | 0.15.11                  | V8 heap OOM                              |
| #4309 | 2026-05-19 | 0.15.11                  | High memory warning around 7 GiB         |

The issue history does not prove that 0.15.10 introduced the OOM class; similar
reports existed in March and April. It does support a recent cluster beginning
around 2026-05-13, overlapping `v0.15.10`/`v0.15.11` releases. The relevant
diff between `v0.15.9` and `v0.15.10` touched subagent runtime,
non-interactive execution, `GeminiChat`, and compression code heavily, so this
range is a reasonable first bisect window.

## Notes

- The first code-navigation prompt allowed open-ended exploration and hit
  `maxSessionTurns`; the successful rows above use a constrained command list.
- The first synthetic-diff attempt used a relative bundle path from inside the
  temporary repositories; those failed immediately and are excluded from the
  tables. The successful rows use the absolute local bundle path.
- Raw JSONL streams are not committed because they contain prompts, tool
  commands, and tool output. The report only includes aggregate diagnostics.
