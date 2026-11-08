package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.RenameDelivery;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The RENAME delivery arm, split out of AgentSessionCommands: replay-owner
 * discovery, deliverable scans, claim/submit/retry/park transitions and the
 * delivery row mapping. The SQL, claim guards and verdict order are the ones
 * the commands ran inline.
 */
final class SessionRenameDeliveries {
    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final AgentStoreRows storeRows;
    private final ManagedWorkspaceRegistry workspaces;

    SessionRenameDeliveries(JdbcTemplate jdbc, Clock clock, AgentStoreRows storeRows,
            ManagedWorkspaceRegistry workspaces) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.storeRows = storeRows;
        this.workspaces = workspaces;
    }

    // The discovery arm of the replay's recorder/creator rule: once this
    // method finds an existing RENAME command receipt under the Session
    // lock, the request may only reuse it when the caller is its recorder
    // (the receipt's actor) or the Session's creator. The alternatives —
    // claiming a still-claimable delivery for the recorder, or failing a
    // digest comparison against a different title — would hand the
    // recorder's pending work to the racer or name the live key before
    // authorization.
    // A legacy Session has no per-actor mutation gate at all; its key's
    // outcome stays answerable through the same contract as the pre-read
    // probe. A tombstoned Session answers the reads' 404 instead of the
    // live-Session refusal.
    void requireRenameReplayOwner(SessionRecord session,
            CommandRecord previous, String actorId) {
        requireRenameReplayOwner(session, previous, actorId,
                actorId == null ? null
                        : SessionPrincipal.ofUser(session.tenantId(), actorId));
    }

    void requireRenameReplayOwner(SessionRecord session,
            CommandRecord previous, String actorId,
            SessionPrincipal principal) {
        if (session.workspace() == null) {
            ManagedSessionPrincipal.requireAuthority(jdbc, session.tenantId(),
                    session.sessionId(), principal);
            return;
        }
        if (!previous.admitsReplayBy(actorId)
                && !workspaces.createdSession(session.tenantId(), actorId,
                        session.sessionId())) {
            if ("DELETED".equals(session.status())) {
                throw new ManagedAgentException(404, "session_not_found",
                        "The Session was not found.");
            }
            throw new ManagedAgentException(409, "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
    }

    List<RenameDelivery> deliverableRenames(long now) {
        // A submitted delivery whose claim expired parks for the reconciler.
        String unanswered = "(state = 'RUNNING' AND phase = 'SUBMITTED' AND claim_until <= "
                + ManagedSchemaTime.SQL_NOW + ")";
        for (Map<String, Object> row : jdbc.queryForList(
                "SELECT operation_key, tenant_id, session_id, idempotency_key FROM ma_operation WHERE operation_kind = 'RENAME' AND " + unanswered + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.is_csi_guard = FALSE) LIMIT 100")) {
            parkRename(row, unanswered);
        }
        jdbc.update(
                "UPDATE ma_operation SET state = 'PENDING', delivery_state = 'PENDING', phase = 'ADMITTED', available_at = ?, claim_owner = NULL, claim_until = NULL, gmt_modified = ? WHERE operation_kind = 'RENAME' AND state = 'RUNNING' AND phase = 'PREPARING' AND claim_until <= " + ManagedSchemaTime.SQL_NOW + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.is_csi_guard = FALSE) LIMIT 100",
                now,
                now);
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'RENAME' AND delivery_state = 'PENDING' AND state = 'PENDING' AND available_at <= ? AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.is_csi_guard = FALSE) ORDER BY available_at LIMIT 100",
                this::renameDelivery,
                now);
    }

    Optional<RenameDelivery> claimRename(RenameDelivery delivery, String owner, Duration lease) {
        storeRows.requireLegacySessionForUpdate(delivery.tenantId(), delivery.sessionId());
        long now = clock.millis();
        int claimed =
                jdbc.update(
                        "UPDATE ma_operation SET state = 'RUNNING', delivery_state = 'LEASED', phase = 'PREPARING', claim_owner = ?, claim_until = (" + ManagedSchemaTime.SQL_NOW + " + ?), claim_generation = claim_generation + 1, attempt_count = attempt_count + 1, gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'RENAME' AND ((state = 'PENDING' AND available_at <= ?) OR (state = 'RUNNING' AND phase = 'PREPARING' AND claim_until <= " + ManagedSchemaTime.SQL_NOW + "))",
                        owner,
                        lease.toMillis(),
                        now,
                        renameKey(delivery.tenantId(), delivery.sessionId(), delivery.revision()),
                        now);
        if (claimed == 0) {
            return Optional.empty();
        }
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_key = ? AND operation_kind ="
                            + " 'RENAME'",
                        this::renameDelivery,
                        renameKey(delivery.tenantId(), delivery.sessionId(), delivery.revision()))
                .stream()
                .findFirst();
    }

    void markRenameSubmitted(RenameDelivery delivery, String owner) {
        int changed =
                jdbc.update(
                        "UPDATE ma_operation SET phase = 'SUBMITTED', gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'RENAME' AND state = 'RUNNING' AND phase = 'PREPARING' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        clock.millis(),
                        renameKey(delivery.tenantId(), delivery.sessionId(), delivery.revision()),
                        owner,
                        delivery.claimGeneration());
        if (changed != 1) {
            throw new ManagedAgentException(
                    409,
                    "operation_claim_lost",
                    "The title delivery claim was lost.");
        }
    }

    void retryRename(RenameDelivery delivery, String owner, long availableAt) {
        storeRows.requireLegacyMutation(delivery.tenantId(), delivery.sessionId());
        String key = renameKey(delivery.tenantId(), delivery.sessionId(), delivery.revision());
        parkRename(Map.of("operation_key", key, "tenant_id", delivery.tenantId(),
                        "session_id", delivery.sessionId(), "idempotency_key", delivery.idempotencyKey()),
                "state = 'RUNNING' AND phase = 'SUBMITTED' AND claim_owner = ? AND claim_generation = ?",
                owner, delivery.claimGeneration());
        jdbc.update(
                "UPDATE ma_operation SET state = 'PENDING', delivery_state = 'PENDING', phase ="
                    + " 'ADMITTED', available_at = ?, claim_owner = NULL, claim_until = NULL,"
                    + " gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'RENAME' AND"
                    + " state = 'RUNNING' AND phase = 'PREPARING' AND claim_owner = ? AND"
                    + " claim_generation = ?",
                availableAt,
                clock.millis(),
                key,
                owner,
                delivery.claimGeneration());
    }

    // Parks one delivery whose submission went unanswered, if it still
    // matches the guard. Its receipt retires as an abandoned delivery's
    // does, so the parked title holds neither later titles nor the Session
    // lifecycle hostage; the claim's own late reply and the reconciler both
    // complete a retired receipt.
    void parkRename(Map<String, Object> row, String guard, Object... guardArguments) {
        List<Object> arguments = new ArrayList<>(List.of(storeRows.lifecycleDatabaseTime(), clock.millis(),
                row.get("operation_key")));
        arguments.addAll(List.of(guardArguments));
        if (jdbc.update("UPDATE ma_operation SET " + PARK_RENAME + ", available_at = ?, gmt_modified = ?"
                        + " WHERE operation_key = ? AND operation_kind = 'RENAME' AND " + guard,
                arguments.toArray()) != 1) {
            return;
        }
        String tenantId = (String) row.get("tenant_id");
        jdbc.update(
                "UPDATE ma_request_receipt SET state = 'FAILED', gmt_modified = ? WHERE receipt_key = ?"
                    + " AND namespace = 'SESSION_COMMAND' AND session_id = ? AND state = 'PENDING'",
                clock.millis(),
                ManagedReceipts.commandKey(tenantId, "RENAME_SESSION", (String) row.get("idempotency_key")),
                row.get("session_id"));
    }

    RenameDelivery renameDelivery(java.sql.ResultSet row, int index) throws java.sql.SQLException {
        return new RenameDelivery(
                row.getString("tenant_id"),
                row.getString("session_id"),
                row.getString("idempotency_key"),
                (String) storeRows.readMap(row.getString("request_json")).get("title"),
                row.getLong("target_revision"),
                row.getInt("attempt_count"),
                row.getLong("claim_generation"));
    }

    static String renameKey(String tenant, String session, long revision) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract
                        .OperationKind.RENAME,
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session),
                AgentStoreRows.renameTarget(tenant, session),
                "rename:" + revision);
    }

    // A RENAME parks with the same columns either way: acceptance unknown,
    // never re-sent, settled only by the reconciler or by the same claim's
    // own late reply. Its claim fields stay, so that late reply still settles.
    static final String PARK_RENAME = "state = 'RECOVERY_BLOCKED',"
            + " phase = 'RECOVERY_BLOCKED', admission_stage = 'JAVA_DURABLE',"
            + " delivery_state = 'BLOCKED', failure_code = '"
            + AgentSessionCommands.SESSION_TITLE_UNCONFIRMED + "'";
}
