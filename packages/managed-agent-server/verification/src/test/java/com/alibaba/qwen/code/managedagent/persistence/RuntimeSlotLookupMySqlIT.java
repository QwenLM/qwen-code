package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Every ordinary Session write runs the CSI marker probe, so each resident
 * Session reads its Runtime slots and bindings several times a minute. Those
 * reads must stay bounded by an index as the tenant's slots grow, and the
 * fence's locking variant must lock only the Session it reads.
 */
class RuntimeSlotLookupMySqlIT {
    private static final String TENANT = "tenant";

    @Test
    void tenfoldRuntimeSlotsKeepTheMarkerProbeBoundedByIndexes() throws SQLException {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new JdbcTemplate(database.source());
            addRuntimes(jdbc, List.of("session-target"));
            int seeded = 0;
            for (int size : new int[] {1000, 10000}) {
                var others = new ArrayList<String>();
                for (int index = seeded; index < size; index++) {
                    others.add("session-other-" + index);
                }
                addRuntimes(jdbc, others);
                seeded = size;
                jdbc.execute("ANALYZE TABLE ma_runtime_slot, ma_runtime_binding");
                List<Statement> statements = new ArrayList<>();
                try (var connection = database.source().getConnection()) {
                    assertThat(JdbcCsiFilesRetirementGuard.hasCsiRuntimeMarker(
                            capturing(connection, statements), TENANT, "session-target")).isFalse();
                }
                assertThat(statements).hasSize(2);
                assertBounded(jdbc, only(statements, " FROM ma_runtime_slot "), "idx_ma_runtime_slot_isolation");
                assertBounded(jdbc, only(statements, " FROM ma_runtime_binding "), "qwen_runtime_harness_bindings_idx");
            }
        }
    }

    @Test
    void fenceLocksTheSlotsOfItsOwnSessionOnly() throws SQLException {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new JdbcTemplate(database.source());
            var sessions = new ArrayList<>(List.of("session-a", "session-b"));
            for (int index = 0; index < 1000; index++) {
                sessions.add("session-other-" + index);
            }
            addRuntimes(jdbc, sessions);
            jdbc.execute("ANALYZE TABLE ma_runtime_slot, ma_runtime_binding");
            try (var fence = database.source().getConnection();
                    var other = database.source().getConnection()) {
                fence.setAutoCommit(false);
                other.setAutoCommit(false);
                try (var timeout = other.createStatement()) {
                    timeout.execute("SET SESSION innodb_lock_wait_timeout = 1");
                }
                assertThat(JdbcCsiFilesRetirementGuard.lockManagedSession(fence, TENANT, "session-a")).isNull();

                // Another Session's slot stays writable while the fence is held.
                try (var update = other.prepareStatement(
                        "UPDATE ma_runtime_slot SET last_generation = last_generation + 1 WHERE request_key = ?")) {
                    update.setString(1, slotKey("session-b"));
                    assertThat(update.executeUpdate()).isEqualTo(1);
                }
                // A second slot for the fenced Session still waits for the fence.
                assertThatThrownBy(() -> insertSlot(other, "session-a", "second"))
                        .isInstanceOfSatisfying(SQLException.class,
                                error -> assertThat(error.getErrorCode()).isEqualTo(1205));
                other.rollback();
                fence.rollback();
            }
        }
    }

    private static void addRuntimes(JdbcTemplate jdbc, List<String> sessions) {
        var slots = new ArrayList<Object[]>();
        var bindings = new ArrayList<Object[]>();
        for (String session : sessions) {
            slots.add(new Object[] {slotKey(session), session, bindingId(session)});
            bindings.add(new Object[] {bindingId(session), slotKey(session),
                    ManagedSchemaKeys.key("scope", session), session});
        }
        jdbc.batchUpdate("INSERT INTO ma_runtime_slot (request_key, tenant_id, workspace_id, workspace_generation,"
                + " canonical_cwd, capability_digest, isolation_class, isolation_key, provisioner_kind, storage_id,"
                + " last_generation, active_binding_id) VALUES (?, 'tenant', 'workspace', '1', '/scale', 'digest',"
                + " 'session', ?, 'local-process', NULL, 1, ?)", slots);
        jdbc.batchUpdate("INSERT INTO ma_runtime_binding (binding_id, request_key, scope_key, tenant_id, workspace_id,"
                + " workspace_generation, canonical_cwd, capability_digest, isolation_class, isolation_key,"
                + " provisioner_kind, runtime_generation, binding_state, attestation_generation,"
                + " is_drain_requested, operation_generation, record_version, last_active_at)"
                + " VALUES (?, ?, ?, 'tenant', 'workspace', '1', '/scale', 'digest', 'session', ?, 'local-process',"
                + " 1, 'READY', 0, FALSE, 0, 0, " + ManagedSchemaTime.SQL_NOW + ")", bindings);
    }

    private static void insertSlot(Connection connection, String session, String variant) throws SQLException {
        try (var insert = connection.prepareStatement("INSERT INTO ma_runtime_slot (request_key, tenant_id,"
                + " workspace_id, workspace_generation, canonical_cwd, capability_digest, isolation_class,"
                + " isolation_key, provisioner_kind, last_generation) VALUES (?, 'tenant', 'workspace',"
                + " '1', '/scale', 'digest', 'session', ?, 'local-process', 0)")) {
            insert.setString(1, ManagedSchemaKeys.key("slot", session, variant));
            insert.setString(2, session);
            insert.executeUpdate();
        }
    }

    private static String slotKey(String session) {
        return ManagedSchemaKeys.key("slot", session);
    }

    private static String bindingId(String session) {
        return "binding-" + session;
    }

    private static void assertBounded(JdbcTemplate jdbc, Statement statement, String index) {
        var plan = ExecutedQueryPlan.explain(jdbc, statement.sql(), statement.arguments());
        assertThat(plan.tableScan()).as(plan.text()).isFalse();
        // MariaDB reports an index merge's keys inside the merge, which
        // Plan.usesIndex does not collect; the plan text names them on both.
        assertThat(plan.text()).contains(index);
        assertThat(plan.rowCounts()).as(plan.text()).isNotEmpty();
        for (double count : plan.rowCounts()) {
            assertThat(count).as(plan.text()).isLessThanOrEqualTo(5);
        }
    }

    private static Statement only(List<Statement> statements, String table) {
        var matching = statements.stream().filter(statement -> statement.sql().contains(table)).toList();
        assertThat(matching).hasSize(1);
        return matching.getFirst();
    }

    private record Statement(String sql, TreeMap<Integer, Object> values) {
        Object[] arguments() {
            return values.values().toArray();
        }
    }

    /** Records each prepared statement's SQL and positional arguments, then delegates. */
    private static Connection capturing(Connection target, List<Statement> statements) {
        return (Connection) Proxy.newProxyInstance(RuntimeSlotLookupMySqlIT.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, arguments) -> {
                    Object result = invoke(target, method, arguments);
                    if (!"prepareStatement".equals(method.getName())) {
                        return result;
                    }
                    var statement = new Statement((String) arguments[0], new TreeMap<>());
                    statements.add(statement);
                    PreparedStatement prepared = (PreparedStatement) result;
                    return Proxy.newProxyInstance(RuntimeSlotLookupMySqlIT.class.getClassLoader(),
                            new Class<?>[] {PreparedStatement.class}, (inner, call, parameters) -> {
                                if (call.getName().startsWith("set") && parameters != null && parameters.length == 2
                                        && parameters[0] instanceof Integer position) {
                                    statement.values().put(position, parameters[1]);
                                }
                                return invoke(prepared, call, parameters);
                            });
                });
    }

    private static Object invoke(Object target, java.lang.reflect.Method method, Object[] arguments)
            throws Throwable {
        try {
            return method.invoke(target, arguments);
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
    }
}
