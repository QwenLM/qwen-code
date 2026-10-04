package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import java.sql.Connection;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
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
    void upgradesBinaryScopeWithoutRewritingOperationEvidence() {
        Flyway.configure().dataSource(data).locations("classpath:db/migration").target("37").load().migrate();
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
