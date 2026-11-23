package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader.Identity;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.io.IOException;
import java.nio.file.AccessDeniedException;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.Map;

final class LocalStorageOwners {
    static final String SESSION_AUTHORITY_SQL = "SELECT 1 FROM ma_session WHERE tenant_id = ? AND workspace_storage_id = ? AND is_resource_gc_completed = FALSE LIMIT 1";
    static final String RUNTIME_AUTHORITY_SQL = "SELECT 1 FROM ma_runtime_binding WHERE tenant_id = ? AND storage_id = ?"
            + " AND (binding_state NOT IN ('FAILED', 'RELEASED')"
            + " OR (binding_state = 'FAILED' AND is_provision_seeded = TRUE)) LIMIT 1";
    static final String OPERATION_AUTHORITY_SQL = "SELECT 1 FROM ma_operation WHERE tenant_id = ? AND storage_id = ?"
            + " AND ((operation_kind IN ('WORKSPACE_RECOVERY', 'WORKSPACE_OPERATOR_RECOVERY', 'STORAGE_MIGRATION')"
            + " AND state IN ('CAPTURING', 'VERIFYING', 'PREPARED', 'ATTESTED', 'RETIRING', 'RETIRED', 'PREPARING', 'INVALIDATED'))"
            + " OR (operation_kind = 'WORKSPACE_UPLOAD' AND state = 'RUNNING')"
            + " OR (operation_kind = 'CHILD_WORKSPACE' AND state IN ('"
            + String.join("', '", JdbcChildWorkspaceStore.PREPARING, JdbcChildWorkspaceStore.READY, JdbcChildWorkspaceStore.MERGING,
                    JdbcChildWorkspaceStore.APPLYING, JdbcChildWorkspaceStore.APPLIED, JdbcChildWorkspaceStore.DISCARDING,
                    JdbcChildWorkspaceStore.CONFLICTED, JdbcChildWorkspaceStore.BLOCKED, JdbcChildWorkspaceStore.FAILED) + "'))) LIMIT 1";
    static final String HEAD_AUTHORITY_SQL = "SELECT /*! STRAIGHT_JOIN */ 1 FROM ma_session s USE INDEX (idx_ma_session_storage_scope)"
            + " JOIN ma_session_head h ON h.tenant_id = s.tenant_id AND h.harness_session_id = s.session_id"
            + " AND s.is_publication_retention_registered = 1"
            + " JOIN ma_workspace w ON w.tenant_id = s.tenant_id AND w.workspace_id = h.workspace_id"
            + " WHERE s.tenant_id = ? AND s.workspace_storage_id IS NULL AND s.is_resource_gc_completed = FALSE"
            + " AND h.head_kind = 'MANAGED_SESSION' AND w.tenant_id = ? AND w.storage_id = ? LIMIT 1";

    private LocalStorageOwners() {
    }

    static String physicalKey(StorageIdentityReader.Identity identity) {
        return ManagedIdentityRefs.ref(ManagedIdentityRefs.PHYSICAL_REF_BYTES,
                identity.device().matches("[0-9a-f]{32}") ? "local-storage/2" : "local-storage/1",
                identity.hostId(), identity.device(), identity.inode(), identity.birthTime());
    }

    static Identity identity(JdbcTemplate jdbc, StorageIdentityReader identities, Path root) {
        try {
            Identity current = identities.read(root);
            if (current.device().matches("[0-9a-f]{32}")) {
                Identity legacy = identities.readLegacy(root);
                if (current.hostId().equals(legacy.hostId()) && current.inode().equals(legacy.inode())
                        && current.birthTime().equals(legacy.birthTime())
                        && !jdbc.queryForList("SELECT 1 FROM ma_storage_owner WHERE physical_id = ?"
                                + " AND mount_root = ? AND mount_host_id = ? AND mount_device = ?"
                                + " AND mount_inode = ? AND mount_birth_time = ?", Integer.class,
                                physicalKey(legacy), legacy.root(), legacy.hostId(), legacy.device(),
                                legacy.inode(), legacy.birthTime()).isEmpty()) {
                    return legacy;
                }
            }
            return current;
        } catch (IOException | RuntimeException error) {
            throw WorkspaceExecutionStore.unavailable(error);
        }
    }

    static Identity identity(StorageIdentityReader identities, Path root, Identity expected) {
        try {
            return expected.device().matches("[0-9]{1,20}") ? identities.readLegacy(root) : identities.read(root);
        } catch (IOException | RuntimeException error) {
            throw WorkspaceExecutionStore.unavailable(error);
        }
    }

    static void verifyHistory(JdbcTemplate jdbc, ObjectMapper json, StorageIdentityReader identities,
            String tenantId, String storageId, boolean probe) {
        var migrations = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'"
                + " AND tenant_id = ? AND storage_id = ? AND state = 'COMPLETED'"
                + " AND (phase IS NULL OR phase <> 'IDENTITY_REATTESTATION') ORDER BY gmt_modified DESC LIMIT 1",
                (row, index) -> WorkspaceOperations.operation(row), tenantId, storageId);
        if (!migrations.isEmpty()) {
            Identity expected;
            try {
                expected = json.readValue((String) migrations.getFirst().get("history_identity_json"), Identity.class);
            } catch (IOException error) {
                throw WorkspaceExecutionStore.unavailable();
            }
            String home = System.getenv("QWEN_HOME");
            if (home == null || !Path.of(home).isAbsolute()
                    || !Path.of(home).resolve("file-history").toString().equals(expected.root())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            try {
                if (!Path.of(home).toRealPath().equals(Path.of(home))
                        || !expected.equals(expected.device().matches("[0-9]{1,20}")
                                ? identities.readLegacy(Path.of(expected.root())) : identities.read(Path.of(expected.root())))) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            } catch (NoSuchFileException | AccessDeniedException error) {
                throw WorkspaceExecutionStore.unavailable();
            } catch (IOException error) {
                if (probe) {
                    throw WorkspaceExecutionStore.unavailableTransient(error);
                }
                throw WorkspaceExecutionStore.unavailable();
            } catch (RuntimeException error) {
                throw WorkspaceExecutionStore.unavailable();
            }
        }
    }

    static void requireNonOverlapping(JdbcTemplate jdbc, StorageIdentityReader.Identity identity) {
        WorkspaceStorageKindGuard.lockDomain(jdbc, "local-storage-host/" + identity.hostId());
        String key = physicalKey(identity);
        var owners = jdbc.queryForList("SELECT physical_id, mount_root FROM ma_storage_owner"
                + " WHERE mount_host_id = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL') FOR UPDATE", identity.hostId());
        for (var owner : owners) {
            String root = (String) owner.get("mount_root");
            if (!key.equals(owner.get("physical_id")) && root != null
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
        var rows = WorkspaceOperations.rows(jdbc, "SELECT " + ManagedSchemaProjection.STORAGE.columns() + " FROM ma_storage WHERE tenant_id = ? AND storage_id = ?" + lock,
                tenant, storage);
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
        return key(jdbc, tenant, storage, TransactionSynchronizationManager.isActualTransactionActive());
    }

    static String key(JdbcTemplate jdbc, String tenant, String storage, boolean lock) {
        String clause = lock ? " FOR UPDATE" : "";
        var alias = alias(jdbc, tenant, storage, clause);
        requireOwner(jdbc, alias, clause);
        return (String) alias.get("physical_id");
    }

    static Map<String, Object> requireOwner(JdbcTemplate jdbc, Map<String, Object> alias, String lock) {
        if (alias == null || !"LOCAL".equals(alias.get("storage_kind"))
                || !java.util.Set.of("REGISTERED", "RETIRING").contains(alias.get("registration_state"))
                || !(alias.get("physical_id") instanceof String physical)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        var owners = WorkspaceOperations.rows(jdbc, "SELECT physical_id, storage_kind, mount_state FROM ma_storage_owner WHERE physical_id = ?"
                + lock, physical);
        if (owners.size() != 1 || !physical.equals(owners.getFirst().get("physical_id"))
                || !"LOCAL".equals(owners.getFirst().get("storage_kind"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return owners.getFirst();
    }
    static String lockCovered(JdbcTemplate jdbc, String tenant, String storage) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Physical recovery requires a transaction");
        }
        var source = alias(jdbc, tenant, storage, false);
        if (source == null || !(source.get("physical_id") instanceof String physical)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        String[] sourceAlias = {tenant, storage};
        // Lock the aliases through (tenant_id, storage_id), in (tenant_id,
        // storage_id) order, before the scan below reaches their primary
        // records: storage admission locks an alias record before its primary
        // record (WorkspaceMigrationAdmission.owner), and two recoveries of
        // aliases sharing this storage take them in one order. On a pooled
        // DataSource the list comes from a committed read (committedRead)
        // rather than this transaction's snapshot; on the single-connection
        // offline entry it is that transaction's first snapshot instead. An
        // alias registered after that read is locked by the scan alone, which
        // never locks its alias record; a recovery of another alias that
        // already saw it can then deadlock with this one.
        java.util.List<String[]> listed = committedRead(jdbc, current -> current.query(
                "SELECT tenant_id, storage_id FROM ma_storage WHERE physical_id = ? ORDER BY tenant_id, storage_id LIMIT 129",
                (row, index) -> new String[] {row.getString("tenant_id"), row.getString("storage_id")}, physical),
                "Physical recovery alias list is unavailable");
        var known = new java.util.TreeSet<String[]>(
                java.util.Comparator.comparing((String[] alias) -> alias[0]).thenComparing(alias -> alias[1]));
        known.addAll(listed);
        known.add(sourceAlias);
        // A range read of the alias unique index, which yields (tenant_id,
        // storage_id) order. The index is forced so this is never a table scan,
        // and physical_id is read so it is never a scan of the whole alias
        // index either, which a covering read becomes once the list is as long
        // as the estimated row count, locking every gap of the index.
        java.util.List<Object> locks = new java.util.ArrayList<>();
        for (String[] alias : known) {
            locks.add(alias[0]);
            locks.add(alias[1]);
        }
        jdbc.queryForList("SELECT tenant_id, storage_id, physical_id FROM ma_storage /*! FORCE INDEX (uk_ma_storage_business_key) */"
                + " WHERE (tenant_id, storage_id) IN (" + String.join(", ", java.util.Collections.nCopies(known.size(), "(?, ?)"))
                + ") ORDER BY tenant_id, storage_id FOR UPDATE", locks.toArray());
        // Through the physical index: a table scan, which the optimizer picks
        // when one storage holds most rows, would lock other storages' primary
        // records in id order and cross another recovery's alias locks.
        var aliases = jdbc.query("SELECT tenant_id, storage_id, storage_kind FROM ma_storage"
                + " /*! FORCE INDEX (idx_ma_storage_physical) */ WHERE physical_id = ? ORDER BY tenant_id, storage_id LIMIT 129 FOR UPDATE",
                (row, index) -> new String[] {row.getString("tenant_id"), row.getString("storage_id"), row.getString("storage_kind")}, physical);
        if (aliases.size() > 128 || aliases.stream().noneMatch(candidate ->
                sourceAlias[0].equals(candidate[0]) && sourceAlias[1].equals(candidate[1]))) {
            throw new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(409, "storage_alias_inventory_limit",
                    "Physical recovery alias inventory is incomplete or exceeds 128 aliases.", false);
        }
        for (var candidate : aliases) {
            if (!"LOCAL".equals(candidate[2])) {
                throw WorkspaceExecutionStore.unavailable();
            }
        }
        if (!physical.equals(key(jdbc, tenant, storage))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        // The caller may already hold a RR snapshot. Admissions wait on the locked aliases;
        // a committed, nonlocking read (committedRead) sees authorities without reversing binding locks.
        committedRead(jdbc, current -> {
            for (var candidate : aliases) {
                if (sourceAlias[0].equals(candidate[0]) && sourceAlias[1].equals(candidate[1])) {
                    continue;
                }
                if (exists(current, SESSION_AUTHORITY_SQL, candidate[0], candidate[1])
                        || exists(current, RUNTIME_AUTHORITY_SQL, candidate[0], candidate[1])
                        || exists(current, OPERATION_AUTHORITY_SQL, candidate[0], candidate[1])) {
                    throw uncovered();
                }
                if (exists(current, HEAD_AUTHORITY_SQL, candidate[0], candidate[0], candidate[1])) {
                    throw uncovered();
                }
            }
            return null;
        }, "Physical recovery inventory is unavailable");
        return physical;
    }

    /**
     * Runs a nonlocking read on a connection of its own, so it sees what is committed rather than
     * the caller's REPEATABLE READ snapshot. The offline recovery entry (WorkspaceRecoveryMain)
     * runs on one SingleConnectionDataSource, whose every connection is the transaction's own:
     * setting it to autocommit would commit the caller's work, and the read-only flag would then
     * refuse the locking reads that follow. There the read runs on the caller's connection and
     * sees the transaction's first consistent snapshot instead. With the server stopped, only
     * another maintenance entry on a sibling alias can commit beside it, and the later
     * transactions of the recovery recheck its boundary on fresh snapshots.
     */
    private static <T> T committedRead(JdbcTemplate jdbc, java.util.function.Function<JdbcTemplate, T> read, String failure) {
        var source = java.util.Objects.requireNonNull(jdbc.getDataSource());
        if (source instanceof org.springframework.jdbc.datasource.SingleConnectionDataSource) {
            return read.apply(jdbc);
        }
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(true);
            connection.setReadOnly(true);
            return read.apply(new ManagedSchemaJdbcTemplate(new org.springframework.jdbc.datasource.SingleConnectionDataSource(connection, true)));
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException(failure, error);
        }
    }

    private static boolean exists(JdbcTemplate jdbc, String sql, Object... arguments) {
        return !jdbc.queryForList(sql, Integer.class, arguments).isEmpty();
    }

    private static com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException uncovered() {
        return new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(409, "storage_alias_authority_uncovered",
                "Another storage alias retains authority outside this recovery source cut.", false);
    }
}
