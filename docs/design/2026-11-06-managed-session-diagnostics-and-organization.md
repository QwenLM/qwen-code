# Managed Session Diagnostics

[English](2026-11-06-managed-session-diagnostics-and-organization.md) | [简体中文](2026-11-06-managed-session-diagnostics-and-organization.zh-CN.md)

Status: implemented locally with focused verification; full CI acceptance is pending. Date: 2026-11-06. Investigated baseline: `1bac51b7d9`. This design and its [implementation plan](../plans/2026-11-06-managed-session-diagnostics-and-organization.md) replace the earlier, broader proposal at these paths. The filenames remain stable for existing links. The plan records actual verification and remaining gaps; no deployment is implied.

## 1. Scope and current gap

The requested work has three parts: (1) request context and cumulative model statistics, (2) Skills/MCP inventory, and (3) direct child-agent invocation relationships. Managed already has basic model context, persisted legacy model usage, task pages, and child-session history. Complete these diagnostic views through Managed Public API and WebShell using the existing Session authority.

The first part contains two distinct views: the last committed main-model request's context and cumulative model calls. Resource inventory describes configured Skills/MCP and persisted discovery; it is not Runtime CPU/RSS or a blob browser. Agent trace describes existing invocation relationships, not OpenTelemetry or a new recursive execution graph.

Out of scope: Session organization, Sources/`record_source`, PR metadata, arbitrary metadata updates, tool/file/Skill invocation statistics, new child execution capabilities, Runtime prewarming, and new database tables or DDL. Do not broaden an existing CSI profile's execution capabilities to deliver diagnostics.

## 2. Owning code and reuse

| Area                  | Existing owner and reuse boundary                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actual model requests | [Hosted model loop](../../packages/cli/src/serve/hosted-harness-model.ts), hook/compression callers, and the ContentGenerator boundary; never process-global usage                                                                                                                                                       |
| Context estimates     | [contextCommand](../../packages/cli/src/ui/commands/contextCommand.ts); extract only pure measurement inputs/logic needed by Hosted                                                                                                                                                                                      |
| Persisted model usage | [Managed hook activation](../../packages/core/src/managed-runtime/managed-hook-activation.ts), main/hook usage resources and existing native commit boundaries                                                                                                                                                           |
| SQL projections       | [ManagedExtensionRecordStore](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedExtensionRecordStore.java); existing `hosted_context_usage/latest` pattern                                                                                             |
| Base Skills           | [ManagedSessionSkills](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionSkills.java); creation snapshot or pinned definition                                                                                                                   |
| Extensions            | [HostedExtensionSession](../../packages/cli/src/serve/hosted-extension-session.ts), `config_install` and immutable bundle/contributions resources                                                                                                                                                                        |
| MCP observations      | [ManagedMcpCatalogService](../../packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/catalog/ManagedMcpCatalogService.java); reuse safe display projection, not its unbounded history query or live-management path                                                             |
| Child relationships   | [ManagedTaskService](../../packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/session/ManagedTaskService.java), task projections and stored Session lineage                                                                                                                    |
| WebShell              | [Managed provider](../../packages/web-shell/client/components/managed/managed-agent-provider.ts), [ManagedSessionsPage](../../packages/web-shell/client/components/managed/ManagedSessionsPage.tsx), and [ManagedChildSessionView](../../packages/web-shell/client/components/managed/ManagedChildSessionView.tsx)       |
| Public contracts      | [OpenAPI](../../packages/managed-agent-server/contracts/src/main/resources/openapi/managed-agent-public-api.openapi.json), [SurfaceRegistry](../../packages/managed-agent-server/verification/src/test/java/com/alibaba/qwen/code/managedagent/api/SurfaceRegistry.java), generated WebShell types and capability parity |

The existing slash-command Skill query omits model-only Skills and dynamic extension contributions. The existing MCP catalog may retain an older published catalog when a newer attempt has no catalog. Neither result alone describes the full configured inventory. Legacy cumulative `models` snapshots must never be summed or copied as an unbounded dictionary into the new diagnostic resource.

## 3. Read contracts, authority and availability

Both transports use the same authorized application services:

| Public GET                               | WebShell POST                                         | Response meaning                                      |
| ---------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `/v1/agents/sessions/{id}/context-usage` | `/api/agent/web-shell/v1/session-context-usage/query` | Last committed main request context                   |
| `/v1/agents/sessions/{id}/stats`         | `/api/agent/web-shell/v1/session-stats/query`         | Session-owned cumulative model statistics             |
| `/v1/agents/sessions/{id}/resources`     | `/api/agent/web-shell/v1/session-resources/query`     | Configured Skills/MCP and bounded persisted discovery |
| `/v1/agents/sessions/{id}/agent-trace`   | `/api/agent/web-shell/v1/session-agent-trace/query`   | Page of direct child-agent invocations                |

Use `requireReadableSession` and existing authenticated actor/Workspace grants. Preserve non-disclosing 404 behavior for foreign, deleted or unauthorized Sessions. Child drill-down additionally verifies the persisted relationship and the child's own read permission. Responses are private and non-cacheable; they never expose private resource references, writer credentials, commands/environment/secrets, raw prompts/errors, or host paths.

All reads are passive and available for readable idle, closed, archived, recovery-blocked and offline Sessions. Do not acquire, warm, attach, recover or resume a Harness/Runtime; do not call MCP management or rediscovery. Deleted Sessions are not readable. No recorded observation, a known zero, partial coverage, stale evidence and an unsupported collector remain distinct.

Return Session identity, schema/observation revisions and explicit availability/coverage. Use decimal strings for potentially unsafe journal/snapshot integers. A request's persisted facts are read under one short `managedAgentTransactionManager` read-only `REPEATABLE_READ` transaction using ordinary SELECTs. Read the journal head and referenced rows/resources in that same view; a `readRevision` is a persisted read boundary, not a live Runtime observation time. Keep `readRevision`, `snapshotRevision` and active configuration revision distinct.

## 4. Last committed request context

Capture the actual prepared main-model request after model/tool selection and context installation. Publish its diagnostic snapshot only with the corresponding durable main output; Hook or compression requests do not replace the main-request context. A failed/uncommitted newer request does not make an older snapshot current. Bind the snapshot to its request/attempt, selected model, configuration/context and compaction facts, and retain explicit stale/partial reasons across fallback, model changes, compaction and recovery.

The current persisted context pointer records invalidation, not a detailed cause history. These invalidations expose the shared `context_changed` stale reason; this slice does not claim to distinguish model, configuration and compaction causes after recovery.

Provide exactly these independent local estimate categories:

- `systemPrompt`
- `builtinTools`
- `mcpTools`
- `instructionFiles`
- `memoryFiles`
- `skills`
- `startupContext`
- `messages`

Provider-reported totals remain separate from local estimates. Cached tokens overlap input and are not added to categories; reasoning/output overlap is normalized by the existing provider semantics. Do not scale categories to match a provider total. Missing provider usage remains unavailable. Use the actual selected model/window and Hosted compaction policy; this view is not a next-request preview.

Measure from explicit prepared-request components and bounded attribution supplied by the owner. Preserve attribution before private rendering discards it, without retaining bodies. Omit raw prompt text, file contents, tool arguments, Skill bodies and absolute paths. This slice stores the bounded eight-category summary; it does not add unbounded per-file/per-tool drill-down, a second request journal, or daemon-local Config loading.

## 5. Cumulative model statistics

A call is one ContentGenerator invocation, not one user Turn and not each internal physical retry. Record calls, provider-normalized tokens, terminal outcome, observed timings/TTFT and backoff-retry counts. Outcomes are `success`, `error`, `cancelled` and `interrupted`. Report missing usage/timings as missing; a request interrupted before a durable outcome has a coverage gap, not invented provider billing.

Use three source classes: `main`, `hook` and `compression`. Auxiliary model work is charged to its owning source. Include manual and automatic compression where that profile already supports them. Parent and child Sessions own separate statistics; do not add child totals into the parent's totals or aggregate unreadable children. Tool/file/Skill execution measurements remain outside this slice.

Keep at most 16 named model buckets plus an explicit overflow bucket. Keep at most 20 recent samples for the whole Session, not 20 per model/source. Counts are cumulative; recent samples are bounded evidence and not a second counter source. Streaming and non-streaming success, error, cancellation, Hook requests, compression and retry backoff must all use the same collector semantics.

Outcome totals must reconcile using saturated integer addition in both Java and TypeScript, including overflow buckets. Committed malformed diagnostics fail closed: skipping a corrupt resource would discard the accumulator revision and billing-budget baseline, so recovery must not continue with reset totals.

Recovery reads maintenance carriers and statistics in batches of at most eight, then folds results in the original reference order. It still verifies every historical carrier and retains same-revision conflict detection and highest-revision selection; this bounds concurrency, not total history. A recovery-generated Turn settlement carries a budget only when its Session and Turn identities match that settlement. Otherwise its budget is null while cumulative statistics and raw-output accounting remain intact.

Collect synchronously in memory. At the existing native `runSerial` commit boundary, freeze pending deltas, fold them into the newest committed baseline and allocate `snapshotRevision`. Retry the exact frozen bytes rather than recomputing the same delta. A later queued commit must fold from the latest baseline so nested Hook/compression work cannot be lost or counted twice. Recovery restores committed totals before new deltas; an unclosed native owner leaves a sticky coverage-gap marker. Replayed terminal events and duplicate commits do not increment counters again.

## 6. Resource budgets and persistence compatibility

The diagnostic usage resource remains within the existing UTF-8 64 KiB inline limit. Partition that envelope as follows: statistics 40 KiB, context 8 KiB, envelope plus budget state 12 KiB, and 4 KiB reserve. Apply bounds before publication, including Unicode byte counts. Overflow/truncation is explicit. Do not store raw prompts/errors or the legacy `models` dictionary. Preserve the budget's raw-output total as a separate scalar, `rawOutputTokensTotal`; normalized diagnostic output must not silently replace its semantics.

The internal `rawOutputTokensTotal` and `budget.outputTokensAtTurnStart` scalars preserve finite, nonnegative ledger values up to `Number.MAX_SAFE_INTEGER`, including fractional legacy provider values, across warm and cold recovery. Preserve their values without rounding and compare persisted totals numerically without integer truncation. The public statistics projection omits both budget scalars. Normalized metric counters and snapshot revisions remain safe integers; diagnostic counters include the full safe-integer maximum independently of the extension-record ordinal ceiling.

Reapply the context bound after assigning the actual attempt identity and provider usage. A diagnostics-only prepared-request observer uses the existing zero snapshot budget and measures its synchronous borrowed input without cloning it. A model window is known only when it is a positive safe integer; an absent observation timestamp remains unknown in the UI.

Use main/hook usage v2 resources. Automatic compression is included with main terminal output or a `turn.settled` usage reference. A new maintenance v2 record carries `modelStatsRef`; its candidate is published before `PostCompact` so later Hook work can build on the correct baseline. Existing active v1 maintenance chains may finish with partial coverage. Leave `context.compacted.tokenCountsRef` unchanged. Do not add a native domain, a Stage H family, or a request journal.

Reuse `ma_session_record` for derived `hosted_context_usage/latest` and `hosted_session_statistics/latest` projections. Updates are atomic with the source commit and resource references. Use a common highest-`snapshotRevision` rule to reject regression: a main r1 reference, followed by Hook r2, followed by an older r1 reference must retain r2 statistics. A Hook-only snapshot must not substitute Hook context for main context. Preserve applicable resource closure, retention and recovery checks; no DDL is required.

Deploy control-plane readers for storage versions 1/2/3 before writers. The first v2 diagnostic write advances the stored reader floor to storage 3; an old worker is rejected with 409 instead of silently dropping diagnostics. Keep existing CSI behavior and `csi-files-retirement/1` intact. Add `csi-files-retirement/2` with its own manifest/proof for diagnostics-aware transfer, without making unsupported manual compression or other execution paths newly available. Old/v1 Sessions retain explicit partial legacy availability.

Both CSI profiles still admit main-model attempts and file-history advancement only; Hook and manual-maintenance execution remain unavailable. The SQL inventory recognizes the shared diagnostic carrier kinds, while context projection uses only main carriers. `/2` is selected from the pinned immutable definition and enabled collector, not inferred by relaxing native activation proof.

## 7. Skills and MCP inventory

Resolve base Skills through the immutable creation snapshot or pinned definition, then merge Skills from the last activated extension bundle. Reuse the existing verified contributions manifest/parts reader. Include name, description, model/user invocability and known base/extension attribution. Commands sharing the Skill loader remain separately typed. There is no fabricated per-Skill live-enabled or loaded marker, and no attempt to reconstruct disabled local Skills that were never imported.

Read the current `config_install/hosted-mcp-settings` directly. Legacy settings supply selected enabled/disabled/removed servers. For package configuration, use the current active `bundleRef`; otherwise follow the predecessor chain to the last active record, reading at most 64 configuration records including the current record. Only after reaching the actual package-history boundary may the first package record's previous bundle supply the baseline. Detect broken references/cycles. On budget exhaustion, mark configuration partial/unknown; do not silently replace unresolved extension state with an apparently complete base inventory.

The active bundle's `independentMcpSelections` retains independent disabled/removed entries; its `mcpServers` is the effective enabled combination including extension servers. Preserve both meanings. Project public display fields only. Determine extension attribution from the actual package contribution mapping, not a guessed identifier prefix.

Scan at most 256 `mcp_configuration` history rows, with one additional sentinel row to determine coverage. Use the existing `(session_scope_key, domain, delivery_state, gmt_create, record_key)` index with `domain='mcp_configuration'` and `delivery_state IS NULL`; MCP records have no delivery. All resource reads together are limited to 8 MiB and the public result to 1 MiB. Hitting any limit produces explicit partial coverage, not silent omission. Do not add a derived MCP index in this slice.

Configuration selection, latest attempt, published catalog and live health are separate facts. With complete history, select by recorded `configRevision`, retaining pin/revision identity; with partial history, results are bounded historical observations and latest/missing remain unknown. An old successful catalog cannot mask a newer failed attempt. Even `active` plus `settled` does not prove a live connection. Release/disabled states remain visible, and tools/resources/prompts have independent discovery coverage. `gmt_create` is operation creation time, not last observation; do not invent `observedAt` from the query time.

Return `serverRevision` for the selected pin, `attemptRevision` plus `attemptServerRevision` for the latest recorded attempt, and `catalogRevision` plus `catalogServerRevision` for published discovery. `lastAttemptState` is the logical run state; `lastExecutionState` is the physical execution state. These are different even for a failed request whose execution conclusively settled. When history is incomplete, the attempt fields and `releaseState` are null; retain any observed catalog as `historical` with stale/unknown discovery. Nullable fields remain present in the response.

Output bounding removes Skills before dropping MCP history, and history completeness is normalized after any capability truncation. Removing Skills alone cannot invalidate complete MCP attempt evidence. Surface output truncation, partial discovery and individual coverage reasons separately.

## 8. Direct child invocation trace

Return only direct `child_agent` task records owned by the requested parent Session. Public child admission currently requires depth 1 and the Hosted Agent tool requires parent depth 0. A recovery parser accepting older depths up to 8 does not advertise nested public execution. Do not construct a recursive tree or accept a daemon-style `rootAgentId` filter.

Filter `task_kind='child_agent'` in SQL before pagination. Use `(gmt_create DESC, record_key DESC)` with limit 1–100 and a cursor bound to tenant/actor, parent Session and query version. Invocation `taskId` and optional `childSessionId` are distinct identities. Return only recorded description, state, timing and relationship facts; repeated agent types remain separate invocations. If a predecessor relationship is exposed, it must come from the actual record, without recursive reconstruction.

Reuse task details/events and `ManagedChildSessionView` for drill-down. A child link requires the recorded parent/run relationship and independent child authorization; `childTaskDetails` alone does not provide actor-level authorization. Missing, deleted or inaccessible child detail does not erase the parent invocation. Retained-away events and no invocation are different states. Trace queries never restore a child or return private checkpoint/input references.

## 9. WebShell integration

Add an optional typed `diagnostics` provider surface backed by generated OpenAPI types. One Managed diagnostic panel has four tabs: Context, model statistics, resources and agent trace. Both home and non-home headers can open it. Availability is based on read capability, not send/interactive or MCP-management permission, so closed/offline history remains usable.

Reuse pure presentation elements from existing context/token/MCP views. Do not synthesize a full `DaemonSessionActions` adapter or reuse daemon polling/action hooks. The trace tab uses a paged direct-invocation list and the existing child viewer, rather than implying a complete daemon graph.

Refresh visible statistics and trace every 5 seconds while the Session is active. Context/resources are fetched on demand and explicitly refreshed when relevant configuration changes. Stop polling when hidden/closed. Clear old data and ignore late responses on Session/provider/actor changes or permission loss. Show estimate, overflow, gap, partial and stale states distinctly; unknown values are not zero. Only advertise capability parity for implemented, integrated behavior.

## 10. Delivery and acceptance

Implement in five stages: resources; direct trace; model statistics with protocol/recovery; context; cross-layer acceptance. The [plan](../plans/2026-11-06-managed-session-diagnostics-and-organization.md) and `.qwen/e2e-tests/managed-session-diagnostics.md` define the checks. Keep both language versions synchronized as implementation decisions are finalized.

Acceptance requires passive offline reads, authorization and child isolation, bounded resources/history, faithful invocation policies, cumulative model exactly-once folding/recovery, every model source/outcome, eight context categories from real prepared input, stale/partial handling, storage-floor compatibility, CSI diagnostics-only transfer and actual WebShell consumers. Context cached input and normalized output must not double count. Parent/child totals remain separate.

Follow root and [Managed module instructions](../../packages/managed-agent-server/AGENTS.md). Run affected API/SurfaceRegistry tests and regenerate WebShell types. Cross-language changes require root build/typecheck and focused consumer tests; transaction behavior needs real MySQL, and producer/recovery changes need their real-process path. All agents share the module's ten-minute local Java budget. Required full gates remain in CI; fixtures/H2 do not establish MySQL, process recovery, deployment or full acceptance. Record passes, failures, unavailable prerequisites and pending gates without inventing evidence.
