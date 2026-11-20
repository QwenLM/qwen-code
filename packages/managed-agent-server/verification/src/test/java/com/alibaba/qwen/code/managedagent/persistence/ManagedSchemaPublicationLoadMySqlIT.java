package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.InputStream;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Fixed worker/page budgets against ten times more terminal history on real MySQL. */
class ManagedSchemaPublicationLoadMySqlIT {
    private static final String TENANT = "publication-load-tenant";
    private static final String HEALTHY = "healthy";

    private record Query(String sql, Object[] arguments) {}

    private static final class ObservedJdbc extends ManagedSchemaJdbcTemplate {
        private final List<Query> queries = new ArrayList<>();

        ObservedJdbc(SingleConnectionDataSource source) {
            super(source);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper) {
            return query(sql, mapper, new Object[0]);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
            if (sql.startsWith("SELECT scope_key, tenant_id, session_id FROM ma_operation")
                    || sql.startsWith("SELECT scope_key, publication_id, tenant_id, session_id FROM ma_operation")
                    || sql.contains("AS needs_operation") || sql.contains("AS needs_ledger")
                    || sql.equals("SELECT MAX(id) FROM ma_output_capture")
                    || sql.equals("SELECT MAX(id) FROM ma_session")
                    || sql.startsWith("SELECT resource_key, byte_length,")) {
                queries.add(new Query(sql, arguments.clone()));
            }
            return super.query(sql, mapper, arguments);
        }
    }

    @Test
    void captureCollectionSkipsTenTimesMoreCompletedOperations() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            try (Connection connection = database.source().getConnection()) {
                var source = new SingleConnectionDataSource(connection, true);
                var jdbc = new ObservedJdbc(source);
                var manager = new DataSourceTransactionManager(source);
                var tx = new TransactionTemplate(manager);
                var properties = new ManagedAgentProperties();
                properties.getToolPublication().setGcEnabled(true);
                properties.getToolPublication().setDeletionGrace(java.time.Duration.ZERO);
                String sessionScope = ManagedSessionStore.sessionScopeKey(TENANT, HEALTHY);
                String scope = ManagedSchemaKeys.key("capture-scope");
                String publication = "capture";
                String operationId = "capture-gc-" + ManagedSchemaKeys.key(scope, publication);
                String operationKey = ManagedSchemaKeys.operationKey(OperationKind.CAPTURE_GC, scope,
                        ManagedSchemaKeys.key(publication), operationId);
                jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                                + " capture_bytes, producer_bytes, admission_bytes, producer_phase, is_write_evidence, is_accepted_complete)"
                                + " VALUES (?, ?, ?, 'workspace', ?, ?, ?, 'capture-id', '{}', ?, ?, 'FENCED',"
                                + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE)",
                        scope, ManagedSchemaKeys.key(TENANT), TENANT, HEALTHY, publication,
                        ManagedSchemaKeys.key("execution"), ManagedSchemaKeys.key("binding"), ManagedSchemaKeys.key("token"));
                tx.executeWithoutResult(status -> {
                    ToolPublicationRetentionStore.lockDeletion(jdbc, TENANT, HEALTHY);
                    ToolPublicationRetentionStore.retire(jdbc, TENANT, HEALTHY, "delete");
                });
                assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_key = ?",
                        String.class, operationKey)).isEqualTo("PENDING");
                ToolPublicationObjectStore unusedObjects = new ToolPublicationObjectStore() {
                    @Override
                    public InputStream openRange(String key, long offset, long length, Runnable guard) {
                        guard.run();
                        try (InputStream full = open(key)) {
                            byte[] bytes = full.readAllBytes();
                            return new java.io.ByteArrayInputStream(bytes, (int) offset, (int) length);
                        } catch (java.io.IOException error) {
                            throw new IllegalStateException(error);
                        }
                    }
                    @Override public void putIfAbsent(String key, byte[] bytes) { throw new AssertionError("No object write is expected"); }
                    @Override public java.io.InputStream open(String key) { throw new AssertionError("No object read is expected"); }
                    @Override public void validateConfiguration() { }
                };
                var collector = new ToolPublicationCollector(jdbc, manager,
                        new ToolPublicationRetentionStore(jdbc, manager), unusedObjects, properties);
                int previous = 0;
                long smaller = 0;
                for (int count : List.of(1_000, 10_000)) {
                    List<Object[]> history = new ArrayList<>();
                    for (int index = previous; index < count; index++) {
                        String id = "capture-history-" + index;
                        history.add(new Object[] {ManagedSchemaKeys.operationKey(OperationKind.CAPTURE_GC, scope,
                                ManagedSchemaKeys.key(id), id), sessionScope, scope, id, TENANT, HEALTHY,
                                ManagedSchemaKeys.key(id), ManagedSchemaKeys.key(id)});
                    }
                    jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id,"
                            + " operation_kind, tenant_id, session_id, target_kind, target_key, request_digest, request_json,"
                            + " phase, state, available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'CAPTURE_GC', ?, ?,"
                            + " 'OUTPUT_CAPTURE', ?, ?, '{}', 'DELETING', 'SUCCEEDED', " + ManagedSchemaTime.NEVER_DUE_MILLIS
                            + ", 0, 0)", history);
                    previous = count;
                    jdbc.update("UPDATE ma_output_capture SET retention_state = 'RETIRING' WHERE scope_key = ? AND publication_id = ?",
                            scope, publication);
                    jdbc.update("UPDATE ma_operation SET state = 'PENDING', claim_owner = NULL, claim_until = NULL,"
                            + " available_at = 0, result_json = NULL WHERE operation_key = ?", operationKey);
                    jdbc.execute("ANALYZE TABLE ma_operation, ma_output_capture");
                    jdbc.queries.clear();
                    long before = handlers(jdbc);
                    assertThat(collector.runOnce()).isTrue();
                    long observed = handlers(jdbc) - before;
                    assertThat(jdbc.queries).hasSize(3);
                    assertThat(jdbc.queries.get(0).sql()).isEqualTo("SELECT MAX(id) FROM ma_output_capture");
                    assertThat(jdbc.queries.get(1).sql()).contains("AS needs_operation");
                    assertThat(jdbc.queries.get(2).sql()).startsWith("SELECT scope_key, publication_id, tenant_id, session_id FROM ma_operation");
                    assertThat(jdbc.queries).allSatisfy(query -> {
                        if (query.sql().startsWith("SELECT MAX(id)")) {
                            assertRoundEndPlan(jdbc, query);
                        } else if (query.sql().contains("AS needs_operation")) {
                            assertBoundedRepairPlan(jdbc, query);
                        } else {
                            List<Map<String, Object>> plan = jdbc.queryForList("EXPLAIN " + query.sql(), query.arguments());
                            assertThat(plan).noneSatisfy(row -> assertThat(row.get("type")).isEqualTo("ALL"));
                            assertThat(plan).noneSatisfy(row -> assertThat(String.valueOf(row.get("extra"))).contains("filesort"));
                        }
                    });
                    assertThat(jdbc.queryForObject("SELECT retention_state FROM ma_output_capture WHERE scope_key = ?"
                            + " AND publication_id = ?", String.class, scope, publication)).isEqualTo("COLLECTED");
                    System.out.println("capture load history=" + count + " runHandlers=" + observed);
                    assertThat(observed).isLessThan(500);
                    if (count == 1_000) {
                        smaller = observed;
                    } else {
                        assertThat(observed).isLessThanOrEqualTo(smaller + 64);
                    }
                }
            }
        }
    }

    @Test
    void collectionClaimsAndPagesRemainBoundedAndKeepReaderPutAndReferenceProtection() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            try (Connection connection = database.source().getConnection()) {
                var source = new SingleConnectionDataSource(connection, true);
                var jdbc = new ObservedJdbc(source);
                var manager = new DataSourceTransactionManager(source);
                var tx = new TransactionTemplate(manager);
                var properties = new ManagedAgentProperties();
                properties.getToolPublication().setGcEnabled(true);
                properties.getToolPublication().setDeletionGrace(java.time.Duration.ZERO);
                var collector = new SessionResourceCollectionCollector(jdbc, manager, properties,
                        () -> java.time.Duration.ofMinutes(2).toNanos());
                for (String session : List.of(HEALTHY, "reader", "unknown-put")) {
                    tx.executeWithoutResult(status -> {
                        ToolPublicationRetentionStore.lockDeletion(jdbc, TENANT, session);
                        ToolPublicationRetentionStore.retire(jdbc, TENANT, session, "delete-" + session);
                    });
                }
                String readerKey = ManagedSchemaKeys.key("reader");
                jdbc.update("INSERT INTO ma_read_lease (lease_id, tenant_key, session_key, retirement_generation, expires_at)"
                                + " VALUES ('held-reader', ?, ?, 0, ?)", ManagedSchemaKeys.key(TENANT), readerKey,
                        ToolPublicationRetentionStore.now(jdbc) + 600_000);
                String unknownScope = ManagedSessionStore.sessionScopeKey(TENANT, "unknown-put");
                String unknownTarget = ManagedSchemaKeys.key("original-object");
                String unknownKey = ManagedSchemaKeys.operationKey(OperationKind.OBJECT_PUT, unknownScope, unknownTarget, "put");
                insertOperation(jdbc, unknownKey, unknownScope, "put", "OBJECT_PUT", "unknown-put", unknownTarget, "UNKNOWN", 0);
                // Retirement queued the three scoped operations; claim must still observe both blockers.
                assertThat(collector.runOnce()).isTrue();
                assertThat(collector.runOnce()).isFalse();
                assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE session_id = ?"
                        + " AND operation_kind = 'SESSION_RESOURCE_GC'", String.class, "reader")).isEqualTo("reader_active");
                assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE session_id = ?"
                        + " AND operation_kind = 'SESSION_RESOURCE_GC'", String.class, "unknown-put")).isEqualTo("put_unresolved");

                String scope = ManagedSessionStore.sessionScopeKey(TENANT, HEALTHY);
                String proofKey = ManagedSchemaKeys.operationKey(OperationKind.WORKSPACE_OPERATOR_RECOVERY, scope, scope, "proof");
                insertOperation(jdbc, proofKey, scope, "proof", "WORKSPACE_OPERATOR_RECOVERY", HEALTHY, scope, "SUCCEEDED",
                        ManagedSchemaTime.NEVER_DUE_MILLIS);
                String protectedId = lowResourceId(scope, "protected");
                byte[] body = "immutable-body".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                insertResource(jdbc, scope, protectedId, "REFERENCED", body);
                jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create) VALUES (?, 'OPERATION', ?, 1, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                        scope, proofKey, ManagedSchemaKeys.key(scope, protectedId), TENANT, HEALTHY, protectedId);
                long smallClaim = 0;
                long smallPage = 0;
                int previous = 0;
                for (int size : List.of(1_000, 10_000)) {
                    addHistory(jdbc, scope, previous, size);
                    previous = size;
                    String eligible = lowResourceId(scope, "eligible-" + size);
                    insertResource(jdbc, scope, eligible, "REFERENCED", body);
                    jdbc.execute("ANALYZE TABLE ma_operation, ma_resource, ma_resource_ref");
                    jdbc.update("UPDATE ma_operation SET state = 'PENDING', available_at = 0, claim_owner = NULL, claim_until = NULL,"
                                    + " result_json = NULL WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_id = ?", HEALTHY);
                    jdbc.queries.clear();
                    long before = handlers(jdbc);
                    var claim = collector.claim();
                    long claimed = handlers(jdbc) - before;
                    assertThat(claim).isNotNull();
                    assertThat(claim.session()).isEqualTo(HEALTHY);
                    before = handlers(jdbc);
                    assertThat(collector.collect(claim)).isTrue();
                    long paged = handlers(jdbc) - before;
                    assertThat(jdbc.queries).hasSize(2);
                    for (Query query : jdbc.queries) {
                        List<Map<String, Object>> plan = jdbc.queryForList("EXPLAIN " + query.sql(), query.arguments());
                        System.out.println("publication query plan history=" + size + " " + plan);
                        assertThat(plan).noneSatisfy(row -> assertThat(row.get("type")).isEqualTo("ALL"));
                        assertThat(plan).anySatisfy(row -> assertThat(row.get("key")).isNotNull());
                        assertThat(plan).noneSatisfy(row -> assertThat(String.valueOf(row.get("extra"))).contains("filesort"));
                    }
                    assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?", String.class,
                            ManagedSchemaKeys.key(scope, protectedId))).isEqualTo("REFERENCED");
                    assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?", byte[].class,
                            ManagedSchemaKeys.key(scope, protectedId))).isEqualTo(body);
                    assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?", String.class,
                            ManagedSchemaKeys.key(scope, eligible))).isEqualTo("COLLECTED");
                    assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_key = ?", String.class, unknownKey)).isEqualTo("UNKNOWN");
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_read_lease WHERE lease_id = 'held-reader'", Long.class)).isEqualTo(1);
                    System.out.println("publication load history=" + size + " claimHandlers=" + claimed + " pageHandlers=" + paged);
                    assertThat(claimed).isLessThan(500);
                    assertThat(paged).isLessThan(600);
                    if (size == 1_000) {
                        smallClaim = claimed;
                        smallPage = paged;
                    } else {
                        assertThat(claimed).isLessThanOrEqualTo(smallClaim + 64);
                        assertThat(paged).isLessThanOrEqualTo(smallPage + 128);
                    }
                }
            }
        }
    }

    @Test
    void repairScansStayBoundedAcrossTenTimesMoreFullyCoveredSourceHistory() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            try (Connection connection = database.source().getConnection()) {
                var source = new SingleConnectionDataSource(connection, true);
                var jdbc = new ObservedJdbc(source);
                var manager = new DataSourceTransactionManager(source);
                var properties = new ManagedAgentProperties();
                properties.getToolPublication().setGcEnabled(true);
                properties.getToolPublication().setDeletionGrace(java.time.Duration.ZERO);
                var smaller = new java.util.HashMap<String, Long>();
                int previous = 0;
                for (int count : List.of(1_000, 10_000)) {
                    addCoveredSources(jdbc, previous, count);
                    previous = count;
                    jdbc.execute("ANALYZE TABLE ma_session, ma_output_capture, ma_operation");
                    var captureCollector = new ToolPublicationCollector(jdbc, manager,
                            new ToolPublicationRetentionStore(jdbc, manager),
                            org.mockito.Mockito.mock(ToolPublicationObjectStore.class), properties);
                    var nanos = new java.util.concurrent.atomic.AtomicLong(java.time.Duration.ofMinutes(1).toNanos());
                    var sessionCollector = new SessionResourceCollectionCollector(jdbc, manager, properties, nanos::get);
                    jdbc.queries.clear();
                    assertThat(captureCollector.runOnce()).isFalse();
                    assertThat(sessionCollector.runOnce()).isFalse();
                    assertThat(jdbc.queries).hasSize(6);
                    var maxima = jdbc.queries.stream().filter(query -> query.sql().startsWith("SELECT MAX(id)")).toList();
                    assertThat(maxima).extracting(Query::sql).containsExactly(
                            "SELECT MAX(id) FROM ma_output_capture", "SELECT MAX(id) FROM ma_session");
                    maxima.forEach(query -> assertRoundEndPlan(jdbc, query));
                    var scans = jdbc.queries.stream().filter(query -> query.sql().contains("AS needs_")).toList();
                    assertThat(scans).hasSize(2);
                    for (Query query : scans) {
                        String marker = query.sql().contains("AS needs_operation") ? "needs_operation" : "needs_ledger";
                        long before = handlers(jdbc);
                        var rows = jdbc.queryForList(query.sql(), query.arguments());
                        long observed = handlers(jdbc) - before;
                        assertThat(rows).hasSize(32).allSatisfy(row ->
                                assertThat(((Number) row.get(marker)).intValue()).isZero());
                        assertBoundedRepairPlan(jdbc, query);
                        System.out.println("repair source=" + marker + " history=" + count + " handlers=" + observed);
                        assertThat(observed).isLessThan(500);
                        if (count == 1_000) {
                            smaller.put(marker, observed);
                        } else {
                            assertThat(observed).isLessThanOrEqualTo(smaller.get(marker) + 64);
                        }
                    }
                    jdbc.queries.clear();
                    assertThat(captureCollector.runOnce()).isFalse();
                    nanos.addAndGet(java.time.Duration.ofMinutes(1).toNanos());
                    assertThat(sessionCollector.runOnce()).isFalse();
                    assertThat(jdbc.queries).hasSize(4).noneMatch(query -> query.sql().startsWith("SELECT MAX(id)"));
                    var nextScans = jdbc.queries.stream().filter(query -> query.sql().contains("AS needs_")).toList();
                    assertThat(nextScans).hasSize(2);
                    for (int index = 0; index < scans.size(); index++) {
                        Object[] before = scans.get(index).arguments();
                        Object[] after = nextScans.get(index).arguments();
                        assertThat(after).hasSize(before.length);
                        assertThat(after[after.length - 1]).isEqualTo(before[before.length - 1]);
                        assertThat((Long) after[after.length - 2]).isGreaterThan((Long) before[before.length - 2]);
                    }
                }
            }
        }
    }

    private static void assertRoundEndPlan(ObservedJdbc jdbc, Query query) {
        assertThat(query.arguments()).isEmpty();
        assertThat(jdbc.queryForList("EXPLAIN " + query.sql())).singleElement()
                .satisfies(row -> assertThat(row.get("extra")).isEqualTo("Select tables optimized away"));
    }

    private static void assertBoundedRepairPlan(ObservedJdbc jdbc, Query query) {
        var plan = jdbc.queryForList("EXPLAIN " + query.sql(), query.arguments());
        assertThat(plan).allSatisfy(row -> {
            if (String.valueOf(row.get("table")).startsWith("<derived")) {
                assertThat(((Number) row.get("rows")).longValue()).isLessThanOrEqualTo(32);
            } else {
                assertThat(row.get("type")).isNotEqualTo("ALL");
                assertThat(String.valueOf(row.get("extra"))).doesNotContain("filesort");
            }
        });
        String table = query.sql().contains("AS needs_operation") ? "ma_output_capture" : "ma_session";
        assertThat(plan).filteredOn(row -> table.equals(row.get("table"))).singleElement()
                .satisfies(row -> assertThat(row.get("key"))
                        .isEqualTo("ma_session".equals(table) ? "uk_ma_session_id" : "PRIMARY"));
    }

    private static void addCoveredSources(ObservedJdbc jdbc, int after, int count) {
        var sessions = new ArrayList<Object[]>();
        var captures = new ArrayList<Object[]>();
        var operations = new ArrayList<Object[]>();
        for (int index = after; index < count; index++) {
            String id = "covered-" + index;
            String sessionScope = ManagedSessionStore.sessionScopeKey(TENANT, id);
            String captureScope = ToolPublicationDataStore.scope(TENANT, "workspace", id);
            String sessionGc = "session-resources-" + sessionScope;
            String captureGc = "capture-gc-" + ManagedSchemaKeys.key(captureScope, id);
            sessions.add(new Object[] {TENANT, id, ManagedSchemaKeys.key(TENANT), ManagedSchemaKeys.key(id), sessionScope});
            captures.add(new Object[] {captureScope, ManagedSchemaKeys.key(TENANT), TENANT, id, id,
                    ManagedSchemaKeys.key("execution", id), id, ManagedSchemaKeys.key("binding"), ManagedSchemaKeys.key("token")});
            operations.add(new Object[] {ManagedSchemaKeys.operationKey(OperationKind.SESSION_RESOURCE_GC,
                    sessionScope, sessionScope, sessionGc), sessionScope, sessionScope, sessionGc,
                    "SESSION_RESOURCE_GC", TENANT, id, null, "SESSION", sessionScope, ManagedSchemaKeys.key(sessionGc)});
            operations.add(new Object[] {ManagedSchemaKeys.operationKey(OperationKind.CAPTURE_GC,
                    captureScope, ManagedSchemaKeys.key(id), captureGc), sessionScope, captureScope, captureGc,
                    "CAPTURE_GC", TENANT, id, id, "OUTPUT_CAPTURE", ManagedSchemaKeys.key(id), ManagedSchemaKeys.key(captureGc)});
        }
        jdbc.batchUpdate("INSERT INTO ma_session (tenant_id, session_id, session_kind, tenant_key, session_key,"
                + " session_scope_key, retired_at, retirement_generation, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'CONTROL', ?, ?, ?, 1, 1, 0, 0)", sessions);
        jdbc.batchUpdate("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                + " capture_bytes, producer_bytes, admission_bytes, retention_state)"
                + " VALUES (?, ?, ?, 'workspace', ?, ?, ?, ?, '{}', ?, ?, 'FENCED', 1, 1, 1, 'RETIRING')", captures);
        jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id, operation_kind,"
                + " tenant_id, session_id, publication_id, target_kind, target_key, request_digest, request_json, phase, state,"
                + " available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'COLLECTING', 'SUCCEEDED', "
                + ManagedSchemaTime.NEVER_DUE_MILLIS + ", 0, 0)", operations);
    }

    private static long handlers(ManagedSchemaJdbcTemplate jdbc) {
        return jdbc.query("SHOW SESSION STATUS LIKE 'Handler_read%'", (row, index) -> row.getLong(2)).stream()
                .mapToLong(Long::longValue).sum();
    }

    private static String lowResourceId(String scope, String prefix) {
        String result = prefix + "-0";
        String lowest = ManagedSchemaKeys.key(scope, result);
        for (int index = 1; index < 2_048; index++) {
            String candidate = prefix + "-" + index;
            String key = ManagedSchemaKeys.key(scope, candidate);
            if (key.compareTo(lowest) < 0) {
                lowest = key;
                result = candidate;
            }
        }
        return result;
    }

    private static void insertOperation(ManagedSchemaJdbcTemplate jdbc, String key, String scope, String id, String kind,
            String session, String target, String state, long available) {
        jdbc.update("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id, operation_kind, tenant_id,"
                        + " session_id, target_kind, target_key, request_digest, request_json, phase, state, available_at, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, 'SESSION', ?, ?, '{\"version\":1}', 'COLLECTING', ?, ?, 0, 0)",
                key, scope, scope, id, kind, TENANT, session, target, ManagedSchemaKeys.key(id), state, available);
    }

    private static void insertResource(ManagedSchemaJdbcTemplate jdbc, String scope, String id, String state, byte[] bytes) {
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES (?, ?, ?, ?, ?, 'managed-message-body', 1, ?, ?, 'MYSQL_INLINE', ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSchemaKeys.key(scope, id), scope, TENANT, HEALTHY, id, bytes.length, ToolPublicationContract.sha256(bytes),
                state.equals("COLLECTED") ? null : bytes, state);
    }

    private static void addHistory(ManagedSchemaJdbcTemplate jdbc, String scope, int after, int count) {
        List<Object[]> operations = new ArrayList<>();
        List<Object[]> resources = new ArrayList<>();
        byte[] bytes = new byte[] {1};
        for (int index = after; index < count; index++) {
            String id = "history-" + index;
            operations.add(new Object[] {ManagedSchemaKeys.operationKey(OperationKind.SESSION_RESOURCE_GC, scope,
                    ManagedSchemaKeys.key(id), id), scope, scope, id, TENANT, HEALTHY, ManagedSchemaKeys.key(id), ManagedSchemaKeys.key(id)});
            resources.add(new Object[] {ManagedSchemaKeys.key(scope, id), scope, TENANT, HEALTHY, id, ToolPublicationContract.sha256(bytes)});
        }
        jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id, operation_kind, tenant_id,"
                        + " session_id, target_kind, target_key, request_digest, request_json, phase, state, available_at, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, 'SESSION_RESOURCE_GC', ?, ?, 'SESSION', ?, ?, '{\"version\":1}', 'COLLECTING', 'SUCCEEDED', "
                        + ManagedSchemaTime.NEVER_DUE_MILLIS + ", 0, 0)", operations);
        jdbc.batchUpdate("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, state, gmt_create) VALUES (?, ?, ?, ?, ?, 'managed-message-body', 1, 1, ?, 'MYSQL_INLINE', 'COLLECTED', " + ManagedSchemaTime.SQL_NOW + ")", resources);
    }
}
