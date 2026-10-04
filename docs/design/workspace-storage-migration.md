# W1c: Offline Workspace storage migration

[English](workspace-storage-migration.md) | [简体中文](workspace-storage-migration.zh-CN.md)

## Status and scope

Implemented locally and integrated with main `5130c1a73`, including W1b, reliable Session close, durable-process defaults and output collection. Production Linux acceptance remains pending. One trusted Linux host, accessible original storage, settled `hosted-workspace-files/1` Sessions, and an unchanged absolute `QWEN_HOME`/file-history volume. Only the Workspace root moves. Shell/O2, MCP/Hook, external Memory roots, opaque absolute-path dependencies, cross-host and source-lost recovery are excluded. All retained storage members participate, including closed, archived and deleted records. Unsupported or unprovable members block the entire operation.

Logical storage, all ContextBinding fields, private Session Store keys, original creation receipts, journal, messages and resource references remain immutable. Migration does not close public Sessions or reopen closed Sessions.

## Maintenance protocol

Private Java commands are `retire`, `prepare`, `promote`, `inspect`, and `abort`. The versioned request pins migration UUID/digest, tenant/storage, expected mount revision, original and target deployment paths, W1a fence UUID, W1b capture UUID, and the retained history volume. Same UUID with changed parameters conflicts. States progress `RETIRING -> RETIRED -> PREPARING -> PREPARED -> COMPLETED`; drift becomes `INVALIDATED`, explicit cancellation becomes `ABORTED`. Transient I/O preserves checkpoints. Completed replay returns the original receipt; a repeated `prepare` on PREPARED also returns its saved receipt, without a fresh scan. Only a new promotion attempt performs fresh verification.

Operators disable Session creation, input admission and dispatch, settle accepted work, stop Harness/journal writers and prevent restarts. `retire` installs a durable storage admission fence under the existing tenant placement lock, releases exact saved Runtime Sessions, proves physical worker retirement and checks unsettled executions/holders. It reuses reliable close's drained-stop receipt and bounded claims, but never installs its permanent Harness close fence. Admission and final metadata checks retain the existing tenant-wide placement lock: unrelated storages of that tenant may wait until these metadata transactions finish; file scans and physical retirement run outside it. Unbound legacy Sessions have no storage ownership and are not covered by this storage fence. Old FAILED/LOST/RELEASED records need positive stop evidence; labels and expired leases are insufficient. Existing loss recovery must complete through its original protocol.

After retirement, operators enter the W1a maintenance fence and capture W1b evidence with an externally prepared Workspace copy. `prepare` validates that fixed capture, current source, target copy, migration eligibility and history volume. `promote` repeats verification in a fresh run; an old successful receipt never authorizes a current transition. No Runtime is acquired during maintenance.

## Evidence and atomic promotion

Reuse W1b's bounded Session cuts, resource closure, history parsers and streaming tree checks. All retained backups are checked; original nonexistence, not-captured history and missing backups remain distinct. Hosted relative history keys resolve against the new effective directory; saved backup names and bytes are unchanged.

The only target-tree exception is the exact root `.qwen-managed-storage.json`: it must match either the sealed source marker or this operation's pinned target marker. Publish the replacement through an operation-owned temporary file inside the target filesystem and atomic replacement, then sync the target directory. Before retry verification, remove only that exact ordinary, single-link temporary whose bounded bytes match a prefix of the pinned marker, and only after confirming its path is absent from the sealed capture. Conflicting objects are refused; the complete target census ignores no entries. Never exclude other `.qwen*` files or modify the original bundle/source marker.

The final SQL transaction checks operation ownership, original revision/fence, complete source cut and old-placement stop evidence, installs target root/identity/new registration UUID, increments revision once, persists completion and clears migration admission. Failed precommit steps preserve the original fenced registration. Marker publication before SQL is resumable with the same operation. Abort preserves retired facts and W1a fence; it neither deletes the target nor reopens service. If an aborted or invalidated operation left a marker or temporary file, a new operation needs an externally rebuilt target copy matching its new capture; it never accepts or deletes another operation's artifacts. Reverse migration requires a fresh operation/capture and a higher revision.

Long file scans hold no database locks. Final conditional reads follow existing lock ordering and use a fresh locked authority check. Add new Flyway migrations only, retaining V31 W1b, V32 close and V33–V34 definition/collection bytes; W1c adds V35 for migration state and fences; V36 adds lookup indexes for historical Sessions and completed migrations.

## Deployment and Runtime routing

Operators change deployment mounts and restart Broker/Harness after completion. Configuration that disagrees with SQL identity fails closed. The private maintenance process must inherit the same canonical absolute QWEN_HOME as the deployment, with no symlink components, and fileHistoryRoot must equal its canonical file-history directory. The private Node probe uses the existing Storage resolver and that inherited environment to pin history identity outside source, target and bundle. New admission/provisioning checks environment and directory identity without scanning backups per Turn. No Worker boot/attestation wire expansion is required.

Fresh file Turns and undo acquire new placement/context/attestation/activation receipts. Old status/cancel/release retain saved binding/generation/scope. Historical Runtime Session lookup must use exact tenant/Harness/Runtime identity rather than today's mount scope, rejecting ambiguity. A nonunique Runtime Session ID index locates candidates before full tenant/Harness identity and ambiguity checks; the single VARCHAR(512) column uses 2048 bytes under utf8mb4 without new hash columns or backfill. Standalone Broker initialization keeps the same schema and adds missing indexes to existing tables. No saved cwd, durable handle, execution ID or attestation is rewritten.

## Validation and acceptance

Test multiple Workspaces/Sessions per storage, retained lifecycle states, historical undo and new history, delayed warm/startup, release/stop acknowledgement loss, stale Broker callbacks, every file/SQL boundary interruption, concurrent promote/abort/W1a restore, membership/model/writer/close drift, root/history replacement, marker conflicts, unsupported profiles and path entries. Regress W1a cold load, W1b receipts, close and historical cleanup. Large files stream and all lists page.

Required acceptance uses production Linux host/mount identity, MySQL 8, packaged Harness/Worker and Java Broker for stop-retire-capture-prepare-promote-restart-write-undo. Build/typecheck/bundle, focused TS/Java tests, MySQL concurrency, two consecutive clean self-audits and independent review precede completion. macOS/H2, injected identities, logical crash simulation and actual physical interruptions are reported separately; unexecuted scenarios cannot be called passed.

## Implementation areas and decisions

Runtime Broker admission/repositories/drained retirement and exact historical lookup; Managed Agent migration store/private main/Storage guard; shared TypeScript recovery closure/tree verification; additive SQL and collocated tests. No public API, online drain, hot mount resolver, general orchestration framework or directory-copy implementation. No open scope decisions remain.
