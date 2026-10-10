package com.alibaba.qwen.code.managedagent.store;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class ManagedRuntimeRetentionGuardMySqlIT {
    private JdbcTemplate admin;
    private String schema;
    private ManagedRuntimeRetentionGuardTest contract;

    @BeforeEach
    void setup() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "retention_child_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        var source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        contract = new ManagedRuntimeRetentionGuardTest() {
            @Override
            DataSource dataSource() { return source; }
        };
        contract.setup();
    }

    @Test
    void unsettledChildRetainsDrainedBindingUntilCanonicalRunSettles() throws Exception {
        contract.unsettledChildRetainsDrainedBindingUntilCanonicalRunSettles();
    }

    @Test
    void aDifferentRawIdentityCannotEndChildProtection() throws Exception {
        contract.aDifferentRawIdentityCannotEndChildProtection();
    }

    @AfterEach
    void removeTestSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
