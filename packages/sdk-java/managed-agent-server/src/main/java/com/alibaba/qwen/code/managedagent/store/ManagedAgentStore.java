package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemPartRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Repository
public class ManagedAgentStore implements AgentStateStore {
    private static final TypeReference<List<Map<String, Object>>> INPUT_TYPE =
            new TypeReference<>() {
            };
    private static final TypeReference<Map<String, Object>> MAP_TYPE =
            new TypeReference<>() {
            };
    private static final TypeReference<List<ItemRecord>> ITEMS_TYPE =
            new TypeReference<>() {
            };
    private static final String MESSAGE_PROJECTION = "message_projection";
    private static final List<String> ACTIVE_TURN_STATES = List.of(
            "ACCEPTED", "RUNNING", "CANCELLING");
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final CommittedEventPublisher eventPublisher;
    private final ManagedWorkspaceRegistry workspaces;
    private final RowMapper<SessionRecord> sessionMapper = (result, row) ->
            new SessionRecord(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getString("agent_id"), result.getString("title"),
                    result.getString("status"),
                    result.getString("harness_boot_id"),
                    result.getString("harness_event_epoch"),
                    result.getLong("harness_last_event_id"),
                    result.getLong("last_sequence"),
                    result.getLong("created_at"),
                    result.getLong("updated_at"),
                    nullableLong(result, "deleted_at"),
                    result.getLong("version"), readBinding(result));
    private final RowMapper<TurnRecord> turnMapper = (result, row) ->
            new TurnRecord(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getString("turn_id"),
                    result.getString("prompt_id"),
                    readInput(result.getString("input_json")),
                    result.getString("payload_digest"),
                    result.getString("status"),
                    result.getBoolean("submission_attempted"),
                    result.getString("harness_event_epoch"),
                    nullableLong(result, "harness_last_event_id"),
                    result.getString("dispatch_owner"),
                    nullableLong(result, "dispatch_lease_until"),
                    result.getInt("retry_count"),
                    nullableLong(result, "retry_after"),
                    result.getString("error_code"),
                    result.getString("error_message"),
                    result.getLong("created_at"),
                    result.getLong("updated_at"),
                    nullableLong(result, "completed_at"),
                    result.getLong("version"));
    private final RowMapper<EventRecord> eventMapper = (result, row) ->
            new EventRecord(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getLong("sequence_id"),
                    result.getString("event_id"),
                    result.getString("turn_id"),
                    result.getString("event_type"),
                    readMap(result.getString("data_json")),
                    result.getBoolean("terminal"),
                    result.getString("source_key"),
                    result.getLong("created_at"));
    private final RowMapper<ItemRow> itemMapper = (result, row) ->
            new ItemRow(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getString("item_id"),
                    result.getString("turn_id"),
                    result.getString("item_type"),
                    result.getString("item_role"),
                    result.getString("item_status"),
                    readMap(result.getString("attributes_json")),
                    result.getLong("first_sequence"),
                    result.getLong("last_sequence"),
                    result.getLong("created_at"),
                    result.getLong("updated_at"),
                    result.getLong("revision"));
    private final RowMapper<ItemPartRow> partMapper = (result, row) ->
            new ItemPartRow(result.getString("item_id"),
                    new ItemPartRecord(result.getString("part_id"),
                            result.getString("part_type"),
                            result.getString("part_text"),
                            result.getLong("first_sequence"),
                            result.getLong("last_sequence"),
                            result.getLong("created_at"),
                            result.getLong("updated_at"),
                            result.getLong("revision")));

    public ManagedAgentStore(JdbcTemplate jdbc, ObjectMapper objectMapper,
            Clock clock, CommittedEventPublisher eventPublisher,
            ManagedWorkspaceRegistry workspaces) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.eventPublisher = eventPublisher;
        this.workspaces = workspaces;
    }

    @Override
    @Transactional
    public Admission insertSessionCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String title, List<Map<String, Object>> input,
            String payloadDigest) {
        return insertSession(tenantId, operation, idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                null, null);
    }

    @Override
    @Transactional
    public Admission insertWorkspaceSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest,
            String agentId, String title, List<Map<String, Object>> input,
            String payloadDigest, WorkspaceSelection selection) {
        if (!input.isEmpty()) {
            throw workspaceExecutionUnavailable();
        }
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (!existing.isEmpty()) {
            return replayWorkspaceCommand(tenantId, actorId,
                    requestDigest, existing.getFirst());
        }
        ResolvedBinding workspace = workspaces.resolveForCreation(
                tenantId, actorId, selection);
        return insertSession(tenantId, "CREATE_SESSION", idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                workspace, actorId);
    }

    @Override
    @Transactional
    public Admission replayWorkspaceSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest) {
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (existing.isEmpty()) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict", "The creation command is missing.");
        }
        return replayWorkspaceCommand(tenantId, actorId, requestDigest,
                existing.getFirst());
    }

    private Admission replayWorkspaceCommand(String tenantId, String actorId,
            String requestDigest, WorkspaceCommand command) {
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        ContextBinding bound = requireSession(tenantId,
                command.sessionId()).workspace();
        if (bound == null) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "workspace_unavailable", "Workspace binding is missing.");
        }
        if (!workspaces.canRead(tenantId, actorId, bound.getWorkspaceId())) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "workspace_not_found", "Workspace not found.");
        }
        return new Admission(command.sessionId(), command.turnId(), true,
                false);
    }

    // H2 truncates bare BINARY casts; the suffix also prevents NUL-padding aliases.
    private List<WorkspaceCommand> findWorkspaceCommand(String tenantId,
            String actorId, String idempotencyKey) {
        return jdbc.query("SELECT request_digest, session_id, turn_id"
                        + " FROM managed_workspace_create_command"
                        + " WHERE CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND actor_id = ?"
                        + " AND CAST(CONCAT(idempotency_key, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))",
                (result, row) -> new WorkspaceCommand(
                        result.getString("request_digest"),
                        result.getString("session_id"),
                        result.getString("turn_id")),
                tenantId, ManagedWorkspaceRegistry.actorKey(tenantId, actorId),
                idempotencyKey);
    }

    private record WorkspaceCommand(String requestDigest, String sessionId,
            String turnId) {
    }

    private static ApiException workspaceExecutionUnavailable() {
        return new ApiException(HttpStatus.CONFLICT,
                "workspace_unavailable",
                "Hosted Workspace execution is not available.");
    }

    private Admission insertSession(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved,
            String actorId) {
        ContextBinding workspace = resolved == null ? null
                : resolved.binding();
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
        String turnId = input.isEmpty() ? null : publicId("turn");
        String promptId = input.isEmpty() ? null
                : UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, title, status, created_at,"
                        + " updated_at, workspace_id, workspace_generation,"
                        + " workspace_storage_id, cwd_relative,"
                        + " context_config_ref, context_revision,"
                        + " workspace_config_ref, workspace_policy_ref)"
                        + " VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tenantId, sessionId, agentId, title, now, now,
                workspace == null ? null : workspace.getWorkspaceId(),
                workspace == null ? null : workspace.getWorkspaceGeneration(),
                workspace == null ? null : workspace.getStorageId(),
                workspace == null ? null : workspace.getCwdRelative(),
                workspace == null ? null : workspace.getContextConfigRef(),
                workspace == null ? null : workspace.getContextRevision(),
                resolved == null ? null : resolved.configRef(),
                resolved == null ? null : resolved.policyRef());
        jdbc.update("INSERT INTO managed_agent_consumer_progress"
                        + " (tenant_id, session_id, consumer_name,"
                        + " covered_sequence, updated_at) VALUES"
                        + " (?, ?, ?, 0, ?)",
                tenantId, sessionId, MESSAGE_PROJECTION, now);
        if (turnId != null) {
            insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
        }
        if (actorId == null) {
            insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                    sessionId, turnId, now);
        } else {
            jdbc.update("INSERT INTO managed_workspace_create_command"
                            + " (tenant_id, actor_id, idempotency_key,"
                            + " request_digest, session_id, turn_id, created_at)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    tenantId, ManagedWorkspaceRegistry.actorKey(tenantId,
                            actorId), idempotencyKey, requestDigest,
                    sessionId, turnId, now);
        }
        appendEvent(tenantId, sessionId, null, "session.created",
                Map.of("sessionId", sessionId), false, null, now);
        if (turnId != null) {
            appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                    acceptedData(turnId, input), false, null, now);
        }
        return new Admission(sessionId, turnId, false, true);
    }

    @Transactional
    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null) {
            throw workspaceExecutionUnavailable();
        }
        Optional<CommandRecord> existing = findCommand(tenantId, operation,
                idempotencyKey, true);
        if (existing.isPresent()) {
            return replayCommand(tenantId, operation, idempotencyKey,
                    requestDigest);
        }
        if (!"ACTIVE".equals(session.status())) {
            throw new ApiException(HttpStatus.CONFLICT, "session_not_active",
                    "The Session does not accept new Turns.");
        }
        if (hasActiveTurn(tenantId, sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_active",
                    "The Session already has an active Turn.");
        }
        long now = clock.millis();
        String turnId = publicId("turn");
        insertTurn(tenantId, sessionId, turnId,
                UUID.randomUUID().toString(), input, payloadDigest, now);
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, now);
        appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                acceptedData(turnId, input), false, null, now);
        return new Admission(sessionId, turnId, false, true);
    }

    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId) {
        if (requireSessionForUpdate(tenantId, sessionId).workspace() != null) {
            throw workspaceExecutionUnavailable();
        }
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        long now = clock.millis();
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, now);
        boolean commandEffect = ACTIVE_TURN_STATES.contains(turn.status())
                && !"CANCELLING".equals(turn.status());
        if (commandEffect) {
            int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                            + " 'CANCELLING', updated_at = ?, version ="
                            + " version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ? AND turn_id = ? AND status IN"
                            + " ('ACCEPTED', 'RUNNING')",
                    now, tenantId, sessionId, turnId);
            commandEffect = updated == 1;
            if (commandEffect) {
                appendEvent(tenantId, sessionId, turnId,
                        "turn.cancel.requested", Map.of("turnId", turnId),
                        false, null, now);
            }
        }
        return new Admission(sessionId, turnId, false, commandEffect);
    }

    @Transactional
    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null) {
            throw workspaceExecutionUnavailable();
        }
        Optional<CommandRecord> existing = findCommand(tenantId, operation,
                idempotencyKey, true);
        if (existing.isPresent()) {
            CommandRecord command = existing.get();
            if (!command.requestDigest().equals(requestDigest)
                    || !command.sessionId().equals(sessionId)) {
                throw new ApiException(HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new SessionMutationCommand(sessionId, command.status(),
                    command.sessionStatusBefore(), true);
        }
        Integer pending = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_command WHERE tenant_id = ? AND"
                        + " session_id = ? AND command_status = 'PENDING'",
                Integer.class, tenantId, sessionId);
        if (pending != null && pending > 0) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "session_operation_active",
                    "The Session already has a lifecycle operation in progress.");
        }
        validateMutationStart(session, kind);
        long now = clock.millis();
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, null, "PENDING", session.status(), now);
        String pendingStatus = pendingStatus(kind);
        if (pendingStatus != null) {
            jdbc.update("UPDATE managed_agent_session SET status = ?,"
                            + " updated_at = ?, version = version + 1 WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    pendingStatus, now, tenantId, sessionId);
        }
        appendEvent(tenantId, sessionId, null,
                mutationEvent(kind, "requested"),
                Map.of("sessionId", sessionId), false,
                mutationSource(operation, idempotencyKey, "requested"), now);
        return new SessionMutationCommand(sessionId, "PENDING",
                session.status(), false);
    }

    @Transactional
    public SessionRecord completeSessionMutation(String tenantId,
            String operation, String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null) {
            throw workspaceExecutionUnavailable();
        }
        CommandRecord command = findCommand(tenantId, operation,
                idempotencyKey, true).orElseThrow(() ->
                        new IllegalStateException(
                                "Session mutation command is unavailable"));
        if (!command.sessionId().equals(sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key belongs to another Session.");
        }
        if ("COMPLETED".equals(command.status())) {
            return session;
        }
        if (!"PENDING".equals(command.status())) {
            throw new IllegalStateException(
                    "Session mutation command has an unknown status");
        }
        validateMutationCompletion(session, kind);
        long now = clock.millis();
        Map<String, Object> data = Map.of("sessionId", sessionId);
        switch (kind) {
            case RENAME -> {
                jdbc.update("UPDATE managed_agent_session SET title = ?,"
                                + " harness_boot_id ="
                                + " COALESCE(harness_boot_id, ?),"
                                + " updated_at = ?, version = version + 1"
                                + " WHERE tenant_id = ? AND session_id = ?",
                        title, harnessBootId, now, tenantId, sessionId);
                data = Map.of("sessionId", sessionId,
                        "metadata", Map.of("title", title));
            }
            case ARCHIVE -> jdbc.update("UPDATE managed_agent_session SET"
                            + " status = 'ARCHIVED', harness_event_epoch = NULL,"
                            + " harness_last_event_id = 0, updated_at = ?,"
                            + " version = version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ?",
                    now, tenantId, sessionId);
            case UNARCHIVE -> jdbc.update("UPDATE managed_agent_session SET"
                            + " status = 'ACTIVE', updated_at = ?, version ="
                            + " version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ?",
                    now, tenantId, sessionId);
            case DELETE -> jdbc.update("UPDATE managed_agent_session SET"
                            + " status = 'DELETED', harness_boot_id = NULL,"
                            + " harness_event_epoch = NULL,"
                            + " harness_last_event_id = 0, deleted_at = ?,"
                            + " updated_at = ?, version = version + 1 WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    now, now, tenantId, sessionId);
        }
        jdbc.update("UPDATE managed_agent_command SET command_status ="
                        + " 'COMPLETED', updated_at = ? WHERE tenant_id = ?"
                        + " AND operation = ? AND idempotency_key = ?",
                now, tenantId, operation, idempotencyKey);
        appendEvent(tenantId, sessionId, null,
                mutationEvent(kind, "completed"), data,
                kind == SessionMutationKind.DELETE,
                mutationSource(operation, idempotencyKey,
                        "completed"), now);
        return requireSessionForUpdate(tenantId, sessionId);
    }

    public Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        CommandRecord command = findCommand(tenantId, operation,
                idempotencyKey).orElseThrow(() -> new ApiException(
                        HttpStatus.CONFLICT, "idempotency_conflict",
                        "The idempotency key is already in use."));
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        return new Admission(command.sessionId(), command.turnId(), true,
                false);
    }

    public Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey) {
        return findCommand(tenantId, operation, idempotencyKey, false);
    }

    private Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey, boolean forUpdate) {
        List<CommandRecord> rows = jdbc.query(
                "SELECT tenant_id, operation, idempotency_key,"
                        + " request_digest, session_id, turn_id,"
                        + " command_status, session_status_before,"
                        + " created_at, updated_at"
                        + " FROM managed_agent_command WHERE"
                        + " CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND operation = ? AND"
                        + " CAST(CONCAT(idempotency_key, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + (forUpdate ? " FOR UPDATE" : ""),
                (result, row) -> new CommandRecord(
                        result.getString("tenant_id"),
                        result.getString("operation"),
                        result.getString("idempotency_key"),
                        result.getString("request_digest"),
                        result.getString("session_id"),
                        result.getString("turn_id"),
                        result.getString("command_status"),
                        result.getString("session_status_before"),
                        result.getLong("created_at"),
                        result.getLong("updated_at")),
                tenantId, operation, idempotencyKey);
        return rows.stream().findFirst();
    }

    public Optional<SessionRecord> findSession(String tenantId,
            String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_session WHERE"
                        + " CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND session_id = ?",
                sessionMapper, tenantId, sessionId);
        return rows.stream().findFirst();
    }

    public Optional<SessionRecord> findSessionById(String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_session WHERE"
                        + " session_id = ?",
                sessionMapper, sessionId);
        return rows.stream().findFirst();
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeUpdatedAt, String beforeSessionId, int limit) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        arguments.add(actorId == null ? null
                : ManagedWorkspaceRegistry.actorKey(tenantId, actorId));
        String cursorClause = "";
        if (beforeUpdatedAt != null && beforeSessionId != null) {
            cursorClause = " AND (updated_at < ? OR (updated_at = ?"
                    + " AND session_id < ?))";
            arguments.add(beforeUpdatedAt);
            arguments.add(beforeUpdatedAt);
            arguments.add(beforeSessionId);
        }
        arguments.add(limit + 1);
        List<SessionRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_session WHERE"
                        + " CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND status <> 'DELETED'"
                        + " AND (workspace_id IS NULL OR EXISTS (SELECT 1"
                        + " FROM managed_workspace_access wa"
                        + " WHERE CAST(CONCAT(wa.tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT("
                        + "managed_agent_session.tenant_id, '!')"
                        + " AS BINARY(513))"
                        + " AND CAST(CONCAT(wa.workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT("
                        + "managed_agent_session.workspace_id, '!')"
                        + " AS BINARY(513))"
                        + " AND wa.actor_id = ?"
                        + " AND wa.can_read = TRUE))"
                        + cursorClause
                        + " ORDER BY updated_at DESC, session_id DESC LIMIT ?",
                sessionMapper, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        if (hasMore) {
            rows = new ArrayList<>(rows.subList(0, limit));
        }
        return new SessionPage(List.copyOf(rows), hasMore);
    }

    public Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ?",
                turnMapper, tenantId, sessionId, turnId);
        return rows.stream().findFirst();
    }

    public Optional<TurnRecord> findActiveTurn(String tenantId,
            String sessionId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')"
                        + " ORDER BY created_at DESC LIMIT 1",
                turnMapper, tenantId, sessionId);
        return rows.stream().findFirst();
    }

    public Optional<TurnRecord> findLatestTurn(String tenantId,
            String sessionId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? ORDER BY created_at DESC,"
                        + " turn_id DESC LIMIT 1",
                turnMapper, tenantId, sessionId);
        return rows.stream().findFirst();
    }

    public List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit) {
        requireSession(tenantId, sessionId);
        return jdbc.query("SELECT * FROM managed_agent_event WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " sequence_id > ? ORDER BY sequence_id ASC LIMIT ?",
                eventMapper,
                tenantId, sessionId, afterSequence, limit);
    }

    public Optional<EventRecord> findLatestEnvironmentEvent(String tenantId,
            String sessionId) {
        requireSession(tenantId, sessionId);
        return jdbc.query("SELECT event.* FROM managed_agent_event event"
                        + " JOIN managed_agent_turn turn_record ON"
                        + " turn_record.tenant_id = event.tenant_id AND"
                        + " turn_record.session_id = event.session_id AND"
                        + " turn_record.turn_id = event.turn_id WHERE"
                        + " event.tenant_id = ? AND event.session_id = ? AND"
                        + " event.event_type IN ('environment.provisioning',"
                        + " 'environment.ready', 'environment.failed') AND"
                        + " turn_record.turn_id = (SELECT turn_id FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? ORDER BY created_at DESC, turn_id"
                        + " DESC LIMIT 1) ORDER BY event.sequence_id DESC"
                        + " LIMIT 1",
                eventMapper, tenantId, sessionId, tenantId, sessionId)
                .stream().findFirst();
    }

    public List<EventRecord> findControlEvents(String tenantId,
            String sessionId, long throughSequence) {
        requireSession(tenantId, sessionId);
        return jdbc.query("SELECT * FROM managed_agent_event WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " sequence_id <= ? AND event_type NOT IN"
                        + " ('turn.accepted', 'item.output_text.delta',"
                        + " 'item.reasoning.delta',"
                        + " 'item.tool_call.updated') ORDER BY sequence_id"
                        + " ASC",
                eventMapper, tenantId, sessionId, throughSequence);
    }

    public EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit) {
        requireSession(tenantId, sessionId);
        List<EventRecord> rows = beforeSequence == null
                ? jdbc.query("SELECT * FROM managed_agent_event WHERE"
                                + " tenant_id = ? AND session_id = ?"
                                + " ORDER BY sequence_id DESC LIMIT ?",
                        eventMapper, tenantId, sessionId, limit + 1)
                : jdbc.query("SELECT * FROM managed_agent_event WHERE"
                                + " tenant_id = ? AND session_id = ? AND"
                                + " sequence_id < ? ORDER BY sequence_id"
                                + " DESC LIMIT ?",
                        eventMapper, tenantId, sessionId, beforeSequence,
                        limit + 1);
        boolean hasMore = rows.size() > limit;
        if (hasMore) {
            rows = new ArrayList<>(rows.subList(0, limit));
        } else {
            rows = new ArrayList<>(rows);
        }
        java.util.Collections.reverse(rows);
        return new EventPage(List.copyOf(rows), hasMore);
    }

    public Optional<SnapshotRecord> findSnapshot(String tenantId,
            String sessionId) {
        requireSession(tenantId, sessionId);
        List<SnapshotRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_snapshot WHERE tenant_id = ?"
                        + " AND session_id = ?",
                (result, row) -> new SnapshotRecord(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getLong("snapshot_version"),
                        result.getLong("covered_sequence"),
                        readItems(result.getString("items_json")),
                        result.getLong("created_at"),
                        result.getLong("updated_at")),
                tenantId, sessionId);
        return rows.stream().findFirst();
    }

    public List<MaterializationTarget> findMaterializationTargets(int limit) {
        return jdbc.query("SELECT s.tenant_id, s.session_id FROM"
                        + " managed_agent_session s JOIN"
                        + " managed_agent_consumer_progress p ON"
                        + " p.tenant_id = s.tenant_id AND p.session_id ="
                        + " s.session_id AND p.consumer_name = ? WHERE"
                        + " s.last_sequence > p.covered_sequence ORDER BY"
                        + " p.updated_at ASC LIMIT ?",
                (result, row) -> new MaterializationTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id")),
                MESSAGE_PROJECTION, limit);
    }

    @Transactional
    public MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit) {
        requireSessionForUpdate(tenantId, sessionId);
        Long covered = jdbc.queryForObject("SELECT covered_sequence FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id"
                        + " = ? AND session_id = ? AND consumer_name = ?"
                        + " FOR UPDATE",
                Long.class, tenantId, sessionId, MESSAGE_PROJECTION);
        if (covered == null) {
            throw new IllegalStateException(
                    "Message projection progress is unavailable");
        }
        List<EventRecord> events = jdbc.query("SELECT * FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND sequence_id > ? ORDER BY"
                        + " sequence_id ASC LIMIT ?",
                eventMapper, tenantId, sessionId, covered, limit);
        if (events.isEmpty()) {
            return new MaterializationResult(false, covered);
        }
        long expected = covered + 1;
        for (EventRecord event : events) {
            if (event.sequence() != expected) {
                throw new IllegalStateException(
                        "Message projection event sequence has a gap");
            }
            materializeEvent(event);
            expected++;
        }
        long nextCovered = events.get(events.size() - 1).sequence();
        long now = clock.millis();
        jdbc.update("UPDATE managed_agent_consumer_progress SET"
                        + " covered_sequence = ?, updated_at = ? WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " consumer_name = ?",
                nextCovered, now, tenantId, sessionId, MESSAGE_PROJECTION);
        List<ItemRecord> items = allItems(tenantId, sessionId);
        List<Long> versions = jdbc.query("SELECT snapshot_version FROM"
                        + " managed_agent_snapshot WHERE tenant_id = ? AND"
                        + " session_id = ? FOR UPDATE",
                (result, row) -> result.getLong("snapshot_version"),
                tenantId, sessionId);
        if (versions.isEmpty()) {
            jdbc.update("INSERT INTO managed_agent_snapshot (tenant_id,"
                            + " session_id, snapshot_version,"
                            + " covered_sequence, items_json, created_at,"
                            + " updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)",
                    tenantId, sessionId, nextCovered, writeJson(items), now,
                    now);
        } else {
            jdbc.update("UPDATE managed_agent_snapshot SET"
                            + " snapshot_version = ?, covered_sequence = ?,"
                            + " items_json = ?, updated_at = ? WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    versions.get(0) + 1, nextCovered, writeJson(items), now,
                    tenantId, sessionId);
        }
        return new MaterializationResult(true, nextCovered);
    }

    public List<DispatchTarget> findDispatchable(long now, int limit) {
        return jdbc.query("SELECT tenant_id, session_id, turn_id FROM"
                        + " managed_agent_turn WHERE status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                        + " (dispatch_lease_until IS NULL OR"
                        + " dispatch_lease_until < ?) AND (retry_after IS"
                        + " NULL OR retry_after <= ?)"
                        + " ORDER BY updated_at ASC LIMIT ?",
                (result, row) -> new DispatchTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("turn_id")), now, now, limit);
    }

    @Transactional
    public Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET"
                        + " dispatch_owner = ?, dispatch_lease_until = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ? AND turn_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING',"
                        + " 'CANCELLING') AND (dispatch_lease_until IS NULL"
                        + " OR dispatch_lease_until < ?) AND (retry_after IS"
                        + " NULL OR retry_after <= ?)",
                owner, now + leaseDuration.toMillis(), now, tenantId,
                sessionId, turnId, now, now);
        return updated == 0 ? Optional.empty()
                : findTurn(tenantId, sessionId, turnId);
    }

    public boolean renewTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        long now = clock.millis();
        return jdbc.update("UPDATE managed_agent_turn SET"
                        + " dispatch_lease_until = ?, version = version + 1"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                        + " dispatch_lease_until >= ?",
                now + leaseDuration.toMillis(), tenantId, sessionId, turnId,
                owner, now) == 1;
    }

    public void releaseTurnLease(String tenantId, String sessionId,
            String turnId, String owner) {
        jdbc.update("UPDATE managed_agent_turn SET dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                tenantId, sessionId, turnId, owner);
    }

    public void scheduleTurnRetry(String tenantId, String sessionId,
            String turnId, String owner, long retryAfter) {
        jdbc.update("UPDATE managed_agent_turn SET retry_count = retry_count"
                        + " + 1, retry_after = ?, dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND dispatch_owner"
                        + " = ? AND status IN ('ACCEPTED', 'RUNNING',"
                        + " 'CANCELLING')",
                retryAfter, clock.millis(), tenantId, sessionId, turnId,
                owner);
    }

    @Transactional
    public boolean bindHarness(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !ACTIVE_TURN_STATES.contains(turn.status())) {
            return false;
        }
        if (harnessBootId.equals(session.harnessBootId())) {
            return true;
        }
        if (session.harnessBootId() != null
                && (turn.submissionAttempted()
                        || turn.harnessEventEpoch() != null)) {
            return false;
        }
        jdbc.update("UPDATE managed_agent_session SET harness_boot_id = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                harnessBootId, now, tenantId, sessionId);
        return true;
    }

    @Transactional
    public boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !ACTIVE_TURN_STATES.contains(turn.status())
                || !turn.submissionAttempted()
                || turn.harnessEventEpoch() == null) {
            return false;
        }
        if (harnessBootId.equals(session.harnessBootId())) {
            return true;
        }
        if (!Objects.equals(expectedHarnessBootId,
                session.harnessBootId())) {
            return false;
        }
        int updated = jdbc.update("UPDATE managed_agent_session SET"
                        + " harness_boot_id = ?, updated_at = ?, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ? AND harness_boot_id = ?",
                harnessBootId, now, tenantId, sessionId,
                expectedHarnessBootId);
        return updated == 1;
    }

    @Transactional
    public void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner) {
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET"
                        + " submission_attempted = TRUE, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND harness_event_epoch IS NULL",
                now, tenantId, sessionId, turnId, owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    @Transactional
    public void recordAdmission(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastEventId) {
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " CASE WHEN status = 'CANCELLING' THEN status ELSE"
                        + " 'RUNNING' END, harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastEventId, now, tenantId, sessionId, turnId,
                owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        int sessionUpdated = jdbc.update("UPDATE managed_agent_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ?",
                eventEpoch, lastEventId, now, tenantId, sessionId);
        if (sessionUpdated != 1) {
            throw new IllegalStateException("Session disappeared");
        }
        if (!hasEventType(tenantId, sessionId, turnId, "turn.started")) {
            appendEvent(tenantId, sessionId, turnId, "turn.started",
                    Map.of("turnId", turnId), false, null, now);
        }
    }

    @Transactional
    public void recordRecoveryAdmission(String tenantId, String sessionId,
            String turnId, String owner, String expectedEventEpoch,
            String eventEpoch, long lastEventId) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !ACTIVE_TURN_STATES.contains(turn.status())) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (eventEpoch.equals(turn.harnessEventEpoch())
                && turn.harnessLastEventId() != null
                && turn.harnessLastEventId() >= lastEventId) {
            return;
        }
        if (!turn.submissionAttempted()
                || !Objects.equals(expectedEventEpoch,
                        turn.harnessEventEpoch())
                || !Objects.equals(expectedEventEpoch,
                        session.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness recovery epoch changed");
        }
        int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " CASE WHEN status = 'CANCELLING' THEN status ELSE"
                        + " 'RUNNING' END, harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND harness_event_epoch = ?",
                eventEpoch, lastEventId, now, tenantId, sessionId, turnId,
                owner, now, expectedEventEpoch);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        int sessionUpdated = jdbc.update("UPDATE managed_agent_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND harness_event_epoch = ?",
                eventEpoch, lastEventId, now, tenantId, sessionId,
                expectedEventEpoch);
        if (sessionUpdated != 1) {
            throw new IllegalStateException(
                    "Hosted Harness recovery epoch changed");
        }
    }

    @Transactional
    public void retractContinuationOutput(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId,
            String eventEpoch) {
        requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !ACTIVE_TURN_STATES.contains(turn.status())) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (harnessBootId.isBlank() || eventEpoch.isBlank()) {
            throw new IllegalArgumentException(
                    "continuation owner is missing");
        }
        String sourcePrefix = harnessBootId + ":" + eventEpoch + ":";
        String reconciliationKey = "reconcile:" + sourcePrefix + turnId;
        if (hasSourceEvent(tenantId, sessionId, reconciliationKey)) {
            return;
        }
        jdbc.queryForObject("SELECT covered_sequence FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id"
                        + " = ? AND session_id = ? AND consumer_name = ?"
                        + " FOR UPDATE",
                Long.class, tenantId, sessionId, MESSAGE_PROJECTION);
        List<EventRecord> deltas = jdbc.query("SELECT * FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND event_type"
                        + " IN ('item.output_text.delta',"
                        + " 'item.reasoning.delta') ORDER BY sequence_id ASC",
                eventMapper, tenantId, sessionId, turnId);
        for (EventRecord event : deltas) {
            if (event.sourceKey() == null
                    || !event.sourceKey().startsWith(sourcePrefix)) {
                continue;
            }
            Map<String, Object> data = new LinkedHashMap<>(event.data());
            data.put("text", "");
            jdbc.update("UPDATE managed_agent_event SET data_json = ?"
                            + " WHERE tenant_id = ? AND session_id = ?"
                            + " AND sequence_id = ?",
                    writeJson(data), tenantId, sessionId, event.sequence());
        }
        // Rebuild shared text parts from retained events, including any
        // output belonging to other Harness generations.
        jdbc.update("DELETE FROM managed_agent_item_part WHERE tenant_id = ?"
                        + " AND session_id = ?", tenantId, sessionId);
        jdbc.update("DELETE FROM managed_agent_item WHERE tenant_id = ?"
                        + " AND session_id = ?", tenantId, sessionId);
        jdbc.update("DELETE FROM managed_agent_snapshot WHERE tenant_id = ?"
                        + " AND session_id = ?", tenantId, sessionId);
        jdbc.update("UPDATE managed_agent_consumer_progress SET"
                        + " covered_sequence = 0, updated_at = ? WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " consumer_name = ?",
                now, tenantId, sessionId, MESSAGE_PROJECTION);
        appendEvent(tenantId, sessionId, turnId, "stream.reconciled", Map.of(),
                false, reconciliationKey, now);
    }

    @Transactional
    public void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events) {
        if (events.isEmpty()) {
            return;
        }
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < clock.millis()) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (!eventEpoch.equals(turn.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness event epoch changed");
        }
        long lastSourceId = turn.harnessLastEventId() == null ? 0
                : turn.harnessLastEventId();
        List<HarnessEvent> accepted = new ArrayList<>();
        for (HarnessEvent event : events) {
            if (event.sourceId() > lastSourceId) {
                accepted.add(event);
                lastSourceId = event.sourceId();
            }
        }
        if (accepted.isEmpty()) {
            return;
        }
        long now = clock.millis();
        HarnessEvent terminal = null;
        for (int index = 0; index < accepted.size(); index++) {
            HarnessEvent event = accepted.get(index);
            if (event.projection() != null
                    && event.projection().terminal()) {
                if (terminal != null || index != accepted.size() - 1) {
                    throw new IllegalArgumentException(
                            "Terminal Harness event must end the batch");
                }
                terminal = event;
            }
        }
        int updated = terminal == null
                ? updateHarnessCursor(tenantId, sessionId, turnId, owner,
                        eventEpoch, lastSourceId, now)
                : completeHarnessTurn(tenantId, sessionId, turnId, owner,
                        eventEpoch, lastSourceId, terminal.projection(), now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        List<HarnessEvent> projected = accepted.stream()
                .filter(event -> event.projection() != null).toList();
        List<EventRecord> committed = appendEvents(tenantId, sessionId,
                turnId, eventEpoch, lastSourceId, session.lastSequence(),
                projected, now);
        publishAfterCommit(committed);
    }

    private int updateHarnessCursor(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastSourceId, long now) {
        return jdbc.update("UPDATE managed_agent_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastSourceId, now, tenantId, sessionId, turnId,
                owner, now);
    }

    private int completeHarnessTurn(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastSourceId, ProjectedEvent terminal, long now) {
        return jdbc.update("UPDATE managed_agent_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, status = ?,"
                        + " error_code = ?, error_message = ?,"
                        + " completed_at = ?, updated_at = ?,"
                        + " dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastSourceId, terminal.terminalStatus(),
                terminal.errorCode(), terminal.errorMessage(), now, now,
                tenantId, sessionId, turnId, owner, now);
    }

    private List<EventRecord> appendEvents(String tenantId,
            String sessionId, String turnId, String eventEpoch,
            long lastSourceId, long sequence, List<HarnessEvent> events,
            long now) {
        List<EventRecord> records = new ArrayList<>();
        long next = sequence;
        for (HarnessEvent event : events) {
            ProjectedEvent projection = event.projection();
            records.add(new EventRecord(tenantId, sessionId, ++next,
                    publicId("evt"), turnId, projection.type(),
                    projection.data(), projection.terminal(),
                    event.sourceKey(), now));
        }
        jdbc.update("UPDATE managed_agent_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, last_sequence = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                eventEpoch, lastSourceId, next, now, tenantId, sessionId);
        if (!records.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO managed_agent_event (tenant_id,"
                            + " session_id, sequence_id, event_id, turn_id,"
                            + " event_type, data_json, terminal, source_key,"
                            + " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?)",
                    records, records.size(), (statement, event) -> {
                        statement.setString(1, event.tenantId());
                        statement.setString(2, event.sessionId());
                        statement.setLong(3, event.sequence());
                        statement.setString(4, event.eventId());
                        statement.setString(5, event.turnId());
                        statement.setString(6, event.type());
                        statement.setString(7, writeJson(event.data()));
                        statement.setBoolean(8, event.terminal());
                        statement.setString(9, event.sourceKey());
                        statement.setLong(10, event.createdAt());
                    });
        }
        return List.copyOf(records);
    }

    @Transactional
    public void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner) {
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || turn.harnessEventEpoch() != null
                || turn.submissionAttempted()) {
            return;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " 'CANCELLED',"
                        + " completed_at = ?, updated_at = ?,"
                        + " dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until >= ?"
                        + " AND submission_attempted = FALSE",
                now, now, tenantId, sessionId, turnId, owner, now);
        if (updated != 1) {
            return;
        }
        appendEvent(tenantId, sessionId, turnId, "turn.cancelled",
                Map.of("turnId", turnId), true, null, now);
    }

    @Transactional
    public void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message) {
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || !ACTIVE_TURN_STATES.contains(turn.status())) {
            return;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " 'FAILED',"
                        + " error_code = ?, error_message = ?, completed_at ="
                        + " ?, updated_at = ?, dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                        + " dispatch_lease_until >= ?",
                code, message, now, now, tenantId, sessionId, turnId, owner,
                now);
        if (updated != 1) {
            return;
        }
        appendEvent(tenantId, sessionId, turnId, "turn.failed",
                Map.of("code", code, "message", message), true, null, now);
    }

    @Transactional
    public void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey) {
        requireSessionForUpdate(tenantId, sessionId);
        if (!hasSourceEvent(tenantId, sessionId, sourceKey)) {
            appendEvent(tenantId, sessionId, turnId, type, data, terminal,
                    sourceKey, clock.millis());
        }
    }

    public SessionRecord requireSession(String tenantId, String sessionId) {
        return findSession(tenantId, sessionId).orElseThrow(() ->
                new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                        "The Session was not found."));
    }

    private void materializeEvent(EventRecord event) {
        switch (event.type()) {
            case "turn.accepted" -> materializeInput(event);
            case "item.output_text.delta" -> materializeText(event,
                    "output_text");
            case "item.reasoning.delta" -> materializeText(event,
                    "reasoning");
            case "item.tool_call.updated" -> materializeTool(event);
            case "turn.completed", "turn.failed", "turn.cancelled" ->
                    settleTurnItems(event);
            default -> {
                return;
            }
        }
    }

    private void materializeInput(EventRecord event) {
        List<Map<String, Object>> input = inputData(event.data().get("input"));
        if (input.isEmpty()) {
            input = requireTurn(event.tenantId(), event.sessionId(),
                    event.turnId()).input();
        }
        String itemId = string(event.data().get("itemId"));
        if (itemId == null) {
            itemId = inputItemId(event.turnId());
        }
        upsertItem(event, itemId, "message", "user", "completed",
                Map.of());
        for (int index = 0; index < input.size(); index++) {
            Map<String, Object> block = input.get(index);
            String text = string(block.get("text"));
            if (text == null) {
                continue;
            }
            replacePart(event, itemId,
                    "part_" + event.turnId() + "_input_" + index,
                    "input_text", text);
        }
    }

    private void materializeText(EventRecord event, String partType) {
        String text = string(event.data().get("text"));
        if (text == null || text.isEmpty()) {
            return;
        }
        String itemId = string(event.data().get("itemId"));
        if (itemId == null) {
            itemId = "item_" + event.turnId() + "_assistant";
        }
        List<String> preceding = jdbc.query("SELECT part_id FROM"
                        + " managed_agent_item_part WHERE tenant_id = ?"
                        + " AND session_id = ? AND item_id = ? AND"
                        + " part_type = ? AND last_sequence = ?",
                (result, row) -> result.getString("part_id"),
                event.tenantId(), event.sessionId(), itemId, partType,
                event.sequence() - 1);
        String partId = preceding.isEmpty()
                ? "part_" + event.turnId() + "_" + partType + "_"
                        + event.sequence()
                : preceding.get(0);
        upsertItem(event, itemId, "message", "assistant", "in_progress",
                Map.of());
        appendPart(event, itemId, partId, partType, text);
    }

    private void materializeTool(EventRecord event) {
        String itemId = string(event.data().get("itemId"));
        if (itemId == null) {
            String callId = string(event.data().get("toolCallId"));
            if (callId == null) {
                callId = string(event.data().get("callId"));
            }
            String identity = callId == null
                    ? event.turnId() + ":sequence:" + event.sequence()
                    : event.turnId() + ":" + callId;
            itemId = "item_tool_" + UUID.nameUUIDFromBytes(
                    identity.getBytes(StandardCharsets.UTF_8));
        }
        String sourceStatus = string(event.data().get("status"));
        String status = switch (sourceStatus == null ? ""
                : sourceStatus.toLowerCase()) {
            case "completed", "success" -> "completed";
            case "failed" -> "failed";
            case "cancelled" -> "cancelled";
            default -> "in_progress";
        };
        Map<String, Object> attributes = existingAttributes(event, itemId);
        attributes.putAll(event.data());
        attributes.remove("itemId");
        upsertItem(event, itemId, "tool_call", "assistant", status,
                Map.copyOf(attributes));
    }

    private Map<String, Object> existingAttributes(EventRecord event,
            String itemId) {
        List<String> rows = jdbc.query("SELECT attributes_json FROM"
                        + " managed_agent_item WHERE tenant_id = ? AND"
                        + " session_id = ? AND item_id = ?",
                (result, row) -> result.getString("attributes_json"),
                event.tenantId(), event.sessionId(), itemId);
        return rows.isEmpty() ? new LinkedHashMap<>()
                : new LinkedHashMap<>(readMap(rows.get(0)));
    }

    private void settleTurnItems(EventRecord event) {
        String status = switch (event.type()) {
            case "turn.completed" -> "completed";
            case "turn.cancelled" -> "cancelled";
            default -> "failed";
        };
        jdbc.update("UPDATE managed_agent_item SET item_status = ?,"
                        + " last_sequence = CASE WHEN last_sequence < ?"
                        + " THEN ? ELSE last_sequence END, updated_at = ?,"
                        + " revision = revision + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND item_status"
                        + " = 'in_progress'",
                status, event.sequence(), event.sequence(),
                event.createdAt(), event.tenantId(), event.sessionId(),
                event.turnId());
    }

    private void upsertItem(EventRecord event, String itemId, String type,
            String role, String status, Map<String, Object> attributes) {
        int updated = jdbc.update("UPDATE managed_agent_item SET"
                        + " item_status = ?, attributes_json = ?,"
                        + " last_sequence = ?, updated_at = ?, revision ="
                        + " revision + 1 WHERE tenant_id = ? AND session_id"
                        + " = ? AND item_id = ?",
                status, writeJson(attributes), event.sequence(),
                event.createdAt(), event.tenantId(), event.sessionId(),
                itemId);
        if (updated == 0) {
            jdbc.update("INSERT INTO managed_agent_item (tenant_id,"
                            + " session_id, item_id, turn_id, item_type,"
                            + " item_role, item_status, attributes_json,"
                            + " first_sequence, last_sequence, created_at,"
                            + " updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?, ?, ?)",
                    event.tenantId(), event.sessionId(), itemId,
                    event.turnId(), type, role, status,
                    writeJson(attributes), event.sequence(), event.sequence(),
                    event.createdAt(), event.createdAt());
        }
    }

    private void replacePart(EventRecord event, String itemId,
            String partId, String type, String text) {
        int updated = jdbc.update("UPDATE managed_agent_item_part SET"
                        + " part_text = ?, last_sequence = ?, updated_at = ?,"
                        + " revision = revision + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND item_id = ? AND part_id = ?",
                text, event.sequence(), event.createdAt(), event.tenantId(),
                event.sessionId(), itemId, partId);
        if (updated == 0) {
            insertPart(event, itemId, partId, type, text);
        }
    }

    private void appendPart(EventRecord event, String itemId,
            String partId, String type, String text) {
        int updated = jdbc.update("UPDATE managed_agent_item_part SET"
                        + " part_text = CONCAT(part_text, ?),"
                        + " last_sequence = ?, updated_at = ?, revision ="
                        + " revision + 1 WHERE tenant_id = ? AND session_id"
                        + " = ? AND item_id = ? AND part_id = ?",
                text, event.sequence(), event.createdAt(), event.tenantId(),
                event.sessionId(), itemId, partId);
        if (updated == 0) {
            insertPart(event, itemId, partId, type, text);
        }
    }

    private void insertPart(EventRecord event, String itemId,
            String partId, String type, String text) {
        jdbc.update("INSERT INTO managed_agent_item_part (tenant_id,"
                        + " session_id, item_id, part_id, part_type,"
                        + " part_text, first_sequence, last_sequence,"
                        + " created_at, updated_at) VALUES (?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?)",
                event.tenantId(), event.sessionId(), itemId, partId, type,
                text, event.sequence(), event.sequence(), event.createdAt(),
                event.createdAt());
    }

    private List<ItemRecord> allItems(String tenantId, String sessionId) {
        return withParts(jdbc.query("SELECT * FROM managed_agent_item WHERE"
                        + " tenant_id = ? AND session_id = ? ORDER BY"
                        + " first_sequence ASC",
                itemMapper, tenantId, sessionId));
    }

    private List<ItemRecord> withParts(List<ItemRow> rows) {
        if (rows.isEmpty()) {
            return List.of();
        }
        ItemRow first = rows.get(0);
        String placeholders = String.join(", ",
                Collections.nCopies(rows.size(), "?"));
        List<Object> arguments = new ArrayList<>();
        arguments.add(first.tenantId());
        arguments.add(first.sessionId());
        rows.forEach(row -> arguments.add(row.itemId()));
        List<ItemPartRow> partRows = jdbc.query("SELECT * FROM"
                        + " managed_agent_item_part WHERE tenant_id = ? AND"
                        + " session_id = ? AND item_id IN (" + placeholders
                        + ") ORDER BY first_sequence ASC",
                partMapper, arguments.toArray());
        Map<String, List<ItemPartRecord>> parts = new HashMap<>();
        for (ItemPartRow row : partRows) {
            parts.computeIfAbsent(row.itemId(), ignored -> new ArrayList<>())
                    .add(row.part());
        }
        return rows.stream().map(row -> row.toRecord(
                List.copyOf(parts.getOrDefault(row.itemId(), List.of()))))
                .toList();
    }

    private static Map<String, Object> acceptedData(String turnId,
            List<Map<String, Object>> input) {
        return Map.of("turnId", turnId, "itemId", inputItemId(turnId),
                "input", input);
    }

    private static String inputItemId(String turnId) {
        return "item_" + turnId + "_input";
    }

    private static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }

    private static List<Map<String, Object>> inputData(Object value) {
        if (!(value instanceof List<?> values)) {
            return List.of();
        }
        List<Map<String, Object>> input = new ArrayList<>();
        for (Object item : values) {
            if (!(item instanceof Map<?, ?> raw)) {
                continue;
            }
            Map<String, Object> block = new LinkedHashMap<>();
            raw.forEach((key, entry) -> {
                if (key instanceof String name) {
                    block.put(name, entry);
                }
            });
            input.add(Map.copyOf(block));
        }
        return List.copyOf(input);
    }

    private SessionRecord requireSessionForUpdate(String tenantId,
            String sessionId) {
        try {
            return jdbc.queryForObject("SELECT * FROM managed_agent_session"
                            + " WHERE CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                            + " = CAST(CONCAT(?, '!') AS BINARY(513)) AND session_id = ?"
                            + " FOR UPDATE",
                    sessionMapper, tenantId, sessionId);
        } catch (EmptyResultDataAccessException error) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "session_not_found", "The Session was not found.");
        }
    }

    private TurnRecord requireTurn(String tenantId, String sessionId,
            String turnId) {
        return findTurn(tenantId, sessionId, turnId).orElseThrow(() ->
                new ApiException(HttpStatus.NOT_FOUND, "turn_not_found",
                        "The Turn was not found."));
    }

    private TurnRecord requireTurnForUpdate(String tenantId,
            String sessionId, String turnId) {
        try {
            return jdbc.queryForObject("SELECT * FROM managed_agent_turn"
                            + " WHERE tenant_id = ? AND session_id = ? AND"
                            + " turn_id = ? FOR UPDATE",
                    turnMapper, tenantId, sessionId, turnId);
        } catch (EmptyResultDataAccessException error) {
            throw new ApiException(HttpStatus.NOT_FOUND, "turn_not_found",
                    "The Turn was not found.");
        }
    }

    private void insertTurn(String tenantId, String sessionId,
            String turnId, String promptId, List<Map<String, Object>> input,
            String payloadDigest, long now) {
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, created_at, updated_at) VALUES"
                        + " (?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, ?)",
                tenantId, sessionId, turnId, promptId, writeJson(input),
                payloadDigest, now, now);
    }

    private void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, long now) {
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, "COMPLETED", now);
    }

    private void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, long now) {
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, status, null, now);
    }

    private void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, String sessionStatusBefore,
            long now) {
        jdbc.update("INSERT INTO managed_agent_command (tenant_id,"
                        + " operation, idempotency_key, request_digest,"
                        + " session_id, turn_id, command_status,"
                        + " session_status_before, created_at, updated_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, status, sessionStatusBefore, now, now);
    }

    private void validateMutationStart(SessionRecord session,
            SessionMutationKind kind) {
        String status = session.status();
        switch (kind) {
            case RENAME, ARCHIVE -> requireSessionStatus(status, "ACTIVE");
            case UNARCHIVE -> requireSessionStatus(status, "ARCHIVED");
            case DELETE -> {
                if (!"ACTIVE".equals(status)
                        && !"ARCHIVED".equals(status)) {
                    throw sessionStateConflict(status);
                }
            }
        }
        if ((kind == SessionMutationKind.ARCHIVE
                || kind == SessionMutationKind.DELETE)
                && hasActiveTurn(session.tenantId(), session.sessionId())) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_active",
                    "The Session has an active Turn.");
        }
    }

    private static void validateMutationCompletion(SessionRecord session,
            SessionMutationKind kind) {
        String expected = switch (kind) {
            case RENAME -> "ACTIVE";
            case ARCHIVE -> "ARCHIVING";
            case UNARCHIVE -> "ARCHIVED";
            case DELETE -> "DELETING";
        };
        requireSessionStatus(session.status(), expected);
    }

    private static String pendingStatus(SessionMutationKind kind) {
        return switch (kind) {
            case ARCHIVE -> "ARCHIVING";
            case DELETE -> "DELETING";
            case RENAME, UNARCHIVE -> null;
        };
    }

    private static String mutationEvent(SessionMutationKind kind,
            String phase) {
        if ("completed".equals(phase)) {
            return switch (kind) {
                case RENAME -> "session.updated";
                case ARCHIVE -> "session.archived";
                case UNARCHIVE -> "session.unarchived";
                case DELETE -> "session.deleted";
            };
        }
        String operation = switch (kind) {
            case RENAME -> "update";
            case ARCHIVE -> "archive";
            case UNARCHIVE -> "unarchive";
            case DELETE -> "delete";
        };
        return "session." + operation + "." + phase;
    }

    private static String mutationSource(String operation,
            String idempotencyKey, String phase) {
        return "control:" + operation + ":" + idempotencyKey + ":" + phase;
    }

    private static void requireSessionStatus(String actual,
            String expected) {
        if (!expected.equals(actual)) {
            throw sessionStateConflict(actual);
        }
    }

    private static ApiException sessionStateConflict(String status) {
        return new ApiException(HttpStatus.CONFLICT,
                "session_state_conflict",
                "The Session is " + status.toLowerCase()
                        + " and cannot perform this operation.");
    }

    private EventRecord appendEvent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey, long now) {
        Long sequence = jdbc.queryForObject("SELECT last_sequence FROM"
                        + " managed_agent_session WHERE tenant_id = ? AND"
                        + " session_id = ? FOR UPDATE",
                Long.class, tenantId, sessionId);
        if (sequence == null) {
            throw new IllegalStateException("Session sequence is unavailable");
        }
        long next = sequence + 1;
        EventRecord event = new EventRecord(tenantId, sessionId, next,
                publicId("evt"), turnId, type, data, terminal, sourceKey,
                now);
        jdbc.update("UPDATE managed_agent_session SET last_sequence = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                next, now, tenantId, sessionId);
        jdbc.update("INSERT INTO managed_agent_event (tenant_id,"
                        + " session_id, sequence_id, event_id, turn_id,"
                        + " event_type, data_json, terminal, source_key,"
                        + " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                event.tenantId(), event.sessionId(), event.sequence(),
                event.eventId(), event.turnId(), event.type(),
                writeJson(event.data()), event.terminal(), event.sourceKey(),
                event.createdAt());
        publishAfterCommit(List.of(event));
        return event;
    }

    private void publishAfterCommit(List<EventRecord> events) {
        if (events.isEmpty()) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            eventPublisher.publish(events);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(
                new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        eventPublisher.publish(events);
                    }
                });
    }

    private boolean hasActiveTurn(String tenantId, String sessionId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                Integer.class, tenantId, sessionId);
        return count != null && count > 0;
    }

    private boolean hasEventType(String tenantId, String sessionId,
            String turnId, String type) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " event_type = ?",
                Integer.class, tenantId, sessionId, turnId, type);
        return count != null && count > 0;
    }

    private boolean hasSourceEvent(String tenantId, String sessionId,
            String sourceKey) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND source_key = ?",
                Integer.class, tenantId, sessionId, sourceKey);
        return count != null && count > 0;
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException("Value is not valid JSON",
                    error);
        }
    }

    private List<Map<String, Object>> readInput(String value) {
        try {
            return objectMapper.readValue(value, INPUT_TYPE);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored input is invalid", error);
        }
    }

    private Map<String, Object> readMap(String value) {
        try {
            return objectMapper.readValue(value, MAP_TYPE);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored event is invalid", error);
        }
    }

    private List<ItemRecord> readItems(String value) {
        try {
            return objectMapper.readValue(value, ITEMS_TYPE);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored snapshot is invalid",
                    error);
        }
    }

    private static ContextBinding readBinding(java.sql.ResultSet result)
            throws java.sql.SQLException {
        String workspaceId = result.getString("workspace_id");
        if (workspaceId == null) {
            return null;
        }
        String configRef = result.getString("workspace_config_ref");
        String policyRef = result.getString("workspace_policy_ref");
        String contextConfigRef = result.getString("context_config_ref");
        if (!ManagedWorkspaceRegistry.descriptorRef(configRef, policyRef)
                .equals(contextConfigRef)) {
            throw new IllegalStateException(
                    "Persisted Workspace configuration descriptor changed");
        }
        return new ContextBinding(result.getString("tenant_id"), workspaceId,
                result.getLong("workspace_generation"),
                result.getString("workspace_storage_id"),
                result.getString("cwd_relative"), contextConfigRef,
                result.getLong("context_revision"));
    }

    private static Long nullableLong(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        long value = result.getLong(name);
        return result.wasNull() ? null : value;
    }

    private static String publicId(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString()
                .replace("-", "");
    }

    private record ItemRow(String tenantId, String sessionId, String itemId,
            String turnId, String type, String role, String status,
            Map<String, Object> attributes, long firstSequence,
            long lastSequence, long createdAt, long updatedAt,
            long revision) {
        private ItemRecord toRecord(List<ItemPartRecord> content) {
            return new ItemRecord(tenantId, sessionId, itemId, turnId, type,
                    role, status, attributes, firstSequence, lastSequence,
                    createdAt, updatedAt, revision, content);
        }
    }

    private record ItemPartRow(String itemId, ItemPartRecord part) {
    }
}
