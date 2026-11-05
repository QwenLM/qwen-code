package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
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
        return owner(jdbc, tenant, storage, lockClause(jdbc, false));
    }

    // With a lock clause, locks the storage row through alias_key, which locks
    // the alias record and then the primary record, as Runtime binding
    // creation, execution membership and journal commits do. Locking it
    // through (tenant_key, storage_key) took the primary record first, and
    // requireOpen asked for the alias record afterwards, in
    // requirePhysicalOpen, which deadlocked with them (#16320).
    private static String owner(JdbcTemplate jdbc, String tenant, String storage, String lock) {
        var rows = jdbc.query("SELECT tenant_id, storage_id, fence_operation_id FROM ma_storage"
                + " WHERE alias_key = ?" + lock, (row, index) -> WorkspaceOperations.values(
                        "tenant_id", row.getString("tenant_id"), "storage_id", row.getString("storage_id"),
                        "fence_operation_id", row.getString("fence_operation_id")),
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.getFirst();
        com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.check(tenant.equals(row.get("tenant_id")) && storage.equals(row.get("storage_id")),
                "migration_identity_conflict");
        return (String) row.get("fence_operation_id");
    }

    static void requireOpen(JdbcTemplate jdbc, String tenant, String storage) {
        requireOpen(jdbc, tenant, storage, lockClause(jdbc, false));
    }

    static void requireOpenForRead(JdbcTemplate jdbc, String tenant, String storage) {
        requireOpen(jdbc, tenant, storage, "");
    }

    static void requireOpenForAdmission(JdbcTemplate jdbc, String tenant, String storage) {
        requireOpen(jdbc, tenant, storage, lockClause(jdbc, true));
    }

    private static void requireOpen(JdbcTemplate jdbc, String tenant, String storage, String lock) {
        if (storage != null && owner(jdbc, tenant, storage, lock) != null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        requirePhysicalOpen(jdbc, tenant, storage, lock);
    }

    static void requirePhysicalOpen(JdbcTemplate jdbc, String tenant, String storage) {
        requirePhysicalOpen(jdbc, tenant, storage, lockClause(jdbc, false));
    }

    static void requirePhysicalOpenForAdmission(JdbcTemplate jdbc, String tenant, String storage) {
        requirePhysicalOpen(jdbc, tenant, storage, lockClause(jdbc, true));
    }

    private static void requirePhysicalOpen(JdbcTemplate jdbc, String tenant, String storage, String lock) {
        if (storage == null) {
            return;
        }
        var aliases = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, storage_id, physical_key, storage_kind, registration_state, fence_operation_id FROM ma_storage WHERE alias_key = ?"
                + lock, JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (aliases.isEmpty()) {
            return;
        }
        var alias = aliases.getFirst();
        if (!tenant.equals(alias.get("tenant_id")) || !storage.equals(alias.get("storage_id"))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (alias.get("physical_key") == null || "CSI".equals(alias.get("storage_kind"))) {
            return;
        }
        var owner = "SSH_LOCAL".equals(alias.get("storage_kind"))
                ? SshWorkspaceStore.requireOwner(jdbc, tenant, storage, alias, lock) : LocalStorageOwners.requireOwner(jdbc, alias, lock);
        if (!"READY".equals(owner.get("mount_state"))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    private static String lockClause(JdbcTemplate jdbc, boolean shared) {
        if (!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            return "";
        }
        if (!shared) {
            return " FOR UPDATE";
        }
        // H2 has no shared-lock syntax; MySQL admissions must retain a current read.
        Boolean h2 = jdbc.execute((ConnectionCallback<Boolean>) connection ->
                "H2".equals(connection.getMetaData().getDatabaseProductName()));
        return Boolean.TRUE.equals(h2) ? " FOR UPDATE" : " FOR SHARE";
    }

    static void requireSessionOpen(JdbcTemplate jdbc, String tenant, String session) {
        requireSessionOpen(jdbc, tenant, session, null);
    }

    static void requireSessionOpen(JdbcTemplate jdbc, String tenant, String session, String workspace) {
        requireOpen(jdbc, tenant, sessionStorage(jdbc, tenant, session, workspace));
    }

    /** Read-only admission of a Session's storage: shared on MySQL; never followed by a write to these rows. */
    static void requireSessionOpenForAdmission(JdbcTemplate jdbc, String tenant, String session) {
        requireOpenForAdmission(jdbc, tenant, sessionStorage(jdbc, tenant, session, null));
    }

    static String sessionStorage(JdbcTemplate jdbc, String tenant, String session, String workspace) {
        var sessions = jdbc.query("SELECT tenant_id, session_id, workspace_storage_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?", (row, index) -> new String[] {
                        row.getString("tenant_id"), row.getString("session_id"), row.getString("workspace_storage_id")}, tenant, session);
        if (!sessions.isEmpty()) {
            var saved = sessions.getFirst();
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.check(tenant.equals(saved[0]) && session.equals(saved[1]), "migration_identity_conflict");
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
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.check(tenant.equals(head[0]) && session.equals(head[1]), "migration_identity_conflict");
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
        com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.check(tenant.equals(row[0]) && expectedWorkspace.equals(row[1]), "migration_identity_conflict");
        return row[2];
    }
}
