package com.alibaba.qwen.code.runtimebroker;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

class JdbcRuntimeRetentionMySqlIT {
    @Test
    void retentionProgressRollbackAndConcurrentSweepersOnMySql() throws Exception {
        withFreshDatabase(JdbcRuntimeRetentionTest::verifyOnDatabase);
    }

    @Test
    void placementKeepsExactIdentitiesWithoutDecryptingHistoricalRowsOnMySql() throws Exception {
        withFreshDatabase(JdbcPlacementGuardTest::verifyOnDatabase);
    }

    private static void withFreshDatabase(DatabaseCheck check) throws Exception {
        String schema = "broker_retention_" + UUID.randomUUID().toString().replace("-", "");
        String url = required("mysql.url");
        String user = required("mysql.user");
        String password = System.getProperty("mysql.password", "");
        DataSource admin = new DriverManagerDataSource(url, user, password);
        try (var connection = admin.getConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        }
        try {
            DataSource source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema),
                    user, password);
            check.verify(source);
        } finally {
            try (var connection = admin.getConnection(); var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS " + schema);
            }
        }
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }

    @FunctionalInterface
    private interface DatabaseCheck {
        void verify(DataSource source) throws Exception;
    }
}
