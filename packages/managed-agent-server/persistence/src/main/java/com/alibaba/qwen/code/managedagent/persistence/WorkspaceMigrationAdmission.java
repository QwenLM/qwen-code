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
        com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.check(tenant.equals(row.get("tenant_id")) && storage.equals(row.get("storage_id")),
                "migration_identity_conflict");
        return (String) row.get("fence_operation_id");
    }

    static void requireOpen(JdbcTemplate jdbc, String tenant, String storage) {
        if (storage != null && owner(jdbc, tenant, storage) != null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
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
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if ("EXTERNAL".equals(alias.get("storage_kind"))) {
            requireExternalPhysicalOpen(jdbc, tenant, storage, lock);
            return;
        }
        if (alias.get("physical_key") == null || "CSI".equals(alias.get("storage_kind"))) {
            return;
        }
        String physical = "SSH_LOCAL".equals(alias.get("storage_kind"))
                ? SshWorkspaceStore.physicalKey(jdbc, tenant, storage) : LocalStorageOwners.key(jdbc, tenant, storage);
        var states = jdbc.queryForList("SELECT mount_state FROM ma_storage_owner WHERE storage_key = ?"
                + (lock ? " FOR UPDATE" : ""), String.class, physical);
        if (states.size() != 1 || !"READY".equals(states.getFirst())) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    private static void requireExternalPhysicalOpen(JdbcTemplate jdbc, String tenant, String storage, boolean lock) {
        var registrations = jdbc.query("SELECT registration_json, registration_revision, physical_key FROM ma_storage"
                + " WHERE alias_key = ? AND storage_kind = 'EXTERNAL' AND registration_state = 'REGISTERED'"
                + (lock ? " FOR UPDATE" : ""), (row, index) -> {
                    var registered = com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry
                            .decodeRegistration(row.getString("registration_json"));
                    if (!storage.equals(registered.tenantWorkspaceId()) || !registered.ownerKey().equals(row.getString("physical_key"))
                            || registered.registrationRevision() != row.getLong("registration_revision")) {
                        throw WorkspaceExecutionStore.unavailable();
                    }
                    return registered;
                }, JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (registrations.size() != 1) {
            throw WorkspaceExecutionStore.unavailable();
        }
        var registered = registrations.getFirst();
        var owners = jdbc.query("SELECT * FROM ma_storage_owner WHERE storage_key = ?" + (lock ? " FOR UPDATE" : ""),
                (row, index) -> registered.ownerKey().equals(row.getString("physical_key"))
                        && "EXTERNAL".equals(row.getString("storage_kind"))
                        && tenant.equals(row.getString("tenant_id")) && storage.equals(row.getString("storage_id"))
                        && registered.mountRoot().equals(row.getString("mount_root"))
                        && registered.registrationRevision() == row.getLong("mount_revision")
                        && "UNVERIFIED".equals(row.getString("mount_state"))
                        && row.getObject("maintenance_id") == null && row.getObject("maintenance_generation") == null
                        && "RELEASED".equals(row.getString("csi_phase")) && row.getLong("csi_revision") == 0
                        && row.getObject("csi_reservation_id") == null && row.getObject("csi_registration_key") == null
                        && row.getObject("csi_registration_revision") == null && row.getObject("csi_provision_request_id") == null,
                registered.ownerKey());
        if (owners.size() != 1 || !owners.getFirst()) {
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
