package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

final class ManagedLegacySessionGuard {
    private ManagedLegacySessionGuard() { }

    static boolean isPrivate(JdbcTemplate jdbc, String tenantId, String sessionId) {
        return Boolean.TRUE.equals(jdbc.execute((ConnectionCallback<Boolean>) connection -> {
            String product = connection.getMetaData().getDatabaseProductName();
            String index = "MySQL".equals(product) || "MariaDB".equals(product)
                    ? " FORCE INDEX (managed_session_csi_guard_idx)" : "";
            try (var statement = connection.prepareStatement("SELECT csi_guard FROM managed_agent_session" + index
                    + " WHERE tenant_id = ? AND session_id = ? AND csi_guard = TRUE FOR UPDATE")) {
                statement.setQueryTimeout(10);
                statement.setString(1, tenantId);
                statement.setString(2, sessionId);
                try (var rows = statement.executeQuery()) {
                    return rows.next();
                }
            }
        }));
    }

    static void requireLegacyMutation(JdbcTemplate jdbc, String tenantId, String sessionId) {
        if (isPrivate(jdbc, tenantId, sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT, "csi_managed_mutation_unavailable",
                    "The private CSI Session does not admit legacy Managed Agent mutations.");
        }
    }
}
