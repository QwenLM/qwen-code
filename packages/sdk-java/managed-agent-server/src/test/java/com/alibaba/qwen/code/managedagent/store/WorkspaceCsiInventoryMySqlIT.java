package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.AbstractDataSource;

/** Real InnoDB snapshot qualification; the fixture journal is SQL mapping data only. */
@Timeout(60)
class WorkspaceCsiInventoryMySqlIT {
    @Test
    void holdsOneConsistentCutAcrossPagesAndSessionHeadsWhileAnotherCoordinatorCommits() throws Exception {
        try (var database = new O4MySqlDatabase()) {
            var fixture = new WorkspaceCsiCheckpointSnapshotStoreTest();
            fixture.initialize(database.source());
            var jdbc = new JdbcTemplate(database.source());
            var original = jdbc.queryForMap("SELECT * FROM qwen_tool_execution");
            for (int index = 0; index < 101; index++) {
                insert(jdbc, original, "before-" + index);
            }
            String retirementId = jdbc.queryForObject("SELECT retirement_id FROM managed_workspace_csi_retirement", String.class);
            var pageRead = new CountDownLatch(1);
            var committed = new CountDownLatch(1);
            DataSource observing = pauseAfterExecutionPage(database.source(), pageRead, committed);
            var bindings = new JdbcRuntimeBindingRepository(observing, new AesGcmSecretProtector("test-key", new byte[32]));
            var store = new WorkspaceCsiCheckpointSnapshotStore(observing, bindings, new ObjectMapper());
            try (var threads = Executors.newFixedThreadPool(2)) {
                var exporter = threads.submit(() -> store.exportRetirementInventory(retirementId));
                var writer = threads.submit(() -> {
                    try {
                        assertThat(pageRead.await(10, TimeUnit.SECONDS)).isTrue();
                        var tx = new org.springframework.transaction.support.TransactionTemplate(
                                new org.springframework.jdbc.datasource.DataSourceTransactionManager(database.source()));
                        tx.executeWithoutResult(status -> {
                            insert(jdbc, original, "after-snapshot");
                            jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'ACTIVE'");
                        });
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    } finally {
                        committed.countDown();
                    }
                });
                var first = exporter.get(30, TimeUnit.SECONDS);
                writer.get(30, TimeUnit.SECONDS);
                assertThat(first.path("executions").size()).isEqualTo(102);
                assertThat(first.path("executions").toString()).doesNotContain("after-snapshot");
                assertThat(first.path("sessionSnapshots").get(0).path("head").path("state").asText()).isEqualTo("SEALED");
                var next = store.exportRetirementInventory(retirementId);
                assertThat(next.path("executions").size()).isEqualTo(103);
                assertThat(next.path("executions").toString()).contains("after-snapshot");
                assertThat(next.path("sessionSnapshots").get(0).path("head").path("state").asText()).isEqualTo("ACTIVE");
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution", Integer.class)).isEqualTo(103);
                assertThat(jdbc.queryForObject("SELECT phase FROM managed_workspace_csi_retirement", String.class)).isEqualTo("DRAINING");
            } finally {
                committed.countDown();
            }
        }
    }

    private static void insert(JdbcTemplate jdbc, Map<String, Object> original, String id) {
        var row = new LinkedHashMap<>(original);
        byte[] bytes = id.getBytes(StandardCharsets.UTF_8);
        String hash = ToolPublicationContract.sha256(ByteBuffer.allocate(4 + bytes.length).putInt(bytes.length).put(bytes).array());
        row.put("execution_call_id", id);
        row.put("execution_call_id_hash", hash);
        row.put("idempotency_key", id);
        row.put("idempotency_key_hash", hash);
        jdbc.update("INSERT INTO qwen_tool_execution (" + String.join(",", row.keySet()) + ") VALUES ("
                + String.join(",", Collections.nCopies(row.size(), "?")) + ")", row.values().toArray());
    }

    private static DataSource pauseAfterExecutionPage(DataSource source, CountDownLatch read, CountDownLatch committed) {
        var paused = new AtomicBoolean();
        return new AbstractDataSource() {
            @Override
            public Connection getConnection() throws SQLException {
                Connection connection = source.getConnection();
                return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class},
                        (proxy, method, arguments) -> {
                            Object result = invoke(connection, method, arguments);
                            if (!"prepareStatement".equals(method.getName())) {
                                return result;
                            }
                            String sql = (String) arguments[0];
                            if (!sql.contains("FROM qwen_tool_execution") || !sql.endsWith("LIMIT 100")) {
                                return result;
                            }
                            return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{java.sql.PreparedStatement.class},
                                    (statement, call, parameters) -> {
                                        Object rows = invoke(result, call, parameters);
                                        if ("executeQuery".equals(call.getName()) && paused.compareAndSet(false, true)) {
                                            read.countDown();
                                            if (!committed.await(20, TimeUnit.SECONDS)) {
                                                throw new IllegalStateException("Concurrent commit did not complete");
                                            }
                                        }
                                        return rows;
                                    });
                        });
            }

            @Override
            public Connection getConnection(String user, String password) throws SQLException {
                return getConnection();
            }
        };
    }

    private static Object invoke(Object target, java.lang.reflect.Method method, Object[] arguments) throws Throwable {
        try {
            return method.invoke(target, arguments);
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
    }
}
