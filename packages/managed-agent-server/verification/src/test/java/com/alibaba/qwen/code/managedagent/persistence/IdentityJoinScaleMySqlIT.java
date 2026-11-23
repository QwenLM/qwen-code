package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;

import javax.sql.DataSource;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Identity joins keep their full index key once a Session's history grows. */
class IdentityJoinScaleMySqlIT {
    @Test
    void recordResourceJoinUsesTheWholeResourceKey() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new CapturingJdbc(database.source(), "LEFT JOIN ma_resource u");
            var resources = new ArrayList<Object[]>();
            for (int index = 0; index < 2000; index++) {
                resources.add(new Object[] {"resource-" + index});
            }
            jdbc.batchUpdate("INSERT INTO ma_resource (tenant_id, workspace_id, session_id, resource_id, kind, schema_version,"
                    + " byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES ('tenant', 'workspace',"
                    + " 'session', ?, 'managed-mcp', 1, 2, 'digest', 'MYSQL_INLINE', X'7b7d', 'REFERENCED', 1)", resources);
            var records = new ArrayList<Object[]>();
            for (int index = 0; index < 5; index++) {
                records.add(new Object[] {"record-" + index, "resource-" + index * 100, index});
            }
            jdbc.batchUpdate("INSERT INTO ma_session_record (tenant_id, workspace_id, session_id, domain, record_id, revision,"
                    + " record_resource_id, gmt_create) VALUES ('tenant', 'workspace', 'session', 'mcp_configuration', ?, 1, ?, ?)",
                    records);
            jdbc.execute("ANALYZE TABLE ma_resource, ma_session_record");

            assertThat(ManagedExtensionQueries.mcpRefs(jdbc, "tenant", "session", 10)).hasSize(5)
                    .allSatisfy(ref -> assertThat(ref.path("kind").asText()).isEqualTo("managed-mcp"));
            JsonNode plan = jsonPlan(jdbc, jdbc.captured);
            assertThat(usedKeyParts(plan, "u")).as(plan.toString()).contains("resource_id");
        }
    }

    @Test
    void artifactPageDoesNotScanTheSessionToolResults() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new CapturingJdbc(database.source(), "FROM ma_artifact a JOIN ma_operation r");
            String scope = JdbcManagedToolResultStore.scope("tenant", "session");
            var operations = new ArrayList<Object[]>();
            for (int index = 0; index < 2000; index++) {
                String id = "result-" + index;
                operations.add(new Object[] {ManagedIdentityRefs.operationRef("TOOL_RESULT_PROJECTION", "tenant", "SESSION",
                        "session", "call-" + index, id), ManagedSchemaKeys.identity("session"), id,
                        ManagedSchemaKeys.identity("call-" + index)});
            }
            jdbc.batchUpdate("INSERT INTO ma_operation (operation_ref, scope_kind, scope_id, operation_kind, operation_id,"
                    + " tenant_id, workspace_id, session_id, target_kind, target_id, request_json, request_digest, phase, state,"
                    + " gmt_create, gmt_modified) VALUES (?, 'SESSION', ?, 'TOOL_RESULT_PROJECTION', ?, 'tenant', 'workspace',"
                    + " 'session', 'TOOL_EXECUTION', ?, '{}', 'digest', 'PROJECTED', 'READY', 1, 1)", operations);
            var artifacts = new ArrayList<Object[]>();
            for (int index = 0; index < 5; index++) {
                artifacts.add(new Object[] {"artifact-" + index, "result-" + index * 100, scope, index + 1});
            }
            jdbc.batchUpdate("INSERT INTO ma_artifact (artifact_id, result_id, scope_ref, descriptor_json, publication_id,"
                    + " binding_json, manifest_ref_json, stream_id, creation_sequence) VALUES (?, ?, ?, '{}', 'publication',"
                    + " '{}', '{}', 'stream', ?)", artifacts);
            jdbc.execute("ANALYZE TABLE ma_operation, ma_artifact");

            var store = new JdbcManagedToolResultStore(jdbc, new DataSourceTransactionManager(database.source()), null);
            assertThat(store.listArtifacts("tenant", "session", null, null, null, 10).artifacts()).hasSize(5);
            var plan = ExecutedQueryPlan.explain(jdbc, jdbc.captured.sql(), jdbc.captured.arguments());
            assertThat(plan.rowCounts()).as(plan.text()).isNotEmpty().allSatisfy(count ->
                    assertThat(count).as(plan.text()).isLessThanOrEqualTo(20));
        }
    }

    @Test
    void recoveryCandidatesProbeTheOperationTargetIndex() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new ManagedSchemaJdbcTemplate(database.source());
            var bindings = new ArrayList<Object[]>();
            var recoveries = new ArrayList<Object[]>();
            for (int index = 0; index < 1000; index++) {
                String binding = "binding-" + index;
                bindings.add(new Object[] {binding, ManagedSchemaKeys.key("request", binding),
                        ManagedSchemaKeys.key("scope", binding)});
                recoveries.add(new Object[] {ManagedIdentityRefs.tenantOperationRef("WORKSPACE_OPERATOR_RECOVERY", "tenant",
                        "recovery-" + index), ManagedSchemaKeys.identity("tenant"), "recovery-" + index,
                        ManagedSchemaKeys.identity(binding)});
            }
            jdbc.batchUpdate("INSERT INTO ma_runtime_binding (binding_id, request_id, scope_id, tenant_id, workspace_id,"
                    + " workspace_generation, canonical_cwd, capability_digest, isolation_class, provisioner_kind, storage_id,"
                    + " runtime_generation, binding_state, resource_handle_version, attestation_generation, is_drain_requested,"
                    + " operation_generation, record_version, last_active_at) VALUES (?, ?, ?, 'tenant', 'workspace', '1',"
                    + " '/scale', 'digest', 'workspace', 'local-process', 'storage', 1, 'READY', 2, 0, FALSE, 0, 0, 1)", bindings);
            jdbc.batchUpdate("INSERT INTO ma_operation (operation_ref, scope_kind, scope_id, operation_kind, operation_id,"
                    + " tenant_id, target_kind, target_id, target_revision, request_json, request_digest, phase, state,"
                    + " gmt_create, gmt_modified) VALUES (?, 'TENANT', ?, 'WORKSPACE_OPERATOR_RECOVERY', ?, 'tenant',"
                    + " 'BINDING', ?, 1, '{}', 'digest', 'RECOVERING', 'RUNNING', 1, 1)", recoveries);
            jdbc.execute("ANALYZE TABLE ma_runtime_binding, ma_operation");

            var statements = new ArrayList<String>();
            var repository = new JdbcRuntimeBindingRepository(capturing(database.source(), statements),
                    new AesGcmSecretProtector("test", new byte[32]));
            assertThat(repository.findRecoveryCandidates("local-process", null, 100)).isEmpty();
            String sql = statements.stream().filter(statement -> statement.contains("FROM ma_operation recovery"))
                    .findFirst().orElseThrow();
            var plan = ExecutedQueryPlan.explain(jdbc, sql, "local-process", "", 100);
            assertThat(plan.usesIndex("idx_ma_operation_target")).as(plan.text()).isTrue();
        }
    }

    private static JsonNode jsonPlan(ManagedSchemaJdbcTemplate jdbc, Query query) {
        try {
            return new ObjectMapper().readTree(jdbc.queryForObject("EXPLAIN FORMAT=JSON " + query.sql(), String.class,
                    query.arguments()));
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private static List<String> usedKeyParts(JsonNode node, String alias) {
        if (alias.equals(node.path("table_name").asText())) {
            List<String> parts = new ArrayList<>();
            node.path("used_key_parts").forEach(part -> parts.add(part.asText()));
            return parts;
        }
        for (JsonNode child : node) {
            List<String> parts = usedKeyParts(child, alias);
            if (!parts.isEmpty()) {
                return parts;
            }
        }
        return List.of();
    }

    private static DataSource capturing(DataSource source, List<String> statements) {
        return new DelegatingDataSource(source) {
            @Override
            public Connection getConnection() throws java.sql.SQLException {
                Connection connection = super.getConnection();
                return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                        new Class<?>[] {Connection.class}, (proxy, method, arguments) -> {
                            if ("prepareStatement".equals(method.getName())) {
                                statements.add((String) arguments[0]);
                            }
                            try {
                                return method.invoke(connection, arguments);
                            } catch (java.lang.reflect.InvocationTargetException error) {
                                throw error.getCause();
                            }
                        });
            }
        };
    }

    private record Query(String sql, Object[] arguments) {}

    private static final class CapturingJdbc extends ManagedSchemaJdbcTemplate {
        private final String marker;
        private Query captured;

        private CapturingJdbc(DataSource source, String marker) {
            super(source);
            this.marker = marker;
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            if (sql.contains(marker)) {
                captured = new Query(sql, args.clone());
            }
            return super.query(sql, mapper, args);
        }
    }
}
