package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Reclaims released public projection bodies, including those of still-live Sessions. */
final class ManagedProjectionResourceCollector {
    private static final int BATCH = 32;
    private static final String KINDS =
            "X'6d616e616765642d6d6573736167652d7061727473',"
                    + "X'6d616e616765642d736e617073686f742d70616765',"
                    + "X'6d616e616765642d736e617073686f742d6d616e6966657374'";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    ManagedProjectionResourceCollector(JdbcTemplate jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        transactions = new TransactionTemplate(manager);
        transactions.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
    }

    static void release(JdbcTemplate jdbc, String scope, String kind, String owner) {
        // A builder can still hold this body's old RR view before publishing its snapshot ref.
        // Mark a candidate here; the collector must wait for that builder's read lease.
        jdbc.update(
                "UPDATE ma_resource SET retention_until = " + ManagedSchemaTime.SQL_NOW + " WHERE session_scope_key = ? AND kind IN ("
                        + KINDS
                        + ") AND state = 'REFERENCED' AND publication_id IS NULL AND resource_key"
                        + " IN (SELECT f.resource_key FROM ma_resource_ref f WHERE"
                        + " f.session_scope_key = ? AND f.owner_kind = ? AND f.owner_key = ?)",
                scope,
                scope,
                kind,
                owner);
    }

    static void removeSnapshot(JdbcTemplate jdbc, String tenant, String session, String id,
            long version) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String owner = ManagedSchemaKeys.key(scope, id);
        release(jdbc, scope, "SNAPSHOT", owner);
        jdbc.update(
                "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                        + " 'SNAPSHOT' AND owner_key = ? AND owner_revision = ?",
                scope, owner, version);
        jdbc.update(
                "DELETE FROM ma_snapshot WHERE tenant_id = ? AND session_id = ? AND snapshot_id ="
                        + " ?",
                tenant, session, id);
    }

    boolean runOnce() {
        boolean changed = expireSnapshots();
        var candidates = jdbc.queryForList(
                        "SELECT resource_key, tenant_id, session_id FROM ma_resource WHERE retention_until <= " + ManagedSchemaTime.SQL_NOW + " AND NOT EXISTS (SELECT 1 FROM ma_session s WHERE s.tenant_id = ma_resource.tenant_id AND s.session_id = ma_resource.session_id AND s.csi_guard = TRUE) ORDER BY retention_until, resource_key LIMIT "
                                + BATCH);
        for (var candidate : candidates) {
            changed |= Boolean.TRUE.equals(transactions.execute(status -> collect(
                    (String) candidate.get("tenant_id"), (String) candidate.get("session_id"),
                    (String) candidate.get("resource_key"))));
        }
        return changed;
    }

    private boolean expireSnapshots() {
        long now = ToolPublicationRetentionStore.now(jdbc);
        var candidates = jdbc.queryForList(
                        "SELECT tenant_id, session_id, snapshot_id FROM ma_snapshot WHERE state ="
                            + " 'PUBLISHED' AND retain_until <= ? AND NOT EXISTS (SELECT 1 FROM"
                            + " ma_session s WHERE s.tenant_id = ma_snapshot.tenant_id AND"
                            + " s.session_id = ma_snapshot.session_id AND s.csi_guard = TRUE) ORDER"
                            + " BY retain_until LIMIT "
                                + BATCH, now);
        boolean changed = false;
        for (var candidate : candidates) {
            changed |=
                    Boolean.TRUE.equals(
                            transactions.execute(
                                    status -> {
                                        String tenant = (String) candidate.get("tenant_id");
                                        String session = (String) candidate.get("session_id");
                                        String id = (String) candidate.get("snapshot_id");
                                        ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
                                        if (ManagedLegacySessionGuard.isPrivate(
                                                jdbc, tenant, session)) {
                                            return false;
                                        }
                                        ToolPublicationRetentionStore.lockSession(
                                                jdbc, tenant, session);
                                        var streams =
                                                jdbc.queryForList(
                                                        "SELECT current_snapshot_id FROM"
                                                            + " ma_event_stream WHERE tenant_id = ?"
                                                            + " AND session_id = ? AND stream_kind"
                                                            + " = 'SESSION' AND stream_id = X'' FOR"
                                                            + " UPDATE",
                                                        tenant,
                                                        session);
                                        var roots =
                                                jdbc.queryForList(
                                                        "SELECT snapshot_version, retain_until FROM"
                                                            + " ma_snapshot WHERE tenant_id = ? AND"
                                                            + " session_id = ? AND snapshot_id = ?"
                                                            + " AND state = 'PUBLISHED' FOR UPDATE",
                                                        tenant,
                                                        session,
                                                        id);
                                        long time = ToolPublicationRetentionStore.now(jdbc);
                                        if (roots.isEmpty()
                                                || ToolPublicationRetentionStore.number(
                                                                roots.getFirst(), "retain_until")
                                                        > time) {
                                            return false;
                                        }
                                        if (!streams.isEmpty()
                                                && id.equals(
                                                        streams.getFirst()
                                                                .get("current_snapshot_id"))) {
                                            jdbc.update(
                                                    "UPDATE ma_snapshot SET retain_until = ? WHERE"
                                                        + " tenant_id = ? AND session_id = ? AND"
                                                        + " snapshot_id = ?",
                                                    time
                                                            + ManagedSnapshotStore
                                                                    .CURSOR_LIFETIME_MILLIS,
                                                    tenant,
                                                    session,
                                                    id);
                                            return false;
                                        }
                                        removeSnapshot(
                                                jdbc,
                                                tenant,
                                                session,
                                                id,
                                                ToolPublicationRetentionStore.number(
                                                        roots.getFirst(), "snapshot_version"));
                                        return true;
                                    }));
        }
        return changed;
    }

    private boolean collect(String tenant, String session, String key) {
        ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
        if (ManagedLegacySessionGuard.isPrivate(jdbc, tenant, session)) {
            return false;
        }
        ToolPublicationRetentionStore.lockSessionHead(jdbc, tenant, session);
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        var rows =
                jdbc.queryForList(
                        "SELECT resource_key FROM ma_resource WHERE resource_key = ? AND"
                            + " session_scope_key = ? AND tenant_id = ? AND session_id = ? AND kind"
                            + " IN ("
                                + KINDS
                                + ") AND retention_until <= " + ManagedSchemaTime.SQL_NOW + " AND state = 'REFERENCED' AND storage_kind = 'MYSQL_INLINE' AND publication_id IS NULL AND object_key IS NULL AND object_version_id IS NULL AND encryption_key_id IS NULL AND deletion_operation_key IS NULL FOR UPDATE",
                        key,
                        scope,
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
                                "SELECT tenant_id FROM ma_session_head WHERE tenant_key = ? AND"
                                    + " harness_key = ? AND tenant_id = ? AND session_id = ? AND"
                                    + " head_kind = 'MANAGED_SESSION' AND recovery_status <>"
                                    + " 'READY'",
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session), tenant, session).isEmpty();
        protectedBody |= !jdbc.queryForList(
                                "SELECT session_id FROM ma_session WHERE tenant_id = ? AND"
                                        + " session_id = ? AND recovery_protected = TRUE",
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
