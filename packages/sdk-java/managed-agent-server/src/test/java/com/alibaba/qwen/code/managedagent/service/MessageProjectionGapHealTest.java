package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.EventIdentity;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Regression for issue #13182 finding 1: once managed_agent_event has a
 * sequence gap ahead of the projection cursor, the gap is permanent —
 * appendEvent allocates a sequence under the session row lock that
 * materializeNextBatch already holds, so no missing sequence can still
 * appear. The projection must skip the gap once instead of throwing on every
 * scan and wedging the session forever.
 */
class MessageProjectionGapHealTest {
    private static final String TENANT = "gap-heal";
    private final AtomicLong now = new AtomicLong(1_000);
    private JdbcTemplate jdbc;

    @Test
    void aSequenceGapHealsInsteadOfWedgingTheProjection() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();

        // The session.created event landed at sequence 1 and materializes.
        store.materializeNextBatch(TENANT, sessionId, 200);
        assertThat(covered(sessionId)).isEqualTo(1);

        // An event lands at sequence 3 while sequence 2 never does (a rolled
        // back transaction, pruned retention, or a failed writer).
        insertGapEvent(sessionId, 3);
        MessageMaterializer materializer = new MessageMaterializer(store);

        // The first scan heals past the permanent gap instead of throwing,
        // and every later scan is a no-op.
        assertThatCode(() -> store.materializeNextBatch(TENANT, sessionId,
                200)).doesNotThrowAnyException();
        assertThat(covered(sessionId)).isEqualTo(3);

        // The event after the gap was projected, not merely skipped: its
        // part row exists in the materialized model.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_item_part WHERE tenant_id = ? AND"
                        + " session_id = ? AND part_text = ?",
                Integer.class, TENANT, sessionId, "survives the gap"))
                .isEqualTo(1);

        for (int run = 0; run < 10; run++) {
            assertThatCode(() -> store.materializeNextBatch(TENANT, sessionId,
                    200)).doesNotThrowAnyException();
            materializer.materialize();
        }
        assertThat(covered(sessionId)).isEqualTo(3);

        // The session leaves the scanner's target list, so the loop stops.
        assertThat(store.findMaterializationTargets(32)).isEmpty();
    }

    private long covered(String sessionId) {
        return jdbc.queryForObject("SELECT covered_sequence FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name ="
                        + " 'message_projection'",
                Long.class, TENANT, sessionId);
    }

    private void insertGapEvent(String sessionId, long sequence) {
        // A projectable event type, so the test can witness that events after
        // the gap are still materialized, not merely skipped over.
        jdbc.update("INSERT INTO managed_agent_event (tenant_id, session_id,"
                        + " sequence_id, event_id, turn_id, event_type,"
                        + " data_json, terminal, source_key, created_at,"
                        + " schema_version, projection_version, item_id,"
                        + " content_part_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?)",
                TENANT, sessionId, sequence, "evt-gap-" + sequence,
                "turn-gap", "item.output_text.delta",
                "{\"text\":\"survives the gap\",\"itemId\":\"item-gap\"}",
                false, "gap-source-" + sequence,
                now.get(), EventIdentity.SCHEMA_VERSION,
                EventIdentity.PROJECTION_VERSION, null, null);
        jdbc.update("UPDATE managed_agent_session SET last_sequence = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                sequence, TENANT, sessionId);
    }

    private ManagedAgentStore store() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:gap-heal-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        return new ManagedAgentStore(jdbc, new ObjectMapper(), new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return Instant.ofEpochMilli(now.get());
            }
        }, ignored -> {
        }, new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
    }
}
