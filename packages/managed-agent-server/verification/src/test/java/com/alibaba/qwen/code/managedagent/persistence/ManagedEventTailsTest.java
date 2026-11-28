package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionKey;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.UUID;

/**
 * The cross-instance stream wake-up reads every locally followed Session's
 * public event tail in one batched query; it must name each Session by tenant
 * and Session together and never return a Session it was not asked for.
 */
class ManagedEventTailsTest {
    private ManagedEventTailsFixture fixture;

    @BeforeEach
    void setUp() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:event-tails-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        fixture = new ManagedEventTailsFixture(source);
    }

    @Test
    void readsEachRequestedTailAcrossTenantsOnly() {
        fixture.readsEachRequestedTailAcrossTenantsOnly();
    }

    @Test
    void splitsALargeRequestIntoBatches() {
        fixture.splitsALargeRequestIntoBatches();
    }

    static ManagedAgentStore store(DataSource source) {
        ManagedSchema.initialize(source);
        ManagedSchemaJdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(source);
        return VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                ignored -> {}, new JdbcManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties(),
                new SdkHarnessRules());
    }

    static SessionKey key(String tenant, String session) {
        return new SessionKey(tenant, session);
    }
}
