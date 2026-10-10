package com.alibaba.qwen.code.managedagent.store;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** The collector suite on a real InnoDB engine, where the locking interleavings are observable. */
class SessionResourceCollectionMySqlIT extends SessionResourceCollectionCollectorTest {
    private JdbcTemplate admin;
    private String schema;

    @Override
    protected DataSource dataSource() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "stream_capture_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        return new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @AfterEach
    void dropSchema() {
        if (schema != null) {
            admin.execute("DROP DATABASE " + schema);
        }
    }
}
