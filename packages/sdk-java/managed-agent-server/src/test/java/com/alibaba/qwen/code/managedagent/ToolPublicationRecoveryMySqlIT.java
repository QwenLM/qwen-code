package com.alibaba.qwen.code.managedagent;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class ToolPublicationRecoveryMySqlIT {
    private JdbcTemplate admin;
    private String schema;
    private ToolPublicationStoreTest fixture;

    @BeforeEach
    void setup() {
        fixture = new ToolPublicationStoreTest() {
            @Override
            DataSource publicationDataSource() {
                return ToolPublicationRecoveryMySqlIT.this.publicationDataSource();
            }
        };
        fixture.setup();
    }

    private DataSource publicationDataSource() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "publication_recovery_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        return new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void recoversExpiredCandidatesWithoutChangingBytesQuotaOrOriginalDeadline(boolean terminal) throws Exception {
        fixture.recoversExpiredCandidatesWithoutChangingBytesQuotaOrOriginalDeadline(terminal);
    }

    @ParameterizedTest
    @CsvSource({"false,false", "false,true", "true,false", "true,true"})
    void resumesHeldWriteAfterDeadlineOrClaimExpiry(boolean terminal, boolean expired) throws Exception {
        fixture.resumesHeldWriteAfterDeadlineOrClaimExpiry(terminal, expired);
    }

    @Test
    void sealUsesCatalogBytesToFinishBeyondTheBaseDeadline() {
        fixture.sealUsesCatalogBytesToFinishBeyondTheBaseDeadline();
    }

    @Test
    void expiredPrefixRemainsExpiredAndFencedPublicationCannotRecover() {
        fixture.expiredPrefixRemainsExpiredAndFencedPublicationCannotRecover();
    }

    @Test
    void activePhaseWithExpiredDeadlinePreventsReserveRenewAndDispatch() {
        fixture.activePhaseWithExpiredDeadlinePreventsReserveRenewAndDispatch();
    }

    @AfterEach
    void removeTestSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
