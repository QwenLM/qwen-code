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
            addColumn(statement, "qwen_tool_execution", "abandoned_at", "DATETIME(6)");
            addColumn(statement, "qwen_tool_execution", "loss_evidence_id", "VARCHAR(512)");
            addColumn(statement, "qwen_tool_execution", "authorized_dispatch_generation", "BIGINT");
            addColumn(statement, "qwen_tool_execution", "authorized_binding_version", "BIGINT");
            addIndex(statement, "qwen_runtime_binding", "qwen_runtime_storage_bindings_idx", "storage_id, binding_id");
            addIndex(statement, "qwen_runtime_session", "idx_runtime_session_id", "runtime_session_id");
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

    private static void addIndex(Statement statement, String table, String index, String columns)
            throws SQLException {
        if (hasIndex(statement, table, index)) {
            return;
        }
        try {
            statement.execute("CREATE INDEX " + index + " ON " + table + " (" + columns + ")");
        } catch (SQLException failure) {
            if (!hasIndex(statement, table, index)) {
                throw failure;
            }
        }
    }

    private static boolean hasIndex(Statement statement, String table, String index) throws SQLException {
        Connection connection = statement.getConnection();
        var metadata = connection.getMetaData();
        String tableName = metadata.storesUpperCaseIdentifiers() ? table.toUpperCase(java.util.Locale.ROOT) : table;
        try (var indexes = metadata.getIndexInfo(connection.getCatalog(), null, tableName, false, false)) {
            while (indexes.next()) {
                if (index.equalsIgnoreCase(indexes.getString("INDEX_NAME"))) {
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
