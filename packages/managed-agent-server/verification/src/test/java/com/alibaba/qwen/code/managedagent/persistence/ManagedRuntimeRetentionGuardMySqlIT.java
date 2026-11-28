package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedRuntimeRetentionGuardMySqlIT {
    private static final String VARCHAR_512_PERMISSIVE =
            "ALTER TABLE ma_session_record MODIFY session_id VARCHAR(512)"
                    + " CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL";

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

    @Test
    void unsettledBackgroundShellRetainsBothIsolationModesUntilSettlement() throws Exception {
        contract.unsettledBackgroundShellRetainsBothIsolationModesUntilSettlement();
    }

    @Test
    void backgroundEvidenceRequiresExactIdentityGenerationKindAndProcessSuffix() throws Exception {
        contract.backgroundEvidenceRequiresExactIdentityGenerationKindAndProcessSuffix();
    }

    @Test
    void backgroundSettlementIsReadOnTheSweepConnection() throws Exception {
        contract.backgroundSettlementIsReadOnTheSweepConnection();
    }

    @Test
    void settledBackgroundVolumeWithOtherSessionNoiseDoesNotTimeoutTheGuard() throws Exception {
        contract.settledBackgroundVolumeWithOtherSessionNoiseDoesNotTimeoutTheGuard();
    }

    @Test
    void backgroundOwnersRemainDistinctUnderPermissiveCollation() throws Exception {
        // The contract then applies the same collation at the declared width,
        // which is the only legal form here: a 512-wide identity column would
        // push these tables' composite keys past InnoDB's 3072-byte limit.
        assertThatThrownBy(() -> contract.configureSessionRecordIdentity(VARCHAR_512_PERMISSIVE))
                .hasStackTraceContaining("Specified key was too long; max key length is 3072 bytes");
        contract.backgroundOwnersRemainDistinctUnderPermissiveCollation();
    }

    @Test
    void childLineageIsReadOnTheSweepConnection() throws Exception {
        contract.childLineageIsReadOnTheSweepConnection();
    }

    @Test
    void releasedRuntimeSessionWithMembershipPinsItsBindingUntilEvidenceCleanup() throws Exception {
        contract.releasedRuntimeSessionWithMembershipPinsItsBindingUntilEvidenceCleanup();
    }

    @Test
    void workspaceRetirementRetainsItsExactBindingAndGeneration() throws Exception {
        contract.workspaceRetirementRetainsItsExactBindingAndGeneration();
    }

    @Test
    void collectedPublicationUsesRawHashWithoutReadingItsPayload() throws Exception {
        contract.collectedPublicationUsesRawHashWithoutReadingItsPayload();
    }

    @Test
    void anActionVariantCannotBeMistakenForAnUnsettledBackgroundRun() throws Exception {
        contract.anActionVariantCannotBeMistakenForAnUnsettledBackgroundRun();
    }

    @AfterEach
    void removeTestSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
