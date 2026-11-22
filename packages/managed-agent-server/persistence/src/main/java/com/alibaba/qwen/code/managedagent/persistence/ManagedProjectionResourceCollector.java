package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Reclaims released public projection bodies, including those of still-live Sessions. */
final class ManagedProjectionResourceCollector {
    private static final int BATCH = 32;
    private static final String KINDS = "X'6d616e616765642d6d6573736167652d7061727473',"
            + "X'6d616e616765642d736964652d71756572792d696e707574',"
            + "X'6d616e616765642d736964652d71756572792d6368756e6b'";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    ManagedProjectionResourceCollector(JdbcTemplate jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        transactions = new TransactionTemplate(manager);
        transactions.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
    }

    static void release(JdbcTemplate jdbc, String tenant, String session, String kind, String owner) {
        // Readers can still hold this body's old read view; collection waits for their leases.
        jdbc.update(
                "UPDATE ma_resource SET retention_until = " + ManagedSchemaTime.SQL_NOW + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND kind IN ("
                        + KINDS
                        + ") AND state = 'REFERENCED' AND publication_id IS NULL AND resource_key"
                        + " IN (SELECT f.resource_key FROM ma_resource_ref f WHERE"
                        + " f.tenant_id = ? AND f.session_id = ? AND f.owner_kind = ? AND f.owner_key = ?)",
                tenant,
                session,
                tenant,
                session,
                kind,
                owner);
    }

    boolean runOnce() {
        boolean changed = false;
        var candidates = jdbc.queryForList(
                        "SELECT resource_key, tenant_id, session_id FROM ma_resource WHERE retention_until <= " + ManagedSchemaTime.SQL_NOW + " ORDER BY retention_until, resource_key LIMIT "
                                + BATCH);
        for (var candidate : candidates) {
            changed |= Boolean.TRUE.equals(JdbcManagedSessionStore.skipContended(transactions,
                    status -> collect((String) candidate.get("tenant_id"),
                            (String) candidate.get("session_id"),
                            (String) candidate.get("resource_key"))));
        }
        return changed;
    }

    private boolean collect(String tenant, String session, String key) {
        JdbcManagedSessionStore.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(
                jdbc, tenant, JdbcManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        ToolPublicationRetentionStore.lockSessionHead(jdbc, tenant, session);
        var rows =
                jdbc.queryForList(
                        "SELECT resource_key FROM ma_resource WHERE resource_key = ? AND"
                            + " tenant_id = ? AND session_id = ? AND kind"
                            + " IN ("
                                + KINDS
                                + ") AND retention_until <= " + ManagedSchemaTime.SQL_NOW + " AND state = 'REFERENCED' AND storage_kind = 'MYSQL_INLINE' AND publication_id IS NULL AND object_key IS NULL AND object_version_id IS NULL AND encryption_key_id IS NULL AND deletion_operation_key IS NULL FOR UPDATE",
                        key,
                        tenant,
                        session);
        if (rows.isEmpty()) {
            return false;
        }
        var refs = jdbc.queryForList(
                        "SELECT resource_key FROM ma_resource_ref WHERE resource_key = ? LIMIT 1"
                                + " FOR UPDATE", key);
        if (!refs.isEmpty()) {
            // Whichever owner still references it will mark it again when that reference is
            // released.
            jdbc.update(
                    "UPDATE ma_resource SET retention_until = NULL WHERE resource_key = ?", key);
            return false;
        }
        long now = ToolPublicationRetentionStore.now(jdbc);
        boolean protectedBody = !jdbc.queryForList(
                                "SELECT tenant_id FROM ma_session_head WHERE tenant_id = ? AND"
                                    + " harness_session_id = ? AND session_id = ? AND"
                                    + " head_kind = 'MANAGED_SESSION' AND recovery_status <>"
                                    + " 'READY'",
                tenant, session, session).isEmpty();
        protectedBody |= !jdbc.queryForList(
                                "SELECT session_id FROM ma_session WHERE tenant_id = ? AND"
                                        + " session_id = ? AND is_recovery_protected = TRUE",
                tenant, session).isEmpty();
        protectedBody |= !jdbc.queryForList(
                                "SELECT lease_id FROM ma_read_lease WHERE tenant_key = ? AND"
                                        + " session_key = ? AND expires_at > ? LIMIT 1",
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session), now).isEmpty();
        protectedBody |=
                !jdbc.queryForList(
                                "SELECT w.operation_key FROM ma_operation_work w JOIN ma_operation"
                                    + " o ON o.operation_key = w.operation_key WHERE w.tenant_id ="
                                    + " ? AND w.session_id = ? AND w.work_kind = 'SESSION' AND"
                                    + " o.operation_kind = 'WORKSPACE_RECOVERY' AND o.state IN"
                                    + " ('CAPTURING', 'VERIFYING') LIMIT 1 FOR UPDATE",
                                tenant,
                                session)
                        .isEmpty();
        if (protectedBody) {
            jdbc.update(
                    "UPDATE ma_resource SET retention_until = (" + ManagedSchemaTime.SQL_NOW + " + 60000) WHERE resource_key = ?", key);
            return false;
        }
        // SQL inline deletion and its non-referenceable tombstone commit atomically; no external
        // I/O.
        return jdbc.update(
                        "UPDATE ma_resource SET inline_bytes = NULL, state = 'COLLECTED',"
                                + " retention_until = NULL WHERE resource_key = ?", key) == 1;
    }
}
