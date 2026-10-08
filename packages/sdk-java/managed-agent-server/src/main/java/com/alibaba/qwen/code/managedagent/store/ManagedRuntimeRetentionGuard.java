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
                binding.getBindingId(), binding.getGeneration());
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
