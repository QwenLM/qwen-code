package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.DefaultTransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.util.Comparator;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Timeout(30)
class ManagedAgentCsiMutationMySqlIT {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void ordinaryCollectionAndPrivateCreationBothComplete(boolean page) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "csi_collection_create_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4");
        try {
            var data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
            Flyway.configure().dataSource(data).locations("classpath:db/managed-schema").load().migrate();
            var jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(data);
            String lockWaitQuery = lockWaitQuery(jdbc);
            var manager = new DataSourceTransactionManager(data);
            var json = new ObjectMapper();
            var properties = new ManagedAgentProperties();
            properties.setAgentRevision("reviewed-agent/1");
            properties.getToolPublication().setGcEnabled(true);
            properties.getToolPublication().setDeletionGrace(Duration.ZERO);
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                    "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
            new WorkspaceCsiReservationStore(jdbc, manager, json).register(registration);
            jdbc.update(
                    "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                            + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                    + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                    CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            jdbc.update(
                    "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                            + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            String ordinary = "!ordinary-retired";
            String scope = ManagedSessionStore.sessionScopeKey("tenant", ordinary);
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified) VALUES ('tenant', ?, 'qwen-code', 'DELETED', 1, 1)", ordinary);
            jdbc.update(
                    "UPDATE ma_session SET tenant_key = ?, session_key = ?, session_scope_key = ?,"
                        + " retirement_operation_id = 'delete', retirement_generation = 1,"
                        + " retired_at = 1, recovery_protected = FALSE WHERE tenant_id = 'tenant'"
                        + " AND session_id = ?",
                    ToolPublicationRetentionStore.hash("tenant"), ToolPublicationRetentionStore.hash(ordinary),
                    scope,
                    ordinary);
            String operationId = "session-resources-" + scope;
            long now = ToolPublicationRetentionStore.now(jdbc);
            jdbc.update(
                    "INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id, operation_kind, tenant_id, session_id, target_kind, target_key, request_digest, request_json, phase, state, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'SESSION_RESOURCE_GC', 'tenant', ?, 'SESSION', ?, ?, '{}', 'COLLECTING', 'PENDING', ?, ?)",
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys
                            .operationKey(
                                    com.alibaba.qwen.code.runtimebroker.managedschema
                                            .ManagedSchemaContract.OperationKind
                                            .SESSION_RESOURCE_GC,
                                    scope,
                                    scope,
                                    operationId),
                    scope,
                    scope,
                    operationId,
                    ordinary,
                    scope,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            operationId),
                    now,
                    now);
            var collector = new SessionResourceCollectionCollector(jdbc, manager, properties);
            var claim = page ? collector.claim() : null;
            if (page) {
                assertThat(claim).isNotNull();
            }
            var inserting = new CountDownLatch(1);
            var continueInsert = new CountDownLatch(1);
            var creationJdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(data) {
                @Override
                public int update(String sql, Object... args) {
                    if (sql.startsWith("INSERT INTO ma_session ")) {
                        inserting.countDown();
                        try {
                            assertThat(continueInsert.await(10, TimeUnit.SECONDS)).isTrue();
                        } catch (InterruptedException error) {
                            Thread.currentThread().interrupt();
                            throw new AssertionError(error);
                        }
                    }
                    return super.update(sql, args);
                }
            };
            try (var pool = Executors.newFixedThreadPool(2)) {
                try {
                    var creation = pool.submit(() -> WorkspaceCsiSessionMain.create(creationJdbc, manager, json, properties,
                            new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null,
                                    new WorkspaceSelection("workspace", "."))));
                    assertThat(inserting.await(5, TimeUnit.SECONDS)).isTrue();
                    var collection = pool.submit(() -> page ? collector.collect(claim) : collector.claim());
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                    while (jdbc.queryForObject(lockWaitQuery, Integer.class, "ma_tenant_guard") == 0) {
                        assertThat(collection).isNotDone();
                        assertThat(System.nanoTime()).isLessThan(deadline);
                        // InnoDB information-schema lock views need over 100 ms between cache
                        // reads.
                        Thread.sleep(150);
                    }
                    continueInsert.countDown();
                    var created = creation.get(5, TimeUnit.SECONDS);
                    var collected = collection.get(5, TimeUnit.SECONDS);
                    assertThat(jdbc.queryForObject(
                                            "SELECT csi_guard FROM ma_session WHERE session_id = ?",
                            Boolean.class, created.sessionId())).isTrue();
                    if (page) {
                        assertThat(collected).isEqualTo(Boolean.TRUE);
                        assertThat(jdbc.queryForObject(
                                                "SELECT completed_at FROM ma_operation WHERE"
                                                    + " operation_kind = 'SESSION_RESOURCE_GC' AND"
                                                    + " session_scope_key = ?", Long.class, scope)).isNotNull();
                    } else {
                        assertThat(collected).isInstanceOf(SessionResourceCollectionCollector.Claim.class);
                    }
                } finally {
                    continueInsert.countDown();
                }
            }
        } finally {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {Connection.TRANSACTION_READ_COMMITTED, Connection.TRANSACTION_REPEATABLE_READ})
    void currentProbeWaitsForOriginalRowAndRefusesAfterAWarmedSnapshot(int isolation) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "csi_managed_mutation_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4");
        try {
            var data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
            Flyway.configure().dataSource(data).locations("classpath:db/managed-schema").load().migrate();
            var jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(data);
            String lockWaitQuery = lockWaitQuery(jdbc);
            var manager = new DataSourceTransactionManager(data);
            var json = new ObjectMapper();
            var properties = new ManagedAgentProperties();
            properties.setAgentRevision("reviewed-agent/1");
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                    "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
            new WorkspaceCsiReservationStore(jdbc, manager, json).register(registration);
            jdbc.update(
                    "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                            + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                    + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                    CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            jdbc.update(
                    "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
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
                    assertThat(jdbc.queryForObject(
                                                                            "SELECT COUNT(*) FROM"
                                                                                    + " ma_session", Integer.class)).isZero();
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
                    try (var query = originalLock.prepareStatement(
                                    "SELECT csi_guard FROM ma_session FORCE INDEX"
                                        + " (ma_session_csi_guard_idx) WHERE tenant_id = 'tenant'"
                                        + " AND session_id = ? AND csi_guard = TRUE FOR UPDATE")) {
                        query.setQueryTimeout(5);
                        query.setString(1, original.sessionId());
                        try (var rows = query.executeQuery()) {
                            assertThat(rows.next()).isTrue();
                            assertThat(rows.getBoolean(1)).isTrue();
                        }
                    }
                    created.countDown();
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                    while (jdbc.queryForObject(lockWaitQuery, Integer.class, "ma_session") == 0) {
                        assertThat(mutation).isNotDone();
                        assertThat(System.nanoTime()).isLessThan(deadline);
                        Thread.sleep(150);
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

    @ParameterizedTest
    @ValueSource(ints = {Connection.TRANSACTION_READ_COMMITTED, Connection.TRANSACTION_REPEATABLE_READ})
    void writerAfterAWarmedSnapshotStillRefusesAnOriginalCommittedLater(int isolation) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "csi_warmed_writer_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4");
        try {
            var data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
            Flyway.configure().dataSource(data).locations("classpath:db/managed-schema").load().migrate();
            var jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(data);
            var manager = new DataSourceTransactionManager(data);
            var json = new ObjectMapper();
            var properties = new ManagedAgentProperties();
            properties.setAgentRevision("reviewed-agent/1");
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                    "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
            new WorkspaceCsiReservationStore(jdbc, manager, json).register(registration);
            jdbc.update(
                    "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                            + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                    + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                    CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            jdbc.update(
                    "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                            + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            var journal = new ManagedSessionStore(jdbc);
            var transaction = new TransactionTemplate(manager);
            transaction.setIsolationLevel(isolation);
            transaction.setTimeout(15);
            var warmed = new CountDownLatch(1);
            var created = new CountDownLatch(1);
            var session = new java.util.concurrent.atomic.AtomicReference<String>();
            try (var pool = Executors.newSingleThreadExecutor()) {
                // The writer's snapshot predates the original Session, so only
                // a locking read of its root can see the pin.
                var writer = pool.submit(() -> transaction.execute(status -> {
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isZero();
                    warmed.countDown();
                    try {
                        assertThat(created.await(10, TimeUnit.SECONDS)).isTrue();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new AssertionError(error);
                    }
                    return journal.acquireWriter("tenant", session.get(), "csi-original-writer-token-for-test",
                            new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 60_000L));
                }));
                try {
                    assertThat(warmed.await(5, TimeUnit.SECONDS)).isTrue();
                    session.set(WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                            new WorkspaceCsiSessionMain.Request(registration, "actor", "original", null, null,
                                    new WorkspaceSelection("workspace", "."))).sessionId());
                    var before = allTables(jdbc, json);
                    created.countDown();
                    assertThatThrownBy(() -> writer.get(10, TimeUnit.SECONDS)).isInstanceOf(ExecutionException.class)
                            .satisfies(error -> {
                                assertThat(error.getCause()).isInstanceOf(
                                        com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
                                assertThat(((com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException)
                                                error.getCause()).getCode())
                                        .isEqualTo("csi_original_binding_unavailable");
                            });
                    assertThat(allTables(jdbc, json)).isEqualTo(before);
                } finally {
                    created.countDown();
                }
            }
        } finally {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    /**
     * A CSI-pinned Session takes the tenant guards behind its root on paths
     * that hold no tenant guard yet (renew, commit, recovery state). Those
     * acquisitions are bounded and named like every other per-turn lane: a
     * held guard answers tenant_guard_contended within the hot-path bound
     * instead of out-waiting the caller on InnoDB's lock wait (#13800).
     */
    @ParameterizedTest
    @ValueSource(strings = {"runtime_placement", "output_publication"})
    void pinnedSessionBoundsItsTenantGuards(String domain) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "csi_guard_bound_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4");
        try {
            var data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
            Flyway.configure().dataSource(data).locations("classpath:db/managed-schema").load().migrate();
            var jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(data);
            var manager = new DataSourceTransactionManager(data);
            var json = new ObjectMapper();
            var properties = new ManagedAgentProperties();
            properties.setAgentRevision("reviewed-agent/1");
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                    "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
            new WorkspaceCsiReservationStore(jdbc, manager, json).register(registration);
            jdbc.update(
                    "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                            + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                    + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                    CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            jdbc.update(
                    "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                            + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            String session = WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                    new WorkspaceCsiSessionMain.Request(registration, "actor", "original", null, null,
                            new WorkspaceSelection("workspace", "."))).sessionId();
            var journal = new ManagedSessionStore(jdbc);
            var transaction = new TransactionTemplate(manager);
            var hold = manager.getTransaction(new DefaultTransactionDefinition());
            try {
                if ("runtime_placement".equals(domain)) {
                    WorkspaceLifecycleStore.lockPlacement(jdbc, "tenant");
                } else {
                    ToolPublicationRetentionStore.lockTenant(jdbc, "tenant");
                }
                long before = System.nanoTime();
                try (var pool = Executors.newSingleThreadExecutor()) {
                    var blocked = pool.submit(() -> transaction.execute(ignored -> {
                        // Past the 20 s wait below: without the 5 s bound
                        // the server's own lock wait cannot answer first
                        // and pass for it, whatever the server's default
                        // (#13800 R2-11).
                        jdbc.execute("SET SESSION innodb_lock_wait_timeout = 30");
                        return journal.blockRecovery("tenant",
                                session, "csi-original-writer-token-for-test",
                                new ManagedSessionStoreModels.BlockRecoveryRequest("workspace", "writer", 1,
                                        "BLOCKED_RESOURCE", "guard-witness"));
                    }));
                    assertThatThrownBy(() -> blocked.get(20, TimeUnit.SECONDS)).isInstanceOf(ExecutionException.class)
                            .satisfies(error -> {
                                assertThat(error.getCause()).isInstanceOf(ApiException.class);
                                var refusal = (ApiException) error.getCause();
                                assertThat(refusal.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                                assertThat(refusal.getCode()).isEqualTo("tenant_guard_contended");
                            });
                }
                // One bounded wait (5 s) plus slack; fixed numbers, so a
                // raised bound fails here too, and the floor shows the
                // refusal came from a wait on the held row that actually
                // ran to the bound rather than from an earlier failure.
                long elapsedMillis = (System.nanoTime() - before) / 1_000_000;
                assertThat(elapsedMillis).isGreaterThanOrEqualTo(4_000).isLessThan(15_000);
            } finally {
                manager.rollback(hold);
            }
        } finally {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    private static String lockWaitQuery(JdbcTemplate jdbc) {
        if (jdbc.queryForObject("SELECT VERSION()", String.class).contains("MariaDB")) {
            return "SELECT COUNT(*) FROM information_schema.INNODB_LOCK_WAITS w"
                    + " JOIN information_schema.INNODB_LOCKS l ON l.LOCK_ID = w.REQUESTED_LOCK_ID"
                    + " WHERE l.LOCK_TABLE = CONCAT('`', DATABASE(), '`.`', ?, '`')";
        }
        return "SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN"
                + " performance_schema.data_locks l ON l.ENGINE_LOCK_ID ="
                + " w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND"
                + " l.OBJECT_NAME = ?";
    }

    private static Map<String, JsonNode> allTables(JdbcTemplate jdbc, ObjectMapper json) {
        var result = new TreeMap<String, JsonNode>();
        for (String table : jdbc.queryForList(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema ="
                                + " DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name", String.class)) {
            var rows = jdbc.queryForList("SELECT * FROM " + table).stream().map(row -> json.<JsonNode>valueToTree(row))
                    .sorted(Comparator.comparing(JsonNode::toString)).toList();
            result.put(table, json.valueToTree(rows));
        }
        assertThat(result).containsKeys("flyway_schema_history",
                        "ma_session",
                        "ma_session_head",
                        "ma_request_receipt");
        return result;
    }
}
