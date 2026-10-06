package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Pins the deferral SQL on H2 in MySQL mode: {@code updated_at} moves so
 * the target rotates behind fresher rows, and {@code covered_sequence}
 * stays put so the gap guard in materializeNextBatch still freezes on a
 * failure.
 */
class ManagedMaterializationDeferTest {
    @Test
    void deferMovesUpdatedAtButNotTheCoveredSequence() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:materialization-defer-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at, last_sequence) VALUES (?, ?, ?, ?,"
                        + " ?, ?, ?)",
                "tenant", "session", "qwen-code", "ACTIVE", 1L, 1L, 9L);
        jdbc.update("INSERT INTO managed_agent_consumer_progress (tenant_id,"
                        + " session_id, consumer_name, covered_sequence,"
                        + " updated_at) VALUES (?, ?, ?, ?, ?)",
                "tenant", "session", "message_projection", 9L, 1L);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(),
                Clock.fixed(Instant.ofEpochMilli(123456789L),
                        ZoneOffset.UTC),
                ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());

        store.deferMaterializationTarget("tenant", "session");

        var row = jdbc.queryForMap("SELECT covered_sequence, updated_at"
                        + " FROM managed_agent_consumer_progress WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " consumer_name = ?",
                "tenant", "session", "message_projection");
        assertThat(row.get("updated_at")).isEqualTo(123456789L);
        assertThat(row.get("covered_sequence")).isEqualTo(9L);
    }
}
