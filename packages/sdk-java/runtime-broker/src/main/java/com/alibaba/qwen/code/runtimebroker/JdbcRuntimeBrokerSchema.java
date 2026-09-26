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
            addStorageColumn(statement, "qwen_runtime_binding_slot");
            addStorageColumn(statement, "qwen_runtime_binding");
        } catch (SQLException exception) {
            throw JdbcRepositorySupport.failure(exception);
        }
    }

    private static void addStorageColumn(Statement statement, String table)
            throws SQLException {
        if (hasStorageColumn(statement, table)) {
            return;
        }
        try {
            statement.execute("ALTER TABLE " + table
                    + " ADD COLUMN storage_id VARCHAR(256)");
        } catch (SQLException failure) {
            // Another instance may have added it since the check.
            if (!hasStorageColumn(statement, table)) {
                throw failure;
            }
        }
    }

    private static boolean hasStorageColumn(Statement statement, String table)
            throws SQLException {
        try (java.sql.ResultSet result = statement.executeQuery(
                "SELECT * FROM " + table + " WHERE 1 = 0")) {
            java.sql.ResultSetMetaData columns = result.getMetaData();
            for (int index = 1; index <= columns.getColumnCount(); index++) {
                if ("storage_id".equalsIgnoreCase(columns.getColumnName(index))) {
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
