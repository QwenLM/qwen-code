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
 * columns (V46) so upgrade paths keep reading operations. The MariaDB
 * retention IT pins the same V31 but migrates before constructing its
 * store, so it never reads against the pre-V46 schema — this test is the
 * only place the mapper's missing-column branch runs.
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
        // A row under the pinned schema exercises the operation mapper
        // itself: an empty-table pass would never run it.
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                + " session_id, agent_id, status, created_at, updated_at)"
                + " VALUES ('t', 's', 'qwen-code', 'ACTIVE', 0, 0)");
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                + " session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state,"
                + " admission_stage, delivery_state, session_status_before,"
                + " available_at, created_at, updated_at) VALUES ('t', 's',"
                + " 'op-1', 'CLOSE', 'actor', 'key', 'digest', 'PENDING',"
                + " 'JAVA_DURABLE', 'PENDING', 'ACTIVE', 0, 0, 0)");
        // Pinned at V31 the operation table has no cwd columns: the read
        // must answer instead of failing with bad SQL grammar.
        assertThat(store.findOperation("t", "s", "op-1")).isPresent()
                .hasValueSatisfying(operation -> {
                    assertThat(operation.targetCwdRelative()).isNull();
                    assertThat(operation.expectedContextRevision()).isNull();
                    assertThat(operation.resultContextRevision()).isNull();
                });

        // After the upgrade the same reads work unchanged.
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        assertThat(store.findOperation("t", "s", "op-1")).isPresent()
                .hasValueSatisfying(operation ->
                    assertThat(operation.expectedContextRevision()).isNull());
    }
}
