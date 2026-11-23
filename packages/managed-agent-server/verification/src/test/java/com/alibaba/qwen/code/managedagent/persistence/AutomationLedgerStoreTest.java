package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.OccurrenceRow;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleRow;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
    private ConsolidatedStoreFixture fixture;
    private Map<String, Long> extensionRecordRows = new TreeMap<>();
    private final List<String> queries = new ArrayList<>();

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
                                        queries.add(sql);
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

    @AfterEach
    void closeDataSource() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @BeforeEach
    void openDataSource() {
        fixture = ConsolidatedStoreFixture.open("automation");
        DataSource raw = fixture.source();
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
        queries.clear();
    }

    private void seedOccurrence(String outcome, String runId, long createdAt) {
        seedOccurrence("schedule:2026-06-01T10:00:00Z", outcome, runId, createdAt);
    }

    private void seedOccurrence(String occurrenceKey, String outcome, String runId, long createdAt) {
        jdbc.update("INSERT INTO ma_schedule_occurrence (tenant_id,schedule_id,occurrence_key,run_id,session_id,slot,trigger_kind,outcome,reason,definition_revision,fence,attempts,next_retry_at,last_error,gmt_create,gmt_modified) VALUES"
                        + " (?, ?, ?, ?, ?, NULL, 'scheduled', ?, NULL, 1, 0,"
                        + " 0, 0, NULL, ?, ?)",
                TENANT, SCHEDULE, occurrenceKey, runId,
                SESSION, outcome, createdAt, createdAt);
    }

    private void seedRunState(String tenantId, String runId, String state) {
        seedRunState(tenantId, SESSION, runId, state);
    }

    private void seedRunState(String tenantId, String sessionId, String runId, String state) {
        jdbc.update("INSERT INTO ma_session_record"
                        + " (tenant_id, workspace_id, session_id, domain, record_id,"
                        + " record_key, revision, task_kind, task_state, record_resource_id, gmt_create)"
                        + " VALUES (?, 'w', ?, 'automation_run', ?, ?, 1, 'automation_run', ?, 'res', 42)", tenantId, sessionId, runId,
                ManagedExtensionProjection.recordKey(sessionId, "automation_run", runId), state);
        // Direct fixtures must carry the same derived flag as a journal projection.
        jdbc.update("UPDATE ma_schedule_occurrence SET is_run_terminal = ?"
                        + " WHERE tenant_id = ? AND session_id = ? AND run_id = ?",
                state != null && Set.of("completed", "failed", "cancelled").contains(state) ? 1 : 0,
                tenantId, sessionId, runId);
    }

    private void seedForeignRecords(int count) {
        for (int index = 0; index < count; index += 1) {
            jdbc.update("INSERT INTO ma_session_record"
                            + " (tenant_id, workspace_id, session_id, domain, record_id, record_key, revision, task_state, record_resource_id, gmt_create) VALUES ('t', 'w',"
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
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(extensionRecordReads()).isZero();
        extensionRecordRows.clear();
        seedForeignRecords(2_000);
        // The same count over a mirror table two thousand rows deeper: the
        // record side's read must stay the one named row, not the table.
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(extensionRecordReads()).isZero();
        extensionRecordRows.clear();
        seedRunState(TENANT, "arun_budget", "completed");
        queries.clear();
        assertThat(store.countActive(TENANT, SCHEDULE)).isZero();
        assertThat(extensionRecordReads()).isZero();
        assertThat(queries).singleElement().satisfies(sql -> assertThat(sql)
                .contains("SELECT COUNT(*)", "is_run_terminal = 0")
                .doesNotContain("ma_session_record"));
    }

    @Test
    void blockingRunsWalkOnlyTheirOwnRows() {
        seedOccurrence("fired", "arun_older", 1000L);
        seedRunState(TENANT, "arun_older", "completed");
        jdbc.update("INSERT INTO ma_schedule_occurrence (tenant_id,schedule_id,occurrence_key,run_id,session_id,slot,trigger_kind,outcome,reason,definition_revision,fence,attempts,next_retry_at,last_error,gmt_create,gmt_modified) VALUES"
                        + " (?, ?, ?, ?, ?, NULL, 'scheduled', 'fired', NULL,"
                        + " 1, 0, 0, 0, NULL, ?, ?)",
                TENANT, SCHEDULE, "schedule:2026-06-01T10:01:00Z",
                "arun_newer", SESSION, 2000L, 2000L);
        seedForeignRecords(2_000);
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        // The terminal run never enters the candidate page or its mirror lookup.
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 5))
                .extracting(view -> view.occurrence().runId())
                .containsExactly("arun_newer");
        assertThat(extensionRecordReads()).isZero();
    }

    @Test
    void blockingRunsSkipTerminalHistoryAndKeepOldestFirstAcrossTies() {
        for (int index = 769; index >= 0; index--) {
            String key = "occurrence-%04d".formatted(index);
            String run = "arun_" + index;
            seedOccurrence(key, "fired", run, index < 512 ? 1000L : 2000L);
            if (index != 768) {
                seedRunState(TENANT, run, index == 300 ? "running" : index == 520 ? "pending" : "completed");
            }
        }
        seedRunState("other-tenant", "arun_768", "completed");
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 2))
                .extracting(view -> view.occurrence().runId())
                .containsExactly("arun_300", "arun_520");
        assertThat(queries.stream().filter(sql -> sql.contains("FROM ma_schedule_occurrence")))
                .hasSize(1);
        assertThat(extensionRecordReads()).isEqualTo(2);
        queries.clear();
        extensionRecordRows.clear();

        var blocking = store.findBlockingRuns(TENANT, SCHEDULE, 10);
        assertThat(blocking).extracting(view -> view.occurrence().runId())
                .containsExactly("arun_300", "arun_520", "arun_768");
        assertThat(blocking).extracting(view -> view.taskState())
                .containsExactly("running", "pending", null);
        var pages = queries.stream().filter(sql -> sql.contains("FROM ma_schedule_occurrence")).toList();
        assertThat(pages).hasSize(1).allSatisfy(sql -> assertThat(sql)
                .contains("is_run_terminal = 0", "ORDER BY o.gmt_create, o.occurrence_key LIMIT ?")
                .doesNotContain("OFFSET"));
        assertThat(extensionRecordReads()).isEqualTo(2);
        queries.clear();
        extensionRecordRows.clear();
        jdbc.update("DELETE FROM ma_schedule_occurrence WHERE tenant_id = ? AND schedule_id = ?"
                + " AND occurrence_key > ?", TENANT, SCHEDULE, "occurrence-0767");
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 10))
                .extracting(view -> view.occurrence().runId()).containsExactly("arun_300", "arun_520");
        assertThat(queries.stream().filter(sql -> sql.contains("FROM ma_schedule_occurrence"))).hasSize(1);
        assertThat(queries.stream().filter(sql -> sql.contains("FROM ma_session_record"))).hasSize(1);
        assertThat(extensionRecordReads()).isEqualTo(2);
        queries.clear();
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(2);
        assertThat(queries).hasSize(1).noneSatisfy(sql -> assertThat(sql).contains("ma_session_record"));
    }

    @Test
    void taskStateBatchesReturnEveryRunAndKeepActiveCountsExact() {
        Set<Integer> terminal = Set.of(0, 255, 256, 511, 512);
        for (int index = 0; index < 520; index++) {
            String run = "arun_" + index;
            seedOccurrence("occurrence-%04d".formatted(index), "fired", run, 1000L);
            if (index != 519) {
                seedRunState(TENANT, run, terminal.contains(index) ? "completed" : "running");
            }
        }
        seedOccurrence("firing", "firing", "arun_firing", 1000L);
        seedRunState("other-tenant", "arun_519", "completed");
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(516);
        assertThat(extensionRecordReads()).isZero();
        assertThat(queries).noneSatisfy(sql -> assertThat(sql).contains("ma_session_record"));
        queries.clear();
        var blocking = store.findBlockingRuns(TENANT, SCHEDULE, 600);
        assertThat(blocking).hasSize(515);
        var pages = queries.stream().filter(sql -> sql.contains("FROM ma_schedule_occurrence")).toList();
        assertThat(pages).hasSize(3);
        assertThat(pages.subList(1, pages.size())).allSatisfy(sql -> assertThat(sql)
                .contains("AND (o.gmt_create > ? OR (o.gmt_create = ? AND o.occurrence_key > ?))")
                .doesNotContain("OFFSET"));
        assertThat(queries.stream().filter(sql -> sql.contains("FROM ma_session_record"))
                .map(sql -> sql.chars().filter(value -> value == '?').count()))
                .containsExactly(768L, 768L, 9L);
        queries.clear();
        extensionRecordRows.clear();

        var page = store.listOccurrences(TENANT, SCHEDULE, null, 600);
        assertThat(page.hasMore()).isFalse();
        assertThat(page.rows()).hasSize(521).allSatisfy(view -> {
            String run = view.occurrence().runId();
            if ("arun_firing".equals(run) || "arun_519".equals(run)) {
                assertThat(view.taskState()).isNull();
            } else {
                int index = Integer.parseInt(run.substring("arun_".length()));
                assertThat(view.taskState()).isEqualTo(terminal.contains(index) ? "completed" : "running");
            }
        });
        assertThat(extensionRecordReads()).isEqualTo(519);
        assertThat(queries.stream().filter(sql -> sql.contains("FROM ma_session_record"))
                .map(sql -> sql.chars().filter(value -> value == '?').count()))
                .containsExactly(768L, 768L, 27L);
    }

    private ScheduleRow heldSchedule(JdbcAutomationLedgerStore store) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'agent', 0, 0)", TENANT, SESSION);
        jdbc.update("INSERT INTO ma_schedule (tenant_id, schedule_id, session_id, workspace_id, actor_id,"
                        + " record_revision, definition_revision, definition_digest, goal, cron, timezone,"
                        + " session_mode, overlap, catch_up, is_enabled, state, armed_at, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, 'w', 'actor', 1, 1, 'digest', 'Goal', '* * * * *', 'UTC',"
                        + " 'default', 'allow', 'none', TRUE, 'live', 0, 0, 0)", TENANT, SCHEDULE, SESSION);
        store.claim(TENANT, SCHEDULE, "owner", 10_000, 1);
        return store.findSchedule(TENANT, SCHEDULE).orElseThrow();
    }

    private int terminalFlag(String key) {
        return jdbc.queryForObject("SELECT is_run_terminal FROM ma_schedule_occurrence"
                + " WHERE tenant_id = ? AND schedule_id = ? AND occurrence_key = ?",
                Integer.class, TENANT, SCHEDULE, key);
    }

    @Test
    void terminalMirrorBeforeOccurrencePreservesFiringFenceAndFirstDecision() {
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        ScheduleRow schedule = heldSchedule(store);
        OccurrenceRow row = OccurrenceRow.decision(schedule, "first", null,
                "manual", "firing", null, schedule.fence(), 100);
        seedRunState(TENANT, row.runId(), "completed");
        store.recordOccurrence(row, "owner");
        assertThat(terminalFlag("first")).isEqualTo(1);
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(store.deferOccurrence(TENANT, SCHEDULE, "first", 1, 500,
                "retry", "owner", schedule.fence(), 110)).isTrue();
        assertThat(store.repinOccurrence(TENANT, SCHEDULE, "first", 2,
                "owner", schedule.fence(), 120)).isTrue();
        assertThat(terminalFlag("first")).isEqualTo(1);
        assertThat(store.settleOccurrence(TENANT, SCHEDULE, "first", "fired", null,
                "stale", schedule.fence(), 130)).isFalse();
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        tx.executeWithoutResult(status -> {
            assertThat(store.settleOccurrence(TENANT, SCHEDULE, "first", "fired", null,
                    "owner", schedule.fence(), 140)).isTrue();
            status.setRollbackOnly();
        });
        assertThat(store.findOccurrence(TENANT, SCHEDULE, "first").orElseThrow().outcome()).isEqualTo("firing");
        assertThat(store.settleOccurrence(TENANT, SCHEDULE, "first", "fired", null,
                "final detail", "owner", schedule.fence(), 150)).isTrue();
        var settled = store.findOccurrence(TENANT, SCHEDULE, "first").orElseThrow();
        assertThat(store.countActive(TENANT, SCHEDULE)).isZero();
        assertThat(store.recordOccurrence(row, "owner").orElseThrow()).isEqualTo(settled);
        assertThat(store.settleOccurrence(TENANT, SCHEDULE, "first", "skipped", "late",
                "owner", schedule.fence(), 160)).isFalse();
        assertThat(store.findOccurrence(TENANT, SCHEDULE, "first").orElseThrow()).isEqualTo(settled);
        tx.executeWithoutResult(status -> {
            store.recordOccurrence(OccurrenceRow.decision(schedule, "rolled-back", null,
                    "manual", "fired", null, schedule.fence(), 170), "owner");
            status.setRollbackOnly();
        });
        assertThat(store.findOccurrence(TENANT, SCHEDULE, "rolled-back")).isEmpty();
    }

    @Test
    void missingAndNonTaskMirrorsStayActiveAndRunIdsAreSessionScoped() {
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        ScheduleRow schedule = heldSchedule(store);
        OccurrenceRow row = OccurrenceRow.decision(schedule, "non-task", null,
                "manual", "fired", null, schedule.fence(), 100);
        seedRunState(TENANT, row.runId(), "completed");
        jdbc.update("UPDATE ma_session_record SET task_kind = NULL, task_state = NULL WHERE tenant_id = ?", TENANT);
        store.recordOccurrence(row, "owner");
        assertThat(terminalFlag("non-task")).isZero();
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 10)).singleElement()
                .satisfies(view -> assertThat(view.taskState()).isNull());
        seedOccurrence("same-run-other-session", "fired", row.runId(), 200);
        jdbc.update("UPDATE ma_schedule_occurrence SET session_id = 'other-session'"
                + " WHERE tenant_id = ? AND occurrence_key = ?", TENANT, "same-run-other-session");
        seedRunState(TENANT, "other-session", row.runId(), "running");
        seedRunState("other-tenant", row.runId(), "completed");
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 10))
                .extracting(view -> view.taskState()).containsExactly(null, "running");
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(2);
    }

    @Test
    void retirementClearsOnlyTheDeletedMirrorsFlagsAndRollsBackWithDeletion() {
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        heldSchedule(store);
        seedOccurrence("fired", "arun_retiring", 100);
        seedRunState(TENANT, "arun_retiring", "failed");
        seedOccurrence("other-session", "fired", "arun_retiring", 200);
        jdbc.update("UPDATE ma_schedule_occurrence SET session_id = 'other-session'"
                + " WHERE tenant_id = ? AND occurrence_key = ?", TENANT, "other-session");
        seedRunState(TENANT, "other-session", "arun_retiring", "cancelled");
        jdbc.update("INSERT INTO ma_schedule_occurrence (tenant_id, schedule_id, occurrence_key, run_id,"
                        + " session_id, trigger_kind, outcome, definition_revision, fence, gmt_create, gmt_modified)"
                        + " VALUES ('other-tenant', ?, 'other-tenant', 'arun_retiring', ?, 'manual', 'fired', 1, 0, 100, 100)",
                SCHEDULE, SESSION);
        seedRunState("other-tenant", "arun_retiring", "completed");
        jdbc.update("UPDATE ma_session SET retired_at = 1 WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        tx.executeWithoutResult(status -> {
            assertThat(ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, TENANT, SESSION, 1)).isTrue();
            assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
            status.setRollbackOnly();
        });
        assertThat(store.countActive(TENANT, SCHEDULE)).isZero();
        tx.executeWithoutResult(status ->
                assertThat(ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, TENANT, SESSION, 1)).isTrue());
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(terminalFlag("other-session")).isEqualTo(1);
        assertThat(store.countActive("other-tenant", SCHEDULE)).isZero();
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 10)).singleElement()
                .satisfies(view -> assertThat(view.taskState()).isNull());
        seedRunState(TENANT, "arun_retiring", "failed");
        assertThat(store.countActive(TENANT, SCHEDULE)).isZero();
    }

    @Test
    void emptyTaskStateBatchesAndZeroBlockingLimitDoNotQueryMirrors() {
        JdbcAutomationLedgerStore store = new JdbcAutomationLedgerStore(jdbc);
        assertThat(store.findBlockingRuns(TENANT, SCHEDULE, 0)).isEmpty();
        assertThat(queries).isEmpty();
        assertThat(store.countActive(TENANT, SCHEDULE)).isZero();
        assertThat(store.listOccurrences(TENANT, SCHEDULE, null, 10).rows()).isEmpty();
        seedOccurrence("firing", "arun_firing", 1000L);
        assertThat(store.countActive(TENANT, SCHEDULE)).isEqualTo(1);
        assertThat(queries).noneSatisfy(sql -> assertThat(sql).contains("ma_session_record"));
    }
}
