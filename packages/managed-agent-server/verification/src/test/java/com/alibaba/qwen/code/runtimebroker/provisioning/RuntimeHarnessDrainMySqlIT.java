package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.DriverManagerDataSource;
import com.alibaba.qwen.code.runtimebroker.managedschema.JdbcRuntimeBrokerSchema;
import org.junit.jupiter.api.AfterEach;

import java.sql.DriverManager;
import java.util.UUID;

class RuntimeHarnessDrainMySqlIT extends RuntimeHarnessDrainTest {
    private Database database;

    @Override
    javax.sql.DataSource createSource() {
        try {
            database = createDatabase();
            return database.source();
        } catch (Exception failure) {
            throw new IllegalStateException("Cannot create the MySQL drain fixture", failure);
        }
    }

    @AfterEach
    void dropDatabase() throws Exception {
        try (var connection = DriverManager.getConnection(database.adminUrl(), database.user(), database.password());
                var statement = connection.createStatement()) {
            statement.execute("DROP DATABASE IF EXISTS " + database.schema());
        }
    }

    private static Database createDatabase() throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user", "root");
        String password = System.getProperty("mysql.password", "");
        String schema = "drain_" + UUID.randomUUID().toString().replace("-", "");
        try (var connection = DriverManager.getConnection(url, user, password); var statement = connection.createStatement()) {
            statement.execute("CREATE DATABASE " + schema);
        }
        var source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        JdbcRuntimeBrokerSchema.initialize(source);
        return new Database(source, url, schema, user, password);
    }

    private record Database(javax.sql.DataSource source, String adminUrl, String schema, String user, String password) { }
}
