package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H2 coverage for S1a resource externalization and S1b journal packs. */
class SessionOssStorageTest {
    private static final String TENANT = "tenant-oss";
    private static final String WORKSPACE = "workspace-oss";
    private static final String SESSION = "session-oss";

    private JdbcTemplate jdbc;
    private PublicationProbeWiring.InMemoryObjectStore objects;
    private JdbcSessionResourceObjects resources;
    private JdbcJournalPacks packs;
    private boolean enabled = true;
    private boolean deletionEnabled = true;

    @BeforeEach
    void setUp() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:oss-" + UUID.randomUUID()
                + ";DB_CLOSE_DELAY=-1;MODE=MySQL");
        Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load()
                .migrate();
        jdbc = new JdbcTemplate(source);
        objects = new PublicationProbeWiring.InMemoryObjectStore();
        ManagedAgentSettings settings = (ManagedAgentSettings) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {ManagedAgentSettings.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("getSessionResources")) {
                        return sessionResources();
                    }
                    return null;
                });
        resources = new JdbcSessionResourceObjects(jdbc, objects, settings);
        packs = new JdbcJournalPacks(jdbc, objects, settings);
    }

    private ManagedAgentSettings.SessionResources sessionResources() {
        return new ManagedAgentSettings.SessionResources() {
            @Override public boolean isEnabled() { return enabled; }
            @Override public String getOssKeyPrefix() { return "test-resources/"; }
            @Override public boolean isPackJobEnabled() { return true; }
            @Override public boolean isDeletionEnabled() { return deletionEnabled; }
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

    private JdbcSessionResourceObjects.AllocateRequest request(String id, byte[] value) {
        return new JdbcSessionResourceObjects.AllocateRequest(WORKSPACE, "writer", 1, id,
                "managed-agent-instructions", 1, value.length, JournalStoreRows.sha256(value));
    }

    @Test
    void externalizesAndReadsBackOversizedResource() {
        byte[] value = bytes(128 * 1024);
        var allocation = resources.allocate(TENANT, SESSION, request("res-1", value));
        resources.upload(TENANT, SESSION, "res-1", value);
        resources.finalize(TENANT, SESSION, "res-1");
        var stored = resources.readExternal(TENANT, WORKSPACE, SESSION, "res-1");
        assertThat(stored.bytes()).isEqualTo(value);
        assertThat(stored.digest()).isEqualTo(JournalStoreRows.sha256(value));
        assertThat(allocation.objectKey()).startsWith("test-resources/");
    }

    @Test
    void allocateReplayIsIdempotentAndDigestConflictIsRejected() {
        byte[] value = bytes(96 * 1024);
        var first = resources.allocate(TENANT, SESSION, request("res-2", value));
        var replay = resources.allocate(TENANT, SESSION, request("res-2", value));
        assertThat(replay.objectKey()).isEqualTo(first.objectKey());
        byte[] other = bytes(96 * 1024);
        other[0] = (byte) ~other[0];
        assertThatThrownBy(() -> resources.allocate(TENANT, SESSION, request("res-2", other)))
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void finalizeQuarantinesDigestMismatch() {
        byte[] value = bytes(96 * 1024);
        resources.allocate(TENANT, SESSION, request("res-3", value));
        byte[] wrong = bytes(96 * 1024);
        wrong[1] = (byte) ~wrong[1];
        resources.upload(TENANT, SESSION, "res-3", wrong);
        assertThatThrownBy(() -> resources.finalize(TENANT, SESSION, "res-3"))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT quarantine_reason FROM ma_resource WHERE"
                + " resource_id = ?", String.class,
                "res-3".getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                .isEqualTo("digest_mismatch");
    }

    @Test
    void disabledConfigurationFailsClosed() {
        enabled = false;
        assertThatThrownBy(() -> resources.allocate(TENANT, SESSION,
                request("res-4", bytes(96 * 1024))))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessageContaining("disabled");
    }

    private void insertHead(long journalRevision) {
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id,"
                + " workspace_id, session_id, harness_session_id, head_kind, state,"
                + " storage_version, writer_generation, journal_revision, committed_sequence,"
                + " last_commit_digest, activation_epoch, packed_through_revision, gmt_create,"
                + " gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'MANAGED_SESSION', 'ACTIVE', 1, 1,"
                + " ?, ?, 'digest', 0, 0, 0, 0)",
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(TENANT),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(SESSION),
                TENANT, WORKSPACE, SESSION, SESSION, journalRevision, journalRevision);
        assertThat(scope).isNotBlank();
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

    @Test
    void packsPublishResolveAndDeleteCoveredBlobs() {
        byte[] first = bytes(4096);
        byte[] second = bytes(8192);
        insertHead(2);
        insertTransaction(1, first);
        insertTransaction(2, second);
        assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
        assertThat(jdbc.queryForObject("SELECT packed_through_revision FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, TENANT, SESSION))
                .isEqualTo(2L);
        assertThat(packs.resolveBytes(TENANT, SESSION, 1, JournalStoreRows.sha256(first),
                first.length)).isEqualTo(first);
        assertThat(packs.resolveBytes(TENANT, SESSION, 2, JournalStoreRows.sha256(second),
                second.length)).isEqualTo(second);
        assertThat(packs.deleteCoveredBlobs()).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE"
                + " record_bytes IS NULL", Long.class)).isEqualTo(2L);
        assertThat(packs.resolveBytes(TENANT, SESSION, 2, JournalStoreRows.sha256(second),
                second.length)).isEqualTo(second);
    }

    @Test
    void packResolveRejectsDigestMismatch() {
        byte[] value = bytes(4096);
        insertHead(1);
        insertTransaction(1, value);
        assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
        assertThatThrownBy(() -> packs.resolveBytes(TENANT, SESSION, 1, "0".repeat(64),
                value.length)).isInstanceOf(ManagedAgentException.class);
    }

}
