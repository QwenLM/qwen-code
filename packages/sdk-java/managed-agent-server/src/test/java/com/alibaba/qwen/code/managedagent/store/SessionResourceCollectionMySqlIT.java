package com.alibaba.qwen.code.managedagent.store;

import java.util.ArrayList;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The collector suite on a real InnoDB engine, where the locking interleavings are observable.
 * One schema serves the whole class: a per-test database re-ran every Flyway migration for each
 * inherited test, and that bootstrap dominated the MariaDB CI job's timeout budget. Truncating
 * every table after each test keeps the same isolation.
 */
class SessionResourceCollectionMySqlIT extends SessionResourceCollectionCollectorTest {
    private static JdbcTemplate admin;
    private static String schema;
    private static DriverManagerDataSource data;

    @BeforeAll
    static void createSchema() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "stream_capture_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @Override
    protected DataSource dataSource() {
        return data;
    }

    @AfterEach
    void truncateTables() {
        // FOREIGN_KEY_CHECKS is session-scoped and a DriverManagerDataSource hands out a fresh
        // connection per call, so the toggle and the truncates must share one connection.
        admin.execute((ConnectionCallback<Void>) connection -> {
            try (var statement = connection.createStatement()) {
                var found = statement.executeQuery("SELECT TABLE_NAME FROM information_schema.TABLES"
                        + " WHERE TABLE_SCHEMA = '" + schema + "' AND TABLE_TYPE = 'BASE TABLE'");
                var tables = new ArrayList<String>();
                while (found.next()) {
                    tables.add(found.getString(1));
                }
                statement.execute("SET FOREIGN_KEY_CHECKS = 0");
                try {
                    for (String table : tables) {
                        if (!table.equals("flyway_schema_history")) {
                            statement.execute("TRUNCATE TABLE " + schema + "." + table);
                        }
                    }
                } finally {
                    statement.execute("SET FOREIGN_KEY_CHECKS = 1");
                }
            }
            return null;
        });
    }

    @AfterAll
    static void dropSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
