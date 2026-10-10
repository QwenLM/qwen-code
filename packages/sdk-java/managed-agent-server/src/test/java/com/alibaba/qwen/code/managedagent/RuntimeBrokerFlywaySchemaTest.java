package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRepositoryContract;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBrokerSchema;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import javax.sql.DataSource;
import org.assertj.core.api.SoftAssertions;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/**
 * The embedded Broker writes through the runtime-broker repositories into
 * tables that Flyway creates, while the repositories are written against the
 * Broker's own schema.sql. These checks keep the two definitions equal.
 */
class RuntimeBrokerFlywaySchemaTest {
    @Test
    void flywayCreatesTheBrokerSchema() throws SQLException {
        DataSource broker = dataSource();
        JdbcRuntimeBrokerSchema.initialize(broker);
        Map<String, TableShape> expected = describe(broker);
        Map<String, TableShape> actual = describe(
                migrate(dataSource(), MigrationVersion.LATEST));

        assertThat(expected).containsKeys("qwen_runtime_binding_slot",
                "qwen_runtime_binding", "qwen_runtime_session",
                "qwen_tool_execution");
        assertThat(actual).containsKeys(
                expected.keySet().toArray(String[]::new));
        SoftAssertions.assertSoftly(softly -> expected.forEach(
                (table, shape) -> {
                    TableShape flyway = actual.get(table);
                    softly.assertThat(flyway.columns())
                            .as("columns of %s", table)
                            .containsExactlyInAnyOrderEntriesOf(
                                    shape.columns());
                    softly.assertThat(flyway.primaryKey())
                            .as("primary key of %s", table)
                            .isEqualTo(shape.primaryKey());
                    softly.assertThat(flyway.indexes())
                            .as("indexes of %s", table)
                            .containsExactlyInAnyOrderElementsOf(
                                    shape.indexes());
                }));
    }

    @Test
    void brokerRepositoriesKeepTheirContractOnTheFlywaySchema()
            throws Exception {
        JdbcRepositoryContract.verify(
                migrate(dataSource(), MigrationVersion.LATEST), "flyway");
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"11", "13"})
    void migrationsPreserveRowsWrittenByOldBinaries(String version) throws SQLException {
        DataSource source = migrate(dataSource(), MigrationVersion.fromVersion(version));
        RuntimeProvisionRequest request = JdbcRepositoryContract.writeLegacyRows(source, "upgrade");
        migrate(source, MigrationVersion.LATEST);
        JdbcRuntimeBindingRepository bindings = new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("key", new byte[32]));
        RuntimeBindingRecord binding = bindings.findOrCreate(request);
        assertThat(binding.getBindingId()).isEqualTo("upgrade-binding");
        assertThat(binding.getVersion()).isEqualTo(3);
        assertThat(binding.getLossEvidence()).isNull();
        assertThat(binding.getStopEvidence()).isNull();
        RuntimeSessionRecord session = new JdbcRuntimeSessionRepository(source)
                .findById(request.getScope(), "upgrade-session");
        assertThat(session.getBindingId()).isEqualTo("upgrade-binding");
        assertThat(session.getVersion()).isEqualTo(4);
        JdbcToolExecutionRepository executions = new JdbcToolExecutionRepository(source);
        for (String state : List.of("PREPARED", "UNKNOWN", "SETTLED")) {
            ToolExecutionRecord execution = executions.findByIdempotencyKey("upgrade-" + state + "-key");
            assertThat(execution.getState().name()).isEqualTo(state);
            assertThat(execution.getExecutionCallId()).isEqualTo("upgrade-" + state);
            assertThat(execution.getVersion()).isEqualTo(5);
            assertThat(execution.getAbandonedAt()).isNull();
            if (execution.isSettled()) {
                assertThat(execution.getResult()).containsEntry("executionStatus", "success");
            }
        }
    }

    private static DataSource migrate(DataSource dataSource,
            MigrationVersion target) {
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").target(target).load()
                .migrate();
        return dataSource;
    }

    private static DataSource dataSource() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:runtime-broker-flyway-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return dataSource;
    }

    private static Map<String, TableShape> describe(DataSource dataSource)
            throws SQLException {
        try (Connection connection = dataSource.getConnection()) {
            DatabaseMetaData metadata = connection.getMetaData();
            String schema = connection.getSchema();
            Map<String, Map<String, String>> columns = new TreeMap<>();
            try (ResultSet rows = metadata.getColumns(null, schema, "%",
                    "%")) {
                while (rows.next()) {
                    columns.computeIfAbsent(rows.getString("TABLE_NAME"),
                            ignored -> new TreeMap<>()).put(
                                    rows.getString("COLUMN_NAME"),
                                    column(rows));
                }
            }
            Map<String, TableShape> tables = new TreeMap<>();
            for (Map.Entry<String, Map<String, String>> table
                    : columns.entrySet()) {
                tables.put(table.getKey(), new TableShape(table.getValue(),
                        primaryKey(metadata, schema, table.getKey()),
                        indexes(metadata, schema, table.getKey())));
            }
            return tables;
        }
    }

    private static String column(ResultSet row) throws SQLException {
        String definition = row.getString("TYPE_NAME") + "("
                + row.getInt("COLUMN_SIZE") + ", "
                + row.getInt("DECIMAL_DIGITS") + ")";
        if ("NO".equals(row.getString("IS_NULLABLE"))) {
            definition += " NOT NULL";
        }
        String defaultValue = row.getString("COLUMN_DEF");
        return defaultValue == null ? definition
                : definition + " DEFAULT " + defaultValue;
    }

    private static List<String> primaryKey(DatabaseMetaData metadata,
            String schema, String table) throws SQLException {
        Map<Short, String> columns = new TreeMap<>();
        try (ResultSet rows = metadata.getPrimaryKeys(null, schema, table)) {
            while (rows.next()) {
                columns.put(rows.getShort("KEY_SEQ"),
                        rows.getString("COLUMN_NAME"));
            }
        }
        return List.copyOf(columns.values());
    }

    /** H2 generates the names of constraint indexes; compare keys only. */
    private static List<String> indexes(DatabaseMetaData metadata,
            String schema, String table) throws SQLException {
        Map<String, Map<Short, String>> columns = new TreeMap<>();
        Map<String, Boolean> unique = new TreeMap<>();
        try (ResultSet rows = metadata.getIndexInfo(null, schema, table,
                false, false)) {
            while (rows.next()) {
                String index = rows.getString("INDEX_NAME");
                if (index == null) {
                    continue;
                }
                unique.put(index, !rows.getBoolean("NON_UNIQUE"));
                columns.computeIfAbsent(index, ignored -> new TreeMap<>())
                        .put(rows.getShort("ORDINAL_POSITION"),
                                rows.getString("COLUMN_NAME"));
            }
        }
        List<String> keys = new ArrayList<>();
        columns.forEach((index, parts) -> keys.add(
                (unique.get(index) ? "UNIQUE " : "INDEX ") + parts.values()));
        keys.sort(null);
        return keys;
    }

    private record TableShape(Map<String, String> columns,
            List<String> primaryKey, List<String> indexes) {
    }
}
