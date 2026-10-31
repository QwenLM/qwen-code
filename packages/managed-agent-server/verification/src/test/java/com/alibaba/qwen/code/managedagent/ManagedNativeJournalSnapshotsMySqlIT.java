package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedNativeJournalSnapshotsMySqlIT extends ManagedNativeJournalSnapshotsTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Test
    void buildingAPrefixDoesNotBlockRenewalOrOtherCommitsAndRejectsAChangedHead() throws Exception {
        commitMonitor();
        var request = request("live-build");
        var paused = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        jdbc.pagesBeforePause = 1;
        jdbc.afterPage = () -> {
            paused.countDown();
            try {
                if (!release.await(15, java.util.concurrent.TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Snapshot test was not released");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
        };
        try (var executor = Executors.newSingleThreadExecutor()) {
            var pending = executor.submit(() -> snapshots.publish("snapshot-tenant", "snapshot-session",
                    "extension-writer-token-0123456789", request));
            try {
                assertThat(paused.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                var renewed = tx.execute(status -> sessions.renewWriter("snapshot-tenant", "snapshot-session",
                        "extension-writer-token-0123456789", new ManagedSessionStoreModels
                                .RenewWriterRequest("snapshot-workspace", "writer-extension", 1, 60_000L)));
                assertThat(renewed.writerGeneration()).isEqualTo(1);
                tx.executeWithoutResult(status -> new ExtensionRecordJournal(sessions, "snapshot-tenant",
                        "snapshot-workspace", "other-session").open());
                commitNextMonitor();
            } finally {
                release.countDown();
            }
            assertThatThrownBy(() -> pending.get(15, java.util.concurrent.TimeUnit.SECONDS))
                    .hasCauseInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        }
        assertThat(snapshotPins()).isZero();
    }

    @Test
    void concurrentPublicationOfTheSameIdentityCommitsOnce() throws Exception {
        var request = request("concurrent");
        var start = new CyclicBarrier(2);
        try (var executor = Executors.newFixedThreadPool(2)) {
            java.util.concurrent.Callable<Boolean> publish = () -> {
                start.await(5, java.util.concurrent.TimeUnit.SECONDS);
                return tx.execute(status -> snapshots.publish("snapshot-tenant", "snapshot-session",
                        "extension-writer-token-0123456789", request)).replayed();
            };
            var first = executor.submit(publish);
            var second = executor.submit(publish);
            assertThat(java.util.List.of(first.get(15, java.util.concurrent.TimeUnit.SECONDS),
                    second.get(15, java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(false, true);
        }
        assertThat(snapshotPins()).isEqualTo(2);
    }

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
}
