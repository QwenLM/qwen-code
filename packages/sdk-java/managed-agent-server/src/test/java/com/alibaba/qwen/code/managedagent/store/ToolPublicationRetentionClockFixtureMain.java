package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/** Exercises the shared database clock from a JVM with its own timezone. */
public final class ToolPublicationRetentionClockFixtureMain {
    private ToolPublicationRetentionClockFixtureMain() {
    }

    public static void main(String[] args) {
        var source = new DriverManagerDataSource(System.getenv("D1_MYSQL_URL"),
                System.getenv("D1_MYSQL_USER"), System.getenv("D1_MYSQL_PASSWORD"));
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var tx = new TransactionTemplate(manager);
        var retention = new ToolPublicationRetentionStore(jdbc, manager);
        var sessions = new ManagedSessionStore(jdbc);
        String tenant = "clock-" + UUID.randomUUID();
        String session = "session-clock";
        var key = new ObjectMapper().createObjectNode().put("tenantId", tenant)
                .put("workspaceId", "workspace-clock").put("sessionId", session);
        try {
            assertEpoch(jdbc, ToolPublicationRetentionStore.now(jdbc));
            try (var lease = retention.read(key)) {
                lease.check();
                long expires = jdbc.queryForObject("SELECT expires_at FROM qwen_output_read_lease"
                        + " WHERE tenant_key = ?", Long.class, ToolPublicationRetentionStore.hash(tenant));
                assertThat(expires - databaseEpoch(jdbc)).isBetween(118_000L, 120_000L);
            }
            tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                    new ManagedSessionStoreModels.AcquireWriterRequest("workspace-clock", "writer-clock", 60_000L)));
            assertThat(jdbc.queryForObject("SELECT UNIX_TIMESTAMP(writer_lease_until) * 1000"
                    + " - UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) * 1000 FROM qwen_managed_session_journal_head"
                    + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session))
                    .isBetween(58_000L, 60_000L);
            assertThatThrownBy(() -> retire(jdbc, tx, tenant, session))
                    .isInstanceOfSatisfying(ApiException.class, error ->
                            assertThat(error.getCode()).isEqualTo("managed_session_writer_active"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement"
                    + " WHERE tenant_id = ?", Integer.class, tenant)).isZero();
            jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until ="
                    + " TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(6)) WHERE tenant_id = ?", tenant);
            retire(jdbc, tx, tenant, session);
            long retired = jdbc.queryForObject("SELECT retired_at FROM qwen_output_session_retirement"
                    + " WHERE tenant_id = ?", Long.class, tenant);
            assertEpoch(jdbc, retired);
            System.out.println("O4_RETENTION_CLOCK_OK");
        } finally {
            jdbc.update("DELETE FROM qwen_output_read_lease WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.hash(tenant));
            jdbc.update("DELETE FROM qwen_output_session_retirement WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM qwen_managed_session_journal_head WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM qwen_tool_publication_tenant WHERE tenant_id = ?", tenant);
        }
    }

    private static void retire(JdbcTemplate jdbc, TransactionTemplate tx, String tenant, String session) {
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
            ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete-clock");
        });
    }

    private static long databaseEpoch(JdbcTemplate jdbc) {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) * 1000", Long.class);
    }

    private static void assertEpoch(JdbcTemplate jdbc, long actual) {
        assertThat(actual - databaseEpoch(jdbc)).isBetween(-2_000L, 2_000L);
    }
}
