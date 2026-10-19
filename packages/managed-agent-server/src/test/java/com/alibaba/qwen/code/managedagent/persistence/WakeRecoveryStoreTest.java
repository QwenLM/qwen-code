package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
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
        assertThat(store.hasPendingInput(candidate())).contains(true);
        for (String source : List.of("monitor", "channel", "child_agent", "workflow", "automation")) {
            append("turn.settled", "turn-" + source, null);
            assertThat(store.hasPendingInput(candidate())).contains(true);
        }
        append("turn.settled", "turn-session_message", null);
        var settled = candidate();
        assertThat(store.hasPendingInput(settled)).contains(false);
        assertThat(store.recordPending(settled, false)).isTrue();
        assertThat(store.findPending("workspace", 8)).isEmpty();

        // A legacy writer advances the journal without maintaining the hint: the stamp exposes it.
        append("input.accepted", "later", "monitor");
        assertThat(store.hasPendingInput(candidate())).contains(true);
    }

    @Test
    void claimSurvivesWorkerRestartAndNeverConsumesPendingInput() {
        append("input.accepted", "turn", "monitor");
        var pending = candidate();
        assertThat(store.claim(pending)).isTrue();
        var restarted = new WakeRecoveryStore(jdbc);
        assertThat(restarted.claim(pending)).isFalse();
        assertThat(restarted.findPending("workspace", 8)).isEmpty();
        assertThat(restarted.hasPendingInput(pending)).contains(true);
        assertThat(restarted.recordPending(pending, true)).isTrue();
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 0");
        assertThat(restarted.findPending("workspace", 8)).containsExactly(pending);
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
        assertThat(store.claim(empty)).isFalse();
        assertThat(store.recordPending(empty, false)).isFalse();
        var fresh = candidate();
        assertThat(store.hasPendingInput(fresh)).contains(true);
        assertThat(store.claim(fresh)).isTrue();
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
            assertThat(store.hasPendingInput(pending)).contains(true);
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
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 0");
        jdbc.update("UPDATE ma_session SET runtime_request_key = ?", "a".repeat(64));
        assertThat(store.claim(sealed)).isFalse();
        jdbc.update("UPDATE ma_session SET runtime_request_key = NULL, retired_at = 1");
        assertThat(store.claim(sealed)).isFalse();
        jdbc.update("UPDATE ma_session SET retired_at = NULL, session_kind = 'CONTROL'");
        assertThat(store.claim(sealed)).isFalse();
        assertThat(store.findPending("workspace", 8)).isEmpty();
        jdbc.update("UPDATE ma_session SET session_kind = 'PUBLIC'");
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
        var compacted = new WakeRecoveryStore.Candidate("tenant", "workspace", "session",
                pending.journalRevision(), pending.committedSequence(), 1, null, null);
        assertThatThrownBy(() -> store.hasPendingInput(compacted)).hasMessageContaining("cannot prove");
        assertThat(store.findPending("workspace", 8)).isEmpty();
        assertThat(store.claim(pending)).isFalse();
        assertThat(store.recordPending(pending, false)).isFalse();
    }

    @Test
    void aFutureSettlementOutsideTheHeadCannotConsumeTheInput() {
        append("input.accepted", "turn", "monitor");
        append("turn.settled", "turn", null);
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 1");
        assertThat(store.hasPendingInput(candidate())).contains(true);
        jdbc.update("UPDATE ma_session_journal_tx SET workspace_id = 'other' WHERE journal_revision = 1");
        assertThatThrownBy(() -> new WakeRecoveryStore(jdbc).hasPendingInput(candidate())).hasMessageContaining("cannot prove");
    }

    @Test
    void hintOnlyMarksSupportedInputAdmissions() {
        for (String source : List.of("monitor", "channel", "child_agent", "workflow", "automation", "session_message")) {
            assertThat(WakeRecoveryStore.isWakeInput(event("input.accepted", "turn", source))).isTrue();
        }
        assertThat(WakeRecoveryStore.isWakeInput(event("input.accepted", "turn", "user"))).isFalse();
        assertThat(WakeRecoveryStore.isWakeInput(event("turn.settled", "turn", null))).isFalse();
    }

    @Test
    void hintedWorkPrecedesLazyBackfillEvenWhenItsKeySortsLast() {
        jdbc.update("UPDATE ma_session_head SET wake_pending = TRUE");
        for (int index = 0; index < 12; index++) {
            String id = "idle-" + index;
            jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified)"
                    + " VALUES ('tenant', ?, 'qwen-code', 1, 1)", id);
            jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, session_id,"
                            + " harness_session_id, workspace_id, head_kind, state, journal_revision,"
                            + " committed_sequence, compacted_through_revision, writer_generation,"
                            + " activation_epoch, storage_version, gmt_create, gmt_modified)"
                            + " SELECT tenant_key, ?, tenant_id, ?, ?, workspace_id, head_kind, state,"
                            + " journal_revision, committed_sequence, compacted_through_revision, 1, 0, 1, 1, 1"
                            + " FROM ma_session_head WHERE session_id = ?",
                    "0".repeat(60) + String.format("%04d", index), id, id, "session");
        }
        assertThat(store.findPending("workspace", 1)).extracting(WakeRecoveryStore.Candidate::sessionId)
                .containsExactly("session");
        assertThat(store.findPending("workspace", 8)).hasSize(8);
    }

    @Test
    void harnessDrainRowsCannotDisplaceManagedSessionCandidates() {
        var expected = candidate();
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, session_id,"
                        + " harness_session_id, workspace_id, head_kind, phase, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'tenant', 'session', 'session', 'workspace', 'HARNESS', 'OPEN', 1, 1)",
                "0".repeat(64), "0".repeat(64));
        assertThat(store.findPending("workspace", 1)).containsExactly(expected);
    }

    @Test
    void aHeadWhoseSequenceOutrunsTheProvenPrefixIsRefused() {
        append("input.accepted", "turn", "monitor");
        append("turn.settled", "turn", null);
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 2");
        assertThatThrownBy(() -> store.hasPendingInput(candidate())).hasMessageContaining("cannot prove");
    }

    @Test
    void batchedEventsPreservePendingInputsAndTheirMatchingSettlement() {
        appendBatch(event("input.accepted", "turn", "monitor"), event("model.attempt", "turn", null));
        assertThat(store.hasPendingInput(candidate())).contains(true);
        appendBatch(event("input.accepted", "other", "channel"), event("turn.settled", "turn", null),
                event("turn.settled", "other", null));
        assertThat(store.hasPendingInput(candidate())).contains(false);
    }

    @Test
    void longPendingProofYieldsAndResumesWithoutLosingAnEarlierInput() {
        append("input.accepted", "turn", "monitor");
        for (int index = 0; index < 64; index++) {
            append("model.attempt", "turn", null);
        }
        var pending = candidate();
        var reads = new CountingJdbcTemplate(jdbc.getDataSource());
        store = new WakeRecoveryStore(reads);
        for (int pass = 0; pass < 2; pass++) {
            assertThat(store.hasPendingInput(pending)).isEmpty();
            assertThat(reads.revisions).hasSize(32 * (pass + 1));
            assertThat(jdbc.queryForObject("SELECT wake_head_revision FROM ma_session_head", Long.class)).isNull();
            assertThat(store.findPending("workspace", 8)).containsExactly(pending);
        }
        assertThat(store.hasPendingInput(pending)).contains(true);
        assertThat(reads.revisions).hasSize(65);
        for (int index = 0; index < reads.revisions.size(); index++) {
            assertThat(reads.revisions.get(index)).isEqualTo((long) index);
        }
        assertThat(store.hasPendingInput(pending)).contains(true);
        assertThat(reads.revisions).hasSize(65);
    }

    @Test
    void resumedProofKeepsBothTurnSetsUntilTheCompleteSequenceIsVerified() {
        append("input.accepted", "pending", "monitor");
        append("turn.settled", "settled", null);
        for (int index = 0; index < 30; index++) {
            append("model.attempt", "pending", null);
        }
        append("input.accepted", "settled", "channel");
        for (int index = 0; index < 31; index++) {
            append("model.attempt", "pending", null);
        }
        append("turn.settled", "pending", null);
        var settled = candidate();
        assertThat(store.hasPendingInput(settled)).isEmpty();
        assertThat(store.hasPendingInput(settled)).isEmpty();
        assertThat(store.hasPendingInput(settled)).contains(false);
        assertThat(store.recordPending(settled, false)).isTrue();
        assertThat(store.findPending("workspace", 8)).isEmpty();
    }

    @Test
    void restartAndNewHeadDiscardPartialProofWithoutCertifyingConsumption() {
        append("input.accepted", "pending", "monitor");
        for (int index = 0; index < 32; index++) {
            append("model.attempt", "pending", null);
        }
        var before = candidate();
        assertThat(store.hasPendingInput(before)).isEmpty();
        var reads = new CountingJdbcTemplate(jdbc.getDataSource());
        store = new WakeRecoveryStore(reads);
        assertThat(store.hasPendingInput(before)).isEmpty();
        assertThat(reads.revisions.getFirst()).isZero();
        append("turn.settled", "pending", null);
        var after = candidate();
        assertThat(store.recordPending(before, false)).isFalse();
        assertThat(store.hasPendingInput(after)).isEmpty();
        assertThat(reads.revisions.get(32)).isZero();
        assertThat(store.hasPendingInput(after)).contains(false);
    }

    @Test
    void corruptionAfterAYieldDiscardsItsContinuation() {
        append("input.accepted", "pending", "monitor");
        for (int index = 0; index < 32; index++) {
            append("model.attempt", "pending", null);
        }
        var pending = candidate();
        var reads = new CountingJdbcTemplate(jdbc.getDataSource());
        store = new WakeRecoveryStore(reads);
        assertThat(store.hasPendingInput(pending)).isEmpty();
        jdbc.update("UPDATE ma_session_journal_tx SET record_digest = ? WHERE journal_revision = 33", "c".repeat(64));
        assertThatThrownBy(() -> store.hasPendingInput(pending)).hasMessageContaining("cannot prove");
        jdbc.update("UPDATE ma_session_journal_tx SET record_digest = ? WHERE journal_revision = 1", "c".repeat(64));
        assertThatThrownBy(() -> store.hasPendingInput(pending)).hasMessageContaining("cannot prove");
        assertThat(reads.revisions.getLast()).isZero();
    }

    @Test
    void backlogBeyondCacheCapacityKeepsProgressAndReclaimsIneligibleHolders() {
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        // This large fixture needs one connection, not thousands of short-lived connections.
        transactions.executeWithoutResult(ignored -> {
            append("input.accepted", "pending", "monitor");
            for (int index = 0; index < 32; index++) {
                append("model.attempt", "pending", null);
            }
            for (int index = 0; index < 128; index++) {
                copySession("backlog-" + index);
            }
            var candidates = store.findPending("workspace", 200);
            assertThat(candidates).hasSize(129);
            var completed = new HashSet<WakeRecoveryStore.Candidate>();
            for (int pass = 0; pass < 4 && completed.size() < candidates.size(); pass++) {
                for (var row : candidates) {
                    if (!completed.contains(row) && store.hasPendingInput(row).equals(java.util.Optional.of(true))) {
                        completed.add(row);
                    }
                }
            }
            assertThat(completed).containsExactlyInAnyOrderElementsOf(candidates);

            store = new WakeRecoveryStore(jdbc);
            for (var row : candidates.subList(0, 128)) {
                assertThat(store.hasPendingInput(row)).isEmpty();
            }
            var waiting = candidates.getLast();
            jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id <> ?", waiting.sessionId());
            assertThat(store.hasPendingInput(waiting)).isEmpty();
            assertThat(store.hasPendingInput(waiting)).contains(true);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head WHERE wake_scan_pending = TRUE",
                    Long.class)).isEqualTo(129L);
        });
    }

    private void copySession(String session) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified)"
                + " VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 1, 1)", session);
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, workspace_id,"
                        + " session_id, harness_session_id, head_kind, state, journal_revision, committed_sequence,"
                        + " compacted_through_revision, writer_generation, activation_epoch, storage_version,"
                        + " writer_lease_until, gmt_create, gmt_modified) SELECT tenant_key, ?, tenant_id, workspace_id,"
                        + " ?, ?, head_kind, state, journal_revision, committed_sequence, compacted_through_revision,"
                        + " writer_generation, activation_epoch, storage_version, writer_lease_until, gmt_create, gmt_modified"
                        + " FROM ma_session_head WHERE session_id = ?",
                ManagedSchemaKeys.key(session), session, session, "session");
        for (var row : jdbc.queryForList("SELECT * FROM ma_session_journal_tx WHERE session_id = ?", "session")) {
            byte[] bytes = new String((byte[]) row.get("record_bytes"), StandardCharsets.UTF_8)
                    .replace("\"sessionId\":\"session\"", "\"sessionId\":\"" + session + "\"")
                    .getBytes(StandardCharsets.UTF_8);
            jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                            + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence,"
                            + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                            + " record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                            + " VALUES ('tenant', 'workspace', ?, ?, ?, ?, 'fixture', ?, ?, ?, ?, ?, 1, 'writer', ?,"
                            + " 0, 'identity', ?, ?, ?, 1)",
                    session, row.get("journal_revision"), row.get("command_key_hash"), row.get("transaction_id"),
                    row.get("command_id"), row.get("content_digest"), row.get("first_sequence"),
                    row.get("last_sequence"), row.get("event_count"), "b".repeat(64), bytes, bytes.length,
                    DigestUtils.sha256Hex(bytes));
        }
    }

    private static final class CountingJdbcTemplate extends ManagedSchemaJdbcTemplate {
        private final List<Long> revisions = new ArrayList<>();

        private CountingJdbcTemplate(DataSource source) {
            super(source);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
            if (sql.contains("FROM ma_session_journal_tx")) {
                revisions.add((Long) arguments[2]);
            }
            return super.query(sql, mapper, arguments);
        }
    }

    private WakeRecoveryStore.Candidate candidate() {
        return store.findPending("workspace", 8).getFirst();
    }

    private ObjectNode event(String kind, String turn, String source) {
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", sequence + 1).put("kind", kind);
        event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace")
                .put("sessionId", "session");
        var payload = event.putObject("payload").put("turnId", turn).put("inputId", turn);
        if (source != null) {
            payload.put("source", source);
        }
        return event;
    }

    private void append(String kind, String turn, String source) {
        appendBatch(event(kind, turn, source));
    }

    private void appendBatch(ObjectNode... events) {
        long firstSequence = sequence + 1;
        StringBuilder records = new StringBuilder();
        for (var event : events) {
            event.put("sequence", ++sequence);
            ObjectNode record = JSON.createObjectNode().put("subtype", "managed_session_event_v1");
            record.set("managedSession", event);
            records.append(record).append('\n');
        }
        byte[] bytes = records.toString().getBytes(StandardCharsets.UTF_8);
        revision++;
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                        + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence,"
                        + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                        + " record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                        + " VALUES ('tenant', 'workspace', 'session', ?, ?, ?, 'fixture', ?, ?, ?, ?, ?, 1, 'writer', ?,"
                        + " 0, 'identity', ?, ?, ?, 1)",
                revision, DigestUtils.sha256Hex("key-" + revision), "tx-" + revision, "command-" + revision,
                "a".repeat(64), firstSequence, sequence, events.length, "b".repeat(64), bytes, bytes.length, DigestUtils.sha256Hex(bytes));
        jdbc.update("UPDATE ma_session_head SET journal_revision = ?, committed_sequence = ?", revision, sequence);
    }
}
