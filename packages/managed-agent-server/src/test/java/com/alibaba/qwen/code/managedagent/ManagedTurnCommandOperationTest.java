package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.jdbc.core.ResultSetExtractor;

import javax.sql.DataSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * D7-1: Turn input and cancellation as durable command operations on real
 * SQL — one operation per command, saved with the command and resolved by a
 * replay of its key, settled only from the Turn's own committed facts, and
 * never a Session barrier.
 */
class ManagedTurnCommandOperationTest {
    static final String TENANT = "turn-command-tenant";
    static final String OWNER = "dispatcher";
    static final List<Map<String, Object>> INPUT = List.of(Map.of(
            "type", "text", "text", "hello"));
    private final AtomicLong now = new AtomicLong(1_000_000);
    ManagedAgentStore store;
    JdbcTemplate jdbc;
    DataSource dataSource;
    String sessionId;
    Clock clock;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:turn-command-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return source;
    }

    @BeforeEach
    void setUp() {
        dataSource = dataSource();
        ManagedSchema.initialize(dataSource);
        jdbc = new ManagedSchemaJdbcTemplate(dataSource);
        clock = new Clock() {
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
        store = new ManagedAgentStore(jdbc, new ObjectMapper(), clock,
                ignored -> {}, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        sessionId = store.insertSessionCommand(TENANT, "CREATE_SESSION",
                "create", "digest", "qwen-code", null, null, List.of(), null)
                .sessionId();
    }

    @Test
    void savesTheInputOperationWithItsCommandAndReplaysIt() {
        Admission admitted = submit("submit-1", "digest-1");
        assertThat(admitted.operationId()).startsWith("op_");
        OperationRecord operation = operation(admitted.operationId());
        assertThat(operation.kind()).isEqualTo(OperationKind.SUBMIT_INPUT);
        assertThat(operation.requestDigest()).isEqualTo("digest-1");
        assertThat(operation.state()).isEqualTo("PENDING");
        assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(operation.deliveryState()).isEqualTo("PENDING");
        assertThat(operation.receiptId()).isNull();
        assertThat(operation.sessionStatusBefore()).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT idempotency_key FROM"
                + " ma_operation WHERE operation_id = ?", String.class,
                admitted.operationId())).isEqualTo("submit-1");

        Admission replay = store.replayCommand(TENANT, "SUBMIT_TURN",
                "submit-1", "digest-1");
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.turnId()).isEqualTo(admitted.turnId());
        assertThat(replay.operationId()).isEqualTo(admitted.operationId());
        // An in-store replay probe answers the same original operation.
        assertThat(submit("submit-1", "digest-1").operationId())
                .isEqualTo(admitted.operationId());
        refused(() -> store.replayCommand(TENANT, "SUBMIT_TURN", "submit-1",
                "digest-2"), HttpStatus.CONFLICT, "idempotency_conflict");
        assertThat(operations(OperationKind.SUBMIT_INPUT)).isEqualTo(1);
    }

    @Test
    void completesTheInputOnceAHarnessAdmitsItsTurn() {
        Admission admitted = submit("submit-1", "digest-1");
        claim(admitted);
        store.recordAdmission(TENANT, sessionId, admitted.turnId(), OWNER,
                "epoch-1", 0);
        OperationRecord operation = operation(admitted.operationId());
        assertThat(operation.state()).isEqualTo("COMPLETED");
        assertThat(operation.admissionStage()).isEqualTo("HARNESS_CONFIRMED");
        assertThat(operation.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(operation.receiptId()).startsWith("rcpt_");
        assertThat(operation.failureCode()).isNull();

        // Completion is admission, not the Turn's outcome: a later Turn
        // failure leaves the completed operation as it was.
        store.failTurn(TENANT, sessionId, admitted.turnId(), OWNER,
                "hosted_harness_unavailable", "gone");
        assertThat(operation(admitted.operationId()))
                .usingRecursiveComparison().isEqualTo(operation);
        assertThat(store.replayCommand(TENANT, "SUBMIT_TURN", "submit-1",
                "digest-1").operationId()).isEqualTo(admitted.operationId());
    }

    @Test
    void completesTheInputWhenTheDispatcherAdoptsARecoveredAdmission() {
        Admission admitted = submit("submit-1", "digest-1");
        claim(admitted);
        store.markSubmissionAttempted(TENANT, sessionId, admitted.turnId(),
                OWNER);
        // The Harness already held the prompt (its reply was lost): the
        // dispatcher adopts the attachment's epoch instead of a receipt.
        store.recordRecoveryAdmission(TENANT, sessionId, admitted.turnId(),
                OWNER, null, null, "epoch-recovered", 0);
        OperationRecord operation = operation(admitted.operationId());
        assertThat(operation.state()).isEqualTo("COMPLETED");
        assertThat(operation.admissionStage()).isEqualTo("HARNESS_CONFIRMED");
        assertThat(operation.receiptId()).startsWith("rcpt_");
    }

    @Test
    void failsTheInputWithItsTurnsCodeWhenTheTurnFailsBeforeAdmission() {
        Admission admitted = submit("submit-1", "digest-1");
        claim(admitted);
        store.failTurn(TENANT, sessionId, admitted.turnId(), OWNER,
                "hosted_harness_rejected", "rejected");
        OperationRecord operation = operation(admitted.operationId());
        assertThat(operation.state()).isEqualTo("FAILED");
        assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(operation.deliveryState()).isEqualTo("BLOCKED");
        assertThat(operation.failureCode())
                .isEqualTo("hosted_harness_rejected");
        assertThat(operation.receiptId()).isNull();
    }

    // D7-2: a null epoch does not prove non-admission (R10-4). An input
    // whose submit no Harness answered parks, and only the Session journal
    // decides it: the prompt's submitInput commit completes it.
    @Test
    void anInputWhoseSubmitNoHarnessAnsweredParksUntilTheJournalDecides() {
        Admission admitted = attemptedThenFailed("submit-1");
        OperationRecord parked = operation(admitted.operationId());
        assertThat(parked.state()).isEqualTo("RECOVERY_BLOCKED");
        assertThat(parked.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(parked.deliveryState()).isEqualTo("BLOCKED");
        assertThat(parked.failureCode()).isEqualTo("submit_input_unconfirmed");
        assertThat(parked.receiptId()).isNull();
        ParkedOperation due = new ParkedOperation(TENANT, sessionId,
                admitted.operationId(), "SUBMIT_INPUT");
        assertThat(store.findParkedOperations(50)).containsExactly(due);
        // No managed journal, then a live one without the commit: a writer
        // may still commit the admission, so nothing is proven.
        assertThat(acceptance(admitted)).isEqualTo(AcceptanceVerdict.unknown());
        managedHead("ACTIVE", 0);
        assertThat(acceptance(admitted)).isEqualTo(AcceptanceVerdict.unknown());
        // A sealed journal takes a new writer, which may still commit it.
        jdbc.update("UPDATE ma_session_head SET state = 'SEALED'");
        assertThat(acceptance(admitted)).isEqualTo(AcceptanceVerdict.unknown());
        journalAdmission(admitted, "c".repeat(64));
        assertThat(acceptance(admitted))
                .isEqualTo(AcceptanceVerdict.committed());
        assertThat(store.settleParkedOperation(due,
                AcceptanceVerdict.committed(), 0)).isTrue();
        OperationRecord completed = operation(admitted.operationId());
        assertThat(completed.state()).isEqualTo("COMPLETED");
        assertThat(completed.admissionStage()).isEqualTo("HARNESS_CONFIRMED");
        assertThat(completed.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(completed.receiptId()).startsWith("rcpt_");
        assertThat(completed.failureCode()).isNull();
        assertThat(store.findParkedOperations(50)).isEmpty();
        // A settled outcome is never rewritten.
        assertThat(store.settleParkedOperation(due,
                AcceptanceVerdict.notCommitted("hosted_harness_unavailable"),
                0)).isFalse();
    }

    // A journal that no writer can extend any more, and that compaction has
    // not touched, is complete: its missing commit proves the input never
    // landed, and it fails with its Turn's code.
    @Test
    void anInputFailsOnceItsCompleteJournalLacksTheAdmission() {
        Admission admitted = attemptedThenFailed("submit-1");
        managedHead("DELETING", 0);
        // A commit under the same prompt with another payload is not this
        // input's admission: nothing is proven either way.
        journalAdmission(admitted, "d".repeat(64));
        assertThat(acceptance(admitted)).isEqualTo(AcceptanceVerdict.unknown());
        jdbc.update("DELETE FROM ma_session_journal_tx");
        assertThat(acceptance(admitted)).isEqualTo(
                AcceptanceVerdict.notCommitted("hosted_harness_unavailable"));
        // Once compaction starts the journal may have lost the commit.
        jdbc.update("UPDATE ma_session_head SET state = 'DELETED',"
                + " compacted_through_revision = 1");
        assertThat(acceptance(admitted)).isEqualTo(AcceptanceVerdict.unknown());
        jdbc.update("UPDATE ma_session_head SET compacted_through_revision = 0");
        ParkedOperation due = new ParkedOperation(TENANT, sessionId,
                admitted.operationId(), "SUBMIT_INPUT");
        assertThat(store.settleParkedOperation(due, acceptance(admitted), 0))
                .isTrue();
        OperationRecord failed = operation(admitted.operationId());
        assertThat(failed.state()).isEqualTo("FAILED");
        assertThat(failed.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(failed.deliveryState()).isEqualTo("BLOCKED");
        assertThat(failed.failureCode()).isEqualTo("hosted_harness_unavailable");
        assertThat(failed.receiptId()).isNull();
        assertThat(store.findParkedOperations(50)).isEmpty();
    }

    // Review of #14443: the journal row and the head come from one
    // statement. Between two statements an admission and then the deletion
    // could both commit, and under READ COMMITTED the second read would show
    // a complete journal while the first had missed the admission. Here every
    // statement autocommits, weaker than READ COMMITTED, and that race lands
    // right after the first statement that reads the journal.
    @Test
    void anAdmissionCommittedBetweenTheEvidenceReadsIsNeverReadAsMissing() {
        Admission admitted = attemptedThenFailed("submit-1");
        managedHead("ACTIVE", 0);
        AtomicBoolean raced = new AtomicBoolean();
        JdbcTemplate racingJdbc = new ManagedSchemaJdbcTemplate(dataSource) {
            @Override
            public <T> T query(String sql, PreparedStatementSetter setter,
                    ResultSetExtractor<T> extractor) {
                T result = super.query(sql, setter, extractor);
                if (sql.contains("ma_session_journal_tx")
                        && raced.compareAndSet(false, true)) {
                    journalAdmission(admitted, "c".repeat(64));
                    jdbc.update("UPDATE ma_session_head SET state = 'DELETED'");
                }
                return result;
            }
        };
        ManagedAgentStore racing = new ManagedAgentStore(racingJdbc,
                new ObjectMapper(), clock, ignored -> {},
                new ManagedWorkspaceRegistry(racingJdbc),
                new ManagedAgentProperties());
        assertThat(racing.turnInputAcceptance(TENANT, sessionId,
                admitted.operationId())).isEqualTo(AcceptanceVerdict.unknown());
        assertThat(raced).isTrue();
        assertThat(acceptance(admitted))
                .isEqualTo(AcceptanceVerdict.committed());
    }

    @Test
    void failsTheInputOperationWhenRecoveryFailsItsTurn() {
        Admission admitted = submit("submit-1", "digest-1");
        claim(admitted);
        assertThat(store.failRecoveryBlockedTurn(TENANT, sessionId,
                admitted.turnId(), OWNER, "blocked")).isTrue();
        OperationRecord operation = operation(admitted.operationId());
        assertThat(operation.state()).isEqualTo("FAILED");
        assertThat(operation.failureCode())
                .isEqualTo("managed_runtime_recovery_blocked");
        assertThat(store.failRecoveryBlockedTurn(TENANT, sessionId,
                admitted.turnId(), OWNER, "blocked")).isFalse();
        assertThat(operation(admitted.operationId()))
                .usingRecursiveComparison().isEqualTo(operation);
    }

    @Test
    void aCancelBeforeAdmissionCancelsTheInputAndCompletesInJava() {
        Admission admitted = submit("submit-1", "digest-1");
        Admission cancel = cancel("cancel-1", "cancel-digest-1", admitted);
        assertThat(cancel.commandEffect()).isTrue();
        OperationRecord pending = operation(cancel.operationId());
        assertThat(pending.kind()).isEqualTo(OperationKind.CANCEL);
        assertThat(pending.state()).isEqualTo("PENDING");
        assertThat(pending.deliveryState()).isEqualTo("PENDING");

        claim(admitted);
        store.cancelBeforeAdmission(TENANT, sessionId, admitted.turnId(),
                OWNER);
        OperationRecord input = operation(admitted.operationId());
        assertThat(input.state()).isEqualTo("CANCELLED");
        assertThat(input.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(input.deliveryState()).isEqualTo("BLOCKED");
        assertThat(input.receiptId()).isNull();
        OperationRecord cancelled = operation(cancel.operationId());
        assertThat(cancelled.state()).isEqualTo("COMPLETED");
        assertThat(cancelled.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(cancelled.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(cancelled.receiptId()).startsWith("rcpt_");
        assertThat(store.replayCommand(TENANT, "CANCEL_TURN", "cancel-1",
                "cancel-digest-1").operationId())
                .isEqualTo(cancel.operationId());
    }

    @Test
    void cancelsOfOneTurnCoalesceAndCompleteWhenTheHarnessCancelsIt() {
        Admission admitted = admit("submit-1");
        Admission first = cancel("cancel-1", "cancel-digest-1", admitted);
        Admission second = cancel("cancel-2", "cancel-digest-2", admitted);
        assertThat(first.commandEffect()).isTrue();
        assertThat(second.commandEffect()).isFalse();
        assertThat(second.operationId()).isNotEqualTo(first.operationId());
        assertThat(operation(second.operationId()).state())
                .isEqualTo("PENDING");

        finish(admitted, "turn.cancelled", "CANCELLED");
        OperationRecord one = operation(first.operationId());
        OperationRecord two = operation(second.operationId());
        for (OperationRecord operation : List.of(one, two)) {
            assertThat(operation.state()).isEqualTo("COMPLETED");
            assertThat(operation.admissionStage())
                    .isEqualTo("HARNESS_CONFIRMED");
            assertThat(operation.deliveryState()).isEqualTo("CONFIRMED");
        }
        assertThat(one.receiptId()).isNotEqualTo(two.receiptId());
        assertThat(operation(admitted.operationId()).state())
                .isEqualTo("COMPLETED");
    }

    @Test
    void aCancelFailsWhenItsTurnEndsWithoutBeingCancelled() {
        Admission admitted = admit("submit-1");
        Admission cancel = cancel("cancel-1", "cancel-digest-1", admitted);
        finish(admitted, "turn.completed", "COMPLETED");
        OperationRecord operation = operation(cancel.operationId());
        assertThat(operation.state()).isEqualTo("FAILED");
        assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(operation.deliveryState()).isEqualTo("BLOCKED");
        assertThat(operation.failureCode()).isEqualTo("turn_already_settled");
        assertThat(operation.receiptId()).isNull();
    }

    @Test
    void aCancelPendingWhenTheDispatcherFailsItsTurnFailsAlreadySettled() {
        Admission admitted = submit("submit-1", "digest-1");
        Admission cancel = cancel("cancel-1", "cancel-digest-1", admitted);
        assertThat(cancel.commandEffect()).isTrue();
        assertThat(operation(cancel.operationId()).state()).isEqualTo("PENDING");

        claim(admitted);
        store.failTurn(TENANT, sessionId, admitted.turnId(), OWNER,
                "hosted_harness_unavailable", "gone");
        OperationRecord operation = operation(cancel.operationId());
        assertThat(operation.state()).isEqualTo("FAILED");
        assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(operation.deliveryState()).isEqualTo("BLOCKED");
        assertThat(operation.failureCode()).isEqualTo("turn_already_settled");
        assertThat(operation.receiptId()).isNull();
        assertThat(operation(admitted.operationId()).failureCode())
                .isEqualTo("hosted_harness_unavailable");
    }

    @Test
    void aCancelOfAnEndedTurnSettlesAtAdmission() {
        Admission completed = admit("submit-1");
        finish(completed, "turn.completed", "COMPLETED");
        Admission late = cancel("cancel-1", "cancel-digest-1", completed);
        assertThat(late.commandEffect()).isFalse();
        assertThat(operation(late.operationId()).failureCode())
                .isEqualTo("turn_already_settled");

        Admission cancelled = admit("submit-2");
        cancel("cancel-2", "cancel-digest-2", cancelled);
        finish(cancelled, "turn.cancelled", "CANCELLED");
        OperationRecord again = operation(cancel("cancel-3",
                "cancel-digest-3", cancelled).operationId());
        assertThat(again.state()).isEqualTo("COMPLETED");
        assertThat(again.admissionStage()).isEqualTo("HARNESS_CONFIRMED");
        assertThat(again.receiptId()).startsWith("rcpt_");
    }

    @Test
    void turnCommandsAreNeitherSessionBarriersNorLifecycleWork() {
        Admission failed = submit("submit-1", "digest-1");
        claim(failed);
        store.failTurn(TENANT, sessionId, failed.turnId(), OWNER,
                "hosted_harness_rejected", "rejected");
        Admission held = submit("submit-2", "digest-2");
        Admission cancel = cancel("cancel-1", "cancel-digest-1", held);
        now.addAndGet(Duration.ofMinutes(10).toMillis());
        assertThat(store.findDeliverableOperations(now.get(), 50)).isEmpty();
        assertThat(store.findDeliverableTaskCancels(50)).isEmpty();
        assertThat(store.findParkedOperations(50)).isEmpty();
        // The open Turn still refuses the close, as before D7-1; its pending
        // cancel is not a Session operation.
        refused(() -> store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, "actor", "close-1", "close-digest"),
                HttpStatus.CONFLICT, "turn_active");
        claim(held);
        store.cancelBeforeAdmission(TENANT, sessionId, held.turnId(), OWNER);
        assertThat(operation(cancel.operationId()).state())
                .isEqualTo("COMPLETED");
        assertThat(store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, "actor", "close-1", "close-digest")
                .operation().state()).isEqualTo("PENDING");
    }

    Admission submit(String key, String digest) {
        return store.insertTurnCommand(TENANT, "SUBMIT_TURN", key, digest,
                sessionId, INPUT, "sha256:" + "c".repeat(64), "actor");
    }

    Admission cancel(String key, String digest, Admission turn) {
        return store.insertCancelCommand(TENANT, "CANCEL_TURN", key, digest,
                sessionId, turn.turnId(), "actor");
    }

    // A Turn a Harness has admitted, released by its dispatcher.
    Admission admit(String key) {
        Admission admitted = submit(key, "digest-" + key);
        claim(admitted);
        store.recordAdmission(TENANT, sessionId, admitted.turnId(), OWNER,
                "epoch-" + key, 0);
        store.releaseTurnLease(TENANT, sessionId, admitted.turnId(), OWNER);
        return admitted;
    }

    // A Turn whose dispatcher sent the submit and then failed it without
    // any Harness answer: no event epoch, but the submission mark is set.
    Admission attemptedThenFailed(String key) {
        Admission admitted = submit(key, "digest-" + key);
        claim(admitted);
        store.markSubmissionAttempted(TENANT, sessionId, admitted.turnId(),
                OWNER);
        store.failTurn(TENANT, sessionId, admitted.turnId(), OWNER,
                "hosted_harness_unavailable", "gone");
        return admitted;
    }

    AcceptanceVerdict acceptance(Admission turn) {
        return store.turnInputAcceptance(TENANT, sessionId,
                turn.operationId());
    }

    void managedHead(String state, long compactedThrough) {
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key,"
                        + " tenant_id, session_id, harness_session_id, head_kind,"
                        + " state, storage_version, writer_generation,"
                        + " journal_revision, committed_sequence, activation_epoch,"
                        + " compacted_through_revision, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, ?, 'MANAGED_SESSION', ?, 1, 1, 1, 1, 0,"
                        + " ?, 0, 0)",
                JdbcRuntimeBindingRepository.harnessDrainKey(TENANT),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), TENANT,
                sessionId, sessionId, state, compactedThrough);
    }

    // The row the Harness's submitInput commit leaves: keyed by operation
    // and prompt, carrying the payload digest without its prefix.
    void journalAdmission(Admission turn, String contentDigest) {
        String promptId = store.findTurn(TENANT, sessionId, turn.turnId())
                .orElseThrow().promptId();
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id,"
                        + " session_id, journal_revision, command_key_hash,"
                        + " transaction_id, operation, command_id, content_digest,"
                        + " first_sequence, last_sequence, event_count,"
                        + " writer_generation, writer_id, writer_token_hash,"
                        + " activation_epoch, record_encoding, record_bytes,"
                        + " byte_length, record_digest, gmt_create) VALUES (?, 'ws',"
                        + " ?, 1, ?, 'tx-1', 'submitInput', ?, ?, 1, 1, 1, 1, 'writer',"
                        + " ?, 0, 'identity', ?, 0, ?, 0)",
                TENANT, sessionId,
                DigestUtils.sha256Hex("submitInput\u0000" + promptId),
                promptId, contentDigest, "0".repeat(64), new byte[0],
                "0".repeat(64));
    }

    void claim(Admission turn) {
        assertThat(store.claimTurn(TENANT, sessionId, turn.turnId(), OWNER,
                Duration.ofMinutes(1))).isPresent();
    }

    private void finish(Admission turn, String type, String status) {
        claim(turn);
        String epoch = store.findTurn(TENANT, sessionId, turn.turnId())
                .orElseThrow().harnessEventEpoch();
        store.recordHarnessEvents(TENANT, sessionId, turn.turnId(), OWNER,
                epoch, List.of(new HarnessEvent(1, "boot:" + epoch + ":1",
                        new ProjectedEvent(type, Map.of(), true, status,
                                null, null))));
    }

    OperationRecord operation(String operationId) {
        return store.findOperation(TENANT, sessionId, operationId)
                .orElseThrow();
    }

    private int operations(OperationKind kind) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE"
                + " operation_kind = ?", Integer.class, kind.name());
    }

    private static void refused(Runnable call, HttpStatus status,
            String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(
                ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(status);
                    assertThat(error.getCode()).isEqualTo(code);
                });
    }
}
