package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

final class ManagedLegacySessionGuard {
    private ManagedLegacySessionGuard() { }

    static boolean isPrivate(JdbcTemplate jdbc, String tenantId, String sessionId) {
        // The pin columns are written only with the root, so a consistent
        // read decides a visible root without locking it. A locking probe
        // that found no pinned idx_ma_session_csi_guard entry left a gap
        // lock over later Sessions, including other tenants' first roots
        // (#13996), and locking an ordinary root here would precede the
        // placement guard that lockPublicationWriter takes next.
        if (Boolean.FALSE.equals(pin(jdbc, tenantId, sessionId, false))) {
            return false;
        }
        // A pinned root, or one outside this snapshot, is read current and
        // locked by its primary key. Behind a tenant guard that read can
        // close a cycle with a pinned CSI Session's continuation, so a
        // deadlock victim here is named like the guard side (#13800 R1-1).
        return JdbcManagedSessionStore.namedRootDeadlock(() ->
                Boolean.TRUE.equals(pin(jdbc, tenantId, sessionId, true)));
    }

    /**
     * A current-read variant for a caller that already holds placement and takes
     * the Session root and head next (the projection collector). The consistent
     * fast path in {@link #isPrivate} would fix the caller's REPEATABLE READ view
     * before those locks, hiding a lease committed while the caller waits on the
     * head lock (R2-1). A primary-key locking read decides the pin without fixing
     * the view, keeps root-before-head, and leaves no cross-tenant pin-index gap
     * (#13996).
     */
    static boolean isPrivateCurrentRead(JdbcTemplate jdbc, String tenantId, String sessionId) {
        return JdbcManagedSessionStore.namedRootDeadlock(() ->
                Boolean.TRUE.equals(pin(jdbc, tenantId, sessionId, true)));
    }

    /** The root's pin, or null without a root. */
    private static Boolean pin(JdbcTemplate jdbc, String tenantId, String sessionId, boolean locking) {
        return jdbc.execute((ConnectionCallback<Boolean>) connection -> {
            try (var statement = connection.prepareStatement(
                    "SELECT is_csi_guard FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                            + (locking ? " FOR UPDATE" : ""))) {
                statement.setQueryTimeout(10);
                statement.setBytes(1, ManagedSchemaKeys.identity(tenantId));
                statement.setBytes(2, ManagedSchemaKeys.identity(sessionId));
                try (var rows = statement.executeQuery()) {
                    return rows.next() ? rows.getBoolean(1) : null;
                }
            }
        });
    }

    static void requireLegacyMutation(JdbcTemplate jdbc, String tenantId, String sessionId) {
        requireLegacyMutation(isPrivate(jdbc, tenantId, sessionId));
    }

    static void requireLegacyMutation(boolean privateSession) {
        if (privateSession) {
            throw new ManagedAgentException(409, "csi_managed_mutation_unavailable",
                    "The private CSI Session does not admit legacy Managed Agent mutations.");
        }
    }
}
