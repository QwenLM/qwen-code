# Managed Agent Tier-1 Convergence (OSS hot path, dead code, packaging)

[English](2026-11-12-managed-agent-tier1-convergence.md) | [简体中文](2026-11-12-managed-agent-tier1-convergence.zh-CN.md)

Status: proposed; scope confirmed with the maintainer. The service is
pre-production, so backward-compatibility constraints are dropped where they only
existed to protect existing deployments. Confirmed scope: remove the OSS read-path
versioning probe (keep the put/delete probes); decouple the generic object-store
auto-configuration from tool publication; delete the dead K1 provisioner; fix the
`sessionWorktreeScheduler` default candidate; apply strict session mode uniformly
across the managed MySQL pools; and collapse the distribution to a single
executable jar. Environment-variable dialect unification stays out of scope.

## Problem

A whole-module architecture review of `packages/managed-agent-server` proposed a
first tier of "high-ROI, low-risk" convergence items. Source-level verification
against the current tree corrected several overstated suggestions (see Current
state). This design records the verified state and the bounded change set, simplified
for a pre-production service with no existing deployments to protect.

The three items in scope:

1. OSS hot-path RPC removal and decoupling the generic object-store
   auto-configuration from `tool-publication.enabled`.
2. Dead-code cleanup, the `sessionWorktreeScheduler` default-candidate fix, and
   uniform strict-mode defaults across the split `DruidDataSource` factories.
3. Packaging convergence: a single executable jar instead of seven repackaged
   fat jars, dispatched by the existing unified admin launcher.

## Current state (verified)

### OSS object store

`adapters/.../artifact/AliyunToolPublicationObjectStore.java`:

- The constructor calls `validateConfiguration()` (a `getBucketVersioning`
  round-trip) and `getBucketAcl` (private-bucket check).
- `putIfAbsent`, `deleteIfPresent`, `open(key, guard)` and `openRange` each call
  `validateConfiguration(guard)` again, adding one `getBucketVersioning`
  round-trip per operation.
- `validateConfiguration()` is a method on the SPI interface
  `contracts/.../artifact/ToolPublicationObjectStore.java`, with two live
  production call sites: `ToolPublicationDataStore.verify()` (async publication
  verification) and `ToolPublicationCollector.runOnce()` (page-level GC probe,
  only when a page carries physical keys).

Constraints:

- `verification/.../artifact/AliyunToolPublicationObjectStoreTest`
  `deletionRejectsVersioningEnabledAfterConstruction` pins that, after
  construction, a bucket whose versioning becomes `Enabled`/`Suspended` must make
  `deleteIfPresent` refuse before calling `deleteObject`. This is a data-erasure
  correctness invariant, not a compatibility artifact: on a versioned bucket a
  delete creates a delete marker rather than physically removing the object.
  `docs/design/managed-tool-output-retention.md` and
  `docs/design/2026-09-27-managed-tool-result-hosted-delivery.md` document the
  same requirement (the latter because `x-oss-forbid-overwrite` is ineffective in
  those states).
- `verification/.../AliyunToolPublicationObjectStoreTest` (root package)
  `retriesTransientGetAndRechecksTheOriginalGuard` asserts the guard runs three
  times on a retried read: once before the versioning probe and twice before the
  two `getObject` attempts. Removing the read probe changes this count to two.
- `verification/.../persistence/AliyunToolPublicationReadRetryTest`
  `transientReadsRecoverWithTheRealSdk` expects three `versioning` requests on
  its versioning rows: the constructor probe fault plus its retry, and `open`'s
  re-probe. Removing the read probe changes this count to two.
- `verification/.../persistence/O4OssGate.java` delegates to the real store and
  does not count probes; its restricted identity skips `validateConfiguration`
  because the probe is itself a storage operation. Keeping the delete probe
  preserves the `ACCESS_DENIED` semantics it asserts.

### Object-store auto-configuration

- `server/.../config/AliyunToolPublicationStorageAutoConfiguration.java` was gated
  on `qwen.managed-agent.tool-publication.enabled=true`,
  `@ConditionalOnBean(ToolPublicationConfiguration.class)` and
  `@ConditionalOnMissingBean(ToolPublicationObjectStore.class)`. It defines the
  `toolPublicationOss` client bean and the `toolPublicationObjects` store bean.
- `server/.../config/ToolPublicationConfiguration.java` (the publication service)
  is gated on the same `tool-publication.enabled` property.
- Consumers that are not publication — `JdbcSessionResourceObjects`,
  `JournalPackTransactions`, `JdbcManagedSessionStore`, `WorkspaceRecoveryStore`
  /`WorkspaceRecoveryReader`, the `WorkspaceCsi*` stores — acquire the store via
  `ObjectProvider`/`@Nullable` and fail closed (HTTP 501
  `managed_session_oss_disabled`) when it is absent. Consequently, enabling
  `session-resources` OSS storage previously required also enabling
  `tool-publication.enabled` purely to obtain the store bean.
- `verification/.../config/ToolPublicationStorageConfigurationTest` pins the
  gating; its `ApplicationContextRunner` does not load `application.yml`.
- `application.yml` already uses a nested-placeholder default for
  `session-store.enabled` (it follows `harness.enabled`), an established pattern
  for one feature flag following another.
- OSS connection settings (`oss-endpoint`, `oss-region`, `oss-bucket`) live under
  `tool-publication.*` (bound from environment variables); `AliyunObjectStoreClient`
  reads them through `ManagedAgentSettings.getToolPublication()`.

### Dead code and configuration

- `runtime-kubernetes/.../KubernetesRuntimeProvisioner.java` (the K1 slice,
  kind `kubernetes`) is dead in production. The module's
  `META-INF/services/...RuntimeProviderFactory` registers only
  `KubernetesRuntimeProviderFactory`, whose `kinds()` returns only
  `kubernetes-workspace`. `RuntimeProviderRegistry` reserves and rejects the
  `kubernetes` kind. The only references to the K1 class are two K1 tests
  (`KubernetesRuntimeProvisionerTest`, `KubernetesRuntimeWorkerTest`), the
  K1-test-only fixture `FakeKubernetesRuntimeClient`, and
  `docs/runtime-broker.md`. **The `KubernetesRuntimeClient` SPI interface is
  live** (`WorkspaceCsiResourceGuard`, `WorkspaceCsiRuntimeProvisioner`, and
  `KubernetesMaintenanceClient extends KubernetesRuntimeClient`); it must stay.
- The `"kubernetes"` disjuncts in `ManagedAgentProperties`
  (`applySessionStoreDefaults`) and `EmbeddedRuntimeBroker`
  (`resolveWorkspaceCwd`/`resolveWorkspaceId`) are unreachable because the kind
  is rejected, but harmless. The reservation guards in `RuntimeProviderRegistry`
  are live and documented. The `"kubernetes"` strings in `HarnessConfiguration`
  and `HarnessPoolConnector` are the Harness pool discovery mode, unrelated to
  the Runtime provisioner.
- **`JdbcRuntimeBrokerSchema` is not deletable.** It has zero `src/main` callers
  but is the schema initializer used by 13+ verification test classes and is
  documented in `docs/runtime-broker.md` as the Broker schema entry point. The
  review claim "production-unused, delete" is incorrect.
- `ManagedArtifactConfiguration.sessionWorktreeScheduler` is the only scheduler
  bean in that class missing `defaultCandidate = false`. All 24 `@Scheduled`
  methods in the module specify an explicit `scheduler=` qualifier; none relies
  on default-candidate resolution. In embedded mode the missing annotation lets
  this single-thread worktree pool become the host application's default
  `TaskScheduler`.
- Four `DruidDataSource` builders were inconsistent:
  - `ManagedAgentServerApplication.standaloneDataSource`: binds
    `spring.datasource` + `spring.datasource.druid`, calls
    `MySqlStatementCache.fillDefaults`, did not set `STRICT_TRANS_TABLES`.
  - `ManagedAgentPersistenceConfiguration.managedAgentDataSource` (embedded):
    reads `qwen.managed-agent.datasource.*`, set `STRICT_TRANS_TABLES`
    connection-init SQL for MySQL/MariaDB, calls `fillDefaults`.
  - `WorkspaceRecoveryApplication.dataSource`: bound `spring.datasource` and
    `spring.datasource.druid` through `@ConfigurationProperties` (after the bean
    method returned), skipped `fillDefaults` and `STRICT_TRANS_TABLES`.
  - `ManagedLocalConfiguration.managedLocalDataSource`: H2-specific
    (`managed-local` profile), intentionally different.
    The embedded vs standalone property-prefix difference is intentional: an
    embedded host owns its own `spring.datasource`. The `STRICT_TRANS_TABLES` split
    was documented in `README.md` as a caller responsibility; pre-production, that
    document is updated to a single uniform rule rather than preserved as a
    constraint.

### Packaging and operator entry points

- The unified admin launcher **already exists**: `bin/qwen-managed-agent-admin`
  (PR #15772, `docs/design/2026-10-23-managed-agent-admin-launcher.md`) dispatches
  all maintenance commands from the executable server jar via Spring Boot
  `PropertiesLauncher`, including `operator-recovery`
  (`maintenance.WorkspaceRecoveryCommand`). The review suggestion "switch to a
  unified CLI subcommand dispatch" is already implemented.
- That design recorded dropping the classified jars as deferred follow-up and
  keeping the operator-recovery jar and launcher as a non-goal — both to protect
  existing distributions. Pre-production there are none, so this batch drops
  every classified jar and the dedicated operator-recovery launcher.
- `server/pom.xml` defines seven `spring-boot-maven-plugin:repackage` executions
  (`exec` plus six operator tools) and seven `maven-jar-plugin` classifier
  executions, governed by `managed.operator-tools.skip/attach/jar.phase`
  (default `false`/`true`/`package`; the `no-operator-tools` and `central-release`
  profiles skip them).
- `scripts/package-managed-agent-reference.mjs` currently ships two jars: the
  `exec` jar (as `lib/<server jar>`) and the `operator-recovery` jar, with a
  dedicated `bin/qwen-managed-agent-operator-recovery` launcher. The container
  selects only the `exec` classifier (`ContainerArtifactSelectionTest`). The
  `operator-recovery` launcher is functionally redundant with
  `bin/qwen-managed-agent-admin operator-recovery`, which runs the same main class
  from the `exec` jar.
- Consumers that name classified jars: `README.md` (workspace-migration private
  artifact), `docs/design/2026-10-01-managed-workspace-w1b-bundle.md`
  (workspace-bundle artifact), `docs/users/hosted-workspace-recovery.md` and the
  configuration reference (operator-recovery launcher), the E2E meta-test
  `scripts/tests/managed-agent-server-e2e.test.js`,
  `scripts/tests/package-managed-agent-reference.test.mjs`, and
  `scripts/run-managed-agent-server-e2e.ts`.
- The admin-launcher design explicitly decides "It maps no environment. Each
  entry point keeps reading its own credentials": `W1_JDBC_*` for Workspace
  commands, `K2_JDBC_*` for CSI commands, `SPRING_DATASOURCE_*` for
  `operator-recovery` and `resident-retirement`. These dialects are load-bearing
  in the E2E scripts, MySQL integration tests and deployment docs.
- `WorkspaceCsiHostedMain` is **not** dead: it is a package-private helper called
  by `WorkspaceCsiRuntimeMain` and has its own test.

## Goals

- Remove the redundant per-read `getBucketVersioning` round-trip on the OSS read
  hot path without weakening any storage-safety invariant.
- Let non-publication features (session resources, journal packs, CSI recovery)
  obtain the generic object store without enabling tool publication.
- Delete the genuinely dead K1 provisioner and its test-only fixture; fix the
  `sessionWorktreeScheduler` default-candidate bug; apply strict session mode and
  the statement cache uniformly across the managed MySQL pools.
- Collapse the module build and distribution to a single executable jar,
  dispatching every maintenance command (including operator-recovery) through the
  admin launcher.

## Non-goals

- Removing the per-call probe from `putIfAbsent` or `deleteIfPresent` (a
  correctness invariant: forbid-overwrite and physical-deletion refusal on a
  drifted versioned bucket; pinned by the deletion regression test).
- Removing the `validateConfiguration()` SPI method or its two explicit
  production call sites.
- Deleting `JdbcRuntimeBrokerSchema` (test-only but load-bearing; relocation to
  verification is a separate future decision).
- Removing the `kubernetes` reservation guards, or touching the unrelated
  Harness pool-discovery `"kubernetes"` strings.
- Unifying `W1_JDBC_*` / `K2_JDBC_*` / `SPRING_DATASOURCE_*` into one dialect
  (a deliberate admin-launcher design decision; the dialects are load-bearing in
  E2E, integration tests and operator docs).
- Consolidating the 16 scheduler pools or the six coordinator lease loops (the
  review's tier-2 structural work, with deliberate isolation reasons documented
  in each scheduler's Javadoc).

## Proposed solution

### 1a. Read-path probe removal

In `AliyunToolPublicationObjectStore`, remove the `validateConfiguration(guard)`
call from `open(key, guard)` and `openRange`. Keep it in the constructor,
`putIfAbsent` and `deleteIfPresent`, and keep the public `validateConfiguration()`
SPI method and its `ToolPublicationDataStore.verify()` /
`ToolPublicationCollector.runOnce()` call sites unchanged.

The guarded read loop still runs the guard before every `getObject` attempt and
retry, so the interface contract "check authorization before each new storage
request, including implementation retries" is preserved. Update
`retriesTransientGetAndRechecksTheOriginalGuard` to expect two guard runs instead
of three, and the versioning rows of `AliyunToolPublicationReadRetryTest`
`transientReadsRecoverWithTheRealSdk` to expect two versioning requests instead
of three. `deletionRejectsVersioningEnabledAfterConstruction` and the remaining
request-count tests stay green. Reads on a bucket whose versioning drifts after
construction are detected at the next verification, GC page or deletion; every
external read still verifies length and SHA-256 and fails closed on mismatch.

### 1b. Object-store auto-configuration decoupling

Add a neutral flag `qwen.managed-agent.object-storage.enabled`:

- A new `ObjectStorage` nested class in `ManagedAgentProperties` (boolean
  `enabled`, default false).
- In `application.yml`:
  `object-storage.enabled: '${QWEN_MANAGED_AGENT_OBJECT_STORAGE_ENABLED:${qwen.managed-agent.tool-publication.enabled:false}}'`,
  mirroring the existing `session-store.enabled` follows-`harness.enabled`
  pattern. A session-resources-only deployment sets `object-storage.enabled=true`
  with `tool-publication.enabled=false`.

Change `AliyunToolPublicationStorageAutoConfiguration` gating to
`@ConditionalOnProperty(prefix = "qwen.managed-agent.object-storage", name = "enabled", havingValue = "true")`
plus the existing `@ConditionalOnMissingBean(ToolPublicationObjectStore.class)`.
Remove the `tool-publication.enabled` condition and the
`@ConditionalOnBean(ToolPublicationConfiguration.class)` condition. Keep the class
name and the `toolPublicationOss` / `toolPublicationObjects` bean names (referenced
by `HostedGateTestSupport`, `HostedShellLifecycleFixtureMain` and the configuration
test); a rename is optional follow-up.

OSS connection settings stay under `tool-publication.oss-*`; no property
migration. `ToolPublicationConfiguration` keeps its `tool-publication.enabled`
gate and its required `ToolPublicationObjectStore` constructor parameter, so
enabling publication without a store still fails closed at startup.

Update `ToolPublicationStorageConfigurationTest`: the `ApplicationContextRunner`
does not load `application.yml`, so every case that exercises the
auto-configuration sets `object-storage.enabled=true` explicitly. The former
`maintenanceContextsDoNotInitializePublicationStorage` case becomes
`genericStorageDoesNotRequirePublicationConfiguration`: with
`object-storage.enabled=true`, no `ToolPublicationConfiguration` and tool
publication disabled, the generic store is still created (and no publication
datastore), proving the decoupling. Update the README "Tool publication storage"
section, the configuration reference (a new `object-storage` section, both
languages) and `configuration-descriptions.json`.

### 2a. K1 dead-code deletion

Delete `KubernetesRuntimeProvisioner.java`, `KubernetesRuntimeProvisionerTest`,
`KubernetesRuntimeWorkerTest` and `FakeKubernetesRuntimeClient`. Update
`docs/runtime-broker.md` to remove the K1 slice description and its dangling
references. Keep `KubernetesRuntimeClient`, `KubernetesMaintenanceClient`,
`KubernetesHttpRuntimeClient`, `KubernetesRuntimeProviderFactory` and the
resident/CSI provisioners. Keep the `RuntimeProviderRegistry` reservation guards.
The unreachable `"kubernetes"` disjuncts in `ManagedAgentProperties` and
`EmbeddedRuntimeBroker` are left as-is (harmless, guarded by the reservation).

### 2b. JdbcRuntimeBrokerSchema

No change. Keep the class and its documentation. Record relocation to
verification fixtures as a separate future decision rather than a deletion.

### 2c. sessionWorktreeScheduler default candidate

Add `defaultCandidate = false` to the `sessionWorktreeScheduler` bean in
`ManagedArtifactConfiguration`, matching every other scheduler bean in the class.
No `@Scheduled` method relies on default-candidate resolution, so standalone
behavior is unchanged and embedded hosts no longer inherit the worktree pool as
their default scheduler.

### 2d. Uniform managed MySQL pool defaults

Add `ManagedDataSourceDefaults.applyMySqlDefaults(DruidDataSource)`: for a
MySQL/MariaDB URL it sets the `STRICT_TRANS_TABLES` connection-init SQL (preserving
other session modes) and calls `MySqlStatementCache.fillDefaults`. Call it after
the pool's URL and connection properties are bound, from the standalone, embedded
and recovery builders. The standalone and recovery builders keep their existing
`maxActive`/`maxWait`/`validationQuery` defaults and prefix binding; the recovery
builder switches from `@ConfigurationProperties("spring.datasource.druid")` to
in-method `Binder` binding (like standalone) so the defaults see the final URL and
connection properties. `ManagedLocalConfiguration` stays H2-specific.

Pre-production, strict mode is applied uniformly rather than left to standalone
and maintenance callers: one rule, no operator burden, and schema admission
already requires strict mode. `README.md` is updated from "the embedded pool adds
strict mode; standalone/maintenance callers configure it" to "every managed pool
adds strict mode; a custom DataSource configures it". The two repeated
`maxWait`/`validationQuery` setters are not factored into the helper (the helper
is post-binding; those defaults are pre-binding and overridable).

### 3a. Single executable jar

Remove all six operator-tool `spring-boot-maven-plugin:repackage` executions
(`workspace-bundle`, `workspace-migration`, `workspace-maintenance-recovery`,
`csi-session`, `csi-runtime`, `operator-recovery`) and their six
`maven-jar-plugin` classifier executions from `server/pom.xml`, leaving the single
`exec` repackage. The `managed.operator-tools.*` properties and the
`no-operator-tools`/`central-release` profiles become unnecessary and are removed.

Collapse the distribution to one jar:

- `scripts/package-managed-agent-reference.mjs` ships only the `exec` jar (as
  `lib/<server jar>`); remove the `operator-recovery` jar entry and the dedicated
  `bin/qwen-managed-agent-operator-recovery` launcher. Every maintenance command,
  including `operator-recovery`, runs through `bin/qwen-managed-agent-admin` from
  the `exec` jar (the `operator-recovery` command already maps to
  `WorkspaceRecoveryCommand`).
- Update the packaging meta-tests
  (`scripts/tests/package-managed-agent-reference.test.mjs`,
  `scripts/tests/managed-agent-server-e2e.test.js`) and
  `scripts/run-managed-agent-server-e2e.ts` to the single-jar layout.
- `ContainerArtifactSelectionTest` keeps proving the selector picks `exec`.
- Update `docs/users/hosted-workspace-recovery.md` (both languages) and the
  configuration reference `operator-recovery-enabled` description to use
  `bin/qwen-managed-agent-admin operator-recovery`; update `README.md`
  (workspace-migration) and `docs/design/2026-10-01-managed-workspace-w1b-bundle.md`
  (workspace-bundle) to the executable jar; mark the admin-launcher design's
  "drop the classified jars" follow-up as realized and its operator-recovery
  non-goal as superseded by this pre-production change. Update the reference
  distribution design layout to one jar.

### 3b. Environment dialects

No change. `W1_JDBC_*`, `K2_JDBC_*` and `SPRING_DATASOURCE_*` remain as documented
in the admin-launcher design and the deployment guide.

## Design decisions and rationale

- **Read-only probe removal**: the deletion probe is pinned by a safety regression
  test and a documented erasure invariant; the put probe preserves the
  forbid-overwrite refusal. Reads are the high-frequency path and verify digests,
  so removing their probe is the pure performance win with no safety loss. The
  put/delete probes are correctness, not compatibility, and stay even
  pre-production.
- **A neutral object-storage flag that defaults to follow `tool-publication.enabled`**:
  reuses an established `application.yml` pattern and keeps the custom-store
  failure mode; OSS properties stay under `tool-publication.oss-*` (no migration).
- **Keep `JdbcRuntimeBrokerSchema`**: the review's "production-unused" claim is
  true only of `src/main`; 13+ tests and the module doc depend on it.
- **Keep the K1 reservation guards and the live `KubernetesRuntimeClient` SPI**:
  only the unregistered K1 provisioner and its test-only fixture are dead.
- **Uniform strict mode**: pre-production removes the reason to leave standalone
  and maintenance callers to configure strict mode themselves; one uniform rule is
  simpler and matches the schema-admission requirement. The README is updated
  accordingly rather than treated as a fixed contract.
- **Single executable jar**: pre-production removes the reason to keep classified
  jars or the dedicated operator-recovery launcher; the admin launcher already
  dispatches every command (including operator-recovery) from the exec jar, so the
  extra jars and launcher are pure redundancy. One jar, one repackage.
- **Do not unify environment dialects**: the admin-launcher design explicitly
  decided against environment mapping, and the dialects are load-bearing in E2E,
  integration tests and operator docs.

## Constraints

- Preserve the `ToolPublicationObjectStore` SPI contract, the guard-before-each-
  request read contract, the private/never-versioned bucket profile, and the
  fail-closed 501 behavior when no store is configured.
- Preserve tenant isolation, writer-lease/generation fencing and durable SQL
  admission for every touched route (module AGENTS.md Code Review rules).
- Preserve the embedded vs standalone datasource prefix split and the H2
  `managed-local` profile.
- Keep every admin-launcher command reaching its entry point from the single
  executable jar, including `operator-recovery`.
- Edit the V1 schema baseline in place if any schema touch arises; do not add V2+
  migrations (module AGENTS.md). No schema change is expected in this batch.
- Documentation changes must keep both language versions complete and synchronized
  (docs/design/README.md).

## Risks

- The guard-count test update must not weaken the guard-before-request contract;
  it is a mechanical count change, and the deletion safety test stays untouched.
- Decoupling changes the storage configuration tests: the former
  `maintenanceContextsDoNotInitializePublicationStorage` case is repurposed into
  `genericStorageDoesNotRequirePublicationConfiguration`; an embedded host that
  sets `tool-publication.enabled=true` now gets generic storage even without
  `ToolPublicationConfiguration` (intended).
- Uniform strict mode changes standalone and recovery behavior (they now add
  `STRICT_TRANS_TABLES`). `StandaloneDataSourceConfigurationTest` asserts
  connection properties (the statement cache), which are unaffected because strict
  mode uses `connectionInitSqls`; the recovery H2 test skips strict mode. Confirm
  both still pass.
- The single-jar change is a module-build and distribution interface change:
  operators who built classified jars or used the dedicated operator-recovery
  launcher must switch to the executable jar / admin launcher. Pre-production
  there are no such deployments; the container is unchanged. This touches
  operator-facing docs and the E2E/meta-test layer.
- K1 deletion must not remove the live `KubernetesRuntimeClient` SPI or the
  reservation guards; a full-module compile proves no dangling references.

## Validation plan

Local validation follows the module AGENTS.md budget (focused regression within
the shared 10-minute budget; full gates remain in CI). Use JDK 21 / Maven 3.8.9+,
install the sibling SDK into a task-isolated repository, and run Checkstyle
through `mvn verify` (a bare `checkstyle:check` is false-green for the
runtime-broker execution).

- OSS: both `AliyunToolPublicationObjectStoreTest` classes,
  `ToolPublicationStorageConfigurationTest`, `ToolPublicationCollectorTest`,
  `ToolPublicationAsyncVerificationTest` and the publication verification tests;
  the real-OSS `O4OssGate` profile in CI.
- Datasource: `StandaloneDataSourceConfigurationTest`,
  `WorkspaceRecoveryApplicationTest`, `MySqlStatementCacheTest`; the MySQL
  `ManagedDataSourceSqlModeMySqlIT` in CI; `managed-local` H2 boot.
- Dead code: a full-module compile (deletion proves no dangling references);
  confirm `KubernetesRuntimeClient` consumers still compile.
- Packaging: `scripts/tests/package-managed-agent-reference.test.mjs`,
  `scripts/tests/managed-agent-server-e2e.test.js`, `ManagedAgentPackagingIT`,
  `ContainerArtifactSelectionTest`, and the reference-distribution E2E that every
  admin command (including `operator-recovery`) reaches its entry point from the
  single jar.
- Documentation: formatting and relative-link/reference checks for every updated
  doc, in both languages.

Report local passes, failures, skips and CI gaps separately; acceptance is pending
until the required CI gates pass on the accepted revision.

## Acceptance criteria

- `open`/`openRange` no longer issue a per-call `getBucketVersioning`;
  `putIfAbsent`/`deleteIfPresent` still refuse a versioned bucket; the deletion
  regression test is green; the guard-count and versioning request-count tests
  expect two.
- `object-storage.enabled=true` with `tool-publication.enabled=false` yields a
  store bean and no publication beans; existing tool-publication deployments work
  unchanged via the follows-default.
- The K1 provisioner and its test-only fixture are gone; all modules compile; the
  `KubernetesRuntimeClient` SPI and the `kubernetes` reservation guards remain.
- `sessionWorktreeScheduler` has `defaultCandidate = false`; no unqualified
  `@Scheduled` task is affected.
- Standalone, embedded and recovery pools all apply `STRICT_TRANS_TABLES` and the
  statement cache via `ManagedDataSourceDefaults`; `managed-local` H2 and the
  property-prefix split are unchanged; the README states the uniform rule.
- Only the `exec` jar is built and shipped; the dedicated operator-recovery
  launcher is gone; every admin command (including `operator-recovery`) reaches
  its entry point from the single jar; docs and E2E consumers are migrated.
- Environment dialects are unchanged.

## Open questions and follow-up

- Optional rename of `AliyunToolPublicationStorageAutoConfiguration` and its bean
  names to a neutral object-storage name (touches the auto-configuration imports,
  the embedded `@Import`, the hosted fixtures and the configuration test).
- Optional relocation of `JdbcRuntimeBrokerSchema` to verification fixtures.
- Optional simplification of the unreachable `"kubernetes"` disjuncts.
- Optional neutral `object-storage.*` prefix for the OSS connection properties
  (currently `tool-publication.oss-*`); deferred as churn outweighs the gain.
- Environment-dialect unification, if ever desired, needs a separate proposal
  with a migration/compatibility story and maintainer sign-off.
- Adjacent doc-sync (not in this batch): the configuration reference
  `session-resources.deletion-enabled` precondition still says the three
  `record_bytes` readers are "not yet pack-aware"; once the pack-aware CSI
  admission and activation-lease reader migration
  (`feat/journal-pack-aware-csi-readers`) lands on main, that precondition line
  should be refreshed separately.
