package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * An additive operation-table migration must not break the store against a
 * schema that predates it: the operation mapper tolerates missing cwd
 * columns (V34) so upgrade paths like the MariaDB retention IT, which pins
 * a V31 schema before upgrading, keep reading operations. The H2 twin of
 * that invariant stays fast enough to run in the unit suite.
 */
class ManagedOperationSchemaUpgradeTest {

    @Test
    void operationReadsTolerateSchemasPredatingTheCwdColumns() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:upgrade-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").target("31").load()
                .migrate();
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        // Pinned at V31 the operation table has no cwd columns: the read
        // must answer instead of failing with bad SQL grammar.
        assertThat(store.findOperation("tenant", "session", "op"))
                .isEmpty();

        // After the upgrade the same reads work unchanged.
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        assertThat(store.findOperation("tenant", "session", "op"))
                .isEmpty();
    }
}
