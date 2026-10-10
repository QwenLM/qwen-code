package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;

public final class ManagedRuntimeRetentionGuard implements JdbcRuntimeRetention.ReferenceGuard {
    @Override
    public boolean bindingReferenced(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        return exists(connection, "SELECT 1 FROM managed_workspace_execution_lease"
                        + " WHERE binding_id = ? AND runtime_generation = ? LIMIT 1",
                binding.getBindingId(), binding.getGeneration())
                || exists(connection, "SELECT 1 FROM managed_workspace_csi_retirement"
                        + " WHERE binding_id = ? AND runtime_generation = ? LIMIT 1",
                binding.getBindingId(), binding.getGeneration())
                || childRunUnsettled(connection, binding);
    }

    private static boolean childRunUnsettled(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        String sessionId = binding.getRequest().getIsolationKey();
        if (sessionId == null) {
            return false;
        }
        String tenantId = binding.getRequest().getScope().getTenantId();
        try (var statement = connection.prepareStatement("SELECT tenant_id, session_id, parent_session_id,"
                + " parent_child_run_id FROM managed_agent_session WHERE tenant_id = ? AND session_id = ?")) {
            statement.setQueryTimeout(10);
            statement.setString(1, tenantId);
            statement.setString(2, sessionId);
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
                // Lineage precedes warm; a canonical terminal run cannot reopen its identity repair debt.
                return !exists(connection, "SELECT 1 FROM qwen_managed_session_extension_record"
                        + " WHERE session_scope_key = ? AND record_key = ?"
                        + " AND CAST(tenant_id AS BINARY(2048)) = CAST(? AS BINARY(2048))"
                        + " AND CAST(session_id AS BINARY(2048)) = CAST(? AS BINARY(2048))"
                        + " AND CAST(domain AS BINARY(2048)) = CAST('child_run' AS BINARY(2048))"
                        + " AND CAST(record_id AS BINARY(2048)) = CAST(? AS BINARY(2048))"
                        + " AND settled_at IS NOT NULL LIMIT 1",
                        ManagedSessionStore.sessionScopeKey(tenantId, parent),
                        ManagedExtensionProjection.recordKey(parent, "child_run", run), tenantId, parent, run);
            }
        }
    }

    @Override
    public boolean executionReferenced(Connection connection, String executionCallId) throws SQLException {
        String key = ToolPublicationContract.sha256(executionCallId.getBytes(StandardCharsets.UTF_8));
        return exists(connection, "SELECT 1 FROM qwen_tool_publication WHERE execution_key = ? LIMIT 1", key)
                || exists(connection, "SELECT 1 FROM managed_workspace_csi_worker_ack"
                        + " WHERE execution_call_id_hash = ? LIMIT 1", key);
    }

    private static boolean exists(Connection connection, String sql, Object... parameters) throws SQLException {
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
