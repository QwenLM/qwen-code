package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

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
     * A Turn's terminal transaction can pin its REPEATABLE READ snapshot
     * before it locks the Session, so a cancel committed in between is
     * invisible to a plain read; the settle must still find and end it.
     */
    @Test
    void aTurnEndingOnAStaleSnapshotSettlesTheCancelCommittedMeanwhile()
            throws Exception {
        Admission turn = admit("submit-1");
        claim(turn);
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
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
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
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
}
