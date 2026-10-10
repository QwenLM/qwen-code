package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SimpleDriverDataSource;

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
                new Class<?>[] { Connection.class },
                (proxy, method, args) -> {
                    if ("prepareStatement".equals(method.getName())
                            && args != null && args.length > 0
                            && args[0] instanceof String sql) {
                        PreparedStatement statement = (PreparedStatement)
                                invoke(method, target, args);
                        return (PreparedStatement) Proxy.newProxyInstance(
                                AutomationLedgerStoreTest.class
                                        .getClassLoader(),
                                new Class<?>[] { PreparedStatement.class },
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
        if (!sql.contains("qwen_managed_session_extension_record")) {
            return rs;
        }
        long[] count = { 0 };
        boolean[] finalized = { false };
        return (ResultSet) Proxy.newProxyInstance(
                AutomationLedgerStoreTest.class.getClassLoader(),
                new Class<?>[] { ResultSet.class }, (proxy, method, args) -> {
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
        this.jdbc = new JdbcTemplate((DataSource) Proxy.newProxyInstance(
                AutomationLedgerStoreTest.class.getClassLoader(),
                new Class<?>[] { DataSource.class }, (proxy, method, args) -> {
                    Object result = invoke(method, raw, args);
                    if (result instanceof Connection connection) {
                        return counting(connection);
                    }
                    return result;
                }));
        extensionRecordRows = new TreeMap<>();
        jdbc.execute("CREATE TABLE qwen_managed_automation_occurrence ("
                + " tenant_id VARCHAR(128) NOT NULL,"
                + " schedule_id VARCHAR(128) NOT NULL,"
                + " occurrence_key VARCHAR(512) NOT NULL,"
                + " run_id VARCHAR(128) NOT NULL,"
                + " session_id VARCHAR(128) NOT NULL,"
                + " slot BIGINT NULL,"
                + " trigger_kind VARCHAR(32) NOT NULL,"
                + " outcome VARCHAR(32) NOT NULL,"
                + " reason VARCHAR(128) NULL,"
                + " definition_revision BIGINT NOT NULL,"
                + " fence BIGINT NOT NULL,"
                + " attempts INT NOT NULL,"
                + " next_retry_at BIGINT NOT NULL,"
                + " last_error VARCHAR(2048) NULL,"
                + " created_at BIGINT NOT NULL,"
                + " updated_at BIGINT NOT NULL)");
        jdbc.execute("CREATE TABLE qwen_managed_session_extension_record ("
                + " session_scope_key VARCHAR(80) NOT NULL,"
                + " tenant_id VARCHAR(128) NOT NULL,"
                + " workspace_id VARCHAR(512) NOT NULL,"
                + " session_id VARCHAR(128) NOT NULL,"
                + " domain VARCHAR(64) NOT NULL,"
                + " record_id VARCHAR(512) NOT NULL,"
                + " record_key VARCHAR(80) NOT NULL,"
                + " revision BIGINT NOT NULL,"
                + " task_state VARCHAR(64) NULL,"
                + " record_resource_id VARCHAR(128) NOT NULL,"
                + " created_at BIGINT NOT NULL,"
                + " PRIMARY KEY (session_scope_key, record_key))");
    }

    private void seedOccurrence(String outcome, String runId, long createdAt) {
        jdbc.update("INSERT INTO qwen_managed_automation_occurrence VALUES"
                        + " (?, ?, ?, ?, ?, NULL, 'scheduled', ?, NULL, 1, 0,"
                        + " 0, 0, NULL, ?, ?)",
                TENANT, SCHEDULE, "schedule:2026-06-01T10:00:00Z", runId,
                SESSION, outcome, createdAt, createdAt);
    }

    private void seedForeignRecords(int count) {
        for (int index = 0; index < count; index += 1) {
            jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                            + " VALUES ('scope-" + index + "', 't', 'w',"
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
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " VALUES (?, ?, 'w', ?, 'automation_run',"
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
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " VALUES (?, ?, 'w', ?, 'automation_run',"
                        + " 'arun_older', ?, 1, 'completed', 'res', 42)",
                ManagedSessionStore.sessionScopeKey(TENANT, SESSION), TENANT,
                SESSION, ManagedExtensionProjection.recordKey(SESSION,
                        "automation_run", "arun_older"));
        jdbc.update("INSERT INTO qwen_managed_automation_occurrence VALUES"
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
