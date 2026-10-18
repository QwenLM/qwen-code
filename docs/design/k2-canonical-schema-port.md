# K2 canonical schema port

[English](k2-canonical-schema-port.md) | [简体中文](k2-canonical-schema-port.zh-CN.md)

## Status and problem

Implementation and compatibility verification are in progress. This document
describes the K2 port to main's fresh canonical managed-agent schema. It does
not qualify application retirement, physical release, or safe volume reuse.

Main consolidates the legacy tables into 32 `ma_*` tables with 707 columns.
K2's old table names, row ownership rules, journal keys, and component snapshot
format cannot be retained through aliases. The fresh initializer rejects a
legacy database; the additive K2 migration provides no legacy backfill or compatibility view.

## Schema and row identity

Preserve the current main V1–V10 bytes. V1 has 32 tables and 707 columns, including the retry-budget fields; V2 adds four private CSI authority columns, V3 changes the list index, V4 extends the Workspace creation receipt namespace, V5 adds four model-selection columns, and V6 adds four approval-selection columns. V7 adds the SSH storage index and extends operation kinds; V8 adds input/cancel operation kinds, without adding tables or columns. V9 adds the runtime Session harness index without adding tables or columns. V10 adds the Session and Turn plan-policy columns. The unpublished K2 retirement increment moves to V11 with unchanged SQL bytes, adding eleven application progress columns, `ma_csi_source` (19 columns) and `ma_csi_physical` (six columns). The effective schema has 34 tables and 757 columns. Application inventory covers 33 tables and 751 columns; the physical companion is inspected separately. `ma_session.csi_guard` is generated from the private tool profile or durable runtime request pin.

All thirteen new main fields participate in typed whole-row comparison, including Session model `(NULL,0)`, both NULL Turn model fields, three retry-budget fields, four approval-selection fields and both plan-policy fields. The private Session supports only approval override `(NULL,0)`; nondefault overrides block while ordinary approval selection retains its main behavior. Turn approval fields preserve their actual nullable snapshot. `model_id` uses strict UTF-8 identity decoding without becoming a new strong reference root. The private first lane keeps its fixed native model policy: only the actual Session defaults `(NULL,0)` are supported; a nondefault selection is captured in full and blocks retirement. Ordinary public model selection remains unchanged. An older inventory/2 baseline missing these columns still refuses: no default-value backfill, header/hash rewrite or saved-byte upgrade. Unpublished K2 V4/V6/V7 are not relabeled as published main migrations and Flyway history is not repaired. Old private preview catalogs missing the published SSH index or operation checks are refused before migration; retain their original build for access and use a fresh disposable catalog for this candidate.

Native resource read evidence uses the existing `ma_request_receipt`, namespace
`SESSION_COMMAND`, operation `CSI_RESOURCE_READ`, and the actual
`key("csi-read", readId)` primary key. Its closed JSON has 23 admission fields
and 25 completion fields. Inventory checks the complete outer row, the initial
request digest, and the original resource/journal/writer association. OPEN and
UNKNOWN receipts block application retirement. There is no separate native
read table or synthesized compatibility row.

Identities use the canonical VARBINARY columns and strict UTF-8 decoding. Opaque
actor keys remain bytes. Hashes and primary keys follow the actual producer:
session scope is `ManagedSchemaKeys.key(tenant, session)`, resource identity is
`key(scope, resourceId)`, and the CSI retirement operation identity is
`key("CSI_RETIREMENT", tenant, retirementId)`. This last identity differs from
the generic operation-key helper used by output operations.

Retirement uses the real `ma_operation` row, with immutable request JSON and a
versioned result envelope. The decoder verifies the complete raw identity,
target, request digest, scope, kind, generation, and result data. Progress CAS
updates are scoped by the true operation key and kind. Journal resource refs
must match their actual owner kind, owner key, owner revision, resource key, and
raw identity tuple. Session-record refs keep their domain revision semantics.

## Inventory and history

Application inventory uses `qwen-csi-application-inventory/2`; the component
checkpoint snapshot uses `qwen-csi-retirement-inventory/2`. Version 1 is refused
because its table and ownership semantics differ. Readers and fixtures must
move together; changing a header alone is insufficient.

Both live inspection and retained history validate the canonical catalog on
the same JDBC Connection. They share the existing ten-second query budget,
4096-row bound, and 32 MiB whole-row bound. Historical owner lookup uses the
tenant and actual operation primary key. Repeated reads account for each
whole row once and reject changed duplicates.

Ownership is determined from actual parent and domain relationships. A row
that does not directly name the original session is not automatically an
unrelated row. Shared tenant guards, root workspace state, storage aliases,
and mode receipts have explicit context roles; strong references to the
original lineage are checked before assigning those roles. Unsupported
original activity blocks retirement. Expected images retain all row values
except the declared stage delta.

## Runtime and mutation boundaries

The port keeps main's producers for session birth, event streams, workspace
operations, captures, and resources. Native writer admission checks the
original CSI boundary before creating a session root or journal head.
Ordinary action, extension, dispatch, and output mutation paths retain their
private-session guards. Collection excludes private sessions before paging and
checks their stored target again under the claim transaction.

Native resource reads, authorization, terminal commit, and original runtime
session completion use canonical tables and keys. Application progress stays
SETTLING/1, FROZEN/2, CUT/3, and DRAINED/4. Physical RELEASED is a separate
milestone and cannot be inferred from DRAINED.

## Affected components and validation

The affected components are the runtime-broker canonical schema and JDBC
repositories, managed-agent stores and inventory/image/history readers, and
TypeScript checkpoint consumers. Tests must initialize the fresh schema and
create rows through actual producers where possible. Fault injection must
observe the current SQL boundary rather than an obsolete statement spelling.

Acceptance requires schema agreement through both initialization paths,
ordinary behavior regressions, private backlog isolation, native and
checkpoint contract checks, exact application images and rollback/retry
behavior, synchronized readers, build/typecheck, and two clean full-diff
self-audits. Pure H2/data checks do not establish Linux, CSI, or node-source
qualification. Restricted acceptance remains recorded as incomplete.

## Scope and remaining work

This port does not install a collector or create paid nodes. Source installation
and confinement qualification, atomic physical release, retained old
credential validation, monotonic safe reuse, and public selection remain
separate K2 work. Passive ownership support for remaining canonical artifact and secondary domains is still incomplete; unknown rows remain blocked. Public selection stays closed until those prerequisites
have passed their required checks.

## New main ordinary mutation isolation

Lifecycle failure settlement checks the actual private fence before operation/head DML. Ordinary model-usage UI projection requires `csi_guard=FALSE`; private journal model events and original resources remain intact without adding a `hosted_context_usage` domain/ref. Action dispatch and ended-action settlement scans exclude private Sessions before LIMIT and recheck inside the claim/settlement transaction; tool-result capture retains its method-level private refusal. The new approvalMode creation overload still checks resident registration or LOCAL storage.

Ordinary H2 data-component controls verify these boundaries, without establishing MySQL locking, native producer, physical stop or volume-reuse qualification.

## Passive Workspace creation receipts

The global receipt scan also sees normal public Workspace creation. A completed `WORKSPACE_CREATE` receipt can belong to a different Workspace even within the original tenant; treating every such row as an unknown owner blocks an otherwise unrelated retirement. Support only this completed producer shape. Pending, orphaned, unknown and conflicting receipts continue to block.

Verify the actual receipt key, tenant/scope/idempotency hashes, actor scope, `CREATE_WORKSPACE` operation, completed state and all unused domain columns. Decode either the original exact four-field saved result or the current exact seven-field result with sourceWorkspaceId/sourceGeneration/cwdRelative all explicitly null, retaining the producer's name/digest and canonical registration UUID. Partial extensions, non-null directory selections and unknown fields remain unsupported. The Workspace and storage IDs must be derived from the actual receipt key. Read the actual root Workspace and registered LOCAL alias on the existing Connection, check their exact identity and registration association, and reject the original Workspace, storage, physical key or any original strong reference. Retain complete rows and the existing aggregate limits. This is passive attribution only: it performs no filesystem or runtime I/O, changes no owner and does not accept original Workspace creation as supported retirement work.

Ordinary H2 tests use the real public Workspace creation producer, preserve full receipt and original-row bytes, and cover malformed hashes/results, missing or changed parents/aliases, original references and pending state. These tests do not establish MySQL lock ordering or physical qualification. Artifact and delivery ownership still require their separate producer chains; this change does not classify unknown rows as unrelated.

This change attributes live inventory only. It does not extend historical carrier decoders or qualify arbitrary concurrent foreign activity; whole saved OTHER rows still participate in image comparisons.

## Main b3c5d3ed1e compatibility

The merge retains published V1–V9 resources byte for byte and appends only the unchanged private retirement DDL at V10. Both explicit initialization and Flyway must recognize and preserve all published predecessors, ordinary rows and installed history. The canonical DDL composer supports main's complete check replacement together with K2 table/column/unique-index additions; the same-Connection validation overload used by live inventory and retained history remains mandatory. A former private V7 catalog is not a published V7 predecessor and must refuse without repair or partial migration.

Main adds no table or column in V7/V8/V9, so the existing typed inventory remains 33 tables/749 columns plus the six-column physical companion. New SSH and command-operation activity still passes the existing ownership and supported-activity rules; it is not silently classified as unrelated. Ordinary cancellation keeps its private Session guard before operation admission. Foreground-only SSH tool declarations retain their no-monitor/no-background shape while sharing the existing Write/Edit descriptions. Private version-six boot refuses SSH runtime injection along with non-container and publisher modes.

Focused H2/mock, repository build checks and disposable MySQL 8.4 V9-to-V10 migration checks cover this compatibility increment. Private Main/F2, Hosted/native fault groups and physical/reuse qualification remain outside these checks.

## Published main V10 plan-policy continuation

The latest-main Flyway check reproduced a version collision between published `V10__session_plan_mode.sql` and the private retirement migration at head `167edd8222`. This candidate incorporates main `970b8876294d400183974b24f81240cceee7b67f`, preserves all ten published SQL resources byte for byte and moves only the unchanged private retirement resource to V11. Published main V10 upgrades append V11 while preserving existing plan-enabled Session/Turn values and every old Flyway history row. Earlier V9-to-V10 results above retain their historical scope.

Both new plan columns are mandatory typed whole-row facts. The supported original private Session requires `plan_enabled=FALSE`; an enabled value blocks application qualification. The original `ma_turn` ledger remains expected-empty/unsupported. Adding its schema column does not admit new private Turn activity. Historical images retain the exact new columns without masks or defaults. Missing-column inventory/2 bytes and the former private V10 catalog without published plan columns refuse; neither direct initialization nor Flyway may adopt or repair that catalog. Existing binaries remain necessary for old development histories.

The merge preserves ordinary plan-mode and attachment behavior, the complete Session-creation overload chain and private mutation guards. The shared Hosted model retains both prompt-hook composition and dynamic plan instructions, while K2 still commits complete final Parts before consumption and retains its original cold-output path. This does not enable plan mode, attachments or a broader Part grammar for the private CSI profile.

Bounded local compatibility verification has passed. The same-worktree SDK/Server source reactor completes all default unit/static gates and eight affected MySQL classes: SDK 390 tests with nine conditional skips, Server 5,229 with 18 conditional skips, and MySQL 151 with no skips; all have zero failures or errors. Both Server Checkstyle executions and SpotBugs are clean. Independent MySQL observers verify published V10-to-V11 true-plan row/history preservation and refusal of the actual former private V10 catalog, with and without genuine old history, without DDL, row or history changes. The complete 33-table/751-column typed inventory, real foreign snapshot/agent producers and historical scan retain their full bytes; the historical scan performs no writes or locks. The active-inspection field controls retain unrelated fixture blockers and do not establish a separate positive active qualification. The real SQL-worker retirement original independently reaches DRAINED/4 and exercises retained reads before and after worker shutdown.

Root build/typecheck/bundle, focused Core/WebShell regressions and the complete 579-case Hosted Session rerun pass. The initial combined CLI run had one wake-park refusal-code mismatch whose cause remains unconfirmed; its unchanged full-file rerun is separate evidence. Three unchanged-main workflow meta-test fixtures fail on the local macOS Bash 3.2 parser, without establishing Ubuntu results. These limits and the earlier failed validation attempts remain in the E2E record; local results are not a CI or cumulative Draft approval.

Cold writer contention and standalone content-publication stale-owner acceptance remain planned increments. Native installation, qualified physical release and reuse remain unfinished.
