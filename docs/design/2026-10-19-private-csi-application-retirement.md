# Private CSI original-owner application retirement

[English](2026-10-19-private-csi-application-retirement.md) | [简体中文](2026-10-19-private-csi-application-retirement.zh-CN.md)

## Status and scope

Implementation extracted from #13526 at `1a6529b73c007044d9d04e0614fbc30ebe13c0ac`, independently based on main `11a6346aa92b5e2f473464174e6043d053bf8010`. Validation results belong to the extracted candidate; historical cumulative-branch tests do not qualify it.

The first supported case is one settled, still-live original private Hosted file owner: runtime generation 1, writer generation 1, activation epoch 1, the original worker and uncompacted inline Read/Write/Edit history. Pending model/tool work, cancellation, UNKNOWN execution, unresolved reads/PUTs, unsupported secondary work and replacement owners block retirement. New cold recovery, node evidence, physical stop, CSI unpublish, binding/holder release, reuse and public CSI selection are outside this change.

## Problem and current behavior

The private file lane can finish turns but generic activation release and Runtime Session release deliberately refuse CSI. SQL admission and worker file descriptors do not have a common durable application cut. Expiry or an empty local promise set does not prove that the original application has stopped changing its retained files and history.

Main's receipt-complete recovery stays active-only. This change adds a distinct original-owner terminal consumer; it does not let ordinary commit, replay, restore or execution admission accept released history.

## Durable application authority

Use nullable progress on the existing canonical `ma_operation` CSI_RETIREMENT row: `qwen-csi-application-retirement/1`, stages SETTLING → FROZEN → CUT → DRAINED and versions 1–4. Retain exact DRAINING intent bytes, binding/holder DRAINING, and the occupied original runtime slot. DRAINED releases only the original logical Runtime Session, after the worker's exact finalization receipt.

Begin persists SETTLING and a checked database `startedAt + 300000` millisecond settlement deadline atomically with the original binding seal and holder transition. Retries never reset the deadline. Legacy NULL, partial or unknown progress refuses. Preserve immutable sealed binding version separately from current binding control version and application progress version. Holder revision advances from the saved reservation; it is not a runtime generation.

Every mutating consumer receives the validated original Connection. Before CUT, fresh database time is checked after blocking locks and immediately before the final write; equality with expiry/deadline is expired. Finalization consumes the immutable saved CUT and does not require or extend a live lease. SETTLING permits only already admitted original continuations within their existing authority and the fixed deadline. FROZEN closes renewal and every ordinary mutation. A deadline never revives an expired lease.

## Existing-owner barrier and exact preparation

The authenticated primary-listener route `/session/:id/internal-csi/retire` is scoped to the existing live owner and its tenant, workspace, binding and retirement identity. It never attaches, resolves or acquires a replacement runtime. It synchronously latches before an await, closes new attach/text/history work, stops renewal scheduling and joins admitted tasks. Failures remain recorded after tasks leave the Set. The retirement promise is outside the Set it joins; exact retries share preparation and completion, while a different retirement conflicts.

Join actual raw activation renewal and HTTP writer renewal outcomes, without starting another renewal. An absent renewal uses current original authority; an existing no-op/undefined or rejected outcome blocks. Do not call stopLocal before joining: it disables the grant required to validate a successful in-flight renewal.

Inside the authority's original serial boundary, close ordinary authority admission and prepare one activation release using existing record/marker encoders and staged resources. The two records and one `managed-activation-boundary` resource retain exact IDs, parent links, times, original activation expiry and predecessor sequence/UUID. Preparation performs no HTTP or durable append and caches bytes even after a lost persistence reply. A shared commit-body builder serves ordinary append and this preparation; ordinary append still ensures its writer, while retirement uses the joined original grant.

## Freeze, cut and finalization

The existing operator-authenticated Session Store prefix exposes private status and freeze/cut/finalize commands, always scoped by workspace and retirement ID. Inputs use closed, bounded JSON and canonical base64 and contain no naked bearer tokens. The same production application store is used by Spring and private test/runtime compositions.

Freeze first validates the whole original SQL inventory and proposed terminal suffix without writes in a bounded transaction. Outside SQL it asks the original worker to latch admission, join work and return a pre-cut inventory bound to retirement and SHA-256 of the exact prepared commit body. A second fresh transaction revalidates current authority, complete membership, deadline, terminal proof and worker observation, then persists FROZEN with the complete immutable envelope. The envelope contains exact commit body bytes/digest, independently derived original identity/token hash/pins, typed baseline, and exact worker observation bytes/digest. The frozen envelope digest is distinct from the prepared commit digest.

Cut consumes only that persisted envelope. It validates the active predecessor and unique original release suffix, inserts the exact resource/ref/transaction, preserves checkpoint identity and atomically persists CUT and SEALED head. Its declared terminal delta uses the current schema’s exact BIGINT epoch-millisecond time cells. It preserves the original database-derived millisecond value without DATETIME/time-zone conversion; it is not used as lease authority. Native live history remains active-only.

Finalization reads the immutable cut, performs the original worker RPC outside SQL, then verifies the exact original response and unchanged full inventory before persisting DRAINED and releasing the one logical Runtime Session. The worker compares executions, grants, results, receipts, history, retained backups/preimages and current files in both directions, closes admission and original descriptors, and returns exact cleanup facts. A cut/receipt retry is read-only with respect to live authority and never acquires, renews, executes, publishes an ACK or creates a new worker.

## Complete inventory and insertion fences

The explicit canonical typed inventory covers all 32 tables and all 736 columns after this additive migration: raw original identities, creation receipts, workspace/config/request pins, registration/holder/intent/slot/binding/control, logical runtime session, all native executions/grants/results/receipts/history, journal/resources/refs, publication/read/output state and unsupported secondary ledgers. It uses independent OR discovery over all states, bounded whole-table discovery for indirectly associated carriers, fixed-point reference expansion and full sorted primary keys. Unknown association, malformed/orphan rows and schema drift block; parent joins and live-state filters cannot hide them.

The budget is ten seconds per whole transaction, 4096 unique rows and 32 MiB aggregate typed evidence. Duplicate unchanged observations share accounting; conflicting bytes refuse. Every empty supported collection has a real producer fence. Generic mutation and collection paths exclude private sessions under original tenant/session locks; native paths consume same-Connection progress. Binding control follows placement → retention → complete sorted original slots/bindings → private pin/context → registration → holder → intent/progress → native head/history/resources → sessions/executions → publication/read/secondary inventory. The original owner follows this parent-lock order on the same Connection; RPC and filesystem work remain outside the cut transaction. Foreign-owner association checks can still acquire another owner’s parent after scanning its child rows.

Retained native file history is checked through its real journal/resource/embedded projection chain. Foreign snapshot manifests/pages/old body revisions and agent instructions/skills are verified using actual producer schemas, complete ownership and references rather than byte substrings or invented empty collections. This does not add historical physical-release authority.

Historical status and retry keep the original DRAINING holder in their read-only fixed-key image; there is no no-holder or released-history qualification. Main's actual `hosted_context_usage/latest` producer remains active. Its one closed typed Session record must equal the first and latest committed native `model.attempt/output_committed` events, including all scope, key, usage resource, sequence and event-time cells; every other cell stays NULL. Only its exact latest `SESSION_RECORD` reference is admitted beside the native JOURNAL references. That reference's SQL-created timestamp is independently bounded by the corresponding journal's database time and the fixed settlement deadline; it is not an event timestamp. Missing, duplicate, stale, forged or unknown projections and references refuse. Native proof replay still consumes only the independently validated JOURNAL resource memberships.

An installed JournalEventTransport is unsupported for private CREATE/request resolution/live authority and retirement, including an installed custom port when its config flag is false. Ordinary main transport remains supported. Turning off a previously installed transport does not establish that older remote work disappeared.

## Main compatibility and files

Keep main's published V11 wake migration and add V12 containing the eleven `ma_operation` progress/unique-target fields only. Do not add node-source/physical tables or change the 32-table contract. Inventory retains the four wake fields, including the generated scan predicate. Exact terminal head updates preserve main's wake-revision producer contract; generated cells are validated rather than ignored. Preserve strict UTF-8 VARBINARY identity decoding, opaque actor bytes, non-Managed broker compatibility and current main's unknown-commit reconciliation and query-budget behavior.

Changes span Hosted CSI ownership, core HTTP/authority preparation, worker finalization/protocol/backend/mount observations, Java application store/inventory/image/proof/progress, original SQL mutation gates and private controller/composition. New finalizer boot 6/resource handle 4 is explicit and retains boot 4/5 compatibility. Node source, installed-byte policy, physical coordinator, stop intent and public selectors are excluded.

## Validation and acceptance

Global CLI baseline is `qwen 0.25.2`: attach/text/retire routes return 404. This establishes unavailable capability only, not a SQL-protocol reproduction.

Run root build/typecheck/bundle; focused core and CLI preparation/barrier/finalizer/recovery regressions; JDK21 affected tests followed by full Maven verify, including both Checkstyle gates and SpotBugs. Real disposable MySQL8.4 acceptance must cover original actual SQL/worker retirement, exact retries/lost responses/deadline rejection, full inventory and rollback, RC/RR writer/control/read/snapshot races, and retained snapshot/agent compatibility. An actual private Hosted attach→settled file turn→begin→existing-owner retire→DRAINED probe must complement mocked barrier tests.

Acceptance requires unchanged original worker/binding/files/history/execution identities, no new execution or writer acquisition, DRAINED version4, sealed head, closed worker descriptors, logical session RELEASED while binding/holder remain DRAINING and slot occupied. Recovered owners refuse without mutation. Missing checks and environment limitations are reported explicitly; these tests do not qualify Linux physical stop/unpublish/reuse. Two clean complete diff audits and review follow verification.

## Open questions

Foreign-owner association checks retain late foreign-parent locks after bounded whole-table child scans. A concurrent ordinary writer for that owner can cause a deadlock or timeout; the bounded transaction rolls back and the caller must retry. Cross-tenant races have not been verified. Maintainers must review this remaining lock-order question before production qualification; this extraction does not invent a new cross-tenant locking protocol.

No new architecture choice is delegated to runtime defaults. Any mismatch between source candidate and current main's immutable history/schema/producer contract blocks extraction until its actual consumer is understood. Physical retirement and recovery→retirement qualification remain separate follow-ups.
