package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * C1 regression: once {@code compactOnce()} publishes a pack and
 * {@code deleteCoveredBlobs()} (grace zero) nulls the covered SQL blobs, the full-journal
 * scanners must still resolve their bytes from the pack instead of failing on a null
 * {@code record_bytes}. Before the fix these readers NPE'd or threw on the deleted prefix.
 *
 * <p>Covered readers: wake recovery, workspace lifecycle, side-query capture, child-result
 * relay, original-authority recovery reads and the context-compaction backfill. The remaining
 * pack-aware readers (tool-result source verification, admission replay and the activity
 * diagnostic projection) resolve through the same {@code resolveBytes} path but need heavier
 * operation/claim fixtures than this journal-only harness provides.
 */
class JournalPackDeletionRegressionTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TENANT = "tenant";
    private static final String WORKSPACE = "workspace";
    private static final String SESSION = "session";
    private static final long EXPIRES_AT = 4_102_444_800_000L;

    private JdbcTemplate jdbc;
    private JdbcJournalPacks packs;
    private PublicationProbeWiring.InMemoryObjectStore objects;
    private long revision;
    private long sequence;
    private String previousDigest;

    @BeforeEach
    void setUp() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:pack-delete-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        objects = new PublicationProbeWiring.InMemoryObjectStore();
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
                        + " 'ACTIVE', 0, 0, 0, 0, 1, 0, 1, 1, 1, 1)",
                ManagedSchemaKeys.key(TENANT), ManagedSchemaKeys.key(SESSION), TENANT, WORKSPACE,
                SESSION, SESSION);
    }

    private ManagedAgentSettings.SessionResources sessionResources() {
        return new ManagedAgentSettings.SessionResources() {
            @Override public boolean isEnabled() { return true; }
            @Override public String getOssKeyPrefix() { return "regression-resources/"; }
            @Override public boolean isPackJobEnabled() { return true; }
            @Override public boolean isDeletionEnabled() { return true; }
            @Override public long getPackTargetBytes() { return 16L * 1024 * 1024; }
            @Override public int getPackMaxTransactions() { return 4096; }
            @Override public Duration getDeletionGrace() { return Duration.ZERO; }
        };
    }

    private ObjectNode event(String kind, String turn, String source) {
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("kind", kind);
        event.putObject("sessionKey").put("tenantId", TENANT).put("workspaceId", WORKSPACE)
                .put("sessionId", SESSION);
        ObjectNode payload = event.putObject("payload").put("turnId", turn).put("inputId", turn);
        if (source != null) {
            payload.put("source", source);
        }
        if ("turn.settled".equals(kind)) {
            payload.put("outcome", "completed");
        }
        return event;
    }

    private void append(ObjectNode... events) {
        long firstSequence = sequence + 1;
        StringBuilder records = new StringBuilder();
        for (ObjectNode event : events) {
            event.put("sequence", ++sequence);
            ObjectNode record = JSON.createObjectNode().put("subtype", "managed_session_event_v1");
            record.set("managedSession", event);
            records.append(record).append('\n');
        }
        byte[] bytes = records.toString().getBytes(StandardCharsets.UTF_8);
        revision++;
        String commitDigest = DigestUtils.sha256Hex(("commit-" + revision).getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id,"
                        + " journal_revision, command_key_hash, transaction_id, operation, command_id,"
                        + " content_digest, first_sequence, last_sequence, event_count,"
                        + " previous_commit_digest, commit_digest, writer_generation, writer_id,"
                        + " writer_token_hash, activation_epoch, record_encoding, record_bytes,"
                        + " byte_length, record_digest, gmt_create) VALUES (?, ?, ?, ?, ?, ?, 'fixture',"
                        + " ?, ?, ?, ?, ?, ?, ?, 1, 'writer', ?, 0, 'identity', ?, ?, ?, 1)",
                TENANT, WORKSPACE, SESSION, revision, DigestUtils.sha256Hex("key-" + revision),
                "tx-" + revision, "command-" + revision, "a".repeat(64), firstSequence, sequence,
                events.length, previousDigest, commitDigest, "b".repeat(64), bytes, bytes.length,
                DigestUtils.sha256Hex(bytes));
        previousDigest = commitDigest;
        jdbc.update("UPDATE ma_session_head SET journal_revision = ?, committed_sequence = ?,"
                + " last_commit_digest = ?", revision, sequence, commitDigest);
    }

    private void compactAndDelete() {
        assertThat(packs.compactOnce(TENANT, WORKSPACE, SESSION)).isTrue();
        assertThat(packs.deleteCoveredBlobs()).isGreaterThan(0);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE"
                + " record_bytes IS NULL", Long.class)).isEqualTo(revision);
    }

    @Test
    void wakeAndLifecycleAndSideQueryReadersResolveDeletedBlobsFromThePack() {
        append(event("input.accepted", "turn-1", "monitor"));
        append(event("turn.settled", "turn-1", null));
        compactAndDelete();

        JdbcWakeRecoveryStore wake = new JdbcWakeRecoveryStore(jdbc);
        wake.setJournalPacks(packs);
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id,"
                + " wake_covered_sequence, gmt_modified) VALUES (?, ?, 'SESSION', '', 999, 1)", TENANT, SESSION);
        jdbc.update("UPDATE ma_session_head SET is_wake_pending = TRUE, wake_retry_at = 0");
        var candidate = wake.findPending(WORKSPACE, 8).getFirst();
        assertThat(wake.hasPendingInput(candidate)).contains(false);

        assertThat(JdbcWorkspaceLifecycleStore.requireIdleJournal(jdbc, JSON, TENANT, SESSION,
                false, false, packs)).containsExactly("turn-1");

        var prefix = SideQueryConversation.capture(jdbc, TENANT, SESSION, revision, sequence,
                previousDigest, packs);
        assertThat(prefix.journalRevision()).isEqualTo(revision);
    }

    @Test
    void childRelayScanResolvesDeletedBlobsFromThePack() {
        append(event("input.accepted", "turn-1", "user"));
        append(event("turn.settled", "turn-1", null));
        compactAndDelete();

        JdbcChildResultRelayStore relay = new JdbcChildResultRelayStore(jdbc);
        relay.setJournalPacks(packs);
        // journalTurnText walks the whole journal via forEachJournalEvent; with no
        // assistant message committed it answers null rather than failing on null bytes.
        assertThat(relay.journalTurnText(TENANT, SESSION, "turn-1")).isNull();
    }

    @Test
    void resolveBytesRoundTripsAfterDeletionAndDeleteIsIdempotent() {
        append(event("input.accepted", "turn-1", "monitor"));
        byte[] first = jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE"
                + " journal_revision = 1", byte[].class);
        compactAndDelete();
        assertThat(packs.resolveBytes(TENANT, SESSION, 1, DigestUtils.sha256Hex(first),
                first.length)).isEqualTo(first);
        assertThat(packs.deleteCoveredBlobs()).isZero();
    }

    @Test
    void recoveryReaderResolvesDeletedBlobsFromThePack() {
        append(event("input.accepted", "turn-1", "user"));
        byte[] first = jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE"
                + " journal_revision = 1", byte[].class);
        compactAndDelete();
        ObjectNode source = JSON.createObjectNode();
        source.putObject("head").put("tenantId", TENANT).put("workspaceId", WORKSPACE)
                .put("sessionId", SESSION).put("journalRevision", revision);
        JsonNode transaction = new WorkspaceRecoveryReader(jdbc, objects).transaction(source, 1);
        assertThat(transaction.path("recordBytesBase64").asText())
                .isEqualTo(Base64.getEncoder().encodeToString(first));
        assertThat(transaction.path("recordDigest").asText()).isEqualTo(DigestUtils.sha256Hex(first));
    }

    @Test
    void backfillCompactionProjectionResolvesDeletedBlobsFromThePack() {
        append(event("input.accepted", "turn-1", "user"));
        append(event("turn.settled", "turn-1", null));
        compactAndDelete();
        // backfillCompactionProjection only touches jdbc, packs and storeRows; the other
        // collaborators are unused on this path.
        AgentStoreRows storeRows = new AgentStoreRows(null, jdbc, JSON);
        AgentExecutionOperations operations = new AgentExecutionOperations(
                null, null, null, null, storeRows, null, jdbc, null, null, false, packs);
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        operations.backfillCompactionProjection(TENANT, SESSION, scope, "compaction-key");
        // With no context.compacted event the backfill still walks the deleted prefix and
        // lands the empty compaction-state resource instead of failing on null bytes.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE resource_id LIKE"
                + " 'compaction-state:%'", Long.class)).isEqualTo(1);
    }

    @Test
    void activationLeaseRowResolvesDeletedBlobFromThePack() {
        appendActivation();
        compactAndDelete();
        JournalStoreRows rows = new JournalStoreRows(StorageReadPolicy.inProcess(), jdbc, objects);
        JournalStoreRows.ActivationLeaseRow lease = rows.activationLeaseRow(activationHead());
        assertThat(lease.revision()).isEqualTo(1);
        assertThat(lease.workerId()).isEqualTo("worker");
        assertThat(lease.lease().activationId()).isEqualTo("current");
        assertThat(lease.lease().epoch()).isEqualTo(2);
        assertThat(lease.lease().renewalSeq()).isEqualTo(1);
        assertThat(lease.lease().expiresAt()).isEqualTo(EXPIRES_AT);
    }

    @Test
    void activationLeaseRowFailsClosedWithoutAnObjectStore() {
        appendActivation();
        compactAndDelete();
        JournalStoreRows rows = new JournalStoreRows(StorageReadPolicy.inProcess(), jdbc, null);
        assertThatThrownBy(() -> rows.activationLeaseRow(activationHead()))
                .isInstanceOf(ManagedAgentException.class);
    }

    // A single renewActivation record whose first line is the activation.changed event the lease
    // lookup parses; is_activation_record is a generated column keyed on the operation name.
    private void appendActivation() {
        String event = "{\"managedSession\":{\"kind\":\"activation.changed\",\"payload\":{\"phase\":\"active\","
                + "\"activationId\":\"current\",\"epoch\":2,\"renewalSeq\":1,\"expiresAt\":" + EXPIRES_AT
                + ",\"workerId\":\"worker\"}}}";
        byte[] bytes = (event + "\n").getBytes(StandardCharsets.UTF_8);
        revision = 1;
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                        + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence,"
                        + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                        + " record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                        + " VALUES (?, ?, ?, 1, ?, 'tx-1', 'renewActivation', 'command-1', ?, 0, 0, 0, 1, 'worker', ?,"
                        + " 2, 'identity', ?, ?, ?, 1)",
                TENANT, WORKSPACE, SESSION, DigestUtils.sha256Hex("key-1"), "a".repeat(64), "b".repeat(64),
                bytes, bytes.length, DigestUtils.sha256Hex(bytes));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 0,"
                + " activation_epoch = 2, activation_id = 'current', activation_phase = 'active',"
                + " activation_event_epoch = 2, activation_expires_at = ?, activation_head_revision = 1", EXPIRES_AT);
    }

    private JournalStoreRows.HeadRow activationHead() {
        return new JournalStoreRows.HeadRow(TENANT, WORKSPACE, SESSION, "ACTIVE", 1, 1, "worker", null, null,
                1, 0, "digest", 2, null, 0, 0, "READY", null, "current", "active", 2L, EXPIRES_AT, 1L);
    }
}
