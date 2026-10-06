package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.EventIdentity.Identity;
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
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutation;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.util.Locale;

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
    // Between full rewrites the snapshot may lag the projection by this many
    // events or this long; the batch that ends a Turn rewrites it anyway.
    public static final int SNAPSHOT_REFRESH_EVENTS = 1000;
    private static final long SNAPSHOT_REFRESH_MILLIS = 5000;
    private static final String INSERT_EVENT = "INSERT INTO managed_agent_event"
            + " (tenant_id, session_id, sequence_id, event_id, turn_id,"
            + " event_type, data_json, terminal, source_key, created_at,"
            + " schema_version, projection_version, item_id, content_part_id)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    private static final List<String> ACTIVE_TURN_STATES = List.of(
            "ACCEPTED", "RUNNING", "CANCELLING");
    private static final String TURN_SUMMARY_COLUMNS = "session_id,"
            + " turn_id, status, created_at, completed_at, error_code";
    // findLatestTurns joins managed_agent_event, so the same projection
    // must be table-qualified there.
    private static final String QUALIFIED_TURN_SUMMARY_COLUMNS =
            "turn_record." + String.join(", turn_record.",
                    TURN_SUMMARY_COLUMNS.split(", "));
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final String approvalMode;
    private final CommittedEventPublisher eventPublisher;
    private final ManagedWorkspaceRegistry workspaces;
    private final String agentRevision;
    private final boolean workspaceFilesEnabled;
    private final List<ManagedAgentProperties.RuntimeBroker.WorkspaceMount> workspaceMounts;
    private final RowMapper<SessionRecord> sessionMapper = (result, row) ->
            new SessionRecord(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getString("agent_id"),
                    result.getString("agent_revision"),
                    result.getString("title"),
                    result.getString("status"),
                    result.getString("harness_boot_id"),
                    result.getString("harness_event_epoch"),
                    result.getLong("harness_last_event_id"),
                    result.getLong("last_sequence"),
                    result.getLong("replay_floor_sequence"),
                    result.getLong("created_at"),
                    result.getLong("updated_at"),
                    nullableLong(result, "deleted_at"),
                    result.getLong("version"), readBinding(result),
                    result.getString("approval_mode"),
                    result.getString("tool_profile"));
    private final RowMapper<TurnSummary> turnSummaryMapper =
            (result, row) -> new TurnSummary(result.getString("session_id"),
                    result.getString("turn_id"), result.getString("status"),
                    result.getLong("created_at"),
                    nullableLong(result, "completed_at"),
                    result.getString("error_code"));
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
                    result.getLong("created_at"),
                    result.getInt("schema_version"),
                    result.getInt("projection_version"),
                    result.getString("item_id"),
                    result.getString("content_part_id"));
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
    private final RowMapper<OperationRecord> operationMapper =
            (result, row) -> new OperationRecord(
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
                    result.getString("lease_owner"),
                    result.getLong("claim_generation"),
                    result.getInt("attempt_count"),
                    additiveString(result, "target_cwd_relative"),
                    additiveLong(result, "expected_context_revision"),
                    additiveLong(result, "result_context_revision"),
                    result.getString("error_code"));
    private final RowMapper<OperationTarget> operationTargetMapper =
            (result, row) -> new OperationTarget(
                    result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getString("operation_id"));

    public ManagedAgentStore(JdbcTemplate jdbc, ObjectMapper objectMapper,
            Clock clock, CommittedEventPublisher eventPublisher,
            ManagedWorkspaceRegistry workspaces,
            ManagedAgentProperties properties) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.approvalMode =
                properties.getHarness().getApprovalMode().toLowerCase(Locale.ROOT);
        this.eventPublisher = eventPublisher;
        this.workspaces = workspaces;
        this.agentRevision = properties.getAgentRevision();
        this.workspaceFilesEnabled = properties.getHarness().isWorkspaceFilesEnabled();
        this.workspaceMounts = properties.getRuntimeBroker().getWorkspaceMounts();
        if (agentRevision == null || agentRevision.isBlank()
                || agentRevision.length() > 128) {
            throw new IllegalArgumentException(
                    "qwen.managed-agent.agent-revision must contain 1-128"
                            + " characters");
        }
    }

    @Override
    @Transactional
    public Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        requireAgentRevision(requestedRevision);
        requireCreationScope(tenantId, idempotencyKey, false);
        return insertSession(tenantId, operation, idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                null, actorId);
    }

    @Override
    @Transactional
    public Admission insertWorkspaceSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection) {
        if (!input.isEmpty() && !workspaceFilesEnabled) {
            throw workspaceExecutionUnavailable();
        }
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (!existing.isEmpty()) {
            return replayWorkspaceCommand(tenantId, actorId,
                    requestDigest, existing.getFirst());
        }
        requireAgentRevision(requestedRevision);
        requireCreationScope(tenantId, idempotencyKey, true);
        ResolvedBinding workspace = workspaces.resolveForCreation(
                tenantId, actorId, selection);
        if (!input.isEmpty()
                && (!"qwen-code".equals(agentId)
                        || !WorkspaceExecutionProfile.CONFIG_REF.equals(workspace.configRef())
                        || !WorkspaceExecutionProfile.POLICY_REF.equals(workspace.policyRef())
                        || workspaceMounts.stream().noneMatch(mount ->
                                tenantId.equals(mount.tenantId())
                                        && workspace.binding().getStorageId().equals(mount.storageId())))) {
            throw workspaceExecutionUnavailable();
        }
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
                        + " WHERE tenant_id = ? AND idempotency_key = ?"
                        + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND actor_id = ?"
                        + " AND CAST(CONCAT(idempotency_key, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))",
                (result, row) -> new WorkspaceCommand(
                        result.getString("request_digest"),
                        result.getString("session_id"),
                        result.getString("turn_id")),
                tenantId, idempotencyKey, tenantId,
                ManagedWorkspaceRegistry.actorKey(tenantId, actorId),
                idempotencyKey);
    }

    private record WorkspaceCommand(String requestDigest, String sessionId,
            String turnId) {
    }

    // A bound Session's creator may rename it under the Workspace-files
    // opt-in (the service checks the creator); unarchive stays gated.
    private boolean boundRenameAllowed(SessionMutationKind kind) {
        return kind == SessionMutationKind.RENAME && workspaceFilesEnabled;
    }

    private static ApiException workspaceExecutionUnavailable() {
        return new ApiException(HttpStatus.CONFLICT,
                "workspace_unavailable",
                "Hosted Workspace execution is not available.");
    }

    private void requireCreationScope(String tenantId, String idempotencyKey,
            boolean workspaceBound) {
        jdbc.update("INSERT INTO managed_session_create_scope"
                        + " (tenant_id, idempotency_key, workspace_bound)"
                        + " VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE"
                        + " workspace_bound = workspace_bound",
                tenantId, idempotencyKey, workspaceBound);
        Boolean existing = jdbc.queryForObject(
                "SELECT workspace_bound FROM managed_session_create_scope"
                        + " WHERE tenant_id = ? AND idempotency_key = ?"
                        + " FOR UPDATE",
                Boolean.class, tenantId, idempotencyKey);
        if (!Boolean.valueOf(workspaceBound).equals(existing)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
    }

    // Called only for a new admission; a retry has already replayed.
    private void requireAgentRevision(String requested) {
        if (requested != null && !requested.equals(agentRevision)) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature",
                    "Only the current agent revision can be selected.");
        }
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
                        + " session_id, agent_id, agent_revision, title,"
                        + " status, created_at, updated_at, workspace_id,"
                        + " workspace_generation, workspace_storage_id,"
                        + " cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref,"
                        + " workspace_policy_ref, tool_profile,"
                        + " creator_actor_key) VALUES"
                        + " (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?)",
                tenantId, sessionId, agentId, agentRevision, title, now, now,
                workspace == null ? null : workspace.getWorkspaceId(),
                workspace == null ? null : workspace.getWorkspaceGeneration(),
                workspace == null ? null : workspace.getStorageId(),
                workspace == null ? null : workspace.getCwdRelative(),
                workspace == null ? null : workspace.getContextConfigRef(),
                workspace == null ? null : workspace.getContextRevision(),
                resolved == null ? null : resolved.configRef(),
                resolved == null ? null : resolved.policyRef(),
                workspace == null ? null : "hosted-workspace-files/1",
                actorId == null ? null
                        : ManagedWorkspaceRegistry.actorKey(tenantId,
                                actorId));
        jdbc.update("INSERT INTO managed_agent_consumer_progress"
                        + " (tenant_id, session_id, consumer_name,"
                        + " covered_sequence, updated_at) VALUES"
                        + " (?, ?, ?, 0, ?)",
                tenantId, sessionId, MESSAGE_PROJECTION, now);
        if (turnId != null) {
            insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
        }
        if (resolved == null) {
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
        if (workspace != null) {
            jdbc.update(
                    "UPDATE managed_agent_session SET approval_mode = ? WHERE tenant_id = ? AND"
                            + " session_id = ?",
                    approvalMode,
                    tenantId,
                    sessionId);
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
        // A bound Session's later Turn needs the same deployment opt-in as
        // its initial one; the service admits only the Session's creator.
        if (session.workspace() != null && !workspaceFilesEnabled) {
            throw workspaceExecutionUnavailable();
        }
        // The replay probe must not lock: a FOR UPDATE read that misses
        // next-key-locks a gap of the tenant-shared command index, and
        // concurrent admissions holding such gap locks deadlock when they
        // all try to insert into the same gap. The PRIMARY KEY deduplicates
        // racing inserts instead, and the service replays on
        // DuplicateKeyException.
        Optional<CommandRecord> existing = findCommand(tenantId, operation,
                idempotencyKey);
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
        // The W2 handshake: an open execution operation on a bound Session
        // is the busy barrier the settlement re-verifies at commit; a
        // later Turn must not slide in underneath it. Narrower than
        // requireNoOpenOperation on purpose: a stuck display mutation
        // (PENDING rename command) or an in-flight ACTION_RESPONSE would
        // otherwise wedge every Turn admission without any recovery scan
        // reading those tables — while the operation-ledger barriers that
        // intentionally cover them stay untouched.
        if (session.workspace() != null
                && hasOpenExecutionOperation(tenantId, sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "session_context_busy",
                    "The Session has an open operation.");
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
        if (requireSessionForUpdate(tenantId, sessionId).workspace() != null
                && !workspaceFilesEnabled) {
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
        if (session.workspace() != null && !boundRenameAllowed(kind)) {
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
            if ("FAILED".equals(command.status())) {
                requireNoOpenOperation(tenantId, sessionId);
                validateMutationStatus(session, kind);
                jdbc.update("UPDATE managed_agent_command SET command_status ="
                                + " 'PENDING', updated_at = ? WHERE tenant_id = ?"
                                + " AND operation = ? AND idempotency_key = ?",
                        clock.millis(), tenantId, operation, idempotencyKey);
                return new SessionMutationCommand(sessionId, "PENDING", true);
            }
            return new SessionMutationCommand(sessionId, command.status(),
                    true);
        }
        requireNoOpenOperation(tenantId, sessionId);
        validateMutationStatus(session, kind);
        long now = clock.millis();
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, null, "PENDING", session.status(), now);
        // Older retired commands may have left their requested event behind.
        String requestedSource = mutationSource(operation, idempotencyKey,
                "requested");
        if (!hasSourceEvent(tenantId, sessionId, requestedSource)) {
            appendEvent(tenantId, sessionId, null,
                    mutationEvent(kind, "requested"),
                    Map.of("sessionId", sessionId), false,
                    requestedSource, now);
        }
        return new SessionMutationCommand(sessionId, "PENDING", false);
    }

    @Transactional
    public SessionRecord completeSessionMutation(String tenantId,
            String operation, String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !boundRenameAllowed(kind)) {
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
        if (!"PENDING".equals(command.status())
                && !"FAILED".equals(command.status())) {
            throw new IllegalStateException(
                    "Session mutation command has an unknown status");
        }
        validateMutationStatus(session, kind);
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
            // An archived Session was closed first, so it stays closed.
            case UNARCHIVE -> jdbc.update("UPDATE managed_agent_session SET"
                            + " status = 'CLOSED', updated_at = ?, version ="
                            + " version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ?",
                    now, tenantId, sessionId);
        }
        jdbc.update("UPDATE managed_agent_command SET command_status ="
                        + " 'COMPLETED', updated_at = ? WHERE tenant_id = ?"
                        + " AND operation = ? AND idempotency_key = ?",
                now, tenantId, operation, idempotencyKey);
        appendEvent(tenantId, sessionId, null,
                mutationEvent(kind, "completed"), data, false,
                mutationSource(operation, idempotencyKey,
                        "completed"), now);
        return requireSessionForUpdate(tenantId, sessionId);
    }

    @Override
    @Transactional
    public void abandonSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId) {
        // Keep the digest and receipt for replay and concurrent completion.
        // A completed outcome must never be overwritten by a failing sibling.
        jdbc.update("UPDATE managed_agent_command SET command_status = 'FAILED',"
                        + " updated_at = ? WHERE tenant_id = ?"
                        + " AND operation = ? AND idempotency_key = ?"
                        + " AND session_id = ? AND command_status = 'PENDING'",
                clock.millis(), tenantId, operation, idempotencyKey, sessionId);
    }

    @Override
    @Transactional
    public OperationAdmission beginOperation(String tenantId,
            String sessionId, OperationKind kind, String actorDigest,
            String idempotencyKey, String requestDigest) {
        if (requireSessionForUpdate(tenantId, sessionId).workspace() != null) {
            throw workspaceExecutionUnavailable();
        }
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest, null, false);
    }

    @Override
    public boolean workspaceFilesEnabled() {
        return workspaceFilesEnabled;
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceClose(String tenantId, String sessionId, String actorId,
            String actorDigest, String key, String digest, boolean supported) {
        return beginLifecycle(tenantId, sessionId, OperationKind.CLOSE, actorDigest, key, digest, actorId, supported);
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key, String digest, boolean closeSupported) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, key, digest, actorId, closeSupported);
    }

    @Override
    public boolean hasCompletedWorkspaceClose(String tenantId, String sessionId) {
        return completedWorkspaceCloses(tenantId, List.of(sessionId))
                .contains(sessionId);
    }

    /** The given Sessions with a completed workspace close, in one read. */
    @Override
    public Set<String> completedWorkspaceCloses(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Set.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 1);
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        return new HashSet<>(jdbc.queryForList("SELECT session_id FROM"
                        + " managed_agent_operation WHERE tenant_id = ?"
                        + " AND session_id IN (" + placeholders(sessionIds.size())
                        + ") AND operation_kind = 'CLOSE' AND state = 'COMPLETED'"
                        + " AND receipt_id IS NOT NULL",
                String.class, arguments.toArray()));
    }

    private void requireWorkspaceCreator(SessionRecord session, String actorId) {
        if (!workspaces.canRead(session.tenantId(), actorId, session.workspace().getWorkspaceId())) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found.");
        }
        if (!workspaces.isSessionCreator(session.tenantId(), session.sessionId(), actorId)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "session_operation_forbidden",
                    "Only the Session creator may manage it.");
        }
    }

    @Override
    @Transactional
    public SessionMutation unarchiveWorkspaceSession(String tenantId, String sessionId,
            String actorId, String scopedKey, String requestDigest) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        requireWorkspaceCreator(session, actorId);
        if ("DELETED".equals(session.status())) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found.");
        }
        String namespace = "UNARCHIVE_WORKSPACE_SESSION";
        Optional<CommandRecord> existing = findCommand(tenantId, namespace, scopedKey, true);
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest) || !existing.get().sessionId().equals(sessionId)) {
                throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new SessionMutation(session, true);
        }
        requireSessionStatus(session.status(), "ARCHIVED");
        requireNoOpenOperation(tenantId, sessionId);
        if (!hasCompletedWorkspaceClose(tenantId, sessionId)) {
            throw workspaceExecutionUnavailable();
        }
        long now = lifecycleDatabaseTime();
        insertCommand(tenantId, namespace, scopedKey, requestDigest, sessionId, null, "COMPLETED", "ARCHIVED", now);
        Map<String, Object> data = Map.of("sessionId", sessionId);
        appendEvent(tenantId, sessionId, null, "session.unarchive.requested", data, false,
                mutationSource(namespace, scopedKey, "requested"), now);
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSED', updated_at = ?, version = version + 1"
                + " WHERE tenant_id = ? AND session_id = ?", now, tenantId, sessionId);
        appendEvent(tenantId, sessionId, null, "session.unarchived", data, false,
                mutationSource(namespace, scopedKey, "completed"), now);
        return new SessionMutation(requireSessionForUpdate(tenantId, sessionId), false);
    }

    private OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorDigest, String idempotencyKey, String requestDigest, String actorId, boolean supported) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null) {
            requireWorkspaceCreator(session, actorId);
        }
        Optional<OperationRecord> existing = jdbc.query("SELECT * FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_kind = ? AND"
                        + " actor_digest = ? AND idempotency_key = ? AND"
                        + " CAST(CONCAT(idempotency_key, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))",
                operationMapper, tenantId, sessionId, kind.name(),
                actorDigest, idempotencyKey, idempotencyKey)
                .stream().findFirst();
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest)) {
                throw new ApiException(HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new OperationAdmission(existing.get(), true);
        }
        if ("DELETED".equals(session.status())) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                    "The Session was not found.");
        }
        if (session.workspace() != null) {
            if (kind == OperationKind.CLOSE) {
                if (!supported || !workspaceFilesEnabled) {
                    throw workspaceExecutionUnavailable();
                }
                if ("ACTIVE".equals(session.status())) {
                    validateOperationStart(session, kind);
                }
            } else {
                if (kind == OperationKind.ARCHIVE) {
                    requireSessionStatus(session.status(), "CLOSED");
                } else if (!List.of("CLOSED", "ARCHIVED").contains(session.status())) {
                    throw sessionStateConflict(session.status());
                }
                requireNoOpenOperation(tenantId, sessionId);
                if (!hasCompletedWorkspaceClose(tenantId, sessionId)) {
                    throw workspaceExecutionUnavailable();
                }
            }
        }
        requireNoOpenOperation(tenantId, sessionId);
        validateOperationStart(session, kind);
        long now = lifecycleDatabaseTime();
        String operationId = publicId("op");
        Map<String, Object> data = Map.of("sessionId", sessionId,
                "operationId", operationId);
        // Java is the only authority an archive needs, so it completes here.
        boolean archive = kind == OperationKind.ARCHIVE;
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before, receipt_id, available_at,"
                        + " created_at, updated_at, completed_at) VALUES"
                        + " (?, ?, ?, ?, ?, ?, ?, ?, 'JAVA_DURABLE', ?, ?, ?,"
                        + " ?, ?, ?, ?)",
                tenantId, sessionId, operationId, kind.name(), actorDigest,
                idempotencyKey, requestDigest,
                archive ? "COMPLETED" : "PENDING",
                archive ? "CONFIRMED" : "PENDING", session.status(),
                archive ? publicId("rcpt") : null, now, now, now,
                archive ? now : null);
        jdbc.update("UPDATE managed_agent_session SET status = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                archive ? "ARCHIVED" : pendingStatus(kind), now, tenantId,
                sessionId);
        appendEvent(tenantId, sessionId, null,
                archive ? completedEvent(kind) : requestedEvent(kind), data,
                false, operationSource(operationId,
                        archive ? "completed" : "requested"), now);
        return new OperationAdmission(findOperation(tenantId, sessionId,
                operationId).orElseThrow(), false);
    }

    @Override
    @Transactional
    public OperationAdmission beginCwdChangeOperation(String tenantId,
            String sessionId, String actorId, String actorDigest,
            String idempotencyKey, String requestDigest,
            String targetCwdRelative, long expectedContextRevision) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        ContextBinding binding = session.workspace();
        if (binding == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature",
                    "The Session has no Workspace context.");
        }
        // Invisibility comes before any refusal that diagnoses facts:
        // a caller without read access must not learn whether a Session,
        // a key or the deployment flag exists. The replay follows it, so a
        // lost 202 always resolves to the original operation even when the
        // deployment has since disabled execution — the idempotency
        // contract outranks the flag gate, exactly as beginLifecycle does.
        requireCwdChangeActor(session, actorId);
        Optional<OperationRecord> existing = jdbc.query("SELECT * FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_kind = ? AND"
                        + " actor_digest = ? AND idempotency_key = ? AND"
                        + " CAST(CONCAT(idempotency_key, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))",
                operationMapper, tenantId, sessionId,
                OperationKind.CWD_CHANGE.name(), actorDigest, idempotencyKey,
                idempotencyKey)
                .stream().findFirst();
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest)) {
                throw new ApiException(HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new OperationAdmission(existing.get(), true);
        }
        if (!workspaceFilesEnabled) {
            throw workspaceExecutionUnavailable();
        }
        if ("DELETED".equals(session.status())) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                    "The Session was not found.");
        }
        if (!"ACTIVE".equals(session.status())) {
            throw sessionStateConflict(session.status());
        }
        requireCwdChangeRegistryFacts(session);
        if (binding.getContextRevision() != expectedContextRevision) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "context_revision_conflict",
                    "The Session context revision has changed.");
        }
        // A requested permission Action is busy too — the sibling
        // lifecycle admission refuses in exactly this state (409
        // turn_active), so the directory change must hold as well.
        if (hasOpenOperation(tenantId, sessionId)
                || hasActiveTurn(tenantId, sessionId)
                || hasDecidableAction(session)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "session_context_busy",
                    "The Session has an active Turn or operation.");
        }
        long now = lifecycleDatabaseTime();
        String operationId = publicId("op");
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before, target_cwd_relative,"
                        + " expected_context_revision, available_at,"
                        + " created_at, updated_at) VALUES"
                        + " (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'JAVA_DURABLE',"
                        + " 'PENDING', ?, ?, ?, ?, ?, ?)",
                tenantId, sessionId, operationId,
                OperationKind.CWD_CHANGE.name(), actorDigest, idempotencyKey,
                requestDigest, session.status(), targetCwdRelative,
                expectedContextRevision, now, now, now);
        return new OperationAdmission(findOperation(tenantId, sessionId,
                operationId).orElseThrow(), false);
    }

    @Override
    @Transactional
    public CwdChangeOutcome completeCwdChangeOperation(String tenantId,
            String sessionId, String operationId, String owner,
            long claimGeneration) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        OperationRecord operation = jdbc.query("SELECT * FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ? FOR UPDATE",
                operationMapper, tenantId, sessionId, operationId).stream()
                .findFirst().orElseThrow(() -> new IllegalStateException(
                        "Session operation is unavailable"));
        if (operation.kind() != OperationKind.CWD_CHANGE) {
            throw new IllegalStateException("Operation " + operationId
                    + " is not a cwd change");
        }
        Long leaseUntil = jdbc.queryForObject("SELECT lease_until FROM"
                + " managed_agent_operation WHERE tenant_id = ? AND"
                + " session_id = ? AND operation_id = ? FOR UPDATE",
                Long.class, tenantId, sessionId, operationId);
        if (leaseUntil == null || leaseUntil <= lifecycleDatabaseTime()
                || !"LEASED".equals(operation.deliveryState())
                || !owner.equals(operation.leaseOwner())
                || operation.claimGeneration() != claimGeneration) {
            return null;
        }
        long now = lifecycleDatabaseTime();
        ContextBinding binding = session.workspace();
        long expected = operation.expectedContextRevision() == null ? -1
                : operation.expectedContextRevision();
        String failure = null;
        if (binding == null || !"ACTIVE".equals(session.status())) {
            failure = "workspace_unavailable";
        } else if (binding.getContextRevision() != expected) {
            failure = "context_revision_conflict";
        } else if (hasOpenOperation(tenantId, sessionId, operationId)
                || hasActiveTurn(tenantId, sessionId)
                || hasDecidableAction(session)) {
            failure = "session_context_busy";
        } else if (!hasCwdChangeRegistryFacts(session)) {
            failure = "workspace_unavailable";
        }
        if (failure != null) {
            jdbc.update("UPDATE managed_agent_operation SET state ="
                            + " 'FAILED', delivery_state = 'CONFIRMED',"
                            + " error_code = ?, lease_owner = NULL,"
                            + " lease_until = NULL, updated_at = ?,"
                            + " completed_at = ? WHERE tenant_id = ? AND"
                            + " session_id = ? AND operation_id = ?",
                    failure, now, now, tenantId, sessionId, operationId);
            return new CwdChangeOutcome(false, failure, null);
        }
        long result = expected + 1;
        jdbc.update("UPDATE managed_agent_session SET cwd_relative = ?,"
                        + " context_revision = ?, updated_at = ?, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ?",
                operation.targetCwdRelative(), result, now, tenantId,
                sessionId);
        jdbc.update("UPDATE managed_agent_operation SET state ="
                        + " 'COMPLETED', delivery_state = 'CONFIRMED',"
                        + " receipt_id = ?, result_context_revision = ?,"
                        + " lease_owner = NULL, lease_until = NULL,"
                        + " updated_at = ?, completed_at = ? WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ?",
                publicId("rcpt"), result, now, now, tenantId, sessionId,
                operationId);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("operationId", operationId);
        data.put("workspaceId", binding.getWorkspaceId());
        data.put("cwdRelative", operation.targetCwdRelative());
        data.put("contextRevision", result);
        appendEvent(tenantId, sessionId, null, "session.context.changed",
                Map.copyOf(data), false, operationSource(operationId,
                        "completed"), now);
        return new CwdChangeOutcome(true, null, result);
    }

    @Override
    @Transactional
    public boolean failCwdChangeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode) {
        long now = lifecycleDatabaseTime();
        return jdbc.update("UPDATE managed_agent_operation SET state ="
                        + " 'FAILED', delivery_state = 'CONFIRMED',"
                        + " error_code = ?, lease_owner = NULL,"
                        + " lease_until = NULL, updated_at = ?,"
                        + " completed_at = ? WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ? AND"
                        + " delivery_state = 'LEASED' AND lease_owner = ?"
                        + " AND claim_generation = ? AND lease_until > ?",
                failureCode, now, now, tenantId, sessionId, operationId,
                owner, claimGeneration, now) == 1;
    }

    // Only the creation actor may move the Session's directory, matching
    // the sibling lifecycle refusals: unreadable 404, a readable actor who
    // is not the creator 403 session_operation_forbidden. The settlement
    // still re-verifies the creator's full grant set at commit.
    private void requireCwdChangeActor(SessionRecord session,
            String actorId) {
        requireWorkspaceCreator(session, actorId);
    }

    private void requireCwdChangeRegistryFacts(SessionRecord session) {
        if (!hasCwdChangeRegistryFacts(session)) {
            throw workspaceExecutionUnavailable();
        }
    }

    // The Registry still backs the binding exactly, its state is ACTIVE and
    // the creation actor's grants survive — the passive-attachment subset the
    // settlement gates on; the frozen profile and agent checks stay the next
    // turn's acquire-time gate.
    private boolean hasCwdChangeRegistryFacts(SessionRecord session) {
        List<Boolean> rows = jdbc.query("SELECT 1 FROM"
                        + " managed_agent_session s JOIN"
                        + " managed_workspace_registry r ON r.tenant_id ="
                        + " s.tenant_id AND r.workspace_id = s.workspace_id"
                        + " JOIN managed_workspace_create_command c ON"
                        + " c.tenant_id = s.tenant_id AND c.session_id ="
                        + " s.session_id JOIN managed_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id AND a.workspace_id ="
                        + " r.workspace_id AND a.actor_id = c.actor_id"
                        + " WHERE s.tenant_id = ? AND s.session_id = ? AND"
                        + " r.workspace_generation = s.workspace_generation"
                        + " AND r.storage_id = s.workspace_storage_id AND"
                        + " r.state = 'ACTIVE' AND a.can_read = TRUE AND"
                        + " a.can_create = TRUE",
                (row, index) -> Boolean.TRUE, session.tenantId(),
                session.sessionId());
        return rows.size() == 1;
    }

    private boolean hasOpenOperation(String tenantId, String sessionId) {
        return hasOpenOperation(tenantId, sessionId, null);
    }

    // The bound later-Turn barrier: context-changing operations only —
    // pending command rows and permission-action operations are excluded,
    // matching the recovery scan's own population.
    private boolean hasOpenExecutionOperation(String tenantId,
            String sessionId) {
        Integer operations = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_kind <>"
                        + " 'ACTION_RESPONSE' AND state IN ('PENDING',"
                        + " 'RUNNING', 'RECOVERY_BLOCKED')",
                Integer.class, tenantId, sessionId);
        return operations != null && operations > 0;
    }

    private boolean hasOpenOperation(String tenantId, String sessionId,
            String excludingOperationId) {
        Integer commands = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_command WHERE tenant_id = ? AND"
                        + " session_id = ? AND command_status = 'PENDING'",
                Integer.class, tenantId, sessionId);
        Integer operations = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND state IN ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED')"
                        + " AND operation_id <> COALESCE(?, '')",
                Integer.class, tenantId, sessionId, excludingOperationId);
        return (commands != null && commands > 0)
                || (operations != null && operations > 0);
    }

    @Override
    public Optional<OperationRecord> findOperation(String tenantId,
            String sessionId, String operationId) {
        return jdbc.query("SELECT * FROM managed_agent_operation WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ?",
                operationMapper, tenantId, sessionId, operationId)
                .stream().findFirst();
    }

    @Override
    public List<OperationTarget> findDeliverableOperations(long now,
            int limit) {
        now = lifecycleDatabaseTime();
        List<OperationTarget> targets =
                new ArrayList<>(
                        jdbc.query(
                                "SELECT tenant_id, session_id, operation_id FROM"
                                        + " managed_agent_operation WHERE operation_kind <>"
                                        + " 'ACTION_RESPONSE' AND (delivery_state = 'PENDING' OR (delivery_state = 'BLOCKED' AND (operation_kind = 'CLOSE'"
                                        + " OR (operation_kind = 'DELETE' AND session_status_before IN ('CLOSED', 'ARCHIVED'))))) AND"
                                        + " available_at <= ? ORDER BY available_at LIMIT ?",
                                operationTargetMapper,
                                now,
                                limit));
        if (targets.size() < limit) {
            targets.addAll(
                    jdbc.query(
                            "SELECT tenant_id, session_id, operation_id FROM"
                                + " managed_agent_operation WHERE operation_kind <>"
                                + " 'ACTION_RESPONSE' AND delivery_state = 'LEASED' AND lease_until"
                                + " < ? ORDER BY lease_until LIMIT ?",
                            operationTargetMapper,
                            now,
                            limit - targets.size()));
        }
        return List.copyOf(targets);
    }

    @Override
    @Transactional
    public Optional<OperationRecord> claimOperation(String tenantId,
            String sessionId, String operationId, String owner,
            Duration leaseDuration) {
        long now = lifecycleDatabaseTime();
        int updated = jdbc.update("UPDATE managed_agent_operation SET state ="
                        + " 'RUNNING', delivery_state = 'LEASED',"
                        + " lease_owner = ?, lease_until = ?,"
                        + " claim_generation = claim_generation + 1,"
                        + " updated_at = ? WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ? AND"
                        + " (((delivery_state = 'PENDING' OR (delivery_state = 'BLOCKED' AND (operation_kind = 'CLOSE'"
                        + " OR (operation_kind = 'DELETE' AND session_status_before IN ('CLOSED', 'ARCHIVED'))))) AND available_at <= ?)"
                        + " OR (delivery_state = 'LEASED' AND lease_until < ?))",
                owner, Math.addExact(now, leaseDuration.toMillis()), now,
                tenantId, sessionId, operationId, now, now);
        return updated == 1 ? findOperation(tenantId, sessionId, operationId)
                : Optional.empty();
    }

    @Override
    @Transactional
    public boolean completeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            boolean harnessConfirmed) {
        var target = findOperation(tenantId, sessionId, operationId).orElseThrow();
        if (target.kind() == OperationKind.DELETE) {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenantId, sessionId);
        }
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        OperationRecord operation = jdbc.query("SELECT * FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ? FOR UPDATE",
                operationMapper, tenantId, sessionId, operationId).stream()
                .findFirst().orElseThrow(() -> new IllegalStateException(
                        "Session operation is unavailable"));
        Long leaseUntil = jdbc.queryForObject("SELECT lease_until FROM managed_agent_operation"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ? FOR UPDATE", Long.class,
                tenantId, sessionId, operationId);
        if (leaseUntil == null || leaseUntil <= lifecycleDatabaseTime()
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
        long now = lifecycleDatabaseTime();
        if (operation.kind() == OperationKind.DELETE) {
            if (session.workspace() != null && !List.of("CLOSED", "ARCHIVED").contains(operation.sessionStatusBefore())) {
                throw new IllegalStateException("Workspace deletion requires a closed Session");
            }
            ToolPublicationRetentionStore.retire(jdbc, tenantId, sessionId, operationId);
        }
        switch (operation.kind()) {
            case CLOSE, ARCHIVE -> jdbc.update("UPDATE managed_agent_session"
                            + " SET status = ?, harness_event_epoch = NULL,"
                            + " harness_last_event_id = 0, updated_at = ?,"
                            + " version = version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ?",
                    operation.kind() == OperationKind.CLOSE ? "CLOSED"
                            : "ARCHIVED", now, tenantId, sessionId);
            case DELETE -> jdbc.update("UPDATE managed_agent_session SET"
                            + " status = 'DELETED', harness_boot_id = NULL,"
                            + " harness_event_epoch = NULL,"
                            + " harness_last_event_id = 0, deleted_at = ?,"
                            + " updated_at = ?, version = version + 1 WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    now, now, tenantId, sessionId);
        }
        jdbc.update("UPDATE managed_agent_operation SET error_code = NULL, state = 'COMPLETED',"
                        + " admission_stage = ?, delivery_state = 'CONFIRMED',"
                        + " receipt_id = ?, lease_owner = NULL,"
                        + " lease_until = NULL, updated_at = ?,"
                        + " completed_at = ? WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ?",
                harnessConfirmed ? "HARNESS_CONFIRMED" : "JAVA_DURABLE",
                publicId("rcpt"), now, now, tenantId, sessionId,
                operationId);
        appendEvent(tenantId, sessionId, null,
                completedEvent(operation.kind()),
                Map.of("sessionId", sessionId, "operationId", operationId),
                operation.kind() == OperationKind.DELETE,
                operationSource(operationId, "completed"), now);
        return true;
    }

    private long lifecycleDatabaseTime() {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Math.addExact(Math.multiplyExact(row.getLong(1), 1000), row.getLong(2) / 1000));
    }

    @Override
    @Transactional
    public boolean renewLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, Duration duration) {
        long now = lifecycleDatabaseTime();
        return jdbc.update("UPDATE managed_agent_operation SET lease_until = ?, updated_at = ?"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ? AND delivery_state = 'LEASED'"
                + " AND lease_owner = ? AND claim_generation = ? AND lease_until > ?",
                Math.addExact(now, duration.toMillis()), now, tenantId, sessionId, operationId, owner, generation, now) == 1;
    }

    @Override
    @Transactional
    public void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt) {
        long now = lifecycleDatabaseTime();
        jdbc.update("UPDATE managed_agent_operation SET state = 'RECOVERY_BLOCKED', delivery_state = 'BLOCKED',"
                + " error_code = ?, available_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?,"
                + " attempt_count = attempt_count + 1"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ? AND delivery_state = 'LEASED'"
                + " AND lease_owner = ? AND claim_generation = ? AND lease_until > ?",
                failureCode, Math.addExact(now, Math.max(0, availableAt - clock.millis())),
                now, tenantId, sessionId, operationId, owner, generation, now);
    }

    @Override
    @Transactional
    public void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt) {
        long delay = Math.max(0, availableAt - clock.millis());
        long now = lifecycleDatabaseTime();
        availableAt = Math.addExact(now, delay);
        jdbc.update("UPDATE managed_agent_operation SET delivery_state ="
                        + " 'PENDING', lease_owner = NULL, lease_until = NULL,"
                        + " attempt_count = attempt_count + 1,"
                        + " available_at = ?, updated_at = ? WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ? AND delivery_state = 'LEASED'"
                        + " AND lease_owner = ? AND claim_generation = ? AND lease_until > ?",
                availableAt, now, tenantId, sessionId,
                operationId, owner, claimGeneration, now);
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
                        + " tenant_id = ? AND idempotency_key = ? AND"
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
                tenantId, idempotencyKey, tenantId, operation, idempotencyKey);
        return rows.stream().findFirst();
    }

    public Optional<SessionRecord> findSession(String tenantId,
            String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_session WHERE tenant_id = ? AND"
                        + " CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND session_id = ?",
                sessionMapper, tenantId, tenantId, sessionId);
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
                "SELECT * FROM managed_agent_session WHERE tenant_id = ? AND"
                        + " CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND status <> 'DELETED'"
                        + " AND (workspace_id IS NULL OR EXISTS (SELECT 1"
                        + " FROM managed_workspace_access wa"
                        + " WHERE wa.tenant_id = managed_agent_session.tenant_id"
                        + " AND wa.workspace_id = managed_agent_session.workspace_id"
                        + " AND CAST(CONCAT(wa.tenant_id, '!') AS BINARY(513))"
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

    /** The active Turn of each given Session, in one round trip. */
    public Map<String, TurnSummary> findActiveTurns(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 1);
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        List<TurnSummary> rows = jdbc.query("SELECT " + TURN_SUMMARY_COLUMNS
                        + " FROM managed_agent_turn"
                        + " WHERE tenant_id = ? AND session_id IN ("
                        + placeholders(sessionIds.size()) + ") AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') ORDER BY"
                        + " created_at DESC",
                turnSummaryMapper, arguments.toArray());
        Map<String, TurnSummary> result = new HashMap<>(
                sessionIds.size() * 2);
        for (TurnSummary row : rows) {
            result.putIfAbsent(row.sessionId(), row);
        }
        return result;
    }

    /** The latest Turn of each given Session, in one round trip. */
    public Map<String, TurnSummary> findLatestTurns(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 3);
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        arguments.add(tenantId);
        arguments.add(tenantId);
        List<TurnSummary> rows = jdbc.query("SELECT "
                        + QUALIFIED_TURN_SUMMARY_COLUMNS + " FROM"
                        + " managed_agent_turn turn_record JOIN (SELECT"
                        + " event.session_id, event.turn_id FROM"
                        + " managed_agent_event event JOIN (SELECT session_id,"
                        + " MAX(sequence_id) AS max_sequence FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id IN (" + placeholders(sessionIds.size())
                        + ") AND event_type = 'turn.accepted' GROUP BY"
                        + " session_id) latest ON latest.session_id ="
                        + " event.session_id AND latest.max_sequence ="
                        + " event.sequence_id WHERE event.tenant_id = ?)"
                        + " latest_turn ON latest_turn.session_id ="
                        + " turn_record.session_id AND latest_turn.turn_id ="
                        + " turn_record.turn_id WHERE turn_record.tenant_id ="
                        + " ?",
                turnSummaryMapper, arguments.toArray());
        Map<String, TurnSummary> result = new HashMap<>(
                sessionIds.size() * 2);
        for (TurnSummary row : rows) {
            result.put(row.sessionId(), row);
        }
        return result;
    }

    // Reads leave the Turn's input out; the public view never shows it.
    @Override
    public TurnPage listTurns(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTurnId, int limit) {
        List<Object> arguments = new ArrayList<>(List.of(tenantId,
                sessionId));
        String before = "";
        if (beforeCreatedAt != null) {
            before = " AND (created_at < ? OR (created_at = ? AND"
                    + " turn_id < ?))";
            arguments.add(beforeCreatedAt);
            arguments.add(beforeCreatedAt);
            arguments.add(beforeTurnId);
        }
        arguments.add(limit + 1);
        List<TurnSummary> rows = jdbc.query("SELECT " + TURN_SUMMARY_COLUMNS
                        + " FROM managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ?" + before + " ORDER BY created_at"
                        + " DESC, turn_id DESC LIMIT ?",
                turnSummaryMapper, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new TurnPage(hasMore ? List.copyOf(rows.subList(0, limit))
                : rows, hasMore);
    }

    @Override
    public Optional<TurnSummary> findTurnSummary(String tenantId,
            String sessionId, String turnId) {
        return jdbc.query("SELECT " + TURN_SUMMARY_COLUMNS + " FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ?",
                turnSummaryMapper, tenantId, sessionId, turnId).stream()
                // The binary collation ignores trailing spaces, so the
                // database also matches an ID that adds some.
                .filter(turn -> turn.turnId().equals(turnId))
                .findFirst();
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

    /**
     * The latest environment event of each Session's latest Turn, in one
     * round trip; the Turns are already loaded, so the turn-row join of the
     * single-session read is implied.
     */
    public Map<String, EventRecord> findLatestEnvironmentEvents(
            String tenantId, Map<String, TurnSummary> latestTurns) {
        if (latestTurns.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(latestTurns.size() * 2 + 2);
        arguments.add(tenantId);
        StringBuilder pairs = new StringBuilder();
        for (TurnSummary turn : latestTurns.values()) {
            if (pairs.length() > 0) {
                pairs.append(",");
            }
            pairs.append(" (?, ?)");
            arguments.add(turn.sessionId());
            arguments.add(turn.turnId());
        }
        arguments.add(tenantId);
        // One row per session: the latest environment event of its latest
        // Turn, selected in SQL instead of shipping every match per pair.
        List<EventRecord> rows = jdbc.query("SELECT event.* FROM"
                        + " managed_agent_event event JOIN (SELECT session_id,"
                        + " MAX(sequence_id) AS max_sequence FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " event_type IN ('environment.provisioning',"
                        + " 'environment.ready', 'environment.failed') AND"
                        + " (session_id, turn_id) IN (" + pairs + ")"
                        + " GROUP BY session_id) latest ON latest.session_id ="
                        + " event.session_id AND latest.max_sequence ="
                        + " event.sequence_id WHERE event.tenant_id = ?",
                eventMapper, arguments.toArray());
        Map<String, EventRecord> result = new HashMap<>(latestTurns.size() * 2);
        for (EventRecord row : rows) {
            result.put(row.sessionId(), row);
        }
        return result;
    }

    public List<EventRecord> findControlEvents(String tenantId,
            String sessionId, long throughSequence) {
        requireSession(tenantId, sessionId);
        return jdbc.query("SELECT * FROM managed_agent_event WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " sequence_id <= ? AND event_type NOT IN"
                        + " ('turn.accepted', 'item.output_text.delta',"
                        + " 'item.reasoning.delta',"
                        + " 'item.tool_call.updated', 'item.tool_result.updated') ORDER BY sequence_id"
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

    /** The snapshot's covered sequence of each given Session, in one read. */
    public Map<String, Long> findSnapshotCoveredSequences(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 1);
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        Map<String, Long> result = new HashMap<>(sessionIds.size() * 2);
        RowCallbackHandler reader = row -> result.put(
                row.getString("session_id"), row.getLong("covered_sequence"));
        jdbc.query("SELECT session_id, covered_sequence FROM"
                        + " managed_agent_snapshot WHERE tenant_id = ? AND"
                        + " session_id IN (" + placeholders(sessionIds.size())
                        + ")", reader, arguments.toArray());
        return result;
    }

    public ReplayWindow findReplayWindow(String tenantId, String sessionId) {
        List<ReplayWindow> rows = jdbc.query("SELECT"
                        + " s.replay_floor_sequence, p.covered_sequence FROM"
                        + " managed_agent_session s LEFT JOIN"
                        + " managed_agent_snapshot p ON p.tenant_id ="
                        + " s.tenant_id AND p.session_id = s.session_id WHERE"
                        + " s.tenant_id = ? AND s.session_id = ?",
                (result, row) -> new ReplayWindow(
                        result.getLong("replay_floor_sequence"),
                        result.getLong("covered_sequence")),
                tenantId, sessionId);
        if (rows.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                    "The Session was not found.");
        }
        return rows.getFirst();
    }

    /**
     * Raises the replay floor, never above the Snapshot's covered sequence,
     * so that a client told to resync can resume from the Snapshot. Nothing
     * prunes events yet; the retention work will call this before pruning.
     */
    @Transactional
    public ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence) {
        requireSessionForUpdate(tenantId, sessionId);
        ReplayWindow window = findReplayWindow(tenantId, sessionId);
        long floor = Math.min(floorSequence,
                window.snapshotThroughSequence());
        if (floor <= window.floorSequence()) {
            return window;
        }
        jdbc.update("UPDATE managed_agent_session SET replay_floor_sequence"
                        + " = ? WHERE tenant_id = ? AND session_id = ?",
                floor, tenantId, sessionId);
        return new ReplayWindow(floor, window.snapshotThroughSequence());
    }

    public List<MaterializationTarget> findMaterializationTargets(int limit) {
        // The second disjunct re-selects a session whose drained batch
        // deferred the snapshot rewrite, once the deferral marker is old
        // enough; without it a caught-up idle session would stay stale
        // forever.
        return jdbc.query("SELECT s.tenant_id, s.session_id FROM"
                        + " managed_agent_session s JOIN"
                        + " managed_agent_consumer_progress p ON"
                        + " p.tenant_id = s.tenant_id AND p.session_id ="
                        + " s.session_id AND p.consumer_name = ? WHERE"
                        + " s.last_sequence > p.covered_sequence"
                        + " OR (p.snapshot_stale_since IS NOT NULL"
                        + " AND p.snapshot_stale_since <= ?)"
                        + " ORDER BY p.updated_at ASC LIMIT ?",
                (result, row) -> new MaterializationTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id")),
                MESSAGE_PROJECTION, clock.millis() - SNAPSHOT_REFRESH_MILLIS,
                limit);
    }

    @Transactional
    public MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
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
            // Reselected only because the snapshot still lags the progress:
            // converge it now.
            rewriteStaleSnapshot(tenantId, sessionId, covered);
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
        List<SnapshotState> snapshots = snapshotForUpdate(tenantId,
                sessionId);
        // A full rewrite costs O(items) under the session row lock, so it
        // runs at creation, every SNAPSHOT_REFRESH_EVENTS behind, on the
        // batch that ends a Turn, and on a drained batch at most once per
        // SNAPSHOT_REFRESH_MILLIS — a deferred drained batch marks the
        // progress row so findMaterializationTargets re-selects the session
        // once the snapshot ages out.
        boolean defer = !snapshots.isEmpty()
                && nextCovered - snapshots.get(0).coveredSequence()
                        < SNAPSHOT_REFRESH_EVENTS
                && events.stream().noneMatch(EventRecord::terminal)
                && !(nextCovered >= session.lastSequence()
                        && now - snapshots.get(0).updatedAt()
                                >= SNAPSHOT_REFRESH_MILLIS);
        jdbc.update("UPDATE managed_agent_consumer_progress SET"
                        + " covered_sequence = ?, updated_at = ?,"
                        + " snapshot_stale_since = ? WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " consumer_name = ?",
                nextCovered, now,
                defer ? snapshots.get(0).updatedAt() : null,
                tenantId, sessionId, MESSAGE_PROJECTION);
        if (defer) {
            return new MaterializationResult(true, nextCovered);
        }
        writeSnapshot(tenantId, sessionId, snapshots, nextCovered, now);
        return new MaterializationResult(true, nextCovered);
    }

    /**
     * Rewrites a snapshot that still lags the projection by a batch whose
     * rewrite the gate deferred, once it is SNAPSHOT_REFRESH_MILLIS old.
     */
    private void rewriteStaleSnapshot(String tenantId, String sessionId,
            long covered) {
        List<SnapshotState> snapshots = snapshotForUpdate(tenantId,
                sessionId);
        long now = clock.millis();
        if (snapshots.isEmpty()
                || snapshots.get(0).coveredSequence() >= covered) {
            // No longer lagging (e.g. recreated by a retraction): drop any
            // stale deferral marker.
            jdbc.update("UPDATE managed_agent_consumer_progress SET"
                            + " snapshot_stale_since = NULL WHERE tenant_id = ?"
                            + " AND session_id = ? AND consumer_name = ?"
                            + " AND snapshot_stale_since IS NOT NULL",
                    tenantId, sessionId, MESSAGE_PROJECTION);
            return;
        }
        if (now - snapshots.get(0).updatedAt() < SNAPSHOT_REFRESH_MILLIS) {
            return;
        }
        writeSnapshot(tenantId, sessionId, snapshots, covered, now);
        jdbc.update("UPDATE managed_agent_consumer_progress SET"
                        + " snapshot_stale_since = NULL WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name = ?",
                tenantId, sessionId, MESSAGE_PROJECTION);
    }

    private List<SnapshotState> snapshotForUpdate(String tenantId,
            String sessionId) {
        return jdbc.query("SELECT snapshot_version, covered_sequence,"
                        + " updated_at FROM managed_agent_snapshot WHERE"
                        + " tenant_id = ? AND session_id = ? FOR UPDATE",
                (result, row) -> new SnapshotState(
                        result.getLong("snapshot_version"),
                        result.getLong("covered_sequence"),
                        result.getLong("updated_at")),
                tenantId, sessionId);
    }

    private void writeSnapshot(String tenantId, String sessionId,
            List<SnapshotState> snapshots, long covered, long now) {
        List<ItemRecord> items = allItems(tenantId, sessionId);
        if (snapshots.isEmpty()) {
            jdbc.update("INSERT INTO managed_agent_snapshot (tenant_id,"
                            + " session_id, snapshot_version,"
                            + " covered_sequence, items_json, created_at,"
                            + " updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)",
                    tenantId, sessionId, covered, writeJson(items), now,
                    now);
        } else {
            jdbc.update("UPDATE managed_agent_snapshot SET"
                            + " snapshot_version = ?, covered_sequence = ?,"
                            + " items_json = ?, updated_at = ? WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    snapshots.get(0).version() + 1, covered,
                    writeJson(items), now, tenantId, sessionId);
        }
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
        long firstRetracted = Long.MAX_VALUE;
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
            firstRetracted = Math.min(firstRetracted, event.sequence());
        }
        if (firstRetracted != Long.MAX_VALUE) {
            reassignIdentity(tenantId, sessionId, firstRetracted);
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

    /**
     * In-band sibling of {@link #retractContinuationOutput} (#13319): a
     * restarted model attempt on the live Harness retracts the published
     * prefix of the message it replaces. The range is keyed by the journal
     * sequence of the message's first delta, which the Harness reports as
     * {@code fromSourceId}; only deltas of the current in-flight message
     * carry source ids at or after it, so earlier committed rounds stay.
     * The cursor advances past the retraction event in the same transaction
     * whether or not the retraction applied, so a crash cannot re-deliver it.
     */
    @Transactional
    public void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (!eventEpoch.equals(turn.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness event epoch changed");
        }
        String sourcePrefix = session.harnessBootId() + ":" + eventEpoch + ":";
        String reconciliationKey = "reconcile:inband:" + sourcePrefix + turnId
                + ":" + fromSourceId;
        if (!hasSourceEvent(tenantId, sessionId, reconciliationKey)) {
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
            long firstRetracted = Long.MAX_VALUE;
            for (EventRecord event : deltas) {
                if (event.sourceKey() == null
                        || !event.sourceKey().startsWith(sourcePrefix)
                        || sourceIdOf(event.sourceKey()) < fromSourceId) {
                    continue;
                }
                Map<String, Object> data = new LinkedHashMap<>(event.data());
                data.put("text", "");
                jdbc.update("UPDATE managed_agent_event SET data_json = ?"
                                + " WHERE tenant_id = ? AND session_id = ?"
                                + " AND sequence_id = ?",
                        writeJson(data), tenantId, sessionId,
                        event.sequence());
                firstRetracted = Math.min(firstRetracted, event.sequence());
            }
            if (firstRetracted != Long.MAX_VALUE) {
                reassignIdentity(tenantId, sessionId, firstRetracted);
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
            appendEvent(tenantId, sessionId, turnId, "stream.reconciled",
                    Map.of(), false, reconciliationKey, now);
        }
        int updated = updateHarnessCursor(tenantId, sessionId, turnId, owner,
                eventEpoch, retractionSourceId, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    // A Harness source key ends in the journal sequence of its journal event;
    // the boot and epoch prefixes are colon-free by construction but the
    // suffix is what the range compares.
    private static long sourceIdOf(String sourceKey) {
        try {
            return Long.parseLong(
                    sourceKey.substring(sourceKey.lastIndexOf(':') + 1));
        } catch (NumberFormatException error) {
            return -1;
        }
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
        Identity previous = events.isEmpty() ? null
                : findIdentity(tenantId, sessionId, next,
                        events.getFirst().projection().type());
        for (HarnessEvent event : events) {
            ProjectedEvent projection = event.projection();
            previous = EventIdentity.of(projection.type(), turnId, ++next,
                    projection.data(), previous);
            records.add(new EventRecord(tenantId, sessionId, next,
                    publicId("evt"), turnId, projection.type(),
                    projection.data(), projection.terminal(),
                    event.sourceKey(), now, EventIdentity.SCHEMA_VERSION,
                    EventIdentity.PROJECTION_VERSION, previous.itemId(),
                    previous.contentPartId()));
        }
        jdbc.update("UPDATE managed_agent_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, last_sequence = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                eventEpoch, lastSourceId, next, now, tenantId, sessionId);
        if (!records.isEmpty()) {
            jdbc.batchUpdate(INSERT_EVENT, records, records.size(),
                    (statement, event) -> {
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
                        statement.setInt(11, event.schemaVersion());
                        statement.setInt(12, event.projectionVersion());
                        statement.setString(13, event.itemId());
                        statement.setString(14, event.contentPartId());
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

    @Transactional
    public void appendLiveSessionEventIfAbsent(String tenantId,
            String sessionId, String type, Map<String, Object> data,
            String sourceKey) {
        // A locking read sees the latest committed status, where a plain one
        // could still see the snapshot taken before a deletion committed.
        Optional<SessionRecord> session = jdbc.query("SELECT * FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
                        + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513)) AND"
                        + " session_id = ? FOR UPDATE",
                sessionMapper, tenantId, tenantId, sessionId).stream()
                .findFirst();
        if (session.isEmpty() || "DELETING".equals(session.get().status())
                || "DELETED".equals(session.get().status())) {
            return;
        }
        if (!hasSourceEvent(tenantId, sessionId, sourceKey)) {
            appendEvent(tenantId, sessionId, null, type, data, false,
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
            case "item.tool_call.updated", "item.tool_result.updated" -> materializeTool(event);
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
            itemId = StoreModels.inputItemId(event.turnId());
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
            itemId = EventIdentity.assistantItemId(event.turnId());
        }
        // The previous part of the same series is the one with the greatest
        // last_sequence, whatever events sit between the two deltas — an
        // announcement row must not split an assistant message in two
        // (#13300 R3-3, symmetric with the write-side identity lookup).
        List<String> preceding = jdbc.query("SELECT part_id FROM"
                        + " managed_agent_item_part WHERE tenant_id = ?"
                        + " AND session_id = ? AND item_id = ? AND"
                        + " part_type = ? AND last_sequence = ?",
                (result, row) -> result.getString("part_id"),
                event.tenantId(), event.sessionId(), itemId, partType,
                event.sequence() - 1);
        String partId = preceding.isEmpty()
                ? EventIdentity.textPartId(event.turnId(), partType,
                        event.sequence())
                : preceding.get(0);
        upsertItem(event, itemId, "message", "assistant", "in_progress",
                Map.of());
        appendPart(event, itemId, partId, partType, text);
    }

    private void materializeTool(EventRecord event) {
        String itemId = EventIdentity.toolItemId(event.turnId(),
                event.sequence(), event.data());
        String sourceStatus = string(event.data().get("status"));
        String status = switch (sourceStatus == null ? ""
                : sourceStatus.toLowerCase()) {
            case "completed", "success" -> "completed";
            case "failed" -> "failed";
            case "cancelled" -> "cancelled";
            default -> "in_progress";
        };
        Map<String, Object> attributes = existingAttributes(event, itemId);
        if (attributes.get("result") instanceof Map<?, ?> previous) {
            if (!(event.data().get("result") instanceof Map<?, ?> next)
                    || number(next.get("projection_revision")) <= number(previous.get("projection_revision"))) {
                return;
            }
        }
        attributes.putAll(event.data());
        attributes.remove("itemId");
        upsertItem(event, itemId, "tool_call", "assistant", status,
                Map.copyOf(attributes));
    }

    private static long number(Object value) {
        return value instanceof Number numeric ? numeric.longValue() : 0;
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
        return Map.of("turnId", turnId,
                "itemId", StoreModels.inputItemId(turnId), "input", input);
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
                            + " WHERE tenant_id = ?"
                            + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                            + " = CAST(CONCAT(?, '!') AS BINARY(513)) AND session_id = ?"
                            + " FOR UPDATE",
                    sessionMapper, tenantId, tenantId, sessionId);
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

    // A mutation leaves the status unchanged until it completes.
    private static void validateMutationStatus(SessionRecord session,
            SessionMutationKind kind) {
        requireSessionStatus(session.status(),
                kind == SessionMutationKind.RENAME ? "ACTIVE" : "ARCHIVED");
    }

    private static String mutationEvent(SessionMutationKind kind,
            String phase) {
        if ("completed".equals(phase)) {
            return kind == SessionMutationKind.RENAME ? "session.updated"
                    : "session.unarchived";
        }
        return "session."
                + (kind == SessionMutationKind.RENAME ? "update" : "unarchive")
                + "." + phase;
    }

    private static String mutationSource(String operation,
            String idempotencyKey, String phase) {
        return "control:" + operation + ":" + idempotencyKey + ":" + phase;
    }

    // One lifecycle change at a time: a pending rename or unarchive command
    // blocks an operation, and an open operation blocks both commands.
    private void requireNoOpenOperation(String tenantId, String sessionId) {
        if (hasOpenOperation(tenantId, sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "session_operation_active",
                    "The Session already has a lifecycle operation in progress.");
        }
    }

    private void validateOperationStart(SessionRecord session,
            OperationKind kind) {
        String status = session.status();
        switch (kind) {
            case CLOSE -> requireSessionStatus(status, "ACTIVE");
            case ARCHIVE -> requireSessionStatus(status, "CLOSED");
            case DELETE -> {
                if (!List.of("ACTIVE", "CLOSED", "ARCHIVED")
                        .contains(status)) {
                    throw sessionStateConflict(status);
                }
            }
        }
        if ("ACTIVE".equals(status)
                && (hasActiveTurn(session.tenantId(), session.sessionId())
                        || session.workspace() != null && hasDecidableAction(session))) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_active",
                    "The Session has an active Turn.");
        }
    }

    private boolean hasDecidableAction(SessionRecord session) {
        long now = lifecycleDatabaseTime();
        for (String options : jdbc.queryForList("SELECT options_json FROM managed_agent_action"
                + " WHERE tenant_id = ? AND session_id = ? AND state = 'requested'", String.class,
                session.tenantId(), session.sessionId())) {
            try {
                if (now < objectMapper.readTree(options).path("expiresAt").asLong()) {
                    return true;
                }
            } catch (JsonProcessingException error) {
                throw new IllegalStateException("Stored Action options are invalid", error);
            }
        }
        return false;
    }

    // ARCHIVING remains only for an archive admitted before V17, which closes
    // the Harness as archive used to.
    private static String pendingStatus(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "CLOSING";
            case ARCHIVE -> "ARCHIVING";
            case DELETE -> "DELETING";
            case ACTION_RESPONSE, CWD_CHANGE -> throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    private static String requestedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.close.requested";
            case ARCHIVE -> "session.archive.requested";
            case DELETE -> "session.delete.requested";
            case ACTION_RESPONSE, CWD_CHANGE -> throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    private static String completedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.closed";
            case ARCHIVE -> "session.archived";
            case DELETE -> "session.deleted";
            case ACTION_RESPONSE, CWD_CHANGE -> throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    private static String operationSource(String operationId,
            String phase) {
        return "operation:" + operationId + ":" + phase;
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
        Identity identity = EventIdentity.of(type, turnId, next, data,
                findIdentity(tenantId, sessionId, sequence, type));
        EventRecord event = new EventRecord(tenantId, sessionId, next,
                publicId("evt"), turnId, type, data, terminal, sourceKey,
                now, EventIdentity.SCHEMA_VERSION,
                EventIdentity.PROJECTION_VERSION, identity.itemId(),
                identity.contentPartId());
        jdbc.update("UPDATE managed_agent_session SET last_sequence = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                next, now, tenantId, sessionId);
        jdbc.update(INSERT_EVENT, event.tenantId(), event.sessionId(),
                event.sequence(), event.eventId(), event.turnId(),
                event.type(), writeJson(event.data()), event.terminal(),
                event.sourceKey(), event.createdAt(), event.schemaVersion(),
                event.projectionVersion(), event.itemId(),
                event.contentPartId());
        publishAfterCommit(List.of(event));
        return event;
    }

    // Emptied deltas name nothing, and a delta that continued one now starts
    // a Part of its own, so identities from the first emptied event on are
    // derived again as the rebuilt Items will name them.
    private void reassignIdentity(String tenantId, String sessionId,
            long fromSequence) {
        List<EventRecord> events = jdbc.query("SELECT * FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND sequence_id >= ? ORDER BY"
                        + " sequence_id ASC",
                eventMapper, tenantId, sessionId, fromSequence - 1);
        Identity previous = null;
        for (EventRecord event : events) {
            if (event.sequence() < fromSequence) {
                previous = new Identity(event.type(), event.itemId(),
                        event.contentPartId());
                continue;
            }
            Identity identity = EventIdentity.of(event.type(),
                    event.turnId(), event.sequence(), event.data(), previous);
            if (!Objects.equals(identity.itemId(), event.itemId())
                    || !Objects.equals(identity.contentPartId(),
                            event.contentPartId())) {
                jdbc.update("UPDATE managed_agent_event SET item_id = ?,"
                                + " content_part_id = ? WHERE tenant_id = ?"
                                + " AND session_id = ? AND sequence_id = ?",
                        identity.itemId(), identity.contentPartId(), tenantId,
                        sessionId, event.sequence());
            }
            previous = identity;
        }
    }

    // Only a text delta continues the event before it, so other events skip
    // the lookup.
    private Identity findIdentity(String tenantId, String sessionId,
            long sequence, String nextType) {
        if (!EventIdentity.continuesPrevious(nextType)) {
            return null;
        }
        List<Identity> rows = jdbc.query("SELECT event_type, item_id,"
                        + " content_part_id FROM managed_agent_event WHERE"
                        + " tenant_id = ? AND session_id = ? AND sequence_id"
                        + " = ?",
                (result, row) -> new Identity(result.getString("event_type"),
                        result.getString("item_id"),
                        result.getString("content_part_id")),
                tenantId, sessionId, sequence);
        return rows.isEmpty() ? null : rows.getFirst();
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
                    "Persisted Workspace configuration descriptor changed for session "
                            + result.getString("session_id") + " of tenant "
                            + result.getString("tenant_id"));
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

    // The cwd columns arrive with V46; an operation read against an
    // additive-upgrade schema that predates them must treat the columns as
    // absent instead of erroring the whole query.
    private static String additiveString(java.sql.ResultSet result,
            String name) throws java.sql.SQLException {
        return hasColumn(result, name) ? result.getString(name) : null;
    }

    private static Long additiveLong(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        return hasColumn(result, name) ? nullableLong(result, name) : null;
    }

    private static boolean hasColumn(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        var meta = result.getMetaData();
        for (int column = 1; column <= meta.getColumnCount(); column++) {
            if (name.equalsIgnoreCase(meta.getColumnLabel(column))) {
                return true;
            }
        }
        return false;
    }

    private static String publicId(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString()
                .replace("-", "");
    }

    private static String placeholders(int count) {
        return String.join(", ", Collections.nCopies(count, "?"));
    }

    private record SnapshotState(long version, long coveredSequence,
            long updatedAt) {
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
