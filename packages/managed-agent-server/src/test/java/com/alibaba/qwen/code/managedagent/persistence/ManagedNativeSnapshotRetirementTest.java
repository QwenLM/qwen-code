package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedNativeSnapshotRetirementTest {
    @Test
    void permanentRetirementReleasesNativeOwnersInBoundedBatchesOnlyForItsSession() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:native-retirement-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        var sessions = new ManagedSessionStore(jdbc);
        var snapshots = new ManagedNativeJournalSnapshots(jdbc, sessions, new ObjectMapper());
        for (String session : java.util.List.of("retiring", "protected")) {
            tx.executeWithoutResult(status -> new ExtensionRecordJournal(sessions, "tenant", "workspace", session).open());
            for (String id : java.util.List.of("one", "two")) {
                tx.executeWithoutResult(status -> snapshots.publish("tenant", session, "extension-writer-token-0123456789",
                        new ManagedNativeJournalSnapshots.PublishRequest("workspace", "writer-extension", 1, id, 1, 0, null)));
            }
        }
        jdbc.update("UPDATE ma_session SET retired_at = 1 WHERE tenant_id = ? AND session_id = ?", "tenant", "retiring");
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "retiring");
        for (int remaining = 4; remaining > 0; remaining--) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE session_scope_key = ?"
                    + " AND owner_kind = 'NATIVE_SNAPSHOT'", Long.class, scope)).isEqualTo(remaining);
            Boolean deleted = tx.execute(status -> ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, "tenant", "retiring", 1));
            assertThat(deleted).isTrue();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE session_scope_key = ?"
                + " AND owner_kind = 'NATIVE_SNAPSHOT'", Long.class, scope)).isZero();
        assertThat(snapshots.read("tenant", "workspace", "protected", "extension-writer-token-0123456789", "two")
                .snapshot().coveredJournalRevision()).isEqualTo(1);
    }
}
