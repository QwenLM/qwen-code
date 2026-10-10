package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.EventIdentity;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Regression for issue #13182 finding 1: once managed_agent_event has a
 * sequence gap ahead of the projection cursor, the gap is permanent —
 * appendEvent allocates a sequence under the session row lock that
 * materializeNextBatch already holds, so no missing sequence can still
 * appear. The projection must skip the gap once instead of throwing on every
 * scan and wedging the session forever. The scans here run inside the same
 * TransactionTemplate boundary production gets from the @Transactional proxy,
 * because the permanence premise rests on the session row lock the scan
 * holds for the whole batch.
 */
class MessageProjectionGapHealTest {
    private static final String TENANT = "gap-heal";
    private final AtomicLong now = new AtomicLong(1_000);
    private JdbcTemplate jdbc;
    private JdbcDataSource dataSource;
    private TransactionTemplate transactions;

    @Test
    void aSequenceGapHealsInsteadOfWedgingTheProjection() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();

        // The session.created event landed at sequence 1 and materializes.
        materialize(store, sessionId);
        assertThat(covered(sessionId)).isEqualTo(1);

        // Events land at sequences 3 and 4 while sequence 2 never does (a
        // rolled back transaction, pruned retention, or a failed writer).
        // Two contiguous post-gap events with distinct items pin the heal to
        // report the gap exactly once, naming only the truly missing
        // sequence — a readvance that keeps `expected++` would log a second,
        // bogus gap between them.
        insertGapEvent(sessionId, 3, "turn-gap", "item.output_text.delta",
                "{\"text\":\"survives the gap\",\"itemId\":\"item-gap-3\"}");
        insertGapEvent(sessionId, 4, "turn-gap", "item.output_text.delta",
                "{\"text\":\"also survives\",\"itemId\":\"item-gap-4\"}");
        MessageMaterializer materializer = new MessageMaterializer(store,
                Clock.systemUTC());

        Logger storeLog = (Logger) LoggerFactory.getLogger(
                ManagedAgentStore.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        storeLog.addAppender(logged);
        try {
            // The first scan heals past the permanent gap instead of
            // throwing.
            assertThatCode(() -> materialize(store, sessionId))
                    .doesNotThrowAnyException();
        } finally {
            storeLog.detachAppender(logged);
        }
        assertThat(covered(sessionId)).isEqualTo(4);

        assertThat(logged.list)
                .filteredOn(event -> event.getFormattedMessage()
                        .contains("permanent event gap"))
                .singleElement()
                .satisfies(event -> {
                    assertThat(event.getLevel()).isEqualTo(Level.ERROR);
                    assertThat(event.getFormattedMessage())
                            .contains("missingSequences=2-2")
                            .contains("nextEvent=3");
                });

        // Both events after the gap were projected, not merely skipped:
        // their part rows exist in the materialized model.
        assertThat(partCount(sessionId, "survives the gap")).isEqualTo(1);
        assertThat(partCount(sessionId, "also survives")).isEqualTo(1);

        for (int run = 0; run < 10; run++) {
            // The healed session never re-enters the scanner's target list,
            // so every later scan is a no-op for it. (materialize() swallows
            // a failing target into a log line, so only the observable
            // database state can pin this.)
            assertThat(store.findMaterializationTargets(32)).isEmpty();
            materializer.materialize();
        }
        assertThat(covered(sessionId)).isEqualTo(4);

        // Re-scans must not have re-materialized the healed events:
        // appendPart would have grown their text with CONCAT.
        assertThat(partCount(sessionId, "survives the gap")).isEqualTo(1);
        assertThat(partCount(sessionId, "also survives")).isEqualTo(1);
        assertThat(store.findMaterializationTargets(32)).isEmpty();
    }

    // The gap's permanence rests on the session row lock: appendEvent
    // allocates a sequence under the same lock the scan holds. This pins
    // that the scan really holds it — a second connection holding the lock
    // must stall the scan.
    @Test
    void theScanHoldsTheSessionRowLockForTheWholeBatch() throws Exception {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        materialize(store, sessionId);
        insertGapEvent(sessionId, 3, "turn-gap", "item.output_text.delta",
                "{\"text\":\"survives the gap\",\"itemId\":\"item-gap-3\"}");

        Connection blocker = dataSource.getConnection();
        ExecutorService scans = Executors.newSingleThreadExecutor();
        try {
            blocker.setAutoCommit(false);
            try (var statement = blocker.prepareStatement(
                    "SELECT session_id FROM managed_agent_session WHERE"
                            + " tenant_id = ? AND session_id = ? FOR UPDATE")) {
                statement.setString(1, TENANT);
                statement.setString(2, sessionId);
                statement.executeQuery();
            }
            var scan = scans.submit(() -> {
                materialize(store, sessionId);
                return null;
            });
            assertThatThrownBy(() -> scan.get(500, TimeUnit.MILLISECONDS))
                    .isInstanceOf(TimeoutException.class);
            blocker.rollback();
            scan.get(10, TimeUnit.SECONDS);
        } finally {
            blocker.close();
            scans.shutdownNow();
        }
        assertThat(covered(sessionId)).isEqualTo(3);
    }

    // The skipped range may have carried a turn's terminal event, whose
    // settle is the only write that moves its items off in_progress: the
    // heal must settle those items as failed instead of pinning them (and
    // the snapshot they feed) at "streaming" forever. The fixture's turn
    // row is terminal: a live turn would instead be settled by its own
    // terminal event or by turn recovery, never by the heal.
    @Test
    void aLostTerminalTurnEventSettlesItsOrphanedItemsAsFailed() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        materialize(store, sessionId);
        assertThat(covered(sessionId)).isEqualTo(1);

        // turn-T opens and streams one assistant delta; its turn.completed
        // at sequence 4 is the event that never lands. turn-U follows at 5.
        // turn-T's row shows the turn over (the corrupted state this settle
        // defends: row and event commit in one transaction, so production
        // never produces this); turn-U's terminal event in the journal must
        // not protect turn-T's item.
        insertTurn(sessionId, "turn-T", "COMPLETED");
        insertTurn(sessionId, "turn-U", "COMPLETED");
        insertGapEvent(sessionId, 2, "turn-T", "turn.accepted",
                "{\"input\":[{\"text\":\"hi T\"}]}");
        insertGapEvent(sessionId, 3, "turn-T", "item.output_text.delta",
                "{\"text\":\"answer T\",\"itemId\":\"item-out-T\"}");
        insertGapEvent(sessionId, 5, "turn-U", "turn.accepted",
                "{\"input\":[{\"text\":\"hi U\"}]}");
        insertGapEvent(sessionId, 6, "turn-U", "turn.completed", "{}");

        assertThatCode(() -> materialize(store, sessionId))
                .doesNotThrowAnyException();
        assertThat(covered(sessionId)).isEqualTo(6);

        // The orphaned assistant item settles as failed; the already
        // completed input items are never re-settled.
        assertThat(itemStatus(sessionId, "item-out-T")).isEqualTo("failed");
        assertThat(itemStatus(sessionId,
                StoreModels.inputItemId("turn-T"))).isEqualTo("completed");
        assertThat(itemStatus(sessionId,
                StoreModels.inputItemId("turn-U"))).isEqualTo("completed");
        assertThat(store.findMaterializationTargets(32)).isEmpty();
    }

    // The compensating settle must not touch a turn whose events span the
    // gap: when the lost sequence is unrelated and the turn's terminal event
    // is still in the journal, its items stay in_progress until their own
    // turn.completed settles them.
    @Test
    void aTurnSpanningTheGapStillCompletesItsOwnItems() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        materialize(store, sessionId);
        assertThat(covered(sessionId)).isEqualTo(1);

        // turn-W opens and streams; sequence 4 is an unrelated loss; turn-W
        // continues past it — with a tool call, not another text delta, so
        // nothing re-pins the text item's status — and completes at 6.
        insertTurn(sessionId, "turn-W", "RUNNING");
        insertGapEvent(sessionId, 2, "turn-W", "turn.accepted",
                "{\"input\":[{\"text\":\"hi W\"}]}");
        insertGapEvent(sessionId, 3, "turn-W", "item.output_text.delta",
                "{\"text\":\"answer W\",\"itemId\":\"item-out-W\"}");
        insertGapEvent(sessionId, 5, "turn-W", "item.tool_call.updated",
                "{\"toolCallId\":\"call-1\",\"status\":\"completed\"}");
        insertGapEvent(sessionId, 6, "turn-W", "turn.completed", "{}");

        assertThatCode(() -> materialize(store, sessionId))
                .doesNotThrowAnyException();
        assertThat(covered(sessionId)).isEqualTo(6);
        assertThat(itemStatus(sessionId, "item-out-W"))
                .isEqualTo("completed");
        assertThat(store.findMaterializationTargets(32)).isEmpty();
    }

    // The first guard's own shape: the turn's row is already terminal and
    // its terminal event is committed past the gap but not yet
    // materialized. The heal must leave its in-flight item alone — the
    // event's own settle completes it.
    @Test
    void aCommittedTerminalEventPastTheGapProtectsItsItems() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        materialize(store, sessionId);
        assertThat(covered(sessionId)).isEqualTo(1);

        insertTurn(sessionId, "turn-V", "COMPLETED");
        insertGapEvent(sessionId, 2, "turn-V", "turn.accepted",
                "{\"input\":[{\"text\":\"hi V\"}]}");
        insertGapEvent(sessionId, 3, "turn-V", "item.output_text.delta",
                "{\"text\":\"answer V\",\"itemId\":\"item-out-V\"}");
        // Sequence 4 is lost; turn-V's terminal event is committed at 6.
        insertGapEvent(sessionId, 5, "turn-V", "item.tool_call.updated",
                "{\"toolCallId\":\"call-1\",\"status\":\"completed\"}");
        insertGapEvent(sessionId, 6, "turn-V", "turn.completed", "{}");

        assertThatCode(() -> materialize(store, sessionId))
                .doesNotThrowAnyException();
        assertThat(covered(sessionId)).isEqualTo(6);
        assertThat(itemStatus(sessionId, "item-out-V"))
                .isEqualTo("completed");
    }

    // The mid-turn shape: the gap opens while the turn is still running, so
    // its terminal event has not been written yet. The heal must leave the
    // turn's items alone — its own terminal event (or turn recovery's
    // turn.failed) settles them.
    @Test
    void aGapInsideARunningTurnLeavesItsItemsStreaming() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        materialize(store, sessionId);
        assertThat(covered(sessionId)).isEqualTo(1);

        insertTurn(sessionId, "turn-W", "RUNNING");
        insertGapEvent(sessionId, 2, "turn-W", "turn.accepted",
                "{\"input\":[{\"text\":\"hi W\"}]}");
        insertGapEvent(sessionId, 3, "turn-W", "item.output_text.delta",
                "{\"text\":\"answer W\",\"itemId\":\"item-out-W\"}");
        // Sequence 4 is lost; the next event is another turn's, and turn-W
        // has no terminal event anywhere yet.
        insertGapEvent(sessionId, 5, "turn-U", "turn.accepted",
                "{\"input\":[{\"text\":\"hi U\"}]}");

        assertThatCode(() -> materialize(store, sessionId))
                .doesNotThrowAnyException();
        assertThat(covered(sessionId)).isEqualTo(5);
        assertThat(itemStatus(sessionId, "item-out-W"))
                .isEqualTo("in_progress");
        assertThat(store.findMaterializationTargets(32)).isEmpty();
    }

    private void materialize(ManagedAgentStore store, String sessionId) {
        transactions.executeWithoutResult(transaction ->
                store.materializeNextBatch(TENANT, sessionId, 200));
    }

    private long covered(String sessionId) {
        return jdbc.queryForObject("SELECT covered_sequence FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name ="
                        + " 'message_projection'",
                Long.class, TENANT, sessionId);
    }

    private int partCount(String sessionId, String text) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_item_part WHERE tenant_id = ? AND"
                        + " session_id = ? AND part_text = ?",
                Integer.class, TENANT, sessionId, text);
    }

    private String itemStatus(String sessionId, String itemId) {
        return jdbc.queryForObject("SELECT item_status FROM"
                        + " managed_agent_item WHERE tenant_id = ? AND"
                        + " session_id = ? AND item_id = ?",
                String.class, TENANT, sessionId, itemId);
    }

    private void insertTurn(String sessionId, String turnId, String status) {
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, created_at, updated_at) VALUES (?, ?, ?,"
                        + " ?, '[]', 'digest', ?, ?, ?)",
                TENANT, sessionId, turnId, "prompt-" + turnId, status,
                now.get(), now.get());
    }

    private void insertGapEvent(String sessionId, long sequence,
            String turnId, String type, String data) {
        // A projectable event type, so the test can witness that events after
        // the gap are still materialized, not merely skipped over.
        jdbc.update("INSERT INTO managed_agent_event (tenant_id, session_id,"
                        + " sequence_id, event_id, turn_id, event_type,"
                        + " data_json, terminal, source_key, created_at,"
                        + " schema_version, projection_version, item_id,"
                        + " content_part_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?)",
                TENANT, sessionId, sequence, "evt-gap-" + sequence,
                turnId, type, data,
                false, "gap-source-" + sequence,
                now.get(), EventIdentity.SCHEMA_VERSION,
                EventIdentity.PROJECTION_VERSION, null, null);
        jdbc.update("UPDATE managed_agent_session SET last_sequence = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                sequence, TENANT, sessionId);
    }

    private ManagedAgentStore store() {
        dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:gap-heal-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
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
