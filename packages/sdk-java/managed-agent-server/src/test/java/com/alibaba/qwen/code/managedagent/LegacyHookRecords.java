package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Hook records as a V27 store wrote them, without admission projections, and
 * the projections V29 must give them. Two Sessions consume the same once key:
 * once keys are unique per Session only.
 */
final class LegacyHookRecords {
    private LegacyHookRecords() {
    }

    static void insert(JdbcTemplate jdbc, String tenant, String session)
            throws IOException {
        for (String sessionId : List.of(session, session + "-other")) {
            JsonNode templates = ManagedHookRecordContractTest.fixtures()
                    .get("templates");
            row(jdbc, tenant, sessionId, "hook_registration", "registration-1",
                    templates.get("hook_registration"));
            for (Object[] execution : List.of(new Object[] {"execution-1", 0, "once-1"},
                    new Object[] {"execution-2", 1, null},
                    new Object[] {"execution-3", 2, "once-3"})) {
                ObjectNode body = templates.get("hook_execution").deepCopy();
                body.put("hookExecutionId", (String) execution[0])
                        .put("ordinal", (int) execution[1]);
                if (execution[2] == null) {
                    body.putNull("onceKey");
                } else {
                    body.put("onceKey", (String) execution[2]);
                }
                body.withObject("/run").put("effectId", (String) execution[0]);
                row(jdbc, tenant, sessionId, "hook_execution", (String) execution[0], body);
            }
            ObjectNode monitor = ManagedExtensionProjectionContractTest.fixtures()
                    .required("monitorChainCases").get(0).required("revisions")
                    .get(0).required("monitorRun").deepCopy();
            row(jdbc, tenant, sessionId, "monitor_run",
                    monitor.required("monitorId").textValue(), monitor);
        }
    }

    static void assertBackfilled(JdbcTemplate jdbc, String tenant, String session) {
        for (String sessionId : List.of(session, session + "-other")) {
            Map<String, List<Object>> expected = new HashMap<>();
            expected.put("registration-1", projection(null, null, null,
                    ExtensionRecordJournal.sha256("catalog-1\u00001")));
            expected.put("execution-1", projection("once-1", "occurrence-1", 0L, null));
            expected.put("execution-2", projection(null, "occurrence-1", 1L, null));
            expected.put("execution-3", projection("once-3", "occurrence-1", 2L, null));
            List<Map<String, Object>> rows = jdbc.queryForList("SELECT record_id,"
                            + " hook_once_key_hash, hook_occurrence_hash, hook_ordinal,"
                            + " hook_definition_hash FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " tenant_id = ? AND session_id = ?", tenant, sessionId);
            assertThat(rows).hasSize(5);
            for (Map<String, Object> row : rows) {
                List<Object> actual = new ArrayList<>();
                actual.add(row.get("hook_once_key_hash"));
                actual.add(row.get("hook_occurrence_hash"));
                Object ordinal = row.get("hook_ordinal");
                actual.add(ordinal == null ? null : ((Number) ordinal).longValue());
                actual.add(row.get("hook_definition_hash"));
                assertThat(actual).as("%s %s", sessionId, row.get("record_id"))
                        .isEqualTo(expected.getOrDefault((String) row.get("record_id"),
                                projection(null, null, null, null)));
            }
        }
    }

    private static List<Object> projection(String onceKey, String occurrence,
            Long ordinal, String definition) {
        List<Object> values = new ArrayList<>();
        values.add(onceKey == null ? null : ExtensionRecordJournal.sha256(onceKey));
        values.add(occurrence == null ? null : ExtensionRecordJournal.sha256(occurrence));
        values.add(ordinal);
        values.add(definition);
        return values;
    }

    private static void row(JdbcTemplate jdbc, String tenant, String session,
            String domain, String recordId, JsonNode body) {
        byte[] bytes = ExtensionRecordJournal.bytes(body);
        String scopeKey = ExtensionRecordJournal.sha256(tenant + "\u0000" + session);
        String resourceId = "legacy-" + domain + "-" + recordId;
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id, session_id,"
                        + " resource_id, kind, schema_version, byte_length, sha256,"
                        + " storage_kind, inline_bytes, publish_command_id, state,"
                        + " created_at) VALUES (?, ?, 'legacy-workspace', ?, ?, ?, 1,"
                        + " ?, ?, 'MYSQL_INLINE', ?, 'legacy', 'REFERENCED',"
                        + " CURRENT_TIMESTAMP)",
                scopeKey, tenant, session, resourceId, "managed-" + domain,
                bytes.length, ExtensionRecordJournal.sha256(bytes), bytes);
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id, workspace_id,"
                        + " session_id, domain, record_id, operation_hash, revision,"
                        + " record_resource_id, task_kind, task_state, created_at)"
                        + " VALUES (?, ?, ?, 'legacy-workspace', ?, ?, ?, ?, 1, ?, ?,"
                        + " ?, 1000)",
                scopeKey, ManagedExtensionProjection.recordKey(session, domain, recordId),
                tenant, session, domain, recordId,
                ExtensionRecordJournal.sha256("legacy-" + recordId), resourceId,
                domain.equals("monitor_run") ? "monitor" : null,
                domain.equals("monitor_run") ? "pending" : null);
    }
}
