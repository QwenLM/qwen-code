package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Regression for the pack publication commit boundary on the Spring-managed production path.
 *
 * <p>{@link JdbcJournalPacks#sweep()} invokes its own methods through {@code this}, which bypasses
 * the Spring proxy, so a {@code @Transactional} annotation on those methods would never be applied
 * and each statement would autocommit. The transactional boundary therefore lives in
 * {@link JournalPackTransactions}. These tests wire the beans through a real Spring context (not
 * {@code new JdbcJournalPacks}) and prove that (a) the head watermark and the PUBLISHED state commit
 * as one unit, and (b) a crash after the object PUT but before publication leaves a BUILDING row
 * that the orphan collector reclaims.
 */
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
        jdbc = new JdbcTemplate(source);
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
                + " storage_version, writer_generation, journal_revision, committed_sequence,"
                + " last_commit_digest, activation_epoch, packed_through_revision, gmt_create,"
                + " gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'MANAGED_SESSION', 'ACTIVE', 1, 1,"
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
            // If the statements autocommitted, the pack would be VERIFIED/PUBLISHED and the
            // watermark would have advanced to 2. Atomic rollback leaves BUILDING and 999.
            assertThat(packCount("BUILDING")).isEqualTo(1);
            assertThat(packCount("VERIFIED")).isZero();
            assertThat(packCount("PUBLISHED")).isZero();
            assertThat(watermark()).isEqualTo(999L);
            // No manifest resource or reference may survive the rolled-back publication.
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class))
                    .isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE"
                    + " owner_kind = 'JOURNAL'", Long.class)).isZero();
            // The orphan collector reclaims the stranded BUILDING row and its object.
            assertThat(packs.collectOrphans()).isEqualTo(1);
            assertThat(packCount("BUILDING")).isZero();
        }
    }

    @Test
    void crashBetweenPutAndPublishLeavesAReclaimableBuildingRow() {
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
            assertThat(packCount("BUILDING")).isEqualTo(1);
            assertThat(watermark()).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack", Long.class))
                    .isEqualTo(1);
            String objectKey = jdbc.queryForObject("SELECT object_key FROM ma_journal_pack"
                    + " WHERE state = 'BUILDING'", String.class);
            // The orphan collector reclaims the BUILDING row and deletes the orphaned object.
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
    void retryAfterACrashedBuildReclaimsTheBuildingRowInsteadOfConflicting() {
        try (var context = context(new CrashOnceStore())) {
            JdbcJournalPacks packs = context.getBean(JdbcJournalPacks.class);
            insertHead(1);
            byte[] value = bytes(4096);
            insertTransaction(1, value);
            // First attempt: BUILDING commits, PUT lands, read-back crashes.
            assertThatThrownBy(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(packCount("BUILDING")).isEqualTo(1);
            assertThat(watermark()).isZero();
            // Retry of the same (scope, from_revision) must reclaim the stranded BUILDING row
            // rather than violate uk_ma_journal_pack_scope_from, then publish.
            assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
            assertThat(watermark()).isEqualTo(1L);
            assertThat(packCount("PUBLISHED")).isEqualTo(1);
            assertThat(packCount("BUILDING")).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack", Long.class))
                    .isEqualTo(1);
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
}
