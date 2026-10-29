# Remove persisted Managed conversation snapshots

[English](2026-10-29-managed-message-snapshot-removal.md) | [简体中文](2026-10-29-managed-message-snapshot-removal.zh-CN.md)

## Status and scope

Initially implemented on top of the direct-message paging change in PR #15865 at `cf7a0edf37d390a58db00901a397286023ce62f5`, following merged bounded-history queries (#15839). See [Managed live message pages](2026-10-29-managed-live-message-pages.md) for the preceding change. The current diff removes persisted public conversation snapshots; acceptance remains pending the checks listed below.

After #15865 merged as `89d3aaea62af96849c4b9b7a2bc68e26347a7ac8` with final head `ca8970b84b96c6d3cc5f77fc43b577150a0944c8`, the removal increment was rebased onto `main`. The dependency's coverage validation and smoke-fixture repairs remain intact. The checks below predate this baseline synchronization and do not establish final-tree acceptance; no local Java allocation was reopened.

The user selected direct reads of mutable messages, recent-message paging, and live export without a fixed content version. Remove `ma_snapshot` and its persisted public message-page copies. Preserve canonical journals, private native journal snapshots, execution checkpoints, child launch snapshots, Workspace authorization, and Legacy daemon behavior.

## Current behavior and problem

Public message queries and the default Managed WebShell transcript/export paths use `ManagedSnapshotStore`. The materializer periodically freezes the complete message projection into manifest and page resources, publishes a `ma_snapshot` row, and advances `ma_event_stream.current_snapshot_id`. Signed cursors identify that persisted version. The event replay floor, Session summaries, resource collection, and CSI application inventory also depend on those rows.

Direct-message paging makes those copies unnecessary for the selected product behavior. Removing only the table would leave active SQL reads, background writes, retention jobs, and integrity checks referring to an absent object.

## Proposed behavior

### Message reads and live export

Use the direct `ma_message` pager for every public Managed message read: public Items, recent Items, default transcript, and export. The first request fixes a membership upper bound; each page reads current content in its own consistent SQL view. Keep the complete `(first_sequence, item_id)` order, direction and scope validation, projection-version checks, authorization on every request, and existing item and byte limits. Adapt numeric `after=N` explicitly: exclude every Item whose first-sequence is N, then use complete tuple boundaries for continuation so equal-sequence Items on later pages are retained. Preserve explicit `cursor` precedence and the existing nonnumeric `after` cursor alias. Old snapshot cursors are rejected; they are not reinterpreted as message cursors.

The default transcript changes from a 1–1000 event limit to a 1–100 message limit; omission still defaults to 100. Existing requests with limits 101–1000 now receive a parameter error and should page through older Items instead. The removed `view` selector is no longer interpreted; retain the existing JSON unknown-property handling rather than adding a global strict-deserialization policy. Clients should omit the selector under the new contract.

The transcript response's resume sequence is the message projection's actual `covered_sequence`, not the public event tail. A client receives subsequent changes through SSE. Export reads forward within its initial membership bound and does not claim immutable content. If the initial projection is behind committed events, use the direct pager's explicit retryable pending response rather than silently exporting an empty or incomplete history.

Existing response field names that refer to snapshot coverage may remain as transitional wire names only where needed by current consumers; they do not imply a retained version. Distinguish their meanings by response: transcript coverage is the current page's actual `covered_sequence` for SSE handoff; export and public Item pagination coverage is the first request's fixed `throughSequence` membership bound and must not advance on later pages. Do not introduce a replacement snapshot table, persisted page store, or process-local history cache.

### Materialization and event replay

Continue updating `ma_message`, public resource references, `covered_sequence`, and `projection_version`. Remove public snapshot building, refresh thresholds, stale markers, and idle snapshot refresh scans. Projection work is pending exactly when `last_sequence > covered_sequence`.

Read replay coverage directly from the Session event-stream row. Preserve the monotonic replay floor, active-Turn protection, private CSI exclusions, and the current deployment enablement policy. A floor advance must never exceed readable message-projection coverage. Projection rebuild does not lower the floor: preserve the pager's retryable pending guard when `covered_sequence < replay_floor_sequence` and cursor invalidation when `projection_version` changes. If the floor advances between a message read and SSE subscription, expired replay reloads the default live-message path rather than a removed snapshot path. This change does not add public event deletion or compact canonical history.

### Resource lifetime and CSI inventory

Remove public `SNAPSHOT` owners, `managed-snapshot-page` and `managed-snapshot-manifest` resources, snapshot expiry scans, and public snapshot retirement batches. Retain message-body collection, read leases, recovery protection, and all native `NATIVE_SNAPSHOT` ownership and collection.

Update the CSI application inventory's declared schema, queries, allowed owners and resource kinds, and structural/content checks together. Continue rejecting unknown objects, references, or scope violations. Removing an obsolete snapshot branch must not weaken the checks for message bodies, journal resources, native history, output artifacts, or physical ownership.

### Shared schema and deployment

Edit the single canonical V1 baseline in place under the first-release policy. Remove `ma_snapshot`, `ma_event_stream.current_snapshot_id`, `snapshot_stale_since`, public snapshot page metadata in `ma_resource`, and their indexes, foreign keys, and checks. Remove the public `SNAPSHOT` resource-owner enum value while preserving `NATIVE_SNAPSHOT`. Update explicit projections, schema validation, CSI declarations, legacy responsibility mapping, and applicable tests. The inspected 39-table baseline becomes 38 business tables.

Development catalogs require recreation; this change supplies no V2 migration, `DROP TABLE` against a running catalog, or repair/history bypass. Preserve the other chat's running preview and its original database. Matching Server/Broker/Harness/WebShell builds are required for qualification.

## Affected components

| Component                                                     | Required work                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ManagedAgentStore`, `AgentStateStore`, `ManagedAgentService` | Replace remaining public snapshot reads and coverage joins; remove building and refresh orchestration.        |
| `ManagedSnapshotStore`, public snapshot model records         | Remove obsolete persisted snapshot implementation and interfaces.                                             |
| Replay floor and SSE services                                 | Use projection coverage and document message resynchronization semantics.                                     |
| Projection collector and Session retirement                   | Remove public snapshot collection; retain message and native-history protection.                              |
| Canonical schema and `managedschema` contracts                | Remove obsolete table, fields, owners and indexes consistently.                                               |
| `WorkspaceCsiApplicationInventory`                            | Remove public snapshot inventory and validation without broadening accepted unknown state.                    |
| OpenAPI and WebShell                                          | Align default live-read semantics, cursor rejection, export metadata and generated types.                     |
| Tests and current operational documentation                   | Replace fixed-copy assertions with live paging, watermark, authorization, retirement and recovery invariants. |

## Validation and acceptance

Message-page errors retain their exact recovery meanings: `400 invalid_message_cursor` rejects invalid cursor bounds/scope/direction, `409 message_projection_changed` requires discarding the cursor after a projection rebuild, `503 message_projection_pending` is retryable projection lag, and `413 message_page_too_large` is a response budget failure. A single oversized Item remains unavailable through message paging even at limit 1. Signed POST request-body failures retain the separate `payload_too_large` code.

Review follow-up strengthens the body-read, write-free read, live-reference, coverage/control-event, transaction-annotation, unknown-selector and MySQL literal-drift witnesses; the CSI body-window negative keeps a valid internal range, and the fixture exporter preserves WebShell milliseconds directly from original events. These Java test edits have source review only until CI executes the new revision. The local Java allocation stays closed; earlier successful CI remains evidence only for its recorded inputs.

Use the direct-message regression cases for no-snapshot sessions, projection lag, duplicate first-sequences, bounded forward/backward paging, evolving content, scope and version errors, and finite export during continued writes. Exercise reconnect before and after replay-floor advancement and projection rebuild. Cover Session summaries, collector runs, retirement, strict schema admission and CSI inventories on the schema without `ma_snapshot`. Native journal snapshot publication, readback, restore and collection must retain their original behavior.

Run affected Java unit/H2 and disposable MySQL cases, API/surface contracts, and affected WebShell checks under applicable repository budgets; full required profiles remain CI gates. Reuse upstream evidence only for identical tested inputs. The upstream chat's closed Java and preview-startup allocations cannot be reused or reset by this follow-up. Record unavailable execution explicitly rather than treating source inspection as runtime acceptance.

Local build, typecheck, bundle and all 318 tests in the four affected WebShell suites passed. The latest collected unit/H2 reports contain 835 cases: 834 passed and one API contract fixture failed because an empty Session used a helper requiring two messages. The fixture now waits for the message query to become ready; that correction was not rerun locally.

Disposable MySQL 8.4.11 completed 141 cases: 140 passed, including 27 Managed API, 22 native journal snapshot, 24 retained artifact and 66 CSI inventory cases. One schema negative-test fixture still named a removed public snapshot CHECK; it now mutates the surviving resource length CHECK and remains unrerun. The Session-schema group was interrupted and the dedicated message-paging group did not start before the local budget ended. The temporary database server and files were cleaned up. The 24 retained-artifact cases passed before three negative fixtures were strengthened to preserve digest-derived resource identity and the original large-body length. Those strengthened fixtures were not compiled or rerun locally; the earlier report is not evidence for their new assertions.

This explicit table-removal request used its separate default 600-second local Java allocation; it is closed below that limit, including setup and cleanup. Earlier chat allocations remain closed and were not reused. Final API/schema-fixture reruns, the strengthened CSI negatives, complete MySQL paging/concurrency, Checkstyle, SpotBugs and relevant full CI profiles remain required. Independent source review also found an obsolete generated-expression normalization branch that assumed an OR in projection_pending. The branch was removed and missing/changed-expression diagnostic tests were added; this final validator change and its tests were not compiled or run locally under the closed budget. The recorded unit and MySQL runs are partial evidence, not a passing full gate or production acceptance.

Subsequent external CI run `40915271041` compiled the `6851d1a8` source tree (synthetic merge `abe373a3`, with the same tree digest). The schema diagnostic, retained-artifact, removal, direct-paging and API contract suites passed there, but the complete run failed: Checkstyle found two obsolete imports and the 5971-case unit phase reported ten failures from three stale physical-table-count assertions. The review follow-up removes those imports and changes those counts from 40 to 39 (38 business tables plus Flyway); verification of the follow-up revision remains pending. No local Java allocation was reopened.

Acceptance requires no production SQL references to the removed table or public snapshot columns, no generation of public snapshot copies, bounded default message reads and live export, a safe SSE resume watermark, consistent strict schema/CSI validation, and intact private recovery history. Outstanding integration or CI evidence must remain explicit.

## Decisions and boundaries

No fixed-version conversation export is required. The compatibility change is intentional and must be stated in API and deployment documentation. No original history is deleted and no existing user database is altered by development work. This is a follow-up to the other chat's reading-path change; do not edit its active checkout or claim its unfinished validation as evidence for this removal.
