package com.alibaba.qwen.code.managedagent;

import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/**
 * Runs the shared H5 channel persistence contract against the Flyway schema
 * on H2 in MySQL mode; a MySQL gate runs the same contract elsewhere.
 */
class ManagedChannelJdbcContractTest {
    @Test
    void channelPersistenceKeepsItsContractOnTheFlywaySchema()
            throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:channel-contract-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        ManagedChannelJdbcContract.verify(dataSource,
                "h2-" + UUID.randomUUID());
    }
}
