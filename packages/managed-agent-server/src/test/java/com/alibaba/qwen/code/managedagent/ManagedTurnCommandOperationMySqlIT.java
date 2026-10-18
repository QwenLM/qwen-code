package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

/** The D7-1 operation behaviors on InnoDB, plus the snapshot race H2 cannot stage. */
class ManagedTurnCommandOperationMySqlIT extends ManagedTurnCommandOperationTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void cleanup() {
        if (database != null) {
            database.close();
        }
    }

    /**
     * Two Sessions' settles must not lock each other's pending cancels. With
     * a long settled history on each ended Turn and few pending rows in the
     * table, an unpinned scan prefers a (kind, state) index whose range holds
     * both Sessions' rows, so each settle waits on the other's new cancel.
     */
    @Test
    void settlesInTwoSessionsDoNotLockEachOthersPendingCancels() throws Exception {
        String other = store.insertSessionCommand(TENANT, "CREATE_SESSION",
                "create-other", "digest-other", "qwen-code", null, null,
                List.of(), null).sessionId();
        Map<String, Admission> ended = new HashMap<>();
        Map<String, Admission> running = new HashMap<>();
        for (String session : List.of(sessionId, other)) {
            Admission turn = store.insertTurnCommand(TENANT, "SUBMIT_TURN",
                    session + "-ended", "digest-ended", session, INPUT,
                    "sha256:" + "c".repeat(64), "actor");
            assertThat(store.claimTurn(TENANT, session, turn.turnId(), OWNER,
                    Duration.ofMinutes(1))).isPresent();
            store.failTurn(TENANT, session, turn.turnId(), OWNER,
                    "hosted_harness_unavailable", "gone");
            settledCancels(session, turn.turnId(), 1000);
            ended.put(session, turn);
            running.put(session, store.insertTurnCommand(TENANT,
                    "SUBMIT_TURN", session + "-running", "digest-running",
                    session, INPUT, "sha256:" + "c".repeat(64), "actor"));
        }
        jdbc.execute("ANALYZE TABLE ma_operation");
        var transactions = transactions();
        var pending = new CyclicBarrier(2);
        List<CompletableFuture<Admission>> late = new ArrayList<>();
        for (String session : List.of(sessionId, other)) {
            late.add(CompletableFuture.supplyAsync(() -> transactions.execute(
                    status -> {
                        // A cancel of the running Turn stays pending and
                        // holds its new row until this transaction ends.
                        assertThat(store.insertCancelCommand(TENANT,
                                "CANCEL_TURN", session + "-cancel-running",
                                "cancel-digest", session,
                                running.get(session).turnId(), "actor")
                                .commandEffect()).isTrue();
                        await(pending);
                        return store.insertCancelCommand(TENANT, "CANCEL_TURN",
                                session + "-cancel-ended", "cancel-digest",
                                session, ended.get(session).turnId(), "actor");
                    })));
        }
        for (var cancel : late) {
            Admission admission = cancel.orTimeout(60, TimeUnit.SECONDS).join();
            assertThat(admission.commandEffect()).isFalse();
        }
        for (int index = 0; index < late.size(); index++) {
            String session = index == 0 ? sessionId : other;
            assertThat(store.findOperation(TENANT, session,
                    late.get(index).get().operationId()).orElseThrow()
                    .failureCode()).isEqualTo("turn_already_settled");
        }
    }

    /**
     * A Turn's terminal transaction can pin its REPEATABLE READ snapshot
     * before it locks the Session, so a cancel committed in between is
     * invisible to a plain read; the settle must still find and end it.
     */
    @Test
    void aTurnEndingOnAStaleSnapshotSettlesTheCancelCommittedMeanwhile()
            throws Exception {
        Admission turn = admit("submit-1");
        claim(turn);
        var transactions = transactions();
        var pinned = new CountDownLatch(1);
        CompletableFuture<Admission> cancel = CompletableFuture.supplyAsync(
                () -> {
                    try {
                        assertThat(pinned.await(10, TimeUnit.SECONDS)).isTrue();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    }
                    return transactions.execute(status -> cancel("cancel-1",
                            "cancel-digest-1", turn));
                });
        transactions.executeWithoutResult(status -> {
            jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation",
                    Integer.class);
            pinned.countDown();
            cancel.orTimeout(10, TimeUnit.SECONDS).join();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation"
                    + " WHERE operation_kind = 'CANCEL'", Integer.class))
                    .as("the snapshot predates the cancel").isZero();
            store.failTurn(TENANT, sessionId, turn.turnId(), OWNER,
                    "hosted_harness_unavailable", "gone");
        });
        OperationRecord settled = operation(cancel.get().operationId());
        assertThat(settled.state()).isEqualTo("FAILED");
        assertThat(settled.failureCode()).isEqualTo("turn_already_settled");
        assertThat(settled.deliveryState()).isEqualTo("BLOCKED");
    }

    /**
     * The mirror race: a cancel whose snapshot still shows the Turn running
     * after it ended must settle at admission, from the Turn as committed.
     */
    @Test
    void aCancelAdmittedOnAStaleSnapshotOfAnEndedTurnSettlesAtAdmission() {
        Admission turn = admit("submit-1");
        claim(turn);
        var transactions = transactions();
        Admission cancel = transactions.execute(status -> {
            jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn", Integer.class);
            CompletableFuture.runAsync(() -> transactions.executeWithoutResult(
                    ended -> store.failTurn(TENANT, sessionId, turn.turnId(),
                            OWNER, "hosted_harness_unavailable", "gone")))
                    .orTimeout(10, TimeUnit.SECONDS).join();
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn"
                    + " WHERE turn_id = ?", String.class, turn.turnId()))
                    .as("the snapshot predates the Turn's end")
                    .isEqualTo("RUNNING");
            return cancel("cancel-1", "cancel-digest-1", turn);
        });
        assertThat(cancel.commandEffect()).isFalse();
        OperationRecord settled = operation(cancel.operationId());
        assertThat(settled.state()).isEqualTo("FAILED");
        assertThat(settled.failureCode()).isEqualTo("turn_already_settled");
    }

    // Snapshot witnesses: the server default must not decide the isolation.
    private TransactionTemplate transactions() {
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        transactions.setIsolationLevel(
                TransactionDefinition.ISOLATION_REPEATABLE_READ);
        return transactions;
    }

    private void settledCancels(String session, String turnId, int count) {
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, session);
        String target = ManagedSchemaKeys.key(turnId);
        jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, scope_key,"
                        + " session_scope_key, operation_id, operation_kind,"
                        + " tenant_id, session_id, target_kind, target_key,"
                        + " target_id, request_digest, request_json, state,"
                        + " phase, admission_stage, delivery_state,"
                        + " failure_code, gmt_create, gmt_modified) VALUES"
                        + " (?, ?, ?, ?, 'CANCEL', ?, ?, 'TURN', ?, ?,"
                        + " 'digest', '{}', 'FAILED', 'FAILED', 'JAVA_DURABLE',"
                        + " 'BLOCKED', 'turn_already_settled', 1, 1)",
                IntStream.range(0, count)
                        .mapToObj(index -> new Object[] {
                                ManagedSchemaKeys.key(session, turnId,
                                        Integer.toString(index)),
                                scope, scope, "op_settled_" + index, TENANT,
                                session, target, turnId})
                        .toList());
    }

    private static void await(CyclicBarrier barrier) {
        try {
            barrier.await(30, TimeUnit.SECONDS);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
