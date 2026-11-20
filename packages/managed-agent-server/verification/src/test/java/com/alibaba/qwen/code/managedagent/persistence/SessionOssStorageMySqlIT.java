package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Real MySQL evidence for S1a/S1b SQL: allocation idempotency, finalize verification, pack
 * publish watermark CAS, range resolution and grace deletion. Requires
 * -Dmysql.url and -Dmysql.user pointing at a disposable MySQL 8.4 instance.
 */
@Timeout(120)
class SessionOssStorageMySqlIT {
    private static final String TENANT = "tenant-oss-it";
    private static final String WORKSPACE = "workspace-oss-it";
    private static final String SESSION = "session-oss-it";

    private IsolatedManagedSchemaMySqlTestDatabase database;
    private JdbcTemplate jdbc;
    private JdbcSessionResourceObjects resources;
    private JdbcJournalPacks packs;
    private PublicationProbeWiring.InMemoryObjectStore objects;
    private ManagedAgentSettings settings;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        Flyway.configure().dataSource(database.source())
                .locations("classpath:db/managed-schema").load().migrate();
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        objects = new PublicationProbeWiring.InMemoryObjectStore();
        settings = (ManagedAgentSettings) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {ManagedAgentSettings.class},
                (proxy, method, args) -> method.getName().equals("getSessionResources")
                        ? sessionResources() : null);
        resources = new JdbcSessionResourceObjects(jdbc, objects, settings);
        packs = new JdbcJournalPacks(jdbc, objects, settings);
    }

    @AfterEach
    void tearDown() {
        if (database != null) {
            database.close();
        }
    }

    private ManagedAgentSettings.SessionResources sessionResources() {
        return new ManagedAgentSettings.SessionResources() {
            @Override public boolean isEnabled() { return true; }
            @Override public String getOssKeyPrefix() { return "it-resources/"; }
            @Override public boolean isPackJobEnabled() { return true; }
            @Override public boolean isDeletionEnabled() { return true; }
            @Override public long getPackTargetBytes() { return 16L * 1024 * 1024; }
            @Override public int getPackMaxTransactions() { return 4096; }
            @Override public Duration getDeletionGrace() { return Duration.ZERO; }
        };
    }

    private byte[] bytes(int size) {
        byte[] value = new byte[size];
        for (int index = 0; index < size; index++) {
            value[index] = (byte) (index % 251);
        }
        return value;
    }

    @Test
    void externalizationAndPacksSurviveRealMysqlTransactions() {
        byte[] value = bytes(128 * 1024);
        var request = new JdbcSessionResourceObjects.AllocateRequest(WORKSPACE, "writer", 1,
                "res-it", "managed-agent-instructions", 1, value.length,
                JournalStoreRows.sha256(value));
        var allocation = resources.allocate(TENANT, SESSION, request);
        assertThat(resources.allocate(TENANT, SESSION, request).objectKey())
                .isEqualTo(allocation.objectKey());
        resources.upload(TENANT, SESSION, "res-it", value);
        resources.finalize(TENANT, SESSION, "res-it");
        assertThat(resources.readExternal(TENANT, WORKSPACE, SESSION, "res-it").bytes())
                .isEqualTo(value);

        byte[] first = bytes(4096);
        byte[] second = bytes(8192);
        insertHead(2);
        insertTransaction(1, first);
        insertTransaction(2, second);
        assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
        assertThat(packs.resolveBytes(TENANT, SESSION, 1, JournalStoreRows.sha256(first),
                first.length)).isEqualTo(first);
        assertThat(packs.deleteCoveredBlobs()).isEqualTo(2);
        assertThat(packs.resolveBytes(TENANT, SESSION, 2, JournalStoreRows.sha256(second),
                second.length)).isEqualTo(second);
        assertThatThrownBy(() -> packs.resolveBytes(TENANT, SESSION, 2, "0".repeat(64),
                second.length)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void latePutWithLostResponseDoesNotBlockReplacementOrDeleteItsObject() throws Exception {
        insertHead(1);
        byte[] value = bytes(4096);
        insertTransaction(1, value);
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        AtomicBoolean first = new AtomicBoolean(true);
        ToolPublicationObjectStore delayed = new ToolPublicationObjectStore() {
            @Override public void validateConfiguration() {
            }

            @Override public void putIfAbsent(String key, byte[] content) {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                if (first.getAndSet(false)) {
                    started.countDown();
                    await(finish);
                    objects.putIfAbsent(key, content);
                    throw new IllegalStateException("lost late PUT response");
                }
                objects.putIfAbsent(key, content);
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
                objects.deleteIfPresent(key);
            }
        };
        packs = new JdbcJournalPacks(jdbc, delayed, settings);
        try (var executor = Executors.newFixedThreadPool(1)) {
            var late = executor.submit(() -> packs.compactOnce(TENANT, WORKSPACE, SESSION));
            try {
                await(started);
                String oldKey = jdbc.queryForObject("SELECT object_key FROM ma_journal_pack", String.class);
                jdbc.update("UPDATE ma_journal_pack SET gmt_modified = 0");
                assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
                assertThat(packs.collectOrphans()).isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack", Long.class)).isEqualTo(2);
                finish.countDown();
                assertThatThrownBy(() -> late.get(10, TimeUnit.SECONDS))
                        .hasRootCauseMessage("lost late PUT response");
                assertThat(jdbc.queryForObject("SELECT is_put_closed FROM ma_journal_pack WHERE"
                        + " state = 'RETIRED'", Integer.class)).isZero();
                assertThat(packs.collectOrphans()).isEqualTo(1);
                assertThatThrownBy(() -> objects.open(oldKey)).isInstanceOf(IllegalStateException.class);
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack WHERE"
                        + " state = 'PUBLISHED'", Long.class)).isEqualTo(1);
                assertThat(packs.resolveBytes(TENANT, SESSION, 1, JournalStoreRows.sha256(value),
                        value.length)).isEqualTo(value);
            } finally {
                finish.countDown();
            }
        }
    }

    @Test
    void gcAndPublishBothWaitForRootBeforeLockingPack() throws Exception {
        insertHead(1);
        insertTransaction(1, bytes(4096));
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        JournalPackTransactions transactions = new JournalPackTransactions(jdbc, objects);
        byte[] value = new byte[1];
        transactions.insertBuilding("racing", scope, TENANT, WORKSPACE, SESSION, 1, 1,
                "racing", value.length, JournalStoreRows.sha256(value), 1, "builder", 0);
        objects.putIfAbsent("racing", value);
        transactions.markPutClosed("racing", scope, TENANT, SESSION, "racing");
        CountDownLatch publisherRoot = new CountDownLatch(1);
        CountDownLatch collectorRoot = new CountDownLatch(1);
        JournalPackTransactions publisher = new JournalPackTransactions(rootObservedJdbc(publisherRoot), objects);
        JournalPackTransactions collector = new JournalPackTransactions(rootObservedJdbc(collectorRoot), objects);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var futures = new TransactionTemplate(new DataSourceTransactionManager(database.source()))
                    .execute(status -> {
                        ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, TENANT, SESSION);
                        Future<Boolean> publish = executor.submit(() -> {
                            try {
                                publisher.publish("racing", scope, TENANT, WORKSPACE, SESSION, 1, 1,
                                        new byte[0]);
                                return true;
                            } catch (ManagedAgentException conflict) {
                                return false;
                            }
                        });
                        Future<Integer> collect = executor.submit(() -> collector.collectOrphans(Long.MAX_VALUE));
                        await(publisherRoot);
                        await(collectorRoot);
                        // Neither contender may hold the pack while waiting on our root/head.
                        jdbc.queryForList("SELECT pack_id FROM ma_journal_pack WHERE pack_id = ? FOR UPDATE",
                                "racing");
                        return new PackRace(publish, collect);
                    });
            boolean published = futures.publish().get(10, TimeUnit.SECONDS);
            int collected = futures.collect().get(10, TimeUnit.SECONDS);
            assertThat(collected).isEqualTo(published ? 0 : 1);
            assertThat(jdbc.queryForObject("SELECT packed_through_revision FROM ma_session_head",
                    Long.class)).isEqualTo(published ? 1 : 0);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_journal_pack", Long.class))
                    .isEqualTo(published ? 1 : 0);
        }
    }

    @Test
    void retirementWinsBeforeQueuedEvictionWithoutResurrectingThePack() throws Exception {
        insertHead(1);
        insertTransaction(1, bytes(4096));
        assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
        CountDownLatch rootAttempt = new CountDownLatch(1);
        JournalPackTransactions observed = new JournalPackTransactions(rootObservedJdbc(rootAttempt), objects);
        try (var executor = Executors.newFixedThreadPool(1)) {
            Future<Integer> eviction = new TransactionTemplate(new DataSourceTransactionManager(database.source()))
                    .execute(status -> {
                        ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, TENANT, SESSION);
                        Future<Integer> queued = executor.submit(() -> observed.deleteCoveredBlobs(Long.MAX_VALUE));
                        await(rootAttempt);
                        jdbc.update("UPDATE ma_session SET retired_at = 1, retirement_generation = 1,"
                                + " retirement_operation_id = 'retirement' WHERE tenant_id = ? AND session_id = ?",
                                TENANT, SESSION);
                        jdbc.update("UPDATE ma_session_head SET state = 'DELETED' WHERE tenant_id = ?"
                                + " AND session_id = ?", TENANT, SESSION);
                        assertThat(ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, TENANT, SESSION, 1)).isTrue();
                        return queued;
                    });
            assertThat(eviction.get(10, TimeUnit.SECONDS)).isZero();
            assertThat(jdbc.queryForObject("SELECT state FROM ma_journal_pack", String.class)).isEqualTo("RETIRED");
            assertThat(packs.collectOrphans()).isEqualTo(1);
        }
    }

    private record PackRace(Future<Boolean> publish, Future<Integer> collect) {
    }

    private JdbcTemplate rootObservedJdbc(CountDownLatch attempted) {
        return new ManagedSchemaJdbcTemplate(database.source()) {
            @Override public int update(String sql, PreparedStatementSetter parameters) {
                if (sql.startsWith("INSERT INTO ma_session (")) {
                    attempted.countDown();
                }
                return super.update(sql, parameters);
            }
        };
    }

    private static void await(CountDownLatch latch) {
        try {
            assertThat(latch.await(10, TimeUnit.SECONDS)).isTrue();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(error);
        }
    }

    private void insertHead(long revision) {
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id,"
                + " workspace_id, session_id, harness_session_id, head_kind, state,"
                + " storage_version, writer_generation, journal_revision, committed_sequence,"
                + " last_commit_digest, activation_epoch, packed_through_revision, gmt_create,"
                + " gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'MANAGED_SESSION', 'ACTIVE', 1, 1,"
                + " ?, ?, 'digest', 0, 0, 0, 0)",
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(TENANT),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(SESSION),
                TENANT, WORKSPACE, SESSION, SESSION, revision, revision);
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
}
