package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
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

class JournalColdStorageTest {
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ManagedAgentProperties settings;
    private MemoryObjects objects;
    private JournalColdStorage cold;
    private final byte[] bytes = new byte[7 * 1024 * 1024];

    @BeforeEach
    void setup() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:cold-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        settings = new ManagedAgentProperties();
        settings.getObjectStore().setJournalColdStorageEnabled(true);
        objects = new MemoryObjects();
        cold = restart();
        var sessions = VerificationFixtures.managedSessionStore(jdbc);
        sessions.acquireWriter("journal-tenant", "journal-session", "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 300000L));
        long old = System.currentTimeMillis() - Duration.ofDays(8).toMillis();
        jdbc.update("UPDATE ma_session SET session_kind = 'PUBLIC', agent_id = 'agent', status = 'CLOSED', gmt_modified = ?", old);
        jdbc.update("UPDATE ma_session_head SET state = 'SEALED', activation_phase = 'released', writer_lease_until = NULL, journal_revision = 5, committed_sequence = 0, gmt_modified = ? WHERE head_kind = 'MANAGED_SESSION'", old);
        String digest = DigestUtils.sha256Hex(bytes);
        for (int revision = 1; revision <= 5; revision++) {
            jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision, command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch, record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                    + " VALUES ('journal-tenant','workspace','journal-session',?, ?, ?, 'test', ?, ?, 0, 0, 0, 1, 'writer', ?, 0, 'identity', ?, ?, ?, ?)",
                    revision, DigestUtils.sha256Hex("command" + revision), "tx-" + revision, "command-" + revision, digest,
                    DigestUtils.sha256Hex("a".repeat(32)), bytes, bytes.length, digest, old);
        }
    }

    @AfterEach
    void close() {
        if (jdbc != null) {
            jdbc.execute("SHUTDOWN");
        }
    }

    private JournalColdStorage restart() {
        return new JournalColdStorage(jdbc, manager, objects, settings, new ObjectMapper());
    }

    @Test
    void packOnlyRolloutKeepsEveryBodyAndReaderLeasePreventsEviction() {
        assertThat(cold.archive("journal-tenant", "journal-session")).isTrue();
        assertThat(residency()).isEqualTo("HOT");
        assertBodies();
        settings.getObjectStore().setJournalEvictionEnabled(true);
        try (var lease = cold.pinHot("journal-tenant", "journal-session")) {
            lease.check();
            assertThat(cold.archive("journal-tenant", "journal-session")).isFalse();
        }
        assertThat(cold.archive("journal-tenant", "journal-session")).isTrue();
        assertThat(residency()).isEqualTo("COLD");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE record_bytes IS NOT NULL", Long.class)).isZero();
        settings.getObjectStore().setJournalColdStorageEnabled(false);
        restart().ensureHot("journal-tenant", "journal-session");
        assertBodies();
        assertThat(jdbc.queryForObject("SELECT compacted_through_revision FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'", Long.class)).isZero();
        assertThat(objects.puts).isEqualTo(2);
    }

    @Test
    void unknownPutReconcilesOriginalKeyAndNeverRepeatsCreate() {
        objects.losePut = true;
        assertThatThrownBy(() -> cold.archive("journal-tenant", "journal-session")).isInstanceOf(ManagedAgentException.class);
        objects.losePut = false;
        new SessionObjectMaintenance(jdbc, manager, objects, settings).runOnce();
        assertThat(restart().archive("journal-tenant", "journal-session")).isTrue();
        assertThat(objects.puts).isEqualTo(2);
        assertBodies();
    }

    @Test
    void restartHydratesPartialEvictionWithoutChangingRowsOrDigestChain() {
        settings.getObjectStore().setJournalEvictionEnabled(true);
        objects.beforeOpen = key -> {
            if ("EVICTING".equals(residency()) && key.endsWith("/2")) {
                throw new ObjectStorageException(ObjectStorageException.Reason.UNAVAILABLE, null);
            }
        };
        assertThatThrownBy(() -> cold.archive("journal-tenant", "journal-session")).isInstanceOf(ManagedAgentException.class);
        assertThat(residency()).isEqualTo("EVICTING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE record_bytes IS NULL", Long.class)).isEqualTo(4);
        objects.beforeOpen = key -> {};
        restart().ensureHot("journal-tenant", "journal-session");
        assertBodies();
        assertThat(residency()).isEqualTo("HOT");
    }

    @Test
    void readerInvalidatesOldEvictionEpochBeforeItCanClearBodies() {
        settings.getObjectStore().setJournalEvictionEnabled(true);
        objects.beforeOpen = key -> {
            if ("EVICTING".equals(residency())) {
                objects.beforeOpen = ignored -> {};
                restart().ensureHot("journal-tenant", "journal-session");
            }
        };
        assertThatThrownBy(() -> cold.archive("journal-tenant", "journal-session"))
                .isInstanceOfSatisfying(ManagedAgentException.class, failure -> assertThat(failure.getCode()).isEqualTo("managed_session_journal_rehydrating"));
        assertBodies();
        assertThat(residency()).isEqualTo("HOT");
    }

    @Test
    void hydratedPacksRetainRecoveryWindowThenUseDeletionLedger() {
        settings.getObjectStore().setJournalEvictionEnabled(true);
        cold.archive("journal-tenant", "journal-session");
        cold.ensureHot("journal-tenant", "journal-session");
        settings.getObjectStore().setJournalColdStorageEnabled(false);
        settings.getObjectStore().setGcEnabled(true);
        settings.getObjectStore().setDeletionGrace(Duration.ZERO);
        var maintenance = new SessionObjectMaintenance(jdbc, manager, objects, settings);
        maintenance.runOnce();
        assertThat(objects.values).hasSize(2);
        jdbc.update("UPDATE ma_operation SET completed_at = ? WHERE operation_kind = 'JOURNAL_ARCHIVE'", System.currentTimeMillis() - Duration.ofHours(25).toMillis());
        cold.runOnce();
        maintenance.runOnce();
        assertThat(objects.values).isEmpty();
        assertBodies();
    }

    @Test
    void codecRejectsCorruptionAndPreservesExactOriginalFraming() throws IOException {
        byte[] body = "{\"n\":1}\r\n{ \"n\": 2 }\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var records = List.of(new JournalPackCodec.Record(17, body, DigestUtils.sha256Hex(body)));
        byte[] encoded = JournalPackCodec.encode(records, () -> {});
        assertThat(JournalPackCodec.decode(encoded, 17, 17, () -> {}).getFirst().bytes()).isEqualTo(body);
        encoded[encoded.length - 1] ^= 1;
        assertThatThrownBy(() -> JournalPackCodec.decode(encoded, 17, 17, () -> {})).isInstanceOf(IOException.class);
    }

    @Test
    void hydrationRestartResumesAfterItsDurableBatchCursor() {
        settings.getObjectStore().setJournalEvictionEnabled(true);
        cold.archive("journal-tenant", "journal-session");
        objects.beforeOpen = key -> {
            if (key.endsWith("/2")) {
                throw new ObjectStorageException(ObjectStorageException.Reason.UNAVAILABLE, null);
            }
        };
        assertThatThrownBy(() -> cold.ensureHot("journal-tenant", "journal-session")).isInstanceOf(ManagedAgentException.class);
        assertThat(residency()).isEqualTo("HYDRATING");
        assertThat(jdbc.queryForObject("SELECT result_json FROM ma_operation WHERE operation_kind = 'JOURNAL_HYDRATE'", String.class)).contains("\"through\":4");
        objects.beforeOpen = key -> assertThat(key).endsWith("/2");
        restart().ensureHot("journal-tenant", "journal-session");
        assertBodies();
    }

    @Test
    void permanentRetirementReleasesColdPackOwnersAfterDeletingTheJournal() {
        settings.getObjectStore().setJournalEvictionEnabled(true);
        cold.archive("journal-tenant", "journal-session");
        jdbc.update("UPDATE ma_session SET retired_at = ?, retirement_generation = 1", System.currentTimeMillis());
        jdbc.update("UPDATE ma_session_head SET state = 'DELETED' WHERE head_kind = 'MANAGED_SESSION'");
        var sql = new org.springframework.transaction.support.TransactionTemplate(manager);
        assertThat(sql.<Boolean>execute(status -> ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, "journal-tenant", "journal-session", 128))).isTrue();
        assertThat(sql.<Boolean>execute(status -> ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, "journal-tenant", "journal-session", 128))).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'OPERATION'", Long.class)).isZero();
        settings.getObjectStore().setGcEnabled(true);
        settings.getObjectStore().setDeletionGrace(Duration.ZERO);
        new SessionObjectMaintenance(jdbc, manager, objects, settings).runOnce();
        assertThat(objects.values).isEmpty();
    }

    private String residency() {
        return jdbc.queryForObject("SELECT journal_residency FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'", String.class);
    }

    @Test
    void protectedInventoryHydratesBeforeOpeningItsSqlSnapshotAndRetainsAHotLease() {
        settings.getObjectStore().setJournalEvictionEnabled(true);
        cold.archive("journal-tenant", "journal-session");
        var resources = new SessionResourceTransactions(jdbc, manager, objects);
        var sql = new org.springframework.transaction.support.TransactionTemplate(manager);
        var stored = resources.protectedRead(() -> sql.execute(status -> {
            SessionResourceBodies.requireJournal("journal-tenant", "journal-session");
            assertThat(residency()).isEqualTo("HOT");
            assertThat(ToolPublicationRetentionStore.earliestReadLeaseExpiry(jdbc, "journal-tenant", "journal-session")).isPositive();
            return jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE journal_revision = 1", byte[].class);
        }), () -> {});
        assertThat(stored).isEqualTo(bytes);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_read_lease", Long.class)).isZero();
    }

    private void assertBodies() {
        var stored = jdbc.query("SELECT record_bytes FROM ma_session_journal_tx ORDER BY journal_revision", (row, index) -> row.getBytes(1));
        assertThat(stored).hasSize(5).allSatisfy(body -> assertThat(body).isEqualTo(bytes));
    }

    private final class MemoryObjects implements ImmutableObjectStore {
        private final Map<String, byte[]> values = new HashMap<>();
        private java.util.function.Consumer<String> beforeOpen = key -> {};
        private int puts;
        private boolean losePut;

        private void outside() {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(TransactionSynchronizationManager.hasResource(jdbc.getDataSource())).isFalse();
        }

        @Override
        public String identity() { return "test:journal"; }

        @Override
        public void putIfAbsent(String key, InputStream input, long length, Runnable guard) {
            outside();
            guard.run();
            puts++;
            try {
                if (values.putIfAbsent(key, input.readAllBytes()) != null) {
                    throw new ObjectStorageException(ObjectStorageException.Reason.ALREADY_EXISTS, null);
                }
            } catch (IOException failure) {
                throw new IllegalStateException(failure);
            }
            if (losePut) {
                throw new ObjectStorageException(ObjectStorageException.Reason.WRITE_OUTCOME_UNKNOWN, null);
            }
        }

        @Override
        public InputStream open(String key, Runnable guard) {
            outside();
            beforeOpen.accept(key);
            guard.run();
            byte[] content = values.get(key);
            if (content == null) {
                throw new ObjectStorageException(ObjectStorageException.Reason.NOT_FOUND, null);
            }
            return new ByteArrayInputStream(content);
        }

        @Override
        public void deleteIfPresent(String key, Runnable guard) {
            outside();
            guard.run();
            values.remove(key);
        }

        @Override
        public void validateConfiguration() { }

        @Override
        public void close() { }
    }
}
