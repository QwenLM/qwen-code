package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

final class ManagedLegacySessionGuard {
    private ManagedLegacySessionGuard() { }

    static boolean isPrivate(JdbcTemplate jdbc, String tenantId, String sessionId) {
        // A locking read of the root: behind a tenant guard it can close a
        // cycle with a pinned CSI Session's continuation, so a deadlock
        // victim here is named like the guard side (#13800 R1-1).
        return ManagedSessionStore.namedRootDeadlock(() -> Boolean.TRUE.equals(
                jdbc.execute(
                        (ConnectionCallback<Boolean>)
                                connection -> {
                                    String product =
                                            connection.getMetaData().getDatabaseProductName();
                                    String index =
                                            "MySQL".equals(product) || "MariaDB".equals(product)
                                                    ? " FORCE INDEX (ma_session_csi_guard_idx)"
                                                    : "";
                                    try (var statement =
                                            connection.prepareStatement(
                                                    "SELECT csi_guard FROM ma_session"
                                                            + index
                                                            + " WHERE tenant_id = ? AND session_id"
                                                            + " = ? AND csi_guard = TRUE FOR"
                                                            + " UPDATE")) {
                                        statement.setQueryTimeout(10);
                                        statement.setBytes(
                                                1,
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaKeys.identity(tenantId));
                                        statement.setBytes(
                                                2,
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaKeys.identity(sessionId));
                                        try (var rows = statement.executeQuery()) {
                                            return rows.next();
                                        }
                                    }
                                })));
    }

    static void requireLegacyMutation(JdbcTemplate jdbc, String tenantId, String sessionId) {
        requireLegacyMutation(isPrivate(jdbc, tenantId, sessionId));
    }

    static void requireLegacyMutation(boolean privateSession) {
        if (privateSession) {
            throw new ApiException(HttpStatus.CONFLICT, "csi_managed_mutation_unavailable",
                    "The private CSI Session does not admit legacy Managed Agent mutations.");
        }
    }
}
