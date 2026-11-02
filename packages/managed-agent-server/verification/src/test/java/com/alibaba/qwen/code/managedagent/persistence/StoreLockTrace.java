package com.alibaba.qwen.code.managedagent.persistence;

import org.springframework.jdbc.datasource.DelegatingDataSource;

import javax.sql.DataSource;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/** Test-only observation; never issues a query or changes transaction configuration. */
public final class StoreLockTrace extends DelegatingDataSource {
    enum Phase { ATTEMPT, SUCCEEDED, FAILED, BEGIN, COMMIT, ROLLBACK, CLOSE }

    record Event(Phase phase, long connection, long transaction, boolean autoCommit,
            String sql, Map<Integer, String> arguments) {
        boolean scope(String tenant, String session) {
            if (sql.startsWith("insert into ma_session (") || sql.startsWith("insert into ma_turn (")) {
                return tenant.equals(arguments.get(1)) && session.equals(arguments.get(2));
            }
            return identity("tenant_id", tenant) && identity("session_id", session);
        }

        private boolean identity(String column, String identity) {
            var match = Pattern.compile("\\b" + column + " = \\?").matcher(sql);
            if (!match.find()) {
                return false;
            }
            int position = 1 + (int) sql.substring(0, match.start()).chars().filter(c -> c == '?').count();
            String value = arguments.get(position);
            return identity.equals(value) || bytes(identity.getBytes(StandardCharsets.UTF_8)).equals(value);
        }

        boolean root() {
            return table(sql, "ma_session")
                    && (sql.startsWith("insert into ma_session ")
                            || sql.startsWith("update ma_session ")
                            || sql.contains("for update") && !sql.contains("csi_guard = true"));
        }

        boolean turn() {
            return table(sql, "ma_turn");
        }

        boolean mappedHead() {
            return head() && sql.startsWith("select tenant_id, workspace_id, session_id, storage_version,");
        }

        boolean head() {
            return table(sql, "ma_session_head") && sql.contains("for update")
                    && sql.contains("head_kind = 'managed_session'");
        }
    }

    private final AtomicLong connections = new AtomicLong();
    private final List<Event> events = new ArrayList<>();

    public StoreLockTrace(DataSource source) {
        super(source);
    }

    public synchronized void clear() {
        events.clear();
    }

    synchronized List<Event> events() {
        return List.copyOf(events);
    }

    List<Event> successful(String tenant, String session) {
        return events().stream().filter(event -> event.phase() == Phase.SUCCEEDED
                && event.scope(tenant, session)).toList();
    }

    public void assertSessionBeforeTurn(String tenant, String session) {
        assertOrder(events(), tenant, session, false);
    }

    void assertRootBeforeHead(String tenant, String session) {
        assertOrder(events(), tenant, session, true);
    }

    static void assertOrder(List<Event> events, String tenant, String session, boolean head) {
        Set<String> roots = new HashSet<>();
        int accesses = 0;
        for (Event event : events) {
            if (event.phase() == Phase.COMMIT || event.phase() == Phase.ROLLBACK || event.phase() == Phase.CLOSE) {
                roots.removeIf(key -> key.startsWith(event.connection() + ":"));
            }
            if (event.phase() != Phase.SUCCEEDED || !event.scope(tenant, session)) {
                continue;
            }
            String transaction = event.connection() + ":" + event.transaction();
            if (head ? event.head() : event.turn()) {
                accesses++;
                assertThat(event.autoCommit()).as("dependent SQL has a transaction: %s", event.sql()).isFalse();
                assertThat(roots).as("same Session root precedes dependent SQL: %s", event.sql())
                        .contains(transaction);
            }
            if (event.root() && !event.autoCommit()) {
                roots.add(transaction);
            }
        }
        assertThat(accesses).as("scenario actually reached its dependent rows").isPositive();
    }

    void assertOneTransaction(String tenant, String session) {
        List<Event> statements = successful(tenant, session);
        assertThat(statements).isNotEmpty().allMatch(event -> !event.autoCommit());
        assertThat(statements.stream().map(event -> event.connection() + ":" + event.transaction()).distinct())
                .hasSize(1);
    }

    @Override
    public Connection getConnection() throws SQLException {
        return wrap(super.getConnection());
    }

    @Override
    public Connection getConnection(String user, String password) throws SQLException {
        return wrap(super.getConnection(user, password));
    }

    private Connection wrap(Connection connection) throws SQLException {
        long id = connections.incrementAndGet();
        boolean[] autoCommit = {connection.getAutoCommit()};
        long[] transaction = {1};
        return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                (proxy, method, arguments) -> {
                    Object result = invoke(connection, method, arguments);
                    String name = method.getName();
                    if (result instanceof Statement statement && (name.equals("prepareStatement")
                            || name.equals("prepareCall") || name.equals("createStatement"))) {
                        return statement(statement, (Connection) proxy, id, transaction, autoCommit,
                                name.equals("createStatement") ? null : (String) arguments[0]);
                    }
                    if (name.equals("setAutoCommit")) {
                        boolean next = (Boolean) arguments[0];
                        if (next != autoCommit[0]) {
                            if (next) {
                                add(Phase.COMMIT, id, transaction[0], autoCommit[0], "", Map.of());
                            }
                            transaction[0]++;
                            autoCommit[0] = next;
                            if (!next) {
                                add(Phase.BEGIN, id, transaction[0], false, "", Map.of());
                            }
                        }
                    } else if ((name.equals("commit") || name.equals("rollback"))
                            && (arguments == null || arguments.length == 0)) {
                        add(name.equals("commit") ? Phase.COMMIT : Phase.ROLLBACK,
                                id, transaction[0], autoCommit[0], "", Map.of());
                        transaction[0]++;
                    } else if (name.equals("close")) {
                        add(Phase.CLOSE, id, transaction[0], autoCommit[0], "", Map.of());
                        transaction[0]++;
                    }
                    return result;
                });
    }

    private Statement statement(Statement statement, Connection connection,
            long id, long[] transaction, boolean[] autoCommit, String text) {
        Map<Integer, String> parameters = new HashMap<>();
        List<Map<Integer, String>> batch = new ArrayList<>();
        List<String> batchSql = new ArrayList<>();
        Class<?> api = statement instanceof CallableStatement ? CallableStatement.class
                : statement instanceof PreparedStatement ? PreparedStatement.class : Statement.class;
        return (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {api},
                (proxy, method, arguments) -> {
                    String name = method.getName();
                    if (name.equals("getConnection")) {
                        return connection;
                    }
                    String sql = normalize(text != null ? text : arguments != null && arguments.length > 0
                            && arguments[0] instanceof String value ? value : "");
                    if (name.equals("clearParameters")) {
                        parameters.clear();
                    } else if (name.startsWith("set") && arguments != null && arguments.length >= 2
                            && arguments[0] instanceof Integer position) {
                        Object value = name.equals("setNull") ? null : arguments[1];
                        parameters.put(position, value instanceof byte[] data ? bytes(data) : String.valueOf(value));
                    } else if (name.equals("addBatch")) {
                        Object value = invoke(statement, method, arguments);
                        batch.add(Map.copyOf(parameters));
                        batchSql.add(sql);
                        return value;
                    } else if (name.equals("clearBatch")) {
                        batch.clear();
                        batchSql.clear();
                    }
                    if (!name.startsWith("execute")) {
                        return invoke(statement, method, arguments);
                    }
                    boolean batched = name.equals("executeBatch") || name.equals("executeLargeBatch");
                    var bindings = batched ? List.copyOf(batch) : List.of(Map.copyOf(parameters));
                    var statements = batched ? List.copyOf(batchSql) : List.of(sql);
                    for (int i = 0; i < bindings.size(); i++) {
                        add(Phase.ATTEMPT, id, transaction[0], autoCommit[0], statements.get(i), bindings.get(i));
                    }
                    try {
                        Object value = invoke(statement, method, arguments);
                        for (int i = 0; i < bindings.size(); i++) {
                            boolean failed = value instanceof int[] counts && counts[i] == Statement.EXECUTE_FAILED
                                    || value instanceof long[] largeCounts && largeCounts[i] == Statement.EXECUTE_FAILED;
                            add(failed ? Phase.FAILED : Phase.SUCCEEDED, id, transaction[0], autoCommit[0], statements.get(i), bindings.get(i));
                        }
                        return value;
                    } catch (Throwable failure) {
                        for (int i = 0; i < bindings.size(); i++) {
                            add(Phase.FAILED, id, transaction[0], autoCommit[0], statements.get(i), bindings.get(i));
                        }
                        throw failure;
                    } finally {
                        if (batched) {
                            batch.clear();
                            batchSql.clear();
                        }
                    }
                });
    }

    private static String normalize(String sql) {
        return sql.replaceAll("\\s+", " ").replaceAll("\\s*=\\s*", " = ").trim().toLowerCase(Locale.ROOT);
    }

    private synchronized void add(Phase phase, long connection, long transaction, boolean autoCommit,
            String sql, Map<Integer, String> parameters) {
        events.add(new Event(phase, connection, transaction, autoCommit, sql, Map.copyOf(parameters)));
    }

    private static Object invoke(Object target, Method method, Object[] arguments) throws Throwable {
        try {
            return method.invoke(target, arguments);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static String bytes(byte[] value) {
        return "bytes:" + HexFormat.of().formatHex(value);
    }

    private static boolean table(String sql, String name) {
        return Pattern.compile("\\b" + name + "\\b").matcher(sql).find();
    }
}
