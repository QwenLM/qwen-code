package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SimpleDriverDataSource;

import javax.sql.DataSource;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The row budget of the ledger's cross-table reads: the run state of an
 * occurrence is one exact point lookup per run, never a walk of the whole
 * extension-record mirror (Q3-45).
 */
class AutomationLedgerStoreTest {
    private static final String TENANT = "tenant-budget";
    private static final String SESSION = "session-budget";
    private static final String SCHEDULE = "asch_0123456789abcdef0123456789abcdef";

    private JdbcTemplate jdbc;
    private Map<String, Long> extensionRecordRows = new TreeMap<>();

    private Connection counting(Connection target) {
        return (Connection) Proxy.newProxyInstance(
                AutomationLedgerStoreTest.class.getClassLoader(),
                new Class<?>[] {Connection.class },
                (proxy, method, args) -> {
                    if ("prepareStatement".equals(method.getName())
                            && args != null && args.length > 0
                            && args[0] instanceof String sql) {
                        PreparedStatement statement = (PreparedStatement)
                                invoke(method, target, args);
                        return (PreparedStatement) Proxy.newProxyInstance(
                                AutomationLedgerStoreTest.class
                                        .getClassLoader(),
                                new Class<?>[] {PreparedStatement.class },
                                (stProxy, stMethod, stArgs) -> {
                                    if ("executeQuery".equals(stMethod
                                            .getName())) {
                                        ResultSet rs = (ResultSet)
                                                invoke(stMethod, statement,
                                                        stArgs);
                                        return countingResult(sql, rs);
                                    }
                                    return invoke(stMethod, statement,
                                            stArgs);
                                });
                    }
                    return invoke(method, target, args);
                });
    }

    private ResultSet countingResult(String sql, ResultSet rs) {
        if (!sql.contains("ma_session_record")) {
            return rs;
        }
        long[] count = {0 };
        boolean[] finalized = {false };
        return (ResultSet) Proxy.newProxyInstance(
                AutomationLedgerStoreTest.class.getClassLoader(),
                new Class<?>[] {ResultSet.class }, (proxy, method, args) -> {
                    if ("next".equals(method.getName())) {
                        boolean more = (Boolean) invoke(method, rs, args);
                        if (!more && !finalized[0]) {
                            finalized[0] = true;
                            extensionRecordRows.merge(sql, count[0],
                                    Long::sum);
                        }
                        if (more) {
                            count[0] += 1;
                        }
                        return more;
                    }
                    if ("close".equals(method.getName()) && !finalized[0]) {
                        finalized[0] = true;
                        extensionRecordRows.merge(sql, count[0], Long::sum);
                    }
                    return invoke(method, rs, args);
                });
    }

    private static Object invoke(java.lang.reflect.Method method,
            Object target, Object[] args) {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException error) {
            throw new RuntimeException(error.getCause());
        } catch (IllegalAccessException error) {
            throw new RuntimeException(error);
        }
    }

    private SimpleDriverDataSource raw() {
        SimpleDriverDataSource data = new SimpleDriverDataSource();
        data.setDriverClass(org.h2.Driver.class);
        data.setUrl("jdbc:h2:mem:automation-ledger-budget-"
                + java.util.UUID.randomUUID() + ";MODE=MySQL;"
                + "DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        data.setUsername("sa");
        data.setPassword("");
        return data;
    }

    @BeforeEach
    void openDataSource() {
        SimpleDriverDataSource raw = raw();
        this.jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate((DataSource) Proxy.newProxyInstance(
                AutomationLedgerStoreTest.class.getClassLoader(),
                new Class<?>[] {DataSource.class }, (proxy, method, args) -> {
                    Object result = invoke(method, raw, args);
                    if (result instanceof Connection connection) {
                        return counting(connection);
                    }
                    return result;
                }));
        extensionRecordRows = new TreeMap<>();
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(raw);
    }

    private void seedOccurrence(String outcome, String runId, long createdAt) {
        jdbc.update("INSERT INTO ma_schedule_occurrence (tenant_id,schedule_id,occurrence_key,run_id,session_id,slot,trigger_kind,outcome,reason,definition_revision,fence,attempts,next_retry_at,last_error,gmt_create,gmt_modified) VALUES"
                        + " (?, ?, ?, ?, ?, NULL, 'scheduled', ?, NULL, 1, 0,"
                        + " 0, 0, NULL, ?, ?)",
                TENANT, SCHEDULE, "schedule:2026-06-01T10:00:00Z", runId,
                SESSION, outcome, createdAt, createdAt);
    }

    private void seedForeignRecords(int count) {
        for (int index = 0; index < count; index += 1) {
            jdbc.update("INSERT INTO ma_session_record"
                            + " (session_scope_key, tenant_id, workspace_id, session_id, domain, record_id, record_key, revision, task_state, record_resource_id, gmt_create) VALUES ('scope-" + index + "', 't', 'w',"
                            + " 's', 'schedule', 'asch_" + index + "',"
                            + " 'rk-" + index + "', 1, 'completed', 'res', ?)",
                    System.nanoTime() + index);
        }
    }

    private long extensionRecordReads() {
        return extensionRecordRows.values().stream().mapToLong(Long::valueOf)
                .sum();
    }

    @Test
    void anActiveCountReadsOnlyTheRowsItNames() {
        seedOccurrence("fired", "arun_budget", 1000L);
        AutomationLedgerStore store = new AutomationLedgerStore(jdbc);
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(extensionRecordReads()).isZero();
        extensionRecordRows.clear();
        seedForeignRecords(2_000);
        // The same count over a mirror table two thousand rows deeper: the
        // record side's read must stay the one named row, not the table.
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(extensionRecordReads()).isZero();
        extensionRecordRows.clear();
        // A committed run record answers its own terminal state — read
        // once, even with the table still deep.
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, tenant_id, workspace_id, session_id, domain, record_id, record_key, revision, task_state, record_resource_id, gmt_create) VALUES (?, ?, 'w', ?, 'automation_run',"
                        + " 'arun_budget', ?, 1, 'completed', 'res', 42)",
                ManagedSessionStore.sessionScopeKey(TENANT, SESSION), TENANT,
                SESSION, ManagedExtensionProjection.recordKey(SESSION,
                        "automation_run", "arun_budget"));
        assertThat(store.countActive(TENANT, SCHEDULE)).isZero();
        assertThat(extensionRecordReads()).isEqualTo(1);
    }

    @Test
    void blockingRunsWalkOnlyTheirOwnRows() {
        seedOccurrence("fired", "arun_older", 1000L);
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, tenant_id, workspace_id, session_id, domain, record_id, record_key, revision, task_state, record_resource_id, gmt_create) VALUES (?, ?, 'w', ?, 'automation_run',"
                        + " 'arun_older', ?, 1, 'completed', 'res', 42)",
                ManagedSessionStore.sessionScopeKey(TENANT, SESSION), TENANT,
                SESSION, ManagedExtensionProjection.recordKey(SESSION,
                        "automation_run", "arun_older"));
        jdbc.update("INSERT INTO ma_schedule_occurrence (tenant_id,schedule_id,occurrence_key,run_id,session_id,slot,trigger_kind,outcome,reason,definition_revision,fence,attempts,next_retry_at,last_error,gmt_create,gmt_modified) VALUES"
                        + " (?, ?, ?, ?, ?, NULL, 'scheduled', 'fired', NULL,"
                        + " 1, 0, 0, 0, NULL, ?, ?)",
                TENANT, SCHEDULE, "schedule:2026-06-01T10:01:00Z",
                "arun_newer", SESSION, 2000L, 2000L);
        seedForeignRecords(2_000);
        AutomationLedgerStore store = new AutomationLedgerStore(jdbc);
        // The terminal-committed run drops out of the blocking list, and
        // the record side answered exactly one named row — the older run's
        // own — not the whole mirror table.
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 5))
                .extracting(view -> view.occurrence().runId())
                .containsExactly("arun_newer");
        assertThat(extensionRecordReads()).isEqualTo(1);
    }
}
