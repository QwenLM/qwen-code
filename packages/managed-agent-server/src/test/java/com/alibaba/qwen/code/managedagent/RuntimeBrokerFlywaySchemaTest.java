package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.runtimebroker.JdbcRepositoryContract;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBrokerSchema;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import org.assertj.core.api.SoftAssertions;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The embedded Broker writes through the runtime-broker repositories into the same canonical schema
 * through both initialization paths.
 */
class RuntimeBrokerFlywaySchemaTest {
    @Test
    void flywayCreatesTheBrokerSchema() throws SQLException {
        DataSource broker = dataSource();
        JdbcRuntimeBrokerSchema.initialize(broker);
        Map<String, TableShape> expected = describe(broker);
        Map<String, TableShape> actual = describe(migrate(dataSource(), MigrationVersion.LATEST));

        assertThat(expected)
                .hasSize(32)
                .containsKeys(
                        "ma_runtime_slot",
                        "ma_runtime_binding",
                        "ma_runtime_session",
                        "ma_tool_execution",
                        "ma_workspace");
        assertThat(actual).containsKeys(expected.keySet().toArray(String[]::new));
        SoftAssertions.assertSoftly(
                softly ->
                        expected.forEach(
                                (table, shape) -> {
                                    TableShape flyway = actual.get(table);
                                    softly.assertThat(flyway.columns())
                                            .as("columns of %s", table)
                                            .containsExactlyInAnyOrderEntriesOf(shape.columns());
                                    softly.assertThat(flyway.primaryKey())
                                            .as("primary key of %s", table)
                                            .isEqualTo(shape.primaryKey());
                                    softly.assertThat(flyway.indexes())
                                            .as("indexes of %s", table)
                                            .containsExactlyInAnyOrderElementsOf(shape.indexes());
                                }));
    }

    @Test
    void brokerRepositoriesKeepTheirContractOnTheFlywaySchema() throws Exception {
        JdbcRepositoryContract.verify(migrate(dataSource(), MigrationVersion.LATEST), "flyway");
    }

    @Test
    void canonicalRetentionIndexesPreserveTerminalReceiptsOnRepeatedInitialization() throws Exception {
        DataSource source = migrate(dataSource(), MigrationVersion.LATEST);
        var executions = new JdbcToolExecutionRepository(source);
        var prepared = executions.findOrCreate(ToolExecutionRecord.prepared("retention-receipt", "retention-key",
                "binding", 1, "harness", "runtime", "turn", "call", "digest",
                Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", "digest")));
        var settled = executions.settlePrepared(prepared, Map.of("executionStatus", "success"),
                java.time.Instant.parse("2000-01-01T00:00:00Z"));
        JdbcRuntimeBrokerSchema.initialize(source);
        JdbcRuntimeBrokerSchema.initialize(source);
        assertThat(executions.findByIdempotencyKey("retention-key")).usingRecursiveComparison().isEqualTo(settled);
        Map<String, TableShape> shape = describe(source);
        assertThat(shape).hasSize(32);
        assertThat(shape.get("ma_runtime_binding").indexes()).contains(
                "INDEX [binding_state, last_active_at, binding_id]", "INDEX [tenant_id, binding_state]");
        assertThat(shape.get("ma_storage_owner").indexes())
                .contains("INDEX [binding_id, runtime_generation, storage_key]");
        assertThat(shape.get("ma_output_capture").indexes()).contains("INDEX [execution_key]");
        assertThat(shape.get("ma_operation_work").indexes())
                .contains("INDEX [work_kind, target_key, operation_key]");
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(
            strings = {"qwen_runtime_binding", "managed_agent_session"})
    void freshInitializerRefusesLegacyRowsWithoutChangingTheirCatalog(String table)
            throws SQLException {
        DataSource source = dataSource();
        try (var connection = source.getConnection();
                var sql = connection.createStatement()) {
            sql.execute("CREATE TABLE " + table + " (identity VARCHAR(64) PRIMARY KEY)");
            sql.execute("INSERT INTO " + table + " VALUES ('legacy-witness')");
        }
        var before = describe(source);
        assertThatThrownBy(() -> JdbcRuntimeBrokerSchema.initialize(source))
                .isInstanceOf(IllegalStateException.class);
        assertThat(describe(source)).isEqualTo(before);
        try (var connection = source.getConnection();
                var sql = connection.createStatement();
                var rows = sql.executeQuery("SELECT identity FROM " + table)) {
            assertThat(rows.next()).isTrue();
            assertThat(rows.getString(1)).isEqualTo("legacy-witness");
        }
    }

    private static DataSource migrate(DataSource dataSource, MigrationVersion target) {
        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db/managed-schema")
                .target(target)
                .load()
                .migrate();
        return dataSource;
    }

    private static DataSource dataSource() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL(
                "jdbc:h2:mem:runtime-broker-flyway-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return dataSource;
    }

    private static Map<String, TableShape> describe(DataSource dataSource) throws SQLException {
        try (Connection connection = dataSource.getConnection()) {
            DatabaseMetaData metadata = connection.getMetaData();
            String schema = connection.getSchema();
            Map<String, Map<String, String>> columns = new TreeMap<>();
            try (ResultSet rows = metadata.getColumns(null, schema, "%", "%")) {
                while (rows.next()) {
                    if ("flyway_schema_history".equalsIgnoreCase(rows.getString("TABLE_NAME"))) {
                        continue;
                    }
                    columns.computeIfAbsent(
                                    rows.getString("TABLE_NAME"), ignored -> new TreeMap<>())
                            .put(rows.getString("COLUMN_NAME"), column(rows));
                }
            }
            Map<String, TableShape> tables = new TreeMap<>();
            for (Map.Entry<String, Map<String, String>> table : columns.entrySet()) {
                tables.put(
                        table.getKey(),
                        new TableShape(
                                table.getValue(),
                                primaryKey(metadata, schema, table.getKey()),
                                indexes(metadata, schema, table.getKey())));
            }
            return tables;
        }
    }

    private static String column(ResultSet row) throws SQLException {
        String definition =
                row.getString("TYPE_NAME")
                        + "("
                        + row.getInt("COLUMN_SIZE")
                        + ", "
                        + row.getInt("DECIMAL_DIGITS")
                        + ")";
        if ("NO".equals(row.getString("IS_NULLABLE"))) {
            definition += " NOT NULL";
        }
        String defaultValue = row.getString("COLUMN_DEF");
        return defaultValue == null ? definition : definition + " DEFAULT " + defaultValue;
    }

    private static List<String> primaryKey(DatabaseMetaData metadata, String schema, String table)
            throws SQLException {
        Map<Short, String> columns = new TreeMap<>();
        try (ResultSet rows = metadata.getPrimaryKeys(null, schema, table)) {
            while (rows.next()) {
                columns.put(rows.getShort("KEY_SEQ"), rows.getString("COLUMN_NAME"));
            }
        }
        return List.copyOf(columns.values());
    }

    /** H2 generates the names of constraint indexes; compare keys only. */
    private static List<String> indexes(DatabaseMetaData metadata, String schema, String table)
            throws SQLException {
        Map<String, Map<Short, String>> columns = new TreeMap<>();
        Map<String, Boolean> unique = new TreeMap<>();
        try (ResultSet rows = metadata.getIndexInfo(null, schema, table, false, false)) {
            while (rows.next()) {
                String index = rows.getString("INDEX_NAME");
                if (index == null) {
                    continue;
                }
                unique.put(index, !rows.getBoolean("NON_UNIQUE"));
                columns.computeIfAbsent(index, ignored -> new TreeMap<>())
                        .put(rows.getShort("ORDINAL_POSITION"), rows.getString("COLUMN_NAME"));
            }
        }
        List<String> keys = new ArrayList<>();
        columns.forEach(
                (index, parts) ->
                        keys.add((unique.get(index) ? "UNIQUE " : "INDEX ") + parts.values()));
        keys.sort(null);
        return keys;
    }

    private record TableShape(
            Map<String, String> columns, List<String> primaryKey, List<String> indexes) {}
}
