package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class WorkspaceOperations {
    enum Kind {
        WORKSPACE_RECOVERY, WORKSPACE_OPERATOR_RECOVERY, STORAGE_MIGRATION, WORKSPACE_RETIREMENT, CHILD_WORKSPACE, SESSION_WORKTREE
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<LinkedHashMap<String, Object>> MAP = new TypeReference<>() { };
    private final JdbcTemplate jdbc;
    private final String tenant;

    WorkspaceOperations(JdbcTemplate jdbc, String tenant) {
        this.jdbc = jdbc;
        this.tenant = tenant;
    }

    String key(Kind kind, String id) {
        return key(kind, tenant, id);
    }

    static String key(Kind kind, String tenant, String id) {
        return ManagedIdentityRefs.tenantOperationRef(kind.name(), tenant, id);
    }

    static String hash(String... fields) {
        return ManagedSchemaKeys.key(fields);
    }

    Map<String, Object> find(Kind kind, String id, boolean lock) {
        List<Map<String, Object>> rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_ref = ?"
                        + " AND operation_kind = ?" + (lock ? " FOR UPDATE" : ""),
                (row, index) -> operation(row), key(kind, id), kind.name());
        if (rows.isEmpty()) {
            return null;
        }
        Map<String, Object> row = rows.getFirst();
        if (!tenant.equals(row.get("tenant_id")) || !id.equals(row.get("operation_id"))) {
            throw new IllegalStateException("Workspace operation identity conflicts");
        }
        return row;
    }

    void create(Kind kind, String id, Map<String, Object> data) {
        String storage = (String) data.get("storage_id");
        Object physical = null;
        if (storage != null) {
            var aliases = jdbc.queryForList("SELECT storage_kind FROM ma_storage WHERE tenant_id = ? AND storage_id = ?", String.class,
                    tenant, storage);
            if (aliases.size() == 1 && "LOCAL".equals(aliases.getFirst())) {
                physical = LocalStorageOwners.key(jdbc, tenant, storage);
                if (kind == Kind.CHILD_WORKSPACE || kind == Kind.SESSION_WORKTREE) {
                    WorkspaceMigrationAdmission.requireOpen(jdbc, tenant, storage);
                }
            }
        }
        String target = (String) data.getOrDefault("binding_id", storage == null ? id : storage);
        Object revision = data.get("runtime_generation");
        String request = (String) data.getOrDefault("request_json", encode(data));
        String state = (String) data.getOrDefault("state", "PENDING");
        requireState(kind, state);
        jdbc.update("INSERT INTO ma_operation (operation_ref, scope_kind, scope_id, operation_kind, operation_id, tenant_id, session_id, target_kind, target_id, target_revision, storage_id, physical_id, state, phase, delivery_state, request_digest, request_json, result_json, available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                key(kind, id), "TENANT", tenant.getBytes(StandardCharsets.UTF_8), kind.name(), id,
                tenant, data.get("session_id"),
                data.containsKey("binding_id") ? "RUNTIME_BINDING" : "STORAGE", target.getBytes(StandardCharsets.UTF_8), revision,
                storage,
                physical, state, data.getOrDefault("phase", state), data.get("delivery_state"),
                data.getOrDefault("request_digest", hash(request)), request, envelope(data), data.getOrDefault("available_at", 0L));
    }

    void update(Kind kind, String id, Map<String, Object> changes) {
        Map<String, Object> row = find(kind, id, true);
        if (row == null) {
            throw new IllegalStateException("Workspace operation is missing");
        }
        Object desired = changes.getOrDefault("state", row.get("state"));
        requireTransition(kind, (String) row.get("state"), (String) desired);
        row.putAll(changes);
        if (changes.containsKey("state") && !changes.containsKey("phase")) {
            row.put("phase", row.get("state"));
        }
        jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, result_json = ?, gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE operation_ref = ? AND operation_kind = ?",
                row.get("state"), row.get("phase") == null ? row.get("state") : row.get("phase"), envelope(row), key(kind, id), kind.name());
    }

    static List<Map<String, Object>> rows(JdbcTemplate jdbc, String sql, Object... arguments) {
        return jdbc.query(sql, (row, index) ->
                ManagedSchemaRows.read(row), arguments);
    }

    static Map<String, Object> values(Object... fields) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < fields.length; index += 2) {
            result.put((String) fields[index], fields[index + 1]);
        }
        return result;
    }

    void insertWork(Kind kind, String id, String workKind, String target,
            String session, Map<String, Object> data, String state) {
        jdbc.update("INSERT INTO ma_operation_work (operation_ref, work_kind, target_id, tenant_id, session_id, storage_id, state, payload_json, evidence_resource_ref, evidence_sha256, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                key(kind, id), workKind, target.getBytes(StandardCharsets.UTF_8), tenant, session,
                data.get("storage_id"), state, workEnvelope(target, data), data.get("evidence_resource_ref"), data.get("evidence_sha256"));
    }

    Map<String, Object> findWork(Kind kind, String id, String workKind, String target, boolean lock) {
        List<Map<String, Object>> rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION_WORK.columns() + " FROM ma_operation_work WHERE operation_ref = ?"
                        + " AND work_kind = ? AND target_id = ?" + (lock ? " FOR UPDATE" : ""),
                (row, index) -> {
                    if (!tenant.equals(row.getString("tenant_id"))) {
                        throw new IllegalStateException("Workspace work tenant conflicts");
                    }
                    return work(row);
                }, key(kind, id), workKind, target);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    void updateWork(Kind kind, String id, String workKind, String target, Map<String, Object> changes) {
        Map<String, Object> row = findWork(kind, id, workKind, target, true);
        if (row == null) {
            throw new IllegalStateException("Workspace operation work is missing");
        }
        row.putAll(changes);
        jdbc.update("UPDATE ma_operation_work SET state = ?, payload_json = ?, gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE operation_ref = ? AND work_kind = ? AND target_id = ?",
                row.get("state"), workEnvelope((String) row.get("work_key"), row), key(kind, id), workKind, target);
    }

    static Map<String, Object> operation(ResultSet row) throws SQLException {
        Map<String, Object> data = decode(row.getString("result_json"));
        data.put("operation_id", row.getString("operation_id"));
        data.put("tenant_id", row.getString("tenant_id"));
        data.put("request_digest", row.getString("request_digest"));
        data.put("request_json", row.getString("request_json"));
        data.put("state", row.getString("state"));
        data.put("phase", row.getString("phase"));
        data.put("created_at", row.getLong("gmt_create"));
        data.put("updated_at", row.getLong("gmt_modified"));
        return data;
    }

    static Map<String, Object> work(ResultSet row) throws SQLException {
        Map<String, Object> data = decode(row.getString("payload_json"));
        String rawKey = row.getString("target_id");
        if (!rawKey.equals(decodeKey(row.getString("payload_json")))) {
            throw new IllegalStateException("Workspace work identity conflicts");
        }
        data.put("work_key", rawKey);
        data.put("session_id", row.getString("session_id"));
        data.put("state", row.getString("state"));
        data.put("evidence_resource_ref", ManagedSchemaRows.identity(row, "evidence_resource_ref"));
        data.put("evidence_sha256", row.getString("evidence_sha256"));
        return data;
    }

    static void requireState(Kind kind, String state) {
        Set<String> allowed = switch (kind) {
            case WORKSPACE_RECOVERY -> Set.of("CAPTURING", "VERIFYING", "SEALED", "VERIFIED", "INVALIDATED");
            case WORKSPACE_OPERATOR_RECOVERY -> Set.of("PREPARED", "ATTESTED", "COMPLETED");
            case STORAGE_MIGRATION -> Set.of("RETIRING", "RETIRED", "PREPARING", "PREPARED", "COMPLETED", "ABORTED", "INVALIDATED");
            case WORKSPACE_RETIREMENT -> Set.of("DRAINING", "PLATFORM_CLEANED", "RELEASED");
            case CHILD_WORKSPACE -> Set.of(JdbcChildWorkspaceStore.PREPARING, JdbcChildWorkspaceStore.READY,
                    JdbcChildWorkspaceStore.MERGING, JdbcChildWorkspaceStore.APPLYING, JdbcChildWorkspaceStore.APPLIED,
                    JdbcChildWorkspaceStore.MERGED, JdbcChildWorkspaceStore.CONFLICTED, JdbcChildWorkspaceStore.DISCARDING,
                    JdbcChildWorkspaceStore.DISCARDED, JdbcChildWorkspaceStore.FAILED, JdbcChildWorkspaceStore.BLOCKED);
            case SESSION_WORKTREE -> Set.of("PREPARING", "READY", "FAILED", "BLOCKED", "REMOVING", "REMOVED");
        };
        if (!allowed.contains(state)) {
            throw new IllegalArgumentException("Unknown state for Workspace operation " + kind);
        }
    }

    private static void requireTransition(Kind kind, String from, String to) {
        requireState(kind, from);
        requireState(kind, to);
        boolean allowed = from.equals(to) || switch (kind) {
            case WORKSPACE_RECOVERY -> "CAPTURING".equals(from) && Set.of("SEALED", "INVALIDATED").contains(to)
                    || "VERIFYING".equals(from) && "VERIFIED".equals(to);
            case WORKSPACE_OPERATOR_RECOVERY -> "PREPARED".equals(from) && "ATTESTED".equals(to)
                    || "ATTESTED".equals(from) && "COMPLETED".equals(to);
            case STORAGE_MIGRATION -> !Set.of("COMPLETED", "ABORTED").contains(from)
                    && (Set.of("ABORTED", "INVALIDATED").contains(to)
                    || "RETIRING".equals(from) && "RETIRED".equals(to)
                    || "RETIRED".equals(from) && "PREPARING".equals(to)
                    || "PREPARING".equals(from) && "PREPARED".equals(to)
                    || "PREPARED".equals(from) && "COMPLETED".equals(to));
            case WORKSPACE_RETIREMENT -> "DRAINING".equals(from) && "PLATFORM_CLEANED".equals(to)
                    || "PLATFORM_CLEANED".equals(from) && "RELEASED".equals(to);
            case CHILD_WORKSPACE, SESSION_WORKTREE -> false;
        };
        if (!allowed) {
            throw new IllegalStateException("Workspace operation transition conflicts");
        }
    }

    private static Map<String, Object> decode(String value) {
        try {
            JsonNode document = JSON.readTree(value);
            if (document.path("schemaVersion").asInt() != 1 || !document.path("data").isObject()) {
                throw new IllegalStateException("Workspace operation payload version is invalid");
            }
            return JSON.convertValue(document.path("data"), MAP);
        } catch (IOException error) {
            throw new IllegalStateException("Workspace operation payload is invalid", error);
        }
    }

    private static String decodeKey(String value) {
        try {
            return JSON.readTree(value).path("workKey").asText();
        } catch (IOException error) {
            throw new IllegalStateException("Workspace work identity is invalid", error);
        }
    }

    private static String envelope(Map<String, Object> value) {
        Map<String, Object> data = new LinkedHashMap<>(value);
        data.remove("created_at");
        data.remove("updated_at");
        data.remove("request_json");
        data.remove("request_digest");
        data.remove("operation_id");
        data.remove("tenant_id");
        data.remove("state");
        data.remove("phase");
        return encode(Map.of("schemaVersion", 1, "data", data));
    }

    private static String workEnvelope(String key, Map<String, Object> value) {
        return encode(Map.of("schemaVersion", 1, "workKey", key, "data", value));
    }

    private static String encode(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (IOException error) {
            throw new IllegalStateException("Workspace operation payload cannot be encoded", error);
        }
    }
}
