package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.Map;

final class LocalStorageOwners {
    static final String SESSION_AUTHORITY_SQL = "SELECT 1 FROM ma_session WHERE tenant_id = ? AND workspace_storage_id = ? AND is_resource_gc_completed = FALSE LIMIT 1";
    static final String RUNTIME_AUTHORITY_SQL = "SELECT 1 FROM ma_runtime_binding WHERE storage_alias_key = ?"
            + " AND (binding_state NOT IN ('FAILED', 'RELEASED')"
            + " OR (binding_state = 'FAILED' AND is_provision_seeded = TRUE)) LIMIT 1";
    static final String OPERATION_AUTHORITY_SQL = "SELECT 1 FROM ma_operation WHERE storage_key = ?"
            + " AND ((operation_kind IN ('WORKSPACE_RECOVERY', 'WORKSPACE_OPERATOR_RECOVERY', 'STORAGE_MIGRATION')"
            + " AND state IN ('CAPTURING', 'VERIFYING', 'PREPARED', 'ATTESTED', 'RETIRING', 'RETIRED', 'PREPARING', 'INVALIDATED'))"
            + " OR (operation_kind = 'WORKSPACE_UPLOAD' AND state = 'RUNNING')"
            + " OR (operation_kind = 'CHILD_WORKSPACE' AND state IN ('"
            + String.join("', '", ChildWorkspaceStore.PREPARING, ChildWorkspaceStore.READY, ChildWorkspaceStore.MERGING,
                    ChildWorkspaceStore.APPLYING, ChildWorkspaceStore.APPLIED, ChildWorkspaceStore.DISCARDING,
                    ChildWorkspaceStore.CONFLICTED, ChildWorkspaceStore.BLOCKED, ChildWorkspaceStore.FAILED) + "'))) LIMIT 1";
    static final String HEAD_AUTHORITY_SQL = "SELECT /*! STRAIGHT_JOIN */ 1 FROM ma_session s USE INDEX (idx_ma_session_storage_scope)"
            + " JOIN ma_session_head h ON h.tenant_key = s.tenant_key AND h.harness_key = s.session_key"
            + " JOIN ma_workspace w ON w.tenant_id = s.tenant_id AND w.workspace_id = h.workspace_id"
            + " WHERE s.tenant_id = ? AND s.workspace_storage_id IS NULL AND s.is_resource_gc_completed = FALSE"
            + " AND h.tenant_key = ? AND h.head_kind = 'MANAGED_SESSION' AND w.tenant_id = ? AND w.storage_id = ? LIMIT 1";

    private LocalStorageOwners() {
    }

    static String physicalKey(StorageIdentityReader.Identity identity) {
        return ManagedSchemaKeys.key("local-storage/1", identity.hostId(), identity.device(), identity.inode(), identity.birthTime());
    }

    static void requireNonOverlapping(JdbcTemplate jdbc, StorageIdentityReader.Identity identity) {
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
        return alias(jdbc, tenant, storage, lock ? " FOR UPDATE" : "");
    }

    private static Map<String, Object> alias(JdbcTemplate jdbc, String tenant, String storage, String lock) {
        var rows = WorkspaceOperations.rows(jdbc, "SELECT " + ManagedSchemaProjection.STORAGE.columns() + " FROM ma_storage WHERE alias_key = ?" + lock,
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.getFirst();
        if (!tenant.equals(row.get("tenant_id")) || !storage.equals(row.get("storage_id"))
                || !java.util.Set.of("LOCAL", "UNREGISTERED").contains(row.get("storage_kind"))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        return row;
    }

    static String key(JdbcTemplate jdbc, String tenant, String storage) {
        return key(jdbc, tenant, storage, TransactionSynchronizationManager.isActualTransactionActive());
    }

    static String key(JdbcTemplate jdbc, String tenant, String storage, boolean lock) {
        String clause = lock ? " FOR UPDATE" : "";
        var alias = alias(jdbc, tenant, storage, clause);
        requireOwner(jdbc, alias, clause);
        return (String) alias.get("physical_key");
    }

    static Map<String, Object> requireOwner(JdbcTemplate jdbc, Map<String, Object> alias, String lock) {
        if (alias == null || !"LOCAL".equals(alias.get("storage_kind"))
                || !java.util.Set.of("REGISTERED", "RETIRING").contains(alias.get("registration_state"))
                || !(alias.get("physical_key") instanceof String physical)) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        var owners = WorkspaceOperations.rows(jdbc, "SELECT storage_key, physical_key, storage_kind, mount_state FROM ma_storage_owner WHERE storage_key = ?"
                + lock, physical);
        if (owners.size() != 1 || !physical.equals(owners.getFirst().get("physical_key"))
                || !"LOCAL".equals(owners.getFirst().get("storage_kind"))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        return owners.getFirst();
    }
    static String lockCovered(JdbcTemplate jdbc, String tenant, String storage) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Physical recovery requires a transaction");
        }
        var source = alias(jdbc, tenant, storage, false);
        if (source == null || !(source.get("physical_key") instanceof String physical)) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        String sourceAlias = JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage);
        // Lock the aliases through alias_key, in alias_key order, before the
        // scan below reaches their primary records: storage admission locks an
        // alias record before its primary record (WorkspaceMigrationAdmission
        // .owner), and two recoveries of aliases sharing this storage take
        // them in one order. The list comes from a fresh read rather than this
        // transaction's snapshot. An alias registered after that read is
        // locked by the scan alone, which never locks its alias record; a
        // recovery of another alias that already saw it can then deadlock with
        // this one.
        var known = new java.util.TreeSet<String>();
        try (var connection = java.util.Objects.requireNonNull(jdbc.getDataSource()).getConnection()) {
            connection.setAutoCommit(true);
            connection.setReadOnly(true);
            known.addAll(new ManagedSchemaJdbcTemplate(new org.springframework.jdbc.datasource.SingleConnectionDataSource(connection, true))
                    .queryForList("SELECT alias_key FROM ma_storage WHERE physical_key = ? ORDER BY alias_key LIMIT 129",
                            String.class, physical));
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException("Physical recovery alias list is unavailable", error);
        }
        known.add(sourceAlias);
        // A range read of the alias index, which yields alias_key order. The
        // index is forced so this is never a table scan, and physical_key is
        // read so it is never a scan of the whole alias index either, which a
        // covering read becomes once the list is as long as the estimated row
        // count, locking every gap of the index.
        jdbc.queryForList("SELECT alias_key, physical_key FROM ma_storage /*! FORCE INDEX (uk_ma_storage_business_key) */"
                + " WHERE alias_key IN (" + String.join(", ", java.util.Collections.nCopies(known.size(), "?"))
                + ") ORDER BY alias_key FOR UPDATE", known.toArray());
        // Through the physical index: a table scan, which the optimizer picks
        // when one storage holds most rows, would lock other storages' primary
        // records in id order and cross another recovery's alias locks.
        var aliases = jdbc.query("SELECT alias_key, tenant_id, storage_id, storage_kind FROM ma_storage"
                + " /*! FORCE INDEX (idx_ma_storage_physical) */ WHERE physical_key = ? ORDER BY alias_key LIMIT 129 FOR UPDATE",
                (row, index) -> new String[] {row.getString("alias_key"), row.getString("tenant_id"), row.getString("storage_id"), row.getString("storage_kind")}, physical);
        if (aliases.size() > 128 || aliases.stream().noneMatch(candidate -> sourceAlias.equals(candidate[0]))) {
            throw new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(409, "storage_alias_inventory_limit",
                    "Physical recovery alias inventory is incomplete or exceeds 128 aliases.", false);
        }
        for (var candidate : aliases) {
            if (!candidate[0].equals(JdbcRuntimeBindingRepository.storageAliasKey(candidate[1], candidate[2]))
                    || !"LOCAL".equals(candidate[3])) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
        }
        if (!physical.equals(key(jdbc, tenant, storage))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
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
