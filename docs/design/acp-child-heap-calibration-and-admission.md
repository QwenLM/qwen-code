# ACP Child Heap Calibration and Admission

[English](acp-child-heap-calibration-and-admission.md) | [简体中文](acp-child-heap-calibration-and-admission.zh-CN.md)

## 1. Status and decision

This document records the calibration evidence and the implementation design for an experimental, opt-in fixed heap ceiling on daemon ACP children. `observe` remains the default and retains legacy host-derived heap arguments. Only explicitly selecting `--child-heap-mode enforce` on the fully managed daemon path applies the fixed old-space ceiling and reports `limits.memory.enforced: true`. The historical calibration summary is unchanged; it is evidence for a bounded candidate, not a production-default recommendation.

The accepted Node 24 calibration set contains eight runs, 184 real-model turns and 360 exact tool calls across long-session, multi-MCP and four-child concurrent profiles. Within those bounded profiles, a 544 MiB old-space ceiling completed the workload and retained at least 434.03 MiB of observed old-generation headroom. This supports retaining 544 MiB as a scoped implementation candidate. It does not establish a universal safe ceiling, a process RSS bound, maximum deployment concurrency, multi-hour stability or acceptable GC and latency thresholds.

The compact [machine-readable summary](acp-child-heap-node24-calibration-summary.json) retains the environment identity, protocol and download-manifest hashes, accepted run metrics, excluded-attempt provenance and the decision. Full per-turn and raw-derived artifacts remain separately archived rather than being committed under `docs/design/`.

The preceding capacity stages are already delivered: [#11911](https://github.com/QwenLM/qwen-code/pull/11911) adds count-only admission through opt-in `admit` mode, [#11940](https://github.com/QwenLM/qwen-code/pull/11940) reclaims an eligible idle ACP at capacity, and [#12008](https://github.com/QwenLM/qwen-code/pull/12008) lets users inspect and stop a workspace runtime. Those stages do not apply a fixed child heap ceiling. The remaining work is tracked by [#8182](https://github.com/QwenLM/qwen-code/issues/8182).

## 2. Evidence

### 2.1 Why new measurement was required

The earlier [registration and recovery report](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5621875474), [live model ladder](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5628271115), [heavier read/search profile](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5628813819) and [constrained-host probes](https://github.com/QwenLM/qwen-code/issues/8182#issuecomment-5622379643) established registration cost, observed RSS and child arguments. The archived collectors did not record child old-generation peaks, post-major-GC live-set observations, major-GC counts or coverage. RSS therefore could not determine a safe V8 old-space ceiling.

The new experiment compared the current baseline with an experiment-only 544 MiB argument on the same source build, Linux host, provider, fixture and isolated Node 24 runtime. It verified the actual child arguments, exact tool delivery, fresh per-generation heap coverage, major-GC observations, OOM counters and cleanup. No production mode or default changed.

### 2.2 Current partition model

`resolveDaemonMemoryBudget` and `createChildHeapPolicy` resolve one immutable partition at daemon startup. With the current defaults:

| Available memory, MiB | Effective budget | Root reserve | Child pool | Child slots | Ceiling per child, MiB |
| --------------------- | ---------------- | ------------ | ---------- | ----------- | ---------------------- |
| 2048                  | 1024             | 256          | 768        | 1           | 768                    |
| 4096                  | 2048             | 256          | 1792       | 3           | 597                    |
| 6144                  | 3072             | 307          | 2765       | 5           | 553                    |
| 7265                  | 3632             | 363          | 3269       | 6           | 544                    |
| 8192                  | 4096             | 409          | 3687       | 7           | 526                    |
| 32768                 | 16384            | 1024         | 15360      | 25          | 614                    |

`MIN_CHILD_HEAP_MB = 512` is a policy floor, not a measured requirement. The model can return zero slots and a null ceiling; an enforcing path must never emit `--max-old-space-size=0`.

The 4-vCPU host had 7,265 MiB of physical memory. Its modeled partition produces six slots at 544 MiB each. Earlier successful runs at higher concurrency do not change that arithmetic because those runs measured workload RSS without enforcing the partition.

### 2.3 Accepted Node 24 results

The accepted set uses Node 24.21.0 and compares the 3,632 MiB legacy baseline with the 544 MiB candidate. It spans four explicitly identified protocols because failed attempts were retained and corrected work started under new batch identifiers.

| Profile      | Accepted pairs | Turns per run | Children per run | Candidate peak old generation, MiB | Candidate minimum observed headroom, MiB |
| ------------ | -------------- | ------------- | ---------------- | ---------------------------------- | ---------------------------------------- |
| MCP          | 1              | 8             | 1                | 106.20                             | 437.80                                   |
| Long session | 2              | 36            | 1                | 109.97                             | 434.03                                   |
| Concurrent   | 1              | 12            | 4                | 93.71                              | 450.29                                   |

All eight accepted runs completed their planned turns and tool calls, had no model API error or retry, observed positive major-GC coverage and passed cleanup. The long-session runs retained one session and child generation for 36 turns, delivered 72 distinct pages and reported final context usage between 300,217 and 311,090 tokens. The concurrent pair ran three waves across four ACP children. Its request-schema capture recorded 36 provider requests per arm; all 24 tool-bearing requests exposed `read_file`, none exposed `tool_search`, and no request failed to parse.

The measurements are observational high-water marks. The live-set value is an upper bound sampled after major GC. Tree RSS includes the daemon and observed descendants and is not unique physical memory. Exact text delivery and usage counters do not prove semantic comprehension or that all prior context remained resident.

### 2.4 Excluded attempts and remaining gaps

Three failed Node 24 attempts remain excluded:

- A long run stopped at turn 13 after returning no required tool call; the response was not archived, so the reason is unknown.
- A baseline long run received a model-serving internal error at turn 22; its full run was retried once with the same collector and workload under a new batch identifier.
- A four-child candidate attempt made two unregistered `tool_search` calls. The later concurrent protocol captured the provider tool-schema surface and reran the complete pair; it does not retroactively validate the failed attempt.

The evidence does not cover multiple retained sessions inside one Node 24 child, broader real-world profiles, materially larger contexts, multi-hour stability, other host partitions or rollout thresholds. Those gaps prevent a production-default claim. They do not require committing every historical raw-derived record to preserve the current scoped conclusion.

## 3. Baseline implementation boundary

| Component                                                 | Current behavior and consequence                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/acp-bridge/src/daemon-memory-budget.ts`         | Resolves the host or cgroup denominator, root reserve and child pool.                                                                                       |
| `packages/acp-bridge/src/child-heap-policy.ts`            | Computes the fixed modeled ceiling and slot count. `off` disables modeling, `observe` reports hypothetical refusals, and `admit` enforces only child count. |
| `packages/acp-bridge/src/spawnChannel.ts`                 | Reserves before deciding and may request idle reclamation, but spawned children still receive legacy heap arguments.                                        |
| `packages/acp-bridge/src/process-registry.ts`             | Counts reservations and attached children until tracked process cleanup proves release.                                                                     |
| `packages/cli/src/serve/idle-acp-reclamation.ts`          | Reclaims only eligible idle runtimes; active or dependent work is excluded.                                                                                 |
| `packages/cli/src/serve/routes/workspace-runtime-stop.ts` | Lets the user inspect and explicitly stop a selected runtime; incomplete cleanup remains visible and accounted.                                             |
| `packages/cli/src/serve/run-qwen-serve.ts`                | Shares one process registry, policy and idle reclaimer across daemon runtime factories.                                                                     |
| `packages/cli/src/serve/daemon-status.ts`                 | Publishes child RSS, heap maxima and coverage while reporting `limits.memory.enforced: false`.                                                              |

Multiple sessions can share one ACP child. Registration count, session count, active prompt count and channel liveness cannot substitute for an actual process reservation. Workspace registration therefore remains independent of child capacity, and a terminating child remains accounted until the existing registry release condition is met.

## 4. Proposed enforcement

### 4.1 Mode and supported wiring

Add experimental opt-in `enforce` to the existing `--child-heap-mode` option and its SDK types. Keep `off`, `observe` and `admit` behavior unchanged. Resolve the mode and budget once before constructing child factories; changing it requires a daemon restart. This proposal adds no environment variable and no workspace registration limit.

The first enforcing path must require the built-in daemon spawn path, one shared process registry and one shared heap policy. Reject unsupported injected bridges or factories before listening. Reject a zero-slot or null-ceiling configuration before preheat. Standalone ACP and IDE callers retain their existing behavior. Direct-embed callers requesting `enforce` without matching managed process wiring fail explicitly, even if an injected status snapshot claims enforcement. Both the normal CLI parser and the serve fast path accept the new mode; the TypeScript SDK exposes the same mode and boolean enforcement status.

### 4.2 Reserve, spawn and release

Reuse `ProcessRegistry.reserve()` and `committedProcessCount`. Reserve first, make the capacity decision with the new reservation included, and cancel the reservation before `spawn()` when refused. Existing error paths must release the reservation if policy evaluation or spawn fails.

For an admitted child, emit exactly one explicit `--max-old-space-size=<ceiling>` and preserve `--expose-gc`. Normalize inherited fixed old-space flags and reject `--max-old-space-size-percentage` in the enforcing path because the percentage flag takes precedence. Preserve unrelated Node options. Check both `process.execArgv` and `NODE_OPTIONS`, including underscore aliases and split values; validate the final child environment after per-spawn overrides. Invalid or conflicting options fail before spawning, without retaining a process reservation. A fixed flag must be emitted even when the parent already has a larger heap limit.

After attach, the process registry owns release. Signalling a process or closing ACP streams is not cleanup proof. Replacement can temporarily require two slots because the old and new children both count until the old child is released. The first version adds no unbudgeted replacement allowance and no waiting queue.

The enforced invariant is limited to:

```text
committed child count × fixed old-space ceiling <= child pool
```

It does not bound ACP RSS, young generation, external buffers, MCP servers, terminals or total daemon-tree memory.

## 5. Failure and status contract

Reuse `acp_child_capacity_exhausted`. REST returns 503 and ACP returns the existing error envelope with equivalent machine-readable metadata. Do not retry automatically or fall back to the primary workspace.

Preserve the capacity cause through existing wrappers, including `StandaloneSessionSpawnError` and `WorkspaceRuntimeInitializationError`, while retaining each operation's rollback and persistence outcome. A factory refusal can occur after worktree, branch or session state changed, so callers cannot assume the whole request is side-effect free.

Set `limits.memory.enforced` to true only for the fully wired built-in enforcing path. Observation refusals remain hypothetical; enforcing refusals mean no new child was spawned. Existing idle reclamation and user-directed runtime stop behavior remain unchanged.

## 6. Verification and delivery

The implementation PR must cover both parsers and every supported child factory; final-slot races; cancellation; synchronous and asynchronous spawn failures; termination overlap; failed cleanup; shutdown; zero capacity; multi-session sharing; full-capacity registration; inherited heap flags; and REST, ACP, standalone and runtime-coordinator error preservation.

Run focused package tests, build, typecheck, bundle and real daemon E2E verification. Confirm the actual child arguments and status output. Local functional verification proves argument propagation, admission and cleanup, not workload capacity. Initially enable only on an isolated daemon after comparing the actual workload with `admit` on the same host partition. Attach an SSE or WebSocket watcher before sampling, then read `GET /daemon/status?detail=full`; compare `runtime.memory.children.heap` with `limits.memory.childHeap.perChildCeilingMb` and record completion, old-generation peaks, major GC and latency. The heap block contains per-field maxima across reporting children, sampling is watcher-gated, and `reported` exposes coverage. Roll back by restarting with `admit` if heap OOMs, lost work or unacceptable workload-specific latency occur. Do not automatically restart into another mode. Broader production rollout still requires explicit GC and latency thresholds.

Implementation acceptance requires unchanged defaults and existing modes, one fixed old-space argument for each supported factory, shared capacity accounting through cleanup, honest status, and unchanged rollback-aware capacity errors. The bilingual design must continue to distinguish local functional validation from the historical Node 24 calibration evidence. The implementation changes the policy, spawn argument handling, CLI parsers and daemon wiring, status/SDK types, related tests and current user documentation; existing wrapper and transport behavior needs regression coverage rather than a new error protocol.

## 7. Open decisions

- Define acceptable GC and latency regressions and the staged rollout and rollback criteria.
- Experimental opt-in uses the existing modeled partition on supported Node runtimes; it is not hardcoded to 544 MiB or restricted by host identity. Calibrate each target workload and partition before production adoption.
- Validate multiple retained sessions per child, broader real-world workloads, materially larger contexts, multi-hour stability and other host partitions before making enforcement the default.
- Capacity refusals retain existing route outcomes: a proven pre-dispatch standalone rollback reports its operation code with nested capacity metadata; uncertain persistence keeps the existing quarantine outcome. Runtime wrappers preserve the capacity cause. Clients must not retry the entire request automatically.

Do not infer these decisions from the earlier registration or RSS capacity experiments, and do not replace the modeled partition with an assumed 16-child limit.
