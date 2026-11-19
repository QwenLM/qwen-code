package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.session.UserMessagePolicy;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.OccurrenceRow;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.OccurrenceView;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleCursor;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore.PendingChild;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.mysql.cj.conf.PropertyKey;
import com.mysql.cj.jdbc.JdbcConnection;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/** Synthetic, single-connection warm-cache comparison; not a production capacity measurement. */
@EnabledIfSystemProperty(named = "sqlperf.enabled", matches = "true")
class ManagedSqlPerformanceMySqlIT {
    private static final String TENANT = "sqlperf-tenant";
    private static final String OTHER = "sqlperf-other";
    private static final long NOW = 1_700_000_000_000L;
    private static final int WARMUPS = 3;
    private static final int BATCH = 250;
    private static final List<String> TURN_SESSIONS = List.of("turn-a", "turn-b");
    private static final String OCCURRENCE_INSERT = "INSERT INTO ma_schedule_occurrence"
            + " (tenant_id, schedule_id, occurrence_key, run_id, session_id, slot, trigger_kind,"
            + " outcome, reason, definition_revision, fence, attempts, next_retry_at, last_error, gmt_create, gmt_modified)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    private static final String MIRROR_INSERT = "INSERT INTO ma_session_record"
            + " (session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, record_id,"
            + " revision, record_resource_id, task_kind, task_state, gmt_create)"
            + " VALUES (?, ?, ?, 'workspace', 'ledger', 'automation_run', ?, 1, ?, 'automation_run', ?, ?)";
    private static final String EVENT_INSERT = "INSERT INTO ma_public_event"
            + " (tenant_id, session_id, sequence_id, event_id, turn_id, event_type, data_json,"
            + " is_terminal, gmt_create, stream_kind, stream_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'SESSION', X'')";
    private static final String OPERATION_INSERT = "INSERT INTO ma_operation"
            + " (operation_key, scope_key, session_scope_key, tenant_id, session_id, operation_id,"
            + " operation_kind, target_kind, target_key, request_digest, request_json, state, phase,"
            + " failure_code, gmt_create, gmt_modified)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, 'SESSION', ?, 'digest', '{}', ?, ?, ?, ?, ?)";

    private final ObjectMapper json = new ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    private JdbcTemplate admin;
    private String ownedSchema;
    private long threadId;
    private long sqlTextLimit;
    private long callDeadline;
    private String group;

    @Test
    void compareProductionReadsOnDeterministicHistory() throws Exception {
        String variant = System.getProperty("sqlperf.variant", "");
        assertThat(variant).as("sqlperf.variant").isIn("baseline", "optimized");
        group = System.getProperty("sqlperf.group", "core");
        assertThat(group).isIn("core", "discovery", "all");
        int measured = Integer.parseInt(System.getProperty("sqlperf.samples", "15"));
        assertThat(measured).as("sqlperf.samples").isGreaterThanOrEqualTo(15);
        List<Integer> sizes = Arrays.stream(System.getProperty("sqlperf.sizes", "1000,10000,100000").split(","))
                .map(String::trim).map(Integer::parseInt).toList();
        assertThat(sizes).isNotEmpty().doesNotHaveDuplicates().allMatch(size -> List.of(1000, 10000, 100000).contains(size));
        String filename = System.getProperty("sqlperf.output", "");
        // A local test-runner option, never an uploaded path; CREATE_NEW also refuses existing symlinks.
        assertThat(filename).as("sqlperf.output: a new JSON filename, not a path")
                .matches("[A-Za-z0-9][A-Za-z0-9_-]{0,100}\\.json");
        Path target = VerificationFixtures.moduleRoot().resolve("verification/target");
        Path output = target.resolve(filename);
        assertThat(Files.exists(output)).as("report must not overwrite an earlier run").isFalse();
        ObjectNode report = json.createObjectNode().put("variant", variant).put("group", group)
                .put("cache", "warm-cache").put("warmups", WARMUPS).put("measuredSamplesPerCase", measured)
                .put("percentileMethod", "nearest-rank").put("perStatementTimeoutSeconds", 5)
                .put("logicalCallBudgetMs", 5000)
                .put("truncatedSqlTextPolicy", "retain verified statement counters; explicitly omit EXPLAIN for truncated SQL")
                .put("scope", "synthetic JDBC reads only; not online performance, concurrency or end-to-end latency")
                .put("historyValidation", "per-thread COUNT_STAR and SUM_ROWS_EXAMINED deltas equal captured history")
                .put("sizeMeaning", "terminal occurrences per schedule; deltas per turn session; unrelated lifecycle operations")
                .put("planDeduplication", "one actual SQL_TEXT per DIGEST per size, explained after all timed calls");
        report.set("sizes", json.valueToTree(sizes));
        var datasets = report.putArray("datasets");
        for (int size : sizes) {
            try (var database = new IsolatedManagedSchemaMySqlTestDatabase();
                    Connection business = database.source().getConnection();
                    Connection observer = database.source().getConnection()) {
                assertThat(business.unwrap(JdbcConnection.class).getPropertySet()
                        .getBooleanProperty(PropertyKey.useServerPrepStmts).getValue())
                        .as("useServerPrepStmts=false is required for executable SQL_TEXT").isFalse();
                var source = new SingleConnectionDataSource(business, true);
                JdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(source) {
                    @Override
                    public <T> T query(String sql, PreparedStatementSetter setter, ResultSetExtractor<T> extractor) {
                        if (callDeadline != 0 && System.nanoTime() > callDeadline) {
                            throw new IllegalStateException("Logical read exceeded the 5-second benchmark budget");
                        }
                        return super.query(sql, setter, extractor);
                    }
                };
                jdbc.setQueryTimeout(5);
                admin = new JdbcTemplate(new SingleConnectionDataSource(observer, true));
                ownedSchema = business.getCatalog();
                assertThat(observer.getCatalog()).isEqualTo(ownedSchema);
                ManagedSchema.initialize(source);
                assertThat(business.getAutoCommit()).as("seed and observer must see the same committed dataset").isTrue();
                String serverVersion = admin.queryForObject("SELECT VERSION()", String.class);
                if (report.has("serverVersion")) {
                    assertThat(serverVersion).isEqualTo(report.path("serverVersion").asText());
                }
                report.put("serverVersion", serverVersion);
                Long connectionId = jdbc.queryForObject("SELECT CONNECTION_ID()", Long.class);
                threadId = admin.queryForObject("SELECT THREAD_ID FROM performance_schema.threads"
                        + " WHERE PROCESSLIST_ID = ?", Long.class, connectionId);
                sqlTextLimit = admin.queryForObject("SELECT @@performance_schema_max_sql_text_length", Long.class);
                requireInstrumentation();
                var dataset = datasets.addObject().put("size", size).put("businessThreadId", threadId)
                        .put("sqlTextLimitBytes", sqlTextLimit)
                        .put("historyCapacity", admin.queryForObject(
                                "SELECT @@performance_schema_events_statements_history_long_size", Long.class));
                long seedStart = System.nanoTime();
                business.setAutoCommit(false);
                try {
                    seed(jdbc, "discovery".equals(group) ? 0 : size);
                    if (!"core".equals(group)) {
                        seedDiscovery(jdbc, size);
                    }
                    business.commit();
                } catch (Exception | Error failure) {
                    business.rollback();
                    throw failure;
                } finally {
                    business.setAutoCommit(true);
                }
                dataset.put("seedMs", (System.nanoTime() - seedStart) / 1_000_000.0);
                dataset.put("discoverySizeMeaning", "size/8 shared sessions and workspaces, four messages and schedules each; size/4 normal and debt relay candidates each")
                        .put("discoveryPlanDistribution", "dense queues and both relay arms restored before the existing per-digest EXPLAIN pass");
                jdbc.execute("ANALYZE TABLE ma_schedule_occurrence, ma_session_record, ma_public_event, ma_turn, ma_operation, ma_session,"
                        + " ma_user_message_queue, ma_user_message, ma_workspace, ma_workspace_access, ma_schedule");
                var counts = dataset.putObject("seededRows");
                for (String table : List.of("ma_schedule_occurrence", "ma_session_record", "ma_public_event", "ma_turn", "ma_operation", "ma_session",
                        "ma_user_message_queue", "ma_user_message", "ma_workspace", "ma_workspace_access", "ma_schedule")) {
                    counts.put(table, admin.queryForObject("SELECT COUNT(*) FROM " + table, Long.class));
                }
                ManagedAgentStore store = VerificationFixtures.managedAgentStore(jdbc, json,
                        Clock.fixed(Instant.ofEpochMilli(NOW), ZoneOffset.UTC), ignored -> {},
                        new JdbcManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties(), new SdkHarnessRules());
                JdbcAutomationLedgerStore ledger = new JdbcAutomationLedgerStore(jdbc);
                Map<String, StatementEvent> shapes = new LinkedHashMap<>();
                var cases = dataset.putArray("cases");
                cases.add(measure("countActive/history-and-active", () -> ledger.countActive(TENANT, "active"), 5, measured, shapes));
                cases.add(measure("countActive/terminal-history", () -> ledger.countActive(TENANT, "terminal"), 0, measured, shapes));
                cases.add(measure("countActive/empty", () -> ledger.countActive(TENANT, "empty"), 0, measured, shapes));
                var blockers = expectedBlockers();
                cases.add(measure("findBlockingRuns/history-and-active", () -> ledger.findBlockingRuns(TENANT, "active", 10), blockers, measured, shapes));
                cases.add(measure("findBlockingRuns/limited", () -> ledger.findBlockingRuns(TENANT, "active", 2), blockers.subList(0, 2), measured, shapes));
                cases.add(measure("findBlockingRuns/terminal-history", () -> ledger.findBlockingRuns(TENANT, "terminal", 10), List.of(), measured, shapes));
                cases.add(measure("findBlockingRuns/empty", () -> ledger.findBlockingRuns(TENANT, "empty", 10), List.of(), measured, shapes));
                var turns = expectedTurns();
                cases.add(measure("findLatestTurns/deltas", () -> store.findLatestTurns(TENANT, List.of("turn-a", "turn-b", "turn-none")), turns, measured, shapes));
                cases.add(measure("findLatestTurns/empty", () -> store.findLatestTurns(TENANT, List.of("turn-none")), Map.of(), measured, shapes));
                // Load through the public API outside the environment-only timing interval.
                var loadedTurns = new TreeMap<>(store.findLatestTurns(TENANT, TURN_SESSIONS));
                assertThat(loadedTurns).isEqualTo(turns);
                cases.add(measure("findLatestEnvironmentEvents/deltas", () -> store.findLatestEnvironmentEvents(TENANT, loadedTurns), expectedEnvironments(), measured, shapes));
                var noEnvironment = new TreeMap<>(store.findLatestTurns(TENANT, List.of("turn-dry")));
                assertThat(noEnvironment).hasSize(1);
                cases.add(measure("findLatestEnvironmentEvents/empty", () -> store.findLatestEnvironmentEvents(TENANT, noEnvironment), Map.of(), measured, shapes));
                Map<String, WebShellLifecycleOperation> lifecycle = Map.of(
                        "close", new WebShellLifecycleOperation("close-b", "close", "pending", null),
                        "delete", new WebShellLifecycleOperation("delete-failed", "delete", "failed", "fixture"),
                        "archive", new WebShellLifecycleOperation("archive-blocked", "archive", "recovery_blocked", null));
                cases.add(measure("findLatestLifecycleOperations/window", () -> store.findLatestLifecycleOperations(TENANT,
                        List.of("close", "delete", "archive", "idle")), lifecycle, measured, shapes));
                cases.add(measure("findLatestLifecycleOperations/empty", () -> store.findLatestLifecycleOperations(TENANT,
                        List.of("idle")), Map.of(), measured, shapes));
                var messages = new JdbcManagedUserMessageStore(jdbc, json, new RequestDigests(), mock(UserMessagePolicy.class));
                List<Map<String, String>> ready = new ArrayList<>();
                for (int i = 0; i < size / 8; i++) {
                    if (i % 10 >= 5) {
                        ready.add(Map.of("tenant", TENANT, "session", discoverySession(i)));
                    }
                }
                cases.add(measure("A08/readySessions/multiple-queued-per-session", messages::readySessions,
                        ready.subList(0, 32), measured, shapes));
                jdbc.update("UPDATE ma_user_message SET state = 'consumed' WHERE tenant_id = ?"
                        + " AND session_id LIKE 'queue-ready-%' AND state = 'queued'", TENANT);
                var sparseReady = ready.subList(ready.size() - 3, ready.size());
                for (var candidate : sparseReady) {
                    jdbc.update("UPDATE ma_user_message SET state = 'queued' WHERE tenant_id = ?"
                            + " AND session_id = ? AND sequence_number = 1", TENANT, candidate.get("session"));
                }
                cases.add(measure("A08/readySessions/sparse-queued-history", messages::readySessions,
                        sparseReady, measured, shapes));
                jdbc.update("UPDATE ma_user_message SET state = 'consumed' WHERE tenant_id = ?"
                        + " AND session_id LIKE 'queue-ready-%' AND state = 'queued'", TENANT);
                cases.add(measure("A08/readySessions/empty-with-ineligible-queues", messages::readySessions,
                        List.of(), measured, shapes));
                jdbc.update("UPDATE ma_user_message SET state = 'queued' WHERE tenant_id = ?"
                        + " AND session_id LIKE 'queue-ready-%' AND sequence_number < 4", TENANT);

                var relay = new JdbcChildResultRelayStore(jdbc);
                var normal = expectedRelay(size, false);
                var debts = expectedRelay(size, true);
                cases.add(measure("A09/pending/many-normal-and-debt", () -> relay.findPendingChildren("sqlperf-worker", NOW, 32),
                        normal.subList(0, 32), measured, shapes));
                jdbc.update("UPDATE ma_operation SET available_at = ? WHERE tenant_id = ?"
                        + " AND operation_kind = 'CHILD_SESSION_START' AND operation_id LIKE 'relay-start-%'", NOW + 10_000, TENANT);
                var sparseNormal = normal.subList(normal.size() - 3, normal.size());
                for (var candidate : sparseNormal) {
                    jdbc.update("UPDATE ma_operation SET available_at = 0 WHERE scope_key = ?"
                            + " AND operation_kind = 'CHILD_SESSION_START' AND operation_id = ?",
                            ManagedSessionStore.sessionScopeKey(TENANT, "ledger"), candidate.childRunId());
                }
                List<PendingChild> mixed = new ArrayList<>(sparseNormal);
                mixed.addAll(debts.subList(0, 29));
                cases.add(measure("A09/pending/sparse-normal-many-debt", () -> relay.findPendingChildren("sqlperf-worker", NOW, 32),
                        mixed, measured, shapes));
                jdbc.update("UPDATE ma_operation SET available_at = ? WHERE tenant_id = ?"
                        + " AND operation_kind = 'CHILD_SESSION_START' AND operation_id LIKE 'relay-start-%'", NOW + 10_000, TENANT);
                cases.add(measure("A09/pending/debt-only", () -> relay.findPendingChildren("sqlperf-worker", NOW, 32),
                        debts.subList(0, 32), measured, shapes));
                jdbc.update("UPDATE ma_operation SET available_at = ? WHERE tenant_id = ?"
                        + " AND operation_kind = 'CHILD_SESSION_CLOSE' AND operation_id LIKE 'relay-debt-%'", NOW + 10_000, TENANT);
                cases.add(measure("A09/pending/empty-with-ineligible-history", () -> relay.findPendingChildren("sqlperf-worker", NOW, 32),
                        List.of(), measured, shapes));
                jdbc.update("UPDATE ma_operation SET available_at = CASE WHEN RIGHT(operation_id, 1) = '1' THEN ? ELSE 0 END"
                        + " WHERE tenant_id = ? AND ((operation_kind = 'CHILD_SESSION_START' AND operation_id LIKE 'relay-start-%')"
                        + " OR (operation_kind = 'CHILD_SESSION_CLOSE' AND operation_id LIKE 'relay-debt-%'))", NOW + 10_000, TENANT);

                List<ScheduleRow> readable = new ArrayList<>();
                for (int i = 15; i >= 0; i--) {
                    if (i % 8 != 3) {
                        for (int slot = 3; slot >= 0; slot--) {
                            readable.add(discoverySchedule(i, slot));
                        }
                    }
                }
                cases.add(measure("A10/listReadableSchedules/auth-before-first-page", () -> {
                    var page = ledger.listReadableSchedules(TENANT, "sqlperf-reader", null, 32);
                    return Map.of("rows", page.rows(), "hasMore", page.hasMore());
                }, Map.of("rows", readable.subList(0, 32), "hasMore", true), measured, shapes));
                var last = readable.get(31);
                var cursor = new ScheduleCursor(last.createdAt(), last.scheduleId());
                cases.add(measure("A10/listReadableSchedules/auth-before-next-page", () -> {
                    var page = ledger.listReadableSchedules(TENANT, "sqlperf-reader", cursor, 32);
                    return Map.of("rows", page.rows(), "hasMore", page.hasMore());
                }, Map.of("rows", readable.subList(32, readable.size()), "hasMore", false), measured, shapes));
                cases.add(measure("A10/listReadableSchedules/no-grants", () -> {
                    var page = ledger.listReadableSchedules(TENANT, "sqlperf-no-grants", null, 32);
                    return Map.of("rows", page.rows(), "hasMore", page.hasMore());
                }, Map.of("rows", List.of(), "hasMore", false), measured, shapes));
                requireInstrumentation();
                var plans = dataset.putArray("plans");
                for (StatementEvent event : shapes.values()) {
                    var plan = plans.addObject().put("digest", event.digest()).put("exampleEventId", event.eventId())
                            .put("sqlText", event.sql());
                    if (event.truncated()) {
                        plan.put("explainStatus", "not_run_sql_text_truncated");
                    } else {
                        plan.set("rawPlan", json.valueToTree(admin.query("EXPLAIN ANALYZE " + event.sql(),
                                (row, index) -> row.getString(1))));
                        plan.put("explainStatus", "complete");
                    }
                }
                dataset.put("historyComplete", true);
            }
        }
        Files.createDirectories(target);
        try (var stream = Files.newOutputStream(output, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            json.writerWithDefaultPrettyPrinter().writeValue(stream, report);
        }
        List<String> failures = new ArrayList<>();
        for (var dataset : datasets) {
            for (var result : dataset.path("cases")) {
                if ("failed".equals(result.path("status").asText())) {
                    failures.add(dataset.path("size").asInt() + "/" + result.path("name").asText());
                }
            }
        }
        assertThat(failures).as("failed benchmark cases; details retained in " + output).isEmpty();
    }

    private void requireInstrumentation() {
        assertThat(admin.queryForObject("SELECT @@performance_schema", Integer.class)).isEqualTo(1);
        assertThat(sqlTextLimit).as("performance_schema_max_sql_text_length must be at least 131072").isGreaterThanOrEqualTo(131072);
        assertThat(admin.queryForObject("SELECT COUNT(*) FROM performance_schema.setup_consumers WHERE NAME IN"
                + " ('global_instrumentation', 'thread_instrumentation', 'events_statements_current',"
                + " 'events_statements_history_long', 'statements_digest') AND ENABLED = 'YES'", Integer.class))
                .as("required performance_schema consumers must already be enabled").isEqualTo(5);
        assertThat(admin.queryForObject("SELECT COUNT(*) FROM performance_schema.setup_instruments"
                + " WHERE NAME LIKE 'statement/sql/%' AND ENABLED <> 'YES'", Integer.class))
                .as("statement instruments must be enabled").isZero();
        assertThat(admin.queryForObject("SELECT COUNT(*) FROM performance_schema.threads"
                + " WHERE THREAD_ID = ? AND INSTRUMENTED = 'YES' AND HISTORY = 'YES'", Integer.class, threadId))
                .as("business thread must retain statement history").isEqualTo(1);
        assertThat(admin.queryForObject("SELECT @@performance_schema_events_statements_history_long_size", Long.class))
                .as("history_long must have storage").isPositive();
    }

    private Boundary boundary() {
        // The last response can arrive before MySQL finishes publishing its statement instrumentation.
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (admin.queryForObject("SELECT COUNT(*) FROM performance_schema.events_statements_current"
                + " WHERE THREAD_ID = ? AND END_EVENT_ID IS NULL", Integer.class, threadId) != 0) {
            assertThat(System.nanoTime()).as("business statement instrumentation did not finish").isLessThan(deadline);
        }
        return admin.queryForObject("SELECT"
                + " (SELECT COALESCE(MAX(EVENT_ID), 0) FROM performance_schema.events_statements_history_long WHERE THREAD_ID = ?) AS event_id,"
                + " COALESCE(SUM(COUNT_STAR), 0) AS statements, COALESCE(SUM(SUM_ROWS_EXAMINED), 0) AS examined"
                + " FROM performance_schema.events_statements_summary_by_thread_by_event_name WHERE THREAD_ID = ?",
                (row, index) -> new Boundary(row.getLong("event_id"), row.getLong("statements"), row.getLong("examined")), threadId, threadId);
    }

    private ObjectNode measure(String name, Supplier<?> call, Object expected, int measured,
            Map<String, StatementEvent> shapes) throws Exception {
        if ((name.startsWith("A") && "core".equals(group))
                || (!name.startsWith("A") && "discovery".equals(group))) {
            return json.createObjectNode().put("name", name).put("status", "not_selected");
        }
        long started = System.nanoTime();
        try {
            return measureCase(name, call, expected, measured, shapes);
        } catch (RuntimeException | AssertionError error) {
            Throwable cause = error;
            while (cause.getCause() != null) {
                cause = cause.getCause();
            }
            String detail = String.valueOf(cause.getMessage());
            return json.createObjectNode().put("name", name).put("status", "failed")
                    .put("errorClass", cause.getClass().getName())
                    .put("error", detail.substring(0, Math.min(1024, detail.length())))
                    .put("elapsedBeforeFailureMs", (System.nanoTime() - started) / 1_000_000.0);
        }
    }

    private ObjectNode measureCase(String name, Supplier<?> call, Object expected, int measured,
            Map<String, StatementEvent> shapes) throws Exception {
        ObjectNode result = json.createObjectNode().put("name", name).put("status", "passed").put("sampleCount", measured);
        var samples = result.putArray("rawSamples");
        List<Double> timings = new ArrayList<>();
        long totalSql = 0;
        long totalExamined = 0;
        String expectedFingerprint = DigestUtils.sha256Hex(json.writeValueAsBytes(expected));
        for (int iteration = 0; iteration < WARMUPS + measured; iteration++) {
            Boundary before = boundary();
            long start = System.nanoTime();
            Object value;
            callDeadline = start + 5_000_000_000L;
            try {
                value = call.get();
            } finally {
                callDeadline = 0;
            }
            long elapsed = System.nanoTime() - start;
            Boundary after = boundary();
            var events = admin.query("SELECT EVENT_ID, SQL_TEXT, DIGEST, ROWS_EXAMINED, MYSQL_ERRNO,"
                            + " CURRENT_SCHEMA, OCTET_LENGTH(SQL_TEXT) AS text_bytes"
                            + " FROM performance_schema.events_statements_history_long"
                            + " WHERE THREAD_ID = ? AND EVENT_ID > ? AND EVENT_ID <= ? ORDER BY EVENT_ID",
                    (row, index) -> {
                        String sql = row.getString("SQL_TEXT");
                        assertThat(sql).as("SQL_TEXT missing: statement capture is incomplete").isNotBlank();
                        boolean truncated = row.getLong("text_bytes") >= sqlTextLimit - 4;
                        assertThat(sql.stripLeading().startsWith("SELECT ") || sql.stripLeading().startsWith("WITH RECURSIVE "))
                                .as("only captured SELECT queries from the owned connection can be explained").isTrue();
                        assertThat(row.getString("CURRENT_SCHEMA")).as("only statements from the owned database").isEqualTo(ownedSchema);
                        assertThat(row.getInt("MYSQL_ERRNO")).isZero();
                        String digest = row.getString("DIGEST");
                        assertThat(digest).as("statement DIGEST missing").isNotBlank();
                        long examined = row.getLong("ROWS_EXAMINED");
                        assertThat(row.wasNull()).as("ROWS_EXAMINED must be reported, not substituted with zero").isFalse();
                        return new StatementEvent(row.getLong("EVENT_ID"), digest, sql, examined, truncated);
                    }, threadId, before.eventId(), after.eventId());
            long examined = events.stream().mapToLong(StatementEvent::rowsExamined).sum();
            long sqlCount = after.statements() - before.statements();
            assertThat(sqlCount).as(name + ": every case must execute SQL").isPositive();
            assertThat((long) events.size()).as(name + ": history lost/evicted statements or counters reset").isEqualTo(sqlCount);
            assertThat(examined).as(name + ": history ROWS_EXAMINED must match the thread summary delta")
                    .isEqualTo(after.rowsExamined() - before.rowsExamined());
            assertThat(value).as(name).isEqualTo(expected);
            String fingerprint = DigestUtils.sha256Hex(json.writeValueAsBytes(value));
            assertThat(fingerprint).isEqualTo(expectedFingerprint);
            int count = value instanceof Map<?, ?> map ? map.size()
                    : value instanceof Collection<?> collection ? collection.size() : ((Number) value).intValue();
            boolean warmup = iteration < WARMUPS;
            double ms = elapsed / 1_000_000.0;
            var sample = samples.addObject().put("iteration", iteration + 1).put("warmup", warmup)
                    .put("elapsedMs", ms).put("sqlCount", sqlCount).put("rowsExamined", examined)
                    .put("fromEventIdExclusive", before.eventId()).put("throughEventId", after.eventId())
                    .put("resultCount", count).put("resultFingerprint", fingerprint);
            var statements = sample.putArray("statements");
            for (StatementEvent event : events) {
                statements.addObject().put("eventId", event.eventId()).put("digest", event.digest()).put("rowsExamined", event.rowsExamined());
                if (!warmup) {
                    shapes.putIfAbsent(event.digest(), event);
                }
            }
            if (!warmup) {
                timings.add(ms);
                totalSql += sqlCount;
                totalExamined += examined;
            }
            result.put("resultCount", count).put("resultFingerprint", fingerprint);
        }
        timings.sort(Double::compareTo);
        result.put("p50Ms", timings.get((int) Math.ceil(measured * 0.50) - 1))
                .put("p95Ms", timings.get((int) Math.ceil(measured * 0.95) - 1))
                .put("sqlCountTotal", totalSql).put("sqlCountPerCall", (double) totalSql / measured)
                .put("rowsExaminedTotal", totalExamined).put("rowsExaminedPerCall", (double) totalExamined / measured);
        result.set("logicalResult", json.valueToTree(expected));
        return result;
    }

    private void seed(JdbcTemplate jdbc, int size) {
        boolean terminalProjection = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE()"
                + " AND table_name = 'ma_schedule_occurrence' AND column_name = 'is_run_terminal'", Integer.class) == 1;
        String historyInsert = terminalProjection
                ? OCCURRENCE_INSERT.replace("gmt_modified)", "gmt_modified, is_run_terminal)").replace("?, ?)", "?, ?, 1)")
                : OCCURRENCE_INSERT;
        var sessions = new ArrayList<Object[]>();
        for (String session : List.of("ledger", "turn-a", "turn-b", "turn-none", "turn-dry", "close", "delete", "archive", "idle", "history")) {
            String status = switch (session) {
                case "close", "history" -> "CLOSING";
                case "delete" -> "DELETING";
                case "archive" -> "ARCHIVING";
                default -> "ACTIVE";
            };
            sessions.add(session(TENANT, session, status, "PUBLIC"));
        }
        sessions.add(session(OTHER, "close", "CLOSING", "CONTROL"));
        jdbc.batchUpdate("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, session_kind,"
                + " tenant_key, session_key, session_scope_key, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'qwen-code', ?, ?, ?, ?, ?, ?, ?)", sessions);
        jdbc.batchUpdate("INSERT INTO ma_schedule (tenant_id, schedule_id, session_id, workspace_id, actor_id,"
                + " record_revision, definition_revision, definition_digest, goal, cron, timezone, session_mode,"
                + " overlap, catch_up, is_enabled, state, armed_at, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'ledger', 'workspace', 'actor', 1, 1, ?, 'synthetic', '* * * * *', 'UTC',"
                + " 'reuse', 'skip', 'skip', 1, 'live', ?, ?, ?)",
                List.of(new Object[] {TENANT, "active", "a".repeat(64), NOW, NOW, NOW},
                        new Object[] {TENANT, "terminal", "b".repeat(64), NOW, NOW, NOW},
                        new Object[] {TENANT, "empty", "c".repeat(64), NOW, NOW, NOW}));
        var turns = new ArrayList<Object[]>();
        var events = new ArrayList<Object[]>();
        for (String session : TURN_SESSIONS) {
            for (String suffix : List.of("old", "new", "orphan")) {
                long created = NOW + ("new".equals(suffix) ? 1 : 100);
                turns.add(new Object[] {TENANT, session, session + "-" + suffix, session + "-prompt-" + suffix, created, created});
            }
            events.add(event(session, 1, "old", "turn.accepted", "{}"));
            events.add(event(session, 2, "old", "environment.ready", "{}"));
            events.add(event(session, 3, "new", "turn.accepted", "{}"));
            events.add(event(session, 4, "new", "environment.provisioning", "{}"));
            events.add(event(session, 5, "new", "environment.failed", "{}"));
            events.add(event(session, 6, "new", "environment.ready", "{\"marker\":\"ready\"}"));
            events.add(event(session, 7, "old", "environment.failed", "{}"));
        }
        turns.add(new Object[] {TENANT, "turn-dry", "turn-dry-new", "turn-dry-prompt", NOW + 1, NOW + 1});
        events.add(event("turn-dry", 1, "new", "turn.accepted", "{}"));
        jdbc.batchUpdate("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                + " status, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, '[]', 'digest', 'RUNNING', ?, ?)", turns);
        jdbc.batchUpdate(EVENT_INSERT, events);
        jdbc.batchUpdate("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, last_sequence, gmt_modified)"
                + " VALUES (?, ?, 'SESSION', X'', ?, ?)", List.of(
                        new Object[] {TENANT, "turn-a", size + 7, NOW}, new Object[] {TENANT, "turn-b", size + 7, NOW},
                        new Object[] {TENANT, "turn-dry", 1, NOW}, new Object[] {TENANT, "turn-none", 0, NOW}));
        for (int from = 0; from < size; from += BATCH) {
            var occurrences = new ArrayList<Object[]>();
            var mirrors = new ArrayList<Object[]>();
            var deltas = new ArrayList<Object[]>();
            var operations = new ArrayList<Object[]>();
            for (int i = from; i < Math.min(size, from + BATCH); i++) {
                for (String schedule : List.of("active", "terminal")) {
                    var occurrence = occurrence(schedule, "history-" + i, "fired", NOW + i);
                    occurrences.add(occurrenceValues(occurrence));
                    mirrors.add(mirror(occurrence, List.of("completed", "failed", "cancelled").get(i % 3)));
                }
                for (String session : TURN_SESSIONS) {
                    deltas.add(event(session, i + 8L, "new", "item.output_text.delta", "{\"delta\":\"synthetic\"}"));
                }
                operations.add(operation(i % 2 == 0 ? TENANT : OTHER, i % 2 == 0 ? "history" : "close",
                        "history-" + i, "CLOSE", "COMPLETED", NOW + i, NOW + i));
            }
            jdbc.batchUpdate(historyInsert, occurrences);
            jdbc.batchUpdate(MIRROR_INSERT, mirrors);
            jdbc.batchUpdate(EVENT_INSERT, deltas);
            jdbc.batchUpdate(OPERATION_INSERT, operations);
        }
        var occurrences = new ArrayList<Object[]>();
        var mirrors = new ArrayList<Object[]>();
        for (OccurrenceView blocker : expectedBlockers()) {
            occurrences.add(occurrenceValues(blocker.occurrence()));
            if (!"active-b".equals(blocker.occurrence().occurrenceKey())) {
                mirrors.add(mirror(blocker.occurrence(), blocker.taskState()));
            }
        }
        occurrences.add(occurrenceValues(occurrence("active", "firing", "firing", NOW + 1_000_001)));
        occurrences.add(occurrenceValues(occurrence("active", "skipped", "skipped", NOW + 1_000_002)));
        jdbc.batchUpdate(OCCURRENCE_INSERT, occurrences);
        jdbc.batchUpdate(MIRROR_INSERT, mirrors);
        jdbc.batchUpdate(OPERATION_INSERT, List.of(
                operation(TENANT, "close", "close-terminal", "CLOSE", "FAILED", NOW + 900, NOW + 900),
                operation(TENANT, "close", "close-early", "CLOSE", "PENDING", NOW + 90, NOW + 100),
                operation(TENANT, "close", "close-z", "CLOSE", "RUNNING", NOW + 50, NOW + 200),
                operation(TENANT, "close", "close-a", "CLOSE", "RECOVERY_BLOCKED", NOW + 80, NOW + 200),
                operation(TENANT, "close", "close-b", "CLOSE", "PENDING", NOW + 80, NOW + 200),
                operation(TENANT, "close", "wrong-kind", "DELETE", "RUNNING", NOW + 1000, NOW + 1000),
                operation(TENANT, "delete", "delete-old", "DELETE", "COMPLETED", NOW + 10, NOW + 10),
                operation(TENANT, "delete", "delete-failed", "DELETE", "FAILED", NOW + 20, NOW + 20),
                operation(TENANT, "archive", "archive-blocked", "ARCHIVE", "RECOVERY_BLOCKED", NOW + 30, NOW + 30),
                operation(TENANT, "idle", "idle-close", "CLOSE", "PENDING", NOW + 40, NOW + 40)));
    }

    private void seedDiscovery(JdbcTemplate jdbc, int size) {
        int sessionCount = size / 8;
        byte[] reader = ManagedWorkspaceRegistry.actorKey(TENANT, "sqlperf-reader");
        byte[] creator = ManagedWorkspaceRegistry.actorKey(TENANT, "sqlperf-creator");
        for (int from = 0; from < sessionCount; from += BATCH) {
            var sessions = new ArrayList<Object[]>();
            var bindings = new ArrayList<Object[]>();
            var queues = new ArrayList<Object[]>();
            var messages = new ArrayList<Object[]>();
            var turns = new ArrayList<Object[]>();
            var workspaces = new ArrayList<Object[]>();
            var schedules = new ArrayList<Object[]>();
            for (int i = from; i < Math.min(sessionCount, from + BATCH); i++) {
                String session = discoverySession(i);
                String workspace = fixtureId("discovery-ws-", i);
                int mode = i % 10;
                sessions.add(session(TENANT, session, mode == 4 ? "CLOSING" : "ACTIVE", "PUBLIC"));
                bindings.add(new Object[] {workspace, creator, i % 8 == 3 || i % 8 == 4,
                        i % 8 == 4 ? reader : creator, TENANT, session});
                queues.add(new Object[] {TENANT, session, mode == 0, NOW + i});
                for (int sequence = 1; sequence <= 4; sequence++) {
                    String state = sequence < 4 ? "queued" : switch (mode) {
                        case 2 -> "claimed";
                        case 3 -> "recovery_blocked";
                        default -> "consumed";
                    };
                    messages.add(new Object[] {TENANT, session, "message-" + sequence, sequence, state});
                }
                if (mode == 1) {
                    turns.add(new Object[] {TENANT, session, session + "-turn", session + "-prompt",
                            List.of("ACCEPTED", "RUNNING", "CANCELLING", "RECOVERY_BLOCKED").get((i / 10) % 4), NOW, NOW});
                }
                boolean root = i % 8 == 0;
                int parent = i % 8 == 7 ? i - 1 : i - i % 8;
                workspaces.add(new Object[] {TENANT, workspace, root ? "ROOT" : "CHILD_GIT",
                        root ? null : fixtureId("discovery-ws-", parent), root ? null : discoverySession(parent),
                        root ? null : fixtureId("workspace-run-", i), root ? null : fixtureId("child-workspace-", i),
                        root ? null : "READY", NOW, NOW});
                for (int slot = 0; slot < 4; slot++) {
                    var schedule = discoverySchedule(i, slot);
                    schedules.add(new Object[] {TENANT, schedule.scheduleId(), session, workspace,
                            schedule.definitionDigest(), NOW, schedule.createdAt(), schedule.updatedAt()});
                }
            }
            jdbc.batchUpdate("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, session_kind,"
                    + " tenant_key, session_key, session_scope_key, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, 'qwen-code', ?, ?, ?, ?, ?, ?, ?)", sessions);
            jdbc.batchUpdate("UPDATE ma_session SET workspace_id = ?, workspace_generation = 1,"
                    + " workspace_storage_id = 'sqlperf-storage', cwd_relative = '', context_config_ref = 'config',"
                    + " context_revision = 1, workspace_config_ref = 'config', workspace_policy_ref = 'policy',"
                    + " creator_actor_key = ?, owner_only = ?, owner_actor_key = ? WHERE tenant_id = ? AND session_id = ?", bindings);
            jdbc.batchUpdate("INSERT INTO ma_user_message_queue (tenant_id, session_id, is_paused, last_dispatch_at, next_sequence)"
                    + " VALUES (?, ?, ?, ?, 5)", queues);
            jdbc.batchUpdate("INSERT INTO ma_user_message (tenant_id, session_id, message_id, sequence_number, revision,"
                    + " actor_id, input_json, state, context_revision) VALUES (?, ?, ?, ?, 1, 'sqlperf-creator', '[]', ?, 1)", messages);
            if (!turns.isEmpty()) {
                jdbc.batchUpdate("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                        + " status, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, '[]', 'digest', ?, ?, ?)", turns);
            }
            jdbc.batchUpdate("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                    + " config_ref, policy_ref, state, workspace_kind, parent_workspace_id, parent_session_id, child_run_id,"
                    + " child_workspace_id, child_state, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, 1, 'sqlperf-storage', 'synthetic', 'config', 'policy', 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?)", workspaces);
            jdbc.batchUpdate("INSERT INTO ma_schedule (tenant_id, schedule_id, session_id, workspace_id, actor_id,"
                    + " record_revision, definition_revision, definition_digest, goal, cron, timezone, session_mode,"
                    + " overlap, catch_up, is_enabled, state, armed_at, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, ?, 'sqlperf-creator', 1, 1, ?, 'synthetic', '* * * * *', 'UTC',"
                    + " 'reuse', 'skip', 'skip', 1, 'live', ?, ?, ?)", schedules);
        }
        jdbc.batchUpdate("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, ?, ?, 'READER')",
                List.of(new Object[] {TENANT, fixtureId("discovery-ws-", 0), reader},
                        new Object[] {TENANT, fixtureId("discovery-ws-", 8), reader},
                        new Object[] {TENANT, fixtureId("discovery-ws-", (sessionCount - 1) / 8 * 8), creator}));
        seedRelayDiscovery(jdbc, size);
    }

    private void seedRelayDiscovery(JdbcTemplate jdbc, int size) {
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, "ledger");
        for (int from = 0; from < size / 4; from += BATCH) {
            var records = new ArrayList<Object[]>();
            var operations = new ArrayList<Object[]>();
            for (int i = from; i < Math.min(size / 4, from + BATCH); i++) {
                int mode = i % 10;
                String run = fixtureId("relay-start-", i);
                records.add(new Object[] {scope, ManagedExtensionProjection.recordKey("ledger", "child_run", run), TENANT,
                        run, run + "-resource", mode == 3 ? "shell" : i % 2 == 0 ? "child_agent" : "workflow",
                        List.of("planned", "accepting", "unknown", "accepted", "consumed", "cancelled").get(i % 6), NOW + i});
                String terminal = List.of("done", "orphaned", "unknown").get((i / 10) % 3);
                operations.add(relayOperation("CHILD_SESSION_START", run, mode == 0 ? terminal : "binding", mode, NOW + i));
                if (mode == 4) {
                    operations.add(relayOperation("CHILD_SESSION_CLOSE", run, "done", mode, NOW + i));
                }
                String debt = fixtureId("relay-debt-", i);
                operations.add(relayOperation("CHILD_SESSION_CLOSE", debt,
                        mode == 0 || mode == 3 ? terminal : "close_debt", mode, NOW - size + i));
                if (i % 2 == 0) {
                    records.add(new Object[] {scope, ManagedExtensionProjection.recordKey("ledger", "child_run", debt), TENANT,
                            debt, debt + "-resource", "workflow", i % 4 == 0 ? "consumed" : null, NOW + i});
                }
            }
            jdbc.batchUpdate("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id, session_id,"
                    + " domain, record_id, revision, record_resource_id, task_kind, task_state, delivery_state, gmt_create)"
                    + " VALUES (?, ?, ?, 'workspace', 'ledger', 'child_run', ?, 1, ?, ?, 'pending', ?, ?)", records);
            jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, tenant_id, session_id, operation_id,"
                    + " operation_kind, target_kind, target_key, request_digest, request_json, state, phase, claim_owner, claim_until,"
                    + " available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'ledger', ?, ?, 'CHILD_RUN', ?, 'digest', '{}', ?, ?, ?, ?, ?, ?, ?)", operations);
        }
    }

    private static Object[] relayOperation(String kind, String run, String state, int mode, long created) {
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, "ledger");
        String target = ManagedSchemaKeys.key(run);
        Long until = mode == 6 ? null : mode == 2 || mode % 2 == 1 ? NOW + 30_000 : NOW - 1;
        return new Object[] {ManagedSchemaKeys.operationKey(OperationKind.valueOf(kind), scope, target, run), scope, scope,
                TENANT, run, kind, target, state, "CHILD_SESSION_CLOSE".equals(kind) ? "CLOSING" : "BINDING",
                mode == 2 ? "sqlperf-other-worker" : "sqlperf-worker", until, mode == 1 ? NOW + 10_000 : 0, created, created};
    }

    private static List<PendingChild> expectedRelay(int size, boolean debt) {
        List<PendingChild> result = new ArrayList<>();
        for (int i = 0; i < size / 4; i++) {
            if (i % 10 >= (debt ? 4 : 5)) {
                String run = fixtureId(debt ? "relay-debt-" : "relay-start-", i);
                boolean mirror = !debt || i % 2 == 0;
                String delivery = debt ? i % 4 == 0 ? "consumed" : "accepted"
                        : List.of("planned", "accepting", "unknown", "accepted", "consumed", "cancelled").get(i % 6);
                result.add(new PendingChild(TENANT, "ledger", run, mirror ? 1 : 0, delivery, mirror ? run + "-resource" : null));
            }
        }
        return result;
    }

    private static ScheduleRow discoverySchedule(int session, int slot) {
        return new ScheduleRow(TENANT, fixtureId("discovery-schedule-", session * 4 + slot), discoverySession(session),
                fixtureId("discovery-ws-", session), "sqlperf-creator", 1, 1, "d".repeat(64), "synthetic", "* * * * *", "UTC",
                "reuse", "skip", "skip", null, true, "live", null, NOW, null, null, null, 0, NOW + session, NOW + session,
                null, null, null, 0, 0, null);
    }

    private static String discoverySession(int index) {
        return fixtureId(index % 10 >= 5 ? "queue-ready-" : "queue-blocked-", index);
    }

    private static String fixtureId(String prefix, int index) {
        return String.format(Locale.ROOT, "%s%06d", prefix, index);
    }

    private static Object[] session(String tenant, String session, String status, String kind) {
        return new Object[] {tenant, session, status, kind, ManagedSchemaKeys.key(tenant), ManagedSchemaKeys.key(session),
                ManagedSessionStore.sessionScopeKey(tenant, session), NOW, NOW};
    }

    private static OccurrenceRow occurrence(String schedule, String key, String outcome, long created) {
        return new OccurrenceRow(TENANT, schedule, key, AutomationLedgerStore.automationRunId(schedule, key), "ledger", null,
                "scheduled", outcome, null, 1, 0, 0, 0, null, created, created);
    }

    private static Object[] occurrenceValues(OccurrenceRow row) {
        return new Object[] {row.tenantId(), row.scheduleId(), row.occurrenceKey(), row.runId(), row.sessionId(), row.slot(),
                row.trigger(), row.outcome(), row.reason(), row.definitionRevision(), row.fence(), row.attempts(),
                row.nextRetryAt(), row.lastError(), row.createdAt(), row.updatedAt()};
    }

    private static Object[] mirror(OccurrenceRow row, String state) {
        return new Object[] {ManagedSessionStore.sessionScopeKey(TENANT, "ledger"),
                ManagedExtensionProjection.recordKey("ledger", "automation_run", row.runId()), TENANT,
                row.runId(), row.runId() + "-resource", state, row.createdAt()};
    }

    private static Object[] event(String session, long sequence, String turn, String type, String data) {
        return new Object[] {TENANT, session, sequence, session + "-event-" + sequence, session + "-" + turn, type, data, NOW};
    }

    private static Object[] operation(String tenant, String session, String id, String kind, String state, long created, long modified) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String target = ManagedSchemaKeys.key(session);
        return new Object[] {ManagedSchemaKeys.operationKey(OperationKind.valueOf(kind), scope, target, id), scope, scope,
                tenant, session, id, kind, target, state, state, "FAILED".equals(state) ? "fixture" : null, created, modified};
    }

    private static List<OccurrenceView> expectedBlockers() {
        return List.of(new OccurrenceView(occurrence("active", "active-a", "fired", NOW + 1_000_000), "pending"),
                new OccurrenceView(occurrence("active", "active-b", "fired", NOW + 1_000_000), null),
                new OccurrenceView(occurrence("active", "active-c", "fired", NOW + 1_000_000), "running"),
                new OccurrenceView(occurrence("active", "active-d", "fired", NOW + 1_000_000), null));
    }

    private static Map<String, TurnSummary> expectedTurns() {
        Map<String, TurnSummary> turns = new TreeMap<>();
        for (String session : TURN_SESSIONS) {
            turns.put(session, new TurnSummary(session, session + "-new", "RUNNING", NOW + 1, null, null));
        }
        return turns;
    }

    private static Map<String, EventRecord> expectedEnvironments() {
        Map<String, EventRecord> events = new TreeMap<>();
        for (String session : TURN_SESSIONS) {
            events.put(session, new EventRecord(TENANT, session, 6, session + "-event-6", session + "-new",
                    "environment.ready", Map.of("marker", "ready"), false, null, NOW, 1, 1, null, null));
        }
        return events;
    }

    private record Boundary(long eventId, long statements, long rowsExamined) { }

    private record StatementEvent(long eventId, String digest, String sql, long rowsExamined, boolean truncated) { }
}
