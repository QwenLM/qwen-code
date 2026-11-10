package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AllocateResourceRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SessionObjectResourcesTest {
    private static final String TOKEN = "a".repeat(32);
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private JdbcManagedSessionStore sessions;
    private SessionObjectResources resources;
    private ManagedAgentProperties settings;
    private MemoryObjects objects;
    private final byte[] bytes = new byte[65537];

    @BeforeEach
    void setUp() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:objects-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        objects = new MemoryObjects();
        settings = new ManagedAgentProperties();
        settings.getObjectStore().setResourceWritesEnabled(true);
        sessions = VerificationFixtures.managedSessionStore(jdbc);
        resources = createResources(sessions);
        sessions.acquireWriter("journal-tenant", "journal-session", TOKEN,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 300000L));
    }

    @AfterEach
    void closeDatabase() {
        jdbc.execute("SHUTDOWN");
    }

    private SessionObjectResources createResources(JdbcManagedSessionStore store) {
        return new SessionObjectResources(jdbc, manager, store, objects, settings, new ObjectMapper(), StorageReadPolicy.inProcess());
    }

    private AllocateResourceRequest request() {
        return new AllocateResourceRequest("workspace", "writer", 1, "external", "managed-context", 1, bytes.length, DigestUtils.sha256Hex(bytes));
    }

    @Test
    void publishCommitAndRestartReadKeepObjectIoOutsideTransactions() {
        var allocation = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource", String.class)).isEqualTo("ALLOCATED");
        resources.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource", String.class)).isEqualTo("PUBLISHED");
        var genesis = JournalLockContractTest.genesis();
        byte[] records = (" ".repeat(65537) + new String(java.util.Base64.getDecoder().decode(genesis.recordBytesBase64()),
                java.nio.charset.StandardCharsets.UTF_8)).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest(genesis.workspaceId(), genesis.writerId(), genesis.writerGeneration(),
                genesis.expectedJournalRevision(), genesis.expectedCommittedSequence(), genesis.transactionId(), genesis.operation(), genesis.commandId(),
                DigestUtils.sha256Hex(records), genesis.firstSequence(), genesis.lastSequence(), genesis.eventCount(), genesis.eventsDigest(),
                genesis.previousCommitDigest(), genesis.commitDigest(), genesis.activationEpoch(), genesis.latestCheckpointResourceId(),
                genesis.recordCount(), java.util.Base64.getEncoder().encodeToString(records), DigestUtils.sha256Hex(records), List.of(new ManagedSessionStoreModels.CommitResource(
                        "external", "managed-context", 1, bytes.length, DigestUtils.sha256Hex(bytes), null)));
        sessions.commit("journal-tenant", "journal-session", TOKEN, commit);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource", String.class)).isEqualTo("REFERENCED");
        assertThat(jdbc.queryForObject("SELECT storage_version FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'", Integer.class)).isEqualTo(6);
        var restarted = VerificationFixtures.managedSessionStore(jdbc);
        createResources(restarted);
        assertThat(restarted.readResource("journal-tenant", "workspace", "journal-session", "external", TOKEN).bytes()).isEqualTo(bytes);
        assertThat(objects.puts).isEqualTo(1);
        var snapshots = new ManagedNativeJournalSnapshots(jdbc, restarted, new ObjectMapper());
        snapshots.configureObjectResources(resources);
        var head = restarted.restore("journal-tenant", "workspace", "journal-session", TOKEN);
        var snapshot = snapshots.publish("journal-tenant", "journal-session", TOKEN,
                new ManagedNativeJournalSnapshots.PublishRequest("workspace", "writer", 1, "external-snapshot",
                        head.journalRevision(), head.committedSequence(), head.lastCommitDigest()));
        assertThat(snapshot.snapshot().coveredJournalRevision()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT storage_kind FROM ma_resource WHERE kind = ?", String.class,
                "managed-native-journal-snapshot-page")).isEqualTo("OBJECT_STORE");
        assertThat(snapshots.pages("journal-tenant", "workspace", "journal-session", TOKEN, "external-snapshot", 0, 10).pages()).hasSize(1);
        settings.getObjectStore().setResourceWritesEnabled(false);
        int puts = objects.puts;
        snapshots.publish("journal-tenant", "journal-session", TOKEN,
                new ManagedNativeJournalSnapshots.PublishRequest("workspace", "writer", 1, "reused-snapshot",
                        head.journalRevision(), head.committedSequence(), head.lastCommitDigest()));
        assertThat(objects.puts).isEqualTo(puts);
        assertThat(snapshots.pages("journal-tenant", "workspace", "journal-session", TOKEN, "reused-snapshot", 0, 10).pages()).hasSize(1);
    }

    @Test
    void lostPutResponseReconcilesOriginalObjectEvenWhenWritesAreDisabled() {
        var allocation = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        objects.losePutResponse = true;
        assertThatThrownBy(() -> resources.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null))
                .isInstanceOf(ManagedAgentException.class).hasMessageContaining("not been verified");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'", String.class)).isEqualTo("UNKNOWN");
        settings.getObjectStore().setResourceWritesEnabled(false);
        var restarted = VerificationFixtures.managedSessionStore(jdbc);
        var publisher = createResources(restarted);
        publisher.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, InputStream.nullInputStream(), null);
        assertThat(objects.puts).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource", String.class)).isEqualTo("PUBLISHED");
    }

    @Test
    void unverifiedBytesCannotCommitAndUncertainAbsenceCannotBeCollected() {
        var allocation = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        objects.losePutResponse = true;
        objects.dropPut = true;
        assertThatThrownBy(() -> resources.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null))
                .isInstanceOf(ManagedAgentException.class);
        settings.getObjectStore().setGcEnabled(true);
        settings.getObjectStore().setDeletionGrace(Duration.ZERO);
        jdbc.update("UPDATE ma_session_head SET state = 'SEALED', writer_lease_until = NULL WHERE head_kind = 'MANAGED_SESSION'");
        new SessionObjectMaintenance(jdbc, manager, objects, settings).runOnce();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'", String.class)).isEqualTo("UNKNOWN");
        assertThat(objects.deletes).isZero();
    }

    @Test
    void fencedUnreferencedObjectsUseDurableDeleteIntentAndRetryLostResponse() {
        var allocation = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        resources.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null);
        settings.getObjectStore().setGcEnabled(true);
        settings.getObjectStore().setDeletionGrace(Duration.ZERO);
        var collector = new SessionObjectMaintenance(jdbc, manager, objects, settings);
        collector.runOnce();
        assertThat(objects.deletes).isZero();
        assertThat(jdbc.queryForObject("SELECT retention_until FROM ma_resource", Long.class)).isNull();
        jdbc.update("UPDATE ma_session_head SET writer_generation = 2 WHERE head_kind = 'MANAGED_SESSION'");
        objects.loseDeleteResponse = true;
        collector.runOnce();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource", String.class)).isEqualTo("DELETING");
        objects.loseDeleteResponse = false;
        collector.runOnce();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource", String.class)).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'SESSION_OBJECT_GC'", String.class)).isEqualTo("SUCCEEDED");
    }

    @Test
    void preparedReadsNeverOpenTheBackendWhileHoldingSql() {
        var allocation = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        resources.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null);
        var rows = new JournalStoreRows(StorageReadPolicy.inProcess(), jdbc);
        var row = rows.findResource(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey("journal-tenant", "journal-session"), "external", false);
        var bodies = new SessionResourceBodies(jdbc, objects);
        var transaction = new TransactionTemplate(manager);
        assertThatThrownBy(() -> transaction.execute(status -> bodies.read(row, () -> {}))).hasMessageContaining("transaction-free");
        try (var prepared = bodies.prepare()) {
            bodies.prepare(prepared, row, () -> {});
            int reads = objects.reads;
            byte[] restored = transaction.execute(status -> bodies.read(row, () -> {}));
            assertThat(restored).isEqualTo(bytes);
            assertThat(objects.reads).isEqualTo(reads);
        }
    }

    @Test
    void writerTakeoverReconcilesTheOriginalPutWithoutSendingAgain() {
        var allocated = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        objects.losePutResponse = true;
        assertThatThrownBy(() -> resources.upload("journal-tenant", "journal-session", "external", allocated.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null))
                .isInstanceOf(ManagedAgentException.class);
        jdbc.update("UPDATE ma_session_head SET writer_id = 'writer2', writer_generation = 2 WHERE head_kind = 'MANAGED_SESSION'");
        var replacement = new AllocateResourceRequest("workspace", "writer2", 2, "external", "managed-context", 1, bytes.length, DigestUtils.sha256Hex(bytes));
        var takenOver = resources.allocate("journal-tenant", "journal-session", TOKEN, replacement, null);
        assertThat(takenOver.uploadId()).isEqualTo(allocated.uploadId());
        resources.upload("journal-tenant", "journal-session", "external", takenOver.uploadId(), TOKEN, InputStream.nullInputStream(), null);
        assertThat(objects.puts).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource", String.class)).isEqualTo("PUBLISHED");
    }

    @Test
    void serverSkillsSurviveWriterRetirementUntilTheSessionRetires() {
        jdbc.update("UPDATE ma_session SET workspace_id = 'workspace'");
        var skills = List.<Map<String, Object>>of(Map.of("name", "large", "description", "Large skill", "body", "x".repeat(70000)));
        var ref = sessions.publishAgentSkills("journal-tenant", "workspace", "journal-session", skills);
        assertThat(ref.byteLength()).isGreaterThan(65536);
        assertThat(jdbc.queryForObject("SELECT storage_kind FROM ma_resource", String.class)).isEqualTo("OBJECT_STORE");
        settings.getObjectStore().setGcEnabled(true);
        settings.getObjectStore().setDeletionGrace(Duration.ZERO);
        jdbc.update("UPDATE ma_session_head SET writer_generation = 2 WHERE head_kind = 'MANAGED_SESSION'");
        new SessionObjectMaintenance(jdbc, manager, objects, settings).runOnce();
        assertThat(objects.deletes).isZero();
        assertThat(sessions.publishAgentSkills("journal-tenant", "workspace", "journal-session", skills)).isEqualTo(ref);
        assertThat(objects.puts).isEqualTo(1);
    }

    @Test
    void missingPreparedDependencyRollsBackSqlBeforeFetching() {
        var allocation = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        resources.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null);
        var rows = new JournalStoreRows(StorageReadPolicy.inProcess(), jdbc);
        var bodies = new SessionResourceBodies(jdbc, objects);
        var attempts = new java.util.concurrent.atomic.AtomicInteger();
        var restored = new SessionResourceTransactions(jdbc, manager, objects).read("journal-tenant", "journal-session", () -> {
            attempts.incrementAndGet();
            jdbc.update("UPDATE ma_session SET version = version + 1");
            return bodies.read(rows.findResource(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey("journal-tenant", "journal-session"), "external"), () -> {});
        });
        assertThat(restored).isEqualTo(bytes);
        assertThat(attempts).hasValue(2);
        assertThat(jdbc.queryForObject("SELECT version FROM ma_session", Long.class)).isEqualTo(1);
    }

    @Test
    void namespaceDriftNeverReadsOrDeletesFromTheReplacementStore() {
        var allocation = resources.allocate("journal-tenant", "journal-session", TOKEN, request(), null);
        resources.upload("journal-tenant", "journal-session", "external", allocation.uploadId(), TOKEN, new ByteArrayInputStream(bytes), null);
        int reads = objects.reads;
        objects.namespace = "memory:replacement";
        var rows = new JournalStoreRows(StorageReadPolicy.inProcess(), jdbc);
        var row = rows.findResource(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey("journal-tenant", "journal-session"), "external", false);
        assertThatThrownBy(() -> new SessionResourceBodies(jdbc, objects).read(row, () -> {}))
                .isInstanceOf(ManagedAgentException.class).hasMessageContaining("does not own");
        settings.getObjectStore().setGcEnabled(true);
        settings.getObjectStore().setDeletionGrace(Duration.ZERO);
        jdbc.update("UPDATE ma_session_head SET writer_generation = 2 WHERE head_kind = 'MANAGED_SESSION'");
        new SessionObjectMaintenance(jdbc, manager, objects, settings).runOnce();
        assertThat(objects.reads).isEqualTo(reads);
        assertThat(objects.deletes).isZero();
    }

    private final class MemoryObjects implements ImmutableObjectStore {
        private final Map<String, byte[]> values = new HashMap<>();
        private int puts;
        private int reads;
        private int deletes;
        private boolean losePutResponse;
        private boolean dropPut;
        private boolean loseDeleteResponse;
        private String namespace = "memory:test";

        private void outside() {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(TransactionSynchronizationManager.hasResource(jdbc.getDataSource())).isFalse();
        }

        @Override
        public String identity() { return namespace; }

        @Override
        public void putIfAbsent(String key, InputStream source, long length, Runnable guard) {
            outside();
            guard.run();
            puts++;
            try {
                byte[] content = source.readAllBytes();
                assertThat(content).hasSize((int) length);
                if (!dropPut && values.putIfAbsent(key, content) != null) {
                    throw new ObjectStorageException(ObjectStorageException.Reason.ALREADY_EXISTS, null);
                }
            } catch (IOException failure) {
                throw new IllegalStateException(failure);
            }
            if (losePutResponse) {
                throw new ObjectStorageException(ObjectStorageException.Reason.WRITE_OUTCOME_UNKNOWN, null);
            }
        }

        @Override
        public InputStream open(String key, Runnable guard) {
            outside();
            guard.run();
            reads++;
            byte[] content = values.get(key);
            if (content == null) {
                throw new ObjectStorageException(ObjectStorageException.Reason.NOT_FOUND, null);
            }
            return new ByteArrayInputStream(content) {
                @Override
                public synchronized int read(byte[] target, int offset, int length) {
                    outside();
                    guard.run();
                    return super.read(target, offset, length);
                }
            };
        }

        @Override
        public void deleteIfPresent(String key, Runnable guard) {
            outside();
            guard.run();
            deletes++;
            assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE object_key = ?", String.class, key)).isEqualTo("DELETING");
            values.remove(key);
            if (loseDeleteResponse) {
                throw new ObjectStorageException(ObjectStorageException.Reason.UNAVAILABLE, null);
            }
        }

        @Override
        public void validateConfiguration() { }

        @Override
        public void close() { }
    }
}
