package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedClientFilesRetirementTest {
    @Test
    void permanentRetirementRemovesClientFilesRowsOnlyForItsSession() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:client-files-retirement-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        var sessions = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc);
        var relay = new ClientFilesRelayStore(jdbc);
        for (String session : java.util.List.of("retiring", "protected")) {
            tx.executeWithoutResult(status -> new ExtensionRecordJournal(sessions, "tenant", "workspace", session).open());
            tx.executeWithoutResult(status -> {
                relay.register("tenant", session, "actor", "local-files", "a".repeat(64),
                        9_000L, 1_000L, "conn-" + session);
                relay.enqueue("tenant", session, 1L, "req-1", "{}", 9_000L, 1_000L);
            });
        }
        jdbc.update("UPDATE ma_session SET retired_at = 1 WHERE tenant_id = ? AND session_id = ?", "tenant", "retiring");
        // Drain the bounded retirement batches until nothing is left to delete.
        boolean deleted = true;
        for (int round = 0; round < 100 && deleted; round++) {
            deleted = Boolean.TRUE.equals(tx.execute(status ->
                    ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, "tenant", "retiring", 128)));
        }
        assertThat(deleted).isFalse();
        String retiringScope = ManagedSessionStore.sessionScopeKey("tenant", "retiring");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request WHERE session_scope_key = ?",
                Long.class, retiringScope)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_binding WHERE session_scope_key = ?",
                Long.class, retiringScope)).isZero();
        // A session that is not retired keeps its relay rows.
        String protectedScope = ManagedSessionStore.sessionScopeKey("tenant", "protected");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request WHERE session_scope_key = ?",
                Long.class, protectedScope)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_binding WHERE session_scope_key = ?",
                Long.class, protectedScope)).isEqualTo(1);
    }
}
