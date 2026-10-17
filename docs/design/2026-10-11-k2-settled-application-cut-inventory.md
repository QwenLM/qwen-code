# Settled original-owner application cut: inventory appendix

[English](2026-10-11-k2-settled-application-cut-inventory.md) | [简体中文](2026-10-11-k2-settled-application-cut-inventory.zh-CN.md)

This appendix belongs to the [application design](2026-10-11-k2-settled-application-cut.md). The current implementation uses main's canonical schema; the [schema port](k2-canonical-schema-port.md) defines the compatibility boundary. Earlier 61/62-table acceptance and legacy hash namespaces remain historical evidence for their exact original binaries. They do not qualify this candidate, rewrite a retained baseline, or establish physical release.

## Original identity and key namespaces

T/S are the exact original tenant/private Session; W/D are its saved Workspace/storage; Q is the complete original managed-context request key; I is its immutable retirement ID. A is the CSI alias and F is the physical backend/driver/volume key. All raw identities and their saved associations must agree.

Canonical Session scope J is `ManagedSchemaKeys.key(T,S)` and resource key RK is `key(J,resourceId)`. CSI retirement operation key is `key("CSI_RETIREMENT",T,I)`, distinct from the generic operation helper. Session-record ownership uses its actual domain key and revision; journal refs use `JOURNAL`, the actual journal owner key/revision and RK. Do not restore the former NUL-delimited Session scope, publication scope or extension-key recipes.

Broker scope/request/execution hashes, CSI alias/physical hashes and token hashes retain their actual producer-specific encodings. Compute them from the complete saved request and raw identity; a matching hash alone cannot grant ownership. Identity VARBINARY fields require strict UTF-8 decoding; opaque actor keys remain bytes.

## Independent discovery and association

Discovery uses independent OR predicates over all states, then expands the original reference sets to a fixed point. It covers raw Session, parent/root lineage, request/binding/runtime IDs, physical and alias identity, actual resource/ref ownership, reader IDs, schedules and typed JSON references. Every scan follows the declared primary-key order below. No active-only filter or parent join may hide a candidate.

`ma_operation`, `ma_operation_work`, `ma_request_receipt`, `ma_delivery`, `ma_artifact`, `ma_runtime_binding`, `ma_tool_execution` and `ma_output_capture` require bounded whole-table discovery because association can be carried indirectly or in structured payloads. Other declarations use their actual Session/Workspace/tenant/hash/physical predicates. Unknown association, orphan parent, mismatched raw/hash identity, unsupported domain or malformed payload remains BLOCKED. A row that does not directly name the original Session is not automatically OTHER.

An unrelated owner must be proven from its actual parent/domain chain. Shared tenant guards, Workspace/access rows, storage aliases and mode receipts have explicit context roles after checking original references. Original TASK/public activity, legacy action/extension activity, capture/publication work, automation, channels and recovery/migration remain unsupported in this first native file lane. Native file history is accepted only through its real journal/resource/embedded projection chain.

## Explicit canonical catalogue (33 tables, 749 columns)

Application inventory is `qwen-csi-application-inventory/2`; the component checkpoint is `qwen-csi-retirement-inventory/2`. Version 1 is refused. The exact column names, order, JDBC kinds and primary keys are declared in `WorkspaceCsiApplicationInventory`; the fresh DDL is `packages/managed-agent-server/src/main/resources/db/managed-schema/` (V1–V9). Catalog validation uses the same actual JDBC Connection as inspection. There are no compatibility views, aliases or legacy backfills.

| Table                    | Columns | Primary key / keyset order                                               |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `ma_agent_definition`    | 6       | `tenant_id, agent_id, revision`                                          |
| `ma_artifact`            | 9       | `artifact_id`                                                            |
| `ma_channel_binding`     | 9       | `tenant_id, channel_id, route_id`                                        |
| `ma_channel_instance`    | 12      | `tenant_id, channel_id`                                                  |
| `ma_csi_source`          | 19      | `binding_id`                                                             |
| `ma_delivery`            | 32      | `delivery_key`                                                           |
| `ma_event_stream`        | 15      | `tenant_id, session_id, stream_kind, stream_id`                          |
| `ma_message`             | 18      | `tenant_id, session_id, item_id`                                         |
| `ma_operation`           | 71      | `operation_key`                                                          |
| `ma_operation_work`      | 16      | `operation_key, work_kind, target_key`                                   |
| `ma_output_capture`      | 44      | `scope_key, publication_id`                                              |
| `ma_public_event`        | 26      | `tenant_id, session_id, stream_kind, stream_id, sequence_id`             |
| `ma_read_lease`          | 5       | `lease_id`                                                               |
| `ma_request_receipt`     | 31      | `receipt_key`                                                            |
| `ma_resource`            | 32      | `resource_key`                                                           |
| `ma_resource_ref`        | 11      | `session_scope_key, owner_kind, owner_key, owner_revision, resource_key` |
| `ma_runtime_binding`     | 40      | `binding_id`                                                             |
| `ma_runtime_session`     | 15      | `scope_key, runtime_session_id`                                          |
| `ma_runtime_slot`        | 12      | `request_key`                                                            |
| `ma_schedule`            | 25      | `tenant_id, schedule_id`                                                 |
| `ma_schedule_occurrence` | 16      | `tenant_id, schedule_id, occurrence_key`                                 |
| `ma_session`             | 47      | `tenant_id, session_id`                                                  |
| `ma_session_head`        | 36      | `tenant_key, harness_key`                                                |
| `ma_session_journal_tx`  | 25      | `tenant_id, session_id, journal_revision`                                |
| `ma_session_record`      | 33      | `session_scope_key, record_key`                                          |
| `ma_snapshot`            | 13      | `tenant_id, session_id, snapshot_id`                                     |
| `ma_storage`             | 14      | `alias_key`                                                              |
| `ma_storage_owner`       | 27      | `storage_key`                                                            |
| `ma_tenant_guard`        | 3       | `tenant_key, guard_domain`                                               |
| `ma_tool_execution`      | 28      | `execution_call_id_hash`                                                 |
| `ma_turn`                | 26      | `tenant_id, session_id, turn_id`                                         |
| `ma_workspace`           | 29      | `tenant_id, workspace_id`                                                |
| `ma_workspace_access`    | 4       | `tenant_id, workspace_id, actor_id`                                      |

`ma_csi_physical` is a separate six-column companion with primary key `retirement_id`. The full fresh schema therefore has 34 tables and 755 columns. Its typed reader runs on the same Connection after application closure and cannot add physical authority to an application baseline.

## Necessary prefix and producer gates

The required application prefix is broker tenant placement P, output-retention tenant R, slots/bindings, current private pin/context, registration, holder, immutable intent and same-intent progress; it then checks complete native heads/journal/resources/refs, logical Runtime Sessions, executions and the remaining catalogue. Generic mutations use the durable private predicate, generated from profile or retained request pin. Native mutations validate the exact original request/progress and retain their own protocol gates.

Each consumer receives the same active Connection and validated authority. Same DataSource alone is insufficient. No nested transaction, late ancestor lock, RPC or physical IO belongs inside the cut transaction. Planning and finalization RPCs happen outside SQL locks, followed by whole-image comparison. The total read budget is ten seconds, 4096 rows and 32 MiB. Metadata probes and repeated unchanged rows do not fabricate additional inventory; changed duplicate rows are refused.

FROZEN closes ordinary native writers. The terminal exception consumes the exact durable frozen request and predecessor once. CUT adds only the declared terminal transaction/resource/ref rows and head delta. DRAINED additionally releases the exact original logical Runtime Session. Retries compare saved bytes and versions without acquiring or renewing live authority. Collection excludes private Sessions before paging and rechecks under claim; private callback refusal rolls back all tentative writes, including tenant guards.

## Qualification still required

Current schema, binary-key, inventory, checkpoint, private-boundary and query-budget regressions provide bounded local evidence. They do not transfer historical RC/RR, application E2E or Linux/CSI qualification to this merged candidate. The full candidate still needs actual membership, rollback/retry/deadline and writer-race acceptance where execution is permitted, plus two clean full-diff audits and review.

Actual worker tasks, timers, renewal promises, executor operations, native history, retained files, FDs and backups must match in both directions. SQL emptiness, expiry, fulfilled promises, old worker ACKs or synthetic kernel observations cannot prove physical stop or unpublish. Atomic physical release, old credential validation, monotonic reuse and public selection remain later K2 work.
