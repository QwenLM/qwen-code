package com.alibaba.qwen.code.managedagent.persistence;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.springframework.jdbc.core.JdbcTemplate;
final class ManagedConfigStore {
    private ManagedConfigStore() { }
    public static void requireOpen(JdbcTemplate jdbc, String tenantId, String sessionId) {
        if (blocked(jdbc, tenantId, sessionId)) {
            throw new ManagedAgentException(409,
                    "session_config_recovery_required", "The Session configuration operation must be reconciled first.");
        }
    }

    public static boolean blocked(JdbcTemplate jdbc, String tenantId, String sessionId) {
        return !jdbc.queryForList("SELECT record_key FROM ma_session_record WHERE session_scope_key=? AND tenant_id=?"
                + " AND session_id=? AND record_kind='DOMAIN' AND domain='config_install' AND record_id=?"
                + " AND settled_at IS NULL LIMIT 1 FOR UPDATE", com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, ManagedMcpSettings.RECORD_ID).isEmpty();
    }
}
