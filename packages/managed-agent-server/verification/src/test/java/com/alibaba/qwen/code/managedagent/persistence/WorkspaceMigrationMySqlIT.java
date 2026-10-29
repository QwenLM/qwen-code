package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceMigrationMySqlIT {
    private JdbcTemplate admin;
    private JdbcTemplate jdbc;
    private DriverManagerDataSource data;
    private String schema;

    @BeforeEach
    void setup() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new ManagedSchemaJdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "workspace_migration_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci");
        data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        jdbc = new ManagedSchemaJdbcTemplate(data);
    }

    @Test
    void freshBaselineRefusesLegacyMigrationEvidenceWithoutMutatingIt() {
        jdbc.execute(
                "CREATE TABLE managed_workspace_migration (operation_id VARCHAR(64) PRIMARY KEY,"
                        + " state VARCHAR(32), request_json LONGTEXT)");
        jdbc.update(
                "INSERT INTO managed_workspace_migration VALUES ('original', 'COMPLETED',"
                        + " '{\"proof\":true}')");
        var before = jdbc.queryForMap("SELECT * FROM managed_workspace_migration");
        assertThatThrownBy(() -> ManagedSchema.initialize(data)).isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_migration")).isEqualTo(before);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema"
                                        + " = ? AND LEFT(table_name, 3) = 'ma_'", Integer.class, schema)).isZero();
    }

    @Test
    void freshBaselineContainsOneGcAuthorityAndEveryContractTable() {
        ManagedSchema.initialize(data);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema"
                                        + " = ?", Integer.class, schema)).isEqualTo(ManagedSchemaContract.TABLES.size());
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'SESSION_RESOURCE_GC'", Integer.class)).isZero();
    }

    @Test
    void freshBinaryScopeKeepsCaseDistinctMigrationEvidence() {
        ManagedSchema.initialize(data);
        for (String tenant : new String[] {"Tenant", "tenant"}) {
            new WorkspaceOperations(jdbc, tenant).create(WorkspaceOperations.Kind.STORAGE_MIGRATION,
                    UUID.randomUUID().toString(), WorkspaceOperations.values("storage_id", "storage", "state", "COMPLETED",
                            "history_identity_json", "{\"root\":\"" + tenant + "\"}"));
        }
        for (String tenant : new String[] {"Tenant", "tenant"}) {
            assertThat(jdbc.queryForObject(
                                    "SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ? AND"
                                            + " operation_kind = 'STORAGE_MIGRATION'", Integer.class, tenant)).isOne();
        }
        var before = jdbc.queryForList("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation ORDER BY operation_key");
        ManagedSchema.initialize(data);
        assertThat(jdbc.queryForList("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation ORDER BY operation_key")).isEqualTo(before);
    }

    @Test
    @Timeout(30)
    void creationWaitingForMigrationSeesCommittedFenceAndPreservesReplay() throws Exception {
        admissionWaitingForMigrationSeesCommittedFenceAndPreservesReplay(false);
    }

    @Test
    @Timeout(30)
    void legacyCwdSettlementWaitingForMigrationSeesCommittedFence() throws Exception {
        admissionWaitingForMigrationSeesCommittedFenceAndPreservesReplay(true);
    }

    private void admissionWaitingForMigrationSeesCommittedFenceAndPreservesReplay(boolean cwd) throws Exception {
        ManagedSchema.initialize(data);
        for (String tenant : List.of("migrating", "unrelated")) {
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')", tenant,
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        }
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(data));
        transaction.setIsolationLevel(Connection.TRANSACTION_REPEATABLE_READ);
        transaction.setTimeout(15);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var original = create(store, transaction, "migrating", "original");
        var other = cwd ? create(store, transaction, "unrelated", "other") : null;
        var originalCwd = cwd ? com.alibaba.qwen.code.managedagent.LegacyCwdOperations.seed(jdbc, store,
                "migrating", original.sessionId(), "actor", "actor-digest", "original", "digest", ".", 1) : null;
        var originalClaim = cwd ? transaction.execute(status -> store.claimOperation("migrating", original.sessionId(),
                originalCwd.operation().operationId(), "owner", Duration.ofSeconds(60)).orElseThrow()) : null;
        var otherCwd = cwd ? com.alibaba.qwen.code.managedagent.LegacyCwdOperations.seed(jdbc, store,
                "unrelated", other.sessionId(), "actor", "actor-digest", "other", "digest", ".", 1) : null;
        var otherClaim = cwd ? transaction.execute(status -> store.claimOperation("unrelated", other.sessionId(),
                otherCwd.operation().operationId(), "owner", Duration.ofSeconds(60)).orElseThrow()) : null;
        var binding = store.findSession("migrating", original.sessionId()).orElseThrow().workspace();
        var attemptingLock = new CountDownLatch(1);
        var waitingJdbc = new ManagedSchemaJdbcTemplate(data) {
            @Override
            public <T> T execute(ConnectionCallback<T> action) {
                return super.execute((ConnectionCallback<T>) connection -> {
                    attemptingLock.countDown();
                    return action.doInConnection(connection);
                });
            }
        };
        var waitingStore = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(waitingJdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(waitingJdbc), properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        try (var migration = data.getConnection(); var pool = Executors.newFixedThreadPool(2)) {
            migration.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(migration, "migrating");
            var creation = pool.submit(() -> cwd
                    ? transaction.execute(status -> waitingStore.completeCwdChangeOperation("migrating", original.sessionId(),
                            originalClaim.operationId(), "owner", originalClaim.claimGeneration()))
                    : create(waitingStore, transaction, "migrating", "racing"));
            try {
                assertThat(attemptingLock.await(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> creation.get(100, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
                assertThat(pool.submit(() -> cwd
                        ? transaction.execute(status -> store.completeCwdChangeOperation("unrelated", other.sessionId(),
                                otherClaim.operationId(), "owner", otherClaim.claimGeneration()))
                        : create(store, transaction, "unrelated", "other"))
                        .get(5, TimeUnit.SECONDS)).isNotNull();
                assertThat(creation.isDone()).isFalse();
                try (var fence = migration.prepareStatement(
                                "INSERT INTO ma_storage (alias_key, tenant_key, storage_key,"
                                    + " tenant_id, storage_id, fence_operation_id) VALUES (?, ?, ?,"
                                    + " 'migrating', 'storage', ?)")) {
                    fence.setString(1, JdbcRuntimeBindingRepository.storageAliasKey("migrating", "storage"));
                    fence.setString(2, JdbcRuntimeBindingRepository.storageFenceKey("migrating"));
                    fence.setString(3, JdbcRuntimeBindingRepository.storageFenceKey("storage"));
                    fence.setBytes(4, UUID.randomUUID().toString().getBytes(StandardCharsets.UTF_8));
                    fence.executeUpdate();
                }
                migration.commit();
                if (cwd) {
                    var outcome = (com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore.CwdChangeOutcome)
                            creation.get(5, TimeUnit.SECONDS);
                    assertThat(outcome.completed()).isFalse();
                    assertThat(outcome.failureCode()).isEqualTo("workspace_unavailable");
                } else {
                    assertThatThrownBy(() -> creation.get(5, TimeUnit.SECONDS))
                            .isInstanceOf(ExecutionException.class)
                            .hasCauseInstanceOf(RuntimeBrokerException.class)
                            .satisfies(error -> {
                                var refusal = (RuntimeBrokerException) error.getCause();
                                assertThat(refusal.getCode()).isEqualTo("workspace_unavailable");
                                assertThat(refusal.getStatusCode()).isEqualTo(409);
                                assertThat(refusal.isRetryable()).isFalse();
                            });
                }
            } finally {
                migration.rollback();
            }
        }
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session WHERE tenant_id ="
                                        + " X'6d6967726174696e67'",
                Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_request_receipt WHERE namespace ="
                                        + " 'SESSION_CREATE_ACTOR' AND tenant_id ="
                                        + " X'6d6967726174696e67'",
                Integer.class)).isEqualTo(1);
        var replay = create(store, transaction, "migrating", "original");
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.sessionId()).isEqualTo(original.sessionId());
        assertThat(store.findSession("migrating", original.sessionId()).orElseThrow().workspace()).isEqualTo(binding);
        if (cwd) {
            var retained = store.findOperation("migrating", original.sessionId(),
                    originalCwd.operation().operationId()).orElseThrow();
            assertThat(retained.state()).isEqualTo("FAILED");
            assertThat(retained.failureCode()).isEqualTo("workspace_unavailable");
            assertThat(store.requireSession("migrating", original.sessionId()).workspace().getContextRevision()).isEqualTo(1);
        }
    }

    private StoreModels.Admission create(ManagedAgentStore store, TransactionTemplate transaction, String tenant, String key) {
        return transaction.execute(status -> store.insertWorkspaceSessionCommand(tenant, "actor", key, "sha256:" + "a".repeat(64),
                "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", ".")));
    }

    @Test
    @Timeout(30)
    void headlessRetirementDoesNotBlockAnotherTenantsWriter() throws Exception {
        ManagedSchema.initialize(data);
        seed("tenant-a", "headless", "DELETED");
        seed("tenant-b", "m-successor", "ACTIVE");
        seed("tenant-b", "a-new", "ACTIVE");
        jdbc.update(
                "UPDATE ma_session SET retirement_operation_id = ?, retirement_generation = 1,"
                        + " retired_at = 1 WHERE tenant_id = ? AND session_id = ?", "delete", "tenant-a", "headless");
        String scopeKey = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey("tenant-a", "headless");
        String targetKey = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key("headless");
        String operationKey = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind.DELETE, scopeKey, targetKey, "delete");
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, target_key, target_kind, request_json, phase, tenant_id, session_id, operation_id, operation_kind, request_digest, state, admission_stage, delivery_state, session_status_before, available_at, gmt_create, gmt_modified, completed_at) VALUES (?, ?, ?, ?, 'SESSION', '{}', 'COMPLETED', ?, ?, 'delete', 'DELETE', 'digest', 'COMPLETED', 'HARNESS_CONFIRMED', 'CONFIRMED', 'CLOSED', 1, 1, 1, 1)",
                operationKey, scopeKey, scopeKey, targetKey, "tenant-a", "headless");
        var manager = new DataSourceTransactionManager(data);
        var transaction = new TransactionTemplate(manager);
        transaction.setIsolationLevel(Connection.TRANSACTION_REPEATABLE_READ);
        var sessions = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedSessionStore(jdbc));
        String token = "a".repeat(64);
        transaction.execute(status -> sessions.acquireWriter("tenant-b", "m-successor", token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 30000L)));
        try (var pool = Executors.newSingleThreadExecutor()) {
            transaction.executeWithoutResult(status -> {
                ToolPublicationRetentionStore.lockTenant(jdbc, "tenant-a");
                WorkspaceMigrationAdmission.lockTenant(jdbc, "tenant-a");
                var source = WorkspaceRecoveryStore.currentSource(jdbc, "tenant-a", "storage", "headless", true);
                assertThat(source.path("head").isNull()).isTrue();
                assertThat(source.path("retirement").path("operationId").asText()).isEqualTo("delete");
                var writer = pool.submit(() -> transaction.execute(other -> {
                    jdbc.execute(
                                                                    "SET SESSION"
                                                                        + " innodb_lock_wait_timeout"
                                                                        + " = 2");
                    return sessions.acquireWriter("tenant-b", "a-new", token,
                            new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 30000L));
                }));
                try {
                    assertThat(writer.get(5, TimeUnit.SECONDS).writerGeneration()).isEqualTo(1);
                } catch (Exception error) {
                    throw new AssertionError(
                                    "Another tenant's writer was blocked by the headless recovery"
                                            + " census", error);
                }
            });
        }
    }

    @Test
    void baselineRefusesAnIncompleteCatalogWithoutAddingOtherTables() {
        jdbc.execute("CREATE TABLE ma_operation (operation_key CHAR(64) PRIMARY KEY)");
        assertThatThrownBy(() -> ManagedSchema.initialize(data)).isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema"
                                        + " = ?", Integer.class, schema)).isOne();
    }

    private void seed(String tenant, String session, String state) {
        jdbc.update(
                "INSERT INTO ma_session (tenant_key, session_key, session_scope_key, tenant_id, session_id, agent_id, status, gmt_create, gmt_modified, workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref, deleted_at) VALUES (?, ?, ?, ?, ?, 'qwen-code', ?, 1, 1, 'workspace', 1, 'storage', '.', ?, 1, ?, ?, ?)",
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(tenant),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(session),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), tenant, session, state, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF, "DELETED".equals(state) ? 1L : null);
        ManagedReceipts.insertCreation(jdbc, tenant, new byte[]{1}, session, "digest", session, null, 1);
        jdbc.update(
                "INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, gmt_modified) VALUES (?, ?, 'SESSION', ?, 1)",
                tenant, session, new byte[0]);
    }

    @AfterEach
    void cleanup() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
