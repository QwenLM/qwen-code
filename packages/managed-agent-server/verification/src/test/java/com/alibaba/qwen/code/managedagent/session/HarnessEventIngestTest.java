package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.IngestEventsRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.IngestReceipt;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class HarnessEventIngestTest {
    private static final String TENANT = "ingest-tenant";
    private static final String WRITER = "11111111-1111-4111-8111-111111111111";
    private static final String OWNER = HarnessEventIngest.OWNER_PREFIX + WRITER;
    private static final String EPOCH = "epoch_1";
    private final AtomicLong now = new AtomicLong(1_000_000);
    private final AtomicLong committed = new AtomicLong();
    private ManagedAgentStore store;
    private JdbcTemplate jdbc;
    private HarnessEventIngest ingest;
    private String sessionId;
    private TurnRecord turn;

    @BeforeEach
    void setUp() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:event-ingest-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        Clock clock = new Clock() {
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
        };
        ManagedAgentProperties properties = new ManagedAgentProperties();
        store = VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), clock,
                ignored -> {}, new JdbcManagedWorkspaceRegistry(jdbc), properties,
                new SdkHarnessRules());
        sessionId = store.insertSessionCommand(TENANT, "CREATE_SESSION", "create", "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        String turnId = store.insertTurnCommand(TENANT, "SUBMIT_TURN", "submit", "digest", sessionId,
                List.of(Map.of("type", "text", "text", "hello")), "sha256:" + "c".repeat(64), "actor")
                .turnId();
        assertThat(store.claimTurn(TENANT, sessionId, turnId, "dispatcher", Duration.ofMinutes(1)))
                .isPresent();
        store.recordAdmission(TENANT, sessionId, turnId, "dispatcher", EPOCH, 0);
        // The admission hand-off lands with the dispatcher change; until then
        // the test hands the Turn to the Harness itself.
        jdbc.update("UPDATE ma_turn SET dispatch_owner = ?, dispatch_lease_until = ?"
                + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                OWNER, now.get() + 60_000, TENANT, sessionId, turnId);
        turn = store.findTurn(TENANT, sessionId, turnId).orElseThrow();
        ManagedSessionStore sessions = mock(ManagedSessionStore.class);
        when(sessions.authenticateEventIngest(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyBoolean())).thenAnswer(ignored -> committed.get());
        ingest = new HarnessEventIngest(store, sessions, new HarnessEventProjector(), clock, properties);
    }

    @Test
    void recordsTheTurnAcrossRequestsAndSettlesItOnTheTerminalEvent() {
        IngestReceipt first = ingest(0, 3, null, text(1, "Hel"), foreign(2), text(3, "lo"));
        assertThat(first.cursor()).isEqualTo(3);
        assertThat(first.leaseRenewAfterMillis()).isEqualTo(20_000);
        assertThat(first.terminal()).isFalse();

        assertThat(ingest(3, 4, null, complete(4)).terminal()).isTrue();

        TurnRecord settled = store.findTurn(TENANT, sessionId, turn.turnId()).orElseThrow();
        assertThat(settled.status()).isEqualTo("COMPLETED");
        assertThat(settled.dispatchOwner()).isNull();
        assertThat(settled.harnessLastEventId()).isEqualTo(4);
        assertThat(deltaTexts()).containsExactly("Hel", "lo");
        assertThat(sourceKeys()).allMatch(key -> key.startsWith(WRITER + ":" + EPOCH + ":"));
    }

    @Test
    void acknowledgesAResentBatchWithoutRecordingItAgain() {
        ingest(0, 2, null, text(1, "a"), text(2, "b"));
        IngestReceipt resent = ingest(0, 2, null, text(1, "a"), text(2, "b"));

        assertThat(resent.cursor()).isEqualTo(2);
        assertThat(deltaTexts()).containsExactly("a", "b");
    }

    @Test
    void refusesABatchThatSkipsAheadOfTheCursorAndReportsIt() {
        ingest(0, 1, null, text(1, "a"));

        assertThatThrownBy(() -> ingest(2, 3, null, text(3, "c")))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getCode())
                            .isEqualTo(ManagedSessionStoreModels.ERROR_INGEST_CURSOR_MISMATCH);
                    assertThat(error.getDetails()).containsEntry("cursor", 1L);
                });
        assertThat(deltaTexts()).containsExactly("a");
    }

    @Test
    void movesTheCursorPastFilteredEnvelopesAndRenewsOnAHeartbeat() {
        ingest(0, 2, null, foreign(1), foreign(2));
        assertThat(store.findTurn(TENANT, sessionId, turn.turnId()).orElseThrow()
                .harnessLastEventId()).isEqualTo(2);

        now.addAndGet(50_000);
        ingest(2, 2, null);
        assertThat(store.findTurn(TENANT, sessionId, turn.turnId()).orElseThrow()
                .dispatchLeaseUntil()).isEqualTo(now.get() + 60_000);
    }

    @Test
    void refusesATurnTheHarnessDoesNotHold() {
        jdbc.update("UPDATE ma_turn SET dispatch_owner = 'dispatcher' WHERE turn_id = ?",
                turn.turnId());
        refused(() -> ingest(0, 1, null, text(1, "a")),
                ManagedSessionStoreModels.ERROR_INGEST_NOT_OWNER);

        jdbc.update("UPDATE ma_turn SET dispatch_owner = ? WHERE turn_id = ?", OWNER, turn.turnId());
        now.addAndGet(61_000);
        refused(() -> ingest(0, 1, null, text(1, "a")),
                ManagedSessionStoreModels.ERROR_INGEST_NOT_OWNER);
        assertThat(deltaTexts()).isEmpty();
    }

    @Test
    void asksTheHarnessToRetryBeforeTheAdmissionAtItsEpochIsRecorded() {
        refused(() -> ingest(new IngestEventsRequest("ws", WRITER, 1, "epoch_2", turn.turnId(),
                        turn.promptId(), 0, 1, List.of(text(1, "a")), null)),
                ManagedSessionStoreModels.ERROR_INGEST_NOT_READY);
    }

    @Test
    void refusesAnEndMarkerBeforeTheJournalIsDrained() {
        committed.set(5);
        refused(() -> ingest(0, 1, ManagedSessionStoreModels.INGEST_END_PARKED, text(1, "a")),
                ManagedSessionStoreModels.ERROR_INGEST_END_REFUSED);
        assertThat(store.findTurn(TENANT, sessionId, turn.turnId()).orElseThrow().dispatchOwner())
                .isEqualTo(OWNER);
    }

    @Test
    void marksARecoveryBlockAndReleasesTheTurn() {
        committed.set(1);
        ingest(0, 1, ManagedSessionStoreModels.INGEST_END_RECOVERY_BLOCKED, text(1, "a"));

        TurnRecord blocked = store.findTurn(TENANT, sessionId, turn.turnId()).orElseThrow();
        assertThat(blocked.errorCode()).isEqualTo("hosted_harness_recovery_blocked");
        assertThat(blocked.dispatchOwner()).isNull();
    }

    @Test
    void rejectsEnvelopesOutsideTheBatchRange() {
        assertThatThrownBy(() -> ingest(0, 1, null, text(2, "a")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(400));
        assertThatThrownBy(() -> ingest(0, 2, null, text(2, "a"), text(1, "b")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(400));
    }

    @SafeVarargs
    private IngestReceipt ingest(long after, long through, String end, Map<String, Object>... events) {
        return ingest(new IngestEventsRequest("ws", WRITER, 1, EPOCH, turn.turnId(), turn.promptId(),
                after, through, List.of(events), end));
    }

    private IngestReceipt ingest(IngestEventsRequest request) {
        return ingest.ingest(TENANT, sessionId, "t".repeat(32), request);
    }

    private Map<String, Object> text(long id, String text) {
        return envelope(id, "session_update", turn.promptId(), Map.of("update", Map.of(
                "sessionUpdate", "agent_message_chunk",
                "content", Map.of("type", "text", "text", text))));
    }

    private Map<String, Object> foreign(long id) {
        return envelope(id, "session_update", UUID.randomUUID().toString(), Map.of("update", Map.of(
                "sessionUpdate", "agent_message_chunk",
                "content", Map.of("type", "text", "text", "other"))));
    }

    private Map<String, Object> complete(long id) {
        return envelope(id, "turn_complete", turn.promptId(), Map.of("stopReason", "end_turn"));
    }

    private static Map<String, Object> envelope(long id, String type, String promptId, Object data) {
        return Map.of("v", 1, "id", id, "type", type, "promptId", promptId, "data", data);
    }

    private List<String> deltaTexts() {
        List<String> texts = new ArrayList<>();
        for (String json : jdbc.queryForList("SELECT data_json FROM ma_public_event WHERE tenant_id = ?"
                + " AND session_id = ? AND turn_id = ? AND event_type = 'item.output_text.delta'"
                + " ORDER BY sequence_id", String.class, TENANT, sessionId, turn.turnId())) {
            try {
                texts.add(new ObjectMapper().readTree(json).path("text").asText());
            } catch (java.io.IOException error) {
                throw new IllegalStateException(error);
            }
        }
        return texts;
    }

    private List<String> sourceKeys() {
        return jdbc.queryForList("SELECT source_key FROM ma_public_event WHERE tenant_id = ?"
                + " AND session_id = ? AND turn_id = ? AND source_key IS NOT NULL", String.class,
                TENANT, sessionId, turn.turnId());
    }

    private static void refused(Runnable call, String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
