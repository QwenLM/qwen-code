package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;

import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Uses only the disposable database selected for this integration invocation. */
class ManagedContextCompressionMySqlIT extends ManagedContextCompressionOperationTest {
    @Override
    protected DataSource testDataSource() {
        String url = System.getProperty("mysql.url");
        assertThat(url).as("Pass -Dmysql.url for a disposable MySQL 8.4 database").isNotBlank();
        var source = new DriverManagerDataSource(url, System.getProperty("mysql.user", "root"),
                System.getProperty("mysql.password", ""));
        var database = new JdbcTemplate(source);
        List<String> tables = database.queryForList("SELECT table_name FROM information_schema.tables"
                + " WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name LIKE 'ma_%'",
                String.class);
        database.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
            try (var statement = connection.createStatement()) {
                statement.execute("SET FOREIGN_KEY_CHECKS = 0");
                try {
                    for (String table : tables) {
                        if (!table.matches("ma_[a-z_]+")) {
                            throw new IllegalStateException("Unexpected Managed table name");
                        }
                        statement.executeUpdate("DELETE FROM " + table);
                    }
                } finally {
                    statement.execute("SET FOREIGN_KEY_CHECKS = 1");
                }
            }
            return null;
        });
        return source;
    }

    @Test
    void compressionAndAnIncomingTurnCannotBothPassIdleAdmission() throws Exception {
        var start = new CyclicBarrier(2);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var compression = executor.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                return attempt(() -> admit("concurrent", "concurrent", 0, true));
            });
            var input = executor.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                return attempt(() -> tx(() -> store.insertTurnCommand("tenant", "SUBMIT", "incoming",
                        "incoming-digest", session, List.of(), "payload")));
            });
            assertThat(List.of(compression.get(20, TimeUnit.SECONDS), input.get(20, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("accepted", "session_context_busy");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                    + " 'CONTEXT_COMPRESSION'", Integer.class)
                    + jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn", Integer.class)).isEqualTo(1);
        }
    }

    @Test
    void projectionBackfillAndNativeCompactionCommitRemainMonotonic() throws Exception {
        var records = new com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore(jdbc, store);
        var nativeStore = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore(jdbc, records));
        var journal = tx(() -> new ExtensionRecordJournal(nativeStore, "tenant", "workspace", session).open());
        var summary = "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var resource = ManagedExtensionRecordStoreTest.hookResource("race-summary", "managed-message", summary);
        var request = journal.request("compactContext", "race", summary, 1_000, event -> {
            event.put("kind", "context.compacted").put("eventId", "compaction:race");
            var payload = event.putObject("payload").put("compactionId", "race")
                    .put("fromSequence", 1).put("toSequence", 0);
            payload.set("summaryRef", ManagedExtensionRecordStoreTest.hookRef(resource));
            payload.putArray("replacedMessageIds");
            payload.putNull("tokenCountsRef");
        }, lines -> lines);
        var commit = new com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest(
                request.workspaceId(), request.writerId(), request.writerGeneration(), request.expectedJournalRevision(),
                request.expectedCommittedSequence(), request.transactionId(), request.operation(), request.commandId(),
                request.contentDigest(), request.firstSequence(), request.lastSequence(), request.eventCount(),
                request.eventsDigest(), request.previousCommitDigest(), request.commitDigest(), request.activationEpoch(),
                request.latestCheckpointResourceId(), request.recordCount(), request.recordBytesBase64(), request.recordDigest(),
                List.of(resource));
        var start = new CyclicBarrier(2);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var backfill = executor.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                return store.contextCompressionState("tenant", session);
            });
            var nativeCommit = executor.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                return tx(() -> journal.commit(commit));
            });
            backfill.get(20, TimeUnit.SECONDS);
            nativeCommit.get(20, TimeUnit.SECONDS);
            assertThat(store.contextCompressionState("tenant", session).compactionRevision())
                    .isEqualTo(commit.firstSequence());
        }
    }

    private static String attempt(Runnable action) {
        try {
            action.run();
            return "accepted";
        } catch (ManagedAgentException error) {
            return error.getCode();
        }
    }
}
