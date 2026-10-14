package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;

import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Base64;
import java.util.List;
import java.util.Map;

final class ManagedReceipts {
    private ManagedReceipts() {}

    static String actorScope(byte[] actor) {
        return Base64.getEncoder().encodeToString(actor);
    }

    static String scope(String tenant, String scopeId) {
        return ManagedSchemaKeys.key(tenant, scopeId);
    }

    static Map<String, Object> find(
            JdbcTemplate jdbc,
            ReceiptNamespace namespace,
            String tenant,
            ReceiptScope scopeKind,
            String scopeId,
            String idempotencyKey,
            boolean lock) {
        List<Map<String, Object>> rows =
                jdbc.query(
                        "SELECT * FROM ma_request_receipt WHERE receipt_key = ? AND namespace = ?"
                            + " AND tenant_key = ? AND scope_key = ?"
                                + (lock ? " FOR UPDATE" : ""),
                        (row, index) -> ManagedSchemaRows.read(row),
                        ManagedSchemaKeys.receiptKey(
                                namespace, tenant, scopeKind, scopeId, idempotencyKey),
                        namespace.name(),
                        ManagedSchemaKeys.key(tenant),
                        scope(tenant, scopeId));
        if (rows.isEmpty()) {
            return null;
        }
        Map<String, Object> row = rows.getFirst();
        if (!tenant.equals(row.get("tenant_id"))
                || !scopeId.equals(row.get("scope_id"))
                || !idempotencyKey.equals(row.get("idempotency_key"))) {
            throw new IllegalStateException("Request identity digest collision.");
        }
        return row;
    }

    static void insert(
            JdbcTemplate jdbc,
            ReceiptNamespace namespace,
            String tenant,
            ReceiptScope scopeKind,
            String scopeId,
            String key,
            String digest,
            String operation,
            byte[] actor,
            String session,
            String turn,
            String state,
            String previousStatus,
            Boolean workspaceBound,
            long now) {
        jdbc.update(
                "INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id,"
                    + " scope_kind, scope_key, scope_id, idempotency_key, idempotency_digest,"
                    + " request_digest, operation, actor_id, session_id, turn_id, state,"
                    + " session_status_before, workspace_bound, created_at, updated_at) VALUES (?,"
                    + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ManagedSchemaKeys.receiptKey(namespace, tenant, scopeKind, scopeId, key),
                namespace.name(),
                ManagedSchemaKeys.key(tenant),
                ManagedSchemaKeys.identity(tenant),
                scopeKind.name(),
                scope(tenant, scopeId),
                ManagedSchemaKeys.identity(scopeId),
                ManagedSchemaKeys.identity(key),
                ManagedSchemaKeys.key(key),
                digest,
                operation,
                actor,
                session == null ? null : ManagedSchemaKeys.identity(session),
                turn == null ? null : ManagedSchemaKeys.identity(turn),
                state,
                previousStatus,
                workspaceBound,
                now,
                now);
    }

    static String commandKey(String tenant, String operation, String key) {
        return ManagedSchemaKeys.receiptKey(
                ReceiptNamespace.SESSION_COMMAND, tenant, ReceiptScope.TENANT, operation, key);
    }

    static void insertCommand(
            JdbcTemplate jdbc,
            String tenant,
            String operation,
            String key,
            String digest,
            String session,
            String turn,
            String state,
            String previousStatus,
            long now) {
        insert(
                jdbc,
                ReceiptNamespace.SESSION_COMMAND,
                tenant,
                ReceiptScope.TENANT,
                operation,
                key,
                digest,
                operation,
                null,
                session,
                turn,
                state,
                previousStatus,
                null,
                now);
    }

    static Map<String, Object> command(
            JdbcTemplate jdbc, String tenant, String operation, String key, boolean lock) {
        return find(
                jdbc,
                ReceiptNamespace.SESSION_COMMAND,
                tenant,
                ReceiptScope.TENANT,
                operation,
                key,
                lock);
    }

    static void insertCreation(
            JdbcTemplate jdbc,
            String tenant,
            byte[] actor,
            String key,
            String digest,
            String session,
            String turn,
            long now) {
        insert(
                jdbc,
                ReceiptNamespace.SESSION_CREATE_ACTOR,
                tenant,
                ReceiptScope.ACTOR,
                actorScope(actor),
                key,
                digest,
                null,
                actor,
                session,
                turn,
                "COMPLETED",
                null,
                true,
                now);
    }

    static Map<String, Object> creation(
            JdbcTemplate jdbc, String tenant, byte[] actor, String key) {
        return find(
                jdbc,
                ReceiptNamespace.SESSION_CREATE_ACTOR,
                tenant,
                ReceiptScope.ACTOR,
                actorScope(actor),
                key,
                false);
    }
}
