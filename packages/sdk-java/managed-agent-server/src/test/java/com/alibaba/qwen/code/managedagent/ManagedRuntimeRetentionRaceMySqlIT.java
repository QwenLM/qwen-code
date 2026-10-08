package com.alibaba.qwen.code.managedagent;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class ManagedRuntimeRetentionRaceMySqlIT {
    private JdbcTemplate admin;
    private String schema;
    private ManagedRuntimeRetentionRaceTest contract;

    @BeforeEach
    void setup() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "retention_race_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        var source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        contract = new ManagedRuntimeRetentionRaceTest() {
            @Override
            DataSource dataSource() { return source; }
        };
    }

    @ParameterizedTest
    @EnumSource(ManagedRuntimeRetentionRaceTest.Reference.class)
    void seesReferencesCommittedAfterTheSweepTransactionStarted(ManagedRuntimeRetentionRaceTest.Reference reference) throws Exception {
        contract.seesReferencesCommittedAfterTheSweepTransactionStarted(reference);
    }

    @ParameterizedTest
    @EnumSource(ManagedRuntimeRetentionRaceTest.Reference.class)
    void writersCannotCreateDanglingReferencesAfterTheSweepLocksTheRetiredBinding(
            ManagedRuntimeRetentionRaceTest.Reference reference) throws Exception {
        contract.writersCannotCreateDanglingReferencesAfterTheSweepLocksTheRetiredBinding(reference);
    }

    @AfterEach
    void removeTestSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
