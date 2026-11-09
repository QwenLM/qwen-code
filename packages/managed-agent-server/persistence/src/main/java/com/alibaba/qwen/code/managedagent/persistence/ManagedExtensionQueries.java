package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHookRecords;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskPage;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskRow;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskTarget;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

final class ManagedExtensionQueries {
    private ManagedExtensionQueries() { }

    static List<JsonNode> records(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store, String tenant, String session, String domain) {
        var body = ManagedExtensionProjection.RECORD_BODIES.get(domain);
        JdbcManagedExtensionRecordStore.require(body != null, "Unknown extension record domain.");
        List<String> ids = jdbc.query("SELECT record_resource_id FROM"
                        + " ma_session_record WHERE record_kind = 'DOMAIN' AND"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND domain = ? ORDER BY gmt_create, record_key",
                (result, row) -> result.getString("record_resource_id"),
                ManagedSessionStore.sessionScopeKey(tenant, session), tenant, session, domain);
        return ids.stream().map(id -> {
            JsonNode record = JdbcManagedExtensionRecordStore.readBody(store.readResource(tenant, session, id));
            body.require().accept(record);
            return record;
        }).toList();
    }

    static Optional<JsonNode> latestHook(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store, String tenant, String session) {
        return jdbc.query("SELECT record_resource_id FROM ma_session_record WHERE record_kind ="
                        + " 'DOMAIN' AND session_scope_key = ? AND tenant_id = ? AND session_id"
                        + " = ? AND domain = 'hook_registration' AND settled_at IS NOT NULL ORDER BY first_sequence DESC",
                (result, row) -> result.getString("record_resource_id"),
                ManagedSessionStore.sessionScopeKey(tenant, session), tenant, session)
                .stream().map(id -> {
                    JsonNode record = JdbcManagedExtensionRecordStore.readBody(store.readResource(tenant, session, id));
                    ManagedHookRecords.requireRegistration(record);
                    return record;
                }).filter(record -> "settled".equals(record.path("run").path("state").textValue())).findFirst();
    }

    static String readRevision(JdbcTemplate jdbc, String tenant, String session) {
        return jdbc.query("SELECT journal_revision FROM ma_session_head WHERE tenant_key = ?"
                        + " AND harness_key = ? AND tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                (row, index) -> row.getString("journal_revision"), JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                JdbcRuntimeBindingRepository.harnessDrainKey(session), tenant, session).stream().findFirst().orElse(null);
    }

    static Optional<JsonNode> configRef(JdbcTemplate jdbc, String tenant, String session) {
        return refs(jdbc, tenant, session, " AND r.record_key = ?", List.of(
                ManagedExtensionProjection.recordKey(session, ManagedMcpSettings.DOMAIN, ManagedMcpSettings.RECORD_ID)))
                .stream().findFirst();
    }

    static List<JsonNode> mcpRefs(JdbcTemplate jdbc, String tenant, String session, int limit) {
        if (limit < 1 || limit > 257) {
            throw new IllegalArgumentException("MCP diagnostic limit is invalid");
        }
        return refs(jdbc, tenant, session,
                " AND r.domain = 'mcp_configuration' AND r.delivery_state IS NULL"
                        + " ORDER BY r.gmt_create DESC, r.record_key DESC LIMIT ?", List.of(limit));
    }

    private static List<JsonNode> refs(JdbcTemplate jdbc, String tenant, String session, String suffix, List<?> extra) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(ManagedSessionStore.sessionScopeKey(tenant, session));
        arguments.add(tenant);
        arguments.add(session);
        arguments.addAll(extra);
        return jdbc.query("SELECT r.record_resource_id, u.kind, u.schema_version, u.byte_length, u.sha256"
                        + " FROM ma_session_record r LEFT JOIN ma_resource u ON u.session_scope_key = r.session_scope_key"
                        + " AND u.resource_id = r.record_resource_id AND u.tenant_id = r.tenant_id AND u.session_id = r.session_id"
                        + " AND u.workspace_id = r.workspace_id WHERE r.record_kind = 'DOMAIN'"
                        + " AND r.session_scope_key = ? AND r.tenant_id = ? AND r.session_id = ?" + suffix,
                (row, index) -> (JsonNode) JsonNodeFactory.instance.objectNode().put("resourceId", row.getString("record_resource_id"))
                        .put("kind", row.getString("kind")).put("schemaVersion", row.getInt("schema_version"))
                        .put("byteLength", row.getLong("byte_length")).put("digest", row.getString("sha256")), arguments.toArray());
    }

    static TaskPage tasks(JdbcTemplate jdbc, String tenant, String session, Long beforeCreatedAt,
            String beforeRecordKey, int limit, boolean childrenOnly, RowMapper<TaskRow> mapper) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(ManagedSessionStore.sessionScopeKey(tenant, session));
        String cursor = "";
        if (beforeCreatedAt != null) {
            cursor = " AND (gmt_create < ? OR gmt_create = ? AND record_key < ?)";
            arguments.add(beforeCreatedAt);
            arguments.add(beforeCreatedAt);
            arguments.add(beforeRecordKey);
        }
        arguments.add(limit + 1);
        List<TaskRow> rows = jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns() + " FROM"
                        + " ma_session_record WHERE record_kind = 'DOMAIN' AND session_scope_key = ? AND "
                        + (childrenOnly ? "task_kind = 'child_agent'" : "task_kind IS NOT NULL")
                        + cursor + " ORDER BY gmt_create DESC, record_key DESC LIMIT ?", mapper, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new TaskPage(hasMore ? rows.subList(0, limit) : rows, hasMore);
    }

    static Optional<TaskRow> task(JdbcTemplate jdbc, String tenant, String session, String recordKey, RowMapper<TaskRow> mapper) {
        if (recordKey == null) {
            return Optional.empty();
        }
        return jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns()
                        + " FROM ma_session_record WHERE record_kind = 'DOMAIN' AND session_scope_key = ? AND record_key = ? AND task_kind IS NOT NULL",
                mapper, ManagedSessionStore.sessionScopeKey(tenant, session), recordKey)
                .stream().findFirst();
    }

    static Optional<TaskTarget> target(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store,
            String tenant, String session, String recordKey, RowMapper<TaskRow> mapper) {
        if (recordKey == null) {
            return Optional.empty();
        }
        return jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns()
                        + " FROM ma_session_record WHERE record_kind = 'DOMAIN' AND session_scope_key = ? AND record_key = ? AND task_kind IS NOT NULL",
                (result, row) -> {
                    mapper.mapRow(result, row);
                    return new String[] {result.getString("domain"), result.getString("record_id"),
                            result.getString("task_kind"), result.getString("task_state"),
                            Long.toString(result.getLong("revision")), result.getString("record_resource_id")};
                }, ManagedSessionStore.sessionScopeKey(tenant, session), recordKey)
                .stream().findFirst().map(row -> {
                    JsonNode body = JdbcManagedExtensionRecordStore.readBody(store.readResource(tenant, session, row[5]));
                    ManagedExtensionProjection.RECORD_BODIES.get(row[0]).require().accept(body);
                    return new TaskTarget(row[0], row[1], row[2], row[3], Long.parseLong(row[4]), body);
                });
    }
}
