package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;

class AutomationCommandTimestampTest {
    @Test
    void settlingACommandAdvancesItsModificationTimestamp() {
        try (var fixture = ConsolidatedStoreFixture.open("command_time")) {
            ManagedSchema.initialize(fixture.source());
            JdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(fixture.source());
            jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                    + " gmt_create, gmt_modified) VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1000, 1000)");
            AutomationLedgerStore ledger = new AutomationLedgerStore(jdbc);
            AutomationLedgerStore.CommandRow command =
                    new AutomationLedgerStore.CommandRow("tenant", "command", "actor",
                            "request", "schedule", "");
            assertThat(ledger.claimCommand("session", command, 1000L)).isTrue();
            assertThat(ledger.settleCommand("tenant", "command", "request", "another-actor",
                    "{\"accepted\":true}")).isFalse();
            assertThat(jdbc.queryForObject("SELECT gmt_modified FROM ma_request_receipt"
                            + " WHERE tenant_id = ? AND idempotency_key = ?", Long.class, "tenant", "command"))
                    .isEqualTo(1000L);
            assertThat(ledger.settleCommand("tenant", "command", "request", "actor",
                    "{\"accepted\":true}")).isTrue();
            assertThat(jdbc.queryForObject("SELECT state FROM ma_request_receipt"
                            + " WHERE namespace = 'AUTOMATION' AND tenant_id = ?"
                            + " AND idempotency_key = ?", String.class, "tenant", "command"))
                    .isEqualTo("COMPLETED");
            Long completedAt = jdbc.queryForObject("SELECT gmt_modified FROM ma_request_receipt"
                            + " WHERE namespace = 'AUTOMATION' AND tenant_id = ?"
                            + " AND idempotency_key = ?", Long.class, "tenant", "command");
            assertThat(completedAt).isGreaterThan(1000L);
            assertThat(ledger.settleCommand("tenant", "command", "request", "actor",
                    "{\"accepted\":false}")).isFalse();
            assertThat(jdbc.queryForObject("SELECT gmt_modified FROM ma_request_receipt"
                            + " WHERE tenant_id = ? AND idempotency_key = ?", Long.class, "tenant", "command"))
                    .isEqualTo(completedAt);
            assertThat(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt"
                            + " WHERE tenant_id = ? AND idempotency_key = ?", String.class, "tenant", "command"))
                    .isEqualTo("{\"accepted\":true}");
        }
    }
}
