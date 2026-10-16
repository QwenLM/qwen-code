# Memory Extraction: Baseline First, Then Incremental Input

[English](2026-10-16-extraction-input-and-baseline.md) | [简体中文](2026-10-16-extraction-input-and-baseline.zh-CN.md)

**Status:** Proposed; no runtime change or performance acceptance in this document.
**Date:** 2026-10-16
**Source baseline:** `38d58c63cf2f07835efe168929ceb4b5be813eef` on `main`.
**Tracking:** [#13004](https://github.com/QwenLM/qwen-code/issues/13004), [#13612](https://github.com/QwenLM/qwen-code/issues/13612).
**Paused experiment:** [#13571](https://github.com/QwenLM/qwen-code/pull/13571), converted to draft on 2026-10-16; its code is not the baseline.

## 1. Goal and decision

Reduce the cost of obtaining useful durable memories without adding missed facts, invented facts, foreground delay, or cross-session leakage. Fewer extractor launches and fewer raw input tokens are intermediate metrics, not the goal.

Proceed in this order:

1. Measure the current implementation with fixed fixtures and request attribution.
2. Test incremental extraction input while preserving the current scheduling cadence.
3. Consider content gates or batching only if measured residual cost justifies them.

A completed extraction that saved nothing describes past input. It does not establish that the next turn contains nothing useful. Do not ship a cooldown based on that inference. Keep #13004 open as the cost/quality acceptance track and #13612 open as the input/lifecycle correctness track; neither is a completed replacement PR.

## 2. Current behavior and evidence limits

| Surface           | Current behavior at the source baseline                                                                                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal model loop | `LlmClient.runManagedAutoMemoryBackgroundTasks()` schedules extraction for eligible completed user queries when managed memory is enabled; internal session-agent conversations are excluded.                                                                                                                                                            |
| ACP               | `Session.#recordPromptCompletionEffects()` schedules after a fresh successful logical user turn, not a retry, cancellation, or loop-protection stop.                                                                                                                                                                                                     |
| Manager           | `MemoryManager.scheduleExtract()` checks direct memory writes and serializes/queues extraction; `runExtract()` checks memory pressure.                                                                                                                                                                                                                   |
| Cursor            | One project-level cursor stores `{ sessionId, processedOffset, updatedAt }`. A different session resets its offset to 0, and a history shrink resets only when the stored offset exceeds the new length. `runAutoMemoryExtract()` uses this raw-history offset to detect new nonempty user text; it does not pass that unprocessed slice to the planner. |
| Extractor input   | `captureCacheSafeParams()` captures the last 40 curated entries and slims them. `runAutoMemoryExtractionByAgent()` sanitizes that captured history and passes it as `extraHistory`. Raw history, curated/slimmed history, and sanitized extractor input therefore have different positions.                                                              |
| Actual execution  | The planner calls `runForkedAgent()` without `cacheSafeParams`, selecting the headless-agent branch and its `initialMessages`. The separate `createForkedChat()` 40-entry cap belongs to the cache branch; it is not a second cap on this extraction path.                                                                                               |
| Success/failure   | Writes or path-bearing tool activity can advance the cursor. Zero path-bearing tool calls hold it back; errors retain retry behavior. Tool activity is not proof of a successful memory read.                                                                                                                                                            |

The sibling [memory-system.md](memory-system.md) documents the same subsystem, but its 提取游标 section still records `processedOffset` as advancing to `params.history.length` after every extraction. That matches only the early return where the unprocessed slice holds no new nonempty user text; on the completed-extraction path the offset advances only when the run made genuine progress, which is the rule this design's acceptance criteria and required-failing regression assume.

The extractor defaults to the fast model when configured and uses its own system prompt, so it cannot assume prefix-cache sharing with the main conversation. Its 40-entry window also slides once history exceeds 40 entries. Re-reading context may still hit a provider cache, while a moving delta may reduce raw input but change cache reuse. The headless result aggregates input/output/total tokens without cache read/write fields, so cache accounting must come from provider responses or request capture. Neither savings nor safe default-on rollout follows from the source inspection alone.

Historical measurements in #13004 identify substantial background request volume, including zero-write runs. They are not acceptance results for this baseline or the proposed input change. Multiple provider requests may belong to one extractor's tool loop; count tasks and requests separately.

Claude Code 2.1.301 static inspection found direct-write/prose gates and a configurable every-N-turn cadence, but no completed-noop cooldown. Service-side gate values and real user defaults were not observed. This comparison is context, not justification for adoption. In particular, `用中文` or `别用 npm` can be durable instructions despite being short.

## 3. First PR: reproducible baseline measurement

This PR must not change extraction frequency, cursor semantics, prompts, model choice, or lifecycle waiting. Reuse existing test/provider capture infrastructure and extraction/API telemetry before adding observability. Add only missing task-to-request correlation or numeric counters; never log prompts, memory bodies, physical memory paths, credentials, or internal account identities to shared telemetry.

### Setup

- Pin the source SHA, CLI entrypoint, provider, resolved main/extractor models, generation options, and memory protocol.
- Use synthetic fixtures and isolated configuration, project/user memory, session storage, and workspaces. Do not read or overwrite the operator's real memory or settings.
- Verify the installed CLI separately. The local `qwen --version` preflight returned `0.25.0`; that installed release is not interchangeable with the pinned source baseline. No conversational model run has been performed for this design.
- Keep Dream, recall, migration, permission classifiers, and foreground calls attributable separately. If isolation needs a setting change, apply it only to test configuration and use it identically across variants.
- Wait for observed extraction settlement in the harness before scoring. Record pending/timeouts explicitly rather than calling them zero cost or no-op.

### Metrics

For each task, retain its synthetic session identity, trigger, bounded history range, outcome, request IDs, model, provider-reported usage, and observed final memory state. Record:

- extractor launches versus API requests per launch;
- provider input/output/cache-read/cache-write token fields, preserving provider semantics;
- request payload sizes split into extraction instructions, memory manifest, historical context, and new content;
- extraction and whole-process estimated cost using verified provider rates, or `unavailable` when rates/usage are missing;
- foreground completion time, extraction settlement time, and pending work at each boundary;
- expected durable facts saved, missing, delayed, contradicted, and spurious; delay measured in turns and elapsed time.

Payload character counts are not exact component token counts. Use a provider-compatible tokenizer if available and label component token counts as estimates. Do not equate raw input with uncached/billable input or add overlapping cache fields twice. Compute P50/P95 only from an adequate disclosed sample; no invented percentiles from a handful of runs.

### Fixed fixture corpus

Use the same starting memory snapshot and literal turns for baseline and later candidate runs. The tool-heavy case uses the existing controlled provider with synthetic repository data; it must produce more than 40 curated entries in one logical turn.

| Case                           | Literal input or sequence                                                                                                                                                                         | Quality oracle                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient                      | `17 * 23 等于多少？这只是一次计算，不要保存为记忆。`                                                                                                                                              | Correct answer; no invented durable preference.                                                                                                                         |
| Short preference               | `以后用中文回答。`                                                                                                                                                                                | Persist the language preference.                                                                                                                                        |
| Correction                     | `不要用 npm 安装依赖，这个项目统一用 pnpm。`                                                                                                                                                      | Persist the collaboration constraint.                                                                                                                                   |
| Context-dependent confirmation | Agent proposes a synthetic project convention; user says `好，就按这个来。`                                                                                                                       | Preserve the confirmed decision with its antecedent, not unrelated older proposals.                                                                                     |
| Duplicate                      | Repeat a preference already present in the initial memory snapshot.                                                                                                                               | No contradictory or duplicate durable facts.                                                                                                                            |
| Long tool turn                 | Introduce a preference, then produce more than 40 curated entries in one logical turn before extraction can settle.                                                                               | Candidate target: preference appears in actual extractor input and persisted memory. A baseline omission is recorded as a measured loss, not a harness failure.         |
| Final-turn fact                | State a durable preference and immediately request ACP close or end a one-shot run.                                                                                                               | Record whether it was saved before return, saved later, or left pending; do not assume a drain exists.                                                                  |
| History replacement            | Introduce a fact, then exercise compression and clear/resume/branch/rewind using supported lifecycle calls; include compression where the new history length is still at least the stored offset. | Report baseline retention and identity boundaries without assuming these routes share one history generation; record silently skipped post-compression content as loss. |
| Concurrent sessions            | Interleave distinct synthetic facts in two sessions/workspaces, including extraction queuing.                                                                                                     | No cross-session input or memory contamination; no silent superseding of pending ranges.                                                                                |
| Failure/retry                  | Inject a provider/read failure, and separately a successful write followed by a later failure.                                                                                                    | Retain unprocessed work; retry does not erase committed facts or advance beyond covered input.                                                                          |

Controlled-provider execution proves payload, cursor, and lifecycle contracts, not real-model memory quality or savings. Real-model evaluation must use the same corpus and blind fact-level scoring. Start with five repetitions per cost/quality fixture and model; counterbalance baseline/candidate order, reset memory/session state, record warm/cold cache conditions, and report per-pair results. Expand the sample if results are unstable. Local cache reset does not prove that the provider cache is cold.

### Completion gate

Deliver a rerunnable harness, retained assertions, raw private evidence, and a sanitized report. The report must identify attribution gaps and avoid causal cost claims until paired candidate runs exist. Reuse `extract.test.ts` and `memoryLifecycle.integration.test.ts` for existing invariants; their mocked planner tests do not establish which messages reach the real outgoing model request.

## 4. Second PR: incremental input, unchanged cadence

Open a new focused PR against `main`, not on top of #13571. It implements the verified input contract and compares against the first PR's baseline. It does not add a cooldown, word-count filter, new user setting, or a durable replay subsystem.

### Ownership and input

- Capture accepted complete-turn content at its owning boundary together with project/workspace, session, and history-generation identity. Do not reconstruct it later from another session's latest cache slot.
- Within that generation, maintain a covered offset and an immutable task end offset. Distinguish raw-history coordinates from curated/slimmed and sanitized input positions; never use one as another's index.
- Construct explicit extractor input from the unprocessed range. Include the nearest complete preceding user turn as read-only context when needed for references/confirmations; context overlap is not newly covered input.
- Keep existing sanitization, memory-root confinement, model/provider selection, and metadata writers. Preserve valid tool-call/result grouping; hidden reasoning and runtime reminders remain excluded.
- Bound input by the resolved model's context budget. Split oversized ranges at complete logical-turn boundaries; if one turn alone is too large, chunk its content with source ranges and minimal antecedent context, preserving tool protocol. Never acknowledge content removed by a tail cap.

The current single project cursor cannot represent independent pending ranges for interleaved sessions or a compression generation. The implementation PR must define the smallest owner/generation-scoped cursor change and migration; do not silently interpret old offsets as durable message IDs.

### Completion and retry

A completed extraction advances only through the input range the task actually covered, even if a later turn arrived while it ran. Context overlap does not advance the covered offset. Failure, cancellation, zero-tool hallucination guard, or index-commit failure must not mark unseen input processed. Preserve existing asymmetric user/project index failure semantics unless an independently verified defect requires a scoped change.

Extraction is at-least-once on retry, not exactly-once transactional writing. Use existing memory reconciliation to avoid duplicate/conflicting facts; do not introduce a transaction framework. A direct main-agent memory write does not prove that every pending fact in earlier turns was saved. Preserve that pending range and serialize writes with extraction; reject stale outcomes from a changed owner/generation.

Queued requests must preserve their actual covered ranges and owners, not only the latest history length. Do not solve multi-session queuing by falling back to another session's cache.

### Lifecycle limits

Retain the accepted input snapshot until it is acknowledged or explicitly cancelled. Compression or a session switch must not silently destroy it. Wire the minimum generation/invalidation handling needed by the input contract; do not add model waits to every command as a substitute for ownership.

If a boundary cannot safely retain its snapshot, it must have a bounded flush or report an explicit pending/cancelled outcome, not success. Process exit/crash recovery remains outside this PR; its report must disclose unpersisted pending work. Reading durable transcript positions for restart recovery is a separate design, not an assumed property of the raw cursor.

### Acceptance

1. Actual outgoing requests contain an early fact from one logical turn with more than 40 curated entries and retain context-dependent short confirmations.
2. Already covered content appears only as bounded antecedent context, not as repeated extraction input.
3. New work arriving during extraction remains pending after the older task completes.
4. Failures and successful-write-then-failure preserve retryability without corrupting stored facts.
5. Compression, history replacement, rewind, and interleaved sessions cannot advance another owner/generation or falsely acknowledge lost content.
6. Fact-level quality does not regress in fixed fixtures or paired real-model runs. Report raw and estimated billed cost independently; fewer input tokens alone is not acceptance.

The controlled provider must use the real CLI/ACP process and inspect payload plus persisted memory/cursor state. Plausible regressions that must make tests fail are restoring the 40-entry input tail, using raw offsets on curated input, advancing to latest history length, or using another session's captured history. Enhance existing tests where they protect the same contract instead of adding duplicate mocked cases.

## 5. Deferred experiments and rollout

Only consider content-based gating or deterministic batching after incremental-input acceptance and a material measured residual cost. A length threshold is not a durability classifier, and every-N-turn batching is not inherently safer than a noop cooldown.

Any deferral must retain input, define a maximum freshness delay, account for all lifecycle boundaries, and demonstrate costs including flush/retry runs. No default-on rollout follows from this document. A negligible saving or a quality/cache regression is a valid reason to keep the current cadence.

## 6. Delivery and open decisions

| Work              | Next artifact                                               | Prerequisite                                                        |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| This design       | Local bilingual documentation; no replacement PR number yet | Pause of #13571 actioned; this design awaits maintainer review      |
| Baseline          | New measurement-only PR for #13004                          | Pin entrypoint/models and verify request attribution                |
| Incremental input | New focused implementation PR for #13004/#13612             | Baseline evidence and resolved cursor/generation contract           |
| Gating/batching   | Optional later experiment                                   | Quality-preserving incremental input and demonstrated residual cost |

Open decisions before the implementation PR: exact input budget, oversized-turn representation, owner/generation cursor shape and migration, write serialization, and safe ownership of retained input at lifecycle boundaries. Do not present those unresolved details as implemented guarantees.

Formatting and relative-reference checks validate this documentation only. No build, unit suite, controlled-provider run, real-model baseline, savings estimate, or implementation PR is claimed by this document.
