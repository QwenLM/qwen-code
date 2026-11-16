package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.transaction.TransactionDefinition;

import javax.sql.DataSource;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class RecoverySettlementStoreMySqlIT extends RecoverySettlementStoreTest {
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

    @ParameterizedTest
    @ValueSource(strings = {"cancel", "fail", "recovery-blocked"})
    void removingThePreReadWouldChangeAnOldSnapshotOwnerDecision(String route) {
        jdbc.update("UPDATE ma_turn SET harness_event_epoch = NULL, is_submission_attempted = FALSE"
                + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?", TENANT, sessionId, turnId);
        transactions.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        transactions.executeWithoutResult(status -> {
            assertThat(turn().dispatchOwner()).isEqualTo(OWNER);
            CompletableFuture.runAsync(() -> transactions.executeWithoutResult(other -> {
                store.releaseTurnLease(TENANT, sessionId, turnId, OWNER);
                assertThat(store.claimTurn(TENANT, sessionId, turnId, "replacement", java.time.Duration.ofMinutes(1))).isPresent();
            })).orTimeout(10, TimeUnit.SECONDS).join();
            assertThat(turn().dispatchOwner()).isEqualTo(OWNER);
            switch (route) {
                case "cancel" -> store.cancelBeforeAdmission(TENANT, sessionId, turnId, "replacement");
                case "fail" -> store.failTurn(TENANT, sessionId, turnId, "replacement", "failure", "failure");
                case "recovery-blocked" -> assertThat(store.failRecoveryBlockedTurn(TENANT, sessionId, turnId, "replacement", "failure")).isFalse();
                default -> throw new IllegalArgumentException(route);
            }
            assertNoFailureEvent();
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND turn_id = ? FOR UPDATE",
                    String.class, TENANT, sessionId, turnId)).isEqualTo("RUNNING");
            // The proposed UPDATE-first decision sees the committed owner, unlike requireTurn's snapshot.
            String predicates = route.equals("cancel")
                    ? " AND harness_event_epoch IS NULL AND is_submission_attempted = FALSE"
                    : " AND status IN ('ACCEPTED', 'RUNNING'" + (route.equals("fail") ? ", 'CANCELLING')" : ")");
            assertThat(jdbc.update("UPDATE ma_turn SET status = ? WHERE tenant_id = ? AND session_id = ? AND turn_id = ?"
                    + " AND dispatch_owner = ? AND dispatch_lease_until >= ?" + predicates,
                    route.equals("cancel") ? "CANCELLED" : "FAILED", TENANT, sessionId, turnId, "replacement", System.currentTimeMillis()))
                    .as("candidate would accept a call that the baseline refuses").isEqualTo(1);
            status.setRollbackOnly();
        });
        assertThat(turn().status()).isEqualTo("RUNNING");
        assertThat(turn().dispatchOwner()).isEqualTo("replacement");
    }

    @Test
    void aStaleSnapshotProjectsTheNativeCancellationCommittedMeanwhile() {
        mark();
        transactions.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        CountDownLatch pinned = new CountDownLatch(1);
        CompletableFuture<Void> cancellation = CompletableFuture.runAsync(() -> {
            try {
                assertThat(pinned.await(10, TimeUnit.SECONDS)).isTrue();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
            }
            cancel();
        });
        transactions.executeWithoutResult(status -> {
            assertThat(turn().status()).isEqualTo("RUNNING");
            pinned.countDown();
            cancellation.orTimeout(10, TimeUnit.SECONDS).join();
            assertThat(turn().status()).as("the read snapshot predates cancellation").isEqualTo("RUNNING");
            assertThat(store.failRecoveryBlockedTurn(TENANT, sessionId, turnId, OWNER, "failure"))
                    .isFalse();
            store.recordHarnessEvents(TENANT, sessionId, turnId, OWNER, "epoch-original",
                    List.of(terminal("turn.cancelled", "CANCELLED")));
        });

        assertThat(turn().status()).isEqualTo("CANCELLED");
        assertNoFailureEvent();
    }
}
