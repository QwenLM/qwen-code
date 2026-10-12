package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
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
 * Pins the deferral SQL on H2 in MySQL mode against the three columns the
 * target scan reads: {@code updated_at} moves so the target rotates behind
 * fresher rows, {@code covered_sequence} stays put so the gap guard in
 * materializeNextBatch still freezes on a failure, and
 * {@code snapshot_stale_since} stays put so a session whose snapshot
 * rewrite was deferred keeps being re-selected.
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
                        + " updated_at, snapshot_stale_since) VALUES (?, ?,"
                        + " ?, ?, ?, ?)",
                "tenant", "session", "message_projection", 9L, 1L, 7L);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(),
                Clock.fixed(Instant.ofEpochMilli(123456789L),
                        ZoneOffset.UTC),
                ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());

        store.deferMaterializationTarget("tenant", "session");

        var row = jdbc.queryForMap("SELECT covered_sequence, updated_at,"
                        + " snapshot_stale_since FROM"
                        + " managed_agent_consumer_progress WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " consumer_name = ?",
                "tenant", "session", "message_projection");
        assertThat(row.get("updated_at")).isEqualTo(123456789L);
        assertThat(row.get("covered_sequence")).isEqualTo(9L);
        assertThat(row.get("snapshot_stale_since")).isEqualTo(7L);
    }

    /**
     * The deferral's purpose: rotate a poisoned target behind fresher rows
     * so it drops out of the selection window. Pins the composition with
     * {@code findMaterializationTargets}' {@code ORDER BY p.updated_at ASC}
     * — flipping it to DESC inverts the deferral and starves the sessions
     * outside the window.
     */
    @Test
    void deferralRotatesTheTargetBehindFresherRows() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:materialization-rotate-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        for (int i = 0; i < 3; i++) {
            String session = "session-" + i;
            jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                            + " session_id, agent_id, status, created_at,"
                            + " updated_at, last_sequence) VALUES (?, ?, ?,"
                            + " ?, ?, ?, ?)",
                    "tenant", session, "qwen-code", "ACTIVE", 1L, 1L, 9L);
            // updated_at 1000/2000/3000, all below the fixed clock:
            // session-0 is the stalest row and heads the selection window.
            jdbc.update("INSERT INTO managed_agent_consumer_progress"
                            + " (tenant_id, session_id, consumer_name,"
                            + " covered_sequence, updated_at) VALUES"
                            + " (?, ?, ?, ?, ?)",
                    "tenant", session, "message_projection", 1L,
                    1000L * (i + 1));
        }
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(),
                Clock.fixed(Instant.ofEpochMilli(123456789L),
                        ZoneOffset.UTC),
                ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());

        assertThat(store.findMaterializationTargets(2))
                .containsExactly(
                        new MaterializationTarget("tenant", "session-0"),
                        new MaterializationTarget("tenant", "session-1"));

        store.deferMaterializationTarget("tenant", "session-0");

        assertThat(store.findMaterializationTargets(2))
                .containsExactly(
                        new MaterializationTarget("tenant", "session-1"),
                        new MaterializationTarget("tenant", "session-2"));
    }
}
