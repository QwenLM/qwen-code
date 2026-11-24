package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Base64;
import java.util.List;

final class ManagedReceipts {
    record Receipt(String tenantId, String scopeId, String idempotencyKey,
            String requestDigest, String sessionId, String turnId, String state,
            String sessionStatusBefore, byte[] actorKey, Boolean workspaceBound, long createdAt,
            long updatedAt, String operation, String resultJson, String resultOperationKey) {
    }

    private ManagedReceipts() {}

    static String actorScope(byte[] actor) {
        return Base64.getEncoder().encodeToString(actor);
    }

    static String scope(String tenant, String scopeId) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs.receiptScopeRef(tenant, scopeId);
    }

    /** Raw actor bytes bind into the VARCHAR actor column as text; empty means unattributed. */
    private static String actorText(byte[] actor) {
        if (actor == null) {
            return null;
        }
        return actor.length == 0
                ? "" : new String(actor, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static byte[] actorBytes(String actor) {
        return actor == null ? null : actor.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    static Receipt find(
            JdbcTemplate jdbc,
            ReceiptNamespace namespace,
            String tenant,
            ReceiptScope scopeKind,
            String scopeId,
            String idempotencyKey,
            boolean lock) {
        List<Receipt> rows =
                jdbc.query(
                        "SELECT tenant_id, scope_id, idempotency_key, request_digest, session_id,"
                            + " turn_id, state, session_status_before, actor_id, is_workspace_bound, gmt_create,"
                            + " gmt_modified, operation, result_json, result_operation_ref FROM ma_request_receipt WHERE receipt_key = ? AND namespace = ?"
                            + " AND tenant_id = ? AND scope_ref = ?"
                                + (lock ? " FOR UPDATE" : ""),
                        (row, index) -> new Receipt(
                                ManagedSchemaRows.identity(row, "tenant_id"),
                                ManagedSchemaRows.identity(row, "scope_id"),
                                ManagedSchemaRows.identity(row, "idempotency_key"),
                                row.getString("request_digest"),
                                ManagedSchemaRows.identity(row, "session_id"),
                                ManagedSchemaRows.identity(row, "turn_id"),
                                row.getString("state"),
                                row.getString("session_status_before"),
                                actorBytes(row.getString("actor_id")),
                                row.getObject("is_workspace_bound", Boolean.class),
                                row.getLong("gmt_create"), row.getLong("gmt_modified"),
                                row.getString("operation"), row.getString("result_json"),
                                ManagedSchemaRows.identity(row, "result_operation_ref")),
                        ManagedSchemaKeys.receiptKey(
                                namespace, tenant, scopeKind, scopeId, idempotencyKey),
                        namespace.name(),
                        tenant,
                        ManagedSchemaKeys.identity(scope(tenant, scopeId)));
        if (rows.isEmpty()) {
            return null;
        }
        Receipt row = rows.getFirst();
        if (!tenant.equals(row.tenantId())
                || !scopeId.equals(row.scopeId())
                || !idempotencyKey.equals(row.idempotencyKey())) {
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
        BrokerValues.requireIdempotencyKey(key, "idempotencyKey");
        jdbc.update(
                "INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_id,"
                    + " scope_kind, scope_ref, scope_id, idempotency_key, idempotency_digest,"
                    + " request_digest, operation, actor_id, session_id, turn_id, state,"
                    + " session_status_before, is_workspace_bound, gmt_create, gmt_modified) VALUES (?,"
                    + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ManagedSchemaKeys.receiptKey(namespace, tenant, scopeKind, scopeId, key),
                namespace.name(),
                tenant,
                scopeKind.name(),
                ManagedSchemaKeys.identity(scope(tenant, scopeId)),
                ManagedSchemaKeys.identity(scopeId),
                key,
                ManagedSchemaKeys.key(key),
                digest,
                operation,
                actorText(actor),
                session,
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
        insertCommand(
                jdbc, tenant, operation, key, digest, session, turn, state, previousStatus, null,
                now);
    }

    // A command this build records without an attributable actor — a
    // server-keyed command, or an actor id the registry key cannot encode.
    // Zero bytes, which no actor key equals (an actor id has at least one
    // code point).
    static final byte[] UNATTRIBUTED = new byte[0];

    // The recording actor rides on the receipt so a replay answers the
    // actor who recorded the command, not only the Session's creator.
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
            byte[] actor,
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
                actor == null ? UNATTRIBUTED : actor,
                session,
                turn,
                state,
                previousStatus,
                null,
                now);
    }

    // A Turn input or cancel command names its durable operation (D7-1), so
    // a replay of the key resolves to that original operation.
    static void linkCommandOperation(
            JdbcTemplate jdbc, String tenant, String operation, String key, String operationRef) {
        jdbc.update(
                "UPDATE ma_request_receipt SET result_operation_ref = ? WHERE receipt_key = ?",
                ManagedSchemaKeys.identity(operationRef),
                commandKey(tenant, operation, key));
    }

    static Receipt command(
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

    static Receipt creation(
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
