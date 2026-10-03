package com.alibaba.qwen.code.managedagent.store;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class WorkspaceRecoveryMySqlIT {
    @TempDir Path temporary;
    private JdbcTemplate admin;
    private String schema;
    private String url;
    private String user;
    private String password;
    private WorkspaceRecoveryStoreTest fixture;

    @BeforeEach
    void setup() throws Exception {
        url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        user = System.getProperty("mysql.user");
        password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "workspace_recovery_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        url = url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema);
        fixture = new WorkspaceRecoveryStoreTest() {
            @Override
            DataSource recoveryDataSource() {
                return recoveryDataSource("UTC");
            }

            @Override
            DataSource recoveryDataSource(String connectionTimeZone) {
                return new DriverManagerDataSource(url + (url.contains("?") ? "&" : "?")
                        + "connectionTimeZone=" + URLEncoder.encode(connectionTimeZone, StandardCharsets.UTF_8),
                        user, password);
            }
        };
        fixture.temporary = temporary;
        fixture.setUp();
    }

    @Test
    void pinsRetainedRetirementWithoutReopeningItsCheckpointOrWriter() {
        fixture.pinsRetainedRetirementWithoutReopeningItsCheckpointOrWriter();
    }

    @Test
    void retirementDriftInvalidatesThePinnedCut() {
        fixture.retirementDriftInvalidatesThePinnedCut();
    }

    @Test
    void leaseFingerprintKeepsWallClockPrecisionAcrossConnectionTimeZones() {
        fixture.leaseFingerprintKeepsWallClockPrecisionAcrossConnectionTimeZones();
    }

    @AfterEach
    void cleanup() {
        if (admin != null && schema != null) admin.execute("DROP DATABASE IF EXISTS " + schema);
    }
}
