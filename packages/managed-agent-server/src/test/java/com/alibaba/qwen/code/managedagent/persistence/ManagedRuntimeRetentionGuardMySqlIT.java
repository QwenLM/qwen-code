package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;

import java.util.UUID;

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
        contract.backgroundOwnersRemainDistinctUnderPermissiveCollation();
    }

    @Test
    void childLineageIsReadOnTheSweepConnection() throws Exception {
        contract.childLineageIsReadOnTheSweepConnection();
    }

    @Test
    void aCsiReservationWithNoHolderStillRetainsItsExactBinding() throws Exception {
        contract.aCsiReservationWithNoHolderStillRetainsItsExactBinding();
    }

    @Test
    void localHolderAndCsiRetirementRetainBindings() throws Exception {
        contract.localHolderAndCsiRetirementRetainBindings();
    }

    @Test
    void collectedPublicationUsesRawHashWithoutReadingItsPayload() throws Exception {
        contract.collectedPublicationUsesRawHashWithoutReadingItsPayload();
    }

    @Test
    void acknowledgementUsesRawHashAndSeesTheCallersUncommittedReference() throws Exception {
        contract.acknowledgementUsesRawHashAndSeesTheCallersUncommittedReference();
    }

    @Test
    void sharedWorkReferencesRequireTheCsiOperationAndAckKinds() throws Exception {
        contract.sharedWorkReferencesRequireTheCsiOperationAndAckKinds();
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
