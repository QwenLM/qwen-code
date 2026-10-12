package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/** Events written before V14, and the identity that V15 must give them. */
final class LegacyEvents {
    static final String TURN = "turn_legacy";
    private static final String ASSISTANT = "item_turn_legacy_assistant";

    private LegacyEvents() {
    }

    static void insert(JdbcTemplate jdbc, String tenant, String session) {
        insert(jdbc, tenant, session, 1, null, "session.created", "{}");
        insert(jdbc, tenant, session, 2, TURN, "turn.accepted", """
                {"itemId":"item_turn_legacy_input",
                 "input":[{"type":"text","text":"hi"}]}""");
        insert(jdbc, tenant, session, 3, TURN, "item.output_text.delta",
                "{\"text\":\"a\"}");
        insert(jdbc, tenant, session, 4, TURN, "item.output_text.delta",
                "{\"itemId\":\"" + ASSISTANT + "\",\"text\":\"b\"}");
        insert(jdbc, tenant, session, 5, TURN, "item.reasoning.delta",
                "{\"text\":\"c\"}");
        // A retracted delta keeps its row with empty text.
        insert(jdbc, tenant, session, 6, TURN, "item.output_text.delta",
                "{\"text\":\"\"}");
        insert(jdbc, tenant, session, 7, TURN, "item.output_text.delta",
                "{\"text\":\"d\"}");
        insert(jdbc, tenant, session, 8, TURN, "item.tool_call.updated",
                "{\"toolCallId\":\"tool-1\"}");
        insert(jdbc, tenant, session, 9, TURN, "turn.completed", "{}");
        // The same tool Item again, separated by an event without identity.
        insert(jdbc, tenant, session, 10, TURN, "item.tool_call.updated",
                "{\"toolCallId\":\"tool-1\",\"status\":\"completed\"}");
    }

    static void assertBackfilled(JdbcTemplate jdbc, String tenant,
            String session) {
        List<List<Object>> rows = jdbc.query("SELECT sequence_id,"
                        + " schema_version, projection_version, item_id,"
                        + " content_part_id FROM managed_agent_event WHERE"
                        + " tenant_id = ? AND session_id = ? ORDER BY"
                        + " sequence_id",
                (result, row) -> Arrays.asList(result.getLong(1),
                        result.getInt(2), result.getInt(3),
                        result.getString(4), result.getString(5)),
                tenant, session);
        String tool = "item_tool_" + UUID.nameUUIDFromBytes(
                "turn_legacy:tool-1".getBytes(StandardCharsets.UTF_8));
        assertThat(rows).containsExactly(
                row(1, null, null),
                row(2, "item_turn_legacy_input", null),
                row(3, ASSISTANT, "part_turn_legacy_output_text_3"),
                row(4, ASSISTANT, "part_turn_legacy_output_text_3"),
                row(5, ASSISTANT, "part_turn_legacy_reasoning_5"),
                row(6, null, null),
                row(7, ASSISTANT, "part_turn_legacy_output_text_7"),
                row(8, tool, null),
                row(9, null, null),
                row(10, tool, null));
    }

    private static List<Object> row(long sequence, String itemId,
            String partId) {
        return Arrays.asList(sequence, 1, 1, itemId, partId);
    }

    private static void insert(JdbcTemplate jdbc, String tenant,
            String session, long sequence, String turnId, String type,
            String data) {
        jdbc.update("INSERT INTO managed_agent_event (tenant_id, session_id,"
                        + " sequence_id, event_id, turn_id, event_type,"
                        + " data_json, terminal, source_key, created_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
                tenant, session, sequence, "evt_legacy_" + session + "_"
                        + sequence, turnId, type, data,
                "turn.completed".equals(type));
    }
}
