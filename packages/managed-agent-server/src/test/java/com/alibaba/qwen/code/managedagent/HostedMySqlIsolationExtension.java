package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.ExtensionContext;

import java.sql.DriverManager;
import java.util.ArrayList;

public final class HostedMySqlIsolationExtension implements BeforeAllCallback {
    static final String ENABLED = "qwen.hosted.mysql.isolation";

    @Override
    public void beforeAll(ExtensionContext context) throws Exception {
        if (!context.getConfigurationParameter(ENABLED).map(Boolean::parseBoolean).orElse(false)) {
            return;
        }
        if (context.getParent().flatMap(ExtensionContext::getTestClass).isPresent()) {
            return;
        }
        String url = System.getProperty("mysql.url");
        String user = System.getProperty("mysql.user");
        if (url == null || user == null || !url.startsWith("jdbc:mysql://")) {
            throw new IllegalArgumentException(
                    "Hosted isolation requires a disposable mysql.url and mysql.user");
        }
        try (var connection = DriverManager.getConnection(url,
                user, System.getProperty("mysql.password", ""))) {
            ManagedSchema.requireApplicationCatalog(connection);
            var tables = new ArrayList<String>();
            try (var statement = connection.createStatement();
                    var rows = statement.executeQuery("SELECT TABLE_NAME FROM information_schema.TABLES"
                            + " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'")) {
                while (rows.next()) {
                    String table = rows.getString(1);
                    if (table.startsWith("ma_")) {
                        tables.add(table);
                    }
                }
            }
            // Foreign-key checks are connection-scoped; the toggle and every
            // truncate must use this same connection, before any context boots.
            try (var statement = connection.createStatement()) {
                statement.execute("SET FOREIGN_KEY_CHECKS = 0");
                try {
                    for (String table : tables) {
                        statement.execute("TRUNCATE TABLE `" + table.replace("`", "``") + "`");
                    }
                } finally {
                    statement.execute("SET FOREIGN_KEY_CHECKS = 1");
                }
            }
        }
    }
}
