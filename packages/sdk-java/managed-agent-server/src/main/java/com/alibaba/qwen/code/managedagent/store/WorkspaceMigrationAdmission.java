package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import java.util.List;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

final class WorkspaceMigrationAdmission {
    private WorkspaceMigrationAdmission() {
    }

    static void lockTenant(JdbcTemplate jdbc, String tenant) {
        // Fence installation and admission share this lock before any Session lock.
        jdbc.execute((ConnectionCallback<Void>) connection -> {
            JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant);
            return null;
        });
    }

    static String owner(JdbcTemplate jdbc, String tenant, String storage) {
        var rows = jdbc.queryForList("SELECT tenant_id, storage_id, operation_id FROM qwen_runtime_storage_fence"
                + " WHERE tenant_key = ? AND storage_key = ?", JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                JdbcRuntimeBindingRepository.storageFenceKey(storage));
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.getFirst();
        WorkspaceRecoveryStore.check(tenant.equals(row.get("tenant_id")) && storage.equals(row.get("storage_id")),
                "migration_identity_conflict");
        return (String) row.get("operation_id");
    }

    static void requireOpen(JdbcTemplate jdbc, String tenant, String storage) {
        if (storage != null && owner(jdbc, tenant, storage) != null) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    static void sessionAdmission(JdbcTemplate jdbc, String tenant, String session) {
        lockTenant(jdbc, tenant);
        requireSessionOpen(jdbc, tenant, session);
    }

    static void requireSessionOpen(JdbcTemplate jdbc, String tenant, String session) {
        List<String> storage = jdbc.queryForList("SELECT workspace_storage_id FROM managed_agent_session"
                + " WHERE tenant_id = ? AND session_id = ?", String.class, tenant, session);
        if (!storage.isEmpty()) {
            requireOpen(jdbc, tenant, storage.getFirst());
        }
    }
}
