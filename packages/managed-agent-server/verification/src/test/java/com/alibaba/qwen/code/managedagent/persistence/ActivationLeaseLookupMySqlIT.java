package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedSessionReaderVersion;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Each activation renewal reads the Session's current activation row, three
 * times a minute for every resident Session. Renewals update that row in
 * place, so it is as old as the activation; the read must not walk back over
 * the transactions committed since.
 */
class ActivationLeaseLookupMySqlIT {
    private static final String TENANT = "tenant";
    private static final String SESSION = "session";
    private static final long EXPIRES_AT = 4_102_444_800_000L;

    @Test
    void tenfoldActivationHistoryKeepsTheLeaseLookupBoundedByItsIndex() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new CapturingJdbc(database.source());
            var rows = new JournalStoreRows(new ManagedSessionReaderVersion(), jdbc, null);
            // An earlier activation and its history, then the current one:
            // installed, renewed once by a later transaction, then history.
            var journal = new ArrayList<Object[]>();
            journal.add(transaction(1, 1, "installActivation", activation("earlier", 1, 1)));
            for (int revision = 2; revision <= 100; revision++) {
                journal.add(transaction(revision, 1, "commit", "{\"other\":true}"));
            }
            journal.add(transaction(101, 2, "installActivation", activation("current", 2, 1)));
            journal.add(transaction(102, 2, "commit", "{\"other\":true}"));
            journal.add(transaction(103, 2, "renewActivation", activation("current", 2, 2)));
            insert(jdbc, journal);
            int committed = 103;
            for (int size : new int[] {1000, 10000}) {
                var history = new ArrayList<Object[]>();
                for (int revision = committed + 1; revision <= 103 + size; revision++) {
                    history.add(transaction(revision, 2, "commit", "{\"other\":true}"));
                }
                insert(jdbc, history);
                committed = 103 + size;
                jdbc.execute("ANALYZE TABLE ma_session_journal_tx");

                var lease = rows.activationLeaseRow(head(committed));
                assertThat(lease.revision()).isEqualTo(103);
                assertThat(lease.workerId()).isEqualTo("worker");
                assertThat(lease.lease().activationId()).isEqualTo("current");
                assertThat(lease.lease().renewalSeq()).isEqualTo(2);

                var plan = ExecutedQueryPlan.explain(jdbc, jdbc.lookup.sql(), jdbc.lookup.arguments());
                assertThat(plan.tableScan()).as(plan.text()).isFalse();
                assertThat(plan.usesIndex("idx_ma_session_journal_tx_activation")).as(plan.text()).isTrue();
                assertThat(plan.rowCounts()).as(plan.text()).isNotEmpty();
                for (double count : plan.rowCounts()) {
                    assertThat(count).as(plan.text()).isLessThanOrEqualTo(5);
                }
            }
        }
    }

    private static JournalStoreRows.HeadRow head(long journalRevision) {
        return new JournalStoreRows.HeadRow(TENANT, "workspace", SESSION, "ACTIVE", 1, 1, "worker", null, null,
                journalRevision, journalRevision, "digest", 2, null, 0, 0, "READY", null, "current", "active", 2L,
                EXPIRES_AT, journalRevision);
    }

    private static String activation(String activationId, long epoch, long renewalSeq) {
        return "{\"managedSession\":{\"kind\":\"activation.changed\",\"payload\":{\"phase\":\"active\","
                + "\"activationId\":\"" + activationId + "\",\"epoch\":" + epoch + ",\"renewalSeq\":" + renewalSeq
                + ",\"expiresAt\":" + EXPIRES_AT + ",\"workerId\":\"worker\"}}}";
    }

    private static Object[] transaction(long revision, long epoch, String operation, String firstLine) {
        byte[] bytes = (firstLine + "\n").getBytes(StandardCharsets.UTF_8);
        return new Object[] {revision, ManagedSchemaKeys.key("command", Long.toString(revision)),
                "transaction-" + revision, operation, "command-" + revision, epoch, bytes, bytes.length,
                JournalStoreRows.sha256(bytes)};
    }

    private static void insert(CapturingJdbc jdbc, List<Object[]> rows) {
        jdbc.batchUpdate("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence,"
                + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                + " record_encoding, record_bytes, byte_length, record_digest, gmt_create) VALUES ('tenant',"
                + " 'workspace', 'session', ?, ?, ?, ?, ?, REPEAT('0', 64), 1, 1, 1, 1, 'worker', REPEAT('0', 64),"
                + " ?, 'identity', ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")", rows);
    }

    private record Query(String sql, Object[] arguments) {}

    private static final class CapturingJdbc extends ManagedSchemaJdbcTemplate {
        private Query lookup;

        private CapturingJdbc(DataSource source) {
            super(source);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            if (sql.contains("FROM ma_session_journal_tx") && sql.contains("ORDER BY journal_revision DESC LIMIT 1")) {
                lookup = new Query(sql, args.clone());
            }
            return super.query(sql, mapper, args);
        }
    }
}
