package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LocalStorageAliasTest {
    @TempDir Path temporary;
    private ManagedSchemaJdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private WorkspaceStorageGuard guard;
    private ManagedAgentProperties properties;
    private Path root;
    private IsolatedManagedSchemaMySqlTestDatabase mysql;

    DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:local-alias-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    DataSource mysqlSource() {
        mysql = new IsolatedManagedSchemaMySqlTestDatabase();
        return mysql.source();
    }

    @BeforeEach
    void setUp() throws Exception {
        var source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        root = Files.createDirectory(temporary.resolve("root")).toRealPath();
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new WorkspaceMount("tenant", "storage", root.toString()),
                new WorkspaceMount("other-tenant", "other-storage", root.toString())));
        for (var alias : List.of(new String[] {"tenant", "storage"}, new String[] {"other-tenant", "other-storage"})) {
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES (?, 'workspace', 1, ?, 'Workspace', ?, ?, 'ACTIVE')", alias[0], alias[1],
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        }
        guard = guard();
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        guard.register("other-tenant", "other-storage", UUID.randomUUID().toString());
    }

    @AfterEach
    void tearDown() {
        if (mysql != null) {
            mysql.close();
        }
    }

    @Test
    void aliasesShareAnImmutablePhysicalRegistrationAndIndependentLogicalFences() throws Exception {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
        String physical = LocalStorageOwners.key(jdbc, "tenant", "storage");
        assertThat(LocalStorageOwners.key(jdbc, "other-tenant", "other-storage")).isEqualTo(physical);
        var owner = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        String aliasKey = JdbcRuntimeBindingRepository.storageAliasKey("tenant", "storage");
        assertThat(jdbc.queryForObject("SELECT gmt_create FROM ma_storage WHERE alias_key = ?",
                Long.class, aliasKey)).isPositive();
        String registrationOperation = WorkspaceRecoveryStore.parse(jdbc.queryForObject(
                "SELECT registration_json FROM ma_storage WHERE alias_key = ?", String.class, aliasKey))
                .path("operationId").asText();
        jdbc.update("UPDATE ma_storage SET storage_kind = 'UNREGISTERED', gmt_modified = 1 WHERE alias_key = ?",
                aliasKey);
        guard.register("tenant", "storage", registrationOperation);
        assertThat(jdbc.queryForObject("SELECT gmt_modified FROM ma_storage WHERE alias_key = ?",
                Long.class, aliasKey)).isGreaterThan(1);
        jdbc.update("UPDATE ma_storage SET gmt_modified = 1 WHERE alias_key = ?", aliasKey);
        guard.register("tenant", "storage", registrationOperation);
        assertThat(jdbc.queryForObject("SELECT gmt_modified FROM ma_storage WHERE alias_key = ?",
                Long.class, aliasKey)).isEqualTo(1);
        byte[] marker = Files.readAllBytes(root.resolve(".qwen-managed-storage.json"));
        assertThat(owner.get("tenant_id")).isEqualTo("tenant");
        assertThat(owner.get("storage_id")).isEqualTo("storage");
        assertThat(owner.get("physical_key")).isEqualTo(physical);
        guard.verify(binding("tenant", "storage"));
        guard.verify(binding("other-tenant", "other-storage"));
        jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE alias_key = ?", UUID.randomUUID().toString(),
                JdbcRuntimeBindingRepository.storageAliasKey("tenant", "storage"));
        assertThatThrownBy(() -> guard.verify(binding("tenant", "storage"))).isInstanceOf(RuntimeBrokerException.class);
        guard.verify(binding("other-tenant", "other-storage"));
        assertThat(Files.readAllBytes(root.resolve(".qwen-managed-storage.json"))).isEqualTo(marker);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(owner);
    }

    @Test
    void physicalFenceBlocksEveryAliasAndMatchingRestoreKeepsTheOriginalMarker() throws Exception {
        byte[] marker = Files.readAllBytes(root.resolve(".qwen-managed-storage.json"));
        String fence = UUID.randomUUID().toString();
        guard.fence("other-tenant", "other-storage", 1, fence);
        for (var binding : List.of(binding("tenant", "storage"), binding("other-tenant", "other-storage"))) {
            assertThatThrownBy(() -> guard.verify(binding)).isInstanceOf(RuntimeBrokerException.class);
        }
        var registration = guard.recoveryRegistration("other-tenant", "other-storage", 1, fence);
        assertThat(registration.tenantId()).isEqualTo("other-tenant");
        assertThat(registration.storageId()).isEqualTo("other-storage");
        guard.restoreOriginal("other-tenant", "other-storage", 1, fence);
        guard.verify(binding("tenant", "storage"));
        guard.verify(binding("other-tenant", "other-storage"));
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner", Long.class)).isEqualTo(2L);
        assertThat(Files.readAllBytes(root.resolve(".qwen-managed-storage.json"))).isEqualTo(marker);
    }

    @Test
    void maintenanceAliasesAreExclusiveAndOldStepCannotReleaseTheSuccessor() {
        var first = binding("tenant", "storage");
        var second = binding("other-tenant", "other-storage");
        var children = new ChildWorkspaceStore(jdbc, manager);
        var firstRow = children.admit("tenant", "parent", "run", first, System.currentTimeMillis());
        var secondRow = children.admit("other-tenant", "parent", "run", second, System.currentTimeMillis());
        var firstClaim = children.claim(firstRow, "first-worker", System.currentTimeMillis(), 60_000);
        var secondClaim = children.claim(secondRow, "second-worker", System.currentTimeMillis(), 60_000);
        var authority = new WorkspaceExecutionStore(jdbc, manager);
        String step = authority.holdForMaintenance(first, firstRow.childWorkspaceId(), firstClaim.claimGeneration());
        assertThatThrownBy(() -> authority.holdForMaintenance(second, secondRow.childWorkspaceId(), secondClaim.claimGeneration()))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_busy"));
        authority.releaseMaintenance(first, firstRow.childWorkspaceId(), firstClaim.claimGeneration(), step);
        String successor = authority.holdForMaintenance(second, secondRow.childWorkspaceId(), secondClaim.claimGeneration());
        var holder = jdbc.queryForMap("SELECT holder_key, maintenance_id, maintenance_generation FROM ma_storage_owner");
        authority.releaseMaintenance(first, firstRow.childWorkspaceId(), firstClaim.claimGeneration(), step);
        assertThat(jdbc.queryForMap("SELECT holder_key, maintenance_id, maintenance_generation FROM ma_storage_owner")).isEqualTo(holder);
        authority.releaseMaintenance(second, secondRow.childWorkspaceId(), secondClaim.claimGeneration(), successor);
        assertThat(jdbc.queryForObject("SELECT holder_key FROM ma_storage_owner", String.class)).isNull();
    }

    @Test
    void uncoveredAliasSessionAuthorityRefusesPhysicalHandover() {
        session("other-tenant", "other-storage", "retained");
        var owner = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        assertUncovered(() -> guard.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(owner);
        jdbc.update("DELETE FROM ma_session WHERE tenant_id = ? AND session_id = ?", "other-tenant", "retained");
        guard.fence("tenant", "storage", 1, UUID.randomUUID().toString());
    }

    @Test
    void anEstablishedRrSnapshotCannotHideCommittedOtherAliasAuthority() throws Exception {
        var transaction = new TransactionTemplate(manager);
        transaction.executeWithoutResult(status -> {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isZero();
            try (var executor = Executors.newSingleThreadExecutor()) {
                executor.submit(() -> new TransactionTemplate(manager).executeWithoutResult(inner -> {
                    WorkspaceMigrationAdmission.requirePhysicalOpen(jdbc, "other-tenant", "other-storage");
                    session("other-tenant", "other-storage", "raced");
                })).get(10, TimeUnit.SECONDS);
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
            assertUncovered(() -> guard.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
            status.setRollbackOnly();
        });
        assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isEqualTo(1);
    }

    @Test
    void driftedPhysicalMappingAndCopiedMarkersCannotAuthorizeAnAlias() throws Exception {
        String physical = LocalStorageOwners.key(jdbc, "tenant", "storage");
        jdbc.update("UPDATE ma_storage_owner SET physical_key = ? WHERE storage_key = ?", "f".repeat(64), physical);
        assertThatThrownBy(() -> guard.verify(binding("other-tenant", "other-storage"))).isInstanceOf(RuntimeBrokerException.class);
        jdbc.update("UPDATE ma_storage_owner SET physical_key = ? WHERE storage_key = ?", physical, physical);
        Path replacement = Files.createDirectory(temporary.resolve("replacement")).toRealPath();
        Files.copy(root.resolve(".qwen-managed-storage.json"), replacement.resolve(".qwen-managed-storage.json"));
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount("third", "copy", replacement.toString())));
        var copied = guard();
        assertThatThrownBy(() -> copied.register("third", "copy", UUID.randomUUID().toString())).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner WHERE storage_key = ?", String.class, physical)).isEqualTo("READY");
    }

    @Test
    void identicalNativeFingerprintAtAnotherRootIsRefused() throws Exception {
        Path different = Files.createDirectory(temporary.resolve("different")).toRealPath();
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount("third", "different", different.toString())));
        var attributes = Files.readAttributes(root, java.nio.file.attribute.BasicFileAttributes.class);
        var collision = new WorkspaceStorageGuard(jdbc, manager, properties, path -> new WorkspaceStorageGuard.Identity(
                path.toString(), "host", "device", attributes.fileKey().toString(), attributes.creationTime().toInstant().toString()));
        assertThatThrownBy(() -> collision.register("third", "different", UUID.randomUUID().toString())).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isEqualTo(2);
        assertThat(Files.exists(different.resolve(".qwen-managed-storage.json"))).isFalse();
    }

    @Test
    void aSeededFailedBindingStillProtectsTheOtherAlias() {
        var source = java.util.Objects.requireNonNull(jdbc.getDataSource());
        var repository = new JdbcRuntimeBindingRepository(source,
                new com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector("test", new byte[32]));
        var request = new com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest(
                new com.alibaba.qwen.code.runtimebroker.RuntimeScope("other-tenant", "workspace", "1", root.toString(),
                        "sha256:" + "a".repeat(64), "workspace"), null, "local-process", "other-storage");
        var original = repository.findOrCreate(request);
        var claimed = repository.claimOperation(original.getBindingId(), "worker", java.time.Duration.ofMinutes(1));
        var failed = repository.compareAndSet(claimed, claimed.withState(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.FAILED, null, java.time.Instant.now()));
        assertThat(failed.getProvisionSeed()).isNotNull();
        assertThatThrownBy(() -> repository.findOrCreate(request)).isInstanceOf(RuntimeBrokerException.class);
        assertUncovered(() -> guard.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("READY");
    }

    @Test
    void migrationCreatesANewPhysicalOwnerWithoutRewritingTheOriginalProof() throws Exception {
        String original = LocalStorageOwners.key(jdbc, "tenant", "storage");
        String fence = UUID.randomUUID().toString();
        guard.fence("other-tenant", "other-storage", 1, fence);
        var originalOwner = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner WHERE storage_key = ?", original);
        var source = guard.recoveryRegistration("other-tenant", "other-storage", 1, fence);
        Path target = Files.createDirectory(temporary.resolve("target")).toRealPath();
        Files.copy(root.resolve(".qwen-managed-storage.json"), target.resolve(".qwen-managed-storage.json"));
        var identity = guard.migrationIdentity(target);
        String registration = UUID.randomUUID().toString();
        String operation = UUID.randomUUID().toString();
        byte[] marker = guard.migrationMarker("other-tenant", "other-storage", identity, registration);
        guard.publishMigrationMarker(target, marker, source, operation);
        guard.promoteMigration(source, identity, registration, operation);
        String promoted = LocalStorageOwners.key(jdbc, "other-tenant", "other-storage");
        assertThat(promoted).isNotEqualTo(original);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner WHERE storage_key = ?", original)).isEqualTo(originalOwner);
        assertThat(LocalStorageOwners.key(jdbc, "tenant", "storage")).isEqualTo(original);
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner WHERE storage_key = ?", Long.class, promoted)).isEqualTo(2);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount("other-tenant", "other-storage", target.toString())));
        guard().verify(binding("other-tenant", "other-storage"));
        assertThatThrownBy(() -> guard.verify(binding("tenant", "storage"))).isInstanceOf(RuntimeBrokerException.class);
    }

    @Test
    void physicalFenceRefusesNewChildWorkOnEveryAlias() {
        guard.fence("tenant", "storage", 1, UUID.randomUUID().toString());
        var children = new ChildWorkspaceStore(jdbc, manager);
        assertThatThrownBy(() -> children.admit("other-tenant", "parent", "run", binding("other-tenant", "other-storage"), System.currentTimeMillis()))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CHILD_WORKSPACE'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace WHERE workspace_kind = 'CHILD_GIT'", Integer.class)).isZero();
    }

    @Test
    void fullyCollectedOtherAliasRetirementStopsBlockingWithoutResettingItsHead() {
        String tenant = "other-tenant";
        String session = "retired-private";
        session(tenant, "other-storage", session);
        var transactions = new TransactionTemplate(manager);
        var journal = new ManagedSessionStore(jdbc);
        String token = "a".repeat(64);
        byte[] bytes = ("{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        transactions.execute(status -> journal.acquireWriter(tenant, session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 30_000L)));
        transactions.execute(status -> journal.commit(tenant, session, token, new ManagedSessionStoreModels.CommitTransactionRequest(
                "workspace", "original", 1, 0, 0, "genesis", "session.create", "genesis-command", WorkspaceRecoveryStore.hash(bytes),
                0, 0, 0, null, null, null, 0, null, 2, java.util.Base64.getEncoder().encodeToString(bytes), WorkspaceRecoveryStore.hash(bytes), List.of())));
        transactions.execute(status -> journal.sealWriter(tenant, session, token,
                new ManagedSessionStoreModels.SealWriterRequest("workspace", "original", 1)));
        transactions.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockSession(jdbc, tenant, session);
            ToolPublicationRetentionStore.retire(jdbc, tenant, session, UUID.randomUUID().toString());
        });
        var before = jdbc.queryForMap("SELECT writer_generation, journal_revision, committed_sequence, activation_epoch, last_commit_digest"
                + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ?",
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session));
        assertUncovered(() -> guard.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        var config = new ManagedAgentProperties();
        config.getToolPublication().setGcEnabled(true);
        config.getToolPublication().setDeletionGrace(java.time.Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(jdbc, manager, config);
        for (int page = 0; page < 20 && collector.runOnce(); page++) {
            // collector.runOnce() in the condition does the work; the body stays empty.
        }
        assertThat(jdbc.queryForObject("SELECT resource_gc_completed FROM ma_session WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session)).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC'", String.class)).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class)).isZero();
        assertThat(jdbc.queryForMap("SELECT writer_generation, journal_revision, committed_sequence, activation_epoch, last_commit_digest"
                + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ?",
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session))).isEqualTo(before);
        guard.fence("tenant", "storage", 1, UUID.randomUUID().toString());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isEqualTo(1);
    }

    @Test
    void anUnknownBindingStateCannotCertifyAnotherAliasesPhysicalStop() {
        var source = java.util.Objects.requireNonNull(jdbc.getDataSource());
        var repository = new JdbcRuntimeBindingRepository(source,
                new com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector("test", new byte[32]));
        var request = new com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest(
                new com.alibaba.qwen.code.runtimebroker.RuntimeScope("other-tenant", "workspace", "1", root.toString(),
                        "sha256:" + "a".repeat(64), "workspace"), null, "local-process", "other-storage");
        var original = repository.findOrCreate(request);
        jdbc.update("UPDATE ma_runtime_binding SET binding_state = 'UNKNOWN_STATE' WHERE binding_id = ?", original.getBindingId());
        assertUncovered(() -> guard.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("READY");
    }

    @Test
    void anOrphanedChildWorkspaceStillBlocksOtherAliasHandover() {
        var child = new ChildWorkspaceStore(jdbc, manager).admit("other-tenant", "retired-parent", "unclosed",
                binding("other-tenant", "other-storage"), 1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isZero();
        for (String state : List.of(ChildWorkspaceStore.PREPARING, ChildWorkspaceStore.READY, ChildWorkspaceStore.MERGING,
                ChildWorkspaceStore.APPLYING, ChildWorkspaceStore.APPLIED, ChildWorkspaceStore.DISCARDING,
                ChildWorkspaceStore.CONFLICTED, ChildWorkspaceStore.BLOCKED, ChildWorkspaceStore.FAILED)) {
            jdbc.update("UPDATE ma_operation SET state = ?, phase = ? WHERE operation_key = ?", state, state,
                    WorkspaceOperations.key(WorkspaceOperations.Kind.CHILD_WORKSPACE, "other-tenant", child.childWorkspaceId()));
            jdbc.update("UPDATE ma_workspace SET child_state = ? WHERE tenant_id = ? AND workspace_id = ?", state, "other-tenant", child.childWorkspaceId());
            assertUncovered(() -> guard.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
            assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("READY");
        }
        for (String state : List.of(ChildWorkspaceStore.MERGED, ChildWorkspaceStore.DISCARDED)) {
            jdbc.update("UPDATE ma_operation SET state = ?, phase = ? WHERE operation_key = ?", state, state,
                    WorkspaceOperations.key(WorkspaceOperations.Kind.CHILD_WORKSPACE, "other-tenant", child.childWorkspaceId()));
            jdbc.update("UPDATE ma_workspace SET child_state = ? WHERE tenant_id = ? AND workspace_id = ?", state, "other-tenant", child.childWorkspaceId());
            var inventory = new TransactionTemplate(manager).execute(status ->
                    LocalStorageOwners.lockCovered(jdbc, "tenant", "storage"));
            assertThat(inventory).isEqualTo(LocalStorageOwners.key(jdbc, "tenant", "storage"));
        }
        guard.fence("tenant", "storage", 1, UUID.randomUUID().toString());
        assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("FENCED");
    }

    private WorkspaceStorageGuard guard() {
        return new WorkspaceStorageGuard(jdbc, manager, properties, path -> {
            var attributes = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class);
            return new WorkspaceStorageGuard.Identity(path.toString(), "host", "device", attributes.fileKey().toString(),
                    attributes.creationTime().toInstant().toString());
        });
    }

    private ContextBinding binding(String tenant, String storage) {
        return new ContextBinding(tenant, "workspace", 1, storage, ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
    }

    private void session(String tenant, String storage, String session) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, session_kind, workspace_storage_id, tenant_key, session_key, session_scope_key, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'CONTROL', ?, ?, ?, ?, 1, 1)", tenant, session, storage,
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session), ManagedSessionStore.sessionScopeKey(tenant, session));
    }

    private static void assertUncovered(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("storage_alias_authority_uncovered"));
    }
}
