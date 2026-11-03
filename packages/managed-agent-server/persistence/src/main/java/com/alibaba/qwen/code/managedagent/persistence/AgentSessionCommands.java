package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.RenameDelivery;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

final class AgentSessionCommands {
    private final AgentEventJournal eventJournal;
    private final AgentSessionPolicies sessionPolicies;
    private final AgentStoreRows storeRows;
    private final com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles;
    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final ManagedWorkspaceRegistry workspaces;
    private final boolean workspaceFilesEnabled;
    private final boolean workspaceShellEnabled;

    AgentSessionCommands(AgentEventJournal eventJournal,
            AgentSessionPolicies sessionPolicies,
            AgentStoreRows storeRows,
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles,
            JdbcTemplate jdbc,
            Clock clock,
            ManagedWorkspaceRegistry workspaces,
            boolean workspaceFilesEnabled,
            boolean workspaceShellEnabled) {
        this.eventJournal = eventJournal;
        this.sessionPolicies = sessionPolicies;
        this.storeRows = storeRows;
        this.worktreeFiles = worktreeFiles;
        this.jdbc = jdbc;
        this.clock = clock;
        this.workspaces = workspaces;
        this.workspaceFilesEnabled = workspaceFilesEnabled;
        this.workspaceShellEnabled = workspaceShellEnabled;
    }

    // A bound Session may be renamed under the Workspace-files opt-in
    // (the service checks the caller's Workspace role and the Session's
    // creator-keyed execution facts); unarchive stays gated.
    boolean boundRenameAllowed(SessionMutationKind kind) {
        return kind == SessionMutationKind.RENAME && workspaceFilesEnabled;
    }

    // Input admission records the supplied caller on the command
    // receipt, so the receipt's replay answers the actor who recorded it —
    // an OPERATOR's own retry of his own key — and not only the creator.
    Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            String actorId) {
        // A per-turn admission takes no tenant guard. The Session row orders it
        // against lifecycle begin, requireOpen's locking reads of this storage's
        // alias (fence) and directory rows order it against migration fence
        // installation and physical fencing, and nothing later in this
        // transaction takes the guard. The Session lock comes first, so this
        // transaction's snapshot is taken after it.
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        sessionPolicies.requirePublicChildImmutable(session);
        // A bound Session's later Turn needs the same deployment opt-in as
        // its initial one; the service admits any caller holding OPERATOR
        // on the bound Workspace while the Session's creator-keyed
        // execution facts hold.
        if (session.workspace() != null && !workspaceFilesEnabled) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        // The replay probe must not lock: a FOR UPDATE read that misses
        // next-key-locks a gap of the tenant-shared command index, and
        // concurrent admissions holding such gap locks deadlock when they
        // all try to insert into the same gap. The unique business key deduplicates
        // racing inserts instead, and the service replays on
        // DuplicateKeyException.
        Optional<CommandRecord> existing = findCommand(tenantId, operation,
                idempotencyKey);
        if (existing.isPresent()) {
            return replayCommand(tenantId, operation, idempotencyKey,
                    requestDigest);
        }
        if (WorkspaceToolProfiles.isPublicShell(session.toolProfile()) && !workspaceShellEnabled) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        if (session.workspace() != null) {
            if (sessionPolicies.isSshWorkspace(session.workspace())) {
                AgentSessionPolicies.requireSshToolProfile(session.toolProfile());
                if (sessionPolicies.hasMcpServers(session)) {
                    throw AgentSessionPolicies.workspaceExecutionUnavailable();
                }
            }
            WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
        }
        if (!"ACTIVE".equals(session.status())) {
            throw new ManagedAgentException(409, "session_not_active",
                    "The Session does not accept new Turns.");
        }
        SessionWorktreeStore.requireReady(worktreeFiles, jdbc, tenantId, sessionId);
        ManagedConfigStore.requireOpen(jdbc, tenantId, sessionId);
        if (sessionPolicies.hasActiveTurn(tenantId, sessionId)) {
            throw new ManagedAgentException(409, "turn_active",
                    "The Session already has an active Turn.");
        }
        record QueuedInput(String messageId, String state, String turnId, String actorId, String inputJson) { }
        var queuedInputs = jdbc.query("SELECT message_id, state, turn_id, actor_id, input_json FROM ma_user_message"
                + " WHERE tenant_id = ? AND session_id = ? AND state IN ('queued', 'claimed', 'recovery_blocked')"
                + " ORDER BY sequence_number LIMIT 1",
                (row, index) -> new QueuedInput(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5)), tenantId, sessionId);
        if (!queuedInputs.isEmpty()) {
            var first = queuedInputs.getFirst();
            if (!"claimed".equals(first.state()) || first.turnId() != null
                    || !("user-queue:" + first.messageId()).equals(idempotencyKey) || !Objects.equals(actorId, first.actorId())
                    || !storeRows.readInput(first.inputJson()).equals(input)) {
                throw new ManagedAgentException(409, "user_message_queue_pending", "Send new input through the Session user message queue.");
            }
        }
        // The W2 handshake: an open execution operation on a bound Session
        // is the busy barrier the settlement re-verifies at commit; a
        // later Turn must not slide in underneath it. Narrower than
        // requireNoOpenOperation on purpose: a stuck display mutation
        // (PENDING rename command) or an in-flight ACTION_RESPONSE would
        // otherwise wedge every Turn admission without any recovery scan
        // reading those tables — while the operation-ledger barriers that
        // intentionally cover them stay untouched.
        if (session.workspace() != null
                && sessionPolicies.hasOpenExecutionOperation(tenantId, sessionId)) {
            throw new ManagedAgentException(409,
                    "session_context_busy",
                    "The Session has an open operation.");
        }
        long now = clock.millis();
        String turnId = AgentStoreRows.publicId("turn");
        insertTurn(tenantId, sessionId, turnId,
                UUID.randomUUID().toString(), input, payloadDigest, now);
        byte[] actorKey = commandActorKey(tenantId, actorId);
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, "COMPLETED", null, actorKey, now);
        String operationId = insertTurnCommandOperation(tenantId, sessionId,
                turnId, OperationKind.SUBMIT_INPUT, operation, idempotencyKey,
                requestDigest, actorKey, session.status(), now);
        eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                AgentEventJournal.acceptedData(turnId, input), false, null, now);
        return new Admission(sessionId, turnId, false, true, operationId);
    }

    // Cancellation receipts preserve the caller just as input receipts do.
    Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String actorId) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !workspaceFilesEnabled) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        TurnRecord turn = storeRows.requireTurn(tenantId, sessionId, turnId);
        long now = clock.millis();
        byte[] actorKey = commandActorKey(tenantId, actorId);
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, "COMPLETED", null, actorKey, now);
        String operationId = insertTurnCommandOperation(tenantId, sessionId,
                turnId, OperationKind.CANCEL, operation, idempotencyKey,
                requestDigest, actorKey, session.status(), now);
        boolean commandEffect = AgentStoreRows.ACTIVE_TURN_STATES.contains(turn.status())
                && !"CANCELLING".equals(turn.status());
        if (commandEffect) {
            // D7-2: a user cancel is due at once, never behind the Runtime
            // recovery park's recheck window.
            int updated = jdbc.update("UPDATE ma_turn SET status ="
                            + " 'CANCELLING', retry_after = NULL, gmt_modified = ?,"
                            + " version = version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ? AND turn_id = ? AND status IN"
                            + " ('ACCEPTED', 'RUNNING')",
                    now, tenantId, sessionId, turnId);
            commandEffect = updated == 1;
            if (commandEffect) {
                eventJournal.appendEvent(tenantId, sessionId, turnId,
                        "turn.cancel.requested", Map.of("turnId", turnId),
                        false, null, now);
            }
        }
        if (!commandEffect) {
            // The Turn read before insertCommand can be a stale snapshot
            // while another transaction already made it terminal. Re-read
            // it FOR UPDATE and settle this new cancel from the current
            // row; a CANCELLING Turn still carries it with the earlier one.
            TurnRecord current = storeRows.requireTurnForUpdate(tenantId, sessionId,
                    turnId);
            boolean cancelled = "CANCELLED".equals(current.status());
            if (cancelled || !AgentStoreRows.ACTIVE_TURN_STATES.contains(current.status())) {
                settleTurnCommand(tenantId, sessionId, turnId,
                        OperationKind.CANCEL,
                        cancelled ? "COMPLETED" : "FAILED",
                        cancelled && current.harnessEventEpoch() != null
                                ? "HARNESS_CONFIRMED" : "JAVA_DURABLE",
                        cancelled ? null : "turn_already_settled", now);
            }
        }
        return new Admission(sessionId, turnId, false, commandEffect,
                operationId);
    }

    SessionMutationCommand beginSessionRename(String tenantId, String key,
            String digest, String sessionId, String title, String actorId) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        // Tenant and Session locks serialize admission without gap-locking missing index entries.
        Optional<CommandRecord> previous = findCommand(tenantId, "RENAME_SESSION", key, false);
        if (previous.isPresent()
                && sessionId.equals(previous.get().sessionId())) {
            requireRenameReplayOwner(session, previous.get(), actorId);
        }
        var retained =
                jdbc.queryForList(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'RENAME' AND target_key"
                            + " = ? AND idempotency_digest = ? AND tenant_id = ? AND session_id = ?"
                            + " ORDER BY target_revision DESC LIMIT 1 FOR UPDATE",
                        AgentStoreRows.renameTarget(tenantId, sessionId),
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                                key),
                        tenantId,
                        sessionId);
        if (!retained.isEmpty()) {
            Map<String, Object> row = retained.getFirst();
            if (!key.equals(row.get("idempotency_key")) || !digest.equals(row.get("request_digest"))
                    || !title.equals(storeRows.readMap((String) row.get("request_json")).get("title"))) {
                throw new ManagedAgentException(
                        409,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            if ("SUPERSEDED".equals(row.get("state"))) {
                throw new ManagedAgentException(
                        409,
                        "session_mutation_superseded",
                        "A later Session title attempt has been admitted.");
            }
            // A parked delivery awaits the reconciler and is never re-sent.
            if ("RECOVERY_BLOCKED".equals(row.get("state"))) {
                throw new ManagedAgentException(
                        409,
                        "operation_outcome_unknown",
                        "The original title delivery is awaiting reconciliation.");
            }
        }
        // A delivery the reconciler proved never landed is FAILED: the key
        // retries under a new revision, as any failed title key does.
        if (!retained.isEmpty() && !"FAILED".equals(retained.getFirst().get("state"))) {
            Map<String, Object> row = retained.getFirst();
            return new SessionMutationCommand(
                    sessionId,
                    "COMPLETED".equals(row.get("state")) ? "COMPLETED" : "PENDING",
                    true,
                    ((Number) row.get("target_revision")).longValue());
        }
        SessionMutationCommand command =
                beginSessionMutation(
                        tenantId,
                        "RENAME_SESSION",
                        key,
                        digest,
                        sessionId,
                        SessionMutationKind.RENAME,
                        actorId);
        if ("COMPLETED".equals(command.status())) {
            return command;
        }
        Long revision =
                jdbc.queryForObject(
                        "SELECT title_revision FROM ma_session WHERE tenant_id = ?"
                                + " AND session_id = ? AND session_kind = 'PUBLIC'",
                        Long.class,
                        tenantId,
                        sessionId);
        long next = Math.addExact(revision, 1);
        long now = clock.millis();
        jdbc.update(
                "UPDATE ma_session SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", title_revision = ? WHERE tenant_id = ? AND session_id = ?",
                next,
                tenantId,
                sessionId);
        jdbc.update(
                "UPDATE ma_operation SET state = 'SUPERSEDED', delivery_state = 'COMPLETED', phase"
                    + " = 'SUPERSEDED', gmt_modified = ? WHERE operation_kind = 'RENAME' AND"
                    + " target_key = ? AND target_revision < ? AND state IN ('PENDING', 'RUNNING',"
                    + " 'RECOVERY_BLOCKED')",
                now,
                AgentStoreRows.renameTarget(tenantId, sessionId),
                next);
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " operation_id, operation_kind, tenant_id, session_id, target_kind,"
                    + " target_key, target_revision, idempotency_key, idempotency_digest,"
                    + " request_digest, request_json, state, phase, delivery_state, available_at,"
                    + " gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'RENAME', ?, ?, 'SESSION', ?,"
                    + " ?, ?, ?, ?, ?, 'PENDING', 'ADMITTED', 'PENDING', ?, ?, ?)",
                renameKey(tenantId, sessionId, next),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                "rename:" + next,
                tenantId,
                sessionId,
                AgentStoreRows.renameTarget(tenantId, sessionId),
                next,
                key,
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(key),
                digest,
                storeRows.writeJson(Map.of("title", title)),
                now,
                now,
                now);
        return new SessionMutationCommand(sessionId, "PENDING", command.replayed(), next);
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
        if (!previous.admitsReplayBy(actorId) && session.workspace() != null
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

    SessionRecord completeSessionRename(String tenantId, String key, String sessionId,
            String title, String bootId, long revision) {
        return settleRename(new RenameDelivery(tenantId, sessionId, key, title, revision, 0), null, bootId);
    }

    SessionRecord completeSessionRename(RenameDelivery delivery, String owner, String bootId) {
        return settleRename(delivery, owner, bootId);
    }

    SessionRecord settleRename(RenameDelivery delivery, String owner, String bootId) {
        String tenantId = delivery.tenantId();
        String sessionId = delivery.sessionId();
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        var rows =
                jdbc.queryForList(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_key = ? AND operation_kind ="
                            + " 'RENAME' AND tenant_id = ? AND session_id = ? FOR UPDATE",
                        renameKey(tenantId, sessionId, delivery.revision()),
                        tenantId,
                        sessionId);
        Long currentRevision =
                jdbc.queryForObject(
                        "SELECT title_revision FROM ma_session WHERE tenant_id = ?"
                                + " AND session_id = ?",
                        Long.class,
                        tenantId,
                        sessionId);
        if (rows.size() != 1
                || currentRevision != delivery.revision()
                || !delivery.idempotencyKey().equals(rows.getFirst().get("idempotency_key"))
                || !delivery.title()
                        .equals(
                                storeRows.readMap((String) rows.getFirst().get("request_json"))
                                        .get("title"))) {
            throw new ManagedAgentException(
                    409,
                    "session_mutation_superseded",
                    "A later Session title attempt has been admitted.");
        }
        Map<String, Object> operation = rows.getFirst();
        if (owner == null
                ? !"PENDING".equals(operation.get("state"))
                : !owner.equals(operation.get("claim_owner"))
                        || delivery.claimGeneration()
                                != ((Number) operation.get("claim_generation")).longValue()
                        || !List.of("RUNNING", "RECOVERY_BLOCKED")
                                .contains(operation.get("state"))) {
            throw new ManagedAgentException(
                    409,
                    "operation_claim_lost",
                    "The title delivery claim was lost.");
        }
        jdbc.update(
                "UPDATE ma_request_receipt SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = 'PENDING' WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND' AND state = 'FAILED'",
                ManagedReceipts.commandKey(tenantId, "RENAME_SESSION", delivery.idempotencyKey()));
        SessionRecord session =
                completeSessionMutation(
                        tenantId,
                        "RENAME_SESSION",
                        delivery.idempotencyKey(),
                        sessionId,
                        SessionMutationKind.RENAME,
                        delivery.title(),
                        bootId);
        // A parked delivery answered late by its own claim was confirmed by
        // the Harness after all.
        boolean parked = !"RUNNING".equals(operation.get("state"))
                && !"PENDING".equals(operation.get("state"));
        jdbc.update(
                "UPDATE ma_operation SET state = 'COMPLETED', phase = 'COMPLETED', delivery_state ="
                    + " 'COMPLETED', claim_owner = NULL, claim_until = NULL, gmt_modified = ?,"
                    + " completed_at = ?"
                    + (parked ? ", admission_stage = 'HARNESS_CONFIRMED', failure_code = NULL" : "")
                    + " WHERE operation_key = ?",
                clock.millis(),
                clock.millis(),
                renameKey(tenantId, sessionId, delivery.revision()));
        return session;
    }

    void abandonSessionRename(String tenantId, String key, String sessionId, long revision, String owner) {
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_operation WHERE operation_key = ? AND operation_kind = 'RENAME' AND state = 'RUNNING' AND claim_owner = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        Integer.class,
                        renameKey(tenantId, sessionId, revision),
                        owner)
                == 1) {
            abandonSessionMutation(tenantId, "RENAME_SESSION", key, sessionId);
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

    // Mutation receipts preserve the caller just as input receipts do.
    SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !boundRenameAllowed(kind)) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        Optional<CommandRecord> existing = findCommand(tenantId, operation,
                idempotencyKey, kind != SessionMutationKind.RENAME);
        if (existing.isPresent()) {
            CommandRecord command = existing.get();
            if (!command.requestDigest().equals(requestDigest)
                    || !command.sessionId().equals(sessionId)) {
                throw new ManagedAgentException(409,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            if ("FAILED".equals(command.status())) {
                if (session.workspace() != null) {
                    WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
                }
                sessionPolicies.requireNoOpenOperation(tenantId, sessionId);
                validateMutationStatus(session, kind);
                jdbc.update(
                        "UPDATE ma_request_receipt SET state = 'PENDING', mutation_attempt_sequence"
                            + " = ?, gmt_modified = ? WHERE receipt_key = ? AND namespace ="
                            + " 'SESSION_COMMAND'",
                        session.lastSequence(),
                        clock.millis(),
                        ManagedReceipts.commandKey(tenantId, operation, idempotencyKey));
                return new SessionMutationCommand(sessionId, "PENDING", true);
            }
            return new SessionMutationCommand(sessionId, command.status(),
                    true);
        }
        if (session.workspace() != null) {
            WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
        }
        sessionPolicies.requireNoOpenOperation(tenantId, sessionId);
        validateMutationStatus(session, kind);
        long now = clock.millis();
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, null, "PENDING", session.status(),
                commandActorKey(tenantId, actorId), now);
        jdbc.update("UPDATE ma_request_receipt SET gmt_modified = " + ManagedSchemaTime.SQL_NOW
                        + ", mutation_attempt_sequence"
                        + " = ? WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND'",
                session.lastSequence(), ManagedReceipts.commandKey(tenantId, operation, idempotencyKey));
        // Older retired commands may have left their requested event behind.
        String requestedSource = mutationSource(operation, idempotencyKey,
                "requested");
        if (!eventJournal.hasSourceEvent(tenantId, sessionId, requestedSource)) {
            eventJournal.appendEvent(tenantId, sessionId, null,
                    mutationEvent(kind, "requested"),
                    Map.of("sessionId", sessionId), false,
                    requestedSource, now);
        }
        return new SessionMutationCommand(sessionId, "PENDING", false);
    }

    SessionRecord completeSessionMutation(String tenantId,
            String operation, String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !boundRenameAllowed(kind)) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        CommandRecord command = findCommand(tenantId, operation,
                idempotencyKey, true).orElseThrow(() ->
                        new IllegalStateException(
                                "Session mutation command is unavailable"));
        if (!command.sessionId().equals(sessionId)) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict",
                    "The idempotency key belongs to another Session.");
        }
        if ("COMPLETED".equals(command.status())) {
            return session;
        }
        if (!"PENDING".equals(command.status())
                && !"FAILED".equals(command.status())) {
            throw new IllegalStateException(
                    "Session mutation command has an unknown status");
        }
        // A retired receipt still completes for a sibling that entered the
        // Harness before the retirement, but never over a later mutation:
        // while it was FAILED another key could begin and complete, and
        // completing this one now would revert that newer outcome.
        if ("FAILED".equals(command.status()) && supersededByLaterMutation(
                tenantId, sessionId, operation, idempotencyKey, kind)) {
            throw new ManagedAgentException(409,
                    "session_mutation_superseded",
                    "A later change to the Session completed after this"
                            + " request was retired.");
        }
        if (session.workspace() != null) {
            WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
        }
        validateMutationStatus(session, kind);
        long now = clock.millis();
        Map<String, Object> data = Map.of("sessionId", sessionId);
        switch (kind) {
            case RENAME -> {
                jdbc.update("UPDATE ma_session SET title = ?,"
                                + " harness_boot_id ="
                                + " COALESCE(harness_boot_id, ?),"
                                + " gmt_modified = ?, version = version + 1"
                                + " WHERE tenant_id = ? AND session_id = ?",
                        title, harnessBootId, now, tenantId, sessionId);
                data = Map.of("sessionId", sessionId,
                        "metadata", Map.of("title", title));
            }
            // An archived Session was closed first, so it stays closed.
            case UNARCHIVE -> jdbc.update("UPDATE ma_session SET"
                            + " status = 'CLOSED', gmt_modified = ?, version ="
                            + " version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ?",
                    now, tenantId, sessionId);
        }
        jdbc.update(
                "UPDATE ma_request_receipt SET state = 'COMPLETED', gmt_modified = ? WHERE"
                    + " receipt_key = ? AND namespace = 'SESSION_COMMAND'",
                now,
                ManagedReceipts.commandKey(tenantId, operation, idempotencyKey));
        eventJournal.appendEvent(tenantId, sessionId, null,
                mutationEvent(kind, "completed"), data, false,
                mutationSource(operation, idempotencyKey,
                        "completed"), now);
        return storeRows.requireSessionForUpdate(tenantId, sessionId);
    }

    void abandonSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        // Keep the digest and receipt for replay and concurrent completion.
        // A completed outcome must never be overwritten by a failing sibling.
        jdbc.update("UPDATE ma_request_receipt SET state = 'FAILED',"
                        + " gmt_modified = ? WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND'"
                        + " AND session_id = ? AND state = 'PENDING'",
                clock.millis(), ManagedReceipts.commandKey(tenantId, operation, idempotencyKey), sessionId);
    }

    // A Turn CANCEL parked cancel_unconfirmed is in ACCEPTANCE_UNKNOWN_KINDS
    // (decision 11): the reconciler settles it from CancelEvidence, which
    // reads the original prompt's retained durable terminal event, and the
    // row is never claimed or delivered again.
    /** Turn input whose submission no Harness answered (D7-2). */
    static final String SUBMIT_INPUT_UNCONFIRMED = "submit_input_unconfirmed";

    /** A Turn cancel whose effect on an unobserved execution no Harness
     * answered (D7-2). */
    static final String CANCEL_UNCONFIRMED = "cancel_unconfirmed";

    /** A Session title whose submitted delivery no Harness answered (D7-2). */
    static final String SESSION_TITLE_UNCONFIRMED = "session_title_unconfirmed";

    // A RENAME parks with the same columns either way: acceptance unknown,
    // never re-sent, settled only by the reconciler or by the same claim's
    // own late reply. Its claim fields stay, so that late reply still settles.
    static final String PARK_RENAME = "state = 'RECOVERY_BLOCKED',"
            + " phase = 'RECOVERY_BLOCKED', admission_stage = 'JAVA_DURABLE',"
            + " delivery_state = 'BLOCKED', failure_code = '"
            + SESSION_TITLE_UNCONFIRMED + "'";

    String insertTurnCommandOperation(String tenantId,
            String sessionId, String turnId, OperationKind kind,
            String command, String idempotencyKey, String requestDigest,
            byte[] actorKey, String sessionStatus, long now) {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String target = turnOperationTarget(turnId);
        String operationId = AgentStoreRows.publicId("op");
        String operationKey = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind.valueOf(kind.name()),
                scope, target, operationId);
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " target_kind, target_key, target_id, phase, request_json,"
                    + " idempotency_digest, tenant_id, session_id, operation_id, operation_kind,"
                    + " actor_key, idempotency_key, request_digest, state, admission_stage,"
                    + " delivery_state, session_status_before, available_at, gmt_create,"
                    + " gmt_modified) VALUES (?, ?, ?, 'TURN', ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?,"
                    + " ?, ?, ?, 'PENDING', 'JAVA_DURABLE', 'PENDING', ?, ?, ?, ?)",
                operationKey,
                scope,
                scope,
                target,
                turnId,
                storeRows.writeJson(Map.of("schemaVersion", 1, "kind", kind.name(),
                        "sessionId", sessionId, "turnId", turnId)),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                        idempotencyKey),
                tenantId,
                sessionId,
                operationId,
                kind.name(),
                actorKey,
                idempotencyKey,
                requestDigest,
                sessionStatus,
                now,
                now,
                now);
        ManagedReceipts.linkCommandOperation(jdbc, tenantId, command,
                idempotencyKey, operationKey);
        return operationId;
    }

    static String turnOperationTarget(String turnId) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(turnId);
    }

    /**
     * Settles the open input and cancel operations of a Turn from the Turn's
     * own committed facts, in the transaction that commits them. Input is
     * accepted once the Turn holds a Harness event epoch, the fact its
     * dispatcher records when a Harness admits the Turn; until then a
     * cancelled or failed Turn ends the input undelivered. A cancel
     * completes when the Turn is cancelled — by the Harness, or by Java
     * before any Harness admitted it — and fails turn_already_settled when
     * the Turn ended otherwise. One whose admitted Turn failed with
     * managed_runtime_recovery_blocked parks recovery_blocked with
     * cancel_unconfirmed: the cancel's effect on the unobserved execution
     * is itself unknown. A Turn that has not ended leaves its cancels
     * pending, so cancels of one Turn coalesce.
     */
    void settleTurnCommands(String tenantId, String sessionId,
            String turnId, long now) {
        // Current reads only: every caller holds the Session row, but its
        // snapshot may predate that lock and miss a cancel committed since.
        TurnRecord turn = storeRows.requireTurnForUpdate(tenantId, sessionId, turnId);
        boolean admitted = turn.harnessEventEpoch() != null;
        if (admitted) {
            settleTurnCommand(tenantId, sessionId, turnId,
                    OperationKind.SUBMIT_INPUT, "COMPLETED", "HARNESS_CONFIRMED",
                    null, now);
        } else if ("CANCELLED".equals(turn.status())) {
            settleTurnCommand(tenantId, sessionId, turnId,
                    OperationKind.SUBMIT_INPUT, "CANCELLED", "JAVA_DURABLE",
                    null, now);
        } else if ("FAILED".equals(turn.status())
                && turn.submissionAttempted()) {
            // A null epoch does not prove non-admission (R10-4): the submit
            // may have been admitted and its reply lost. The input parks
            // until the Session journal proves which (D7-2).
            settleTurnCommand(tenantId, sessionId, turnId,
                    OperationKind.SUBMIT_INPUT, "RECOVERY_BLOCKED",
                    "JAVA_DURABLE", SUBMIT_INPUT_UNCONFIRMED, now);
        } else if ("FAILED".equals(turn.status())) {
            settleTurnCommand(tenantId, sessionId, turnId,
                    OperationKind.SUBMIT_INPUT, "FAILED", "JAVA_DURABLE",
                    turn.errorCode(), now);
        }
        if ("CANCELLED".equals(turn.status())) {
            settleTurnCommand(tenantId, sessionId, turnId,
                    OperationKind.CANCEL, "COMPLETED",
                    admitted ? "HARNESS_CONFIRMED" : "JAVA_DURABLE", null, now);
        } else if (!AgentStoreRows.ACTIVE_TURN_STATES.contains(turn.status())) {
            if ((admitted || turn.submissionAttempted())
                    && "managed_runtime_recovery_blocked".equals(
                            turn.errorCode())) {
                // Under the Session row lock, every cancel still pending
                // here predates the failure; a cancel admitted afterwards
                // settles itself in insertCancelCommand. A submission mark
                // is enough: a null epoch does not prove non-admission
                // (R10-4).
                settleTurnCommand(tenantId, sessionId, turnId,
                        OperationKind.CANCEL, "RECOVERY_BLOCKED",
                        "JAVA_DURABLE", CANCEL_UNCONFIRMED, now);
            } else {
                settleTurnCommand(tenantId, sessionId, turnId,
                        OperationKind.CANCEL, "FAILED", "JAVA_DURABLE",
                        "turn_already_settled", now);
            }
        }
    }

    // Only a completed operation is delivered and carries a receipt; a
    // failed or cancelled one stays java_durable and blocked, so it is never
    // delivered again. A parked submit_input or Turn cancel is due for the
    // reconciler at once (decision 11).
    void settleTurnCommand(String tenantId, String sessionId,
            String turnId, OperationKind kind, String state,
            String admissionStage, String failureCode, long now) {
        boolean completed = "COMPLETED".equals(state);
        boolean parked = "RECOVERY_BLOCKED".equals(state);
        // The identity index confines this locking scan to the Turn's own
        // operations. Left to the optimizer, a long settled history steers it
        // to a (kind, state) index whose range holds every Session's pending
        // rows, and two Sessions' settles then deadlock. H2 skips the hint.
        for (String operationKey : jdbc.queryForList("SELECT operation_key"
                        + " FROM ma_operation /*! FORCE INDEX (uk_ma_operation_identity) */"
                        + " WHERE scope_key = ? AND"
                        + " operation_kind = ? AND target_key = ? AND state ="
                        + " 'PENDING' FOR UPDATE",
                String.class,
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                kind.name(), turnOperationTarget(turnId))) {
            jdbc.update("UPDATE ma_operation SET state = ?, phase = ?,"
                            + " admission_stage = ?, delivery_state = ?,"
                            + " receipt_id = ?, failure_code = ?,"
                            + " available_at = ?, gmt_modified = ?,"
                            + " completed_at = ? WHERE"
                            + " operation_key = ? AND state = 'PENDING'",
                    state, state, admissionStage,
                    completed ? "CONFIRMED" : "BLOCKED",
                    completed ? AgentStoreRows.publicId("rcpt") : null, failureCode, now,
                    now, parked ? null : now, operationKey);
        }
    }

    Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        ManagedReceipts.Receipt command = ManagedReceipts.command(jdbc,
                tenantId, operation, idempotencyKey, false);
        if (command == null) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict",
                    "The idempotency key is already in use.");
        }
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        String operationId = command.resultOperationKey() == null ? null
                : jdbc.queryForObject("SELECT operation_id FROM ma_operation"
                                + " WHERE operation_key = ?", String.class,
                        command.resultOperationKey());
        return new Admission(command.sessionId(), command.turnId(), true,
                false, operationId);
    }

    Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey) {
        return findCommand(tenantId, operation, idempotencyKey, false);
    }

    Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey, boolean forUpdate) {
        ManagedReceipts.Receipt row = ManagedReceipts.command(jdbc, tenantId, operation, idempotencyKey, forUpdate);
        if (row == null) {
            return Optional.empty();
        }
        return Optional.of(
                new CommandRecord(
                        tenantId,
                        operation,
                        idempotencyKey,
                        row.requestDigest(), row.sessionId(), row.turnId(), row.state(),
                        row.sessionStatusBefore(), row.actorKey(), row.createdAt(), row.updatedAt()));
    }

    void insertTurn(String tenantId, String sessionId,
            String turnId, String promptId, List<Map<String, Object>> input,
            String payloadDigest, long now) {
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, gmt_create, gmt_modified, model_id, model_revision, approval_mode, approval_revision, is_plan_enabled, permission_rules_json) SELECT"
                        + " ?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, ?, model_id,"
                        + " CASE WHEN model_id IS NULL THEN NULL ELSE model_revision END,"
                        + " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
                        + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
                        + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
                        + " 'hosted-workspace-shell/1','hosted-workspace-files/3')"
                        + " THEN COALESCE(selected_approval_mode, approval_mode) ELSE NULL END,"
                        + " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
                        + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
                        + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
                        + " 'hosted-workspace-shell/1','hosted-workspace-files/3')"
                        + " THEN approval_revision ELSE NULL END,"
                        + " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
                        + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
                        + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
                        + " 'hosted-workspace-shell/1','hosted-workspace-files/3')"
                        + " THEN is_plan_enabled ELSE NULL END,"
                        + " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
                        + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
                        + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
                        + " 'hosted-workspace-shell/1','hosted-workspace-files/3')"
                        + " THEN permission_rules_json ELSE NULL END"
                        + " FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                tenantId, sessionId, turnId, promptId, storeRows.writeJson(input),
                payloadDigest, now, now, "qwen-code".getBytes(StandardCharsets.UTF_8),
                "qwen-code".getBytes(StandardCharsets.UTF_8), "qwen-code".getBytes(StandardCharsets.UTF_8),
                "qwen-code".getBytes(StandardCharsets.UTF_8), "qwen-code".getBytes(StandardCharsets.UTF_8),
                "qwen-code".getBytes(StandardCharsets.UTF_8), "qwen-code".getBytes(StandardCharsets.UTF_8),
                "qwen-code".getBytes(StandardCharsets.UTF_8), tenantId, sessionId);
    }

    void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, long now) {
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, "COMPLETED", now);
    }

    void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, long now) {
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, status, null, null, now);
    }

    void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, String sessionStatusBefore,
            byte[] actorKey, long now) {
        ManagedReceipts.insertCommand(jdbc, tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, status, sessionStatusBefore, actorKey, now);
    }

    // null for an actor id the registry key cannot encode: ManagedReceipts
    // stamps the receipt UNATTRIBUTED, which answers to the creator gate
    // alone.
    static byte[] commandActorKey(String tenantId, String actorId) {
        if (actorId == null) {
            return null;
        }
        try {
            return com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    // A mutation leaves the status unchanged until it completes.
    static void validateMutationStatus(SessionRecord session,
            SessionMutationKind kind) {
        AgentSessionPolicies.requireSessionStatus(session.status(),
                kind == SessionMutationKind.RENAME ? "ACTIVE" : "ARCHIVED");
    }

    static String mutationEvent(SessionMutationKind kind,
            String phase) {
        if ("completed".equals(phase)) {
            return kind == SessionMutationKind.RENAME ? "session.updated"
                    : "session.unarchived";
        }
        return "session."
                + (kind == SessionMutationKind.RENAME ? "update" : "unarchive")
                + "." + phase;
    }

    // The Session lock orders each new attempt against committed events.
    // Legacy receipts fall back to their original requested event; a
    // re-drive refreshes the boundary without appending another event.
    boolean supersededByLaterMutation(String tenantId,
            String sessionId, String operation, String idempotencyKey,
            SessionMutationKind kind) {
        List<Long> attempts =
                jdbc.queryForList(
                        "SELECT COALESCE( c.mutation_attempt_sequence, e.sequence_id) FROM"
                            + " ma_request_receipt c LEFT JOIN ma_public_event e ON e.tenant_id ="
                            + " c.tenant_id AND e.session_id = c.session_id AND e.stream_kind ="
                            + " 'SESSION' AND e.stream_id = X'' AND e.source_key = ? WHERE"
                            + " c.namespace = 'SESSION_COMMAND' AND c.receipt_key = ? AND"
                            + " c.session_id = ?",
                        Long.class,
                        mutationSource(operation, idempotencyKey, "requested"),
                        ManagedReceipts.commandKey(tenantId, operation, idempotencyKey),
                        sessionId);
        if (attempts.isEmpty() || attempts.getFirst() == null) {
            return false;
        }
        Integer later =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                            + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND"
                            + " sequence_id > ? AND event_type = ? AND source_key LIKE 'control:%'",
                        Integer.class,
                        tenantId,
                        sessionId,
                        attempts.getFirst(),
                        mutationEvent(kind, "completed"));
        return later != null && later > 0;
    }

    static String mutationSource(String operation,
            String idempotencyKey, String phase) {
        return "control:" + operation + ":" + idempotencyKey + ":" + phase;
    }
}
