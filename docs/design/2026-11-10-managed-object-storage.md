# Pluggable Managed Session object storage

[English](2026-11-10-managed-object-storage.md) | [简体中文](2026-11-10-managed-object-storage.zh-CN.md)

Status: implemented locally; full CI, real MySQL, real object storage and cross-Harness acceptance pending.

## Goal and boundary

Deliver immutable Session resources first, followed by cold storage for closed Session journals. MySQL remains the authority for ordering, writer fencing, idempotency, references, and recovery. Object providers only create, read, and delete immutable bodies. Core and Harness keep their existing resource and journal interfaces.

Before this change, journal bytes and bounded Session resources were stored inline in MySQL. Tool Publication had an object adapter with tool-specific lifecycle/configuration, and operator recovery entrypoints constructed OSS clients directly.

## Provider contract

Publish a Spring- and SDK-independent `ImmutableObjectStore` and factory in contracts. Support bounded streaming create-if-absent, guarded reads and deletes, configuration validation, stable namespace identity, and close ownership. A create must never overwrite, expose partial bytes, or retry an uncertain physical write. Errors distinguish missing, existing, access denied, unavailable, and unknown write outcome.

Discover trusted factories using Java `ServiceLoader`; select one provider at startup with `object-store.provider` and `object-store.provider-options`. Unknown or duplicate providers and invalid configuration fail startup. Factory constructors are inert. Server, Broker, and operator tools use the same loader. Plugins depend only on same-version contracts; their JARs and dependencies must be on the runtime classpath. There is no hot loading, download mechanism, or online backend migration.

The default adapter is OSS. Its private, never-versioned bucket and overwrite-prevention requirements belong to that adapter, not the generic contract. Custom providers require no OSS configuration. Persist the stable store identity with every external object to reject namespace changes instead of reading an unrelated key.

The [standalone plugin example](../../packages/managed-agent-server/examples/object-store/README.md) provides the factory, SPI service entry, contracts-only POM, reusable contract check and explicit classpath/PropertiesLauncher instructions. Maintenance mains use system properties/environment configuration rather than Boot application configuration files. SQL-only inspection does not open an object client.

## Session resource protocol

New bodies up to 64 KiB remain inline; larger bodies use the selected store. The generic maximum is 64 MiB. Existing narrower semantic limits remain: checkpoint 1 MiB, input 8 MiB, skills 2 MiB, model request 32 MiB, and native snapshot page 16 MiB. Existing inline rows remain readable without migration.

Add `POST /resources:allocate` and streaming `PUT /resources/{resourceId}/content` under the private Session store API. Freeze the descriptor and writer identity at allocation. Verify complete uploaded bytes before publication and return the unchanged DurableRef. Never expose provider credentials or addresses to Harness.

Use `ma_operation` for durable physical PUT attempts. Unknown outcomes reconcile by reading the original immutable object, never by repeating the PUT. Resource state becomes publishable only after exact length and SHA-256 verification.

Read authorization and leases are admitted in short SQL transactions. Object IO and bounded dependency prefetch run outside SQL transactions. Commit rechecks writer/head/activation and every prepared resource descriptor before atomically writing journal, references, receipt, and head. Cover historical checkpoint dependencies, domain records, skills, tool details, diagnostics, snapshots, CSI, and maintenance readers. Unsupported reader profiles refuse before an external write. Transient failures do not become permanent corruption.

The negotiated storage reader version is 6. CSI opts into immutable resources with `csi-files-retirement/4`; earlier profiles retain their original storage floors. Tool result content/page/manifest limits remain 1 MiB/256 KiB/64 KiB, and `managed-config_install` remains 64 KiB. The prepared dependency set is bounded to 128 MiB and 512 preparation steps. Resource descriptors and canonical CSI SQL images retain their original external locators; verified bytes live only in the temporary read set.

Native snapshot publication stages immutable pages outside the final manifest transaction. Failure can leave unreferenced pages or an unpublished manifest claim for reconciliation/GC; the final transaction publishes all snapshot references atomically. Its public entry rejects an ambient SQL transaction. Existing snapshot readers still see only a completely published manifest. Disabling external writes preserves reuse of already-externalized pages.

## Retention and journal cold storage

New external writes and GC have independent, default-off controls. A retired Session collector and an abandoned-publication collector both use the existing operation ledger. Before deletion, verify reference absence, publisher fencing, read leases, and recovery protection, persist deletion intent, then delete outside SQL and confirm completion. The 24-hour grace starts only after the publisher is fenced and the reference/reader/recovery checks pass. Missing objects or expired leases do not settle uncertain PUTs. Disabling new writes does not disable reads, reconciliation, or collection.

Journal cold storage is separately default-off. Candidates are CLOSED/ARCHIVED, SEALED, recovery-ready, activation-released Sessions, cold for seven days and holding at least 32 MiB of journal bytes. Exclude active executions, lifecycle/recovery operations, read leases, CSI ownership, and deletion.

Keep journal rows, ordering, digests, receipts, references, and `compacted_through_revision` unchanged. Persist HOT/EVICTING/COLD/HYDRATING residency, task epoch, and a SQL-authoritative pack manifest. Versioned length framing preserves exact transaction bytes; gzip packs contain at most 64 MiB of uncompressed bodies and never split a transaction. Verify object and per-transaction digests and decompression bounds.

Upload and verify complete packs before publishing the manifest and clearing SQL bytes in fenced batches. Access hydrates the full journal before business code reads it. Every byte reader holds a HOT lease; locked code never fetches objects. Task epochs fence stale eviction workers. Hydration exceeding the request budget returns retryable `managed_session_journal_rehydrating`. CSI transitions and Workspace image creation hydrate first and retain protection. Keep redundant packs for 24 hours after hydration before reference-aware GC.

Foreground hydration has a 20-second cooperative budget; the background worker has 60 seconds per hydration attempt. Network calls remain bounded by the provider's own timeouts. Persist both the applied revision and final byte/digest-chain verification cursor so retries resume work. Core retries the rehydrating response within its existing request budget; Web Shell preserves the pending request until success or cancellation. A global CSI historical inventory obtains HOT leases for foreign journals before opening the successful SQL snapshot, and scans retained pack contents for references as well.

Configuration under `qwen.managed-agent.object-store` separates `resource-writes-enabled`, `gc-enabled`, `journal-cold-storage-enabled` and `journal-eviction-enabled`, all default off. `deletion-grace` defaults to `24h`. Pack-only mode enables cold storage while leaving eviction off. Unknown PUTs never become safely collectible based on elapsed time or object absence. Permanently retired journals release pack references only after their SQL journal retirement completes.

## Verification and rollout

Test independent plugin compilation/discovery and Server/operator use without OSS; bounded streams, immutable concurrent creation, uncertain writes, authorization changes, and deletion failures; mixed inline/external commits and cross-Harness recovery; every archive/hydration crash boundary, concurrent readers/deletion, stale workers, and exact-byte restoration.

Use focused Java checks, real MySQL concurrency cases, affected TypeScript tests/build/typecheck, and opt-in real provider acceptance. Mocks and H2 cannot establish real backend qualification. Follow the module's shared ten-minute local Java verification budget and report remaining CI/real-service gaps.

Update V1 baseline and its validators without V2 migrations or a database schema-version bump. Deploy all compatible readers before enabling external writes. Qualify resources before cold journals, and run pack-only verification before enabling eviction. Rollback stops new writes/eviction but retains compatible readers and recovery; old binaries cannot read already-externalized data.

Local validation: after synchronizing with main and its lockfile, root build, typecheck and bundle passed; selected Core/CLI/Web Shell suites passed 416 tests (242/121/53). Earlier focused Java runs provide combined passing evidence for 49 cases across plugins, resources, cold storage, context-compression replay and native snapshots. The last focused reactor run had one failure; the corrected snapshot regression passed separately after direct compilation. Earlier API/surface, Tool Publication and lock inventory checks passed on their tested source states. These results do not establish a successful final Maven verification.

Acceptance remains pending. The shared local Java verification budget is exhausted. Final changes to recovery-read guards and published-resource parity, external snapshot reuse with writes disabled, GC grace after publisher fencing, SQL-only CSI ACK inspection, and the schema-inventory count after synchronizing main have not been compiled or executed. CI must validate the final source, Checkstyle/SpotBugs, MySQL concurrency, independent packaged plugins, real OSS faults and cross-Harness recovery before completing the required self-audit and accepting the rollout. Preserve failed runs and distinguish focused tests from backend qualification in the PR verification report.
