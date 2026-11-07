package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.ManagedNativeJournalSnapshots;
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

    @Test
    void aSecondPublicationWaitsForTheFirstWithoutLosingADeadlock() throws Exception {
        lateSecondPublication(request("concurrent"));
        assertThat(snapshotPins()).isEqualTo(2);
        requirePagesJustBelowTheManifest(1);
    }

    @Test
    void aLateSecondPublicationOfALongJournalIsNeverRolledBack() throws Exception {
        // Each page the first Build inserts into the gap below the manifest
        // would roll a queued upsert back again, often more times than publish
        // retries. These page keys differ from run to run, so this case shows
        // the realistic shape; the single-page cases are the deterministic
        // witnesses of the cycle.
        commitMonitors(30);
        lateSecondPublication(request("long-journal"));
    }

    /**
     * The second publication arrives after the first has claimed the manifest
     * row and before it writes any page; one publishes, the other replays
     * without upserting the row, and no claim is rolled back.
     */
    private void lateSecondPublication(ManagedNativeJournalSnapshots.PublishRequest request) throws Exception {
        var claimed = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var isolation = new java.util.concurrent.atomic.AtomicReference<String>();
        jdbc.afterClaim = () -> {
            claimed.countDown();
            isolation.set(jdbc.queryForObject("SELECT @@transaction_isolation", String.class));
            await(release);
        };
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> publish(request));
            try {
                assertThat(claimed.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                var second = executor.submit(() -> publish(request));
                awaitAClaimQueued("the second publication");
                release.countDown();
                assertThat(java.util.List.of(first.get(30, java.util.concurrent.TimeUnit.SECONDS),
                        second.get(30, java.util.concurrent.TimeUnit.SECONDS))).containsExactly(false, true);
            } finally {
                release.countDown();
            }
        }
        assertThat(jdbc.claimDeadlocks).as("claims rolled back by InnoDB").hasValue(0);
        // The level the claim's comment relies on; these outcomes would also
        // hold at REPEATABLE READ, so only this check notices a change to it.
        assertThat(isolation).as("the publication's isolation level").hasValue("READ-COMMITTED");
        assertThat(jdbc.claimReads).as("claim locking reads").hasValue(2);
        assertThat(jdbc.claimUpserts).as("claim upserts").hasValue(1);
    }

    @Test
    void aPublicationQueuedOnAClaimThatRollsBackPublishesTheSnapshotItself() throws Exception {
        // The first publication fails right after its claim while the second
        // waits on the manifest row; the second's locking read then finds no
        // row, so it claims the snapshot and publishes it.
        var request = request("concurrent");
        var claimed = new java.util.concurrent.CountDownLatch(1);
        jdbc.afterClaim = () -> {
            claimed.countDown();
            try {
                awaitAClaimQueued("the second publication");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
            throw new SimulatedCrash();
        };
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> publish(request));
            assertThat(claimed.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            var second = executor.submit(() -> publish(request));
            assertThatThrownBy(() -> first.get(15, java.util.concurrent.TimeUnit.SECONDS))
                    .hasCauseInstanceOf(SimulatedCrash.class);
            assertThat(second.get(15, java.util.concurrent.TimeUnit.SECONDS)).as("whether the second publication replayed")
                    .isFalse();
        }
        assertThat(jdbc.claimReads).as("claim locking reads").hasValue(2);
        assertThat(jdbc.claimUpserts).as("claim upserts").hasValue(2);
        assertThat(jdbc.claimDeadlocks).as("claims rolled back by InnoDB").hasValue(0);
        assertThat(snapshotPins()).isEqualTo(2);
    }

    @Test
    void publicationsThatClaimAtOnceRetryTheOneThatLosesTheDeadlock() throws Exception {
        // Both pass the claim's locking read before either row exists. The
        // first to upsert waits after its claim until the other queues behind
        // it with a next-key lock; its page insert then closes the cycle, and
        // the retried loser waits on the row instead.
        var request = request("concurrent");
        var together = new CyclicBarrier(2);
        jdbc.afterClaim = () -> {
            try {
                awaitAClaimQueued("the other publication's upsert");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
        };
        jdbc.claimLocksToHook.set(2);
        jdbc.afterClaimLock = () -> {
            try {
                together.await(5, java.util.concurrent.TimeUnit.SECONDS);
            } catch (Exception interrupted) {
                throw new IllegalStateException(interrupted);
            }
        };
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> publish(request));
            var second = executor.submit(() -> publish(request));
            assertThat(java.util.List.of(first.get(15, java.util.concurrent.TimeUnit.SECONDS),
                    second.get(15, java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(false, true);
        }
        // Checked first: without the barrier hook on both first reads, or
        // without the page in the manifest's gap, this case is a plain race
        // and the counts below mean nothing. Then only the retried loser's
        // read found the row and skipped the upsert.
        assertThat(jdbc.claimReads.get()).as("claim locking reads").isGreaterThanOrEqualTo(2);
        requirePagesJustBelowTheManifest(1);
        assertThat(jdbc.claimReads).as("claim locking reads").hasValue(3);
        assertThat(jdbc.claimUpserts).as("claim upserts").hasValue(2);
        assertThat(jdbc.claimDeadlocks).as("claims rolled back by InnoDB").hasValue(1);
        assertThat(snapshotPins()).isEqualTo(2);
    }

    /**
     * These cases rely on pages falling in the gap just below the manifest key
     * in uk_ma_resource_business_key: those are the inserts a queued next-key
     * lock blocks. The keys are digests of fixed content, so a change to the
     * fixture or the snapshot id can move them apart.
     */
    private void requirePagesJustBelowTheManifest(int count) {
        var kinds = jdbc.queryForList("SELECT kind FROM ma_resource ORDER BY resource_key", String.class);
        int manifest = kinds.indexOf("managed-native-journal-snapshot");
        assertThat(manifest).as("resources below the manifest in key order: %s", kinds).isGreaterThanOrEqualTo(count);
        assertThat(kinds.subList(manifest - count, manifest)).as("the resources just below the manifest: %s", kinds)
                .containsOnly("managed-native-journal-snapshot-page");
    }

    /**
     * Waits until a transaction of this schema queues for a record of the
     * manifest's index, read live from performance_schema rather than from
     * INNODB_TRX, which InnoDB refreshes only every ~100 ms.
     */
    private void awaitAClaimQueued(String what) throws InterruptedException {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
        while (jdbc.queryForObject("SELECT COUNT(*) FROM performance_schema.data_lock_waits waits"
                + " JOIN performance_schema.data_locks requested ON requested.ENGINE = waits.ENGINE"
                + " AND requested.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID"
                + " WHERE requested.OBJECT_SCHEMA = DATABASE() AND requested.OBJECT_NAME = 'ma_resource'"
                + " AND requested.INDEX_NAME = 'uk_ma_resource_business_key'", Integer.class) == 0) {
            if (System.nanoTime() > deadline) {
                throw new AssertionError("Timed out waiting for " + what + " to queue on the manifest row; "
                        + MySqlLockProbe.describeLockWaits(jdbc, jdbc.queryForObject("SELECT DATABASE()", String.class)));
            }
            Thread.sleep(20);
        }
    }

    private boolean publish(ManagedNativeJournalSnapshots.PublishRequest request) {
        return tx.execute(status -> snapshots.publish("snapshot-tenant", "snapshot-session",
                "extension-writer-token-0123456789", request)).replayed();
    }

    private static void await(java.util.concurrent.CountDownLatch latch) {
        try {
            if (!latch.await(15, java.util.concurrent.TimeUnit.SECONDS)) {
                throw new IllegalStateException("Snapshot test was not released");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
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
