package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHookRecords;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskPage;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskRow;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskTarget;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

final class ManagedExtensionQueries {
    private ManagedExtensionQueries() { }

    static List<JsonNode> records(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store, String tenant, String session, String domain) {
        var body = ManagedExtensionProjection.RECORD_BODIES.get(domain);
        JdbcManagedExtensionRecordStore.require(body != null, "Unknown extension record domain.");
        List<String> ids = jdbc.query("SELECT record_resource_id FROM"
                        + " ma_session_record WHERE record_kind = 'DOMAIN' AND"
                        + " tenant_id = ?"
                        + " AND session_id = ? AND domain = ? ORDER BY gmt_create, record_id",
                (result, row) -> result.getString("record_resource_id"),
                tenant, session, domain);
        return ids.stream().map(id -> {
            JsonNode record = JdbcManagedExtensionRecordStore.readBody(store.readResource(tenant, session, id));
            body.require().accept(record);
            return record;
        }).toList();
    }

    static Optional<JsonNode> latestHook(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store, String tenant, String session) {
        return jdbc.query("SELECT record_resource_id FROM ma_session_record WHERE record_kind ="
                        + " 'DOMAIN' AND tenant_id = ? AND session_id"
                        + " = ? AND domain = 'hook_registration' AND settled_at IS NOT NULL ORDER BY first_sequence DESC",
                (result, row) -> result.getString("record_resource_id"),
                tenant, session)
                .stream().map(id -> {
                    JsonNode record = JdbcManagedExtensionRecordStore.readBody(store.readResource(tenant, session, id));
                    ManagedHookRecords.requireRegistration(record);
                    return record;
                }).filter(record -> "settled".equals(record.path("run").path("state").textValue())).findFirst();
    }

    static String readRevision(JdbcTemplate jdbc, String tenant, String session) {
        return jdbc.query("SELECT journal_revision FROM ma_session_head WHERE tenant_id = ? AND"
                        + " harness_session_id = ? AND head_kind = 'MANAGED_SESSION'",
                (row, index) -> row.getString("journal_revision"), tenant, session).stream().findFirst().orElse(null);
    }

    static Optional<JsonNode> configRef(JdbcTemplate jdbc, String tenant, String session) {
        return refs(jdbc, tenant, session, " AND r.domain = ? AND r.record_id = ?",
                List.of(ManagedMcpSettings.DOMAIN, ManagedMcpSettings.RECORD_ID))
                .stream().findFirst();
    }

    static List<JsonNode> mcpRefs(JdbcTemplate jdbc, String tenant, String session, int limit) {
        if (limit < 1 || limit > 257) {
            throw new IllegalArgumentException("MCP diagnostic limit is invalid");
        }
        return refs(jdbc, tenant, session,
                " AND r.domain = 'mcp_configuration' AND r.delivery_state IS NULL"
                        + " ORDER BY r.gmt_create DESC, r.record_id DESC LIMIT ?", List.of(limit));
    }

    private static List<JsonNode> refs(JdbcTemplate jdbc, String tenant, String session, String suffix, List<?> extra) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenant);
        arguments.add(session);
        arguments.addAll(extra);
        return jdbc.query("SELECT r.record_resource_id, u.kind, u.schema_version, u.byte_length, u.sha256"
                        + " FROM ma_session_record r LEFT JOIN ma_resource u ON"
                        + " " + ManagedSchemaJdbcTemplate.binaryIdentity(jdbc, "u.resource_id")
                        + " = r.record_resource_id AND u.tenant_id = r.tenant_id AND u.session_id = r.session_id"
                        + " AND u.workspace_id = r.workspace_id WHERE r.record_kind = 'DOMAIN'"
                        + " AND r.tenant_id = ? AND r.session_id = ?" + suffix,
                (row, index) -> (JsonNode) JsonNodeFactory.instance.objectNode().put("resourceId", row.getString("record_resource_id"))
                        .put("kind", row.getString("kind")).put("schemaVersion", row.getInt("schema_version"))
                        .put("byteLength", row.getLong("byte_length")).put("digest", row.getString("sha256")), arguments.toArray());
    }

    static TaskPage tasks(JdbcTemplate jdbc, String tenant, String session, Long beforeCreatedAt,
            String beforeRecordKey, int limit, boolean childrenOnly, RowMapper<TaskRow> mapper) {
        String select = "SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns() + " FROM"
                + " ma_session_record WHERE record_kind = 'DOMAIN' AND tenant_id = ? AND session_id = ? AND "
                + (childrenOnly ? "task_kind = 'child_agent'" : "task_kind IS NOT NULL");
        RowMapper<TimedTask> timed = (result, row) ->
                new TimedTask(mapper.mapRow(result, row), result.getLong("gmt_create"));
        List<TimedTask> rows = new ArrayList<>();
        if (beforeCreatedAt != null && beforeRecordKey != null) {
            // The public tie-break is the record hash inside taskId, not a stored
            // column: read the cursor timestamp's whole tie group and filter it here.
            String beforeTaskId = ManagedExtensionProjection.taskId(beforeRecordKey);
            jdbc.query(select + " AND gmt_create = ?", timed, tenant, session, beforeCreatedAt)
                    .stream().filter(row -> row.row().taskId().compareTo(beforeTaskId) < 0)
                    .forEach(rows::add);
        }
        List<Object> arguments = new ArrayList<>(List.of(tenant, session));
        String younger = "";
        if (beforeCreatedAt != null) {
            younger = " AND gmt_create < ?";
            arguments.add(beforeCreatedAt);
        }
        arguments.add(limit + 1);
        List<TimedTask> window = jdbc.query(select + younger
                + " ORDER BY gmt_create DESC, record_id DESC LIMIT ?", timed, arguments.toArray());
        // A page boundary inside a timestamp tie must see the whole group, or the
        // hash order could drop or duplicate rows across pages.
        if (window.size() > limit && window.get(limit - 1).createdAt() == window.get(limit).createdAt()) {
            long boundary = window.get(limit).createdAt();
            List<TimedTask> merged = window.stream().filter(row -> row.createdAt() > boundary)
                    .collect(java.util.stream.Collectors.toCollection(ArrayList::new));
            merged.addAll(jdbc.query(select + " AND gmt_create = ?", timed, tenant, session, boundary));
            window = merged;
        }
        rows.addAll(window);
        rows.sort(java.util.Comparator.comparingLong(TimedTask::createdAt).reversed()
                .thenComparing(row -> row.row().taskId(), java.util.Comparator.reverseOrder()));
        boolean hasMore = rows.size() > limit;
        return new TaskPage(rows.stream().limit(limit).map(TimedTask::row).toList(), hasMore);
    }

    private record TimedTask(TaskRow row, long createdAt) { }

    static Optional<TaskRow> task(JdbcTemplate jdbc, String tenant, String session, String recordKey, RowMapper<TaskRow> mapper) {
        String[] identity = recordIdentity(jdbc, tenant, session, recordKey);
        if (identity == null) {
            return Optional.empty();
        }
        return jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns()
                        + " FROM ma_session_record WHERE record_kind = 'DOMAIN' AND tenant_id = ? AND session_id = ? AND domain = ? AND record_id = ?"
                        + " AND task_kind IS NOT NULL",
                mapper, tenant, session, identity[0], identity[1])
                .stream().findFirst();
    }

    static Optional<TaskTarget> target(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store,
            String tenant, String session, String recordKey, RowMapper<TaskRow> mapper) {
        String[] identity = recordIdentity(jdbc, tenant, session, recordKey);
        if (identity == null) {
            return Optional.empty();
        }
        return targetByRecord(jdbc, store, tenant, session, identity[0], identity[1], mapper);
    }

    // Queries the raw (domain, record_id) business key directly, so a caller
    // that already holds the row does not pay a Session-wide scan to re-resolve
    // the public task id hash.
    static Optional<TaskTarget> targetByRecord(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store,
            String tenant, String session, String domain, String recordId, RowMapper<TaskRow> mapper) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns()
                        + " FROM ma_session_record WHERE record_kind = 'DOMAIN' AND tenant_id = ? AND session_id = ? AND domain = ? AND record_id = ?"
                        + " AND task_kind IS NOT NULL",
                (result, row) -> {
                    mapper.mapRow(result, row);
                    return new String[] {result.getString("domain"), result.getString("record_id"),
                            result.getString("task_kind"), result.getString("task_state"),
                            Long.toString(result.getLong("revision")), result.getString("record_resource_id")};
                }, tenant, session, domain, recordId)
                .stream().findFirst().map(row -> {
                    JsonNode body = JdbcManagedExtensionRecordStore.readBody(store.readResource(tenant, session, row[5]));
                    ManagedExtensionProjection.RECORD_BODIES.get(row[0]).require().accept(body);
                    return new TaskTarget(row[0], row[1], row[2], row[3], Long.parseLong(row[4]), body);
                });
    }

    // A public task id carries the record hash, but rows are keyed by the raw
    // (domain, record_id) tuple, so the hash is matched over the Session's tasks.
    // Package-private so a locking admission can resolve the tuple with a
    // non-locking read before taking FOR UPDATE on the single resolved row.
    static String[] recordIdentity(JdbcTemplate jdbc, String tenant, String session, String recordKey) {
        if (recordKey == null) {
            return null;
        }
        return jdbc.query("SELECT domain, record_id FROM ma_session_record WHERE record_kind = 'DOMAIN'"
                        + " AND tenant_id = ? AND session_id = ? AND task_kind IS NOT NULL",
                (row, index) -> new String[] {row.getString("domain"), row.getString("record_id")}, tenant, session)
                .stream()
                .filter(identity -> recordKey.equals(
                        ManagedExtensionProjection.recordKey(session, identity[0], identity[1])))
                .findFirst().orElse(null);
    }

    // Resolves many record keys in one Session-wide task scan instead of one
    // scan per key, so a page of activity items costs O(tasks) rather than
    // O(page x tasks). Keys absent from the Session are simply not returned.
    static Map<String, TaskRow> tasksByRecordKeys(JdbcTemplate jdbc, String tenant, String session,
            Set<String> recordKeys, RowMapper<TaskRow> mapper) {
        if (recordKeys.isEmpty()) {
            return Map.of();
        }
        Map<String, TaskRow> found = new HashMap<>();
        jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns()
                        + " FROM ma_session_record WHERE record_kind = 'DOMAIN' AND tenant_id = ? AND session_id = ?"
                        + " AND task_kind IS NOT NULL",
                (result, row) -> {
                    String key = ManagedExtensionProjection.recordKey(session,
                            result.getString("domain"), result.getString("record_id"));
                    if (recordKeys.contains(key)) {
                        found.put(key, mapper.mapRow(result, row));
                    }
                    return null;
                }, tenant, session);
        return found;
    }
}
