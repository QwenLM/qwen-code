package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.IOException;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSessionQueryTest {
    private static final String TENANT = "query-tenant";
    private static final String WORKSPACE = "query-workspace";
    private static final String SESSION = "query-session";
    private static final String TOKEN = "extension-writer-token-0123456789";
    protected JdbcTemplate jdbc;
    private ManagedSessionStore sessions;
    private TransactionTemplate tx;
    private ExtensionRecordJournal journal;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:query-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        sessions = new ManagedSessionStore(jdbc);
        tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        journal = new ExtensionRecordJournal(sessions, TENANT, WORKSPACE, SESSION);
        tx.executeWithoutResult(status -> journal.open());
    }

    private void commit(String command, int revision) throws IOException {
        var value = ManagedExtensionProjectionContractTest.fixtures().required("monitorChainCases").get(0)
                .required("revisions").get(revision);
        tx.executeWithoutResult(status -> journal.commitMonitor(command, value.required("monitorRun"),
                value.required("occurredAt").longValue()));
    }

    @Test
    void recentPagesAreChronologicalBoundedAndKeepTheirOriginalPrefix() throws IOException {
        commit("first", 0);
        var frozen = sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN, null, null, 1);
        assertThat(frozen.transactions()).extracting(value -> value.commandId()).containsExactly("first");
        assertThat(frozen.throughRevision()).isEqualTo(2);
        assertThat(frozen.nextBeforeRevision()).isEqualTo(2);
        commit("second", 1);
        var older = sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN,
                frozen.throughRevision(), frozen.nextBeforeRevision(), 1);
        assertThat(older.transactions()).extracting(value -> value.commandId()).containsExactly("command-genesis");
        assertThat(older.hasMore()).isFalse();
        assertThat(older.nextBeforeRevision()).isNull();
        var latest = sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN, null, null, 2);
        assertThat(latest.transactions()).extracting(value -> value.commandId()).containsExactly("first", "second");
        assertThat(latest.transactions().stream().mapToLong(value -> value.byteLength()).sum())
                .isLessThanOrEqualTo(8 * 1024 * 1024);
    }

    @Test
    void commandLookupUsesExactIdentityWithinTheCapturedPrefix() throws IOException {
        commit("first", 0);
        commit("second", 1);
        assertThat(sessions.commandTransaction(TENANT, WORKSPACE, SESSION, TOKEN, 2L,
                ExtensionRecordJournal.OPERATION, "first").transaction().commandId()).isEqualTo("first");
        assertThat(sessions.commandTransaction(TENANT, WORKSPACE, SESSION, TOKEN, 2L,
                ExtensionRecordJournal.OPERATION, "second").transaction()).isNull();
        assertThat(sessions.commandTransaction(TENANT, WORKSPACE, SESSION, TOKEN, null,
                "another-operation", "first").transaction()).isNull();
        assertThat(sessions.commandTransaction(TENANT, WORKSPACE, SESSION, TOKEN, null,
                ExtensionRecordJournal.OPERATION, "second").transaction().journalRevision()).isEqualTo(3);
    }

    @Test
    void rejectsFutureBoundsMissingPrefixAndOversizedRows() {
        assertThatThrownBy(() -> sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN, 2L, null, 1))
                .hasMessageContaining("prefix");
        assertThatThrownBy(() -> sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN, null, 0L, 1))
                .hasMessageContaining("position");
        assertThatThrownBy(() -> sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN, null, null, 101))
                .hasMessageContaining("position");
        jdbc.update("UPDATE ma_session_journal_tx SET byte_length = ? WHERE tenant_id = ? AND session_id = ?",
                8 * 1024 * 1024 + 1, TENANT, SESSION);
        assertThatThrownBy(() -> sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN, null, null, 1))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        assertThatThrownBy(() -> sessions.commandTransaction(TENANT, WORKSPACE, SESSION, TOKEN, null,
                "session.create", "command-genesis"))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        jdbc.update("DELETE FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        assertThatThrownBy(() -> sessions.commandTransaction(TENANT, WORKSPACE, SESSION, TOKEN, null,
                "session.create", "missing"))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
    }

    @Test
    void queriesPreserveCredentialsScopeAndWriterOwnership() {
        var before = sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN);
        assertThatThrownBy(() -> sessions.recentTransactions(TENANT, "other-workspace", SESSION, TOKEN, null, null, 1))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        assertThatThrownBy(() -> sessions.commandTransaction(TENANT, WORKSPACE, SESSION, "x".repeat(32), null,
                "session.create", "command-genesis"))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        var after = sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN);
        assertThat(after).isEqualTo(before);
    }

    @Test
    void replacedWriterCannotReadEitherQuerySurface() {
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 0 WHERE tenant_id = ? AND session_id = ?",
                TENANT, SESSION);
        String replacement = "replacement-writer-token-0123456789";
        tx.executeWithoutResult(status -> sessions.acquireWriter(TENANT, SESSION, replacement,
                new com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.AcquireWriterRequest(
                        WORKSPACE, "replacement", 60_000L)));
        assertThatThrownBy(() -> sessions.recentTransactions(TENANT, WORKSPACE, SESSION, TOKEN, null, null, 1))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        assertThatThrownBy(() -> sessions.commandTransaction(TENANT, WORKSPACE, SESSION, TOKEN, null,
                "session.create", "command-genesis"))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        assertThat(sessions.commandTransaction(TENANT, WORKSPACE, SESSION, replacement, null,
                "session.create", "command-genesis").transaction()).isNotNull();
    }
}
