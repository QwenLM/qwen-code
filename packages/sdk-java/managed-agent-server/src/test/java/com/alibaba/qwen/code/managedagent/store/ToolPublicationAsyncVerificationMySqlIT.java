package com.alibaba.qwen.code.managedagent.store;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class ToolPublicationAsyncVerificationMySqlIT extends ToolPublicationAsyncVerificationTest {
    private JdbcTemplate admin;
    private final List<String> schemas = new ArrayList<>();

    @Override
    protected DataSource dataSource() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "publication_async_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        schemas.add(schema);
        return new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @AfterEach
    void removeSchema() {
        if (admin != null) {
            for (String schema : schemas) {
                admin.execute("DROP DATABASE IF EXISTS " + schema);
            }
        }
    }
}
