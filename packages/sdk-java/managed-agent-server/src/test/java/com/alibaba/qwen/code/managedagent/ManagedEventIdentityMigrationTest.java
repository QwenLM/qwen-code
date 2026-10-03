package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.IntStream;
import java.util.stream.LongStream;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Upgrades events written before V14 on H2 in MySQL mode; ManagedAgentMySqlIT
 * runs the same upgrade on MySQL.
 */
class ManagedEventIdentityMigrationTest {
    @Test
    void backfillsTheIdentityThatTheSnapshotUses() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:event-identity-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("1")).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String tenant = "legacy-tenant";
        String session = "legacy-session";
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at, last_sequence) VALUES (?, ?, ?, ?, ?,"
                        + " ?, ?)",
                tenant, session, "qwen-code", "IDLE", 1L, 1L, 10L);
        LegacyEvents.insert(jdbc, tenant, session);
        // One text Part longer than a page of the backfill.
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at, last_sequence) VALUES (?, ?, ?, ?, ?,"
                        + " ?, ?)",
                tenant, "long-session", "qwen-code", "IDLE", 1L, 1L, 6000L);
        jdbc.batchUpdate("INSERT INTO managed_agent_event (tenant_id,"
                        + " session_id, sequence_id, event_id, turn_id,"
                        + " event_type, data_json, terminal, created_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, 1)",
                LongStream.rangeClosed(1, 6000).mapToObj(sequence ->
                        new Object[] {tenant, "long-session", sequence,
                                "evt_long_" + sequence, "turn_long",
                                "item.output_text.delta",
                                "{\"text\":\"x\"}"}).toList());
        // More Sessions than a page of the enumeration, split over two
        // tenants so that the page boundary falls inside a tenant.
        List<String[]> many = IntStream.range(0, 1500).mapToObj(index ->
                new String[] {index < 700 ? "legacy-a" : "legacy-b",
                        "many-" + index}).toList();
        jdbc.batchUpdate("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at, last_sequence) VALUES (?, ?,"
                        + " 'qwen-code', 'IDLE', 1, 1, 1)",
                many.stream().map(key -> new Object[] {key[0], key[1]})
                        .toList());
        jdbc.batchUpdate("INSERT INTO managed_agent_event (tenant_id,"
                        + " session_id, sequence_id, event_id, turn_id,"
                        + " event_type, data_json, terminal, created_at)"
                        + " VALUES (?, ?, 1, ?, 'turn_many',"
                        + " 'item.output_text.delta', '{\"text\":\"x\"}',"
                        + " FALSE, 1)",
                many.stream().map(key -> new Object[] {key[0], key[1],
                        "evt_" + key[1]}).toList());

        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();

        LegacyEvents.assertBackfilled(jdbc, tenant, session);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_event WHERE session_id LIKE 'many-%'"
                        + " AND content_part_id ="
                        + " 'part_turn_many_output_text_1'",
                Integer.class)).isEqualTo(1500);
        assertThat(jdbc.queryForList("SELECT DISTINCT item_id,"
                        + " content_part_id FROM managed_agent_event WHERE"
                        + " session_id = 'long-session'"))
                .containsExactly(Map.of("item_id", "item_turn_long_assistant",
                        "content_part_id", "part_turn_long_output_text_1"));
        assertThat(jdbc.queryForObject("SELECT replay_floor_sequence FROM"
                        + " managed_agent_session WHERE session_id = ?",
                Long.class, session)).isZero();
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        store.materializeNextBatch(tenant, session, 100);
        List<ItemRecord> items = store.findSnapshot(tenant, session)
                .orElseThrow().items();
        store.findEvents(tenant, session, 0, 100).stream()
                .filter(event -> event.itemId() != null)
                .forEach(event -> {
                    ItemRecord item = items.stream().filter(candidate ->
                            candidate.itemId().equals(event.itemId()))
                            .findFirst().orElseThrow();
                    if (event.contentPartId() != null) {
                        assertThat(item.content()).extracting(
                                part -> part.partId())
                                .contains(event.contentPartId());
                    }
                });
        assertThat(items).extracting(ItemRecord::itemId).contains(
                "item_turn_legacy_input", "item_turn_legacy_assistant");
    }
}
