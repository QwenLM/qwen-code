package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.managedagent.persistence.JdbcJournalPacks;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Covers {@link CsiPackRecords#resolve}, the shared pack fallback used by the three CSI journal
 * read points (activation history, terminal history and the dispatch checkpoint). Once
 * {@code compactOnce()} publishes a pack and {@code deleteCoveredBlobs()} nulls the covered SQL
 * blob, the resolver must return the packed bytes; with no pack, or no object store, it must return
 * null so the admission callers stay fail-closed.
 *
 * <p>The end-to-end CSI admission paths themselves require full native-proof fixtures (genesis,
 * activation and checkpoint digest chains) that this journal-only harness does not build, so their
 * pack resolution is exercised here at the shared resolver rather than through the admission gates.
 */
class CsiPackRecordsTest {
    private static final String TENANT = "tenant";
    private static final String WORKSPACE = "workspace";
    private static final String SESSION = "session";

    private JdbcTemplate jdbc;
    private JdbcJournalPacks packs;
    private byte[] bytes;

    @BeforeEach
    void setUp() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:csi-pack-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        PublicationProbeWiring.InMemoryObjectStore objects = new PublicationProbeWiring.InMemoryObjectStore();
        ManagedAgentSettings settings = (ManagedAgentSettings) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {ManagedAgentSettings.class},
                (proxy, method, args) -> method.getName().equals("getSessionResources")
                        ? sessionResources() : null);
        packs = new JdbcJournalPacks(jdbc, objects, settings);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                + " gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)", TENANT, SESSION);
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, workspace_id,"
                        + " session_id, harness_session_id, head_kind, state, journal_revision,"
                        + " committed_sequence, compacted_through_revision, packed_through_revision,"
                        + " writer_generation, activation_epoch, storage_version, writer_lease_until,"
                        + " gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'MANAGED_SESSION',"
                        + " 'ACTIVE', 1, 0, 0, 0, 1, 0, 1, 1, 1, 1)",
                ManagedSchemaKeys.key(TENANT), ManagedSchemaKeys.key(SESSION), TENANT, WORKSPACE,
                SESSION, SESSION);
        bytes = "{\"subtype\":\"managed_session_event_v1\",\"managedSession\":{\"kind\":\"input.accepted\"}}\n"
                .getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id,"
                        + " journal_revision, command_key_hash, transaction_id, operation, command_id,"
                        + " content_digest, first_sequence, last_sequence, event_count, writer_generation,"
                        + " writer_id, writer_token_hash, activation_epoch, record_encoding, record_bytes,"
                        + " byte_length, record_digest, gmt_create) VALUES (?, ?, ?, 1, ?, 'tx-1', 'fixture',"
                        + " 'command-1', ?, 1, 1, 1, 1, 'writer', ?, 0, 'identity', ?, ?, ?, 1)",
                TENANT, WORKSPACE, SESSION, DigestUtils.sha256Hex("key-1"), "a".repeat(64), "b".repeat(64),
                bytes, bytes.length, DigestUtils.sha256Hex(bytes));
    }

    private ManagedAgentSettings.SessionResources sessionResources() {
        return new ManagedAgentSettings.SessionResources() {
            @Override public boolean isEnabled() { return true; }
            @Override public String getOssKeyPrefix() { return "csi-pack-resources/"; }
            @Override public boolean isPackJobEnabled() { return true; }
            @Override public boolean isDeletionEnabled() { return true; }
            @Override public long getPackTargetBytes() { return 16L * 1024 * 1024; }
            @Override public int getPackMaxTransactions() { return 4096; }
            @Override public Duration getDeletionGrace() { return Duration.ZERO; }
        };
    }

    private void compactAndDelete() {
        assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
        assertThat(packs.deleteCoveredBlobs()).isGreaterThan(0);
        assertThat(jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE"
                + " journal_revision = 1", byte[].class)).isNull();
    }

    private byte[] resolve(JdbcJournalPacks resolver, long revision) {
        return jdbc.query("SELECT record_bytes, record_digest, byte_length FROM ma_session_journal_tx"
                        + " WHERE journal_revision = ?",
                (ResultSetExtractor<byte[]>) row -> {
                    assertThat(row.next()).isTrue();
                    return CsiPackRecords.resolve(row, resolver, TENANT, SESSION, revision);
                }, revision);
    }

    @Test
    void resolvesEvictedRecordBytesFromThePack() {
        compactAndDelete();
        assertThat(resolve(packs, 1)).isEqualTo(bytes);
    }

    @Test
    void failsClosedWhenNoObjectStoreIsConfigured() {
        compactAndDelete();
        assertThat(resolve(null, 1)).isNull();
    }

    @Test
    void failsClosedWhenTheBundleHasNoObjectStore() {
        compactAndDelete();
        // A bundle constructed without a store must yield null, not the 501 that resolveBytes'
        // store() throws, so the admission caller raises its own fail-closed exception.
        assertThat(resolve(new JdbcJournalPacks(jdbc, null, null), 1)).isNull();
    }

    @Test
    void failsClosedWhenNoPackCoversTheEvictedRange() {
        // Evict the blob without publishing a pack: the resolver must not invent bytes.
        jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = NULL WHERE journal_revision = 1");
        assertThat(resolve(packs, 1)).isNull();
    }
}
