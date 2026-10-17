package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

public final class ManagedRuntimeRetentionGuard implements JdbcRuntimeRetention.ReferenceGuard {
    @Override
    public boolean bindingReferenced(Connection connection, RuntimeBindingRecord binding)
            throws SQLException {
        var request = binding.getRequest();
        // A shared binding has no isolation key; private-CSI Sessions never place on one.
        return JdbcCsiFilesRetirementGuard.isProfile(request.getScope())
                || request.getIsolationKey() != null
                        && exists(
                                connection,
                                "SELECT 1 FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                                    + " AND csi_guard = TRUE LIMIT 1 FOR UPDATE",
                                identity(request.getScope().getTenantId()),
                                identity(request.getIsolationKey()))
                || exists(
                        connection,
                        "SELECT 1 FROM ma_storage_owner"
                                + " WHERE binding_id = ? AND runtime_generation = ? LIMIT 1",
                        identity(binding.getBindingId()),
                        binding.getGeneration())
                || exists(
                        connection,
                        "SELECT 1 FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT' AND"
                            + " target_kind = 'RUNTIME_BINDING' AND target_id = ? AND"
                            + " target_revision = ? LIMIT 1",
                        identity(binding.getBindingId()),
                        binding.getGeneration())
                || childRunUnsettled(connection, binding)
                || backgroundRunUnsettled(connection, binding);
    }

    private static boolean backgroundRunUnsettled(
            Connection connection, RuntimeBindingRecord binding) throws SQLException {
        String tenantId = binding.getRequest().getScope().getTenantId();
        // Session-open treats a missing <call>:process row as proof that the Shell never started.
        // Deduplicate owners by binary identity to avoid scanning a Session for every process.
        return exists(
                connection,
                "SELECT 1 FROM (SELECT DISTINCT e.harness_session_id, CAST(e.harness_session_id AS"
                    + " BINARY(2048)) AS harness_session_key FROM ma_tool_execution e WHERE"
                    + " e.binding_id = ? AND e.runtime_generation = ? AND CAST(e.binding_id AS"
                    + " BINARY(2048)) = CAST(? AS BINARY(2048)) AND CAST(RIGHT(e.execution_call_id,"
                    + " 8) AS BINARY(8)) = CAST(':process' AS BINARY(8))) s JOIN ma_session_record"
                    + " r ON r.tenant_id = ? AND r.session_id = s.harness_session_id AND"
                    + " r.record_kind = 'DOMAIN' AND r.domain = 'child_run' WHERE CAST(r.tenant_id"
                    + " AS BINARY(2048)) = CAST(? AS BINARY(2048)) AND CAST(r.workspace_id AS"
                    + " BINARY(2048)) = CAST(? AS BINARY(2048)) AND CAST(r.session_id AS"
                    + " BINARY(2048)) = s.harness_session_key AND CAST(r.domain AS BINARY(2048)) ="
                    + " CAST('child_run' AS BINARY(2048)) AND CAST(r.task_kind AS BINARY(2048)) ="
                    + " CAST('background_shell' AS BINARY(2048)) AND r.settled_at IS NULL LIMIT 1",
                identity(binding.getBindingId()),
                binding.getGeneration(),
                binding.getBindingId(),
                identity(tenantId),
                tenantId,
                binding.getRequest().getScope().getWorkspaceId());
    }

    private static boolean childRunUnsettled(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        String tenantId = binding.getRequest().getScope().getTenantId();
        if (HarnessOwnership.sharesRuntimeSessions(binding.getRequest())) {
            // Guards run before any deletion, and a settled child run cannot reopen, so owners
            // whose Runtime Sessions a later visit removes were already settled.
            List<String> owners = new ArrayList<>();
            try (var statement =
                    connection.prepareStatement(
                            "SELECT DISTINCT harness_session_id FROM ma_runtime_session"
                                    + " WHERE binding_id = ? AND runtime_generation = ? AND tenant_id = ?")) {
                statement.setQueryTimeout(10);
                statement.setBytes(1, identity(binding.getBindingId()));
                statement.setLong(2, binding.getGeneration());
                statement.setBytes(3, identity(tenantId));
                try (var rows = statement.executeQuery()) {
                    while (rows.next()) {
                        owners.add(rows.getString("harness_session_id"));
                    }
                }
            }
            for (String owner : owners) {
                if (childRunUnsettled(connection, tenantId, owner)) {
                    return true;
                }
            }
            return false;
        }
        String sessionId = binding.getRequest().getIsolationKey();
        if (sessionId == null) {
            return false;
        }
        return childRunUnsettled(connection, tenantId, sessionId);
    }

    private static boolean childRunUnsettled(Connection connection, String tenantId, String sessionId)
            throws SQLException {
        try (var statement =
                connection.prepareStatement(
                        "SELECT tenant_id, session_id, parent_session_id, parent_child_run_id FROM"
                            + " ma_session WHERE tenant_id = ? AND session_id = ?")) {
            statement.setQueryTimeout(10);
            statement.setBytes(1, tenantId.getBytes(StandardCharsets.UTF_8));
            statement.setBytes(2, sessionId.getBytes(StandardCharsets.UTF_8));
            try (var rows = statement.executeQuery()) {
                if (!rows.next() || !tenantId.equals(rows.getString("tenant_id"))
                        || !sessionId.equals(rows.getString("session_id"))) {
                    return false;
                }
                String parent = rows.getString("parent_session_id");
                String run = rows.getString("parent_child_run_id");
                if (parent == null && run == null) {
                    return false;
                }
                if (parent == null || run == null) {
                    return true;
                }
                // Lineage precedes warm; a canonical terminal run cannot reopen its identity repair
                // debt.
                return !exists(
                        connection,
                        "SELECT 1 FROM ma_session_record WHERE record_kind = 'DOMAIN' AND"
                            + " session_scope_key = ? AND record_key = ? AND CAST(tenant_id AS"
                            + " BINARY(2048)) = CAST(? AS BINARY(2048)) AND CAST(session_id AS"
                            + " BINARY(2048)) = CAST(? AS BINARY(2048)) AND CAST(domain AS"
                            + " BINARY(2048)) = CAST('child_run' AS BINARY(2048)) AND"
                            + " CAST(record_id AS BINARY(2048)) = CAST(? AS BINARY(2048)) AND"
                            + " settled_at IS NOT NULL LIMIT 1",
                        ManagedSessionStore.sessionScopeKey(tenantId, parent),
                        ManagedExtensionProjection.recordKey(parent, "child_run", run),
                        tenantId,
                        parent,
                        run);
            }
        }
    }

    @Override
    public boolean executionReferenced(Connection connection, String executionCallId)
            throws SQLException {
        String key =
                ToolPublicationContract.sha256(executionCallId.getBytes(StandardCharsets.UTF_8));
        return exists(
                        connection,
                        "SELECT 1 FROM ma_tool_execution WHERE execution_call_id_hash = ? AND"
                            + " execution_call_id = ? AND native_authorization_json IS NOT NULL"
                            + " LIMIT 1 FOR UPDATE",
                        ManagedSchemaKeys.key(executionCallId),
                        identity(executionCallId))
                || exists(
                        connection,
                        "SELECT 1 FROM ma_output_capture WHERE execution_key = ? LIMIT 1",
                        key)
                || exists(
                        connection,
                        "SELECT 1 FROM ma_operation_work w JOIN ma_operation o"
                                + " ON o.operation_key = w.operation_key"
                                + " WHERE w.work_kind = 'CSI_WORKER_ACK' AND w.target_key = ?"
                                + " AND o.operation_kind = 'CSI_RETIREMENT' LIMIT 1",
                        key);
    }

    private static byte[] identity(String value) {
        return value == null ? null : value.getBytes(StandardCharsets.UTF_8);
    }

    private static boolean exists(Connection connection, String sql, Object... parameters)
            throws SQLException {
        try (var statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(10);
            for (int index = 0; index < parameters.length; index++) {
                statement.setObject(index + 1, parameters[index]);
            }
            try (var rows = statement.executeQuery()) {
                return rows.next();
            }
        }
    }
}
