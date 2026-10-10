package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.time.Clock;
import java.util.Comparator;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

@Timeout(30)
class ManagedAgentCsiMutationMySqlIT {
    @ParameterizedTest
    @ValueSource(ints = {Connection.TRANSACTION_READ_COMMITTED, Connection.TRANSACTION_REPEATABLE_READ})
    void currentProbeWaitsForOriginalRowAndRefusesAfterAWarmedSnapshot(int isolation) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "csi_managed_mutation_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4");
        try {
            var data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
            Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
            var jdbc = new JdbcTemplate(data);
            var manager = new DataSourceTransactionManager(data);
            var json = new ObjectMapper();
            var properties = new ManagedAgentProperties();
            properties.setAgentRevision("reviewed-agent/1");
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                    "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
            new WorkspaceCsiReservationStore(jdbc, manager, json).register(registration);
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                    + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                    CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            var store = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                    new ManagedWorkspaceRegistry(jdbc), properties);
            var transaction = new TransactionTemplate(manager);
            transaction.setIsolationLevel(isolation);
            transaction.setTimeout(15);
            var warmed = new CountDownLatch(1);
            var created = new CountDownLatch(1);
            var session = new java.util.concurrent.atomic.AtomicReference<String>();
            try (var pool = Executors.newSingleThreadExecutor(); var originalLock = data.getConnection()) {
                var mutation = pool.submit(() -> transaction.executeWithoutResult(status -> {
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session", Integer.class)).isZero();
                    warmed.countDown();
                    try {
                        assertThat(created.await(10, TimeUnit.SECONDS)).isTrue();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new AssertionError(error);
                    }
                    store.appendPublicEventIfAbsent("tenant", session.get(), null, "session.environment",
                            Map.of(), false, "late-warmup");
                }));
                try {
                    assertThat(warmed.await(5, TimeUnit.SECONDS)).isTrue();
                    var original = WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                            new WorkspaceCsiSessionMain.Request(registration, "actor", "original", null, null,
                                    new WorkspaceSelection("workspace", ".")));
                    session.set(original.sessionId());
                    var before = allTables(jdbc, json);
                    originalLock.setAutoCommit(false);
                    try (var query = originalLock.prepareStatement("SELECT csi_guard FROM managed_agent_session"
                            + " FORCE INDEX (managed_session_csi_guard_idx)"
                            + " WHERE tenant_id = 'tenant' AND session_id = ? AND csi_guard = TRUE FOR UPDATE")) {
                        query.setQueryTimeout(5);
                        query.setString(1, original.sessionId());
                        try (var rows = query.executeQuery()) {
                            assertThat(rows.next()).isTrue();
                            assertThat(rows.getBoolean(1)).isTrue();
                        }
                    }
                    created.countDown();
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                    while (jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.PROCESSLIST"
                            + " WHERE DB = DATABASE() AND COMMAND = 'Query'"
                            + " AND INFO LIKE 'SELECT csi_guard FROM managed_agent_session%FOR UPDATE'", Integer.class) == 0) {
                        assertThat(mutation).isNotDone();
                        assertThat(System.nanoTime()).isLessThan(deadline);
                        Thread.sleep(20);
                    }
                    assertThatThrownBy(() -> mutation.get(100, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
                    originalLock.rollback();
                    assertThatThrownBy(() -> mutation.get(5, TimeUnit.SECONDS)).isInstanceOf(ExecutionException.class)
                            .satisfies(error -> {
                                assertThat(error.getCause()).isInstanceOf(ApiException.class);
                                var refusal = (ApiException) error.getCause();
                                assertThat(refusal.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                                assertThat(refusal.getCode()).isEqualTo("csi_managed_mutation_unavailable");
                            });
                    assertThat(allTables(jdbc, json)).isEqualTo(before);
                } finally {
                    created.countDown();
                    if (!originalLock.getAutoCommit()) {
                        originalLock.rollback();
                    }
                }
            }
        } finally {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    private static Map<String, JsonNode> allTables(JdbcTemplate jdbc, ObjectMapper json) {
        var result = new TreeMap<String, JsonNode>();
        for (String table : jdbc.queryForList("SELECT table_name FROM information_schema.tables"
                + " WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name", String.class)) {
            var rows = jdbc.queryForList("SELECT * FROM " + table).stream().map(row -> json.<JsonNode>valueToTree(row))
                    .sorted(Comparator.comparing(JsonNode::toString)).toList();
            result.put(table, json.valueToTree(rows));
        }
        assertThat(result).containsKeys("flyway_schema_history", "managed_agent_session",
                "qwen_managed_session_journal_head", "qwen_csi_resource_read");
        return result;
    }
}
