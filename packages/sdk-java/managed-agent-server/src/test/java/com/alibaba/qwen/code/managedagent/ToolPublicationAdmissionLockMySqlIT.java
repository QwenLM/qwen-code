package com.alibaba.qwen.code.managedagent;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

@Timeout(30)
class ToolPublicationAdmissionLockMySqlIT {
    private JdbcTemplate admin;
    private String database;

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void receiptDoesNotHoldTenantWhileWaitingForNativeParent(boolean replay) throws Exception {
        var fixture = new ToolPublicationAdmissionLockTest() {
            @Override
            DataSource publicationDataSource() {
                String url = System.getProperty("mysql.url");
                if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
                    throw new IllegalArgumentException("A MySQL test database URL is required");
                }
                String user = System.getProperty("mysql.user");
                String password = System.getProperty("mysql.password", "");
                admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
                database = "receipt_parent_" + UUID.randomUUID().toString().replace("-", "");
                admin.execute("CREATE DATABASE " + database);
                return new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + database), user, password);
            }
        };
        fixture.receiptDoesNotHoldTenantWhileWaitingForNativeParent(replay);
    }

    @AfterEach
    void removeOwnedDatabase() {
        if (admin != null && database != null) {
            admin.execute("DROP DATABASE IF EXISTS " + database);
        }
    }
}
