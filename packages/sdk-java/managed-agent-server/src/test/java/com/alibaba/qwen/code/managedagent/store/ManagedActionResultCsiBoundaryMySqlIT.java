package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.time.Clock;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.UnexpectedRollbackException;
import org.springframework.transaction.support.TransactionTemplate;

@Timeout(30)
class ManagedActionResultCsiBoundaryMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();

    @ParameterizedTest
    @ValueSource(ints = {Connection.TRANSACTION_READ_COMMITTED, Connection.TRANSACTION_REPEATABLE_READ})
    void privateCallbacksWaitAtParentBeforeHeadOrResult(int isolation) throws Exception {
        try (var fixture = new Fixture(isolation)) {
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                    "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
            new WorkspaceCsiReservationStore(fixture.jdbc, fixture.manager, JSON).register(registration);
            fixture.jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                    + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                    CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            fixture.jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            String session = WorkspaceCsiSessionMain.create(fixture.jdbc, fixture.manager, JSON, fixture.properties,
                    new WorkspaceCsiSessionMain.Request(registration, "actor", "original", null, null,
                            new WorkspaceSelection("workspace", "."))).sessionId();
            var source = fixture.seedResult(session, "historical-private", "LEASED");
            fixture.jdbc.update("INSERT INTO qwen_managed_session_journal_head (tenant_id, workspace_id, session_id, storage_version,"
                    + " state, writer_generation, journal_revision, committed_sequence, activation_epoch, compacted_through_revision,"
                    + " recovery_status, created_at, updated_at) VALUES ('tenant', 'workspace', ?, 1, 'ACTIVE', 1, 0, 0, 0, 0,"
                    + " 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)", session);
            var claim = new ManagedToolResultStore.Claim(source, 1);
            var before = fixture.tables();
            fixture.waitAtParent(session, () -> {
                fixture.results.fail(claim, "RETRYABLE", "late-callback");
                return null;
            }, false);
            assertThat(fixture.tables()).isEqualTo(before);
            fixture.waitAtParent(session, () -> fixture.results.complete(claim,
                    new ManagedToolResultStore.Projection(JSON.createObjectNode(), "missing", JSON.createObjectNode(),
                            JSON.nullNode(), List.of(), "policy"), "policy"), true);
            assertThat(fixture.tables()).isEqualTo(before);
            fixture.waitAtParent(session, () -> fixture.results.admitsLegacyProjection(claim), false);
            assertThat(fixture.tables()).isEqualTo(before);
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {Connection.TRANSACTION_READ_COMMITTED, Connection.TRANSACTION_REPEATABLE_READ})
    void concurrentOrdinaryClaimsHaveOneWinner(int isolation) throws Exception {
        try (var fixture = new Fixture(isolation); var pool = Executors.newFixedThreadPool(2)) {
            var source = fixture.seedResult("journal-only", "ordinary", "PENDING");
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            Callable<java.util.Optional<ManagedToolResultStore.Claim>> callback = () -> fixture.transaction.execute(status -> {
                fixture.jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Integer.class);
                ready.countDown();
                await(start);
                return fixture.results.claim();
            });
            var first = pool.submit(callback);
            var second = pool.submit(callback);
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            var winners = List.of(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS))
                    .stream().flatMap(java.util.Optional::stream).toList();
            assertThat(winners).hasSize(1);
            assertThat(winners.getFirst()).isEqualTo(new ManagedToolResultStore.Claim(source, 2));
            assertThat(fixture.jdbc.queryForMap("SELECT work_state, claim_generation, attempts FROM managed_agent_tool_result"))
                    .containsEntry("work_state", "LEASED").containsEntry("claim_generation", 2L).containsEntry("attempts", 1);
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            assertThat(latch.await(10, TimeUnit.SECONDS)).isTrue();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final JdbcTemplate admin;
        private final String schema;
        private final DriverManagerDataSource data;
        private final JdbcTemplate jdbc;
        private final DataSourceTransactionManager manager;
        private final TransactionTemplate transaction;
        private final ManagedAgentProperties properties = new ManagedAgentProperties();
        private final ManagedToolResultStore results;

        Fixture(int isolation) {
            String url = System.getProperty("mysql.url");
            if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
                throw new IllegalArgumentException("A MySQL test database URL is required");
            }
            String user = System.getProperty("mysql.user");
            String password = System.getProperty("mysql.password", "");
            admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
            schema = "csi_action_result_" + UUID.randomUUID().toString().replace("-", "");
            admin.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4");
            data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
            try {
                Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
                jdbc = new JdbcTemplate(data);
                manager = new DataSourceTransactionManager(data);
                transaction = new TransactionTemplate(manager);
                transaction.setIsolationLevel(isolation);
                transaction.setTimeout(15);
                properties.setAgentRevision("reviewed-agent/1");
                results = new ManagedToolResultStore(jdbc, manager, new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(),
                        ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties));
            } catch (RuntimeException error) {
                admin.execute("DROP DATABASE IF EXISTS " + schema);
                throw error;
            }
        }

        void waitAtParent(String session, Callable<?> callback, boolean rollbackExpected) throws Exception {
            try (var pool = Executors.newSingleThreadExecutor(); var owner = data.getConnection()) {
                owner.setAutoCommit(false);
                try {
                    try (var query = owner.prepareStatement("SELECT csi_guard FROM managed_agent_session"
                            + " FORCE INDEX (managed_session_csi_guard_idx)"
                            + " WHERE tenant_id = 'tenant' AND session_id = ? AND csi_guard = TRUE FOR UPDATE")) {
                        query.setString(1, session);
                        try (var rows = query.executeQuery()) {
                            assertThat(rows.next()).isTrue();
                            assertThat(rows.getBoolean(1)).isTrue();
                        }
                    }
                    var warmed = new CountDownLatch(1);
                    var mutation = pool.submit(() -> transaction.execute(status -> {
                        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Integer.class)).isEqualTo(1);
                        warmed.countDown();
                        try {
                            return callback.call();
                        } catch (Exception error) {
                            throw new AssertionError(error);
                        }
                    }));
                    assertThat(warmed.await(5, TimeUnit.SECONDS)).isTrue();
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                    while (jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.PROCESSLIST"
                            + " WHERE DB = DATABASE() AND COMMAND = 'Query'"
                            + " AND INFO LIKE 'SELECT csi_guard FROM managed_agent_session%FOR UPDATE'", Integer.class) == 0) {
                        assertThat(mutation).isNotDone();
                        assertThat(System.nanoTime()).isLessThan(deadline);
                        Thread.sleep(20);
                    }
                    assertThatThrownBy(() -> mutation.get(100, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
                    for (String table : List.of("qwen_managed_session_journal_head", "managed_agent_tool_result")) {
                        try (var query = owner.prepareStatement("SELECT session_id FROM " + table
                                + " WHERE tenant_id = 'tenant' AND session_id = ? FOR UPDATE")) {
                            query.setQueryTimeout(2);
                            query.setString(1, session);
                            try (var rows = query.executeQuery()) {
                                assertThat(rows.next()).isTrue();
                            }
                        }
                    }
                    owner.rollback();
                    try {
                        Object value = mutation.get(5, TimeUnit.SECONDS);
                        assertThat(rollbackExpected).isFalse();
                        assertThat(value == null || Boolean.FALSE.equals(value)).isTrue();
                    } catch (ExecutionException error) {
                        assertThat(rollbackExpected).isTrue();
                        assertThat(error.getCause()).isInstanceOf(UnexpectedRollbackException.class);
                    }
                } finally {
                    owner.rollback();
                }
            }
        }

        ManagedToolResultStore.Source seedResult(String session, String id, String state) {
            // This row is historical legacy work, not original native membership.
            var source = new ManagedToolResultStore.Source(id, "tenant", "workspace", session, "execution-" + id,
                    1, 1, JSON.nullNode(), JSON.nullNode(), JSON.createArrayNode(), "a".repeat(64));
            jdbc.update("INSERT INTO managed_agent_tool_result (result_id, scope_key, execution_key, tenant_id, workspace_id,"
                    + " session_id, source_json, source_digest, work_state, claim_generation, claim_until)"
                    + " VALUES (?, ?, ?, 'tenant', 'workspace', ?, ?, ?, ?, 1, 0)", id,
                    ManagedToolResultStore.scope("tenant", session), ManagedToolResultStore.identity("execution", id).substring(10),
                    session, JSON.valueToTree(source).toString(), source.sourceDigest(), state);
            return source;
        }

        Map<String, JsonNode> tables() {
            return transaction.execute(status -> {
                var result = new TreeMap<String, JsonNode>();
                for (String table : jdbc.queryForList("SELECT table_name FROM information_schema.tables"
                        + " WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name", String.class)) {
                    var rows = jdbc.queryForList("SELECT * FROM " + table).stream().map(row -> {
                        row.replaceAll((column, value) -> value instanceof java.sql.Timestamp timestamp ? timestamp.toString() : value);
                        return JSON.<JsonNode>valueToTree(row);
                    })
                            .sorted(Comparator.comparing(JsonNode::toString)).toList();
                    result.put(table, JSON.valueToTree(rows));
                }
                assertThat(result).hasSize(57);
                return result;
            });
        }

        @Override
        public void close() {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
