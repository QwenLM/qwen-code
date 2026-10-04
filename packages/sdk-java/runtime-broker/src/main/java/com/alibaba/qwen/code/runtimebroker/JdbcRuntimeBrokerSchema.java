package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import javax.sql.DataSource;

/** Installs the private Runtime Broker JDBC schema. */
public final class JdbcRuntimeBrokerSchema {
    private static final String RESOURCE =
            "/com/alibaba/qwen/code/runtimebroker/schema.sql";

    private JdbcRuntimeBrokerSchema() {
    }

    public static void initialize(DataSource dataSource) {
        DataSource source = JdbcRepositorySupport.requireDataSource(
                dataSource);
        String schema = readSchema();
        try (Connection connection = source.getConnection();
                Statement statement = connection.createStatement()) {
            for (String sql : schema.split(";")) {
                String command = sql.trim();
                if (!command.isEmpty()) {
                    statement.execute(command);
                }
            }
            addColumn(statement, "qwen_runtime_binding_slot", "storage_id", "VARCHAR(256)");
            addColumn(statement, "qwen_runtime_binding", "storage_id", "VARCHAR(256)");
            addColumn(statement, "qwen_runtime_binding", "loss_evidence_json", "LONGTEXT");
            addColumn(statement, "qwen_runtime_binding", "stop_evidence_json", "LONGTEXT");
            addColumn(statement, "qwen_runtime_binding", "drain_receipt_json", "LONGTEXT");
            addColumn(statement, "qwen_runtime_harness_drain", "phase", "VARCHAR(32) NOT NULL DEFAULT 'DRAINING'");
            addColumn(statement, "qwen_runtime_harness_drain", "operation_id", "VARCHAR(128)");
            addColumn(statement, "qwen_runtime_harness_drain", "claim_generation", "BIGINT NOT NULL DEFAULT 0");
            addColumn(statement, "qwen_runtime_harness_drain", "claim_lease_until", "BIGINT");
            addColumn(statement, "qwen_tool_execution", "abandoned_at", "DATETIME(6)");
            addColumn(statement, "qwen_tool_execution", "loss_evidence_id", "VARCHAR(512)");
        } catch (SQLException exception) {
            throw JdbcRepositorySupport.failure(exception);
        }
    }

    private static void addColumn(Statement statement, String table, String column, String definition)
            throws SQLException {
        if (hasColumn(statement, table, column)) {
            return;
        }
        try {
            statement.execute("ALTER TABLE " + table
                    + " ADD COLUMN " + column + " " + definition);
        } catch (SQLException failure) {
            // Another instance may have added it since the check.
            if (!hasColumn(statement, table, column)) {
                throw failure;
            }
        }
    }

    private static boolean hasColumn(Statement statement, String table, String column)
            throws SQLException {
        try (java.sql.ResultSet result = statement.executeQuery(
                "SELECT * FROM " + table + " WHERE 1 = 0")) {
            java.sql.ResultSetMetaData columns = result.getMetaData();
            for (int index = 1; index <= columns.getColumnCount(); index++) {
                if (column.equalsIgnoreCase(columns.getColumnName(index))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static String readSchema() {
        try (InputStream stream = JdbcRuntimeBrokerSchema.class
                .getResourceAsStream(RESOURCE)) {
            if (stream == null) {
                throw new IllegalStateException(
                        "Runtime Broker schema resource is missing");
            }
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Runtime Broker schema resource cannot be read",
                    exception);
        }
    }
}
