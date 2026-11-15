package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

import static com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.ERROR_REJECTED;

final class ManagedSessionMessageRoutes {
    private ManagedSessionMessageRoutes() {
    }

    static String[] lineage(JdbcTemplate jdbc, String tenantId, String sessionId) {
        List<String[]> lineage = jdbc.query("SELECT parent_session_id,"
                        + " parent_child_run_id FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> new String[] {
                        result.getString("parent_session_id"),
                        result.getString("parent_child_run_id") },
                tenantId, sessionId);
        return lineage.isEmpty() ? null : lineage.getFirst();
    }

    static void requirePrivateRoute(JdbcTemplate jdbc, String tenantId, String sender, String target) {
        if (target == null) {
            return;
        }
        boolean forbidden = !jdbc.queryForList("SELECT 1 FROM ma_session s WHERE s.tenant_id = ?"
                        + " AND s.session_id = ? AND s.owner_only = 1 AND NOT EXISTS (SELECT 1 FROM ma_session t"
                        + " WHERE t.tenant_id = s.tenant_id AND t.session_id = ? AND t.owner_only = 1"
                        + " AND COALESCE(t.owner_actor_key, t.creator_actor_key) = COALESCE(s.owner_actor_key, s.creator_actor_key))",
                Integer.class, tenantId, sender, target).isEmpty();
        if (forbidden) {
            throw new ManagedAgentException(409, ERROR_REJECTED,
                    "Personal Session context must remain with the same owner's private Sessions.");
        }
    }
}
