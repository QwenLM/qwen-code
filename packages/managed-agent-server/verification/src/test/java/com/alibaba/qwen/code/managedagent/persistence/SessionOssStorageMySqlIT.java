package com.alibaba.qwen.code.managedagent.persistence;

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

import java.lang.reflect.Proxy;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Real MySQL evidence for S1a/S1b SQL: allocation idempotency, finalize verification, pack
 * publish watermark CAS, range resolution and grace deletion. Requires
 * -Dqwen.o4.mysql.url pointing at a disposable dedicated MySQL 8.4 instance.
 */
@Timeout(120)
class SessionOssStorageMySqlIT {
    private static final String TENANT = "tenant-oss-it";
    private static final String WORKSPACE = "workspace-oss-it";
    private static final String SESSION = "session-oss-it";

    private O4MySqlDatabase database;
    private JdbcTemplate jdbc;
    private JdbcSessionResourceObjects resources;
    private JdbcJournalPacks packs;

    @BeforeEach
    void setUp() {
        database = new O4MySqlDatabase();
        Flyway.configure().dataSource(database.source())
                .locations("classpath:db/managed-schema").load().migrate();
        jdbc = new JdbcTemplate(database.source());
        var objects = new PublicationProbeWiring.InMemoryObjectStore();
        ManagedAgentSettings settings = (ManagedAgentSettings) Proxy.newProxyInstance(
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
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id,"
                + " workspace_id, session_id, harness_session_id, head_kind, state,"
                + " storage_version, writer_generation, journal_revision, committed_sequence,"
                + " last_commit_digest, activation_epoch, packed_through_revision, gmt_create,"
                + " gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'MANAGED_SESSION', 'ACTIVE', 1, 1,"
                + " 2, 2, 'digest', 0, 0, 0, 0)",
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(TENANT),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(SESSION),
                TENANT, WORKSPACE, SESSION, SESSION);
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
