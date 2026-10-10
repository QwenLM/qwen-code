package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Commits a growing Hook history through the Session store, as the Session
 * authority does, and counts the SQL statements that admitting one more
 * execution costs. Admission must not read the history it accumulated, so
 * the count of a late admission equals that of an early one.
 *
 * <p>Execution {@code i} is ordinal {@code i % 4} of occurrence
 * {@code i / 4}, and odd executions consume a once key, so two admissions
 * whose indexes agree modulo 4 run the same checks.
 */
final class HookAdmissionHistory {
    record Admission(int history, int selects, int statements, long nanos) {
    }

    private final AtomicInteger selects = new AtomicInteger();
    private final AtomicInteger statements = new AtomicInteger();
    private final Set<String> sql = ConcurrentHashMap.newKeySet();
    private final TransactionTemplate transactions;
    private final ExtensionRecordJournal journal;
    private final ObjectNode registration;
    private final ObjectNode template;
    private final String sessionId;
    private int executions;
    private String intruderOnceKey;

    HookAdmissionHistory(DataSource dataSource, String tenantId,
            String workspaceId, String sessionId) throws Exception {
        this.sessionId = sessionId;
        DataSource counted = new DelegatingDataSource(dataSource) {
            @Override
            public Connection getConnection() throws SQLException {
                return count(super.getConnection());
            }
        };
        JdbcTemplate jdbc = new JdbcTemplate(counted);
        transactions = new TransactionTemplate(
                new DataSourceTransactionManager(counted));
        journal = inTransaction(() -> new ExtensionRecordJournal(
                new ManagedSessionStore(jdbc), tenantId, workspaceId,
                sessionId).open());
        JsonNode templates = ManagedHookRecordContractTest.fixtures()
                .get("templates");
        byte[] data = "{}".getBytes(StandardCharsets.UTF_8);
        CommitResource resource = new CommitResource("hook-data", "hook-data",
                1, data.length, ExtensionRecordJournal.sha256(data),
                Base64.getEncoder().encodeToString(data));
        ObjectNode ref = JsonNodeFactory.instance.objectNode()
                .put("resourceId", resource.resourceId())
                .put("kind", resource.kind()).put("schemaVersion", 1)
                .put("byteLength", resource.byteLength())
                .put("digest", resource.digest());
        registration = templates.get("hook_registration").deepCopy();
        registration.set("catalogRef", ref.deepCopy());
        for (String state : List.of("admitted", "running", "settled")) {
            registration.withObject("/run").put("state", state);
            commit("register-" + state, "hook_registration", registration,
                    List.of(resource));
        }
        template = templates.get("hook_execution").deepCopy();
        template.set("planRef", ref.deepCopy());
        template.set("inputRef", ref.deepCopy());
    }

    /**
     * Settles a registration of another catalog, as a catalog replacement
     * does, and returns an execution body bound to it.
     */
    ObjectNode replaceCatalog(String registrationId, String catalogId) {
        ObjectNode replacement = registration.deepCopy();
        replacement.put("registrationId", registrationId).put("catalogId", catalogId);
        replacement.withObject("/run").put("effectId", registrationId);
        replacement.withObject("/run/definition").put("definitionId", catalogId);
        for (String state : List.of("admitted", "running", "settled")) {
            replacement.withObject("/run").put("state", state);
            commit(registrationId + "-" + state, "hook_registration", replacement,
                    List.of());
        }
        ObjectNode execution = execution(0);
        execution.put("registrationId", registrationId);
        execution.withObject("/run").set("definition",
                replacement.get("run").get("definition").deepCopy());
        return execution;
    }

    /** The execution body with history index {@code index}. */
    ObjectNode execution(int index) {
        String id = "execution-" + index;
        ObjectNode execution = template.deepCopy();
        execution.put("hookExecutionId", id)
                .put("occurrenceId", "occurrence-" + index / 4)
                .put("ordinal", index % 4);
        if (index % 2 == 1) {
            execution.put("onceKey", "once-" + index);
        } else {
            execution.putNull("onceKey");
        }
        execution.withObject("/run").put("effectId", id);
        return execution;
    }

    /**
     * Admits executions until the Session holds {@code total} of them, and
     * returns what admitting the last one cost.
     */
    Admission admitUntil(int total) {
        Admission last = null;
        while (executions < total) {
            int index = executions;
            selects.set(0);
            statements.set(0);
            long started = System.nanoTime();
            commit("execute-" + index, "hook_execution", execution(index),
                    List.of());
            last = new Admission(index, selects.get(), statements.get(),
                    System.nanoTime() - started);
            executions++;
        }
        return last;
    }

    /** Every distinct statement text the store has run for this history. */
    Set<String> sql() {
        return Set.copyOf(sql);
    }

    /** Commits a revision; a refusal leaves the history unchanged. */
    void commit(String commandId, String domain, JsonNode record,
            List<CommitResource> resources) {
        CommitTransactionRequest request = journal.requestDomain(commandId,
                domain, record, resources, 1_000);
        inTransaction(() -> journal.commit(request));
        journal.committed(request);
    }

    /**
     * Makes the next record insert collide with a row that consumes
     * {@code onceKey}, written in the same transaction after the store's
     * checks ran, as a concurrent writer that bypassed them would.
     */
    void interleaveOnceKey(String onceKey) {
        intruderOnceKey = onceKey;
    }

    private <T> T inTransaction(Supplier<T> operation) {
        return transactions.execute(status -> operation.get());
    }

    // Counts each statement text a connection prepares, or that a plain
    // statement it created executes.
    private Connection count(Connection connection) {
        return proxy(Connection.class, connection, (method, arguments) -> {
            if (method.equals("prepareStatement") || method.equals("prepareCall")) {
                record((String) arguments[0]);
                if (intruderOnceKey != null && ((String) arguments[0])
                        .startsWith("INSERT INTO qwen_managed_session_extension_record")) {
                    intrude(connection, intruderOnceKey);
                    intruderOnceKey = null;
                }
            }
        }, "createStatement");
    }

    private void intrude(Connection connection, String onceKey) {
        try (var insert = connection.prepareStatement("INSERT INTO"
                + " qwen_managed_session_extension_record (session_scope_key,"
                + " record_key, tenant_id, workspace_id, session_id, domain,"
                + " record_id, operation_hash, revision, record_resource_id,"
                + " created_at, hook_once_key_hash) SELECT session_scope_key, ?,"
                + " tenant_id, workspace_id, session_id, 'hook_execution',"
                + " 'intruder', ?, 1, record_resource_id, created_at, ? FROM"
                + " qwen_managed_session_extension_record WHERE session_id = ?"
                + " AND record_id = 'registration-1'")) {
            insert.setString(1, ExtensionRecordJournal.sha256("intruder"));
            insert.setString(2, ExtensionRecordJournal.sha256("intruder-command"));
            insert.setString(3, ExtensionRecordJournal.sha256(onceKey));
            insert.setString(4, sessionId);
            insert.executeUpdate();
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }

    private void record(String sql) {
        statements.incrementAndGet();
        this.sql.add(sql);
        if (sql.stripLeading().toUpperCase(Locale.ROOT).startsWith("SELECT")) {
            selects.incrementAndGet();
        }
    }

    private interface Observer {
        void observe(String method, Object[] arguments);
    }

    private <T> T proxy(Class<T> type, T target, Observer observer,
            String wrapStatements) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(),
                new Class<?>[] {type}, (proxy, method, arguments) -> {
                    observer.observe(method.getName(), arguments);
                    Object result;
                    try {
                        result = method.invoke(target, arguments);
                    } catch (InvocationTargetException error) {
                        throw error.getCause();
                    }
                    if (method.getName().equals(wrapStatements)) {
                        return proxy(Statement.class, (Statement) result,
                                (name, values) -> {
                                    if (name.startsWith("execute") && values != null
                                            && values.length > 0
                                            && values[0] instanceof String sql) {
                                        record(sql);
                                    }
                                }, null);
                    }
                    return result;
                }));
    }
}
