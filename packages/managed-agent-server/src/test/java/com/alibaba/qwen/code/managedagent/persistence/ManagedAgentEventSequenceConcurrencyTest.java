package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

class ManagedAgentEventSequenceConcurrencyTest {
    private static final String TENANT = "tenant-sequence";
    private static final String OWNER = "owner-sequence";
    private static final String EPOCH = "epoch-sequence";
    private JdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private ManagedAgentStore store;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:event-sequence-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
                + ";LOCK_TIMEOUT=10000");
        return source;
    }

    @BeforeEach
    void setUp() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transactions = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @Timeout(20)
    void waitingHarnessBatchKeepsCommittedPublicSequence(boolean projected)
            throws Exception {
        Admission turn = createTurn();
        long before = store.requireSession(TENANT, turn.sessionId()).lastSequence();

        try (var executor = Executors.newSingleThreadExecutor()) {
            Future<?> waiting = transactions.execute(status -> {
                Long blockerId = currentSessionId(jdbc);
                jdbc.queryForObject("SELECT version FROM ma_session WHERE"
                                + " tenant_id = ? AND session_id = ? FOR UPDATE",
                        Long.class, TENANT, turn.sessionId());
                Future<?> pending = executor.submit(() -> transactions.executeWithoutResult(
                        ignored -> store.recordHarnessEvents(TENANT, turn.sessionId(),
                                turn.turnId(), OWNER, EPOCH,
                                List.of(event(2, projected)))));
                awaitSessionLockWait(jdbc, blockerId);
                store.recordHarnessEvents(TENANT, turn.sessionId(), turn.turnId(),
                        OWNER, EPOCH, List.of(event(1, true)));
                return pending;
            });
            assertThat(waiting).isNotNull();
            waiting.get(5, TimeUnit.SECONDS);
        }

        long expected = before + (projected ? 2 : 1);
        assertThat(store.requireSession(TENANT, turn.sessionId()).lastSequence())
                .isEqualTo(expected);
        assertThat(store.findTurn(TENANT, turn.sessionId(), turn.turnId()))
                .get().satisfies(record -> assertThat(record.harnessLastEventId()).isEqualTo(2));
        transactions.executeWithoutResult(status -> store.recordHarnessEvents(TENANT,
                turn.sessionId(), turn.turnId(), OWNER, EPOCH, List.of(event(3, true))));
        assertThat(store.findEvents(TENANT, turn.sessionId(), before, 10))
                .extracting(record -> record.sequence())
                .containsExactlyElementsOf(projected
                        ? List.of(before + 1, before + 2, before + 3)
                        : List.of(before + 1, before + 2));
        assertThat(store.requireSession(TENANT, turn.sessionId()).lastSequence())
                .isEqualTo(expected + 1);
    }

    @Test
    void missingSessionStreamKeepsItsUnavailableError() {
        Admission turn = createTurn();
        jdbc.update("DELETE FROM ma_public_event WHERE tenant_id = ? AND session_id = ?",
                TENANT, turn.sessionId());
        jdbc.update("DELETE FROM ma_event_stream WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'SESSION' AND stream_id = X''",
                TENANT, turn.sessionId());

        assertThatThrownBy(() -> transactions.executeWithoutResult(status ->
                store.recordHarnessEvents(TENANT, turn.sessionId(), turn.turnId(),
                        OWNER, EPOCH, List.of(event(1, true)))))
                .isExactlyInstanceOf(IllegalStateException.class)
                .hasMessage("Session stream is unavailable.");
    }

    protected Long currentSessionId(JdbcTemplate template) {
        return template.queryForObject("SELECT SESSION_ID()", Long.class);
    }

    protected void awaitSessionLockWait(JdbcTemplate template, Long blockerId) {
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(template.queryForList("SELECT executing_statement FROM"
                                        + " information_schema.sessions WHERE blocker_id = ?"
                                        + " AND session_state = 'BLOCKED'",
                                String.class, blockerId))
                        .singleElement().satisfies(statement ->
                                assertThat(statement).contains("ma_session", "FOR UPDATE")));
    }

    private Admission createTurn() {
        Admission turn = transactions.execute(status -> {
            Admission session = store.insertSessionCommand(TENANT,
                    "CREATE_SESSION", "create", "create-digest", "qwen-code",
                    "1", null, List.of(), null);
            Admission admitted = store.insertTurnCommand(TENANT,
                    "SUBMIT_TURN", "submit", "submit-digest", session.sessionId(),
                    List.of(Map.of("type", "text", "text", "hello")), "payload");
            assertThat(store.claimTurn(TENANT, session.sessionId(),
                    admitted.turnId(), OWNER, Duration.ofMinutes(1))).isPresent();
            store.recordAdmission(TENANT, session.sessionId(), admitted.turnId(),
                    OWNER, EPOCH, 0);
            return admitted;
        });
        assertThat(turn).isNotNull();
        return turn;
    }

    private static HarnessEvent event(long sourceId, boolean projected) {
        return new HarnessEvent(sourceId, "boot:" + EPOCH + ":" + sourceId,
                projected ? new ProjectedEvent("item.output_text.delta",
                        Map.of("text", "event-" + sourceId), false, null, null, null) : null);
    }
}
