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
        } catch (SQLException exception) {
            throw JdbcRepositorySupport.failure(exception);
        }
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
