package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class AgentLifecycleOperations {
    private final AgentEventJournal eventJournal;
    private final AgentSessionCommands sessionCommands;
    private final AgentSessionPolicies sessionPolicies;
    private final AgentSessionQueries sessionQueries;
    private final AgentStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final WorkspaceLifecycleStore lifecycle;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final ManagedWorkspaceRegistry workspaces;
    private final boolean workspaceFilesEnabled;
    private final long lifecycleHandoffMillis;

    AgentLifecycleOperations(AgentEventJournal eventJournal,
            AgentSessionCommands sessionCommands,
            AgentSessionPolicies sessionPolicies,
            AgentSessionQueries sessionQueries,
            AgentStoreRows storeRows,
            JdbcTemplate jdbc,
            WorkspaceLifecycleStore lifecycle,
            ObjectMapper objectMapper,
            Clock clock,
            ManagedWorkspaceRegistry workspaces,
            boolean workspaceFilesEnabled,
            long lifecycleHandoffMillis) {
        this.eventJournal = eventJournal;
        this.sessionCommands = sessionCommands;
        this.sessionPolicies = sessionPolicies;
        this.sessionQueries = sessionQueries;
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.lifecycle = lifecycle;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.workspaces = workspaces;
        this.workspaceFilesEnabled = workspaceFilesEnabled;
        this.lifecycleHandoffMillis = lifecycleHandoffMillis;
        this.operationMapper = (result, row) -> new OperationRecord(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("operation_id"),
                        OperationKind.valueOf(result.getString("operation_kind")),
                        result.getString("request_digest"),
                        result.getString("state"),
                        result.getString("admission_stage"),
                        result.getString("delivery_state"),
                        result.getString("session_status_before"),
                        result.getString("receipt_id"),
                        result.getString("claim_owner"),
                        result.getLong("claim_generation"),
                        result.getInt("attempt_count"),
                        AgentStoreRows.additiveString(result, "target_cwd_relative"),
                        AgentStoreRows.additiveLong(result, "expected_context_revision"),
                        AgentStoreRows.additiveLong(result, "result_context_revision"),
                        result.getString("failure_code"),
                        AgentStoreRows.additiveInt(result, "budget_exempt_attempt"),
                        AgentStoreRows.hasColumn(result, "lifecycle_protocol_version")
                                ? result.getInt("lifecycle_protocol_version") : 0,
                        // NULL on a pre-V56 operation: those operations settle
                        // against the creator-keyed facts alone.
                        AgentStoreRows.hasColumn(result, "actor_key")
                                ? result.getBytes("actor_key") : null,
                        AgentStoreRows.additiveString(result, "task_id"));
        this.operationTargetMapper = (result, row) -> new OperationTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("operation_id"));
    }

    final RowMapper<OperationRecord> operationMapper;

    final RowMapper<OperationTarget> operationTargetMapper;

    OperationAdmission beginOperation(String tenantId,
            String sessionId, OperationKind kind, String actorDigest,
            String idempotencyKey, String requestDigest) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        if (storeRows.requireLegacySessionForUpdate(tenantId, sessionId).workspace() != null) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest, null, false);
    }

    OperationAdmission beginWorkspaceClose(String tenantId, String sessionId, String actorId,
            String actorDigest, String key, String digest, boolean supported) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        return beginLifecycle(tenantId, sessionId, OperationKind.CLOSE, actorDigest, key, digest, actorId, supported);
    }

    OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key, String digest, boolean closeSupported) {
        // H4b child close is the only production caller. Public lifecycle uses
        // the protocol overload and requires v2 for an active Shell or MCP Session.
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, key, digest, actorId, closeSupported, 0, false);
    }

    OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key, String digest, boolean supported, int protocolVersion) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, key, digest, actorId, supported, protocolVersion, true);
    }

    // The lifecycle owner gate: the Session's recorded owner (with the
    // pre-V40 creator fallback) holding a current read grant. Unreadable is
    // invisible; a readable non-owner gets the sibling family's 403.
    void requireWorkspaceCreator(SessionRecord session, String actorId) {
        if (!workspaces.canRead(session.tenantId(), actorId, session.workspace().getWorkspaceId())) {
            throw new ManagedAgentException(
                    404, "session_not_found", "The Session was not found.");
        }
        if (!workspaces.isSessionOwner(session.tenantId(), actorId, session.sessionId())) {
            throw new ManagedAgentException(403, "session_operation_forbidden",
                    "Only the Session owner may manage it.");
        }
    }

    SessionMutation unarchiveWorkspaceSession(String tenantId, String sessionId,
            String actorId, String scopedKey, String requestDigest) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        requireWorkspaceCreator(session, actorId);
        String namespace = "UNARCHIVE_WORKSPACE_SESSION";
        // Replay first, like every other mutation path: a recorded success
        // must not 404 after a later delete.
        Optional<CommandRecord> existing = sessionCommands.findCommand(tenantId, namespace, scopedKey, true);
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest) || !existing.get().sessionId().equals(sessionId)) {
                throw new ManagedAgentException(409, "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new SessionMutation(session, true);
        }
        // The tombstone 404 precedes the migration fence and the shell
        // refusal: a fresh key against a deleted Session must not answer
        // a retryable 409 for a Session that will never come back.
        if ("DELETED".equals(session.status())) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found.");
        }
        if (WorkspaceToolProfiles.isShellOrMcp(session.toolProfile())
                && (WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) != 2
                        || !List.of("CLOSED", "ARCHIVED").contains(session.status()))) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
        AgentSessionPolicies.requireSessionStatus(session.status(), "ARCHIVED");
        sessionPolicies.requireNoOpenOperation(tenantId, sessionId);
        if (!sessionQueries.hasCompletedWorkspaceClose(tenantId, sessionId)) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        long now = storeRows.lifecycleDatabaseTime();
        sessionCommands.insertCommand(
                tenantId,
                namespace,
                scopedKey,
                requestDigest,
                sessionId,
                null,
                "COMPLETED",
                "ARCHIVED",
                null,
                now);
        Map<String, Object> data = Map.of("sessionId", sessionId);
        eventJournal.appendEvent(tenantId, sessionId, null, "session.unarchive.requested", data, false,
                AgentSessionCommands.mutationSource(namespace, scopedKey, "requested"), now);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED', gmt_modified = ?, version = version + 1"
                + " WHERE tenant_id = ? AND session_id = ?", now, tenantId, sessionId);
        eventJournal.appendEvent(tenantId, sessionId, null, "session.unarchived", data, false,
                AgentSessionCommands.mutationSource(namespace, scopedKey, "completed"), now);
        return new SessionMutation(storeRows.requireSessionForUpdate(tenantId, sessionId), false);
    }

    // D7-1: a Turn input or cancel command targets its Turn, never the
    // Session, so no Session barrier above counts it: the Turn row is its
    // barrier, and the Turn dispatcher, which holds the only lease that may
    // act on the Turn, is its only deliverer.
    static final String TURN_COMMAND_KINDS = "('SUBMIT_INPUT', 'CANCEL')";

    // For these it is a published wait on a precondition of an operation
    // whose acceptance is known: the lifecycle coordinator re-drives it, and
    // keyed effect receipts keep the re-drive from repeating an effect.
    static final String LIFECYCLE_WAIT_KINDS =
            "('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE')";

    Optional<OperationRecord> findTurnCommandOperation(
            String tenantId, String sessionId, String operationId) {
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + TURN_COMMAND_KINDS
                                + " AND operation_id = ?",
                        (result, row) -> {
                            if (!tenantId.equals(result.getString("tenant_id"))
                                    || !sessionId.equals(result.getString("session_id"))) {
                                throw new IllegalStateException(
                                        "Session operation identity does not match its index key");
                            }
                            return operationMapper.mapRow(result, row);
                        },
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        operationId)
                .stream()
                .findFirst();
    }

    Optional<OperationRecord> replayOperation(String tenantId, String sessionId,
            OperationKind kind, String actorDigest, String idempotencyKey) {
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE scope_key = ? AND operation_kind = ? AND"
                            + " target_key = ? AND actor_digest = ? AND idempotency_digest = ?",
                        (result, row) -> {
                            if (!tenantId.equals(result.getString("tenant_id"))
                                    || !sessionId.equals(result.getString("session_id"))
                                    || !idempotencyKey.equals(
                                            result.getString("idempotency_key"))) {
                                throw new IllegalStateException(
                                        "Session operation identity does not match its index key");
                            }
                            return operationMapper.mapRow(result, row);
                        },
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        kind.name(),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        actorDigest,
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                                idempotencyKey))
                .stream()
                .findFirst();
    }

    Optional<OperationRecord> findSessionOperation(String tenantId, String sessionId, String operationId, boolean lock) {
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND operation_id = ?"
                                + (lock ? " FOR UPDATE" : ""),
                        (result, row) -> {
                            if (!tenantId.equals(result.getString("tenant_id"))
                                    || !sessionId.equals(result.getString("session_id"))) {
                                throw new IllegalStateException(
                                        "Session operation identity does not match its index key");
                            }
                            return operationMapper.mapRow(result, row);
                        },
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        operationId)
                .stream()
                .findFirst();
    }

    OperationAdmission beginChildClose(String tenantId, String parentSessionId,
            String childSessionId, String childRunId, String actorDigest, String key,
            String digest, boolean supported) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        storeRows.requireSessionForUpdate(tenantId, parentSessionId);
        byte[] creator =
                jdbc.queryForObject(
                        "SELECT creator_actor_key FROM ma_session WHERE tenant_id = ? AND"
                            + " session_id = ?",
                        byte[].class,
                        tenantId,
                        parentSessionId);
        var lineage =
                jdbc.queryForList(
                        "SELECT parent_session_id, parent_child_run_id, creator_actor_key FROM"
                            + " ma_session WHERE tenant_id = ? AND session_id = ? AND session_kind"
                            + " = 'PUBLIC' FOR UPDATE",
                        tenantId,
                        childSessionId);
        if (lineage.size() != 1
                || !parentSessionId.equals(lineage.getFirst().get("parent_session_id"))
                || !childRunId.equals(lineage.getFirst().get("parent_child_run_id"))
                || !(lineage.getFirst().get("creator_actor_key") instanceof byte[] actor)
                || actor.length == 0
                || !java.util.Arrays.equals(actor, creator)) {
            throw new ManagedAgentException(
                    404,
                    "session_not_found",
                    "The child Session lineage was not found.");
        }
        return beginLifecycle(tenantId, childSessionId, OperationKind.CLOSE, actorDigest, key, digest,
                null, supported, storeRows.requireSession(tenantId, childSessionId).publicChildAgentsVersion() == 1
                        ? WorkspaceToolProfiles.lifecycleProtocol(storeRows.requireSession(tenantId, childSessionId).toolProfile()) : 0, true, true);
    }

    OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorDigest, String idempotencyKey, String requestDigest, String actorId, boolean supported) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest, actorId, supported, 0, true);
    }

    OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorDigest, String idempotencyKey, String requestDigest, String actorId, boolean supported, int protocolVersion,
            boolean publicLifecycle) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest,
                actorId, supported, protocolVersion, publicLifecycle, false);
    }

    OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorDigest, String idempotencyKey, String requestDigest, String actorId, boolean supported, int protocolVersion,
            boolean publicLifecycle, boolean trustedChildClose) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        // A resumed admission pins the new operation to the failed one's
        // protocol (below), so the tenant lock keys on the prospect of
        // that pin too — otherwise the resumed lifecycle admission's
        // journal-idleness read would race the retention sweep.
        if (WorkspaceToolProfiles.lifecycleProtocol(protocolVersion)
                || latestFailedLifecycleOperation(tenantId, sessionId, kind)
                        .filter(failed -> WorkspaceToolProfiles.lifecycleProtocol(
                                failed.lifecycleProtocolVersion()))
                        .isPresent()) {
            ToolPublicationRetentionStore.lockTenant(jdbc, tenantId);
        }
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !trustedChildClose) {
            requireWorkspaceCreator(session, actorId);
        }
        Optional<OperationRecord> existing = replayOperation(tenantId, sessionId,
                kind, actorDigest, idempotencyKey);
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest)) {
                throw new ManagedAgentException(409,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new OperationAdmission(existing.get(), true);
        }
        if ("DELETED".equals(session.status())) {
            throw new ManagedAgentException(404, "session_not_found",
                    "The Session was not found.");
        }
        // A terminally FAILED operation leaves the Session in the pending
        // status, which the workspace status gate and validateOperationStart
        // refuse forever: the Session would be un-closable and un-deletable
        // without database surgery (review round 9, R9-3; the workspace
        // DELETE case surfaced in review round 13, R13-2). The permitted
        // resume is recognized before those gates, and the failed
        // operation's protocol is pinned up front — the service computes
        // the caller's protocol from the Session's CURRENT status, and a
        // Session parked in the pending status by the terminal fail no
        // longer passes the lifecycle gate, so an unpinned resume would run
        // as protocol 0 while the parked fence row is never rebound (review
        // round 9 re-review, R9-3). The no-open-operation guard below still
        // runs before the insert: a Session with a live operation cannot
        // double-close.
        var failedBefore =
                kind != OperationKind.ACTION_RESPONSE
                        && kind != OperationKind.CWD_CHANGE
                        && pendingStatus(kind).equals(session.status())
                ? latestFailedLifecycleOperation(tenantId, sessionId, kind)
                : Optional.<FailedLifecycleOperation>empty();
        boolean resumed = failedBefore.isPresent();
        if (resumed) {
            protocolVersion = failedBefore.get().lifecycleProtocolVersion();
        }
        if (protocolVersion < 0 || protocolVersion > 2
                || protocolVersion != 0 && protocolVersion != WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile())) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceLifecycleStore.blocked("workspace_lifecycle_protocol_unavailable");
        }
        if (publicLifecycle && WorkspaceToolProfiles.isShellOrMcp(session.toolProfile())
                && (WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) != 2
                        || protocolVersion != 2 && (!List.of("CLOSED", "ARCHIVED").contains(session.status())
                                || !sessionQueries.hasCompletedWorkspaceClose(tenantId, sessionId)))) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        if (sessionPolicies.hasPendingRenameDelivery(tenantId, sessionId)) {
            throw new ManagedAgentException(409, "session_operation_active",
                    "The Session has a title delivery awaiting completion.");
        }
        if (session.workspace() != null) {
            WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
        }
        if (kind == OperationKind.DELETE && List.of("CLOSED", "ARCHIVED").contains(session.status())) {
            protocolVersion = 0;
        }
        if (session.workspace() != null && !resumed) {
            if (kind == OperationKind.CLOSE || kind == OperationKind.DELETE && "ACTIVE".equals(session.status()) && WorkspaceToolProfiles.lifecycleProtocol(protocolVersion)) {
                if (!supported || protocolVersion == 1 && !workspaceFilesEnabled) {
                    throw AgentSessionPolicies.workspaceExecutionUnavailable();
                }
                if ("ACTIVE".equals(session.status())) {
                    validateOperationStart(session, kind);
                }
            } else {
                if (kind == OperationKind.ARCHIVE) {
                    AgentSessionPolicies.requireSessionStatus(session.status(), "CLOSED");
                } else if (!List.of("CLOSED", "ARCHIVED").contains(session.status())) {
                    throw AgentSessionPolicies.sessionStateConflict(session.status());
                }
                sessionPolicies.requireNoOpenOperation(tenantId, sessionId);
                if (!sessionQueries.hasCompletedWorkspaceClose(tenantId, sessionId)) {
                    throw AgentSessionPolicies.workspaceExecutionUnavailable();
                }
            }
        }
        sessionPolicies.requireNoOpenOperation(tenantId, sessionId);
        String sessionStatusBefore = session.status();
        if (resumed) {
            // The new operation carries the failed one's original
            // pre-operation status, so its settle runs the steps the failed
            // attempt was owed: an ACTIVE-before close asks the Harness to
            // stop again, and a CLOSED-before delete still makes no Runtime
            // calls.
            sessionStatusBefore = failedBefore.get().sessionStatusBefore();
        } else {
            validateOperationStart(session, kind);
        }
        if (WorkspaceToolProfiles.lifecycleProtocol(protocolVersion)) {
            WorkspaceLifecycleStore.requireIdleJournal(jdbc, objectMapper, tenantId, sessionId, true, protocolVersion == 2);
        }
        long now = storeRows.lifecycleDatabaseTime();
        String operationId = AgentStoreRows.publicId("op");
        Map<String, Object> data = Map.of("sessionId", sessionId,
                "operationId", operationId);
        // Java is the only authority an archive needs, so it completes here.
        boolean archive = kind == OperationKind.ARCHIVE;
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " target_kind, target_key, target_id, phase, request_json,"
                    + " idempotency_digest, tenant_id, session_id, operation_id, operation_kind,"
                    + " actor_digest, idempotency_key, request_digest, state, admission_stage,"
                    + " delivery_state, session_status_before, receipt_id, available_at,"
                    + " gmt_create, gmt_modified, completed_at, lifecycle_protocol_version) VALUES"
                    + " (?, ?, ?, 'SESSION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'JAVA_DURABLE',"
                    + " ?, ?, ?, ?, ?, ?, ?, ?)",
                AgentStoreRows.sessionOperationKey(tenantId, sessionId, kind, operationId),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                AgentStoreRows.sessionOperationTarget(sessionId),
                sessionId,
                archive ? "COMPLETED" : "PENDING",
                storeRows.writeJson(
                        Map.of(
                                "schemaVersion",
                                1,
                                "kind",
                                kind.name(),
                                "sessionId",
                                sessionId,
                                "sessionStatusBefore",
                                sessionStatusBefore,
                                "protocolVersion",
                                protocolVersion)),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                        idempotencyKey),
                tenantId,
                sessionId,
                operationId,
                kind.name(),
                actorDigest,
                idempotencyKey,
                requestDigest,
                archive ? "COMPLETED" : "PENDING",
                archive ? "CONFIRMED" : "PENDING",
                sessionStatusBefore,
                archive ? AgentStoreRows.publicId("rcpt") : null,
                now,
                now,
                now,
                archive ? now : null,
                protocolVersion);
        if (resumed && WorkspaceToolProfiles.lifecycleProtocol(protocolVersion)) {
            // failOperation kept the fence row and released the dead
            // operation's claim on it, so the re-admitted operation rebinds
            // the row rather than inserting a duplicate. The release only
            // reaches a fence still LIFECYCLE_ONLY: once effects were saved
            // the fence moved to DRAINING with the dead operation still
            // named, and a rebind limited to the LIFECYCLE_ONLY shape
            // matches nothing — every later claim check reads the fence as
            // another operation's and refuses with
            // workspace_lifecycle_claim_fenced (review round 13, R13-1).
            // Both parked shapes rebind here: the claim-released
            // LIFECYCLE_ONLY row, and the DRAINING row that still names the
            // failed operation whose validated effects the resume inherits.
            jdbc.update("UPDATE ma_session_head SET"
                            + " operation_id = ? WHERE tenant_key = ? AND"
                            + " harness_key = ? AND tenant_id = ? AND"
                            + " harness_session_id = ? AND (phase ="
                            + " 'LIFECYCLE_ONLY' AND operation_id IS NULL OR"
                            + " phase = 'DRAINING' AND operation_id = ?)",
                    operationId,
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId, sessionId, failedBefore.get().operationId());
            // The effects the failed operation validated stay valid for its
            // resume: the receipt moves to the new operation with them, and
            // verification reads the hook-execution namespace from the
            // receipt's own operation id.
            String carriedEffects = jdbc.queryForObject(
                    "SELECT lifecycle_effects_receipt_json FROM"
                            + " ma_operation WHERE tenant_id = ?"
                            + " AND session_id = ? AND operation_id = ?",
                    String.class, tenantId, sessionId,
                    failedBefore.get().operationId());
            if (carriedEffects != null) {
                jdbc.update("UPDATE ma_operation SET"
                                + " lifecycle_effects_receipt_json = ? WHERE"
                                + " tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ?",
                        carriedEffects, tenantId, sessionId, operationId);
            }
        } else if (WorkspaceToolProfiles.lifecycleProtocol(protocolVersion)) {
            jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.beginHarnessLifecycle(connection, tenantId, sessionId, operationId);
                return null;
            });
            if (protocolVersion == 2) {
                // Admission fences ordinary renewals before the Harness receives its claim.
                // Preserve a live writer once, without reviving an expired owner on retries.
                jdbc.update("UPDATE ma_session_head SET writer_lease_until = GREATEST(writer_lease_until, ("
                                + ManagedSchemaTime.SQL_NOW + ") + ?), gmt_modified = " + ManagedSchemaTime.SQL_NOW
                                + " WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND harness_session_id = ?"
                                + " AND head_kind = 'MANAGED_SESSION' AND phase = 'LIFECYCLE_ONLY' AND operation_id = ? AND state = 'ACTIVE'"
                                + " AND writer_lease_until > (" + ManagedSchemaTime.SQL_NOW + ")",
                        lifecycleHandoffMillis, JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), tenantId, sessionId, operationId);
            }
        }
        jdbc.update("UPDATE ma_session SET status = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                archive ? "ARCHIVED" : pendingStatus(kind), now, tenantId,
                sessionId);
        eventJournal.appendEvent(tenantId, sessionId, null,
                archive ? completedEvent(kind) : requestedEvent(kind), data,
                false, AgentEventJournal.operationSource(operationId,
                        archive ? "completed" : "requested"), now);
        return new OperationAdmission(findOperation(tenantId, sessionId,
                operationId).orElseThrow(), false);
    }

    Optional<OperationRecord> findOperation(String tenantId,
            String sessionId, String operationId) {
        return findSessionOperation(tenantId, sessionId, operationId, false)
                .or(() -> findTurnCommandOperation(tenantId, sessionId,
                        operationId));
    }

    List<OperationTarget> findDeliverableOperations(long now,
            int limit) {
        now = storeRows.lifecycleDatabaseTime();
        List<OperationTarget> targets =
                new ArrayList<>(
                        jdbc.query(
                                // Every blocked lifecycle shape is
                                // re-driven. CLOSE, DELETE and CWD_CHANGE
                                // are the delivered kinds (an archive
                                // completes at admission): CLOSE and DELETE
                                // publish their writer-live and stale-boot
                                // waits, and a cwd change stays bounded by
                                // its own attempt budget in the coordinator
                                // (review round 2, R2-15).
                                "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE"
                                    + " operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE',"
                                    + " 'CWD_CHANGE') AND state IN ('PENDING', 'RUNNING',"
                                    + " 'RECOVERY_BLOCKED') AND delivery_state IN ('PENDING',"
                                    + " 'BLOCKED') AND available_at <= ? AND EXISTS (SELECT 1 FROM"
                                    + " ma_session private_scope WHERE private_scope.tenant_id ="
                                    + " ma_operation.tenant_id AND private_scope.session_id ="
                                    + " ma_operation.session_id AND private_scope.is_csi_guard ="
                                    + " FALSE) ORDER BY available_at LIMIT ?",
                                operationTargetMapper,
                                now,
                                limit));
        if (targets.size() < limit) {
            targets.addAll(
                    jdbc.query(
                            "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE') AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_until < " + ManagedSchemaTime.SQL_NOW + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.is_csi_guard = FALSE) ORDER BY claim_until LIMIT ?",
                            operationTargetMapper,
                            limit - targets.size()));
        }
        return List.copyOf(targets);
    }

    Optional<OperationRecord> claimOperation(String tenantId,
            String sessionId, String operationId, String owner,
            Duration leaseDuration) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = storeRows.lifecycleDatabaseTime();
        int updated =
                jdbc.update(
                        "UPDATE ma_operation SET phase = 'RUNNING', state = 'RUNNING', delivery_state = 'LEASED', claim_owner = ?, claim_until = (" + ManagedSchemaTime.SQL_NOW + " + ?), claim_generation = claim_generation + 1, gmt_modified = ? WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ? AND (state IN ('PENDING', 'RUNNING')"
                                + " OR state = 'RECOVERY_BLOCKED' AND operation_kind IN "
                                + LIFECYCLE_WAIT_KINDS
                                + ") AND ((delivery_state IN ('PENDING', 'BLOCKED')"
                                + " AND available_at <= ?) OR (delivery_state = 'LEASED' AND"
                                + " claim_until < " + ManagedSchemaTime.SQL_NOW + "))",
                        owner,
                        leaseDuration.toMillis(),
                        now,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId,
                        now);
        if (updated == 1) {
            syncLifecycleClaim(tenantId, sessionId, operationId);
        }
        return updated == 1 ? findOperation(tenantId, sessionId, operationId)
                : Optional.empty();
    }

    boolean completeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            boolean harnessConfirmed) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        var target = findOperation(tenantId, sessionId, operationId).orElseThrow();
        if (WorkspaceToolProfiles.lifecycleProtocol(target.lifecycleProtocolVersion())) {
            WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
            ManagedSessionStore.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(
                    jdbc, tenantId, ManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        }
        if (target.kind() == OperationKind.DELETE && !WorkspaceToolProfiles.lifecycleProtocol(target.lifecycleProtocolVersion())) {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenantId, sessionId);
        }
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (WorkspaceToolProfiles.lifecycleProtocol(target.lifecycleProtocolVersion()) && target.kind() == OperationKind.DELETE) {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenantId, sessionId);
        }
        OperationRecord operation = findSessionOperation(tenantId, sessionId, operationId, true)
                .orElseThrow(() -> new IllegalStateException("Session operation is unavailable"));
        Boolean leaseLive =
                jdbc.queryForObject(
                        "SELECT claim_until > " + ManagedSchemaTime.SQL_NOW + " FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ? FOR UPDATE",
                        Boolean.class,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId);
        if (!Boolean.TRUE.equals(leaseLive)
                || !"RUNNING".equals(operation.state())
                || !"LEASED".equals(operation.deliveryState())
                || !owner.equals(operation.leaseOwner())
                || operation.claimGeneration() != claimGeneration) {
            return false;
        }
        if (!pendingStatus(operation.kind()).equals(session.status())) {
            throw new IllegalStateException("Session " + sessionId + " is "
                    + session.status() + " during its "
                    + operation.kind() + " operation");
        }
        if (WorkspaceToolProfiles.lifecycleProtocol(operation.lifecycleProtocolVersion())) {
            if (lifecycle == null) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceLifecycleStore.blocked("workspace_close_identity_unverified");
            }
            lifecycle.verifyCompletion(operation);
        }
        long now = storeRows.lifecycleDatabaseTime();
        if (operation.kind() == OperationKind.DELETE) {
            if (session.workspace() != null && !List.of("CLOSED", "ARCHIVED").contains(operation.sessionStatusBefore())
                    && !WorkspaceToolProfiles.lifecycleProtocol(operation.lifecycleProtocolVersion())) {
                throw new IllegalStateException("Workspace deletion requires a closed Session");
            }
            ToolPublicationRetentionStore.retire(jdbc, tenantId, sessionId, operationId);
        }
        switch (operation.kind()) {
            case CLOSE, ARCHIVE -> jdbc.update("UPDATE ma_session"
                            + " SET status = ?, harness_event_epoch = NULL,"
                            + " harness_last_event_id = 0, gmt_modified = ?,"
                            + " version = version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ?",
                    operation.kind() == OperationKind.CLOSE ? "CLOSED"
                            : "ARCHIVED", now, tenantId, sessionId);
            case DELETE -> jdbc.update("UPDATE ma_session SET"
                            + " status = 'DELETED', harness_boot_id = NULL,"
                            + " harness_event_epoch = NULL,"
                            + " harness_last_event_id = 0, deleted_at = ?,"
                            + " gmt_modified = ?, version = version + 1 WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    now, now, tenantId, sessionId);
        }
        jdbc.update(
                "UPDATE ma_operation SET failure_code = NULL, phase = 'COMPLETED', state ="
                    + " 'COMPLETED', admission_stage = ?, delivery_state = 'CONFIRMED', receipt_id"
                    + " = ?, claim_owner = NULL, claim_until = NULL, gmt_modified = ?, completed_at ="
                    + " ? WHERE scope_key = ? AND operation_kind IN "
                        + AgentStoreRows.SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ?",
                harnessConfirmed ? "HARNESS_CONFIRMED" : "JAVA_DURABLE",
                AgentStoreRows.publicId("rcpt"),
                now,
                now,
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                AgentStoreRows.sessionOperationTarget(sessionId),
                tenantId,
                sessionId,
                operationId);
        eventJournal.appendEvent(tenantId, sessionId, null,
                completedEvent(operation.kind()),
                Map.of("sessionId", sessionId, "operationId", operationId),
                operation.kind() == OperationKind.DELETE,
                AgentEventJournal.operationSource(operationId, "completed"), now);
        return true;
    }

    boolean failOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        long now = storeRows.lifecycleDatabaseTime();
        // The same fencing as completeOperation, and deliberately no
        // Session effect beyond the claim-mirror release below: the Session
        // row keeps its pending status and no completion event is appended,
        // because the settle never succeeded. The receipt
        // the contract requires of every confirmed row certifies nothing —
        // status failed and the failure code carry the outcome.
        // delivery_state CONFIRMED keeps every recovery scan from re-driving
        // the row.
        int updated = jdbc.update("UPDATE ma_operation SET"
                        + " state = 'FAILED', phase = 'FAILED',"
                        + " delivery_state = 'CONFIRMED', failure_code = ?,"
                        + " receipt_id = ?, claim_owner = NULL,"
                        + " claim_until = NULL, gmt_modified = ?,"
                        + " completed_at = ? WHERE scope_key = ? AND"
                        + " operation_kind IN "
                        + AgentStoreRows.SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ? AND"
                        + " state = 'RUNNING' AND delivery_state = 'LEASED'"
                        + " AND claim_owner = ? AND claim_generation = ?"
                        + " AND claim_until > " + ManagedSchemaTime.SQL_NOW,
                failureCode, AgentStoreRows.publicId("rcpt"), now, now,
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                AgentStoreRows.sessionOperationTarget(sessionId), tenantId, sessionId,
                operationId, owner, claimGeneration);
        if (updated == 1) {
            // The terminal write also releases the lifecycle claim mirror a
            // v1 admission raised: nothing will drive this operation again,
            // so the fence row must not stay bound to a dead operation's id.
            // The phase stays LIFECYCLE_ONLY, though — only the completion
            // path flips it to DRAINING, gated on its effects verification,
            // and isHarnessDraining (drainHarnessSession's sole precondition)
            // reads the phase alone: writing DRAINING here would authorize
            // draining a Session whose worker stop was never verified (review
            // round 6, R5-5). retryOperation and blockLifecycleOperation
            // deliberately only NULL the lease — a rescheduled operation is
            // still in flight and must stay admission-closed to everyone
            // else.
            jdbc.update("UPDATE ma_session_head SET"
                            + " operation_id = NULL, claim_lease_until = NULL"
                            + " WHERE tenant_key = ? AND harness_key = ? AND"
                            + " tenant_id = ? AND harness_session_id = ? AND"
                            + " operation_id = ? AND phase = 'LIFECYCLE_ONLY'",
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId, sessionId, operationId);
        }
        return updated == 1;
    }

    boolean renewLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, Duration duration) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = storeRows.lifecycleDatabaseTime();
        int updated =
                jdbc.update(
                        "UPDATE ma_operation SET claim_until = (" + ManagedSchemaTime.SQL_NOW + " + ?), gmt_modified = ? WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        duration.toMillis(),
                        now,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId,
                        owner,
                        generation);
        if (updated == 1) {
            syncLifecycleClaim(tenantId, sessionId, operationId);
        }
        return updated == 1;
    }

    void syncLifecycleClaim(String tenantId, String sessionId, String operationId) {
        var rows =
                jdbc.queryForList(
                        "SELECT lifecycle_protocol_version, claim_generation, FLOOR(claim_until) AS claim_lease_until FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ?",
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId);
        if (!rows.isEmpty()
                && rows.getFirst().get("lifecycle_protocol_version") instanceof Number version
                && WorkspaceToolProfiles.lifecycleProtocol(version.intValue())) {
            var row = rows.getFirst();
            jdbc.update(
                    "UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", claim_generation = ?, claim_lease_until = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND harness_session_id = ? AND operation_id = ? AND (phase = 'LIFECYCLE_ONLY' OR ? = 2 AND phase = 'DRAINING')",
                    row.get("claim_generation"),
                    row.get("claim_lease_until"),
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId,
                    sessionId,
                    operationId, version.intValue());
        }
    }

    void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt,
            boolean budgetExempt) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = storeRows.lifecycleDatabaseTime();
        // The exempt count increments from itself, never from
        // attempt_count: a wait refunds no already-charged attempt, so
        // attempt_count - budget_exempt_attempt stays the count of attempts
        // that could have made progress regardless of interleaving order.
        int updated =
                jdbc.update(
                        "UPDATE ma_operation SET phase = 'RECOVERY_BLOCKED', state ="
                            + " 'RECOVERY_BLOCKED', delivery_state = 'BLOCKED', failure_code = ?,"
                            + " available_at = ?, claim_owner = NULL, claim_until = NULL,"
                            + " gmt_modified = ?,"
                            + (budgetExempt
                                    ? " budget_exempt_attempt = budget_exempt_attempt + 1,"
                                    : "")
                            + " attempt_count = attempt_count + 1 WHERE scope_key ="
                            + " ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        failureCode,
                        Math.addExact(now, Math.max(0, availableAt - clock.millis())),
                        now,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId,
                        owner,
                        generation);
        if (updated == 1) {
            jdbc.update(
                    "UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", claim_lease_until = NULL WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND harness_session_id = ? AND operation_id = ? AND claim_generation = ?",
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId,
                    sessionId,
                    operationId,
                    generation);
        }
    }

    void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt, boolean budgetExempt) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long delay = Math.max(0, availableAt - clock.millis());
        long now = storeRows.lifecycleDatabaseTime();
        availableAt = Math.addExact(now, delay);
        // The exempt count increments from itself, never from
        // attempt_count: a wait refunds no already-charged attempt, so
        // attempt_count - budget_exempt_attempt stays the count of attempts
        // that could have made progress regardless of interleaving order.
        int updated =
                jdbc.update(
                        "UPDATE ma_operation SET delivery_state = 'PENDING', claim_owner = NULL,"
                            + " claim_until = NULL,"
                            + (budgetExempt
                                    ? " budget_exempt_attempt = budget_exempt_attempt + 1,"
                                    : "")
                            + " attempt_count = attempt_count + 1, available_at"
                            + " = ?, gmt_modified = ? WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        availableAt,
                        now,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId,
                        owner,
                        claimGeneration);
        if (updated == 1) {
            jdbc.update(
                    "UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", claim_lease_until = NULL WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND harness_session_id = ? AND operation_id = ? AND claim_generation = ?",
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId,
                    sessionId,
                    operationId,
                    claimGeneration);
        }
    }

    void markOperationAnswered(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = storeRows.lifecycleDatabaseTime();
        // Watermark only: the row stays leased and no reschedule runs here —
        // the catch block's own retryOperation (or a throw losing it) decides
        // what happens next. The point is that the answered fact is durable
        // before any recovery read can throw it away (review round 14,
        // R14-3).
        jdbc.update(
                "UPDATE ma_operation SET budget_exempt_attempt ="
                    + " budget_exempt_attempt + 1, gmt_modified = ? WHERE scope_key = ? AND"
                    + " operation_kind IN "
                        + AgentStoreRows.SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ? AND state = 'RUNNING' AND delivery_state ="
                        + " 'LEASED' AND claim_owner = ? AND claim_generation = ? AND"
                        + " claim_until > " + ManagedSchemaTime.SQL_NOW,
                now,
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                AgentStoreRows.sessionOperationTarget(sessionId),
                tenantId,
                sessionId,
                operationId,
                owner,
                claimGeneration);
    }

    // One lifecycle change at a time: a pending rename or unarchive command
    // blocks an operation, and an open operation blocks both commands.
    /** The latest terminally failed lifecycle operation of the kind: the
     * status the Session carried when it began and the protocol it ran
     * under — both re-pinned by a resumed admission. */
    Optional<FailedLifecycleOperation> latestFailedLifecycleOperation(
            String tenantId, String sessionId, OperationKind kind) {
        var rows = jdbc.query("SELECT operation_id, session_status_before,"
                        + " lifecycle_protocol_version FROM"
                        + " ma_operation WHERE tenant_id = ?"
                        + " AND session_id = ? AND operation_kind = ? AND"
                        + " state = 'FAILED' ORDER BY gmt_modified DESC,"
                        + " gmt_create DESC LIMIT 1",
                (result, row) -> new FailedLifecycleOperation(
                        result.getString(1), result.getString(2),
                        result.getInt(3)),
                tenantId, sessionId, kind.name());
        return rows.isEmpty() ? Optional.empty()
                : Optional.of(rows.getFirst());
    }

    record FailedLifecycleOperation(String operationId,
            String sessionStatusBefore, int lifecycleProtocolVersion) {
    }

    void validateOperationStart(SessionRecord session,
            OperationKind kind) {
        String status = session.status();
        switch (kind) {
            case CLOSE -> AgentSessionPolicies.requireSessionStatus(status, "ACTIVE");
            case ARCHIVE -> AgentSessionPolicies.requireSessionStatus(status, "CLOSED");
            case DELETE -> {
                if (!List.of("ACTIVE", "CLOSED", "ARCHIVED")
                        .contains(status)) {
                    throw AgentSessionPolicies.sessionStateConflict(status);
                }
            }
        }
        if ("ACTIVE".equals(status)
                && (hasLiveTurn(session.tenantId(), session.sessionId())
                        || session.workspace() != null && sessionPolicies.hasDecidableAction(session))) {
            throw new ManagedAgentException(409, "turn_active",
                    "The Session has an active Turn.");
        }
    }

    /**
     * Only a permanently refused workflow leaves this lifecycle gate.
     * Runtime and Harness parks still await authoritative settlement;
     * closing them could discard a later result. Cancellation also waits.
     */
    boolean hasLiveTurn(String tenantId, String sessionId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')"
                        + " AND (status = 'CANCELLING' OR error_code IS NULL"
                        + " OR error_code <> '"
                        + AgentStateStore.WORKFLOW_RECOVERY_BLOCKED + "')",
                Integer.class, tenantId, sessionId);
        return count != null && count > 0;
    }

    // ARCHIVING remains only for an archive admitted before V17, which closes
    // the Harness as archive used to.
    static String pendingStatus(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "CLOSING";
            case ARCHIVE -> "ARCHIVING";
            case DELETE -> "DELETING";
            case ACTION_RESPONSE, CWD_CHANGE, CONTEXT_COMPRESSION, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    static String requestedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.close.requested";
            case ARCHIVE -> "session.archive.requested";
            case DELETE -> "session.delete.requested";
            case ACTION_RESPONSE, CWD_CHANGE, CONTEXT_COMPRESSION, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    static String completedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.closed";
            case ARCHIVE -> "session.archived";
            case DELETE -> "session.deleted";
            case ACTION_RESPONSE, CWD_CHANGE, CONTEXT_COMPRESSION, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }
}
