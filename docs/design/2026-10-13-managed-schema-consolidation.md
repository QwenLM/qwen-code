# Managed Agent schema consolidation: 63 to 32 tables

[English](2026-10-13-managed-schema-consolidation.md) | [简体中文](2026-10-13-managed-schema-consolidation.zh-CN.md)

## Status and boundaries

Implemented in an isolated worktree and validated on fresh MySQL8.4 databases, including native Linux worker, reboot and independent service acceptance. Formal production traffic has not been switched; see the implementation runbook for executed evidence and environment limits. The source inventory is pinned to `18f80f56666a347a2b67b2ef98099cc58356b253`. The existing schema has 63 business tables including V68 asynchronous output verification. A fresh database is required. Existing databases and existing Session records are not migrated. DataAgent's five `da_qwen_session_*` tables are outside this change. Executed acceptance and remaining production cutover steps are recorded in the implementation runbook.

The target preserves Managed Session, Runtime, tools, Workspace/CSI, recovery, child Agents, channels and automation. Table count is an outcome of removing redundant storage boundaries, not permission to discard protocol facts. The earlier 26-table proposal is superseded: writer ownership, event-stream cursors, immutable snapshots, Runtime slots, physical storage ownership and reader leases remain separate.

## Target tables

| Module               | Count | Physical tables                                                                                                                                                                    |
| -------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session and content  |    10 | `ma_session`, `ma_session_head`, `ma_turn`, `ma_session_journal_tx`, `ma_event_stream`, `ma_public_event`, `ma_message`, `ma_snapshot`, `ma_session_record`, `ma_agent_definition` |
| Resources and output |     4 | `ma_resource`, `ma_resource_ref`, `ma_output_capture`, `ma_artifact`                                                                                                               |
| Requests and work    |     3 | `ma_request_receipt`, `ma_operation`, `ma_operation_work`                                                                                                                          |
| Workspace            |     3 | `ma_workspace`, `ma_workspace_access`, `ma_storage`                                                                                                                                |
| Runtime              |     4 | `ma_runtime_slot`, `ma_runtime_binding`, `ma_runtime_session`, `ma_tool_execution`                                                                                                 |
| Coordination         |     3 | `ma_tenant_guard`, `ma_storage_owner`, `ma_read_lease`                                                                                                                             |
| Channels             |     3 | `ma_channel_instance`, `ma_channel_binding`, `ma_delivery`                                                                                                                         |
| Automation           |     2 | `ma_schedule`, `ma_schedule_occurrence`                                                                                                                                            |

## Authority and commit boundaries

`ma_session` owns public identity, actor/Workspace binding, lineage, title revision and retirement tombstone. `ma_session_head` owns writer generation, lease, activation, private journal revision/checkpoint, recovery status and admission fence as separate fields. `ma_event_stream` owns the durable tail and retention floor for each `(tenant, session, stream_kind, stream_id)`; the Session stream also owns projection progress and current snapshot identity. Rebuilding projections cannot erase tail/floor.

The Session stream's nullable `wake_covered_sequence` independently deduplicates attempted journal wake activations. Its private journal sequence may exceed the public event tail. An atomic strict-advance claim changes only this field, preserving message `covered_sequence`, retention floor, tail and materialization scheduling time; projection rebuilds retain it. Transport consumers read public Session state only, excluding Control roots and retired Sessions. Journal ownership uses the head's digest primary key, rechecks raw identities and excludes Harness-only heads; batch ownership reads remain bounded to 200 requested identities.

Broker-only Harness admission barriers can exist before a Managed Session registration. Such a head is explicitly a control-only record: absent journal authority must not be interpreted as an active writer. Storage admission fences can likewise precede CSI registration; an unregistered logical storage row does not prove a physical identity or mount. Neither placeholder grants execution authority. Public Session Workspace bindings are either entirely absent or complete, with positive Workspace and context revisions; control-only tombstones may retain a partial internal binding.

Private journal bytes and digest chains remain immutable. Journal append, resource references, domain projections and head advancement commit together. Public events contain only public projections, with separate Session/task streams, sequences, deduplication and retention. `ma_session_record` is the latest typed domain projection for tasks, approvals, Hook, MCP and Team; Hook once/occurrence constraints remain durable. Immutable Agent definitions remain revision-pinned.

Messages store current projection and ordered stable-ID parts; streaming deltas are events and projection updates are batched. Large bodies use immutable resources. Snapshots retain immutable versions, covered sequence and manifest/page references. Build against one repeatable-read consistent view, verify every page, then publish the pointer. Do not replace that view with independent transactions or INSERT SELECT. Snapshot cursors expire after 30 minutes and pin required resources/replay interval; current snapshots survive until replacement. Expiry retains 409 cursor_expired and SSE resync semantics.

Snapshot construction and page reads reuse the current consistent-view connection to validate their committed read lease; they never borrow a second connection from inside the read view. The view must finish within the committed 120-second lease and fails closed on expiry. Renewal and a fresh retirement-generation check run after the view releases its connection, before publication or returning a page. Ordinary output readers still renew their leases. This protects GC without a nested connection-pool dependency.

Expired superseded snapshots are removed in bounded background batches even when the Session is idle. Releasing a SNAPSHOT or MESSAGE owner marks its generated inline bodies for indexed collection using resource.retention_until. The collector checks remaining references, active read/build leases and recovery protection under the Session lock, then atomically clears inline bytes and writes the COLLECTED tombstone. It never selects private journal staging resources; the current snapshot remains retained. Collection follows the existing GC enable switch.

Each immutable snapshot-page resource records its snapshot identity, ordinal and the minimum/maximum item first-sequence in that page. These four typed fields are mandatory for snapshot pages and absent for other resources; the scoped snapshot/ordinal is unique. Numeric initial `after` seeks the page through the resource directory index and filters inside that page; equal first-sequences spanning pages keep the existing exclusive numeric boundary. The seek reads the same fixed snapshot, never the latest mutable message projection. The subsequent opaque cursor retains snapshot identity and page/offset. Historical message volume growing from 1,000 to 10,000 must keep the production page read and indexed directory scan bounded.

## Requests, workers and external effects

Request receipts reserve identity before external effects and replay an exact digest/result in a fixed namespace and trusted scope. Session creation mode conflict is tenant-scoped and distinct from actor-scoped creation replay. Private journal command deduplication remains independent.

Operations are closed, typed execution units for lifecycle/rename/context/approval/cancel, child launch/close/Workspace work, output upload/verify/finalize/put/result projection/GC, recovery/migration/CSI retirement and channel ingress. Indexed columns hold tenant, target, kind, phase, state, claim generation and next-attempt time; type-specific parameters have a validated schema. Work rows record each affected Session/asset/execution and immutable proof. There is no configurable workflow engine or dynamic SQL compatibility router.

Delivery separates transport, acceptance and consumption, and claims are fields on the delivery row. Child close debt remains a separate operation after result handover. Approval reservation is unique by action identity/revision; opposite decisions cannot become admissible after claim expiry. Rename settlement names its desired title revision and cannot regress it. V68 asynchronous verification retains explicit phase/due columns.

Workers claim in short transactions and settle only the same generation. Domain row locks are never held over external I/O. UNKNOWN external outcomes are reconciled through the original identity or explicitly settled by an operator; expiry never licenses a new tool execution, object write or provider send. Terminal receipts are not ordinary rebuildable cache entries. An OBJECT_PUT left IN_FLIGHT or UNKNOWN can be settled by reading its original immutable object and verifying complete length and digest. This never sends another PUT or uses lease expiry as completion evidence. Object adapters must perform one physical create without automatic retries; normal server and offline recovery/CSI clients use the same retry policy. Missing or mismatched objects remain unresolved and protected.

Channel reconciliation reserves a stable identity derived from tenant/channel/delivery and claim generation. The live-session Harness accepts that reserved identity only for settling an unknown delivery and carries it unchanged into the private journal command. Server projection checks the reserved identity against the current claim in the same journal transaction; a stale claim cannot revise a successor. Ordinary UUID requests retain their existing command behavior.

## Runtime, storage and resource closure

Runtime slot allocation is monotonic and outlives binding GC. Binding history, Runtime Session and original tool execution identities remain distinct. Status/cancel/recovery refers to the original execution; unresolved outcomes block unsafe replay.

Logical storage aliases and registration/admission fences live in storage. Physical ownership and mount/CSI evidence live in storage_owner keyed by canonical physical identity, including aliases across tenant namespaces. Lease expiry is not proof of stopped execution. Tenant guards have separate runtime_placement and output_publication domains. Reader leases are one row per reader, bound to Session retirement generation; acquisition is atomic with retirement checks, renewal failure stops further reads.

Fresh LOCAL tool and child Git deployments must enable `QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED=true` on Linux and register each logical alias against the native mount before execution. Unmapped aliases provide metadata only and cannot claim physical execution.

For local storage, the physical key is a length-encoded digest of the native host, device, inode and birth identity. Each configured tenant/storage alias keeps its own registration and admission fence, while all aliases resolve to the same physical owner. The owner and on-disk marker retain the first registration's provenance; that provenance does not grant another alias's Session authority. Alias registration never rewrites that marker or native identity. Migration creates a new physical owner for the target mount and atomically remaps only the selected logical alias; the original physical owner keeps its fence and evidence. A copied marker or a different canonical root cannot authorize an alias. New Runtime admission and existing writer content mutations check the mapped physical owner's current state. Writer sealing remains available during recovery freezing.

Physical handover locks at most 128 mapped aliases in key order, then the owner, before checking committed authorities. An incomplete or larger alias inventory fails closed. A tenant-scoped recovery or migration cannot certify another alias's uncovered Session, private writer or pending Runtime work; it fails closed until those authorities are settled. Inventory reads use current committed SQL state even when the calling recovery transaction has an older repeatable-read view. Runtime bindings retain a derived storage-alias key indexed with state, provisioning-seed presence and identity; Session authority is indexed by tenant, storage, resource-GC completion and Session. A FAILED binding with a durable provisioning seed remains unresolved physical authority. Recovery does not infer permission to export another tenant's private journal. Sealed or expired Sessions remain outside the source cut until permanently retired and fully collected. The resource_gc_completed Session projection is set only in the same transaction that settles successful GC and verifies the permanent tombstone, fully compacted DELETED head (or absence of any private journal), and immutable authority. Completed historical tombstones no longer block handover, while their SQL counters remain intact. Child Workspace operation states retain their lowercase domain values; preparing, ready, merging, applying, applied, discarding, conflicted, blocked and failed still block handover even when the parent has been collected or is absent. Only merged/discarded confirm the physical cleanup step settled. Stopped original bindings with no matching physical owner can complete a no-op release; this never clears a CSI or successor holder.

Resource bytes are immutable and scoped. The catalog distinguishes staging, verified, quarantine and deletion state and preserves digest/length/storage metadata. resource_ref records typed owner/revision edges for journals, snapshots, captures, artifacts, tasks and recovery proofs; owner removal and edge release commit together. No cross-scope sharing is inferred solely from a digest. Capture manifests retain each stream's count, size and digest; complete capture does not itself authorize public artifact publication.

GC checks references, recovery protection, active readers and unresolved puts. It first persists deletion intent and blocks new references, then performs physical deletion. Unknown deletion/write outcomes remain reconcileable. The original resource closure cannot be pruned merely because its public events expired.

Workspace rows represent root and child_git entities and keep parent, generation, Git base/result/conflict evidence. Child creation/merge/cleanup are operations. Default Workspace is a generated-column unique constraint with transactional switching. Child permission checks follow the current parent ACL instead of copying it. Schedule definitions remain journal authority. Validated schedule records update session_record and schedule in the same transaction as journal bytes, resource references and head advancement. HTTP mutation responses read this committed projection; the scanner never repairs definitions. Definition changes preserve scanner lease/fence/watermark and reset armed_at only when enabling a previously disabled definition. Scanner retirement changes scheduling state without rewriting the authoritative enabled field. The cron column supports the private contract’s 4096-byte expressions. Occurrences preserve skipped, missed and unknown decisions separately from run existence. Channel bindings are stable routes; ingress deduplication includes account generation, platform event identity and semantic revision.

Git discovery checks metadata before starting the native process: even `rev-parse` can mutate linked-worktree metadata. Starting at the requested cwd, the preflight locates the nearest `.git` inside the storage boundary, resolves regular gitfile and commondir pointers, and rejects unsafe links in metadata that Git can write or prune. Native discovery and the existing canonical layout/config checks still validate the resolved repository. Valid ordinary repositories and linked worktrees retain their existing behavior.

Recovery registration locks each Session and private head, checks current deletion intents, and commits its Session protection in the same transaction. Private resources use named JOURNAL/SESSION_RECORD references; public message and snapshot bodies do not enlarge the private recovery closure. A permanently deleted Session whose private journal is fully collected can use the existing headless retirement path only after the retirement, DELETED head, complete compaction, and SUCCEEDED Session GC operation agree. Its optional `retiredHead` preserves the original writer generation, journal and event watermarks, activation and commit digest as immutable backup metadata. The worker validates and roundtrips that metadata without replaying collected transactions or activating the Session; it never deletes or resets the SQL head or event stream. Partial compaction and unresolved GC outcomes fail closed.

## Identity, indexes and shared DDL

Machine identities are byte-exact, including trailing spaces. Actor creation scopes retain the existing Base64 representation and reserve 2732 bytes for the full validated 2048-byte actor identity. Session message and channel delivery scans index domain/delivery state; the channel query selects the scoped status index so completed history does not determine its scan cost. Long identities retain raw bytes and use fixed-encoding digest keys with equality verification. Relational cardinalities use unique constraints and foreign keys; polymorphic edges use a closed owner-kind set and transactional checks. Hot claiming/paging/GC/recovery predicates are indexed columns rather than JSON scans.

One versioned MySQL 8.4/InnoDB baseline is shared by Managed Server and Broker. It must refuse an existing legacy database before creating or altering business tables. Both initializers consume the same resource; no compatibility views, triggers, second independently maintained schema, or legacy-name SQL router are permitted. HTTP/SDK business identities and existing fields remain stable. The public pagination contract changes to signed opaque snapshot cursors with explicit 30-minute expiry, 409 cursor_expired and SSE resynchronization, including when all retained event rows have been removed; these changes are recorded in public contract version 1.45.0. Task-event cursors use versioned, length-safe tenant/Session/task identity tuples; retained task sequence and floor remain authoritative when every event row expires. Native database-time leases retain DATETIME(6) precision and are validated against the database catalog. Epoch-millisecond public timestamps keep their existing representation.

Historical SQL/Java migrations and their upgrade-only witnesses are kept under `docs/archive/managed-agent-schema`, outside runtime/test classpaths. The former Broker `schema.sql` is removed. Active tests cover fresh baseline activation and old-catalog refusal; no dormant upgrade path or second schema definition ships with the new application. History-only catalogs and history views are rejected before Flyway writes.

Both MySQL/MariaDB initialization paths require a selected application catalog. They reject `mysql`, `sys`, `information_schema` and `performance_schema` before reading table metadata or invoking DDL/Flyway. JDBC drivers can classify all tables in a system catalog as SYSTEM TABLE, so filtering TABLE/VIEW alone cannot prove an empty application database.

The retained MariaDB CI lane uses the same canonical DDL. Its CHECK catalog has no per-constraint ENFORCED field; validation detects MariaDB even when Connector/J reports MySQL, requires global and session check_constraint_checks, and compares every declared CHECK name/expression. Both database families require InnoDB; MySQL still requires ENFORCED=YES. Missing enforcement settings or disabled checks fail closed before metadata enumeration or DDL. This does not change the MySQL 8.4 acceptance baseline.

Structural CASE comparison treats only bare TRUE/FALSE tokens as the numeric aliases 1/0, matching [MariaDB Boolean literals](https://mariadb.com/docs/server/reference/sql-structure/sql-language-structure/sql-language-structure-boolean-literals). Quoted strings, branch order/values, operators and ELSE remain part of the checked shape; no CHECK clause is skipped.

Load witnesses preserve actual execution statistics on both retained database families. MySQL uses EXPLAIN ANALYZE tree operators; MariaDB uses [ANALYZE FORMAT=JSON](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/analyze-and-explain-statements/analyze-format-json), multiplying average r_rows by r_loops for every table node. The test helper checks actual chosen keys rather than possible_keys, rejects estimated-only or incomplete counters, and preserves zero-loop unexecuted joins. MariaDB can read a PRIMARY const table during optimization with zero execution loops and no r_rows; its actual r_engine_stats.pages_accessed is tracked separately from scanned rows. Each resource witness requires positive actual row or page evidence and bounds both metrics independently. Row counts must remain stable across 1000-to-10000 history; page counts remain bounded at each size because B-tree height can change. Existing scan budgets and actual index checks remain mandatory; no vendor is skipped.

The real-stack E2E runner seeds and audits only canonical tables, including the ACTION discriminator for approvals. Linux CI explicitly enables verified recovery for both initial and replacement Server processes and registers the fresh task-owned native storage before launching any Harness or admitting work. It never substitutes SQL-only identity proof or enables trusted reboot recovery. Current macOS LOCAL tool support remains an unresolved platform decision; the documented current behavior requires Linux registration and preserves physical exclusion.

Linux Hosted fixtures register each configured workspace storage through the production native storage guard before tool admission. Crash and lifecycle recovery fixtures register only at initial startup; restarting preserves the original registration and physical holder evidence. Physical owner assertions resolve the logical alias to its physical key. These fixtures do not skip native storage checks, manufacture identity proofs in SQL or weaken fault assertions.

## Delivery sequence and acceptance

1. Commit bilingual design, complete 63-to-32 ownership inventory, typed keys/state contracts and canonical DDL; verify clean database initialization and refusal of legacy schemas.
2. Connect receipts/operations/resources, Session/head/journal/streams/messages/snapshots; prove create/commit/read/replay/rebuild/delete closure.
3. Connect Runtime/Workspace/CSI/output/recovery/GC; preserve original identities and prove physical exclusion and read/write/GC races.
4. Connect approval/Hook/child/channel/automation/public queries; every production worker must use target tables.
5. Run real MySQL constraints/concurrency/crash/load gates before accepting new deployment traffic. Quiesce old admissions and settle old work; preserve the old database for history. New records must never be routed back to the old database during rollback.

Acceptance requires exactly 32 business tables, full old responsibility coverage and no legacy table access. Test tenant/actor/idempotency/mode-conflict/default races; commit-prefix atomicity and stale writers; immutable paged snapshots and rebuild/empty-stream retention floors; connection loss after external send; reader/put/seal/retirement/GC races; alias physical exclusion and missing execution ACKs; approval/Hook/child close debt/rename/channel-generation/schedule races; indexed bounded scans when historical data grows tenfold. H2 is feedback, not evidence for MySQL lock/isolation correctness. Tests run without real user cloud resources.

## Complete responsibility mapping

| Previous table                             | Target storage                                     |
| ------------------------------------------ | -------------------------------------------------- |
| `managed_agent_session`                    | `ma_session`, `ma_event_stream`                    |
| `managed_agent_turn`                       | `ma_turn`                                          |
| `managed_agent_command`                    | `ma_request_receipt`                               |
| `managed_agent_operation`                  | `ma_operation`                                     |
| `managed_agent_action`                     | `ma_session_record`, `ma_operation`                |
| `managed_session_rename_delivery`          | `ma_operation`, `ma_session`                       |
| `managed_session_create_scope`             | `ma_request_receipt`                               |
| `managed_workspace_create_command`         | `ma_request_receipt`, `ma_session`                 |
| `managed_agent_event`                      | `ma_public_event`                                  |
| `managed_agent_item`                       | `ma_message`                                       |
| `managed_agent_item_part`                  | `ma_message`                                       |
| `managed_agent_snapshot`                   | `ma_snapshot`                                      |
| `managed_agent_consumer_progress`          | `ma_event_stream`                                  |
| `qwen_managed_session_journal_head`        | `ma_session_head`                                  |
| `qwen_managed_session_journal_tx`          | `ma_session_journal_tx`                            |
| `qwen_managed_session_resource`            | `ma_resource`                                      |
| `qwen_managed_session_resource_ref`        | `ma_resource_ref`                                  |
| `qwen_managed_session_resource_collection` | `ma_session`, `ma_operation`                       |
| `qwen_managed_session_extension_record`    | `ma_session_record`                                |
| `qwen_managed_session_task_journal`        | `ma_public_event`                                  |
| `qwen_managed_session_task_journal_cursor` | `ma_event_stream`, `ma_resource_ref`               |
| `qwen_managed_child_result_relay`          | `ma_operation`, `ma_delivery`                      |
| `qwen_managed_session_message_relay`       | `ma_delivery`                                      |
| `qwen_managed_child_workspace`             | `ma_workspace`, `ma_operation`                     |
| `qwen_runtime_binding_slot`                | `ma_runtime_slot`                                  |
| `qwen_runtime_binding`                     | `ma_runtime_binding`                               |
| `qwen_runtime_session`                     | `ma_runtime_session`                               |
| `qwen_tool_execution`                      | `ma_tool_execution`                                |
| `qwen_runtime_placement_guard`             | `ma_tenant_guard`                                  |
| `qwen_runtime_harness_drain`               | `ma_session_head`                                  |
| `qwen_runtime_storage_fence`               | `ma_storage`                                       |
| `managed_workspace_registry`               | `ma_workspace`                                     |
| `managed_workspace_access`                 | `ma_workspace_access`                              |
| `managed_workspace_default`                | `ma_workspace`                                     |
| `managed_workspace_execution_lease`        | `ma_storage_owner`                                 |
| `managed_workspace_operator_recovery`      | `ma_operation`, `ma_operation_work`, `ma_resource` |
| `managed_workspace_recovery_operation`     | `ma_operation`                                     |
| `managed_workspace_recovery_session`       | `ma_operation_work`                                |
| `managed_workspace_recovery_work`          | `ma_operation_work`                                |
| `managed_workspace_csi_registration`       | `ma_storage`                                       |
| `managed_workspace_csi_retirement`         | `ma_operation`, `ma_operation_work`                |
| `managed_workspace_csi_worker_ack`         | `ma_operation_work`, `ma_resource`                 |
| `managed_workspace_migration`              | `ma_operation`, `ma_operation_work`, `ma_storage`  |
| `qwen_tool_publication_tenant`             | `ma_tenant_guard`                                  |
| `qwen_tool_publication`                    | `ma_output_capture`                                |
| `qwen_tool_publication_object`             | `ma_resource`                                      |
| `qwen_tool_publication_operation`          | `ma_operation`                                     |
| `qwen_tool_publication_seal`               | `ma_output_capture`, `ma_resource`                 |
| `managed_agent_tool_result`                | `ma_operation`, `ma_message`                       |
| `managed_agent_artifact`                   | `ma_artifact`                                      |
| `qwen_output_session_retirement`           | `ma_session`                                       |
| `qwen_output_read_lease`                   | `ma_read_lease`                                    |
| `qwen_output_put_attempt`                  | `ma_operation`                                     |
| `managed_agent_definition`                 | `ma_agent_definition`                              |
| `managed_agent_definition_command`         | `ma_request_receipt`                               |
| `qwen_managed_channel_instance`            | `ma_channel_instance`                              |
| `qwen_managed_channel_binding`             | `ma_channel_binding`                               |
| `qwen_managed_channel_route`               | `ma_request_receipt`, `ma_operation`               |
| `qwen_managed_channel_delivery`            | `ma_delivery`                                      |
| `qwen_managed_channel_claim`               | `ma_delivery`                                      |
| `qwen_managed_automation_schedule`         | `ma_schedule`                                      |
| `qwen_managed_automation_occurrence`       | `ma_schedule_occurrence`                           |
| `qwen_managed_automation_command`          | `ma_request_receipt`                               |
