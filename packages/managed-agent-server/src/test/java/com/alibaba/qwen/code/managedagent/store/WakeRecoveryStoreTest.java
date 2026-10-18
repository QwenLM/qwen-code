package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class WakeRecoveryStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    protected ManagedSchemaJdbcTemplate jdbc;
    protected WakeRecoveryStore store;
    private long revision;
    private long sequence;

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:wake-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        store = new WakeRecoveryStore(jdbc);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                + " gmt_modified) VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1)");
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, workspace_id,"
                        + " session_id, harness_session_id, head_kind, state, journal_revision,"
                        + " committed_sequence, compacted_through_revision, writer_generation, activation_epoch,"
                        + " storage_version, writer_lease_until, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'tenant', 'workspace', 'session', 'session', 'MANAGED_SESSION',"
                        + " 'ACTIVE', 0, 0, 0, 1, 0, 1, 1, 1, 1)",
                ManagedSchemaKeys.key("tenant"), ManagedSchemaKeys.key("session"));
    }

    @Test
    void discoversEverySourceWithoutMqAndOnlyMatchingSettlementConsumesIt() {
        for (String source : List.of("monitor", "channel", "child_agent", "workflow", "automation", "session_message")) {
            append("input.accepted", "turn-" + source, source);
        }
        // Cross the journal page boundary; neither an attempt nor a different Turn settles this input.
        append("input.accepted", "foreground", "user");
        append("turn.settled", "foreground", null);
        append("model.attempt", "turn-monitor", null);
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id,"
                + " wake_covered_sequence, gmt_modified) VALUES ('tenant', 'session', 'SESSION', '', 999, 1)");
        assertThat(store.hasPendingInput(candidate())).isTrue();
        for (String source : List.of("monitor", "channel", "child_agent", "workflow", "automation")) {
            append("turn.settled", "turn-" + source, null);
            assertThat(store.hasPendingInput(candidate())).isTrue();
        }
        append("turn.settled", "turn-session_message", null);
        var settled = candidate();
        assertThat(store.hasPendingInput(settled)).isFalse();
        assertThat(store.recordPending(settled, false)).isTrue();
        assertThat(store.findPending("workspace", 8)).isEmpty();

        // A legacy writer advances the journal without maintaining the hint: the stamp exposes it.
        append("input.accepted", "later", "monitor");
        assertThat(store.hasPendingInput(candidate())).isTrue();
    }

    @Test
    void claimSurvivesWorkerRestartAndNeverConsumesPendingInput() {
        append("input.accepted", "turn", "monitor");
        var pending = candidate();
        assertThat(store.claim(pending)).isTrue();
        var restarted = new WakeRecoveryStore(jdbc);
        assertThat(restarted.claim(pending)).isFalse();
        assertThat(restarted.findPending("workspace", 8)).isEmpty();
        assertThat(restarted.hasPendingInput(pending)).isTrue();
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 0");
        assertThat(restarted.claim(candidate())).isTrue();
    }

    @Test
    void concurrentScannersClaimOneRecoveryAttempt() throws Exception {
        append("input.accepted", "turn", "monitor");
        var pending = candidate();
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        var workers = Executors.newFixedThreadPool(2);
        try {
            java.util.concurrent.Callable<Boolean> claim = () -> {
                ready.countDown();
                if (!start.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("claim did not start");
                }
                return new WakeRecoveryStore(jdbc).claim(pending);
            };
            var first = workers.submit(claim);
            var second = workers.submit(claim);
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(true, false);
        } finally {
            start.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void concurrentAdmissionCannotBeClearedByAnOlderScan() {
        var empty = candidate();
        append("input.accepted", "new", "monitor");
        assertThat(store.recordPending(empty, false)).isFalse();
        assertThat(store.hasPendingInput(candidate())).isTrue();
    }

    @Test
    void publicCloseAfterClaimFencesUnboundWriterTakeover() {
        append("input.accepted", "turn", "monitor");
        var pending = candidate();
        assertThat(store.claim(pending)).isTrue();
        var sessions = new ManagedSessionStore(jdbc);
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        for (String status : List.of("CLOSING", "CLOSED")) {
            jdbc.update("UPDATE ma_session SET status = ?", status);
            assertThat(store.hasPendingInput(pending)).isTrue();
            assertThat(store.recordPending(pending, true)).isTrue();
            assertThatThrownBy(() -> transactions.execute(ignored -> sessions.acquireWriter(
                    "tenant", "session", "wake-recovery-writer-token-0123456789",
                    new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "replacement", 30_000L))))
                    .hasMessageContaining("closing or closed");
            assertThat(jdbc.queryForObject("SELECT writer_generation FROM ma_session_head", Long.class)).isEqualTo(1L);
        }
    }

    @Test
    void liveWritersAndLifecycleAndCsiAndWrongScopesNeverBecomeCandidates() {
        assertThat(store.findPending("another-workspace", 8)).isEmpty();
        for (String status : List.of("CLOSING", "CLOSED")) {
            jdbc.update("UPDATE ma_session SET status = ?", status);
            assertThat(store.findPending("workspace", 8)).isEmpty();
        }
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE', retired_at = 1");
        assertThat(store.findPending("workspace", 8)).isEmpty();
        jdbc.update("UPDATE ma_session SET retired_at = NULL, runtime_request_key = ?", "a".repeat(64));
        assertThat(store.findPending("workspace", 8)).isEmpty();
        jdbc.update("UPDATE ma_session SET runtime_request_key = NULL");
        for (String state : List.of("DELETING", "DELETED")) {
            jdbc.update("UPDATE ma_session_head SET state = ?", state);
            assertThat(store.findPending("workspace", 8)).isEmpty();
        }
        jdbc.update("UPDATE ma_session_head SET state = 'ACTIVE', writer_lease_until = ?", Long.MAX_VALUE);
        assertThat(store.findPending("workspace", 8)).isEmpty();
        jdbc.update("UPDATE ma_session_head SET state = 'SEALED'");
        var sealed = candidate();
        assertThat(store.claim(sealed)).isTrue();
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 0, state = 'ACTIVE'");
        assertThat(store.claim(sealed)).isFalse();
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 1");
        jdbc.update("UPDATE ma_session SET status = 'CLOSING'");
        assertThat(store.claim(sealed)).isFalse();
    }

    @Test
    void tenantAndWorkspaceChangesCannotHideOrConsumeAnotherScope() {
        var before = candidate();
        jdbc.update("UPDATE ma_session_head SET workspace_id = 'other'");
        assertThat(store.recordPending(before, false)).isFalse();
        assertThat(store.claim(before)).isFalse();
        assertThat(store.findPending("workspace", 8)).isEmpty();
        jdbc.update("UPDATE ma_session_head SET workspace_id = 'workspace', tenant_id = 'Tenant'");
        assertThat(store.findPending("workspace", 8)).isEmpty();
    }

    @Test
    void missingOrCorruptOrCompactedProofIsNeverTreatedAsConsumption() {
        append("input.accepted", "turn", "monitor");
        var pending = candidate();
        jdbc.update("UPDATE ma_session_journal_tx SET record_digest = ?", "b".repeat(64));
        assertThatThrownBy(() -> store.hasPendingInput(pending)).hasMessageContaining("cannot prove");
        jdbc.update("DELETE FROM ma_session_journal_tx");
        assertThatThrownBy(() -> store.hasPendingInput(pending)).hasMessageContaining("cannot prove");
        jdbc.update("UPDATE ma_session_head SET compacted_through_revision = 1");
        assertThatThrownBy(() -> store.hasPendingInput(candidate())).hasMessageContaining("cannot prove");
        assertThat(store.findPending("workspace", 8)).hasSize(1);
    }

    @Test
    void aFutureSettlementOutsideTheHeadCannotConsumeTheInput() {
        append("input.accepted", "turn", "monitor");
        append("turn.settled", "turn", null);
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 1");
        assertThat(store.hasPendingInput(candidate())).isTrue();
        jdbc.update("UPDATE ma_session_journal_tx SET workspace_id = 'other' WHERE journal_revision = 1");
        assertThatThrownBy(() -> new WakeRecoveryStore(jdbc).hasPendingInput(candidate())).hasMessageContaining("cannot prove");
    }

    @Test
    void hintOnlyMarksSupportedInputAdmissions() {
        for (String source : List.of("monitor", "channel", "child_agent", "workflow", "automation", "session_message")) {
            assertThat(WakeRecoveryStore.hasWakeInput(line("input.accepted", "turn", source), 1)).isTrue();
        }
        assertThat(WakeRecoveryStore.hasWakeInput(line("input.accepted", "turn", "user"), 1)).isFalse();
        assertThat(WakeRecoveryStore.hasWakeInput(line("turn.settled", "turn", null), 1)).isFalse();
    }

    private WakeRecoveryStore.Candidate candidate() {
        return store.findPending("workspace", 8).getFirst();
    }

    private byte[] line(String kind, String turn, String source) {
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", sequence + 1).put("kind", kind);
        event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace")
                .put("sessionId", "session");
        var payload = event.putObject("payload").put("turnId", turn).put("inputId", turn);
        if (source != null) {
            payload.put("source", source);
        }
        ObjectNode record = JSON.createObjectNode().put("subtype", "managed_session_event_v1");
        record.set("managedSession", event);
        return (record + "\n").getBytes(StandardCharsets.UTF_8);
    }

    private void append(String kind, String turn, String source) {
        byte[] bytes = line(kind, turn, source);
        sequence++;
        revision++;
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                        + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence,"
                        + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                        + " record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                        + " VALUES ('tenant', 'workspace', 'session', ?, ?, ?, 'fixture', ?, ?, ?, ?, 1, 1, 'writer', ?,"
                        + " 0, 'identity', ?, ?, ?, 1)",
                revision, DigestUtils.sha256Hex("key-" + revision), "tx-" + revision, "command-" + revision,
                "a".repeat(64), sequence, sequence, "b".repeat(64), bytes, bytes.length, DigestUtils.sha256Hex(bytes));
        jdbc.update("UPDATE ma_session_head SET journal_revision = ?, committed_sequence = ?", revision, sequence);
    }
}
