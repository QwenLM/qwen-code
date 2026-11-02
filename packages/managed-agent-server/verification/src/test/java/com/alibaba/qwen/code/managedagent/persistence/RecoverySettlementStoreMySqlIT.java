package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
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
