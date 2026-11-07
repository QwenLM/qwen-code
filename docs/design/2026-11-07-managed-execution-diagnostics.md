# Managed Tool v4 executor measurements

[English](2026-11-07-managed-execution-diagnostics.md) | [简体中文](2026-11-07-managed-execution-diagnostics.zh-CN.md)

## Status and baseline

This design narrows PR #16498 after the author selected #16499 as the baseline. The prerequisite remains #16475; the initial integration base is `d886d0640a623928cea4507a413a1f1899bb1e8a`. Implementation and final CI acceptance are tracked separately.

The baseline owns invocation identity, activity evidence v1, incremental SQL projections, authorized activity queries, the statistics panel and the child invocation tree. This increment extends those paths. It does not restore the earlier `execution_diagnostics` domain, a second collector, `/stats.execution`, or a second graph.

## Remaining behavior

An ordinary Hosted Runtime can report its actual execution duration and the native file changes it measured. The existing activity view must retain those measurements after Runtime shutdown and replay. A successful filesystem operation remains successful when formatting, output limits or delivery later fail.

| Measurement        | Meaning                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution duration | A nonnegative integer measured with the executor's monotonic clock around the actual invocation. Approval, queueing and result publication are excluded. |
| Model lines        | Added/removed lines between the original content and the model proposal.                                                                                 |
| Applied lines      | Added/removed lines between the original content and the final applied content.                                                                          |
| File scope         | Only successful native `read_file`, `write_file` and `edit`; Shell and MCP internals are not inferred.                                                   |

Line counts accumulate per operation, including repeated edits; they are not a Git diff and undo does not subtract earlier work. Explicit zero, unchanged content, unmeasured content and missing evidence remain distinguishable. Background Shell/Monitor measurements cover only their launch invocation. Execution duration is not presented as end-to-end invocation latency, and timestamps from separate processes are never subtracted.

The Harness compares the persisted model request with the persisted dispatch input and records bounded proposal provenance (`original / modified / unknown`). If a Hook or approval changed the input, or the original input cannot be proven, model line counts are not exposed as measured samples. Applied line counts and execution duration remain available. No original content is copied into diagnostic evidence.

## Runtime protocol

Tool v2/v3 remain closed and unchanged. Tool v4 exposes `execute`, `status`, `cancel` and `acknowledge` under `/internal/managed-runtime/v4/`. Its request selects an underlying execution protocol, 2 or 3. Its response wraps that original result with `managed-tool-measurements/1` and a canonical digest of the complete result and measurement packet.

The packet contains only a nullable execution duration, a physical execution outcome and a nullable native-file measurement. File measurements contain operation/status and nullable model/applied line counts. They contain no paths, file contents, patches or Skill text. Parsing is closed, integers are bounded and the reference packet is bounded to 4 KiB.

A new attested ordinary Workspace capability explicitly advertises v4. Existing ordinary, extension, resident and CSI digests retain their meanings. Protocol selection happens before dispatch. A lost v4 reply is followed by a status query for the same execution; it never falls back to a v2 re-execution.

The Worker freezes result and measurement together before settlement. The Broker validates the canonical digest and persists the combined result using its existing result/version CAS before ACK. A v3 publication that settles before the measurement arrives is reconciled against the same original execution and result. ACK carries the original frozen digest; v3 capture, manifest, publication receipt and reclamation rules are preserved.

## Existing activity projection path

```mermaid
flowchart LR
  W[Executor result and measurements] --> B[Broker durable result]
  B --> H[Hosted completion writer]
  H --> J[tool.measured source event]
  J --> P[Existing ActivityProjection]
  P --> Q[Existing authorized activity queries]
  Q --> U[Existing activity view]
```

A dedicated `tool.measured` source event references the original `toolOutcomeRef` and an immutable `managed-tool-measurements` resource. The resource binds the packet and frozen result digest to the execution call and existing invocation identity. This is source evidence for the existing ActivityProjection, not another collector or projection domain.

Some v3 receipts commit during Worker publication, before the v4 result freezes. Enriching those receipts afterward would change their immutable identity and closed publication contract. The separate event preserves both v2/v3 results and all original receipt bytes. It commits before model-result delivery or ACK, including blocked delivery, and does not authorize dispatch, create an invocation, invalidate Context or settle execution. A v2 results-ready checkpoint remains distinct from a receipt.

The Harness freezes packet bytes and the measurement command identity. On recovery it first checks committed evidence; exact replay changes no total and conflicting evidence is rejected. The event and the existing activity updates share one journal transaction and the writer/activation fences. The reducer verifies kind, version, digest, byte bounds, outcome provenance and the existing execution-to-invocation link. File measurements must match the resolved native tool. No database table or public write endpoint is added, and no tool is re-run to improve diagnostics.

After the measurement event commits, later cancellation or delivery recovery may produce a different conversation outcome. Replaying the same frozen measurement retains the original event and outcome reference. A proven Shell completion or native-file effect remains successful execution evidence even if cancellation changes the conversation result.

Aggregates are added to the existing overall tool/file metrics and three file-operation groups. Per-tool buckets retain the baseline's bounded representation; executor measurements remain available in paginated invocation details. This avoids multiplying the retained bucket payload while preserving cumulative measured totals.

Measurement fields are added lazily, only when measurement evidence exists. Unmeasured activity-v1 and CSI `/3` records must preserve their previous projection bytes. Internal references and digests are not exposed in activity responses; public additions contain bounded measurements, source sequence and aggregate decimal-string counters.

## Coverage and presentation

The existing tool/file summaries and invocation details show executor duration, valid sample counts and model/applied line changes. Means divide by measured samples, never by all requests. Missing measurement fields in older rows mean not recorded. Partial coverage is shown when recorded measurements cover only part of the relevant activity, and unsupported profiles do not become zero-valued samples.

The measurements reuse the activity query's authorization, passive reads, pagination and `no-store` behavior. No Runtime attach, MCP discovery or filesystem read is added to queries. The existing child invocation tree and its authorization limits are unchanged.

## Compatibility and rollout

The new source event requires Session storage floor 5, HTTP reader version 5 and native reader capability `managed-session/3`, distinct from the database schema version. Promotion depends on the committed measurement event/reference, including replay of an already stored resource, not merely on newly uploaded bytes. New readers deploy before measurement producers; older readers cannot acquire a floor-5 Session.

Set `QWEN_MANAGED_AGENT_RUNTIME_TOOL_MEASUREMENTS=true` (default `false`) to select the measured profile for newly resolved ordinary bindings after compatible readers and Workers deploy. Existing bindings keep their attested capability. Measurement commits also require the baseline activity evidence and a storage-version-5 grant; there is no second collector switch.

CSI `/1`, `/2` and `/3` keep their existing storage support of 1, 3 and 4. CSI `/3` activity evidence remains supported; this increment adds no CSI executor measurement capability. An ordinary measurement profile must not widen extension/resident/CSI admission. Resource snapshots, recovery and permanent deletion retain the new reference closure through the existing mechanisms.

## Implementation boundaries

| Layer              | Increment                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Core               | Bounded measurement contract/fixture, measurement event/reference and reference/version validation.                                |
| Runtime and Broker | Attested v4 wrapper, monotonic/native-file measurements, frozen result persistence, status/cancel/ACK recovery.                    |
| Hosted             | Carry Broker measurements into live and recovered completion writers and release transient measurement state after durable commit. |
| Server             | Extend the existing activity reducer, storage/reader gates, snapshot closure and existing activity response schemas.               |
| WebShell           | Extend current summaries/details and bilingual labels; regenerate API types.                                                       |

## Verification and acceptance

Shared TypeScript/Java fixtures cover integer/null/status validation and canonical digests, including UTF-8. Focused tests cover duplicate requests/results, v4 status/cancel/ACK, publication-before-measurement races, output failure after filesystem success, model/final content differences, unchanged files and legacy compatibility. Measurement binding, replay, counter replacement and snapshot closure require transactional tests.

The test engineer runs the relevant packaged Worker path and browser presentation checks using the existing test-script fallback where no public CLI command exposes an internal contract. Presentation fixtures do not replace real Worker/Broker, MySQL or recovery acceptance. Root build/typecheck/bundle, affected TypeScript tests, API/SurfaceRegistry validation and generated-type checks remain required.

Java verification continues the existing ten-minute ledger; it is not reset for this integration. Focused checks consume only the remaining budget. Full Java, MySQL, Hosted/fault, native CSI and SpotBugs gates remain in CI, and any unexecuted real path is reported explicitly. Success means one frozen execution contributes once, offline activity retains known measurements, and legacy/unmeasured data remains clearly distinguishable.
