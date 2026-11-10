package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.lang.Nullable;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Map;

/** Reconciles the original PUT and records deletion intent before touching the provider. */
@Repository
public class SessionObjectMaintenance {
    private static final Logger LOG = LoggerFactory.getLogger(SessionObjectMaintenance.class);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ImmutableObjectStore objects;
    private final ManagedAgentSettings settings;
    private String collectionCursor = "";

    public SessionObjectMaintenance(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            @Nullable ImmutableObjectStore objects, ManagedAgentSettings settings) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.objects = objects;
        this.settings = settings;
    }

    @Scheduled(fixedDelay = 10000)
    public void tick() {
        try {
            runOnce();
        } catch (RuntimeException failure) {
            LOG.warn("Session object maintenance will retry", failure);
        }
    }

    public synchronized boolean runOnce() {
        if (objects == null) {
            return false;
        }
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        boolean changed = false;
        var pending = jdbc.queryForList("SELECT r.resource_key, o.operation_key FROM ma_resource r JOIN ma_operation o"
                + " ON o.target_key = r.resource_key AND o.operation_id = r.publish_command_id AND o.operation_kind = 'OBJECT_PUT'"
                + " WHERE r.storage_kind = 'OBJECT_STORE' AND r.capture_state IS NULL AND o.phase IN ('SESSION_RESOURCE','JOURNAL_PACK')"
                + " AND o.state IN ('IN_FLIGHT','UNKNOWN') AND o.available_at <= ? ORDER BY o.available_at, o.operation_key LIMIT 8",
                ToolPublicationRetentionStore.now(jdbc));
        for (var attempt : pending) {
            changed |= reconcile((String) attempt.get("resource_key"), (String) attempt.get("operation_key"));
        }
        if (settings.getObjectStore().isGcEnabled()) {
            var candidates = jdbc.queryForList("SELECT resource_key FROM ma_resource WHERE storage_kind = 'OBJECT_STORE'"
                    + " AND capture_state IS NULL AND state <> 'COLLECTED' AND gmt_create <= ? AND resource_key > ?"
                    + " AND NOT EXISTS (SELECT 1 FROM ma_resource_ref f WHERE f.resource_key = ma_resource.resource_key)"
                    + " ORDER BY resource_key LIMIT 16", String.class,
                    ToolPublicationRetentionStore.now(jdbc) - settings.getObjectStore().getDeletionGrace().toMillis(), collectionCursor);
            for (String key : candidates) {
                collectionCursor = key;
                try {
                    changed |= collect(key);
                } catch (RuntimeException failure) {
                    LOG.warn("Session object collection will retry resource={}", key);
                }
            }
            if (candidates.size() < 16) {
                collectionCursor = "";
            }
        }
        return changed;
    }

    private boolean reconcile(String key, String operation) {
        var row = resource(key);
        Runnable guard = () -> {
            requireIdentity(row);
            var current = resource(key);
            if (!sameLocator(row, current) || current.get("deletion_operation_key") != null
                    || jdbc.queryForList("SELECT 1 FROM ma_operation WHERE operation_key = ? AND state IN ('IN_FLIGHT','UNKNOWN','RETURNED')",
                            Integer.class, operation).isEmpty()) {
                throw new IllegalStateException("The original PUT is no longer eligible for reconciliation");
            }
        };
        try {
            guard.run();
            try (InputStream input = objects.open((String) row.get("object_key"), number(row, "byte_length") + 1, guard)) {
                SessionResourceBodies.verifiedBytes(input, number(row, "byte_length"), (String) row.get("sha256"), guard);
            }
            return Boolean.TRUE.equals(transactions.execute(status -> {
                lockSession(row);
                guard.run();
                return jdbc.update("UPDATE ma_operation SET state = 'RETURNED', failure_code = NULL, completed_at = ?, gmt_modified = ?"
                        + " WHERE operation_key = ? AND state IN ('IN_FLIGHT','UNKNOWN')",
                        ToolPublicationRetentionStore.now(jdbc), ToolPublicationRetentionStore.now(jdbc), operation) == 1;
            }));
        } catch (RuntimeException | IOException failure) {
            jdbc.update("UPDATE ma_operation SET available_at = ?, failure_code = 'put_unresolved', gmt_modified = ?"
                    + " WHERE operation_key = ? AND state IN ('IN_FLIGHT','UNKNOWN')",
                    ToolPublicationRetentionStore.now(jdbc) + 60000, ToolPublicationRetentionStore.now(jdbc), operation);
            LOG.warn("Session object PUT remains unresolved operation={}", operation);
            return false;
        }
    }

    private boolean collect(String key) {
        var initial = resource(key);
        Map<String, Object> admitted = transactions.execute(status -> {
            lockSession(initial);
            var row = jdbc.query("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE resource_key = ? FOR UPDATE",
                    (result, index) -> ManagedSchemaRows.read(result), key).getFirst();
            requireIdentity(row);
            if (!eligible(row)) {
                return null;
            }
            String scope = (String) row.get("session_scope_key");
            String operation = ManagedSchemaKeys.operationKey(OperationKind.SESSION_OBJECT_GC, scope, key, key);
            long now = ToolPublicationRetentionStore.now(jdbc);
            var puts = jdbc.queryForList("SELECT operation_key, state FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'"
                    + " AND target_key = ? AND operation_id = ? AND phase IN ('SESSION_RESOURCE','JOURNAL_PACK') FOR UPDATE", key, row.get("publish_command_id"));
            if (puts.size() != 1 || !List.of("PREPARED", "RETURNED").contains(puts.getFirst().get("state"))) {
                return null;
            }
            if ("PREPARED".equals(puts.getFirst().get("state"))) {
                jdbc.update("UPDATE ma_operation SET state = 'RETURNED', failure_code = 'put_never_started', completed_at = ?, gmt_modified = ? WHERE operation_key = ? AND state = 'PREPARED'",
                        now, now, puts.getFirst().get("operation_key"));
                jdbc.update("UPDATE ma_resource SET state = 'COLLECTED', retention_until = NULL WHERE resource_key = ?", key);
                return null;
            }
            String request = "{\"resourceKey\":\"" + key + "\"}";
            jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_id, operation_kind, tenant_id, workspace_id, session_id,"
                    + " target_kind, target_key, request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, ?, 'SESSION_OBJECT_GC', ?, ?, ?, 'RESOURCE', ?, ?, ?, 'PENDING', 'DELETING', ?, ?)"
                    + " ON DUPLICATE KEY UPDATE operation_key = operation_key", operation, scope, scope, key,
                    row.get("tenant_id"), row.get("workspace_id"), row.get("session_id"), key, ManagedSchemaKeys.key(request), request, now, now);
            jdbc.update("UPDATE ma_resource SET state = 'DELETING', deletion_operation_key = ? WHERE resource_key = ? AND state <> 'COLLECTED'", operation, key);
            return resource(key);
        });
        if (admitted == null) {
            return false;
        }
        Runnable guard = () -> transactions.executeWithoutResult(status -> {
            lockSession(admitted);
            var current = resource(key);
            if (!sameLocator(admitted, current) || !"DELETING".equals(current.get("state"))
                    || !admitted.get("deletion_operation_key").equals(current.get("deletion_operation_key")) || !eligible(current)) {
                throw new IllegalStateException("Object deletion protection changed");
            }
        });
        guard.run();
        objects.deleteIfPresent((String) admitted.get("object_key"), guard);
        transactions.executeWithoutResult(status -> {
            guard.run();
            long now = ToolPublicationRetentionStore.now(jdbc);
            jdbc.update("UPDATE ma_resource SET state = 'COLLECTED' WHERE resource_key = ? AND deletion_operation_key = ? AND state = 'DELETING'",
                    key, admitted.get("deletion_operation_key"));
            jdbc.update("UPDATE ma_operation SET state = 'SUCCEEDED', completed_at = ?, gmt_modified = ? WHERE operation_key = ?",
                    now, now, admitted.get("deletion_operation_key"));
        });
        return true;
    }

    private boolean eligible(Map<String, Object> row) {
        String tenant = (String) row.get("tenant_id");
        String session = (String) row.get("session_id");
        long now = ToolPublicationRetentionStore.now(jdbc);
        var root = jdbc.queryForMap("SELECT is_csi_guard, is_recovery_protected, retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?", tenant, session);
        if ("COLLECTED".equals(row.get("state")) || ToolPublicationRetentionStore.flag(root, "is_csi_guard")
                || ToolPublicationRetentionStore.flag(root, "is_recovery_protected")
                || number(row, "gmt_create") > now - settings.getObjectStore().getDeletionGrace().toMillis()
                || !jdbc.queryForList("SELECT 1 FROM ma_resource_ref WHERE resource_key = ? LIMIT 1", Integer.class, row.get("resource_key")).isEmpty()
                || ToolPublicationRetentionStore.earliestReadLeaseExpiry(jdbc, tenant, session) != 0
                || recoveryInFlight(jdbc, tenant, session)) {
            return false;
        }
        if (root.get("retired_at") != null && number(root, "retired_at") > now - settings.getObjectStore().getDeletionGrace().toMillis()) {
            return false;
        }
        if (root.get("retired_at") == null && "managed-agent-skills".equals(row.get("kind"))) {
            return false;
        }
        var heads = jdbc.query("SELECT state, writer_id, writer_generation, writer_lease_until FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                (result, index) -> ManagedSchemaRows.read(result), tenant, session);
        if (heads.isEmpty()) {
            if (root.get("retired_at") == null) {
                return false;
            }
        } else {
            var head = heads.getFirst();
            if ("ACTIVE".equals(head.get("state")) && head.get("writer_lease_until") != null && number(head, "writer_lease_until") > now) {
                var writers = jdbc.queryForList("SELECT request_json FROM ma_operation WHERE operation_kind = 'OBJECT_PUT' AND target_key = ? AND operation_id = ?",
                        String.class, row.get("resource_key"), row.get("publish_command_id"));
                if (writers.size() != 1) {
                    return false;
                }
                var writer = JdbcManagedToolResultStore.parse(writers.getFirst());
                if (writer.path("writerGeneration").asLong() == number(head, "writer_generation")
                        && writer.path("writerId").asText().equals(head.get("writer_id"))) {
                    return false;
                }
            }
        }
        if (row.get("retention_until") == null) {
            long due = Math.addExact(now, settings.getObjectStore().getDeletionGrace().toMillis());
            jdbc.update("UPDATE ma_resource SET retention_until = ? WHERE resource_key = ? AND retention_until IS NULL", due, row.get("resource_key"));
            return due <= now;
        }
        return number(row, "retention_until") <= now;
    }

    static boolean recoveryInFlight(JdbcTemplate jdbc, String tenant, String session) {
        return !jdbc.queryForList("SELECT w.operation_key FROM ma_operation_work w JOIN ma_operation o ON o.operation_key = w.operation_key"
                + " WHERE w.tenant_id = ? AND w.session_id = ? AND w.work_kind = 'SESSION' AND o.operation_kind IN ('WORKSPACE_RECOVERY','STORAGE_MIGRATION')"
                + " AND ((o.operation_kind = 'WORKSPACE_RECOVERY' AND o.state IN ('CAPTURING','VERIFYING'))"
                + " OR (o.operation_kind = 'STORAGE_MIGRATION' AND o.state NOT IN ('COMPLETED','ABORTED','INVALIDATED'))) LIMIT 1", String.class, tenant, session).isEmpty();
    }

    private void lockSession(Map<String, Object> row) {
        ToolPublicationRetentionStore.lockSessionHead(jdbc, (String) row.get("tenant_id"), (String) row.get("session_id"));
    }

    private Map<String, Object> resource(String key) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE resource_key = ?",
                (result, index) -> ManagedSchemaRows.read(result), key).getFirst();
    }

    private void requireIdentity(Map<String, Object> row) {
        if (!objects.identity().equals(row.get("store_id")) || !"OBJECT_STORE".equals(row.get("storage_kind"))) {
            throw SessionResourceBodies.unavailable();
        }
    }

    private static long number(Map<String, Object> row, String column) {
        return ((Number) row.get(column)).longValue();
    }

    private static boolean sameLocator(Map<String, Object> first, Map<String, Object> second) {
        return List.of("resource_key", "store_id", "object_key", "byte_length", "sha256", "storage_kind").stream()
                .allMatch(key -> java.util.Objects.equals(first.get(key), second.get(key)));
    }
}
