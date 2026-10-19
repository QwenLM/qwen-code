package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

final class WorkspaceMigrationAdmission {
    private WorkspaceMigrationAdmission() {
    }

    static void lockTenant(JdbcTemplate jdbc, String tenant) {
        // A zero statement timeout is unlimited, the historical shape.
        lockTenant(jdbc, tenant, 0);
    }

    /** Bounded variant for per-turn admissions: fails instead of out-waiting the caller (#13800). */
    static void lockTenant(JdbcTemplate jdbc, String tenant, int timeoutSeconds) {
        // Fence installation and admission share this lock before any Session lock.
        jdbc.execute((ConnectionCallback<Void>) connection -> {
            JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant, timeoutSeconds);
            return null;
        });
    }

    static String owner(JdbcTemplate jdbc, String tenant, String storage) {
        var rows = jdbc.query("SELECT tenant_id, storage_id, fence_operation_id FROM ma_storage"
                + " WHERE tenant_key = ? AND storage_key = ?"
                + (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive() ? " FOR UPDATE" : ""), (row, index) -> WorkspaceOperations.values(
                        "tenant_id", row.getString("tenant_id"), "storage_id", row.getString("storage_id"),
                        "fence_operation_id", row.getString("fence_operation_id")), JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                JdbcRuntimeBindingRepository.storageFenceKey(storage));
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.getFirst();
        WorkspaceRecoveryStore.check(tenant.equals(row.get("tenant_id")) && storage.equals(row.get("storage_id")),
                "migration_identity_conflict");
        return (String) row.get("fence_operation_id");
    }

    static void requireOpen(JdbcTemplate jdbc, String tenant, String storage) {
        if (storage != null && owner(jdbc, tenant, storage) != null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        requirePhysicalOpen(jdbc, tenant, storage);
    }

    static void requirePhysicalOpen(JdbcTemplate jdbc, String tenant, String storage) {
        if (storage == null) {
            return;
        }
        boolean lock = org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive();
        var aliases = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, storage_id, physical_key, storage_kind FROM ma_storage WHERE alias_key = ?"
                + (lock ? " FOR UPDATE" : ""), JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (aliases.isEmpty()) {
            return;
        }
        var alias = aliases.getFirst();
        if (!tenant.equals(alias.get("tenant_id")) || !storage.equals(alias.get("storage_id"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        if (alias.get("physical_key") == null || "CSI".equals(alias.get("storage_kind"))) {
            return;
        }
        String physical = "SSH_LOCAL".equals(alias.get("storage_kind"))
                ? SshWorkspaceStore.physicalKey(jdbc, tenant, storage) : LocalStorageOwners.key(jdbc, tenant, storage);
        var states = jdbc.queryForList("SELECT mount_state FROM ma_storage_owner WHERE storage_key = ?"
                + (lock ? " FOR UPDATE" : ""), String.class, physical);
        if (states.size() != 1 || !"READY".equals(states.getFirst())) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    static void requireSessionOpen(JdbcTemplate jdbc, String tenant, String session) {
        requireSessionOpen(jdbc, tenant, session, null);
    }

    static void requireSessionOpen(JdbcTemplate jdbc, String tenant, String session, String workspace) {
        requireOpen(jdbc, tenant, sessionStorage(jdbc, tenant, session, workspace));
    }

    static String sessionStorage(JdbcTemplate jdbc, String tenant, String session, String workspace) {
        var sessions = jdbc.query("SELECT tenant_id, session_id, workspace_storage_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?", (row, index) -> new String[] {
                        row.getString("tenant_id"), row.getString("session_id"), row.getString("workspace_storage_id")}, tenant, session);
        if (!sessions.isEmpty()) {
            var saved = sessions.getFirst();
            WorkspaceRecoveryStore.check(tenant.equals(saved[0]) && session.equals(saved[1]), "migration_identity_conflict");
            if (saved[2] != null) {
                return saved[2];
            }
        }
        if (workspace == null) {
            var heads = jdbc.query("SELECT tenant_id, session_id, workspace_id FROM ma_session_head"
                    + " WHERE tenant_key = ? AND harness_key = ? AND head_kind = 'MANAGED_SESSION'",
                    (row, index) -> new String[] {row.getString("tenant_id"), row.getString("session_id"), row.getString("workspace_id")},
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session));
            if (heads.isEmpty()) {
                return null;
            }
            var head = heads.getFirst();
            WorkspaceRecoveryStore.check(tenant.equals(head[0]) && session.equals(head[1]), "migration_identity_conflict");
            workspace = head[2];
        }
        if (workspace == null) {
            return null;
        }
        String expectedWorkspace = workspace;
        var registry = jdbc.query("SELECT tenant_id, workspace_id, storage_id FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                (row, index) -> new String[] {row.getString("tenant_id"), row.getString("workspace_id"), row.getString("storage_id")}, tenant, workspace);
        if (registry.isEmpty()) {
            return null;
        }
        var row = registry.getFirst();
        WorkspaceRecoveryStore.check(tenant.equals(row[0]) && expectedWorkspace.equals(row[1]), "migration_identity_conflict");
        return row[2];
    }
}
