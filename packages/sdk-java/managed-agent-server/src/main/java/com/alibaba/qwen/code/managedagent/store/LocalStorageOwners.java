package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.Map;

final class LocalStorageOwners {
    static final String SESSION_AUTHORITY_SQL = "SELECT 1 FROM ma_session WHERE tenant_id = ? AND workspace_storage_id = ? AND resource_gc_completed = FALSE LIMIT 1";
    static final String RUNTIME_AUTHORITY_SQL = "SELECT 1 FROM ma_runtime_binding WHERE storage_alias_key = ?"
            + " AND (binding_state NOT IN ('FAILED', 'RELEASED')"
            + " OR (binding_state = 'FAILED' AND provision_seeded = TRUE)) LIMIT 1";
    static final String OPERATION_AUTHORITY_SQL = "SELECT 1 FROM ma_operation WHERE storage_key = ?"
            + " AND ((operation_kind IN ('WORKSPACE_RECOVERY', 'WORKSPACE_OPERATOR_RECOVERY', 'STORAGE_MIGRATION')"
            + " AND state IN ('CAPTURING', 'VERIFYING', 'PREPARED', 'ATTESTED', 'RETIRING', 'RETIRED', 'PREPARING', 'INVALIDATED'))"
            + " OR (operation_kind = 'CHILD_WORKSPACE' AND state IN ('"
            + String.join("', '", ChildWorkspaceStore.PREPARING, ChildWorkspaceStore.READY, ChildWorkspaceStore.MERGING,
                    ChildWorkspaceStore.APPLYING, ChildWorkspaceStore.APPLIED, ChildWorkspaceStore.DISCARDING,
                    ChildWorkspaceStore.CONFLICTED, ChildWorkspaceStore.BLOCKED, ChildWorkspaceStore.FAILED) + "'))) LIMIT 1";
    static final String HEAD_AUTHORITY_SQL = "SELECT /*! STRAIGHT_JOIN */ 1 FROM ma_session s USE INDEX (ix_ma_session_storage_scope)"
            + " JOIN ma_session_head h ON h.tenant_key = s.tenant_key AND h.harness_key = s.session_key"
            + " JOIN ma_workspace w ON w.tenant_id = s.tenant_id AND w.workspace_id = h.workspace_id"
            + " WHERE s.tenant_id = ? AND s.workspace_storage_id IS NULL AND s.resource_gc_completed = FALSE"
            + " AND h.tenant_key = ? AND h.head_kind = 'MANAGED_SESSION' AND w.tenant_id = ? AND w.storage_id = ? LIMIT 1";

    private LocalStorageOwners() {
    }

    static String physicalKey(WorkspaceStorageGuard.Identity identity) {
        return ManagedSchemaKeys.key("local-storage/1", identity.hostId(), identity.device(), identity.inode(), identity.birthTime());
    }

    static void requireNonOverlapping(JdbcTemplate jdbc, WorkspaceStorageGuard.Identity identity) {
        WorkspaceStorageKindGuard.lockDomain(jdbc, "local-storage-host/" + identity.hostId());
        String key = physicalKey(identity);
        var owners = jdbc.queryForList("SELECT storage_key, mount_root FROM ma_storage_owner"
                + " WHERE mount_host_id = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL') FOR UPDATE", identity.hostId());
        for (var owner : owners) {
            String root = (String) owner.get("mount_root");
            if (!key.equals(owner.get("storage_key")) && root != null
                    && (contains(root, identity.root()) || contains(identity.root(), root))) {
                throw new RuntimeBrokerException(409, "storage_overlapping_roots",
                        "Workspace directory overlaps an existing physical owner.", false);
            }
        }
    }

    private static boolean contains(String root, String candidate) {
        return root.equals(candidate) || candidate.startsWith(root.endsWith("/") ? root : root + "/");
    }

    static Map<String, Object> alias(JdbcTemplate jdbc, String tenant, String storage, boolean lock) {
        var rows = WorkspaceOperations.rows(jdbc, "SELECT " + ManagedSchemaProjection.STORAGE.columns() + " FROM ma_storage WHERE alias_key = ?" + (lock ? " FOR UPDATE" : ""),
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.getFirst();
        if (!tenant.equals(row.get("tenant_id")) || !storage.equals(row.get("storage_id"))
                || !java.util.Set.of("LOCAL", "UNREGISTERED").contains(row.get("storage_kind"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return row;
    }

    static String key(JdbcTemplate jdbc, String tenant, String storage) {
        boolean lock = TransactionSynchronizationManager.isActualTransactionActive();
        var alias = alias(jdbc, tenant, storage, lock);
        if (alias == null || !"LOCAL".equals(alias.get("storage_kind"))
                || !java.util.Set.of("REGISTERED", "RETIRING").contains(alias.get("registration_state"))
                || !(alias.get("physical_key") instanceof String physical)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        var owners = WorkspaceOperations.rows(jdbc, "SELECT storage_key, physical_key, storage_kind FROM ma_storage_owner WHERE storage_key = ?"
                + (lock ? " FOR UPDATE" : ""), physical);
        if (owners.size() != 1 || !physical.equals(owners.getFirst().get("physical_key"))
                || !"LOCAL".equals(owners.getFirst().get("storage_kind"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return physical;
    }
    static String lockCovered(JdbcTemplate jdbc, String tenant, String storage) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Physical recovery requires a transaction");
        }
        var source = alias(jdbc, tenant, storage, false);
        if (source == null || !(source.get("physical_key") instanceof String physical)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        var aliases = jdbc.query("SELECT alias_key, tenant_id, storage_id, storage_kind FROM ma_storage WHERE physical_key = ? ORDER BY alias_key LIMIT 129 FOR UPDATE",
                (row, index) -> new String[] {row.getString("alias_key"), row.getString("tenant_id"), row.getString("storage_id"), row.getString("storage_kind")}, physical);
        String sourceAlias = JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage);
        if (aliases.size() > 128 || aliases.stream().noneMatch(candidate -> sourceAlias.equals(candidate[0]))) {
            throw new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(409, "storage_alias_inventory_limit",
                    "Physical recovery alias inventory is incomplete or exceeds 128 aliases.", false);
        }
        for (var candidate : aliases) {
            if (!candidate[0].equals(JdbcRuntimeBindingRepository.storageAliasKey(candidate[1], candidate[2]))
                    || !"LOCAL".equals(candidate[3])) {
                throw WorkspaceExecutionStore.unavailable();
            }
        }
        if (!physical.equals(key(jdbc, tenant, storage))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        // The caller may already hold a RR snapshot. Admissions wait on the locked aliases;
        // an independent, nonlocking read sees committed authorities without reversing binding locks.
        try (var connection = java.util.Objects.requireNonNull(jdbc.getDataSource()).getConnection()) {
            connection.setAutoCommit(true);
            connection.setReadOnly(true);
            var current = new ManagedSchemaJdbcTemplate(new org.springframework.jdbc.datasource.SingleConnectionDataSource(connection, true));
            for (var candidate : aliases) {
                if (sourceAlias.equals(candidate[0])) {
                    continue;
                }
                if (exists(current, SESSION_AUTHORITY_SQL, candidate[1], candidate[2])
                        || exists(current, RUNTIME_AUTHORITY_SQL, candidate[0])
                        || exists(current, OPERATION_AUTHORITY_SQL, candidate[0])) {
                    throw uncovered();
                }
                if (exists(current, HEAD_AUTHORITY_SQL, candidate[1], JdbcRuntimeBindingRepository.harnessDrainKey(candidate[1]),
                        candidate[1], candidate[2])) {
                    throw uncovered();
                }
            }
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException("Physical recovery inventory is unavailable", error);
        }
        return physical;
    }

    private static boolean exists(JdbcTemplate jdbc, String sql, Object... arguments) {
        return !jdbc.queryForList(sql, Integer.class, arguments).isEmpty();
    }

    private static com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException uncovered() {
        return new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(409, "storage_alias_authority_uncovered",
                "Another storage alias retains authority outside this recovery source cut.", false);
    }
}
