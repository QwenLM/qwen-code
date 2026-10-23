package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.transaction.support.TransactionTemplate;

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
                    || sql.startsWith("SELECT c.scope_key, c.publication_id, c.tenant_id")
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
                                + " capture_bytes, producer_bytes, admission_bytes, producer_phase, write_evidence, accepted_complete)"
                                + " VALUES (?, ?, ?, 'workspace', ?, ?, ?, 'capture-id', '{}', ?, ?, 'FENCED',"
                                + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE)",
                        scope, ManagedSchemaKeys.key(TENANT), TENANT, HEALTHY, publication,
                        ManagedSchemaKeys.key("execution"), ManagedSchemaKeys.key("binding"), ManagedSchemaKeys.key("token"));
                tx.executeWithoutResult(status -> {
                    ToolPublicationRetentionStore.lockDeletion(jdbc, TENANT, HEALTHY);
                    ToolPublicationRetentionStore.retire(jdbc, TENANT, HEALTHY, "delete");
                });
                insertOperation(jdbc, operationKey, scope, operationId, "CAPTURE_GC", HEALTHY,
                        ManagedSchemaKeys.key(publication), "PENDING", 0);
                jdbc.update("UPDATE ma_operation SET session_scope_key = ?, publication_id = ? WHERE operation_key = ?",
                        sessionScope, publication, operationKey);
                ToolPublicationObjectStore unusedObjects = new ToolPublicationObjectStore() {
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
                    assertThat(jdbc.queries).hasSize(2).allSatisfy(query -> {
                        List<Map<String, Object>> plan = jdbc.queryForList("EXPLAIN " + query.sql(), query.arguments());
                        assertThat(plan).noneSatisfy(row -> assertThat(row.get("type")).isEqualTo("ALL"));
                        assertThat(plan).noneSatisfy(row -> assertThat(String.valueOf(row.get("extra"))).contains("filesort"));
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
                // Let the actual collector create its three scoped operations and observe both blockers.
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
