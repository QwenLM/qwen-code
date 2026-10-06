package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

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
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "workspace_migration_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci");
        data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        jdbc = new JdbcTemplate(data);
    }

    @Test
    void upgradesCurrentMainWithoutChangingAppliedMigrations() {
        Flyway.configure().dataSource(data).locations("classpath:db/migration").target("47").load().migrate();
        var applied = jdbc.queryForList("SELECT * FROM flyway_schema_history ORDER BY installed_rank");
        int lastRank = jdbc.queryForObject("SELECT MAX(installed_rank) FROM flyway_schema_history", Integer.class);
        Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
        assertThat(jdbc.queryForList("SELECT * FROM flyway_schema_history"
                + " WHERE installed_rank <= ? ORDER BY installed_rank", lastRank)).isEqualTo(applied);
        assertThat(jdbc.queryForList("SELECT version FROM flyway_schema_history"
                + " WHERE installed_rank > ? AND success = TRUE ORDER BY installed_rank",
                String.class, lastRank)).containsExactly("48", "49", "50");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_storage_fence", Integer.class)).isZero();
    }

    @Test
    void upgradesBinaryScopeWithoutRewritingOperationEvidence() {
        Flyway.configure().dataSource(data).locations("classpath:db/migration").target("49").load().migrate();
        for (String tenant : new String[] {"Tenant", "tenant"}) {
            jdbc.update("INSERT INTO managed_workspace_migration (operation_id, tenant_id, storage_id, request_digest,"
                    + " request_json, state, history_identity_json, target_registration_id)"
                    + " VALUES (?, ?, 'storage', 'digest', '{}', 'COMPLETED', ?, ?)",
                    UUID.randomUUID().toString(), tenant, "{\"root\":\"" + tenant + "\"}", UUID.randomUUID().toString());
        }
        jdbc.update("INSERT INTO qwen_runtime_storage_fence VALUES (?, ?, 'Tenant', 'storage', ?)",
                JdbcRuntimeBindingRepository.storageFenceKey("Tenant"),
                JdbcRuntimeBindingRepository.storageFenceKey("storage"), UUID.randomUUID().toString());
        var operations = jdbc.queryForList("SELECT * FROM managed_workspace_migration ORDER BY operation_id");
        var fence = jdbc.queryForList("SELECT * FROM qwen_runtime_storage_fence");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration"
                + " WHERE tenant_id = 'Tenant' AND storage_id = 'storage'", Integer.class)).isEqualTo(2);
        Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
        assertThat(jdbc.queryForList("SELECT * FROM managed_workspace_migration ORDER BY operation_id")).isEqualTo(operations);
        assertThat(jdbc.queryForList("SELECT * FROM qwen_runtime_storage_fence")).isEqualTo(fence);
        for (String tenant : new String[] {"Tenant", "tenant"}) {
            assertThat(jdbc.queryForObject("SELECT history_identity_json FROM managed_workspace_migration"
                    + " WHERE tenant_id = ? AND storage_id = 'storage' AND state = 'COMPLETED'"
                    + " ORDER BY updated_at DESC LIMIT 1", String.class, tenant))
                    .isEqualTo("{\"root\":\"" + tenant + "\"}");
        }
        assertThat(jdbc.queryForList("SELECT TABLE_COLLATION FROM information_schema.TABLES"
                + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('managed_workspace_migration', 'qwen_runtime_storage_fence')",
                String.class, schema)).containsExactlyInAnyOrder("utf8mb4_bin", "utf8mb4_bin");
    }

    @Test
    @Timeout(30)
    void creationWaitingForMigrationSeesCommittedFenceAndPreservesReplay() throws Exception {
        admissionWaitingForMigrationSeesCommittedFenceAndPreservesReplay(false);
    }

    @Test
    @Timeout(30)
    void cwdWaitingForMigrationSeesCommittedFenceAndPreservesReplay() throws Exception {
        admissionWaitingForMigrationSeesCommittedFenceAndPreservesReplay(true);
    }

    private void admissionWaitingForMigrationSeesCommittedFenceAndPreservesReplay(boolean cwd) throws Exception {
        Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
        for (String tenant : List.of("migrating", "unrelated")) {
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')", tenant,
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES (?, 'workspace', ?, TRUE, TRUE)", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        }
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(data));
        transaction.setIsolationLevel(Connection.TRANSACTION_REPEATABLE_READ);
        transaction.setTimeout(15);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> { },
                new ManagedWorkspaceRegistry(jdbc), properties);
        var original = create(store, transaction, "migrating", "original");
        var other = cwd ? create(store, transaction, "unrelated", "other") : null;
        var originalCwd = cwd ? changeCwd(store, transaction, "migrating", original.sessionId(), "original", 1) : null;
        if (cwd) {
            var claim = transaction.execute(status -> store.claimOperation("migrating", original.sessionId(),
                    originalCwd.operation().operationId(), "owner", Duration.ofSeconds(60)).orElseThrow());
            assertThat(transaction.execute(status -> store.completeCwdChangeOperation("migrating", original.sessionId(),
                    claim.operationId(), "owner", claim.claimGeneration())).completed()).isTrue();
        }
        var binding = store.findSession("migrating", original.sessionId()).orElseThrow().workspace();
        var attemptingLock = new CountDownLatch(1);
        var waitingJdbc = new JdbcTemplate(data) {
            @Override
            public <T> T execute(ConnectionCallback<T> action) {
                return super.execute((ConnectionCallback<T>) connection -> {
                    attemptingLock.countDown();
                    return action.doInConnection(connection);
                });
            }
        };
        var waitingStore = new ManagedAgentStore(waitingJdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> { },
                new ManagedWorkspaceRegistry(waitingJdbc), properties);
        try (var migration = data.getConnection(); var pool = Executors.newFixedThreadPool(2)) {
            migration.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(migration, "migrating");
            var creation = pool.submit(() -> cwd
                    ? changeCwd(waitingStore, transaction, "migrating", original.sessionId(), "racing", 2)
                    : create(waitingStore, transaction, "migrating", "racing"));
            try {
                assertThat(attemptingLock.await(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> creation.get(100, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
                assertThat(pool.submit(() -> cwd
                        ? changeCwd(store, transaction, "unrelated", other.sessionId(), "other", 1)
                        : create(store, transaction, "unrelated", "other"))
                        .get(5, TimeUnit.SECONDS)).isNotNull();
                assertThat(creation.isDone()).isFalse();
                try (var fence = migration.prepareStatement("INSERT INTO qwen_runtime_storage_fence"
                        + " (tenant_key, storage_key, tenant_id, storage_id, operation_id)"
                        + " VALUES (?, ?, 'migrating', 'storage', ?)")) {
                    fence.setString(1, JdbcRuntimeBindingRepository.storageFenceKey("migrating"));
                    fence.setString(2, JdbcRuntimeBindingRepository.storageFenceKey("storage"));
                    fence.setString(3, UUID.randomUUID().toString());
                    fence.executeUpdate();
                }
                migration.commit();
                assertThatThrownBy(() -> creation.get(5, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .hasCauseInstanceOf(RuntimeBrokerException.class)
                        .satisfies(error -> {
                            var refusal = (RuntimeBrokerException) error.getCause();
                            assertThat(refusal.getCode()).isEqualTo("workspace_unavailable");
                            assertThat(refusal.getStatusCode()).isEqualTo(409);
                            assertThat(refusal.isRetryable()).isFalse();
                        });
            } finally {
                migration.rollback();
            }
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session WHERE tenant_id = 'migrating'",
                Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_create_command WHERE tenant_id = 'migrating'",
                Integer.class)).isEqualTo(1);
        var replay = create(store, transaction, "migrating", "original");
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.sessionId()).isEqualTo(original.sessionId());
        assertThat(store.findSession("migrating", original.sessionId()).orElseThrow().workspace()).isEqualTo(binding);
        if (cwd) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_operation WHERE tenant_id = 'migrating'",
                    Integer.class)).isEqualTo(1);
            var cwdReplay = changeCwd(store, transaction, "migrating", original.sessionId(), "original", 1);
            assertThat(cwdReplay.replayed()).isTrue();
            assertThat(cwdReplay.operation().operationId()).isEqualTo(originalCwd.operation().operationId());
            assertThat(cwdReplay.operation().state()).isEqualTo("COMPLETED");
            assertThat(cwdReplay.operation().resultContextRevision()).isEqualTo(2);
        }
    }

    private StoreModels.OperationAdmission changeCwd(ManagedAgentStore store, TransactionTemplate transaction,
            String tenant, String sessionId, String key, long revision) {
        return transaction.execute(status -> store.beginCwdChangeOperation(tenant, sessionId, "actor", "actor-digest",
                key, "cwd-digest", ".", revision));
    }

    private StoreModels.Admission create(ManagedAgentStore store, TransactionTemplate transaction, String tenant, String key) {
        return transaction.execute(status -> store.insertWorkspaceSessionCommand(tenant, "actor", key, "sha256:" + "a".repeat(64),
                "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", ".")));
    }

    @Test
    @Timeout(30)
    void headlessRetirementDoesNotBlockAnotherTenantsWriter() throws Exception {
        Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
        seed("tenant-a", "headless", "DELETED");
        seed("tenant-b", "m-successor", "ACTIVE");
        seed("tenant-b", "a-new", "ACTIVE");
        jdbc.update("INSERT INTO qwen_output_session_retirement VALUES (?, ?, 'tenant-a', 'headless', 'delete', 1, 1, FALSE)",
                WorkspaceRecoveryStore.hash("tenant-a"), WorkspaceRecoveryStore.hash("headless"));
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id, session_id, operation_id, operation_kind,"
                + " actor_digest, idempotency_key, request_digest, state, admission_stage, delivery_state,"
                + " session_status_before, available_at, created_at, updated_at, completed_at)"
                + " VALUES ('tenant-a', 'headless', 'delete', 'DELETE', 'digest', 'delete', 'digest',"
                + " 'COMPLETED', 'HARNESS_CONFIRMED', 'CONFIRMED', 'CLOSED', 1, 1, 1, 1)");
        var manager = new DataSourceTransactionManager(data);
        var transaction = new TransactionTemplate(manager);
        transaction.setIsolationLevel(Connection.TRANSACTION_REPEATABLE_READ);
        var sessions = new ManagedSessionStore(jdbc);
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
                    jdbc.execute("SET SESSION innodb_lock_wait_timeout = 2");
                    return sessions.acquireWriter("tenant-b", "a-new", token,
                            new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 30000L));
                }));
                try {
                    assertThat(writer.get(5, TimeUnit.SECONDS).writerGeneration()).isEqualTo(1);
                } catch (Exception error) {
                    throw new AssertionError("Another tenant's writer was blocked by the headless recovery census", error);
                }
            });
        }
    }

    private void seed(String tenant, String session, String state) {
        jdbc.update("INSERT INTO managed_agent_session (tenant_id, session_id, agent_id, status, created_at, updated_at,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref, deleted_at)"
                + " VALUES (?, ?, 'qwen-code', ?, 1, 1, 'workspace', 1, 'storage', '.', ?, 1, ?, ?, ?)",
                tenant, session, state, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF, "DELETED".equals(state) ? 1L : null);
        jdbc.update("INSERT INTO managed_workspace_create_command (tenant_id, actor_id, idempotency_key, request_digest,"
                + " session_id, created_at) VALUES (?, ?, ?, 'digest', ?, 1)", tenant, new byte[] {1}, session, session);
    }

    @AfterEach
    void cleanup() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
