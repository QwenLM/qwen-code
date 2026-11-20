package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.spy;

/**
 * Regression for the pack publication commit boundary on the Spring-managed production path.
 *
 * <p>{@link JdbcJournalPacks#sweep()} invokes its own methods through {@code this}, which bypasses
 * the Spring proxy, so a {@code @Transactional} annotation on those methods would never be applied
 * and each statement would autocommit. The transactional boundary therefore lives in
 * {@link JournalPackTransactions}. These tests wire the beans through a real Spring context (not
 * {@code new JdbcJournalPacks}) and prove that (a) the head watermark and the PUBLISHED state commit
 * as one unit, and (b) failed publication preserves deletion debt until the PUT is closed.
 */
@Timeout(30)
class JournalPackTransactionRegressionTest {
    private static final String TENANT = "tenant-pack-tx";
    private static final String WORKSPACE = "workspace-pack-tx";
    private static final String SESSION = "session-pack-tx";

    private JdbcTemplate jdbc;
    private PublicationProbeWiring.InMemoryObjectStore objects;

    private ManagedAgentSettings settings() {
        return (ManagedAgentSettings) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {ManagedAgentSettings.class},
                (proxy, method, args) -> method.getName().equals("getSessionResources")
                        ? sessionResources() : null);
    }

    private ManagedAgentSettings.SessionResources sessionResources() {
        return new ManagedAgentSettings.SessionResources() {
            @Override public boolean isEnabled() { return true; }
            @Override public String getOssKeyPrefix() { return "pack-tx-resources/"; }
            @Override public boolean isPackJobEnabled() { return true; }
            @Override public boolean isDeletionEnabled() { return true; }
            @Override public long getPackTargetBytes() { return 16L * 1024 * 1024; }
            @Override public int getPackMaxTransactions() { return 4096; }
            @Override public Duration getDeletionGrace() { return Duration.ZERO; }
        };
    }

    private AnnotationConfigApplicationContext context(ToolPublicationObjectStore store) {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:pack-tx-" + UUID.randomUUID()
                + ";DB_CLOSE_DELAY=-1;MODE=MySQL");
        Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load()
                .migrate();
        jdbc = spy(new ManagedSchemaJdbcTemplate(source));
        objects = new PublicationProbeWiring.InMemoryObjectStore();
        AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext();
        context.registerBean("managedJdbcTemplate", JdbcTemplate.class, () -> jdbc);
        context.registerBean(ToolPublicationObjectStore.class, () -> store);
        context.registerBean(ManagedAgentSettings.class, this::settings);
        context.register(JournalPackTransactions.class, JdbcJournalPacks.class);
        context.refresh();
        return context;
    }

    private byte[] bytes(int size) {
        byte[] value = new byte[size];
        for (int index = 0; index < size; index++) {
            value[index] = (byte) (index % 251);
        }
        return value;
    }

    private void insertHead(long journalRevision) {
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id,"
                + " workspace_id, session_id, harness_session_id, head_kind, state,"
                + " writer_generation, journal_revision, committed_sequence,"
                + " last_commit_digest, activation_epoch, packed_through_revision, gmt_create,"
                + " gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'MANAGED_SESSION', 'ACTIVE', 1,"
                + " ?, ?, 'digest', 0, 0, 0, 0)",
                ManagedSchemaKeys.key(TENANT), ManagedSchemaKeys.key(SESSION),
                TENANT, WORKSPACE, SESSION, SESSION, journalRevision, journalRevision);
    }

    private void insertTransaction(long revision, byte[] value) {
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id,"
                + " journal_revision, transaction_id, operation, command_id, command_key_hash,"
                + " content_digest, first_sequence, last_sequence, event_count, events_digest,"
                + " commit_digest, writer_generation, writer_id, writer_token_hash,"
                + " activation_epoch, record_encoding, record_bytes, byte_length, record_digest,"
                + " gmt_create) VALUES (?, ?, ?, ?, ?, 'turn.start', ?, ?, 'content', ?, ?, 1,"
                + " 'events', ?, 1, 'writer', 'hash', 0, 'identity', ?, ?, ?, 0)",
                TENANT, WORKSPACE, SESSION, revision, "tx-" + revision, "cmd-" + revision,
                "cmdkey-" + revision, revision, revision, "commit-" + revision, value,
                value.length, JournalStoreRows.sha256(value));
    }

    private long watermark() {
        return jdbc.queryForObject("SELECT packed_through_revision FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, TENANT, SESSION);
    }

    private long packCount(String state) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack WHERE state = ?",
                Long.class, state);
    }

    /** Advances the head watermark during the read-back, racing the publication. */
    private final class RacingStore implements ToolPublicationObjectStore {
        private final AtomicBoolean raced = new AtomicBoolean();
        private final boolean failRead;

        private RacingStore(boolean failRead) {
            this.failRead = failRead;
        }

        @Override public void validateConfiguration() {
        }

        @Override public void putIfAbsent(String key, byte[] value) {
            objects.putIfAbsent(key, value);
        }

        @Override public InputStream open(String key) {
            if (failRead) {
                throw new IllegalStateException("simulated crash after PUT");
            }
            if (raced.compareAndSet(false, true)) {
                jdbc.update("UPDATE ma_session_head SET packed_through_revision = 999"
                        + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
            }
            return objects.open(key);
        }

        @Override public InputStream open(String key, Runnable guard) {
            guard.run();
            return open(key);
        }

        @Override public InputStream openRange(String key, long offset, long length, Runnable guard) {
            return objects.openRange(key, offset, length, guard);
        }

        @Override public void deleteIfPresent(String key) {
            objects.deleteIfPresent(key);
        }
    }

    @Test
    void watermarkAndPublishedStateCommitAtomicallyOnTheSpringPath() {
        try (var context = context(new RacingStore(false))) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(2);
            insertTransaction(1, bytes(4096));
            insertTransaction(2, bytes(8192));
            // The read-back races the head watermark forward, so the guarded publication UPDATE
            // matches no row and the whole publish transaction must roll back as a unit.
            assertThatThrownBy(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION))
                    .isInstanceOf(ManagedAgentException.class);
            // Publication rolls back, then only this failed attempt is retired.
            assertThat(packCount("RETIRED")).isEqualTo(1);
            assertThat(packCount("BUILDING")).isZero();
            assertThat(packCount("VERIFIED")).isZero();
            assertThat(packCount("PUBLISHED")).isZero();
            assertThat(watermark()).isEqualTo(999L);
            // No manifest resource or reference may survive the rolled-back publication.
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class))
                    .isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE"
                    + " owner_kind = 'JOURNAL'", Long.class)).isZero();
            // The successful PUT closed this retired attempt even though publication failed.
            assertThat(packs.collectOrphans()).isEqualTo(1);
            assertThat(packCount("BUILDING")).isZero();
        }
    }

    @Test
    void failedReadBackAfterSuccessfulPutLeavesClosedRetiredDebt() {
        RacingStore store = new RacingStore(true);
        try (var context = context(store)) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            byte[] value = bytes(4096);
            insertTransaction(1, value);
            // The BUILDING row commits REQUIRES_NEW before the PUT; the PUT succeeds; the
            // read-back then fails, so publication never runs.
            assertThatThrownBy(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(packCount("RETIRED")).isEqualTo(1);
            assertThat(watermark()).isZero();
            assertThat(jdbc.queryForObject("SELECT is_put_closed FROM ma_journal_pack", Integer.class))
                    .isEqualTo(1);
            String objectKey = jdbc.queryForObject("SELECT object_key FROM ma_journal_pack"
                    + " WHERE state = 'RETIRED'", String.class);
            // No GET is needed to close a PUT that returned normally.
            assertThat(packs.collectOrphans()).isEqualTo(1);
            assertThat(packCount("BUILDING")).isZero();
            assertThatThrownBy(() -> objects.open(objectKey))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void sweepPublishesThroughTheSpringPathAndResolvesAfterDeletion() {
        try (var context = context(new PublicationProbeWiring.InMemoryObjectStore())) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(2);
            byte[] first = bytes(4096);
            byte[] second = bytes(8192);
            insertTransaction(1, first);
            insertTransaction(2, second);
            packs.sweep();
            assertThat(watermark()).isEqualTo(2L);
            // Grace is zero, so the same pass evicts the pack it just published.
            assertThat(packCount("EVICTED")).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE"
                    + " record_bytes IS NULL", Long.class)).isEqualTo(2L);
            assertThat(packs.resolveBytes(TENANT, SESSION, 1, JournalStoreRows.sha256(first),
                    first.length)).isEqualTo(first);
            assertThat(packs.resolveBytes(TENANT, SESSION, 2, JournalStoreRows.sha256(second),
                    second.length)).isEqualTo(second);
        }
    }

    /** Fails the first read-back (a crash after PUT), then behaves normally. */
    private final class CrashOnceStore implements ToolPublicationObjectStore {
        private final AtomicBoolean crashed = new AtomicBoolean();

        @Override public void validateConfiguration() {
        }

        @Override public void putIfAbsent(String key, byte[] value) {
            objects.putIfAbsent(key, value);
        }

        @Override public InputStream open(String key) {
            if (crashed.compareAndSet(false, true)) {
                throw new IllegalStateException("simulated crash after PUT");
            }
            return objects.open(key);
        }

        @Override public InputStream open(String key, Runnable guard) {
            guard.run();
            return open(key);
        }

        @Override public InputStream openRange(String key, long offset, long length, Runnable guard) {
            return objects.openRange(key, offset, length, guard);
        }

        @Override public void deleteIfPresent(String key) {
            objects.deleteIfPresent(key);
        }
    }

    @Test
    void retryUsesNewUuidWithoutDiscardingTheFailedAttemptsDebt() {
        try (var context = context(new CrashOnceStore())) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            byte[] value = bytes(4096);
            insertTransaction(1, value);
            // First attempt: BUILDING commits, PUT lands, read-back crashes.
            assertThatThrownBy(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(packCount("RETIRED")).isEqualTo(1);
            assertThat(watermark()).isZero();
            // RETIRED debt no longer occupies the active range, even on the same builder.
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
            assertThat(watermark()).isEqualTo(1L);
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
            assertThat(packCount("BUILDING")).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack", Long.class))
                    .isEqualTo(2);
            assertThat(packs.collectOrphans()).isEqualTo(1);
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
            assertThat(packs.resolveBytes(TENANT, SESSION, 1, JournalStoreRows.sha256(value),
                    value.length)).isEqualTo(value);
        }
    }

    @Test
    void evictionMarksPacksEvictedSoTheSweepProgressesAndTerminates() {
        try (var context = context(new PublicationProbeWiring.InMemoryObjectStore())) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(2);
            byte[] first = bytes(4096);
            byte[] second = bytes(8192);
            insertTransaction(1, first);
            insertTransaction(2, second);
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
            assertThat(packs.deleteCoveredBlobs()).isEqualTo(2);
            // The pack is marked EVICTED instead of staying PUBLISHED for endless re-selection.
            assertThat(packCount("EVICTED")).isEqualTo(1);
            assertThat(packCount("PUBLISHED")).isZero();
            // A second pass selects nothing: the sweep makes progress and terminates.
            assertThat(packs.deleteCoveredBlobs()).isZero();
            // Evicted packs remain resolvable from the object store.
            assertThat(packs.resolveBytes(TENANT, SESSION, 1, JournalStoreRows.sha256(first),
                    first.length)).isEqualTo(first);
            assertThat(packs.resolveBytes(TENANT, SESSION, 2, JournalStoreRows.sha256(second),
                    second.length)).isEqualTo(second);
        }
    }

    @Test
    void buildRefusesARecordWhoseBytesDoNotMatchItsDigestOrLength() {
        try (var context = context(new PublicationProbeWiring.InMemoryObjectStore())) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            byte[] value = bytes(4096);
            insertTransaction(1, value);
            // Corrupt the blob without updating the SQL digest or length.
            byte[] corrupt = bytes(4096);
            corrupt[0] = (byte) ~corrupt[0];
            jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ?"
                    + " WHERE journal_revision = 1", (Object) corrupt);
            // Fail closed: no BUILDING row, no pack, no watermark advance.
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isFalse();
            assertThat(packCount("BUILDING")).isZero();
            assertThat(packCount("PUBLISHED")).isZero();
            assertThat(watermark()).isZero();
        }
    }

    @Test
    void publishRollsBackWhenThePackRowWasReclaimedConcurrently() {
        try (var context = context(new PublicationProbeWiring.InMemoryObjectStore())) {
            JournalPackTransactions transactions = context.getBean(JournalPackTransactions.class);
            insertHead(2);
            insertTransaction(1, bytes(4096));
            insertTransaction(2, bytes(8192));
            String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
            long now = System.currentTimeMillis();
            transactions.insertBuilding("pack-A", scope, TENANT, WORKSPACE, SESSION, 1, 2,
                    "key-A", 100, "sha", now, "builder-A", now - 1);
            transactions.markPutClosed("pack-A", scope, TENANT, SESSION, "key-A");
            transactions.retireBuilding("pack-A", scope, TENANT, SESSION);
            // Publication must fail closed: the VERIFIED update matches no row, so the watermark
            // must never advance to a covered range that has no published pack.
            assertThatThrownBy(() -> transactions.publish("pack-A", scope, TENANT, WORKSPACE,
                    SESSION, 1, 2, "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                    .isInstanceOf(ManagedAgentException.class);
            assertThat(watermark()).isZero();
            assertThat(packCount("PUBLISHED")).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class))
                    .isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE"
                    + " owner_kind = 'JOURNAL'", Long.class)).isZero();
        }
    }

    @Test
    void insertBuildingDoesNotDisplaceALiveBuildOwnedByAnotherReplica() {
        try (var context = context(new PublicationProbeWiring.InMemoryObjectStore())) {
            JournalPackTransactions transactions = context.getBean(JournalPackTransactions.class);
            insertHead(1);
            insertTransaction(1, bytes(4096));
            String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
            long now = System.currentTimeMillis();
            long liveCutoff = now - 1;
            transactions.insertBuilding("pack-A", scope, TENANT, WORKSPACE, SESSION, 1, 1,
                    "key-A", 100, "shaA", now, "builder-A", liveCutoff);
            // Another replica's live build (different owner, within its lease) must not be
            // displaced: the INSERT collides on uk_ma_journal_pack_scope_from rather than deleting
            // A's in-flight row and object.
            assertThatThrownBy(() -> transactions.insertBuilding("pack-B", scope, TENANT,
                    WORKSPACE, SESSION, 1, 1, "key-B", 100, "shaB", now, "builder-B", liveCutoff))
                    .isInstanceOf(DuplicateKeyException.class);
            assertThat(packCount("BUILDING")).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT pack_id FROM ma_journal_pack WHERE state ="
                    + " 'BUILDING'", String.class)).isEqualTo("pack-A");
            // A second call on the same replica is not evidence that its first PUT has stopped.
            assertThatThrownBy(() -> transactions.insertBuilding("pack-A2", scope, TENANT,
                    WORKSPACE, SESSION, 1, 1, "key-A2", 100, "shaA2", now, "builder-A", liveCutoff))
                    .isInstanceOf(DuplicateKeyException.class);
            assertThat(packCount("BUILDING")).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT pack_id FROM ma_journal_pack WHERE state ="
                    + " 'BUILDING'", String.class)).isEqualTo("pack-A");
        }
    }

    @Test
    void latePutClosesOnlyItsRetiredUuidAfterANewRangePublishes() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        AtomicBoolean first = new AtomicBoolean(true);
        ProbeStore store = new ProbeStore() {
            @Override public void putIfAbsent(String key, byte[] value) {
                if (first.getAndSet(false)) {
                    started.countDown();
                    await(finish);
                }
                super.putIfAbsent(key, value);
            }
        };
        try (var context = context(store); var executor = Executors.newFixedThreadPool(1)) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            byte[] value = bytes(4096);
            insertTransaction(1, value);
            var late = executor.submit(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION));
            try {
                await(started);
                String oldKey = jdbc.queryForObject("SELECT object_key FROM ma_journal_pack", String.class);
                jdbc.update("UPDATE ma_journal_pack SET gmt_modified = 0");
                assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
                assertThat(packCount("RETIRED")).isEqualTo(1);
                assertThat(packs.collectOrphans()).isZero();
                assertThat(jdbc.queryForObject("SELECT is_put_closed FROM ma_journal_pack"
                        + " WHERE state = 'RETIRED'", Integer.class)).isZero();
                finish.countDown();
                assertThatThrownBy(() -> late.get(10, TimeUnit.SECONDS))
                        .hasCauseInstanceOf(ManagedAgentException.class);
                assertThat(jdbc.queryForObject("SELECT is_put_closed FROM ma_journal_pack"
                        + " WHERE state = 'RETIRED'", Integer.class)).isEqualTo(1);
                assertThat(packs.collectOrphans()).isEqualTo(1);
                assertThatThrownBy(() -> objects.open(oldKey)).isInstanceOf(IllegalStateException.class);
                assertThat(packCount("PUBLISHED")).isEqualTo(1);
                assertThat(watermark()).isEqualTo(1);
                assertThat(packs.resolveBytes(TENANT, SESSION, 1, JournalStoreRows.sha256(value),
                        value.length)).isEqualTo(value);
                assertThat(store.puts).hasSize(2).allSatisfy((key, count) -> assertThat(count).isEqualTo(1));
            } finally {
                finish.countDown();
            }
        }
    }

    @Test
    void lostPutResponseIsReconciledWithoutAnotherPut() {
        ProbeStore store = new ProbeStore() {
            @Override public void putIfAbsent(String key, byte[] value) {
                super.putIfAbsent(key, value);
                throw new IllegalStateException("lost PUT response");
            }
        };
        try (var context = context(store)) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            insertTransaction(1, bytes(4096));
            assertThatThrownBy(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION))
                    .hasMessage("lost PUT response");
            assertThat(packCount("RETIRED")).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT is_put_closed FROM ma_journal_pack", Integer.class)).isZero();
            assertThat(packs.collectOrphans()).isEqualTo(1);
            assertThat(packs.collectOrphans()).isZero();
            assertThat(store.puts).hasSize(1).allSatisfy((key, count) -> assertThat(count).isEqualTo(1));
        }
    }

    @Test
    void neverLandingPutRemainsUnknownWithoutBlockingANewRange() {
        AtomicBoolean first = new AtomicBoolean(true);
        ProbeStore store = new ProbeStore() {
            @Override public void putIfAbsent(String key, byte[] value) {
                if (first.getAndSet(false)) {
                    throw new IllegalStateException("PUT outcome unknown");
                }
                super.putIfAbsent(key, value);
            }
        };
        try (var context = context(store)) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            insertTransaction(1, bytes(4096));
            assertThatThrownBy(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION))
                    .hasMessage("PUT outcome unknown");
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
            assertThat(packs.collectOrphans()).isZero();
            assertThat(packs.collectOrphans()).isZero();
            assertThat(packCount("RETIRED")).isEqualTo(1);
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT is_put_closed FROM ma_journal_pack"
                    + " WHERE state = 'RETIRED'", Integer.class)).isZero();
        }
    }

    @Test
    void failedDeleteDoesNotDiscardDebtOrSkipTheNextClosedPack() {
        AtomicBoolean first = new AtomicBoolean(true);
        ProbeStore store = new ProbeStore() {
            @Override public void deleteIfPresent(String key) {
                if (first.getAndSet(false)) {
                    throw new IllegalStateException("DELETE failed");
                }
                super.deleteIfPresent(key);
            }
        };
        try (var context = context(store)) {
            insertHead(1);
            JournalPackTransactions transactions = context.getBean(JournalPackTransactions.class);
            insertDebt(transactions, "first", true);
            insertDebt(transactions, "second", true);
            assertThat(transactions.collectOrphans(0)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT pack_id FROM ma_journal_pack", String.class)).isEqualTo("first");
            assertThat(transactions.collectOrphans(0)).isEqualTo(1);
        }
    }

    @Test
    void closedReceiptFailureRetainsDebtAndNeverReputsTheOldUuid() {
        ProbeStore store = new ProbeStore();
        try (var context = context(store)) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            insertTransaction(1, bytes(4096));
            failNextUpdate("UPDATE ma_journal_pack SET is_put_closed");
            assertThatThrownBy(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION))
                    .hasMessage("injected SQL failure");
            assertThat(packCount("RETIRED")).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT is_put_closed FROM ma_journal_pack", Integer.class)).isZero();
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
            assertThat(packs.collectOrphans()).isEqualTo(1);
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
            assertThat(store.puts).hasSize(2).allSatisfy((key, count) -> assertThat(count).isEqualTo(1));
        }
    }

    @Test
    void failedDeleteConfirmationPreservesManifestAndClosedDebtForRetry() {
        ProbeStore store = new ProbeStore();
        try (var context = context(store)) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            insertTransaction(1, bytes(4096));
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
            jdbc.update("UPDATE ma_journal_pack SET state = 'RETIRED'");
            String key = jdbc.queryForObject("SELECT object_key FROM ma_journal_pack", String.class);
            failNextUpdate("DELETE FROM ma_journal_pack");
            assertThat(packs.collectOrphans()).isZero();
            assertThatThrownBy(() -> objects.open(key)).isInstanceOf(IllegalStateException.class);
            assertThat(packCount("RETIRED")).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Long.class)).isEqualTo(1);
            assertThat(packs.collectOrphans()).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Long.class)).isZero();
        }
    }

    @Test
    void twoCollectorsConfirmDeletionOnlyOnce() throws Exception {
        CountDownLatch deleted = new CountDownLatch(2);
        ProbeStore store = new ProbeStore() {
            @Override public void deleteIfPresent(String key) {
                super.deleteIfPresent(key);
                deleted.countDown();
                await(deleted);
            }
        };
        try (var context = context(store); var executor = Executors.newFixedThreadPool(2)) {
            insertHead(1);
            insertDebt(context.getBean(JournalPackTransactions.class), "closed", true);
            var other = new JournalPackTransactions(jdbc, store);
            var first = executor.submit(() -> context.getBean(JdbcJournalPacks.class).collectOrphans());
            var second = executor.submit(() -> other.collectOrphans(0));
            assertThat(first.get(10, TimeUnit.SECONDS) + second.get(10, TimeUnit.SECONDS)).isEqualTo(1);
            assertThat(packCount("RETIRED")).isZero();
        }
    }

    @Test
    void thirtyThreeUnknownPutsCannotStarveAClosedPack() {
        try (var context = context(new ProbeStore())) {
            insertHead(1);
            JournalPackTransactions transactions = context.getBean(JournalPackTransactions.class);
            for (int index = 0; index < 33; index++) {
                insertDebt(transactions, "unknown-" + index, false);
            }
            insertDebt(transactions, "closed", true);
            assertThat(transactions.collectOrphans(0)).isZero();
            assertThat(packCount("RETIRED")).isEqualTo(34);
            assertThat(transactions.collectOrphans(0)).isEqualTo(1);
            assertThat(packCount("RETIRED")).isEqualTo(33);
            assertThat(transactions.collectOrphans(0)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack WHERE is_put_closed = 1",
                    Long.class)).isZero();
        }
    }

    @Test
    void newlyArrivingPacksDoNotPreventRevisitingLatePuts() {
        try (var context = context(new ProbeStore())) {
            insertHead(1);
            JournalPackTransactions transactions = context.getBean(JournalPackTransactions.class);
            insertDebt(transactions, "late", false);
            for (int index = 1; index < 64; index++) {
                insertDebt(transactions, "original-" + index, false);
            }
            assertThat(transactions.collectOrphans(0)).isZero();
            objects.putIfAbsent("late", new byte[1]);
            for (int index = 0; index < 32; index++) {
                insertDebt(transactions, "new-first-" + index, false);
            }
            assertThat(transactions.collectOrphans(0)).isZero();
            for (int index = 0; index < 32; index++) {
                insertDebt(transactions, "new-second-" + index, false);
            }
            assertThat(transactions.collectOrphans(0)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack WHERE pack_id = ?", Long.class, "late")).isZero();
        }
    }

    @Test
    void mismatchedGetDoesNotCloseAnUnknownPut() {
        try (var context = context(new ProbeStore())) {
            insertHead(1);
            JournalPackTransactions transactions = context.getBean(JournalPackTransactions.class);
            insertDebt(transactions, "wrong-digest", false);
            objects.putIfAbsent("wrong-digest", new byte[] {1});
            insertDebt(transactions, "wrong-length", false);
            objects.putIfAbsent("wrong-length", new byte[] {0, 0});
            assertThat(transactions.collectOrphans(0)).isZero();
            assertThat(packCount("RETIRED")).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack WHERE is_put_closed = 1",
                    Long.class)).isZero();
        }
    }

    @Test
    void publicationRequiresClosedAndEvictionRechecksHeadCoverage() {
        try (var context = context(new ProbeStore())) {
            insertHead(1);
            insertTransaction(1, bytes(4096));
            JournalPackTransactions transactions = context.getBean(JournalPackTransactions.class);
            String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
            transactions.insertBuilding("open", scope, TENANT, WORKSPACE, SESSION, 1, 1,
                    "open", 1, JournalStoreRows.sha256(new byte[1]), 1, "builder", 0);
            assertThatThrownBy(() -> transactions.publish("open", scope, TENANT, WORKSPACE, SESSION,
                    1, 1, new byte[0])).isInstanceOf(ManagedAgentException.class);
            assertThat(watermark()).isZero();
            transactions.retireBuilding("open", scope, TENANT, SESSION);
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
            jdbc.update("UPDATE ma_session_head SET packed_through_revision = 0");
            assertThat(packs.deleteCoveredBlobs()).isZero();
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
            jdbc.update("UPDATE ma_session_head SET packed_through_revision = 1");
            jdbc.update("UPDATE ma_journal_pack SET state = 'RETIRED' WHERE state = 'PUBLISHED'");
            assertThat(packs.deleteCoveredBlobs()).isZero();
            assertThat(packCount("EVICTED")).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE"
                    + " record_bytes IS NOT NULL", Long.class)).isEqualTo(1);
        }
    }

    @Test
    void sweepStillCollectsWhenEvictionFails() {
        try (var context = context(new ProbeStore())) {
            insertHead(1);
            insertTransaction(1, bytes(4096));
            insertDebt(context.getBean(JournalPackTransactions.class), "closed", true);
            failNextUpdate("UPDATE ma_journal_pack SET state = 'EVICTED'");
            assertThatThrownBy(() -> context.getBean(JdbcJournalPacks.class).sweep())
                    .hasMessage("injected SQL failure");
            assertThat(packCount("RETIRED")).isZero();
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
        }
    }

    private void insertDebt(JournalPackTransactions transactions, String id, boolean closed) {
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        byte[] value = new byte[1];
        transactions.insertBuilding(id, scope, TENANT, WORKSPACE, SESSION, 1, 1, id,
                value.length, JournalStoreRows.sha256(value), 1, "builder", 0);
        if (closed) {
            objects.putIfAbsent(id, value);
            transactions.markPutClosed(id, scope, TENANT, SESSION, id);
        }
        transactions.retireBuilding(id, scope, TENANT, SESSION);
    }

    private void failNextUpdate(String prefix) {
        AtomicBoolean failed = new AtomicBoolean();
        doAnswer(invocation -> {
            String sql = invocation.getArgument(0);
            if (sql.startsWith(prefix) && failed.compareAndSet(false, true)) {
                throw new IllegalStateException("injected SQL failure");
            }
            return invocation.callRealMethod();
        }).when(jdbc).update(anyString(), any(Object[].class));
    }

    private static void await(CountDownLatch latch) {
        try {
            assertThat(latch.await(10, TimeUnit.SECONDS)).isTrue();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(error);
        }
    }

    private class ProbeStore implements ToolPublicationObjectStore {
        private final Map<String, Integer> puts = new ConcurrentHashMap<>();

        @Override public void validateConfiguration() {
        }

        @Override public void putIfAbsent(String key, byte[] value) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(puts.merge(key, 1, Integer::sum)).isEqualTo(1);
            objects.putIfAbsent(key, value);
        }

        @Override public InputStream open(String key) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            return objects.open(key);
        }

        @Override public InputStream openRange(String key, long offset, long length, Runnable guard) {
            return objects.openRange(key, offset, length, guard);
        }

        @Override public void deleteIfPresent(String key) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(jdbc.queryForObject("SELECT state FROM ma_journal_pack WHERE object_key = ?",
                    String.class, key)).isEqualTo("RETIRED");
            objects.deleteIfPresent(key);
        }
    }
}
