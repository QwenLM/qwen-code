# ACP Child Heap Calibration and Admission

[English](acp-child-heap-calibration-and-admission.md) | [简体中文](acp-child-heap-calibration-and-admission.zh-CN.md)

## 1. Status and decision

Design investigation dated 2026-09-12, with live smoke and repeated-pair tests on
2026-09-14, against
`df864bea6a930d31faf8b35fc5e57bac98a25e20`. This includes the
[#11653 sentinel fix](https://github.com/QwenLM/qwen-code/pull/11653).
This document records verified wiring, the available calibration evidence,
and a proposed implementation. It does not enable enforcement or claim that
workload calibration is complete.

The revised 2026-09-14 matrix completed all 12 runs / 36 turns with verified file delivery and fresh heap/GC coverage (section 2.8). The earlier heavy timeout and collector validation failure remain separate, excluded attempts. The accepted v3 long, v3b MCP/multi and v3c concurrency pairs together cover 88 validated turns under separately identified protocols (section 2.9). Section 2.10 now contains eight accepted Node 24 runs, 184 real-model turns and 360 exact tool calls across two long-session pairs, one MCP pair and one four-child concurrent pair; failed attempts retain separate provenance. Broader real-world workloads, materially larger contexts, multi-hour stability, other hosts and rollout criteria remain open.

Proceed with a workload comparison before applying the existing fixed heap
partition. The fixed-heap behavioral change will be opt-in through the existing
`--child-heap-mode` option; `observe` stays the default. No additional
environment variable or registration limit is proposed.

The three preceding capacity stages are now delivered: [#11911](https://github.com/QwenLM/qwen-code/pull/11911) adds count-only admission through opt-in `admit` mode while retaining legacy heap arguments, [#11940](https://github.com/QwenLM/qwen-code/pull/11940) reclaims an eligible idle ACP at capacity, and [#12008](https://github.com/QwenLM/qwen-code/pull/12008) lets the user inspect and stop a workspace runtime. They do not apply the modeled per-child heap ceiling or establish the aggregate heap invariant below. Sections 4–7 describe that later fixed-heap proposal.

This follows the
[#8182 remaining scope](https://github.com/QwenLM/qwen-code/issues/8182#issuecomment-5338301483),
the [resource tracker](https://github.com/QwenLM/qwen-code/issues/8091), and
the [measurement design's exit criteria](2026-08-18-acp-child-peak-old-generation-measurement.md#exit-criteria-for-the-enforcement-pr).

## 2. Calibration evidence report

### 2.1 Evidence already published

These are reports retrieved from GitHub, not experiments rerun for this
document. The Linux capacity runs used `dfcf07ac`, before #11653.

| Evidence                                                                                                           | Established result                                                                                                                                            | What it does not establish                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Registration, recovery, churn and soak](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5621875474) | On 4 vCPU / 7265 MiB, 256 real repositories retained 226.4 MiB RSS with zero children. Three churn cycles and about 20 minutes of idle observation completed. | Child heap adequacy under model load.                                                             |
| [Live model ladder](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5628271115)                      | 73 sessions / 146 turns completed at concurrency 1–24. At 16, peak tree RSS was 4671.7 MiB and minimum `MemAvailable` was 2923 MiB.                           | Survival and GC cost under a fixed, smaller V8 ceiling; multi-session retention inside one child. |
| [Heavier read/search profile](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5628813819)            | 96 turns completed at concurrency 4/8/12; per-active-workspace RSS was 288–298 MiB. The profile accumulated about 296K of text over four turns.               | Arbitrarily long sessions, multi-MCP workloads, large retained outputs, or multi-hour stability.  |
| [Constrained-host probes](https://github.com/QwenLM/qwen-code/issues/8182#issuecomment-5622379643)                 | Actual child arguments were inspected with no limit and with 2/4/6 GiB cgroup limits.                                                                         | Workload performance under those limits; the runs used idle children.                             |

The published tables do not include `peakOldGenerationBytes`,
`peakLiveSetBytes`, `majorGcCount`, `majorGcMs`, reporter coverage, or
unclassified spaces. This does not prove those fields are absent from the
original JSON. The original archive has now been located at
`code_agent/repros/daemon-capacity-linux-4c8g`, including 55 JSON files and
the collectors. The [machine-readable audit](acp-child-heap-calibration-evidence.json)
records file hashes and selected metrics. Recursive inspection found zero
occurrences of all five heap/GC fields across all 55 files. This is now a
verified collection gap, rather than an inference from the comments.

The collector explains the gap: `load-probe.mjs` samples `/proc` every two
seconds and saves RSS, FDs, child count and available memory, without child
heap snapshots. `harness.mjs` fetches daemon status but retains limits and
counts rather than `runtime.memory.children`; its inspector reads the root
process's heap. Neither can reconstruct a child old-generation peak later.

All 11 published light/heavy run records were rechecked: 146 light and 96
heavy prompts returned `end_turn`, with zero failed turns and exit code 0
for each daemon. The light summary contains only the later 12/16/24 runs;
use individual records for all eight levels. The archive README identifies
three invalid early cgroup setup records; they are excluded from capacity
conclusions. Existing completion/RSS evidence can be reused. Child-heap and
GC evidence must be newly collected.

### 2.2 Current model, not measured safe capacity

`resolveDaemonMemoryBudget` and `createChildHeapPolicy` resolve one partition
at daemon startup. With default budgets their arithmetic is:

| Available memory, MiB | Effective budget | Root reserve | Child pool | Child slots | Ceiling per child, MiB |
| --------------------- | ---------------- | ------------ | ---------- | ----------- | ---------------------- |
| 2048                  | 1024             | 256          | 768        | 1           | 768                    |
| 4096                  | 2048             | 256          | 1792       | 3           | 597                    |
| 6144                  | 3072             | 307          | 2765       | 5           | 553                    |
| 7265                  | 3632             | 363          | 3269       | 6           | 544                    |
| 8192                  | 4096             | 409          | 3687       | 7           | 526                    |
| 32768                 | 16384            | 1024         | 15360      | 25          | 614                    |

The capacity report's suggested 16 concurrent workspaces is therefore not
the current model's limit. Enforcing the unchanged partition would refuse
the seventh committed child on the 7265 MiB host, even though the reported
workload ran at 16. This is an explicit compatibility tradeoff to evaluate,
not a reason to infer a heap size from RSS or silently replace the model
with a 16-child constant.

`MIN_CHILD_HEAP_MB = 512` is a policy floor, not a measured requirement. The
model can return zero slots and a null ceiling. It must never emit
`--max-old-space-size=0`, which requests V8's default.

### 2.3 Measurements needed to close calibration

First inspect the existing raw reports. Reuse samples only when their
commit, bundle hash, Node version, workload, child generation, actual
arguments, memory limit and measurement coverage can be established.
Preserve their original provenance; do not relabel pre-#11653 results as
current-main results.

If the necessary fields are missing, repeat only the relevant workload
groups with collection enabled. Do not repeat the registration ladder.
Compare the current post-#11653 arguments with a fixed candidate ceiling on
the same build, host, provider and fixture. Verify the child's actual
arguments; setting `NODE_OPTIONS` alone is insufficient because explicit
spawn arguments can override it. A temporary experiment seam must apply
only to daemon ACP children and must not become a production option.

The required profiles are the existing light and heavier workloads, a
long session with a large transcript and large tool output, multiple
sessions retained in one workspace child, and a multi-MCP configuration.
Use both 8 GiB and 32 GiB modeled partitions and supported Node majors.
Distinguish a real constrained host from injecting a memory value into the
pure model. Include the original 7265 MiB host where available. MCP and
other descendant memory is recorded separately from ACP heap.

Use paired baseline/candidate runs and repeat each pair at least three
times. Record task completion, actual tool calls, major-GC pauses, wall
time, OS/cgroup memory events, and cleanup. Handle permission requests in
the isolated fixture and record each decision; an unanswered request is
not an overload failure. This plan does not prescribe auto-approval for
real user workspaces.

### 2.4 Evidence quality rules

- Keep the daemon event stream attached while collecting, and wait for
  fresh child resource readings before the child exits. The child probe
  accumulates lifetime marks independently, but daemon collection is
  watcher-gated and its cache can be absent or stale.
- Preserve `activeAcpChildren`, `children.sampled`,
  `children.oldestReadingAgeMs`, `children.heap.reported` and
  `unclassifiedSpaceNames` with every sample. Missing reporters, stale
  readings or unknown spaces are unknown coverage, not zero consumption.
- The public heap aggregate contains independent maxima across currently
  live children. Its GC count and pause time are not sums; their maxima can
  come from different children. Do not subtract aggregate maxima across
  changing populations to calculate per-child GC cost. Use single-child
  paired runs or collect per-generation snapshots in the experiment
  harness. Preserve samples before replacement; exited children disappear
  from the current aggregate.
- `peakLiveSetBytes = 0` with no observed major GC is not an empty live
  set. A positive aggregate GC count does not prove that every child has
  a post-major-GC sample. Record missing per-child evidence explicitly.
- Committed old-generation peaks depend on the heap ceiling. Exceeding a
  candidate under a larger ceiling is not by itself a failure. The live-set
  observation is also an upper bound because GC callbacks are asynchronous.
  Actual candidate runs, coverage and GC cost must support the decision.

Calibration passes only when all required profiles have complete evidence,
finish under the candidate, retain measured headroom below its ceiling,
and quantify GC and latency changes. No universal headroom percentage or
acceptable latency regression has yet been calibrated; the report must
state the observed margins and an explicitly chosen acceptance threshold.
If evidence is incomplete, the result is pending. If a profile fails,
revisit the partition before implementing it as a supported policy.

### 2.5 Local baseline checks completed

Fourteen local commands completed without timeouts on macOS arm64. The
globally installed CLI was 0.22.3, separate from the source revision under
study: help bypassed enum validation, while an actual isolated enforcing
startup exited 1 and reported only `off` / `observe` as supported. All six
model rows, the N/N+1 boundary, and two zero-slot 768 MiB cases matched
executable source.

Small synthetic real-Node probes on 22.22.3 and 24.12.0 produced heap
reports, no unknown spaces and non-decreasing lifetime marks. Both
reproduced the percentage-option precedence. All owned command process
groups were empty after completion; isolated state was removed. These
checks made no model calls and cannot satisfy workload calibration.

### 2.6 First live smoke pair after connectivity recovered

On 2026-09-14, the original Linux host was reachable using its existing
test identity. A separate experiment directory received the post-#11653
bundle; all 1072 bundle-file hashes matched. The original source and
capacity archive were retained. The host still had 7265 MiB RAM, no swap,
and Node 22.23.2.

The [smoke evidence](acp-child-heap-smoke-evidence.json) records one light
run per arm, each with one workspace, one session and one ACP child.
The same collector, bundle, Node, provider and prompts were used. An
experiment-only preload changed ACP spawn arguments in the fixed arm;
no production mode or admission behavior was changed.

| Observation                              | Baseline  | Fixed candidate |
| ---------------------------------------- | --------- | --------------- |
| Actual old-space argument, MiB           | 3632      | 544             |
| Completed turns                          | 2         | 2               |
| Completed tool calls                     | 6         | 13              |
| Peak old generation, MiB                 | 115.65    | 117.16          |
| Post-major-GC live-set upper bound, MiB  | 106.38    | 106.19          |
| Major GC count / cumulative duration, ms | 3 / 20.00 | 3 / 17.23       |
| Peak daemon-tree RSS, MiB                | 466.24    | 469.18          |

Both runs returned `end_turn` for every prompt, reported completed tool
calls and fresh heap coverage for the single observed child generation,
and reported no unclassified spaces. Tracked processes exited, the port
was released, isolated state was removed and fixture Git status was
unchanged. Answer semantics were not graded.

This establishes collector readiness and successful execution of this
light task with the experimental 544 MiB ceiling. It is not the required
three repeated pairs. Tool-call counts differed despite identical prompts,
so wall-time differences do not isolate heap-policy overhead. At this
smoke stage, all repeated and broader comparisons were still pending.
Section 2.7 records the subsequent repeated experiment.

### 2.7 Repeated light pairs and a heavy baseline timeout

The [repeated-matrix evidence](acp-child-heap-paired-calibration-evidence.json)
records a new batch on the same physical 7265 MiB Linux host, Node
22.23.2, provider, fixture and frozen post-#11653 build. The earlier smoke
runs are excluded. The planned matrix was light/heavy × baseline/544 MiB
× three repetitions: 12 runs and 36 turns. Within each profile, the pair
order was baseline-first, candidate-first, baseline-first. Each sequential
run used a fresh isolated home, one workspace, one session and one child.
Prompts limited work to read, list, glob and grep; the fixture configuration
disabled shell execution, file modification and delegation. No production
settings or admission behavior changed. The enabled registry was broader
than those four operations; all recorded calls were read/search.

The six light runs completed all 12 turns and 43 tool calls. Independent
raw-sample checks confirmed the fixed collector and bundle hashes,
actual 3632/544 MiB arguments, one observed child generation per run,
fresh reports before the first turn, after each turn and before teardown,
known heap spaces, unchanged cgroup OOM counters and complete cleanup.
Tool titles included both requested files in every run; full-file content
coverage and answer semantics were not graded.

| Light observation                               | Baseline              | Fixed candidate       |
| ----------------------------------------------- | --------------------- | --------------------- |
| Completed runs / turns                          | 3 / 6                 | 3 / 6                 |
| Completed tool calls                            | 19                    | 24                    |
| Actual old-space argument, MiB                  | 3632                  | 544                   |
| Maximum observed old-generation peak, MiB       | 120.46                | 116.84                |
| Maximum live-set upper bound, MiB               | 108.49                | 107.41                |
| New major GCs per run in the measurement window | 3–4                   | 3                     |
| Window major-GC duration median (range), ms     | 21.85 (21.58–25.11)   | 16.41 (16.26–17.55)   |
| Prompt wall-time median (range), s              | 116.03 (85.01–220.15) | 109.18 (99.11–123.84) |
| Maximum observed daemon-tree RSS, MiB           | 469.76                | 472.14                |

Heap peaks are lifetime marks and include startup. The GC window is the
difference between the fresh report before the first turn and the fresh
report before teardown, including between-turn and final settling waits.
Every light run observed new major GC in this window. The candidate's
maximum observed old-generation peak left 427.16 MiB below its 544 MiB
grant. This is measured headroom for these runs, not a calibrated universal
margin. Different tool sequences and provider output mean that neither
wall-time nor GC differences isolate a heap-policy performance effect.

Run 7, the first heavy baseline with a verified 3632 MiB grant, timed out
in its first prompt after 600001 ms. It requested exhaustive `workspace`
occurrence counts and the ten highest-count files. All 183 issued tool
calls completed: 182 search operations and one read. The three subsequent
large-file reading turns never started. The driver preserved this attempt
and stopped as specified; the remaining five runs, including every heavy
544 MiB run, were not started. The complete 12-run/36-turn matrix therefore
did not pass.

The last periodic observation before cancellation reported a 152.95 MiB
old-generation peak, a 145.69 MiB live-set upper bound and 14 lifetime
major GCs totaling 93.02 ms. Tree RSS peaked at 481.96 MiB and minimum host
`MemAvailable` was 5952.62 MiB. There were no sample errors or cgroup OOM
counter increases; retained metric buckets reported no model API errors
or retries. These observations provide no evidence of heap exhaustion.
They do not explain all model/tool latency. Only the initial fresh report
exists: the last periodic reading was about 4.96 seconds old and is not a
complete after-turn or before-teardown measurement.

The observed execution path spent the timeout on exhaustive search under
the read-only tool restriction; it did not reach the intended large-file
retention workload. A protocol revision should supply a constrained,
auditable read-only counting command, preserve the three large-file reads,
and freeze a new version before rerunning the whole matrix. That was the proposal at the end of v1; section 2.8 records its later execution without retroactively changing this failed result.
The revised collector should retain fixture-scoped tool arguments, output
size and truncation metadata, and bounded answer evidence. The current
titles alone cannot establish whether output limits or the model's
counting strategy caused the search to expand.

All 44 downloaded artifact hashes matched the stopped remote batch, and
all 1072 bundle-file hashes still matched afterward. Every tracked daemon
and child exited, ports and isolated fixtures were released, and the
temporary provider credential file was removed. A read-only download of
completed light artifacts occurred during heavy run 7 and is recorded in
the evidence; its timing is another reason not to interpret wall time as
a controlled performance comparison. At the end of v1, heavy and broader calibration remained outstanding. Section 2.8 records the later single-child heavy comparison; long-session, multi-session, multi-MCP, concurrency, Node 24 and 8/32 GiB partition calibration remains outstanding. Production enforcement remains unimplemented.

### 2.8 Revised paired protocol and completed scoped results

The v1 timeout is retained unchanged. A new v2 protocol keeps the original light inspection and heavy three-file comparison goals, but performs the count through one fixed read-only Shell command. Its scope is explicitly case-sensitive literal occurrences in Git-tracked non-binary files under `packages/cli/src/serve/`. An independent Python byte counter verifies the helper; both the successful command output and the model's final JSON must match that oracle. This changes the execution protocol, so v2 results must not be pooled with v1.

All target reads use precomputed pages of at most 400 lines and 16,000 UTF-8 bytes. Successful ACP text must exactly match each frozen file slice after the known range wrapper and per-line trailing-whitespace normalization. Every page is required. The collector retains bounded sequenced tool arguments, output, status, metadata, hashes and final answers. This proves text delivery through ACP, not model understanding or cross-turn retention; prose answers are retained without claiming semantic correctness.

The collector verifies the actual enabled tool set and the absence of configured MCP servers or live MCP clients. Shell requires a single `allow_once` approval for the exact foreground command and directory. Fresh isolated daemon runs retain the existing process, heap-report freshness, timeout, host-memory and cleanup gates.

The full matrix is predeclared as 12 runs / 36 turns, with three pairs per profile and AB / BA / AB ordering. The first heavy baseline/544 pair runs first and is paused for independent raw-result validation before the remaining ten runs. It counts as the first planned pair only if that audit passes with unchanged bundle, collector, helper, driver, fixture and runtime. Any protocol fix starts a separately identified batch and preserves the failed evidence. The completed execution is reported below; the protocol itself does not establish a safe production capacity.

The first v2 attempt (`matrix-v2-20260914T095218Z`) completed its single count command and returned the correct JSON in 10,001 ms, but the collector rejected the run. Permission-gated tools intentionally omit the argument-bearing in-progress update: the full arguments were in the permission request, while the preparing event had `{}` and the terminal event had no `rawInput`. This was a collector validation defect, not a count or heap failure. The archived attempt is excluded from calibration statistics. v2b starts a new complete matrix and retains permission arguments separately by `toolCallId`, validating them against terminal command, directory and output without rewriting the raw tool events.

The revised batch `matrix-v2b-20260914T095554Z` completed all **12 runs / 36 turns**. Each profile completed three baseline/544 MiB pairs in AB / BA / AB order. Both independent pilot audits passed before the remaining ten runs resumed with the same frozen identities. Every heavy run executed the one approved counting command and delivered all 5 + 5 + 12 file pages; every light run delivered both complete target files. The count command and answer JSON matched the independent 419-file oracle: 275 matching files and 16,474 literal occurrences. See the [audited machine-readable results](acp-child-heap-revised-paired-calibration-evidence.json) for per-run evidence, hashes, ranges and excluded failures.

| Profile | Arm      | Peak old generation, MiB | Observed old-space margin, MiB | Median GC window, ms | Median prompt wall time, s | Peak process-tree RSS, MiB |
| ------- | -------- | -----------------------: | -----------------------------: | -------------------: | -------------------------: | -------------------------: |
| light   | baseline |                   113.46 |                        3518.54 |                17.86 |                      85.95 |                     459.54 |
| light   | 544      |                   116.10 |                         427.90 |                16.27 |                     122.24 |                     461.30 |
| heavy   | baseline |                   125.82 |                        3506.18 |                45.24 |                     317.16 |                     508.52 |
| heavy   | 544      |                   127.07 |                         416.93 |                28.65 |                     350.94 |                     507.21 |

The matrix completed 201 tool calls. Heavy runs included 19 additional read-only checks in addition to their required pages (16 searches and three reads of `workspace-git-state.ts`). Light baseline runs used 16 calls in total, versus 28 for the fixed-ceiling runs. These are observed differences in execution under the same prompts; the protocol only fixes the count turn to one command and requires complete target-page delivery. The independent final audit passed 12,155 checks. Its initial mistaken assumption that every heavy run must have exactly 23 calls was corrected, with the failed audit snapshot retained separately.

All twelve runs had one observed child generation with actual 3632/544 MiB arguments, complete fresh heap reports and a newly observed major GC in the measured window. No model API errors/retries or cgroup OOM increments were observed. All process, port and fixture cleanup checks passed. Downloads took place while the pilot was paused or after the matrix stopped. The final check verified all 1072 bundle files, experiment hashes and the 421 counted/target fixture files, then removed the temporary provider file.

These are successful single-child workload observations, not a measured deployment capacity or evidence that the heap flag bounds RSS. File text delivery is verified; prose correctness and cross-turn retention are not. Different generated answers and timings prevent causal attribution of wall-time differences to the heap limit. Long sessions, multiple sessions per child, multi-MCP workloads, concurrent children, Node 24 and the other host partitions remain outside this completed matrix. Production enforcement remains unimplemented pending that broader calibration.

### 2.9 Extended long-session, multi-session, MCP and concurrency screen

The [extended screening evidence](acp-child-heap-extended-calibration-evidence.json) retains the independently passing long-session pair from `extended-v3-20260914T114300Z`, the MCP and multi-session pairs from `extended-v3b-20260914T120020Z`, and the concurrent pair from `extended-v3c-20260914T122158Z`, on the same frozen CLI/SDK, provider, Node 22.23.2 and original 4-vCPU host. These separately attributed results cover **eight accepted runs, 88 real-model turns and 144 exact tool calls**, one default/544 MiB pair for each profile. The order is AB for long and MCP, BA for multi and concurrent. The original v3 eight-run and v3b six-run matrices both failed; only the v3c two-run matrix completed. These are four profile pairs across three frozen protocols, not one completed eight-run matrix or pooled statistical evidence. The retained v3 and v3b pilots passed independent raw-data audit before continuation; the complete v3c pair also passed. Earlier v1/v2/v2b matrices and startup-only preflights are excluded.

In v3 run 3 (multi/544), the tenth turn returned its requested page and then performed an extra Glob lookup for a referenced file. Both tools completed without clipping, but the exact-call contract failed. Only the first nine turns passed that contract; no complete final fresh workload window exists. All raw data remains archived and the other five original runs never started. v3b restarts all three missing profile pairs, exposes only read_file among built-ins, explicitly disables list/glob/grep, and instructs the model to leave absent references unknown. It keeps exact page/body validation. The already audited v3 long pair is not relabeled as v3b or repeated solely to consolidate batch IDs.

In v3b run 5 (concurrent/544), one model-generated read path omitted `heap-` from a long temporary workspace path. That read failed before the corrected read completed; the first wave ended four prompts with five calls, one failed and four completed. All four required pages arrived, but the frozen no-failed-or-extra-call contract rejected the attempt. There is no final fresh resource window, and the remaining baseline run never started. Its raw data and failed state remain archived. v3c reruns only this pair using four existing full Git repositories at `/root/cap/repos/ws000` through `ws003`. Their commits, clean status, five target hashes and four absent workspace configuration paths match before and after both runs. Only workspace selection and its identity checks change from v3b; prompts, pages, strict call/body checks, provider and instrumentation remain the same.

The longer-session profile has one session and 12 turns, returning all 24 pages of the same five source files, about 307K source bytes. The multi-session profile keeps four distinct thread sessions attached in one workspace/child for three sequential round-robin rounds. Each session reads three successive pages of the daemon-status fixture. The MCP profile uses one session, three local stdio servers and 32 valid read-only tool schemas per server; eight turns each return three exact 8192-byte payloads. ToolSearch is disabled for this fixture. The accepted concurrent pair uses one daemon with four existing repository workspaces, sessions and children, executing three overlapping prompt waves. Those repositories are read-only inputs and are never removed during cleanup. The longer temporary copy workspaces belong only to the excluded v3b attempt.

An experiment-only daemon preload observes existing ACP resource requests/responses and session creation, without adding resource requests, forcing GC or rebuilding the CLI. PID/start ticks and returned session IDs establish ownership. Every measurement boundary requires a resource request started after the boundary and a response no older than seven seconds for every expected child. RPC IDs are paired internally by the tap but are not serialized; the independent offline probe verifies pairing and byte/backpressure transparency, while raw-result audits verify recorded generation and request/response times. This distinction limits what can be reconstructed from the archive. Full status, per-turn context-usage and session-status diagnostics also run during collection; their allocation/CPU overhead is included and was not independently benchmarked.

| Profile    | Protocol | Arm      | Sessions / children | Old-generation peak, MiB | Live-set upper bound, MiB | Window major GC count / ms | Tree RSS peak, MiB |
| ---------- | -------- | -------- | ------------------- | -----------------------: | ------------------------: | -------------------------: | -----------------: |
| long       | v3       | baseline | 1 / 1               |                   130.03 |                    108.75 |                  6 / 28.34 |             464.88 |
| long       | v3       | 544      | 1 / 1               |                   119.82 |                    107.17 |                  6 / 27.19 |             443.68 |
| mcp        | v3b      | baseline | 1 / 1               |                   123.76 |                    111.85 |                  6 / 31.40 |             607.69 |
| mcp        | v3b      | 544      | 1 / 1               |                   129.29 |                    111.96 |                  5 / 20.55 |             610.40 |
| multi      | v3b      | 544      | 4 / 1               |                   125.55 |                    113.02 |                   3 / 9.41 |             463.27 |
| multi      | v3b      | baseline | 4 / 1               |                   125.30 |                    114.30 |                   3 / 8.75 |             474.11 |
| concurrent | v3c      | 544      | 4 / 4               |                   113.16 |                    105.86 |                  7 / 42.36 |            1133.28 |
| concurrent | v3c      | baseline | 4 / 4               |                   112.91 |                    106.56 |                  8 / 41.84 |            1122.07 |

Heap peaks are per-child lifetime maxima, including startup. For four children, the table shows the largest individual peak, not their sum. Each child's GC increment is computed between its fresh `workload-start` and `before-teardown` reports; the concurrent row sums those four independently computed increments. These windows include inter-turn and final waits and are not identical to prompt wall time. No delta is derived from the daemon's aggregate maxima. The JSON retains each child’s GC window, aggregate prompt timings, selected context-usage sequences, raw-evidence hashes and observed overlaps. Tree RSS is the largest sampled sum of the daemon and its observed descendants, including ACP children and local MCP processes where present. Shared pages can be counted more than once; this is neither unique physical memory nor a continuous peak measurement.

The longer-session final context reports were 105,903/102,944 tokens for default/544, respectively, against the reported 1,000,000-token context window. These values are the daemon's reported usage, not a claim that all previously delivered bytes remain resident. The collector preserves context-usage sequences and event counts; absence of an observed decrease or compaction event cannot rule out every internal history transformation. Exact file/MCP text delivery is verified, while answer semantics and comprehension are not graded.

Three connected MCP pool entries, 96 valid tool schemas, three actual server processes and the server call logs establish the MCP workload. On this build, `clientCount` still reports zero in the off-budget pool path because its fallback counts legacy manager clients, excluding pooled connections. The first startup-only preflight incorrectly required three from that field and was retained as a collector-validation failure. The corrected experiment uses pool entries and process evidence and does not change production accounting. MCP output is repetitive synthetic text; it does not represent arbitrary external services, resource/image outputs or every MCP transport.

The resource and independent audits require exact tool arguments and complete untruncated bodies, expected session-to-generation topology, fresh known-space heap coverage, actual 3632/544 MiB arguments, unchanged OOM counters and complete cleanup. Concurrent runs additionally require actual overlapping prompt intervals and four-active-prompt observations in every wave. Original fixture hashes and all four concurrent repository identities are checked before teardown. Raw files are downloaded only while paused or stopped; the retained pilots are preserved unchanged through the final downloads. Final verification checks the frozen bundle, experiment and original fixture hashes, all four existing repository identities, no remaining calibration processes, and removal of the temporary provider file.

The minimum observed old-space headroom across the four 544 MiB screening runs was 414.71 MiB. This supports retaining 544 MiB as an experimental candidate for further calibration; it does not establish safe production RSS, maximum concurrency, leak freedom, or an acceptable GC/latency regression threshold. One pair and nondeterministic model output do not isolate a causal performance difference. At this screening stage, broader profiles, materially larger/longer contexts, sustained higher concurrency, Node 24 and other modeled hosts remained open; section 2.10 records the subsequent Node 24 follow-up and its remaining gaps. Production enforcement remains disabled.

### 2.10 Node 24 long-session, MCP and four-child concurrent calibration

The [Node 24 evidence](acp-child-heap-node24-long-calibration-evidence.json) contains **eight accepted runs, 184 real-model turns and 360 exact tool calls**: two MCP runs from v4, four long-session runs across v4b and the v4c retry, and a fresh four-child concurrent pair from `node24-concurrent-v5-20260919T150128Z`. This is an accepted evidence set across four explicitly identified protocols, not a relabeled single successful batch. The runtime is isolated Node 24.21.0, V8 `13.6.233.17-node.53`, with the official [archive checksum](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt), executable hash and observed daemon/ACP/MCP executable paths verified. The frozen CLI/SDK and original Linux host are unchanged, as is the system Node 22 executable. Earlier Node 22 protocols are not matched cross-major performance controls.

Three failed attempts remain excluded. The v4 long run stopped at turn 13 after returning no required tool call; its answer was not archived, so the cause is unknown. The second v4b baseline completed 21 turns and then received a model-serving internal error; the whole run was retried once in v4c with the identical collector and workload. The v4c 544 MiB concurrent attempt failed its first wave when one session made two unregistered `tool_search` calls instead of the required read, while the other three sessions completed their exact reads. Registry snapshots exposed only `read_file`, but provider request schemas were not captured, so that failure remains unexplained and excluded. The later v5 pair retries the complete concurrent workload with a fresh protocol and request-schema summaries; it does not retroactively make the v4c attempt valid.

The accepted long-session profile has two baseline/544 pairs, ordered AB then BA, with the retry qualification above. Each run retains one session and child generation for 36 turns. Two distinct pages per turn consume 72 pages in three stages, delivering 1,008,521 exact body bytes. Actual paced spans were 21.34–22.94 minutes, including model execution, diagnostics and recorded waits; this is continuous residency, not continuous CPU work or multi-hour stability. Final reported context usage was 300,217–311,090 tokens. The MCP pair retains three local stdio servers, 96 valid tool schemas and 24 exact 8192-byte results per arm.

The v5 concurrent pair uses one daemon with four clean repositories, four sessions and four ACP children. Each arm performs three overlapping waves; every session completes one exact `read_file` call per wave, for 12 turns and 12 calls. Every wave has measured overlap and at least three samples with all four prompts active. Every child generation has positive major-GC coverage over the workload window, OOM counters remain unchanged, repository/config hashes remain unchanged, and cleanup releases all owned processes and ports.

| Profile    | Pair | Arm      | Turns / children | Old peak, MiB | Live-set upper bound, MiB | Window major GC count / ms | Tree RSS peak, MiB | Long paced span, min |
| ---------- | ---- | -------- | ---------------- | ------------: | ------------------------: | -------------------------: | -----------------: | -------------------: |
| mcp        | 1    | baseline | 8 / 1            |        106.00 |                     94.51 |                  5 / 39.09 |             814.59 |                  N/A |
| mcp        | 1    | 544      | 8 / 1            |        106.20 |                    100.31 |                  7 / 37.06 |             716.05 |                  N/A |
| long       | 1    | baseline | 36 / 1           |        109.31 |                     94.62 |                29 / 105.17 |             522.91 |                22.57 |
| long       | 1    | 544      | 36 / 1           |        109.97 |                     98.36 |                37 / 131.36 |             547.03 |                22.07 |
| long       | 2    | 544      | 36 / 1           |        108.87 |                     98.71 |                40 / 138.53 |             535.98 |                22.94 |
| long       | 2    | baseline | 36 / 1           |        109.20 |                     94.60 |                29 / 134.31 |             562.01 |                21.34 |
| concurrent | 1    | 544      | 12 / 4           |         93.71 |                     86.06 |                 12 / 73.32 |            1285.70 |                  N/A |
| concurrent | 1    | baseline | 12 / 4           |         93.23 |                     87.58 |                10 / 113.43 |            1359.64 |                  N/A |

Heap columns are individual-child lifetime observational peaks including startup; the concurrent rows show the largest individual value, while the GC column sums independently bounded per-child workload deltas. Live-set values are post-major-GC lifetime upper bounds, not current retained memory or leak slopes. Tree RSS is a maximum sampled sum of the daemon and observed descendants; shared pages may be counted repeatedly, so it is neither unique physical memory nor a continuous peak. One real-model pair cannot establish a causal latency, RSS or GC difference between arms.

The v5 experiment-only loopback proxy retained request timestamp, model, body size, top-level keys, tool names, and parameter-schema size and SHA-256. It did not retain authorization headers, message bodies, schema bodies or response bodies. Each arm recorded 36 provider requests; all 24 tool-bearing requests included only `read_file`, none included `tool_search`, and no request failed to parse. This verifies the v5 request surface and closes the missing-schema observation for this retry; it does not identify why the preserved v4c attempt behaved differently.

Across the accepted Node 24 candidate runs, the largest old-generation peak is 109.97 MiB, leaving 434.03 MiB below the experimental 544 MiB argument. The v5 candidate concurrent maximum is 93.71 MiB, leaving 450.29 MiB. These are observed margins for bounded inputs, not production safety margins. Exact delivery and usage counters do not prove semantic comprehension or that all history remains resident. Local repetitive MCP payloads do not represent arbitrary external services. Tap and diagnostics overhead is included but not independently benchmarked, and no forced GC was introduced.

The pilot snapshot, failed attempts and raw hashes are preserved. The candidate pilot passed 3,957 independent checks before the baseline ran; the completed pair passed 6,318 independent checks. Final verification confirms 1,072 frozen bundle files, runtime and experiment hashes, four clean repositories, unchanged OOM counters, no remaining calibration processes and removal of the temporary provider file. The Node 24 concurrency gap is closed for this workload. The evidence supports retaining 544 MiB as a scoped candidate, while broader profiles, larger contexts, multi-hour stability, other host partitions and explicit GC/latency rollout thresholds remain open. Production heap enforcement remains unimplemented.

## 3. Verified implementation boundaries

| Component                                                 | Current behavior and design consequence                                                                                                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/acp-bridge/src/daemon-memory-budget.ts`         | Resolves the host/cgroup denominator, root reserve and child pool.                                                                                                                                       |
| `packages/acp-bridge/src/child-heap-policy.ts`            | Computes one fixed modeled ceiling and slot count. `off` disables modeling, `observe` records hypothetical refusals, and `admit` enforces only the modeled child count. There is no heap-enforcing mode. |
| `packages/acp-bridge/src/spawnChannel.ts`                 | Reserves before deciding, rejects over-capacity spawns in `admit`, and may request one idle reclamation before retrying. Spawned children still receive the legacy host-derived heap arguments.          |
| `packages/acp-bridge/src/process-registry.ts`             | Counts reservations and attached children. A terminating owned group remains accounted until process cleanup proves release.                                                                             |
| `packages/cli/src/serve/idle-acp-reclamation.ts`          | At capacity, selects the least recently used eligible idle channel from trusted existing runtimes; it excludes the requester and runtimes with active or dependent work.                                 |
| `packages/cli/src/serve/routes/workspace-runtime-stop.ts` | Publishes stop previews and requires an exact user confirmation before stopping a selected workspace runtime; incomplete cleanup remains visible and accounted.                                          |
| `packages/cli/src/serve/run-qwen-serve.ts`                | Primary, internal and secondary runtime factories share one process registry, heap policy and idle reclaimer.                                                                                            |
| `packages/cli/src/serve/server.ts`                        | Direct-embed default spawning and externally supplied bridges/factories are separate paths; they cannot inherit a future heap-enforcement claim automatically.                                           |
| `packages/cli/src/acp-integration/child-heap-probe.ts`    | Accumulates whole old-generation and post-major-GC observations inside daemon ACP children.                                                                                                              |
| `packages/cli/src/serve/daemon-status.ts`                 | Publishes active-child RSS, heap maxima and coverage. `limits.memory.enforced` remains the literal `false`.                                                                                              |

Multiple sessions share one child. Registration count, session count, active prompt count and `bridge.isChannelLive()` cannot replace an actual process reservation. A channel may be logically unavailable while its child or owned descendants are still terminating. #12008 therefore retains isolation and capacity accounting until tracked cleanup settles.

Workspace registration remains independent and can succeed while all modeled child slots are occupied. The delivered idle reclaimer only considers fully idle eligible runtimes, and the user-directed route exposes the remaining workspace choices when none can be reclaimed automatically. The fixed-heap proposal does not add a registration cap or environment variable.

## 4. Proposed policy and lifecycle

### 4.1 Explicit, immutable policy

After calibration, add `enforce` to the existing fast-path parser,
full CLI parser, `ServeOptions`, policy type and SDK mirrors together.
Keep `off` and `observe` behavior unchanged. Resolve mode and budget once
before startup constructs any child factory. Changing the policy requires
a restart; do not shrink existing children or recompute grants as
workspaces register.

Enforcement requires the built-in daemon spawn path, one shared registry,
and one shared policy. Reject an unsupported injected bridge or factory
configuration before listening rather than accepting an inert mode. Reject
a zero-slot/null-ceiling enforcing configuration before preheat. Standalone
ACP, IDE and direct-embed callers keep their existing behavior unless they
explicitly enter a separately documented supported path.

Specifically, `runQwenServe` must reject `enforce` with `deps.bridge`,
which currently disables policy construction. An enforcing public spawn
factory requires an explicit shared `processRegistry`; an implicit private
registry would let every factory admit its own full partition. Direct
`createServeApp` calls without daemon-owned enforcement wiring must also
reject the mode. A caller-provided status snapshot is not proof of wiring.

### 4.2 Reserve, decide, spawn, release

Reuse `ProcessRegistry.reserve()` and `committedProcessCount`. In the
existing synchronous sequence, reserve first and decide with the new
reservation included. If the enforcing policy refuses, cancel that
reservation and throw a typed capacity error before `spawn()`. The existing
try/catch must also release it when policy evaluation or spawn throws.

When admitted, emit an explicit fixed `--max-old-space-size=<ceiling>` even
when it is below the parent's heap limit. Preserve `--expose-gc`. Verify
precedence over inherited `process.execArgv` and `NODE_OPTIONS`, including
equivalent or competing heap-size flags supported by the Node version;
remove or reject conflicting inputs only within the enforcing path.
Neither the legacy argument cache nor another factory may supply a
different ceiling for a later admitted child.

One conflicting flag is already confirmed:
[`--max-old-space-size-percentage` takes precedence over the fixed flag](https://nodejs.org/api/cli.html#--max-old-space-size-percentagepercentage).
A local Node 22.22.3 probe reported a 560 MiB total heap limit for fixed
512 MiB, but 9878 MiB when percentage 20 was also present, in either
argument order or through `NODE_OPTIONS`. These are startup-parameter
observations, not allocations or workload results. The enforcing path
must reject competing percentage options and normalize inherited fixed
old-space options before adding its one fixed grant. Preserve unrelated
loader options. Do not assert that V8's total `heap_size_limit` equals the
old-space grant; it includes other heap capacity.

Once attached, the process registry owns release. Preserve cancellation,
spawn failure, exit and process-tree teardown semantics. Sending a signal
or closing ACP streams is not proof of root exit. The current registry
retains known owned groups during teardown, but can release a root/known
scope and subsequently report a cleanup-proof error; Windows can release
after root exit even if tree kill failed. Do not strengthen that into a
claim that every possible descendant was observed or terminated. A known
live tracked process remains counted; retain existing cleanup-failure
reporting and keep descendant/RSS guarantees outside this policy.
During replacement, old and new children each consume a slot until the old
one is actually released. Full occupancy may refuse a replacement; the
first version grants no unbudgeted replacement allowance and creates no
unbounded waiting queue. Existing drain/rollback behavior remains owned by
the corresponding workspace generation.

The claim is narrowly `committed child count × fixed old-space ceiling <=
childPoolMb`. It is not a bound on process RSS, young generation, external
buffers, MCP servers, channel workers, terminals or the entire daemon tree.

## 5. Failure and status contracts

Reuse the existing shared typed error for exhausted child capacity,
`acp_child_capacity_exhausted`. REST returns 503; ACP returns the existing
error envelope with equivalent machine-readable code and HTTP status metadata.
Do not retry automatically or fall back to the primary workspace.

Review every operation that can cause a child start: session create,
restore, resume, fork, prompt recovery, runtime ensure/restart, startup
preheat, channel management and scheduled execution. Retain the resolved
workspace/session owner across awaits. Session worktree/branch/fork paths
may have changed persistent state before channel acquisition; a factory
refusal therefore cannot universally promise `sideEffectPossible: false`
or safe whole-request retry. Preserve each route's existing outcome and
rollback metadata. Background startup and scheduled jobs must record the
failure through their existing owner-specific reporting path.

Conversations needs an explicit cause-preservation path:
`StandaloneSessionSpawnError` wraps the factory error, and
`standalone-session-service.ts` currently converts an undispatched failure
to `standalone_creation_rolled_back`. Preserve the capacity cause after
performing the existing rollback and retaining its outcome; do not turn
ordinary capacity pressure into a terminal quarantine. Updating only the
global REST and ACP error mappers would miss this path.

The runtime coordinator is another wrapper: its preheat and MCP preparation
paths wrap failures in `WorkspaceRuntimeInitializationError`, which REST
maps to `runtime_initialization_failed`. Preserve the capacity cause through
this wrapper too, while keeping generation-closed/draining errors and
existing outcomes higher priority. A full-capacity runtime-ensure test must
verify the returned capacity reason, not merely HTTP 503.

`limits.memory.enforced` is documented as a child-heap flag in the current
source. Widen its type only in the behavioral PR, and set it true only for
the fully wired built-in enforcing path. Keep the coverage statement
explicitly about daemon ACP child heaps. Update `mode`, refusal semantics
and SDK types together; an observation refusal remains hypothetical,
whereas an enforcing refusal means that no new child was spawned. Verify
all readers rather than treating a new enum value as documentation only.

Workspace registration stays independent and can succeed while all child
slots are occupied. The existing eligible-idle LRU and user-directed stop
behavior remain unchanged; this proposal adds no registration-cap change,
session eviction or environment variable.

## 6. Verification and delivery

1. Archive and inspect the existing raw reports; produce the missing-field
   and provenance inventory. Completed: 55 JSON files audited, collector
   source checked, 242 completed turns revalidated. The five required
   heap/GC fields are absent from every archived JSON.
2. Run paired workload calibration on a build containing #11653. Retain
   actual child arguments, coverage and per-generation GC measurements.
   Publish the measured margins and the decision to keep or revise the
   partition. Current status: the original host connection recovered on 2026-09-14. The smoke pair and revised 12-run / 36-turn matrix completed; section 2.8 records verified text delivery and heap/GC observations. Earlier failures remain separately archived. The accepted v3 long, v3b MCP/multi and v3c concurrency pairs cover 88 validated turns (section 2.9). Section 2.10 records eight accepted Node 24 runs, including the completed four-child concurrent retry and its request-schema evidence. Broader real-world profiles, materially larger contexts, multi-hour stability, other hosts and rollout thresholds remain pending.
3. Implement the opt-in policy in a focused PR after calibration passes.
   Tests must exercise both parsers and every factory, two racing starts
   at the final slot, cancellation, synchronous and asynchronous spawn
   errors, termination overlap, failed cleanup, shutdown, zero capacity,
   multi-session sharing, registration at full child capacity, inherited
   heap flags and standalone parity.
4. Validate REST/ACP errors and persistence outcomes for the operations in
   section 5. Run the existing focused package suites, build, typecheck,
   bundle, the fast-path closure check and real daemon E2E verification.

The current deliverable is this bilingual evidence/design document, raw archive audit, live smoke and repeated-matrix evidence, and local E2E collection plan. The evidence change does not alter production behavior. The later implementation PR remains gated by the open decisions below.

## 7. Open decisions

- Review the Node 22 screens and accepted Node 24 long/MCP/concurrent evidence within their measured scopes. Broaden real-world profiles, materially larger contexts, multi-hour stability and other host partitions, and establish rollout/performance thresholds before enforcement.
- Measured safety margin and acceptable GC/latency change for each profile;
  whether the current 512 MiB floor and maximum-25 partition are suitable.
- Whether the first supported rollout should be limited to the measured workload scope until broader real-world and multi-hour calibration passes.
- Exact existing route outcomes for full-capacity channel replacement and
  operations with prior filesystem/persistence effects. Finalize the
  error metadata in their tests before making retry promises.

These decisions must not be filled with an assumed 16-child operating
limit or inferred from the registration-capacity results.
