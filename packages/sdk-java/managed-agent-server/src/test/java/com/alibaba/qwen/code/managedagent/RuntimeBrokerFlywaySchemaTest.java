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
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
    private static final Instant START = Instant.parse(
            "2026-09-27T00:00:00Z");

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

    @Test
    void alignmentKeepsRuntimeRowsWrittenBeforeIt() {
        DataSource dataSource = migrate(dataSource(),
                MigrationVersion.fromVersion("11"));
        RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                "generation", "/workspace", "capability", "session");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                "isolation", "local-process");
        AtomicInteger bindingIds = new AtomicInteger();
        JdbcRuntimeBindingRepository bindings =
                new JdbcRuntimeBindingRepository(dataSource,
                        new AesGcmSecretProtector("key", new byte[32]),
                        () -> "binding-" + bindingIds.incrementAndGet());
        JdbcRuntimeSessionRepository sessions =
                new JdbcRuntimeSessionRepository(dataSource);
        JdbcToolExecutionRepository executions =
                new JdbcToolExecutionRepository(dataSource);
        RuntimeBindingRecord binding = bindings.findOrCreate(request);
        RuntimeSessionRecord session = sessions.findOrCreate(
                new RuntimeSessionRecord(new RuntimeSession("harness",
                        "runtime-session", "bootstrap", scope),
                        binding.getBindingId(), binding.getGeneration(),
                        RuntimeSessionRecord.State.ACQUIRING, 0, START));
        ToolExecutionRecord execution = executions.findOrCreate(
                ToolExecutionRecord.prepared("execution", "idempotency",
                        binding.getBindingId(), binding.getGeneration(),
                        "harness", "runtime-session", "turn", "tool",
                        "digest", Map.of("sessionId", "runtime-session",
                                "promptId", "turn", "callId", "tool",
                                "argsDigest", "digest")));

        migrate(dataSource, MigrationVersion.LATEST);

        RuntimeBindingRecord upgradedBinding = bindings.findOrCreate(request);
        assertThat(upgradedBinding.getBindingId())
                .isEqualTo(binding.getBindingId());
        assertThat(upgradedBinding.getVersion())
                .isEqualTo(binding.getVersion());
        RuntimeSessionRecord upgradedSession = sessions.findById(scope,
                "runtime-session");
        assertThat(upgradedSession.getBindingId())
                .isEqualTo(session.getBindingId());
        assertThat(upgradedSession.getVersion())
                .isEqualTo(session.getVersion());
        ToolExecutionRecord upgradedExecution =
                executions.findByExecutionCallId("execution");
        assertThat(upgradedExecution.getIdempotencyKey())
                .isEqualTo(execution.getIdempotencyKey());
        assertThat(upgradedExecution.getVersion())
                .isEqualTo(execution.getVersion());
        assertThat(executions.findByIdempotencyKey("idempotency")
                .getExecutionCallId()).isEqualTo("execution");
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
