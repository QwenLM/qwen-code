package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
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
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Regression for the seal-time wake stamp (docs/design/2026-11-19-managed-
 * control-plane-wake-seal-stamp.md §1, §7): a suspended head whose earliest
 * pending input is a far-future loop wakeup carries its due time in
 * {@code wake_retry_at}, so the backstop neither claims nor replays it before
 * then, and at its due time selects it stamped, which skips the replay.
 */
class WakeRecoveryStampedHeadsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long NOW = 1_000_000L;
    private static final long NOT_BEFORE = 10_000_000L;
    private ManagedSchemaJdbcTemplate jdbc;
    private long revision;
    private long sequence;

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:wake-stamped-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                + " gmt_modified) VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1)");
        jdbc.update("INSERT INTO ma_session_head (tenant_id, workspace_id,"
                        + " session_id, harness_session_id, head_kind, state, journal_revision,"
                        + " committed_sequence, compacted_through_revision, writer_generation, activation_epoch,"
                        + " writer_lease_until, gmt_create, gmt_modified)"
                        + " VALUES ('tenant', 'workspace', 'session', 'session', 'MANAGED_SESSION',"
                        + " 'SEALED', 0, 0, 0, 1, 0, 1, 1, 1)");
    }

    @Test
    void aStampedFarFutureHeadIsNeitherClaimedNorReplayedBeforeItsDueTime() {
        farFutureJournal(10);
        stamp("session", System.currentTimeMillis() + 3_600_000L);
        var reads = new CountingJdbcTemplate(jdbc.getDataSource());
        var store = store(reads);
        for (int cycle = 0; cycle < 5; cycle++) {
            assertThat(store.findPending("workspace", 8)).isEmpty();
        }

        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 0");
        var candidates = store.findPending("workspace", 8);
        assertThat(candidates).hasSize(1);
        assertThat(candidates.getFirst().stamped()).isTrue();
        assertThat(store.claim(candidates.getFirst())).isTrue();
        assertThat(reads.revisions).isEmpty();
    }

    @Test
    void stampedFarFutureHeadsLeaveTheScanPageToADueSession() {
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        transactions.executeWithoutResult(ignored -> {
            // Longer than the 32-transaction proof budget of one call.
            farFutureJournal(40);
            for (int index = 1; index < 128; index++) {
                copySession("far-" + index, "\"source\":\"loop\"");
            }
            copySession("due", "\"source\":\"monitor\"");
        });
        jdbc.update("UPDATE ma_session_head SET wake_seal_revision = journal_revision,"
                + " wake_head_revision = journal_revision, is_wake_pending = TRUE, wake_retry_at = ?",
                System.currentTimeMillis() + 3_600_000L);
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 0 WHERE session_id = ?", "due");
        var reads = new CountingJdbcTemplate(jdbc.getDataSource());

        var candidates = store(reads).findPending("workspace", 8);

        assertThat(candidates).extracting(row -> row.sessionId()).containsExactly("due");
        assertThat(candidates.getFirst().stamped()).isTrue();
        assertThat(reads.revisions).isEmpty();
    }

    /** What a clean suspension's seal writes for a head whose earliest input is due at {@code dueAt}. */
    private void stamp(String session, long dueAt) {
        jdbc.update("UPDATE ma_session_head SET wake_seal_revision = journal_revision,"
                + " wake_head_revision = journal_revision, is_wake_pending = TRUE, wake_retry_at = ?"
                + " WHERE session_id = ?", dueAt, session);
    }

    private JdbcWakeRecoveryStore store(ManagedSchemaJdbcTemplate template) {
        var store = new JdbcWakeRecoveryStore(template);
        store.setNowMillis(() -> NOW);
        return store;
    }

    /** A loop wakeup due at NOT_BEFORE, then filler transactions up to {@code length}. */
    private void farFutureJournal(int length) {
        ObjectNode wakeup = event("input.accepted", "wakeup", "loop");
        ((ObjectNode) wakeup.get("payload")).put("notBefore", NOT_BEFORE);
        appendBatch(wakeup);
        for (int index = 1; index < length; index++) {
            appendBatch(event("model.attempt", "wakeup", null));
        }
    }

    /** Copies the head and journal of 'session', with its wake input's source replaced. */
    private void copySession(String session, String source) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified)"
                + " VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 1, 1)", session);
        jdbc.update("INSERT INTO ma_session_head (tenant_id, workspace_id,"
                        + " session_id, harness_session_id, head_kind, state, journal_revision, committed_sequence,"
                        + " compacted_through_revision, writer_generation, activation_epoch,"
                        + " writer_lease_until, gmt_create, gmt_modified) SELECT tenant_id, workspace_id,"
                        + " ?, ?, head_kind, state, journal_revision, committed_sequence, compacted_through_revision,"
                        + " writer_generation, activation_epoch, writer_lease_until, gmt_create, gmt_modified"
                        + " FROM ma_session_head WHERE session_id = ?",
                session, session, "session");
        for (var row : jdbc.queryForList("SELECT * FROM ma_session_journal_tx WHERE session_id = ?", "session")) {
            byte[] bytes = new String((byte[]) row.get("record_bytes"), StandardCharsets.UTF_8)
                    .replace("\"sessionId\":\"session\"", "\"sessionId\":\"" + session + "\"")
                    .replace("\"source\":\"loop\"", source)
                    .getBytes(StandardCharsets.UTF_8);
            jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                            + " command_ref, transaction_id, operation, command_id, content_digest, first_sequence,"
                            + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                            + " record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                            + " VALUES ('tenant', 'workspace', ?, ?, ?, ?, 'fixture', ?, ?, ?, ?, ?, 1, 'writer', ?,"
                            + " 0, 'identity', ?, ?, ?, 1)",
                    session, row.get("journal_revision"), row.get("command_ref"), row.get("transaction_id"),
                    row.get("command_id"), row.get("content_digest"), row.get("first_sequence"),
                    row.get("last_sequence"), row.get("event_count"), "b".repeat(64), bytes, bytes.length,
                    DigestUtils.sha256Hex(bytes));
        }
    }

    private ObjectNode event(String kind, String turn, String source) {
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("kind", kind);
        event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace")
                .put("sessionId", "session");
        var payload = event.putObject("payload").put("turnId", turn).put("inputId", turn);
        if (source != null) {
            payload.put("source", source);
        }
        return event;
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
                        + " command_ref, transaction_id, operation, command_id, content_digest, first_sequence,"
                        + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                        + " record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                        + " VALUES ('tenant', 'workspace', 'session', ?, ?, ?, 'fixture', ?, ?, ?, ?, ?, 1, 'writer', ?,"
                        + " 0, 'identity', ?, ?, ?, 1)",
                revision, ManagedIdentityRefs.commandRef("fixture", "command-" + revision), "tx-" + revision, "command-" + revision,
                "a".repeat(64), firstSequence, sequence, events.length, "b".repeat(64), bytes, bytes.length,
                DigestUtils.sha256Hex(bytes));
        jdbc.update("UPDATE ma_session_head SET journal_revision = ?, committed_sequence = ?", revision, sequence);
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
}
