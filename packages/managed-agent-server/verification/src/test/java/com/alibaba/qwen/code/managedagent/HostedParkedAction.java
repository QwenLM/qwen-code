package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Map;

import static com.alibaba.qwen.code.managedagent.contracts.session.TurnExecutionStore.HARNESS_ACTION_PARKED;
import static org.assertj.core.api.Assertions.assertThat;

record HostedParkedAction(String promptId, String actionId, long writerGeneration) {
    static HostedParkedAction read(JdbcTemplate jdbc, String tenant, String session, String turn) {
        var rows = jdbc.queryForList("""
                SELECT t.status, t.prompt_id, t.error_code, t.retry_count, t.retry_after,
                       t.dispatch_owner, t.dispatch_lease_until,
                       h.state, h.activation_phase, h.writer_generation, h.journal_revision,
                       h.wake_seal_revision, h.wake_seal_parked_prompt_id, h.wake_seal_parked_until,
                       a.action_id, a.state AS action_state
                FROM ma_turn t
                JOIN ma_session_head h ON h.tenant_id = t.tenant_id AND h.harness_session_id = t.session_id
                    AND h.head_kind = 'MANAGED_SESSION'
                JOIN ma_session_record a ON a.tenant_id = t.tenant_id AND a.session_id = t.session_id
                    AND a.prompt_id = t.prompt_id AND a.record_kind = 'ACTION'
                WHERE t.tenant_id = ? AND t.session_id = ? AND t.turn_id = ?
                """, tenant, session, turn);
        assertThat(rows).as("Turn with its journal head and original Action").hasSize(1);
        var row = rows.getFirst();
        assertThat(row).containsEntry("status", "RUNNING").containsEntry("error_code", HARNESS_ACTION_PARKED)
                .containsEntry("state", "SEALED").containsEntry("activation_phase", "released")
                .containsEntry("action_state", "requested")
                .containsEntry("dispatch_owner", null).containsEntry("dispatch_lease_until", null)
                .containsEntry("wake_seal_parked_prompt_id", row.get("prompt_id"));
        assertThat(row.get("journal_revision")).isEqualTo(row.get("wake_seal_revision"));
        assertThat(row.get("retry_after")).isEqualTo(row.get("wake_seal_parked_until"));
        assertThat(((Number) row.get("retry_after")).longValue()).isGreaterThan(System.currentTimeMillis());
        assertThat(((Number) row.get("retry_count")).intValue()).isZero();
        return new HostedParkedAction((String) row.get("prompt_id"), (String) row.get("action_id"),
                ((Number) row.get("writer_generation")).longValue());
    }

    Map<String, Object> response(JsonNode action, String option) {
        assertThat(action.path("id").asText()).isEqualTo(actionId);
        assertThat(action.path("kind").asText()).isEqualTo("permission");
        assertThat(action.path("state").asText()).isEqualTo("requested");
        return Map.of("kind", "permission", "option_id", option,
                "input_revision", action.path("input_revision").asLong(),
                "policy_revision", action.path("policy_revision").asText());
    }

    void assertSettled(JdbcTemplate jdbc, String tenant, String session, String turn,
            String status, String terminalEvent) {
        var turns = jdbc.queryForList("""
                SELECT turn_id, status, prompt_id FROM ma_turn
                WHERE tenant_id = ? AND session_id = ?
                """, tenant, session);
        assertThat(turns).singleElement().satisfies(row ->
                assertThat(row).containsEntry("turn_id", turn).containsEntry("status", status)
                        .containsEntry("prompt_id", promptId));
        assertThat(jdbc.queryForList("""
                SELECT action_id, prompt_id, state FROM ma_session_record WHERE tenant_id = ? AND session_id = ?
                    AND record_kind = 'ACTION'
                """, tenant, session)).singleElement().satisfies(row -> {
                    assertThat(row).containsEntry("action_id", actionId).containsEntry("prompt_id", promptId);
                    assertThat(row.get("state")).isNotNull().isNotEqualTo("requested");
                });
        assertThat(jdbc.queryForList("""
                SELECT event_type FROM ma_public_event WHERE tenant_id = ? AND session_id = ? AND turn_id = ?
                    AND event_type IN ('turn.completed', 'turn.failed', 'turn.cancelled')
                """, String.class, tenant, session, turn)).containsExactly(terminalEvent);
        assertThat(jdbc.queryForObject("""
                SELECT writer_generation FROM ma_session_head
                WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'
                """, Long.class, tenant, session)).isEqualTo(writerGeneration + 1);
    }
}
