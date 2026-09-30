package com.alibaba.qwen.code.managedagent.store;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Assumptions;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Creates and drops only a fresh, explicitly named O4 test database. */
final class O4MySqlDatabase implements AutoCloseable {
    private final JdbcTemplate admin;
    private final String database;
    private final String url;
    private final String user;
    private final DriverManagerDataSource source;

    O4MySqlDatabase() {
        String base = System.getProperty("qwen.o4.mysql.url");
        if (!Boolean.getBoolean("qwen.o4.required")) { Assumptions.assumeTrue(base != null, "O4 MySQL not configured"); }
        if (base == null || !base.matches("jdbc:mysql://[a-zA-Z0-9.:-]+/qwen_o4_[a-zA-Z0-9_]+")) {
            throw new IllegalArgumentException("O4 requires a dedicated qwen_o4_ MySQL URL without credentials or query parameters");
        }
        database = "qwen_o4_" + UUID.randomUUID().toString().replace("-", "");
        user = System.getProperty("qwen.o4.mysql.user", "root");
        String password = System.getenv().getOrDefault("QWEN_O4_MYSQL_PASSWORD", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(base, user, password));
        admin.execute("CREATE DATABASE `" + database + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
        url = base.substring(0, base.lastIndexOf('/') + 1) + database;
        source = new DriverManagerDataSource(url, user, password);
    }

    DataSource source() { return source; }
    String url() { return url; }
    String user() { return user; }
    @Override public void close() { admin.execute("DROP DATABASE `" + database + "`"); }
}
