package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.EventIdentity.Identity;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemPartRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.RenameDelivery;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutation;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnSummary;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

@Repository
public class ManagedAgentStore implements AgentStateStore {
    private static final Logger LOG = LoggerFactory.getLogger(
            ManagedAgentStore.class);
    private static final TypeReference<List<Map<String, Object>>> INPUT_TYPE =
            new TypeReference<>() {
            };
    private static final TypeReference<Map<String, Object>> MAP_TYPE =
            new TypeReference<>() {
            };
    private static final TypeReference<List<ItemRecord>> ITEMS_TYPE =
            new TypeReference<>() {
            };
    private static final TypeReference<List<ItemPartRecord>> PARTS_TYPE = new TypeReference<>() {};
    // Between full rewrites the snapshot may lag the projection by this many
    // events or this long; the batch that ends a Turn rewrites it anyway.
    public static final int SNAPSHOT_REFRESH_EVENTS = 1000;
    private static final long SNAPSHOT_REFRESH_MILLIS = 5000;
    private static final String INSERT_EVENT = "INSERT INTO ma_public_event"
            + " (tenant_id, session_id, sequence_id, event_id, turn_id,"
            + " event_type, data_json, terminal, source_key, gmt_create,"
            + " schema_version, projection_version, item_id, content_part_id)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    private static final List<String> ACTIVE_TURN_STATES = List.of(
            "ACCEPTED", "RUNNING", "CANCELLING");
    private static final String TURN_SUMMARY_COLUMNS = "session_id,"
            + " turn_id, status, gmt_create, completed_at, error_code";
    // findLatestTurns joins ma_public_event, so the same projection
    // must be table-qualified there.
    private static final String QUALIFIED_TURN_SUMMARY_COLUMNS =
            "turn_record." + String.join(", turn_record.",
                    TURN_SUMMARY_COLUMNS.split(", "));
    private final JdbcTemplate jdbc;
    private WorkspaceLifecycleStore lifecycle;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setWorkspaceLifecycleStore(WorkspaceLifecycleStore lifecycle) {
        this.lifecycle = lifecycle;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setManagedAgentDefinitionStore(
            ManagedAgentDefinitionStore definitions) {
        this.definitions = definitions;
    }

    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final ManagedSnapshotStore snapshots;
    private final String approvalMode;
    private final CommittedEventPublisher eventPublisher;
    private final ManagedWorkspaceRegistry workspaces;
    private final String agentRevision;
    private final List<String> definitionToolProfiles;
    private final List<String> definitionModels;
    private final List<WebShellModelOption> modelCatalog;
    private ManagedAgentDefinitionStore definitions;
    private static final Pattern DEFINITION_REVISION = Pattern.compile(
            "^[1-9][0-9]{0,17}$");
    private final boolean workspaceFilesEnabled;
    private final boolean workspaceShellEnabled;
    private final List<ManagedAgentProperties.RuntimeBroker.WorkspaceMount> workspaceMounts;
    private final ResidentWorkspaces residentWorkspaces;
    private final WorkspaceCreationRoots createdRoots;
    private static final String SESSION_WITH_STREAM =
            "SELECT " + ManagedSchemaProjection.SESSION.columns("ma_session") + ", es.last_sequence AS list_last_sequence, es.replay_floor_sequence AS list_floor_sequence FROM ma_session LEFT JOIN ma_event_stream es ON es.tenant_id = ma_session.tenant_id AND es.session_id = ma_session.session_id AND es.stream_kind = 'SESSION' AND es.stream_id = X''";
    private final RowMapper<SessionRecord> sessionMapper = (result, row) -> {
        if (result.getObject("list_last_sequence") == null || result.getObject("list_floor_sequence") == null) {
            throw new IllegalStateException("Session stream is unavailable.");
        }
        return readSession(result, new StreamCounters(result.getLong("list_last_sequence"),
                result.getLong("list_floor_sequence")));
    };
    private final RowMapper<SessionRecord> sessionListMapper =
            (result, row) ->
                    readSession(
                            result,
                            new StreamCounters(
                                    result.getLong("list_last_sequence"),
                                    result.getLong("list_floor_sequence")));

    private SessionRecord readSession(java.sql.ResultSet result, StreamCounters counters) throws java.sql.SQLException {
        return new SessionRecord(
                result.getString("tenant_id"),
                result.getString("session_id"),
                result.getString("agent_id"),
                result.getString("agent_revision"),
                result.getString("title"),
                result.getString("status"),
                result.getString("harness_boot_id"),
                result.getString("harness_event_epoch"),
                result.getLong("harness_last_event_id"),
                counters.lastSequence(),
                counters.floorSequence(),
                result.getLong("gmt_create"),
                result.getLong("gmt_modified"),
                nullableLong(result, "deleted_at"),
                result.getLong("version"),
                readBinding(result),
                result.getString("approval_mode"),
                result.getString("tool_profile"),
                result.getString("agent_definition_digest"));
    }

    private final RowMapper<TurnSummary> turnSummaryMapper =
            (result, row) ->
                    new TurnSummary(
                            result.getString("session_id"),
                            result.getString("turn_id"),
                            result.getString("status"),
                            result.getLong("gmt_create"),
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
                    additiveInt(result, "consecutive_failures"),
                    additiveInt(result, "budget_exempt_failures"),
                    nullableLong(result, "retry_after"),
                    result.getString("error_code"),
                    result.getString("error_message"),
                    result.getLong("gmt_create"),
                    result.getLong("gmt_modified"),
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
                    result.getLong("gmt_create"),
                    result.getInt("schema_version"),
                    result.getInt("projection_version"),
                    result.getString("item_id"),
                    result.getString("content_part_id"));
    private final RowMapper<ItemRow> itemMapper =
            (result, row) ->
                    new ItemRow(
                            result.getString("tenant_id"),
                            result.getString("session_id"),
                            result.getString("item_id"),
                            result.getString("turn_id"),
                            result.getString("item_type"),
                            result.getString("item_role"),
                            result.getString("item_status"),
                            readMap(result.getString("attributes_json")),
                            result.getLong("first_sequence"),
                            result.getLong("last_sequence"),
                            result.getLong("gmt_create"),
                            result.getLong("gmt_modified"),
                            result.getLong("revision"),
                            readParts(
                                    result.getString("parts_json"),
                                    result.getString("body_resource_key"),
                                    result.getString("tenant_id"),
                                    result.getString("session_id")));
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
                    result.getString("claim_owner"),
                    result.getLong("claim_generation"),
                    result.getInt("attempt_count"),
                    additiveString(result, "target_cwd_relative"),
                    additiveLong(result, "expected_context_revision"),
                    additiveLong(result, "result_context_revision"),
                    result.getString("failure_code"),
                    additiveInt(result, "budget_exempt_attempt"),
                    hasColumn(result, "lifecycle_protocol_version")
                            ? result.getInt("lifecycle_protocol_version") : 0,
                    // NULL on a pre-V56 operation: those operations settle
                    // against the creator-keyed facts alone.
                    hasColumn(result, "actor_key")
                            ? result.getBytes("actor_key") : null,
                    additiveString(result, "task_id"));
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
        this.snapshots = new ManagedSnapshotStore(jdbc, objectMapper, clock, this::snapshotItems);
        this.approvalMode =
                properties.getHarness().getApprovalMode().toLowerCase(Locale.ROOT);
        this.eventPublisher = eventPublisher;
        this.workspaces = workspaces;
        this.agentRevision = properties.getAgentRevision();
        this.definitionToolProfiles = properties.getDefinitionToolProfiles();
        this.definitionModels = properties.getDefinitionModels();
        var modelIds = new HashSet<String>();
        this.modelCatalog = properties.getModelCatalog().stream().map(option -> {
            String id = option.getModelId();
            String label = option.getLabel() == null ? id : option.getLabel();
            if (StringUtils.isBlank(id) || id.getBytes(StandardCharsets.UTF_8).length > 512
                    || id.chars().anyMatch(Character::isISOControl) || !modelIds.add(id)
                    || StringUtils.isBlank(label) || label.length() > 512
                    || label.chars().anyMatch(Character::isISOControl)) {
                throw new IllegalArgumentException("Invalid or duplicate Managed model catalog entry");
            }
            return new WebShellModelOption(id, label);
        }).toList();
        this.workspaceFilesEnabled = properties.getHarness().isWorkspaceFilesEnabled();
        this.workspaceShellEnabled = properties.getHarness().isWorkspaceShellEnabled();
        this.workspaceMounts = properties.getRuntimeBroker().getWorkspaceMounts();
        this.residentWorkspaces = new ResidentWorkspaces(properties.getRuntimeBroker().getResidentWorkspaces());
        this.createdRoots = new WorkspaceCreationRoots(jdbc, properties);
        if (StringUtils.isBlank(agentRevision)
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
        AgentPin pin = resolveAgentPin(tenantId, agentId, requestedRevision,
                false);
        requireCreationScope(tenantId, idempotencyKey, false);
        return insertSession(tenantId, operation, idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                null, actorId, pin);
    }

    @Override
    @Transactional
    public Admission insertWorkspaceSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection) {
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input,
                payloadDigest, selection, null);
    }

    @Override
    @Transactional
    public Admission insertWorkspaceSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection, String requestedApprovalMode) {
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest,
                selection, requestedApprovalMode, false);
    }

    @Override
    @Transactional
    public Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title, List<Map<String, Object>> input,
            String payloadDigest, WorkspaceSelection selection, String requestedApprovalMode,
            boolean approvalSelectionSupported) {
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest,
                agentId, requestedRevision, title, input, payloadDigest, selection,
                requestedApprovalMode, approvalSelectionSupported, null, false);
    }

    @Override
    @Transactional
    public Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title, List<Map<String, Object>> input,
            String payloadDigest, WorkspaceSelection selection, String requestedApprovalMode,
            boolean approvalSelectionSupported, Boolean requestedPlanMode, boolean planModeSupported) {
        if (!input.isEmpty() && !workspaceFilesEnabled) {
            throw workspaceExecutionUnavailable();
        }
        // InnoDB's first consistent read must follow the migration admission lock.
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (!existing.isEmpty()) {
            return replayWorkspaceCommand(tenantId, actorId,
                    requestDigest, existing.getFirst(), false);
        }
        AgentPin pin = selectApprovalMode(resolveAgentPin(tenantId, agentId,
                requestedRevision, true), requestedApprovalMode, approvalSelectionSupported);
        boolean planMode = Boolean.TRUE.equals(requestedPlanMode);
        if (planMode && (!planModeSupported || !approvalSelectionSupported
                || pin.hooks() || !(WorkspaceToolProfiles.FILES.equals(pin.toolProfile())
                || WorkspaceToolProfiles.isPublicShell(pin.toolProfile())))) {
            throw new ApiException(HttpStatus.CONFLICT, "unsupported_feature", "Plan mode is unavailable");
        }
        if (!input.isEmpty() && WorkspaceToolProfiles.isPublicShell(pin.toolProfile())
                && !workspaceShellEnabled) {
            throw workspaceExecutionUnavailable();
        }
        requireCreationScope(tenantId, idempotencyKey, true);
        ResolvedBinding workspace = workspaces.resolveForCreation(
                tenantId, actorId, selection);
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, workspace.binding().getStorageId());
        boolean sshWorkspace = isSshWorkspace(workspace.binding());
        if (sshWorkspace) {
            requireSshToolProfile(pin.toolProfile());
        }
        boolean resident = residentWorkspaces.find(workspace.binding()) != null;
        if (resident) {
            if (!workspaceFilesEnabled) {
                throw workspaceExecutionUnavailable();
            }
            residentWorkspaces.requireCreation(jdbc, workspace.binding(), pin.toolProfile());
        } else if (!sshWorkspace) {
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, workspace.binding().getStorageId());
        }
        if (!resident && !input.isEmpty()
                && (!WorkspaceExecutionProfile.CONFIG_REF.equals(workspace.configRef())
                        || !WorkspaceExecutionProfile.POLICY_REF.equals(workspace.policyRef())
                        || !sshWorkspace && !configuredStorage(tenantId, workspace.binding().getStorageId()))) {
            throw workspaceExecutionUnavailable();
        }
        return insertSession(tenantId, "CREATE_SESSION", idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                workspace, actorId, pin, null, planMode);
    }

    private boolean configuredStorage(String tenant, String storage) {
        return workspaceMounts.stream().anyMatch(mount -> tenant.equals(mount.tenantId())
                && storage.equals(mount.storageId())) || createdRoots.resolve(tenant, storage, false) != null;
    }

    /** Trusted internal creation; public requests and definitions cannot select this policy. */
    @Transactional
    public Admission insertInternalTeamLeadSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest,
            String title, WorkspaceSelection selection) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (!existing.isEmpty()) {
            return replayWorkspaceCommand(tenantId, actorId,
                    requestDigest, existing.getFirst(), true);
        }
        if (!workspaceFilesEnabled) {
            throw workspaceExecutionUnavailable();
        }
        requireCreationScope(tenantId, idempotencyKey, true);
        ResolvedBinding workspace = workspaces.resolveForCreation(tenantId, actorId, selection);
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, workspace.binding().getStorageId());
        if (!WorkspaceExecutionProfile.CONFIG_REF.equals(workspace.configRef())
                || !WorkspaceExecutionProfile.POLICY_REF.equals(workspace.policyRef())
                || !configuredStorage(tenantId, workspace.binding().getStorageId())) {
            throw workspaceExecutionUnavailable();
        }
        return insertSession(tenantId, "CREATE_SESSION", idempotencyKey, requestDigest,
                "qwen-code", title, List.of(), null, workspace, actorId,
                new AgentPin(agentRevision, null, approvalMode, WorkspaceToolProfiles.INTERNAL_TEAM_LEAD, false));
    }

    @Override
    public Optional<Admission> findWorkspaceCreateReplay(String tenantId,
            String actorId, String idempotencyKey, String requestDigest) {
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (existing.isEmpty()) {
            return Optional.empty();
        }
        // The pre-gate probe re-runs the sibling's re-checks — a replay must
        // not outlive the Workspace binding or the caller's read grant.
        return Optional.of(replayWorkspaceCommand(tenantId, actorId,
                requestDigest, existing.getFirst(), false));
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
                existing.getFirst(), false);
    }

    Admission insertCsiSessionCommand(
            WorkspaceCsiRegistration registration,
            String actorId,
            String idempotencyKey,
            String requestDigest,
            String requestedRevision,
            String title,
            WorkspaceSelection selection) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Private CSI CREATE requires a transaction");
        }
        String tenantId = registration.tenantId();
        requireCreationScope(tenantId, idempotencyKey, true);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId, actorId, idempotencyKey);
        if (!existing.isEmpty()) {
            Admission replay =
                    replayWorkspaceCommand(
                            tenantId, actorId, requestDigest, existing.getFirst(), false);
            requireCsiRequest(registration, replay.sessionId());
            return replay;
        }
        AgentPin pin = resolveAgentPin(tenantId, "qwen-code", requestedRevision, true);
        ResolvedBinding workspace = workspaces.resolveForCreation(tenantId, actorId, selection);
        if (!registration.storageId().equals(workspace.binding().getStorageId())
                || !CsiFilesRetirementProfile.CONFIG_REF.equals(workspace.configRef())
                || !CsiFilesRetirementProfile.POLICY_REF.equals(workspace.policyRef())) {
            throw workspaceExecutionUnavailable();
        }
        return insertSession(
                tenantId,
                "CREATE_SESSION",
                idempotencyKey,
                requestDigest,
                "qwen-code",
                title,
                List.of(),
                null,
                workspace,
                actorId,
                pin,
                registration);
    }

    RuntimeProvisionRequest requireCsiRequest(
            WorkspaceCsiRegistration registration, String sessionId) {
        SessionRecord session = requireSessionForUpdate(registration.tenantId(), sessionId);
        if (!CsiFilesRetirementProfile.PROFILE.equals(session.toolProfile())
                || session.workspace() == null
                || !"qwen-code".equals(session.agentId())
                || !CsiFilesRetirementProfile.CONTEXT_CONFIG_REF.equals(
                        session.workspace().getContextConfigRef())
                || !registration.storageId().equals(session.workspace().getStorageId())) {
            throw workspaceExecutionUnavailable();
        }
        RuntimeProvisionRequest request =
                CsiFilesRetirementProfile.request(
                        session.workspace(), registration.mountRoot(), session.sessionId());
        String saved =
                jdbc.queryForObject(
                        "SELECT runtime_request_key FROM ma_session"
                                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                        String.class,
                        session.tenantId(),
                        session.sessionId());
        if (!request.requestKey().equals(saved)) {
            throw workspaceExecutionUnavailable();
        }
        return request;
    }

    private static String childActorOf(String parentSessionId) {
        return "child:" + parentSessionId;
    }

    @Override
    @Transactional
    public Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        return insertChildSession(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage, null);
    }

    @Override
    @Transactional
    public Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        if (childCwdRelative == null) {
            throw new IllegalArgumentException("An isolated child needs its Workspace directory");
        }
        return insertChildSession(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage,
                childCwdRelative);
    }

    @Override
    public String findChildWorkspaceCwd(String tenantId,
            String parentSessionId, String childRunId) {
        List<String> rows = jdbc.queryForList(
                        "SELECT child_cwd_relative FROM ma_workspace WHERE workspace_kind ="
                                + " 'CHILD_GIT' AND tenant_id = ? AND parent_session_id = ? AND"
                                + " child_run_id = ?",
                String.class, tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private Admission insertChildSession(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                childActorOf(parentSessionId), idempotencyKey);
        if (existing.isEmpty()) {
            WorkspaceMigrationAdmission.requireSessionOpen(jdbc, tenantId, parentSessionId);
        }
        SessionRecord parent = requireSessionForUpdate(tenantId,
                parentSessionId);
        if (parent.workspace() == null || residentWorkspaces.find(parent.workspace()) != null || !"ACTIVE".equals(parent.status())
                || CsiFilesRetirementProfile.PROFILE.equals(parent.toolProfile())) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        requireLegacyMutation(tenantId, parentSessionId);
        if (!input.isEmpty() && !workspaceFilesEnabled) {
            throw workspaceExecutionUnavailable();
        }
        if (!existing.isEmpty()) {
            WorkspaceCommand command = existing.getFirst();
            if (!command.requestDigest().equals(requestDigest)) {
                throw new ApiException(HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new Admission(command.sessionId(), command.turnId(), true,
                    false);
        }
        // The terminal truth fence: the relay can give up on a stalled
        // creation and commit the run's terminal verdict (creation_failed
        // among them), then retire — while a lease-losing worker that
        // paused before this call is about to mint the Session anyway.
        // The row lock serializes that verdict against this read, so a
        // settled record refuses the mint inside its own transaction —
        // addressed by the parent's launch row's own primary key, which
        // is the same key the idempotent admission derives, so the
        // locking read never becomes a cross-tenant table scan under
        // REPEATABLE READ.
        String fenceScopeKey = ManagedSessionStore.sessionScopeKey(tenantId,
                parentSessionId);
        String fenceRecordKey = ManagedExtensionProjection.recordKey(
                parentSessionId, "child_run", lineage.parentChildRunId());
        List<String> runState = jdbc.query("SELECT task_state FROM"
                + " ma_session_record"
                + " WHERE session_scope_key = ? AND record_key = ?"
                + " FOR UPDATE",
                (result, row) -> result.getString(1), fenceScopeKey,
                fenceRecordKey);
        if (!runState.isEmpty()
                && ("completed".equals(runState.getFirst())
                        || "failed".equals(runState.getFirst())
                        || "cancelled".equals(runState.getFirst()))) {
            throw new ApiException(HttpStatus.CONFLICT, "child_run_settled",
                    "The child run already settled; creation owes no more Session.");
        }
        // A child bound to a snapshot reads with the read-only profile
        // whatever its parent's is (#13753 I3): the mode comes from the row
        // this transaction locks, so no caller can bind a snapshot copy to
        // a profile that writes. Only the profile differs from the parent.
        String toolProfile = null;
        if (childCwdRelative != null
                && ChildWorkspaceStore.SNAPSHOT.equals(requireReadyChildWorkspace(
                        tenantId, parentSessionId, lineage.parentChildRunId(),
                        parent.workspace(), childCwdRelative))) {
            toolProfile = WorkspaceToolProfiles.READ;
        }
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
        String turnId = input.isEmpty() ? null : publicId("turn");
        String promptId = input.isEmpty() ? null : UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, agent_revision,"
                        + " agent_definition_digest, title,"
                        + " status, gmt_create, gmt_modified, workspace_id,"
                        + " workspace_generation, workspace_storage_id,"
                        + " cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref,"
                        + " workspace_policy_ref, tool_profile,"
                        + " creator_actor_key, approval_mode,"
                        + " parent_session_id, root_session_id,"
                        + " parent_child_run_id, child_depth)"
                        + " SELECT tenant_id, ?, agent_id,"
                        + " agent_revision, agent_definition_digest,"
                        + " ?, 'ACTIVE', ?, ?,"
                        + " workspace_id, workspace_generation,"
                        + " workspace_storage_id, "
                        + (childCwdRelative == null ? "cwd_relative" : "?")
                        + ", context_config_ref, context_revision,"
                        + " workspace_config_ref, workspace_policy_ref, "
                        + (toolProfile == null ? "tool_profile" : "?")
                        + ", creator_actor_key, approval_mode,"
                        + " ?, ?, ?, ?"
                        + " FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                childInsertArgs(sessionId, title, now, childCwdRelative,
                        toolProfile, lineage, tenantId, parentSessionId));
        jdbc.update("INSERT INTO ma_event_stream"
                        + " (tenant_id, session_id, stream_kind, stream_id,"
                        + " covered_sequence, gmt_modified) VALUES"
                        + " (?, ?, 'SESSION', '', 0, ?)",
                tenantId, sessionId, now);
        if (turnId != null) {
            insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
        }
        ManagedReceipts.insertCreation(jdbc, tenantId,
                ManagedWorkspaceRegistry.actorKey(tenantId, childActorOf(parentSessionId)),
                idempotencyKey, requestDigest, sessionId, turnId, now);
        appendEvent(tenantId, sessionId, null, "session.created",
                Map.of("sessionId", sessionId), false, null, now);
        if (turnId != null) {
            appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                    acceptedData(turnId, input), false, null, now);
        }
        return new Admission(sessionId, turnId, false, true);
    }

    private static Object[] childInsertArgs(String sessionId, String title,
            long now, String childCwdRelative, String toolProfile,
            StoreModels.SessionLineage lineage, String tenantId,
            String parentSessionId) {
        List<Object> args = new ArrayList<>(List.of(sessionId, title, now, now));
        if (childCwdRelative != null) {
            args.add(childCwdRelative);
        }
        if (toolProfile != null) {
            args.add(toolProfile);
        }
        args.addAll(List.of(lineage.parentSessionId(), lineage.rootSessionId(),
                lineage.parentChildRunId(), lineage.depth(), tenantId,
                parentSessionId));
        return args.toArray();
    }

    /**
     * Decision 13 of the isolation slice: an isolated child binds only to a ready, unfinished child
     * Workspace prepared from the parent's current Workspace and storage. The locking read
     * serializes the creation against a finish request, which locks the same row. Answers
     * the row's mode (#13753 I3), which its operation's request fixed when it was admitted.
     */
    private String requireReadyChildWorkspace(String tenantId,
            String parentSessionId, String childRunId, ContextBinding parent,
            String childCwdRelative) {
        List<Boolean> ready =
                jdbc.query(
                        "SELECT child_state AS state, finish_request, parent_workspace_id AS"
                            + " workspace_id, workspace_generation, storage_id, child_cwd_relative"
                            + " FROM ma_workspace WHERE workspace_kind = 'CHILD_GIT' AND"
                            + " parent_session_id = ? AND child_run_id = ? AND tenant_id = ? FOR"
                            + " UPDATE",
                        (row, index) ->
                                "ready".equals(row.getString("state"))
                                        && row.getString("finish_request") == null
                                        && parent.getWorkspaceId()
                                                .equals(row.getString("workspace_id"))
                                        && parent.getWorkspaceGeneration()
                                                == row.getLong("workspace_generation")
                                        && parent.getStorageId().equals(row.getString("storage_id"))
                                        && childCwdRelative.equals(
                                                row.getString("child_cwd_relative")),
                        parentSessionId,
                        childRunId,
                        tenantId);
        if (ready.size() != 1 || !ready.getFirst()) {
            throw new ApiException(HttpStatus.CONFLICT, "child_workspace_not_ready",
                    "The child run's Workspace is not ready to bind a child Session.");
        }
        // The request is written once, when the row is admitted, so the
        // locked row's mode needs no lock of its own.
        List<String> requests = jdbc.queryForList("SELECT o.request_json FROM ma_workspace w"
                        + " JOIN ma_operation o ON o.tenant_id = w.tenant_id"
                        + " AND o.operation_id = w.child_workspace_id AND o.operation_kind = 'CHILD_WORKSPACE'"
                        + " WHERE w.workspace_kind = 'CHILD_GIT' AND w.parent_session_id = ?"
                        + " AND w.child_run_id = ? AND w.tenant_id = ?",
                String.class, parentSessionId, childRunId, tenantId);
        if (requests.size() != 1) {
            throw new ApiException(HttpStatus.CONFLICT, "child_workspace_not_ready",
                    "The child run's Workspace is not ready to bind a child Session.");
        }
        return ChildWorkspaceStore.workspaceMode(requests.getFirst());
    }

    @Override
    @Transactional
    public Admission replayChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest) {
        SessionRecord parent = requireSessionForUpdate(tenantId, parentSessionId);
        if (CsiFilesRetirementProfile.PROFILE.equals(parent.toolProfile())) {
            throw new ApiException(
                    HttpStatus.CONFLICT,
                    "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        requireLegacyMutation(tenantId, parentSessionId);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                childActorOf(parentSessionId), idempotencyKey);
        if (existing.isEmpty()) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict", "The creation command is missing.");
        }
        WorkspaceCommand command = existing.getFirst();
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        return new Admission(command.sessionId(), command.turnId(), true,
                false);
    }

    @Override
    public StoreModels.SessionLineage findChildLineage(String tenantId,
            String sessionId) {
        // The mapper yields null for a root row, and Stream.findFirst()
        // throws on a null element — fetch and read the one row directly.
        List<StoreModels.SessionLineage> rows = jdbc.query(
                "SELECT parent_session_id, root_session_id,"
                        + " parent_child_run_id, child_depth"
                        + " FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> {
                    String parent = result.getString("parent_session_id");
                    if (parent == null) {
                        return null;
                    }
                    return new StoreModels.SessionLineage(parent,
                            result.getString("root_session_id"),
                            result.getString("parent_child_run_id"),
                            result.getInt("child_depth"));
                }, tenantId, sessionId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private Admission replayWorkspaceCommand(String tenantId, String actorId,
            String requestDigest, WorkspaceCommand command, boolean internalTeamLead) {
        SessionRecord session = requireSession(tenantId, command.sessionId());
        if (!command.requestDigest().equals(requestDigest)
                || internalTeamLead != WorkspaceToolProfiles.INTERNAL_TEAM_LEAD.equals(session.toolProfile())
                || internalTeamLead && (!"qwen-code".equals(session.agentId())
                        || session.agentDefinitionDigest() != null)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        ContextBinding bound = session.workspace();
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
        ManagedReceipts.Receipt row = ManagedReceipts.creation(jdbc, tenantId,
                ManagedWorkspaceRegistry.actorKey(tenantId, actorId), idempotencyKey);
        return row == null
                ? List.of()
                : List.of(
                        new WorkspaceCommand(
                                row.requestDigest(), row.sessionId(), row.turnId()));
    }

    private record WorkspaceCommand(String requestDigest, String sessionId,
            String turnId) {
    }

    // A bound Session may be renamed under the Workspace-files opt-in
    // (the service checks the caller's Workspace role and the Session's
    // creator-keyed execution facts); unarchive stays gated.
    private boolean boundRenameAllowed(SessionMutationKind kind) {
        return kind == SessionMutationKind.RENAME && workspaceFilesEnabled;
    }

    private static ApiException workspaceExecutionUnavailable() {
        return new ApiException(HttpStatus.CONFLICT,
                "workspace_unavailable",
                "Hosted Workspace execution is not available.");
    }

    private void requireCreationScope(String tenantId, String idempotencyKey, boolean workspaceBound) {
        var namespace = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_MODE;
        var scope = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.TENANT;
        try {
            ManagedReceipts.insert(jdbc, namespace, tenantId, scope, tenantId, idempotencyKey,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(Boolean.toString(workspaceBound)),
                    null, null, null, null, "RESERVED", null, workspaceBound, clock.millis());
        } catch (DuplicateKeyException existing) {
            // The independently persisted creation-mode claim cannot be overwritten by replay.
        }
        ManagedReceipts.Receipt existing = ManagedReceipts.find(jdbc, namespace, tenantId, scope,
                tenantId, idempotencyKey, true);
        if (existing == null
                || !Boolean.valueOf(workspaceBound).equals(existing.workspaceBound())) {
            throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
    }

    /**
     * The execution identity a new Session pins (D8b): for the built-in {@code qwen-code} agent the
     * deployment revision with no definition digest; for a stored definition the resolved revision,
     * its digest and the approval mode and tool profile compiled from its content (D8c-1).
     */
    private record AgentPin(String revision, String digest,
            String approvalMode, String toolProfile, boolean hooks) {
    }

    private boolean isSshWorkspace(ContextBinding binding) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE alias_key = ? AND storage_kind = 'SSH_LOCAL'",
                Long.class, JdbcRuntimeBindingRepository.storageAliasKey(binding.getTenantId(), binding.getStorageId())) == 1;
    }

    private static void requireSshToolProfile(String profile) {
        if (!WorkspaceToolProfiles.FILES.equals(profile) && !WorkspaceToolProfiles.SHELL.equals(profile)) {
            throw workspaceExecutionUnavailable();
        }
    }

    @Override
    @Transactional
    public WebShellSessionOptions workspaceSessionOptions(
            String tenantId, String agentId) {
        AgentPin pin = resolveAgentPin(tenantId, agentId, null, true);
        return new WebShellSessionOptions(
                pin.approvalMode(), availableApprovalModes(pin),
                !pin.hooks() && (WorkspaceToolProfiles.FILES.equals(pin.toolProfile())
                        || WorkspaceToolProfiles.isPublicShell(pin.toolProfile())), false);
    }

    private static List<String> availableApprovalModes(AgentPin pin) {
        return pin.digest() != null ? List.of(pin.approvalMode())
                : WorkspaceToolProfiles.isPublicShell(pin.toolProfile())
                        ? List.of("default", "auto-edit")
                        : List.of("default", "auto-edit", "yolo");
    }

    @Override
    public boolean supportsPlanMode(SessionRecord session) {
        return WorkspaceToolProfiles.supportsApprovalSelection(session)
                && findChildLineage(session.tenantId(), session.sessionId()) == null
                && (session.agentDefinitionDigest() == null
                || !definitions.pinnedContent(session).containsKey("hook_catalog"));
    }

    private static AgentPin selectApprovalMode(AgentPin pin, String requested, boolean supported) {
        if (requested == null) {
            return pin;
        }
        if (!availableApprovalModes(pin).contains(requested)
                && !(supported && pin.digest() == null && "yolo".equals(requested)
                        && WorkspaceToolProfiles.isPublicShell(pin.toolProfile()))) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "unsupported_approval_mode",
                    "The selected approval mode is not available for this Agent.");
        }
        return new AgentPin(pin.revision(), pin.digest(), requested, pin.toolProfile(), pin.hooks());
    }

    // Called only for a new admission; a retry has already replayed and
    // never resolves a definition again.
    private AgentPin resolveAgentPin(String tenantId, String agentId,
            String requested, boolean workspaceBound) {
        if ("qwen-code".equals(agentId)) {
            if (requested != null && !requested.equals(agentRevision)) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "unsupported_feature",
                        "Only the current agent revision can be selected.");
            }
            String toolProfile = workspaceBound
                    ? (workspaceShellEnabled ? WorkspaceToolProfiles.SHELL
                            : WorkspaceToolProfiles.FILES)
                    : null;
            return new AgentPin(agentRevision, null, approvalMode, toolProfile, false);
        }
        if (definitions == null) {
            throw ManagedAgentDefinitionStore.notFound();
        }
        ManagedAgentDefinitionStore.DefinitionRevision revision =
                resolveDefinitionRevision(tenantId, agentId, requested);
        AgentDefinitionCompiler.Compiled compiled =
                AgentDefinitionCompiler.compile(revision.definitionJson(),
                        workspaceBound, approvalMode, definitionToolProfiles,
                        definitionModels);
        return new AgentPin(Long.toString(revision.revision()),
                revision.digest(), compiled.approvalMode(),
                compiled.toolProfile(), readMap(revision.definitionJson()).containsKey("hook_catalog"));
    }

    private ManagedAgentDefinitionStore.DefinitionRevision resolveDefinitionRevision(
            String tenantId, String agentId, String requested) {
        if (requested == null) {
            return definitions.latestForUpdate(tenantId, agentId)
                    .orElseThrow(ManagedAgentDefinitionStore::notFound);
        }
        if (!DEFINITION_REVISION.matcher(requested).matches()) {
            throw ManagedAgentDefinitionStore.notFound();
        }
        return definitions
                .find(tenantId, agentId, Long.parseLong(requested))
                .orElseThrow(ManagedAgentDefinitionStore::notFound);
    }

    private Admission insertSession(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved,
            String actorId, AgentPin pin) {
        return insertSession(
                tenantId,
                operation,
                idempotencyKey,
                requestDigest,
                agentId,
                title,
                input,
                payloadDigest,
                resolved,
                actorId,
                pin,
                null);
    }

    private Admission insertSession(
            String tenantId,
            String operation,
            String idempotencyKey,
            String requestDigest,
            String agentId,
            String title,
            List<Map<String, Object>> input,
            String payloadDigest,
            ResolvedBinding resolved,
            String actorId,
            AgentPin pin,
            WorkspaceCsiRegistration registration) {
        return insertSession(tenantId, operation, idempotencyKey, requestDigest, agentId, title,
                input, payloadDigest, resolved, actorId, pin, registration, false);
    }

    private Admission insertSession(String tenantId, String operation, String idempotencyKey,
            String requestDigest, String agentId, String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved, String actorId, AgentPin pin,
            WorkspaceCsiRegistration registration, boolean planMode) {
        ContextBinding workspace = resolved == null ? null
                : resolved.binding();
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
        String runtimeRequestKey =
                registration == null
                        ? null
                        : CsiFilesRetirementProfile.request(
                                        workspace, registration.mountRoot(), sessionId)
                                .requestKey();
        String turnId = input.isEmpty() ? null : publicId("turn");
        String promptId = input.isEmpty() ? null
                : UUID.randomUUID().toString();
        byte[] actorKey = actorId == null ? null
                : ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, agent_revision,"
                        + " agent_definition_digest, title,"
                        + " status, gmt_create, gmt_modified, workspace_id,"
                        + " workspace_generation, workspace_storage_id,"
                        + " cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref,"
                        + " workspace_policy_ref, tool_profile,"
                        + " creator_actor_key, owner_actor_key, runtime_request_key, approval_mode,"
                        + " plan_enabled, selected_approval_mode, approval_revision) VALUES"
                        + " (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tenantId, sessionId, agentId, pin.revision(), pin.digest(),
                title, now, now,
                workspace == null ? null : workspace.getWorkspaceId(),
                workspace == null ? null : workspace.getWorkspaceGeneration(),
                workspace == null ? null : workspace.getStorageId(),
                workspace == null ? null : workspace.getCwdRelative(),
                workspace == null ? null : workspace.getContextConfigRef(),
                workspace == null ? null : workspace.getContextRevision(),
                resolved == null ? null : resolved.configRef(),
                resolved == null ? null : resolved.policyRef(),
                registration != null
                        ? CsiFilesRetirementProfile.PROFILE
                        : workspace == null ? null : pin.toolProfile(),
                actorKey, actorKey,
                runtimeRequestKey, workspace != null || pin.digest() != null ? pin.approvalMode() : "yolo",
                planMode, planMode ? pin.approvalMode() : null, planMode ? 1 : 0);
        jdbc.update("INSERT INTO ma_event_stream"
                        + " (tenant_id, session_id, stream_kind, stream_id,"
                        + " covered_sequence, gmt_modified) VALUES"
                        + " (?, ?, 'SESSION', '', 0, ?)",
                tenantId, sessionId, now);
        if (turnId != null) {
            insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
        }
        if (resolved == null) {
            insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                    sessionId, turnId, now);
        } else {
            ManagedReceipts.insertCreation(jdbc, tenantId, actorKey,
                    idempotencyKey, requestDigest, sessionId, turnId, now);
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
        return insertTurnCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, input, payloadDigest, null);
    }

    // The actor-carrying variant records the caller on the command
    // receipt, so the receipt's replay answers the actor who recorded it —
    // an OPERATOR's own retry of his own key — and not only the creator.
    @Transactional
    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            String actorId) {
        // A per-turn admission: a long holder of the tenant's placement row
        // answers tenant_guard_contended within the hot-path bound instead
        // of parking the submit past the caller's budget (#13800).
        ManagedSessionStore.lockBounded(() -> WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId,
                ManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        // A bound Session's later Turn needs the same deployment opt-in as
        // its initial one; the service admits any caller holding OPERATOR
        // on the bound Workspace while the Session's creator-keyed
        // execution facts hold.
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
        if (WorkspaceToolProfiles.isPublicShell(session.toolProfile()) && !workspaceShellEnabled) {
            throw workspaceExecutionUnavailable();
        }
        if (session.workspace() != null) {
            if (isSshWorkspace(session.workspace())) {
                requireSshToolProfile(session.toolProfile());
            }
            WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
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
        byte[] actorKey = commandActorKey(tenantId, actorId);
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, "COMPLETED", null, actorKey, now);
        String operationId = insertTurnCommandOperation(tenantId, sessionId,
                turnId, OperationKind.SUBMIT_INPUT, operation, idempotencyKey,
                requestDigest, actorKey, session.status(), now);
        appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                acceptedData(turnId, input), false, null, now);
        return new Admission(sessionId, turnId, false, true, operationId);
    }

    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId) {
        return insertCancelCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, turnId, null);
    }

    // The actor-carrying twin of insertTurnCommand's overload.
    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String actorId) {
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !workspaceFilesEnabled) {
            throw workspaceExecutionUnavailable();
        }
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        long now = clock.millis();
        byte[] actorKey = commandActorKey(tenantId, actorId);
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, "COMPLETED", null, actorKey, now);
        String operationId = insertTurnCommandOperation(tenantId, sessionId,
                turnId, OperationKind.CANCEL, operation, idempotencyKey,
                requestDigest, actorKey, session.status(), now);
        boolean commandEffect = ACTIVE_TURN_STATES.contains(turn.status())
                && !"CANCELLING".equals(turn.status());
        if (commandEffect) {
            int updated = jdbc.update("UPDATE ma_turn SET status ="
                            + " 'CANCELLING', gmt_modified = ?, version ="
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
        if (!commandEffect) {
            // A Turn that already ended settles the cancel now; one already
            // cancelling carries this cancel with the earlier one.
            settleTurnCommands(tenantId, sessionId, turnId, now);
        }
        return new Admission(sessionId, turnId, false, commandEffect,
                operationId);
    }

    @Override
    @Transactional
    public SessionMutationCommand beginSessionRename(String tenantId, String key,
            String digest, String sessionId, String title) {
        return beginSessionRename(tenantId, key, digest, sessionId, title,
                null);
    }

    @Override
    @Transactional
    public SessionMutationCommand beginSessionRename(String tenantId, String key,
            String digest, String sessionId, String title, String actorId) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
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
                        renameTarget(tenantId, sessionId),
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                key),
                        tenantId,
                        sessionId);
        if (!retained.isEmpty()) {
            Map<String, Object> row = retained.getFirst();
            if (!key.equals(row.get("idempotency_key")) || !digest.equals(row.get("request_digest"))
                    || !title.equals(readMap((String) row.get("request_json")).get("title"))) {
                throw new ApiException(
                        HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            if ("SUPERSEDED".equals(row.get("state"))) {
                throw new ApiException(
                        HttpStatus.CONFLICT,
                        "session_mutation_superseded",
                        "A later Session title attempt has been admitted.");
            }
            // A parked delivery (UNKNOWN before D7-2 unified it) awaits the
            // reconciler and is never re-sent.
            if ("RECOVERY_BLOCKED".equals(row.get("state"))
                    || "UNKNOWN".equals(row.get("state"))) {
                throw new ApiException(
                        HttpStatus.CONFLICT,
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
                    + " 'RECOVERY_BLOCKED', 'UNKNOWN')",
                now,
                renameTarget(tenantId, sessionId),
                next);
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " operation_id, operation_kind, tenant_id, session_id, target_kind,"
                    + " target_key, target_revision, idempotency_key, idempotency_digest,"
                    + " request_digest, request_json, state, phase, delivery_state, available_at,"
                    + " gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'RENAME', ?, ?, 'SESSION', ?,"
                    + " ?, ?, ?, ?, ?, 'PENDING', 'ADMITTED', 'PENDING', ?, ?, ?)",
                renameKey(tenantId, sessionId, next),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                "rename:" + next,
                tenantId,
                sessionId,
                renameTarget(tenantId, sessionId),
                next,
                key,
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(key),
                digest,
                writeJson(Map.of("title", title)),
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
    // authorization. A receipt recorded before the recorder stamp keeps the
    // role-gated replay it was recorded under (CommandRecord.admitsReplayBy).
    // A legacy Session has no per-actor mutation gate at all; its key's
    // outcome stays answerable through the same contract as the pre-read
    // probe. A tombstoned Session answers the reads' 404 instead of the
    // live-Session refusal.
    private void requireRenameReplayOwner(SessionRecord session,
            CommandRecord previous, String actorId) {
        if (!previous.admitsReplayBy(actorId) && session.workspace() != null
                && !workspaces.createdSession(session.tenantId(), actorId,
                        session.sessionId())) {
            if ("DELETED".equals(session.status())) {
                throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                        "The Session was not found.");
            }
            throw new ApiException(HttpStatus.CONFLICT, "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
    }

    @Override
    @Transactional
    public SessionRecord completeSessionRename(String tenantId, String key, String sessionId,
            String title, String bootId, long revision) {
        return settleRename(new RenameDelivery(tenantId, sessionId, key, title, revision, 0), null, bootId);
    }

    @Override
    @Transactional
    public SessionRecord completeSessionRename(RenameDelivery delivery, String owner, String bootId) {
        return settleRename(delivery, owner, bootId);
    }

    private SessionRecord settleRename(RenameDelivery delivery, String owner, String bootId) {
        String tenantId = delivery.tenantId();
        String sessionId = delivery.sessionId();
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        requireLegacySessionForUpdate(tenantId, sessionId);
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
                                readMap((String) rows.getFirst().get("request_json"))
                                        .get("title"))) {
            throw new ApiException(
                    HttpStatus.CONFLICT,
                    "session_mutation_superseded",
                    "A later Session title attempt has been admitted.");
        }
        Map<String, Object> operation = rows.getFirst();
        if (owner == null
                ? !"PENDING".equals(operation.get("state"))
                : !owner.equals(operation.get("claim_owner"))
                        || delivery.claimGeneration()
                                != ((Number) operation.get("claim_generation")).longValue()
                        || !List.of("RUNNING", "RECOVERY_BLOCKED", "UNKNOWN")
                                .contains(operation.get("state"))) {
            throw new ApiException(
                    HttpStatus.CONFLICT,
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

    @Override
    @Transactional
    public void abandonSessionRename(String tenantId, String key, String sessionId, long revision, String owner) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        requireLegacySessionForUpdate(tenantId, sessionId);
        if (jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_operation WHERE operation_key = ? AND operation_kind = 'RENAME' AND state = 'RUNNING' AND claim_owner = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        Integer.class,
                        renameKey(tenantId, sessionId, revision),
                        owner)
                == 1) {
            abandonSessionMutation(tenantId, "RENAME_SESSION", key, sessionId);
        }
    }

    @Override
    @Transactional
    public List<RenameDelivery> deliverableRenames(long now) {
        // A submitted delivery whose claim expired was never answered, and a
        // delivery parked UNKNOWN before D7-2 waits the same way: both park
        // for the reconciler.
        String unanswered = "(state = 'RUNNING' AND phase = 'SUBMITTED' AND claim_until <= "
                + ManagedSchemaTime.SQL_NOW + " OR state = 'UNKNOWN')";
        for (Map<String, Object> row : jdbc.queryForList(
                "SELECT operation_key, tenant_id, session_id, idempotency_key FROM ma_operation WHERE operation_kind = 'RENAME' AND " + unanswered + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.csi_guard = FALSE) LIMIT 100")) {
            parkRename(row, unanswered);
        }
        jdbc.update(
                "UPDATE ma_operation SET state = 'PENDING', delivery_state = 'PENDING', phase = 'ADMITTED', available_at = ?, claim_owner = NULL, claim_until = NULL, gmt_modified = ? WHERE operation_kind = 'RENAME' AND state = 'RUNNING' AND phase = 'PREPARING' AND claim_until <= " + ManagedSchemaTime.SQL_NOW + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.csi_guard = FALSE) LIMIT 100",
                now,
                now);
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'RENAME' AND delivery_state = 'PENDING' AND state = 'PENDING' AND available_at <= ? AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.csi_guard = FALSE) ORDER BY available_at LIMIT 100",
                this::renameDelivery,
                now);
    }

    @Override
    @Transactional
    public Optional<RenameDelivery> claimRename(RenameDelivery delivery, String owner, Duration lease) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, delivery.tenantId());
        requireLegacySessionForUpdate(delivery.tenantId(), delivery.sessionId());
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

    @Override
    public void markRenameSubmitted(RenameDelivery delivery, String owner) {
        int changed =
                jdbc.update(
                        "UPDATE ma_operation SET phase = 'SUBMITTED', gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'RENAME' AND state = 'RUNNING' AND phase = 'PREPARING' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        clock.millis(),
                        renameKey(delivery.tenantId(), delivery.sessionId(), delivery.revision()),
                        owner,
                        delivery.claimGeneration());
        if (changed != 1) {
            throw new ApiException(
                    HttpStatus.CONFLICT,
                    "operation_claim_lost",
                    "The title delivery claim was lost.");
        }
    }

    @Override
    @Transactional
    public void retryRename(RenameDelivery delivery, String owner, long availableAt) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, delivery.tenantId());
        requireLegacyMutation(delivery.tenantId(), delivery.sessionId());
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
    private void parkRename(Map<String, Object> row, String guard, Object... guardArguments) {
        List<Object> arguments = new ArrayList<>(List.of(lifecycleDatabaseTime(), clock.millis(),
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

    private RenameDelivery renameDelivery(java.sql.ResultSet row, int index) throws java.sql.SQLException {
        return new RenameDelivery(
                row.getString("tenant_id"),
                row.getString("session_id"),
                row.getString("idempotency_key"),
                (String) readMap(row.getString("request_json")).get("title"),
                row.getLong("target_revision"),
                row.getInt("attempt_count"),
                row.getLong("claim_generation"));
    }

    private static String renameTarget(String tenant, String session) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                "SESSION", tenant, session);
    }
    private static String renameKey(String tenant, String session, long revision) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract
                        .OperationKind.RENAME,
                ManagedSessionStore.sessionScopeKey(tenant, session),
                renameTarget(tenant, session),
                "rename:" + revision);
    }
    // A parked title (RECOVERY_BLOCKED, or UNKNOWN before D7-2) is not
    // pending: nothing sends it again, and the reconciler settles it in any
    // Session status, so it never holds the lifecycle (D7-2).
    private boolean hasPendingRenameDelivery(String tenantId, String sessionId) {
        return jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'RENAME' AND"
                            + " target_key = ? AND tenant_id = ? AND session_id = ? AND state IN"
                            + " ('PENDING', 'RUNNING')",
                        Integer.class,
                        renameTarget(tenantId, sessionId),
                        tenantId,
                        sessionId)
                > 0;
    }

    @Transactional
    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind) {
        return beginSessionMutation(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, kind, null);
    }

    // The actor-carrying twin of insertTurnCommand's overload.
    @Transactional
    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !boundRenameAllowed(kind)) {
            throw workspaceExecutionUnavailable();
        }
        Optional<CommandRecord> existing = findCommand(tenantId, operation,
                idempotencyKey, kind != SessionMutationKind.RENAME);
        if (existing.isPresent()) {
            CommandRecord command = existing.get();
            if (!command.requestDigest().equals(requestDigest)
                    || !command.sessionId().equals(sessionId)) {
                throw new ApiException(HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            if ("FAILED".equals(command.status())) {
                if (session.workspace() != null) {
                    WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
                }
                requireNoOpenOperation(tenantId, sessionId);
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
        requireNoOpenOperation(tenantId, sessionId);
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
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
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
        // A retired receipt still completes for a sibling that entered the
        // Harness before the retirement, but never over a later mutation:
        // while it was FAILED another key could begin and complete, and
        // completing this one now would revert that newer outcome.
        if ("FAILED".equals(command.status()) && supersededByLaterMutation(
                tenantId, sessionId, operation, idempotencyKey, kind)) {
            throw new ApiException(HttpStatus.CONFLICT,
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
        requireLegacyMutation(tenantId, sessionId);
        // Keep the digest and receipt for replay and concurrent completion.
        // A completed outcome must never be overwritten by a failing sibling.
        jdbc.update("UPDATE ma_request_receipt SET state = 'FAILED',"
                        + " gmt_modified = ? WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND'"
                        + " AND session_id = ? AND state = 'PENDING'",
                clock.millis(), ManagedReceipts.commandKey(tenantId, operation, idempotencyKey), sessionId);
    }

    @Override
    @Transactional
    public OperationAdmission beginOperation(String tenantId,
            String sessionId, OperationKind kind, String actorDigest,
            String idempotencyKey, String requestDigest) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        if (requireLegacySessionForUpdate(tenantId, sessionId).workspace() != null) {
            throw workspaceExecutionUnavailable();
        }
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest, null, false);
    }

    @Override
    public boolean workspaceFilesEnabled() {
        return workspaceFilesEnabled;
    }

    @Override
    public boolean workspaceShellEnabled() {
        return workspaceShellEnabled;
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceClose(String tenantId, String sessionId, String actorId,
            String actorDigest, String key, String digest, boolean supported) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        return beginLifecycle(tenantId, sessionId, OperationKind.CLOSE, actorDigest, key, digest, actorId, supported);
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key, String digest, boolean closeSupported) {
        // H4b child close is the only production caller. Public lifecycle uses
        // the protocol overload and requires v2 for an active Shell or MCP Session.
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, key, digest, actorId, closeSupported, 0, false);
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key, String digest, boolean supported, int protocolVersion) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, key, digest, actorId, supported, protocolVersion, true);
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
        sessionIds.forEach(id -> arguments.add(ManagedSessionStore.sessionScopeKey(tenantId, id)));
        return new HashSet<>(jdbc.queryForList("SELECT session_id FROM"
                        + " ma_operation WHERE tenant_id = ?"
                        + " AND scope_key IN (" + placeholders(sessionIds.size())
                        + ") AND operation_kind = 'CLOSE' AND state = 'COMPLETED'"
                        + " AND receipt_id IS NOT NULL",
                String.class, arguments.toArray()));
    }

    // The lifecycle owner gate: the Session's recorded owner (with the
    // pre-V40 creator fallback) holding a current read grant. Unreadable is
    // invisible; a readable non-owner gets the sibling family's 403.
    private void requireWorkspaceCreator(SessionRecord session, String actorId) {
        if (!workspaces.canRead(session.tenantId(), actorId, session.workspace().getWorkspaceId())) {
            throw new ApiException(
                    HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found.");
        }
        if (!workspaces.isSessionOwner(session.tenantId(), actorId, session.sessionId())) {
            throw new ApiException(HttpStatus.FORBIDDEN, "session_operation_forbidden",
                    "Only the Session owner may manage it.");
        }
    }

    @Override
    @Transactional
    public SessionMutation unarchiveWorkspaceSession(String tenantId, String sessionId,
            String actorId, String scopedKey, String requestDigest) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        requireWorkspaceCreator(session, actorId);
        String namespace = "UNARCHIVE_WORKSPACE_SESSION";
        // Replay first, like every other mutation path: a recorded success
        // must not 404 after a later delete.
        Optional<CommandRecord> existing = findCommand(tenantId, namespace, scopedKey, true);
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest) || !existing.get().sessionId().equals(sessionId)) {
                throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new SessionMutation(session, true);
        }
        // The tombstone 404 precedes the migration fence and the shell
        // refusal: a fresh key against a deleted Session must not answer
        // a retryable 409 for a Session that will never come back.
        if ("DELETED".equals(session.status())) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found.");
        }
        if (WorkspaceToolProfiles.isShellOrMcp(session.toolProfile())
                && (WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) != 2
                        || !List.of("CLOSED", "ARCHIVED").contains(session.status()))) {
            throw workspaceExecutionUnavailable();
        }
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
        requireSessionStatus(session.status(), "ARCHIVED");
        requireNoOpenOperation(tenantId, sessionId);
        if (!hasCompletedWorkspaceClose(tenantId, sessionId)) {
            throw workspaceExecutionUnavailable();
        }
        long now = lifecycleDatabaseTime();
        insertCommand(
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
        appendEvent(tenantId, sessionId, null, "session.unarchive.requested", data, false,
                mutationSource(namespace, scopedKey, "requested"), now);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED', gmt_modified = ?, version = version + 1"
                + " WHERE tenant_id = ? AND session_id = ?", now, tenantId, sessionId);
        appendEvent(tenantId, sessionId, null, "session.unarchived", data, false,
                mutationSource(namespace, scopedKey, "completed"), now);
        return new SessionMutation(requireSessionForUpdate(tenantId, sessionId), false);
    }

    private static final String SESSION_OPERATION_KINDS =
            "('CLOSE', 'ARCHIVE', 'DELETE', 'ACTION_RESPONSE', 'CWD_CHANGE', 'TASK_CANCEL')";
    // D7-1: a Turn input or cancel command targets its Turn, never the
    // Session, so no Session barrier above counts it: the Turn row is its
    // barrier, and the Turn dispatcher, which holds the only lease that may
    // act on the Turn, is its only deliverer.
    private static final String TURN_COMMAND_KINDS = "('SUBMIT_INPUT', 'CANCEL')";
    // D7-2: RECOVERY_BLOCKED carries two meanings, decided by kind. For
    // these kinds it means the command's acceptance is unknown: no claim
    // ever takes the row, nothing re-sends it, and only the reconciler
    // settles it, from the kind's own keyed evidence.
    private static final String ACCEPTANCE_UNKNOWN_KINDS =
            "('TASK_CANCEL', 'SUBMIT_INPUT', 'RENAME')";
    // For these it is a published wait on a precondition of an operation
    // whose acceptance is known: the lifecycle coordinator re-drives it, and
    // keyed effect receipts keep the re-drive from repeating an effect.
    private static final String LIFECYCLE_WAIT_KINDS =
            "('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE')";
    /** Turn input whose submission no Harness answered (D7-2). */
    static final String SUBMIT_INPUT_UNCONFIRMED = "submit_input_unconfirmed";
    /** A Session title whose submitted delivery no Harness answered (D7-2). */
    static final String SESSION_TITLE_UNCONFIRMED = "session_title_unconfirmed";
    /** A parked Session title the sealed journal proves never landed. */
    static final String SESSION_TITLE_UNDELIVERED = "session_title_undelivered";
    // A RENAME parks with the same columns either way: acceptance unknown,
    // never re-sent, settled only by the reconciler or by the same claim's
    // own late reply. Its claim fields stay, so that late reply still settles.
    private static final String PARK_RENAME = "state = 'RECOVERY_BLOCKED',"
            + " phase = 'RECOVERY_BLOCKED', admission_stage = 'JAVA_DURABLE',"
            + " delivery_state = 'BLOCKED', failure_code = '"
            + SESSION_TITLE_UNCONFIRMED + "'";

    private String insertTurnCommandOperation(String tenantId,
            String sessionId, String turnId, OperationKind kind,
            String command, String idempotencyKey, String requestDigest,
            byte[] actorKey, String sessionStatus, long now) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String target = turnOperationTarget(turnId);
        String operationId = publicId("op");
        String operationKey = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind.valueOf(kind.name()),
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
                writeJson(Map.of("schemaVersion", 1, "kind", kind.name(),
                        "sessionId", sessionId, "turnId", turnId)),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
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

    private static String turnOperationTarget(String turnId) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(turnId);
    }

    /**
     * Settles the open input and cancel operations of a Turn from the Turn's
     * own committed facts, in the transaction that commits them. Input is
     * accepted once the Turn holds a Harness event epoch, the fact its
     * dispatcher records when a Harness admits the Turn; until then a
     * cancelled or failed Turn ends the input undelivered. A cancel
     * completes when the Turn is cancelled — by the Harness, or by Java
     * before any Harness admitted it — and fails turn_already_settled when
     * the Turn ended otherwise. A Turn that has not ended leaves its cancels
     * pending, so cancels of one Turn coalesce.
     */
    private void settleTurnCommands(String tenantId, String sessionId,
            String turnId, long now) {
        // Current reads only: every caller holds the Session row, but its
        // snapshot may predate that lock and miss a cancel committed since.
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
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
        } else if (!ACTIVE_TURN_STATES.contains(turn.status())) {
            settleTurnCommand(tenantId, sessionId, turnId,
                    OperationKind.CANCEL, "FAILED", "JAVA_DURABLE",
                    "turn_already_settled", now);
        }
    }

    // Only a completed operation is delivered and carries a receipt; a
    // failed or cancelled one stays java_durable and blocked, so it is never
    // delivered again, and a parked one is due for the reconciler at once.
    private void settleTurnCommand(String tenantId, String sessionId,
            String turnId, OperationKind kind, String state,
            String admissionStage, String failureCode, long now) {
        boolean completed = "COMPLETED".equals(state);
        boolean parked = "RECOVERY_BLOCKED".equals(state);
        // The identity index confines this locking scan to the Turn's own
        // operations. Left to the optimizer, a long settled history steers it
        // to a (kind, state) index whose range holds every Session's pending
        // rows, and two Sessions' settles then deadlock. H2 skips the hint.
        for (String operationKey : jdbc.queryForList("SELECT operation_key"
                        + " FROM ma_operation /*! FORCE INDEX (uq_ma_operation_identity) */"
                        + " WHERE scope_key = ? AND"
                        + " operation_kind = ? AND target_key = ? AND state ="
                        + " 'PENDING' FOR UPDATE", String.class,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                kind.name(), turnOperationTarget(turnId))) {
            jdbc.update("UPDATE ma_operation SET state = ?, phase = ?,"
                            + " admission_stage = ?, delivery_state = ?,"
                            + " receipt_id = ?, failure_code = ?,"
                            + " available_at = ?, gmt_modified = ?,"
                            + " completed_at = ? WHERE"
                            + " operation_key = ? AND state = 'PENDING'",
                    state, state, admissionStage,
                    completed ? "CONFIRMED" : "BLOCKED",
                    completed ? publicId("rcpt") : null, failureCode, now,
                    now, parked ? null : now, operationKey);
        }
    }

    private Optional<OperationRecord> findTurnCommandOperation(
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
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        operationId)
                .stream()
                .findFirst();
    }

    private static String sessionOperationTarget(String sessionId) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(sessionId);
    }

    private static String sessionOperationKey(String tenantId, String sessionId, OperationKind kind, String operationId) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind.valueOf(kind.name()),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId), sessionOperationTarget(sessionId), operationId);
    }

    private Optional<OperationRecord> replayOperation(String tenantId, String sessionId,
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
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        kind.name(),
                        sessionOperationTarget(sessionId),
                        actorDigest,
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                idempotencyKey))
                .stream()
                .findFirst();
    }

    private Optional<OperationRecord> findSessionOperation(String tenantId, String sessionId, String operationId, boolean lock) {
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
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
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
                        operationId)
                .stream()
                .findFirst();
    }

    @Override
    @Transactional
    public OperationAdmission beginChildClose(String tenantId, String parentSessionId,
            String childSessionId, String childRunId, String actorDigest, String key,
            String digest, boolean supported) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        requireSessionForUpdate(tenantId, parentSessionId);
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
            throw new ApiException(
                    HttpStatus.NOT_FOUND,
                    "session_not_found",
                    "The child Session lineage was not found.");
        }
        return beginLifecycle(tenantId, childSessionId, OperationKind.CLOSE, actorDigest, key, digest,
                null, supported, 0, true, true);
    }

    private OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorDigest, String idempotencyKey, String requestDigest, String actorId, boolean supported) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest, actorId, supported, 0, true);
    }

    private OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorDigest, String idempotencyKey, String requestDigest, String actorId, boolean supported, int protocolVersion) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest, actorId, supported, protocolVersion, true);
    }

    private OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorDigest, String idempotencyKey, String requestDigest, String actorId, boolean supported, int protocolVersion,
            boolean publicLifecycle) {
        return beginLifecycle(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest,
                actorId, supported, protocolVersion, publicLifecycle, false);
    }

    private OperationAdmission beginLifecycle(String tenantId, String sessionId, OperationKind kind,
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
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() != null && !trustedChildClose) {
            requireWorkspaceCreator(session, actorId);
        }
        Optional<OperationRecord> existing = replayOperation(tenantId, sessionId,
                kind, actorDigest, idempotencyKey);
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
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_protocol_unavailable");
        }
        if (publicLifecycle && WorkspaceToolProfiles.isShellOrMcp(session.toolProfile())
                && (WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) != 2
                        || protocolVersion != 2 && (!List.of("CLOSED", "ARCHIVED").contains(session.status())
                                || !hasCompletedWorkspaceClose(tenantId, sessionId)))) {
            throw workspaceExecutionUnavailable();
        }
        if (hasPendingRenameDelivery(tenantId, sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT, "session_operation_active",
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
        long now = lifecycleDatabaseTime();
        String operationId = publicId("op");
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
                sessionOperationKey(tenantId, sessionId, kind, operationId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId),
                sessionId,
                archive ? "COMPLETED" : "PENDING",
                writeJson(
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
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
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
                archive ? publicId("rcpt") : null,
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
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.beginHarnessLifecycle(connection, tenantId, sessionId, operationId);
                return null;
            });
        }
        jdbc.update("UPDATE ma_session SET status = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
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
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
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
        // The mutable role refusal comes after the replay: the replay
        // lookup is actor-scoped, so a role revoked after admission still
        // resolves a retry to the caller's own operation instead of 403.
        WorkspaceAccess cwdAccess = workspaces.accessOf(session.tenantId(),
                actorId, binding.getWorkspaceId());
        if (!cwdAccess.canRead()) {
            throw new ApiException(
                    HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found.");
        }
        Optional<OperationRecord> existing = replayOperation(tenantId, sessionId,
                OperationKind.CWD_CHANGE, actorDigest, idempotencyKey);
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest)) {
                throw new ApiException(HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new OperationAdmission(existing.get(), true);
        }
        if (!cwdAccess.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "session_operation_forbidden",
                    "Only a Workspace operator may change the Session directory.");
        }
        if (residentWorkspaces.find(binding) != null) {
            throw workspaceExecutionUnavailable();
        }
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId,
                binding.getStorageId());
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
                || hasPendingRenameDelivery(tenantId, sessionId)
                || hasActiveTurn(tenantId, sessionId)
                || hasDecidableAction(session)
                || hasRetainedRuntimeSession(tenantId, sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "session_context_busy",
                    "The Session has an active Turn, operation or retained Runtime context.");
        }
        long now = lifecycleDatabaseTime();
        String operationId = publicId("op");
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " target_kind, target_key, target_id, phase, request_json,"
                    + " idempotency_digest, tenant_id, session_id, operation_id, operation_kind,"
                    + " actor_digest, idempotency_key, request_digest, state, admission_stage,"
                    + " delivery_state, session_status_before, target_cwd_relative,"
                    + " expected_context_revision, actor_key, available_at, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, 'SESSION', ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                    + " 'PENDING', 'JAVA_DURABLE', 'PENDING', ?, ?, ?, ?, ?, ?, ?)",
                sessionOperationKey(tenantId, sessionId, OperationKind.CWD_CHANGE, operationId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId),
                sessionId,
                writeJson(
                        Map.of(
                                "schemaVersion",
                                1,
                                "kind",
                                "CWD_CHANGE",
                                "sessionId",
                                sessionId,
                                "targetCwdRelative",
                                targetCwdRelative,
                                "expectedContextRevision",
                                expectedContextRevision)),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                        idempotencyKey),
                tenantId,
                sessionId,
                operationId,
                OperationKind.CWD_CHANGE.name(),
                actorDigest,
                idempotencyKey,
                requestDigest,
                session.status(),
                targetCwdRelative,
                expectedContextRevision,
                actorId == null ? null : ManagedWorkspaceRegistry.actorKey(tenantId, actorId),
                now,
                now,
                now);
        return new OperationAdmission(findOperation(tenantId, sessionId,
                operationId).orElseThrow(), false);
    }

    @Override
    @Transactional
    public CwdChangeOutcome completeCwdChangeOperation(String tenantId,
            String sessionId, String operationId, String owner,
            long claimGeneration) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        OperationRecord operation = findSessionOperation(tenantId, sessionId, operationId, true)
                .orElseThrow(() -> new IllegalStateException("Session operation is unavailable"));
        if (operation.kind() != OperationKind.CWD_CHANGE) {
            throw new IllegalStateException("Operation " + operationId
                    + " is not a cwd change");
        }
        Boolean leaseLive =
                jdbc.queryForObject(
                        "SELECT claim_until > " + ManagedSchemaTime.SQL_NOW + " FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ? FOR UPDATE",
                        Boolean.class,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId);
        if (!Boolean.TRUE.equals(leaseLive)
                || !"RUNNING".equals(operation.state())
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
        if (binding == null || !"ACTIVE".equals(session.status())
                || WorkspaceMigrationAdmission.owner(jdbc, tenantId,
                        binding.getStorageId()) != null) {
            failure = "workspace_unavailable";
        } else if (binding.getContextRevision() != expected) {
            failure = "context_revision_conflict";
        } else if (hasOpenOperation(tenantId, sessionId, operationId)
                || hasActiveTurn(tenantId, sessionId)
                || hasDecidableAction(session)
                || hasRetainedRuntimeSession(tenantId, sessionId)) {
            failure = "session_context_busy";
        } else if (!hasExecutionRegistryFacts(session.tenantId(),
                session.sessionId()) || !initiatorKeepsOperate(session,
                operation)) {
            failure = "workspace_unavailable";
        }
        if (failure != null) {
            jdbc.update(
                    "UPDATE ma_operation SET phase = 'FAILED', state ="
                            + " 'FAILED', delivery_state = 'CONFIRMED',"
                            + " failure_code = ?, claim_owner = NULL,"
                            + " claim_until = NULL, gmt_modified = ?,"
                            + " completed_at = ? WHERE scope_key = ? AND operation_kind IN "
                            + SESSION_OPERATION_KINDS
                            + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                            + " operation_id = ?",
                    failure,
                    now,
                    now,
                    ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                    sessionOperationTarget(sessionId),
                    tenantId,
                    sessionId,
                    operationId);
            return new CwdChangeOutcome(false, failure, null);
        }
        long result = expected + 1;
        jdbc.update("UPDATE ma_session SET cwd_relative = ?,"
                        + " context_revision = ?, gmt_modified = ?, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ?",
                operation.targetCwdRelative(), result, now, tenantId,
                sessionId);
        jdbc.update(
                "UPDATE ma_operation SET phase = 'COMPLETED', state = 'COMPLETED', delivery_state ="
                    + " 'CONFIRMED', receipt_id = ?, result_context_revision = ?, claim_owner ="
                    + " NULL, claim_until = NULL, gmt_modified = ?, completed_at = ? WHERE scope_key"
                    + " = ? AND operation_kind IN "
                        + SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ?",
                publicId("rcpt"),
                result,
                now,
                now,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId),
                tenantId,
                sessionId,
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
        requireLegacyMutation(tenantId, sessionId);
        long now = lifecycleDatabaseTime();
        return jdbc.update(
                        "UPDATE ma_operation SET phase = 'FAILED', state ="
                                + " 'FAILED', delivery_state = 'CONFIRMED',"
                                + " failure_code = ?, claim_owner = NULL,"
                                + " claim_until = NULL, gmt_modified = ?,"
                                + " completed_at = ? WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        failureCode,
                        now,
                        now,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId,
                        owner,
                        claimGeneration)
                == 1;
    }

    @Override
    @Transactional
    public OperationAdmission beginTaskCancelOperation(String tenantId,
            String sessionId, String taskId, String actorDigest,
            String idempotencyKey, String requestDigest) {
        // The caller has already validated the key and checked current
        // access (404, then 403 task_forbidden): those run first by
        // contract, so a revoked caller never replays. Under the Session
        // lock the retained key replays before any new-request check, so
        // a lost 202 survives capability and state changes; only a new
        // request rechecks the Session state, the task's cancel action
        // and the one-open-operation rule, atomically with its insert.
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        Optional<OperationRecord> existing = replayOperation(tenantId, sessionId,
                OperationKind.TASK_CANCEL, actorDigest, idempotencyKey);
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
        if (!"ACTIVE".equals(session.status())) {
            throw new ApiException(HttpStatus.CONFLICT, "session_not_active",
                    "The Session is " + session.status().toLowerCase(
                            java.util.Locale.ROOT)
                            + " and accepts no task cancellation.");
        }
        // The task row is the projection its own commits update, so the
        // locking read serializes this admission with the transition that
        // would settle the task.
        List<String[]> task = jdbc.query("SELECT task_kind, task_state FROM"
                        + " ma_session_record WHERE"
                        + " session_scope_key = ? AND record_key = ?"
                        + " AND task_kind IS NOT NULL FOR UPDATE",
                (result, row) -> new String[] {result.getString("task_kind"),
                        result.getString("task_state")},
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                taskId.substring("task_".length()));
        if (task.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "task_not_found",
                    "The task was not found.");
        }
        if (!ManagedExtensionProjection.taskActions(task.getFirst()[0],
                task.getFirst()[1]).contains("cancel")) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "task_action_unavailable",
                    "The task does not accept a cancellation now.");
        }
        // A bound Session under storage migration admits no new work, as
        // every sibling bound admission refuses it: a cancel admitted
        // behind the fence would wedge the migration's idle checks.
        if (session.workspace() != null) {
            WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId,
                    session.workspace().getStorageId());
        }
        requireNoOpenOperation(tenantId, sessionId);
        long now = lifecycleDatabaseTime();
        String operationId = publicId("op");
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " target_kind, target_key, target_id, phase, request_json,"
                    + " idempotency_digest, tenant_id, session_id, operation_id, operation_kind,"
                    + " actor_digest, idempotency_key, request_digest, state, admission_stage,"
                    + " delivery_state, session_status_before, task_id, available_at, gmt_create,"
                    + " gmt_modified) VALUES (?, ?, ?, 'SESSION', ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?,"
                    + " ?, ?, ?, 'PENDING', 'JAVA_DURABLE', 'PENDING', ?, ?, ?, ?, ?)",
                sessionOperationKey(tenantId, sessionId, OperationKind.TASK_CANCEL, operationId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId),
                sessionId,
                writeJson(
                        Map.of(
                                "schemaVersion",
                                1,
                                "kind",
                                "TASK_CANCEL",
                                "sessionId",
                                sessionId,
                                "taskId",
                                taskId)),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                        idempotencyKey),
                tenantId,
                sessionId,
                operationId,
                OperationKind.TASK_CANCEL.name(),
                actorDigest,
                idempotencyKey,
                requestDigest,
                session.status(),
                taskId,
                now,
                now,
                now);
        return new OperationAdmission(findOperation(tenantId, sessionId,
                operationId).orElseThrow(), false);
    }

    @Override
    public List<OperationTarget> findDeliverableTaskCancels(int limit) {
        long now = lifecycleDatabaseTime();
        List<OperationTarget> targets =
                new ArrayList<>(
                        jdbc.query(
                                "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE"
                                    + " operation_kind = 'TASK_CANCEL' AND state IN ('PENDING',"
                                    + " 'RUNNING') AND delivery_state = 'PENDING' AND available_at"
                                    + " <= ? AND EXISTS (SELECT 1 FROM ma_session private_scope"
                                    + " WHERE private_scope.tenant_id = ma_operation.tenant_id AND"
                                    + " private_scope.session_id = ma_operation.session_id AND"
                                    + " private_scope.csi_guard = FALSE) ORDER BY available_at"
                                    + " LIMIT ?",
                                operationTargetMapper,
                                now,
                                limit));
        if (targets.size() < limit) {
            targets.addAll(jdbc.query(
                            "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE operation_kind = 'TASK_CANCEL' AND delivery_state = 'LEASED' AND claim_until < " + ManagedSchemaTime.SQL_NOW + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.csi_guard = FALSE) ORDER BY claim_until LIMIT ?",
                    operationTargetMapper, limit - targets.size()));
        }
        return List.copyOf(targets);
    }

    @Override
    public List<ParkedOperation> findParkedOperations(int limit) {
        // Kind and state lead the due index, so the per-second scan reads
        // only parked rows, never a kind's settled history.
        return jdbc.query(
                "SELECT tenant_id, session_id, operation_id, operation_kind FROM ma_operation"
                    + " WHERE operation_kind IN " + ACCEPTANCE_UNKNOWN_KINDS + " AND state ="
                    + " 'RECOVERY_BLOCKED' AND available_at <= ? AND delivery_state = 'BLOCKED'"
                    + " AND EXISTS (SELECT 1 FROM ma_session s WHERE s.tenant_id ="
                    + " ma_operation.tenant_id AND s.session_id = ma_operation.session_id AND"
                    + " s.csi_guard = FALSE) ORDER BY available_at LIMIT ?",
                (result, row) -> new ParkedOperation(result.getString("tenant_id"),
                        result.getString("session_id"), result.getString("operation_id"),
                        result.getString("operation_kind")),
                lifecycleDatabaseTime(), limit);
    }

    @Override
    @Transactional
    public boolean settleParkedOperation(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        requireLegacyMutation(parked.tenantId(), parked.sessionId());
        long now = lifecycleDatabaseTime();
        List<Object> arguments = new ArrayList<>();
        String update = switch (verdict.acceptance()) {
            case COMMITTED -> {
                arguments.add(publicId("rcpt"));
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'COMPLETED', state = 'COMPLETED',"
                        + " admission_stage = 'HARNESS_CONFIRMED',"
                        + " delivery_state = 'CONFIRMED', receipt_id = ?,"
                        + " failure_code = NULL, gmt_modified = ?, completed_at = ?";
            }
            case NOT_COMMITTED -> {
                // Terminal yet blocked, as the contract has it: available_at
                // moves past every scan of the blocked range for good.
                arguments.add(verdict.failureCode());
                arguments.add(Long.MAX_VALUE);
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'FAILED', state = 'FAILED',"
                        + " admission_stage = 'JAVA_DURABLE',"
                        + " delivery_state = 'BLOCKED', failure_code = ?,"
                        + " available_at = ?, gmt_modified = ?, completed_at = ?";
            }
            case UNKNOWN -> {
                arguments.add(Math.addExact(now,
                        Math.max(0, retryAt - clock.millis())));
                arguments.add(now);
                yield "UPDATE ma_operation SET available_at = ?, gmt_modified = ?,"
                        + " attempt_count = attempt_count + 1";
            }
        };
        arguments.addAll(List.of(parked.kind(), parked.operationId(),
                parked.tenantId(), parked.sessionId()));
        // Only a still-parked row: a reconciliation never rewrites an
        // outcome already recorded, and no claim holds a parked row.
        return jdbc.update(update + " WHERE operation_kind = ? AND operation_id = ?"
                        + " AND tenant_id = ? AND session_id = ? AND operation_kind IN "
                        + ACCEPTANCE_UNKNOWN_KINDS + " AND state = 'RECOVERY_BLOCKED' AND"
                        + " delivery_state = 'BLOCKED' AND claim_owner IS NULL",
                arguments.toArray()) == 1;
    }

    /**
     * The Harness admits a prompt by committing {@code submitInput} to the
     * Session journal under the prompt's id, so the journal row keyed by that
     * command is the admission's own evidence. Its absence proves nothing
     * while a writer may still commit it; once the head refuses every writer
     * (DELETING or DELETED) and compaction has not started, the journal is
     * complete and the absence is proof. Both facts come from one statement,
     * whose single read view holds under any isolation level: a commit that
     * preceded the deletion is visible beside it, and no commit can land
     * between the two reads, as it could between two statements under READ
     * COMMITTED and turn an admitted input into a failed one.
     */
    @Override
    public AcceptanceVerdict turnInputAcceptance(String tenantId,
            String sessionId, String operationId) {
        String turnId = jdbc.queryForList("SELECT target_id FROM ma_operation WHERE"
                        + " scope_key = ? AND operation_kind = 'SUBMIT_INPUT' AND operation_id = ?",
                String.class, ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                operationId).stream().findFirst().orElse(null);
        TurnRecord turn = turnId == null ? null
                : findTurn(tenantId, sessionId, turnId).orElse(null);
        if (turn == null) {
            return AcceptanceVerdict.unknown();
        }
        if (turn.harnessEventEpoch() != null) {
            return AcceptanceVerdict.committed();
        }
        JournalEvidence evidence = journalEvidence(tenantId, sessionId,
                "submitInput", turn.promptId());
        if (evidence.admittedDigest() != null) {
            if (("sha256:" + evidence.admittedDigest()).equals(turn.payloadDigest())) {
                return AcceptanceVerdict.committed();
            }
            LOG.warn("Journal admission digest differs from its Turn tenant={}"
                    + " session={} turn={}", tenantId, sessionId, turnId);
            return AcceptanceVerdict.unknown();
        }
        return evidence.sealed() ? AcceptanceVerdict.notCommitted(turn.errorCode())
                : AcceptanceVerdict.unknown();
    }

    private record JournalEvidence(String admittedDigest, boolean sealed) {
    }

    /**
     * The Session journal's own record of one keyed command: the content
     * digest it was admitted with, if any, and whether the journal is sealed
     * complete (no writer can still commit, compaction has not started).
     */
    private JournalEvidence journalEvidence(String tenantId, String sessionId,
            String operation, String commandId) {
        return jdbc.queryForObject("SELECT (SELECT content_digest"
                        + " FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND command_key_hash = ?) AS admitted_digest, (SELECT COUNT(*) FROM"
                        + " ma_session_head WHERE tenant_key = ? AND harness_key = ? AND"
                        + " tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'"
                        + " AND state IN ('DELETING', 'DELETED') AND"
                        + " COALESCE(compacted_through_revision, 0) = 0) AS sealed",
                (result, row) -> new JournalEvidence(result.getString("admitted_digest"),
                        result.getLong("sealed") > 0),
                tenantId, sessionId,
                ManagedSessionStore.commandKeyHash(operation, commandId),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), tenantId,
                sessionId);
    }

    /**
     * The Hosted Harness commits a fenced title to the Session journal as
     * {@code renameSession} under {@code hosted-title:<revision>}, with the
     * title's SHA-256 as its content digest. That commit is the delivery's
     * own evidence, read in one statement beside the head exactly as a Turn
     * input's admission is.
     */
    @Override
    public Optional<AcceptanceVerdict> renameAcceptance(ParkedOperation parked) {
        var rows = jdbc.queryForList("SELECT target_revision, request_json FROM ma_operation"
                        + " WHERE scope_key = ? AND operation_kind = 'RENAME' AND operation_id = ?"
                        + " AND tenant_id = ? AND session_id = ? AND state = 'RECOVERY_BLOCKED'",
                ManagedSessionStore.sessionScopeKey(parked.tenantId(), parked.sessionId()),
                parked.operationId(), parked.tenantId(), parked.sessionId());
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        long revision = ((Number) rows.getFirst().get("target_revision")).longValue();
        String title = (String) readMap((String) rows.getFirst().get("request_json")).get("title");
        JournalEvidence evidence = journalEvidence(parked.tenantId(), parked.sessionId(),
                "renameSession", "hosted-title:" + revision);
        // A row without its title can still be proven undelivered, never
        // matched (review of #14475).
        if (evidence.admittedDigest() != null) {
            if (title != null && DigestUtils.sha256Hex(title).equals(evidence.admittedDigest())) {
                return Optional.of(AcceptanceVerdict.committed());
            }
            LOG.warn("Journal title digest differs from its delivery tenant={}"
                    + " session={} revision={}", parked.tenantId(), parked.sessionId(), revision);
            return Optional.of(AcceptanceVerdict.unknown());
        }
        return Optional.of(evidence.sealed()
                ? AcceptanceVerdict.notCommitted(SESSION_TITLE_UNDELIVERED)
                : AcceptanceVerdict.unknown());
    }

    @Override
    @Transactional
    public boolean settleParkedRename(ParkedOperation parked, AcceptanceVerdict verdict,
            long retryAt) {
        String tenantId = parked.tenantId();
        String sessionId = parked.sessionId();
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        // Only a still-parked row: the claim's own late reply or a later
        // title may have settled it since the evidence was read.
        var rows = jdbc.queryForList("SELECT operation_key, idempotency_key, request_json"
                        + " FROM ma_operation WHERE scope_key = ? AND operation_kind = 'RENAME'"
                        + " AND operation_id = ? AND tenant_id = ? AND session_id = ? AND state ="
                        + " 'RECOVERY_BLOCKED' AND delivery_state = 'BLOCKED' FOR UPDATE",
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId), parked.operationId(),
                tenantId, sessionId);
        if (rows.isEmpty()) {
            return false;
        }
        String operationKey = (String) rows.getFirst().get("operation_key");
        String key = (String) rows.getFirst().get("idempotency_key");
        String receipt = ManagedReceipts.commandKey(tenantId, "RENAME_SESSION", key);
        long now = clock.millis();
        switch (verdict.acceptance()) {
            case COMMITTED -> {
                // The Harness holds the title, so the Session shows it in
                // whatever status a lifecycle has since reached, unless a
                // deletion took the Session away. A later title would have
                // superseded this row, so it is still the newest.
                String title = (String) readMap((String) rows.getFirst().get("request_json"))
                        .get("title");
                if (title != null && !List.of("DELETING", "DELETED").contains(session.status())) {
                    jdbc.update("UPDATE ma_session SET title = ?, gmt_modified = ?,"
                                    + " version = version + 1 WHERE tenant_id = ? AND session_id = ?",
                            title, now, tenantId, sessionId);
                    appendEvent(tenantId, sessionId, null,
                            mutationEvent(SessionMutationKind.RENAME, "completed"),
                            Map.of("sessionId", sessionId, "metadata", Map.of("title", title)),
                            false, mutationSource("RENAME_SESSION", key, "completed"), now);
                }
                jdbc.update("UPDATE ma_request_receipt SET state = 'COMPLETED', gmt_modified = ?"
                                + " WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND'",
                        now, receipt);
                jdbc.update("UPDATE ma_operation SET state = 'COMPLETED', phase = 'COMPLETED',"
                                + " admission_stage = 'HARNESS_CONFIRMED', delivery_state = 'COMPLETED',"
                                + " failure_code = NULL, claim_owner = NULL, claim_until = NULL,"
                                + " gmt_modified = ?, completed_at = ? WHERE operation_key = ?",
                        now, now, operationKey);
            }
            case NOT_COMMITTED -> {
                // Terminal yet blocked, as every proven non-commit is: its
                // available_at moves past every scan for good.
                jdbc.update("UPDATE ma_request_receipt SET state = 'FAILED', gmt_modified = ?"
                                + " WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND'"
                                + " AND state = 'PENDING'",
                        now, receipt);
                jdbc.update("UPDATE ma_operation SET state = 'FAILED', phase = 'FAILED',"
                                + " admission_stage = 'JAVA_DURABLE', delivery_state = 'BLOCKED',"
                                + " failure_code = ?, available_at = ?, claim_owner = NULL,"
                                + " claim_until = NULL, gmt_modified = ?, completed_at = ?"
                                + " WHERE operation_key = ?",
                        verdict.failureCode(), Long.MAX_VALUE, now, now, operationKey);
            }
            case UNKNOWN -> jdbc.update("UPDATE ma_operation SET available_at = ?, gmt_modified = ?,"
                            + " attempt_count = attempt_count + 1 WHERE operation_key = ?",
                    Math.addExact(lifecycleDatabaseTime(), Math.max(0, retryAt - now)), now,
                    operationKey);
        }
        return true;
    }

    @Override
    @Transactional
    public boolean settleTaskCancel(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            TaskCancelOutcome outcome, long retryAt) {
        if (owner == null) {
            throw new IllegalArgumentException(
                    "A parked task cancel settles through settleParkedOperation");
        }
        requireLegacyMutation(tenantId, sessionId);
        long now = lifecycleDatabaseTime();
        // A leased claim settles only while it is still this worker's.
        String claim = " AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "";
        List<Object> arguments = new ArrayList<>();
        String update = switch (outcome.status()) {
            case "completed" -> {
                arguments.add(publicId("rcpt"));
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'COMPLETED', state = 'COMPLETED',"
                        + " admission_stage = 'HARNESS_CONFIRMED',"
                        + " delivery_state = 'CONFIRMED', receipt_id = ?,"
                        + " failure_code = NULL, claim_owner = NULL,"
                        + " claim_until = NULL, gmt_modified = ?,"
                        + " completed_at = ?";
            }
            case "failed" -> {
                // A failed cancel is terminal yet keeps the contract's
                // blocked delivery state: its available_at moves past
                // every scan of the blocked index range for good.
                arguments.add(outcome.failureCode());
                arguments.add(Long.MAX_VALUE);
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'FAILED', state = 'FAILED',"
                        + " admission_stage = 'JAVA_DURABLE',"
                        + " delivery_state = 'BLOCKED', failure_code = ?,"
                        + " available_at = ?, claim_owner = NULL,"
                        + " claim_until = NULL, gmt_modified = ?,"
                        + " completed_at = ?";
            }
            case "recovery_blocked" -> {
                arguments.add(outcome.failureCode());
                arguments.add(Math.addExact(now,
                        Math.max(0, retryAt - clock.millis())));
                arguments.add(now);
                yield "UPDATE ma_operation SET"
                        + " phase = 'RECOVERY_BLOCKED', state = 'RECOVERY_BLOCKED',"
                        + " admission_stage = 'JAVA_DURABLE',"
                        + " delivery_state = 'BLOCKED', failure_code = ?,"
                        + " available_at = ?, claim_owner = NULL,"
                        + " claim_until = NULL, gmt_modified = ?,"
                        + " attempt_count = attempt_count + 1";
            }
            default -> throw new IllegalArgumentException(
                    "Unknown task cancel outcome " + outcome.status());
        };
        arguments.addAll(List.of(ManagedSessionStore.sessionScopeKey(tenantId, sessionId), sessionOperationTarget(sessionId), tenantId, sessionId, operationId, owner, claimGeneration));
        return jdbc.update(
                        update
                                + " WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ? AND operation_kind = 'TASK_CANCEL'"
                                + claim,
                        arguments.toArray())
                == 1;
    }

    // The initiator, persisted at V56 admission: settlement fails when the
    // operating actor no longer holds OPERATOR — revoking one in-flight
    // initiator stops only their own admitted change, as the W2 guard
    // intends. A pre-V56 (NULL key) row settles on the creator-keyed facts
    // alone. The vocabulary filter keeps an out-of-enum stored role (only
    // reachable by an out-of-band write past V53's CHECK) on the same
    // fail-closed workspace_unavailable verdict as a revocation, rather
    // than an IllegalArgumentException looping through the retry.
    private boolean initiatorKeepsOperate(SessionRecord session,
            OperationRecord operation) {
        if (operation.actorKey() == null) {
            return true;
        }
        List<String> roles = jdbc.queryForList("SELECT role FROM"
                        + " ma_workspace_access WHERE tenant_id = ? AND"
                        + " workspace_id = ? AND actor_id = ? AND role IN"
                        + " ('READER', 'OPERATOR', 'OWNER')",
                String.class, session.tenantId(),
                session.workspace().getWorkspaceId(), operation.actorKey());
        return !roles.isEmpty() && WorkspaceAccess.valueOf(roles.getFirst())
                .atLeast(WorkspaceAccess.OPERATOR);
    }

    private void requireCwdChangeRegistryFacts(SessionRecord session) {
        if (!hasExecutionRegistryFacts(session.tenantId(),
                session.sessionId())) {
            throw workspaceExecutionUnavailable();
        }
    }

    // The Registry still backs the binding exactly, its state is ACTIVE and
    // the creation actor's grants survive — the passive-attachment subset
    // WorkspaceExecutionStore.authorizePassiveAttachment gates execution on;
    // the frozen profile and agent checks stay the next turn's
    // acquire-time gate. Admission of every family that executes under the
    // creator's authority (later Turns and the cwd change alike) re-checks
    // the same facts so a widened caller cannot be certified for a run
    // that can only fail.
    @Override
    public boolean hasExecutionRegistryFacts(String tenantId,
            String sessionId) {
        return sessionsWithExecutionRegistryFacts(tenantId,
                List.of(sessionId)).contains(sessionId);
    }

    /** The batch twin of {@link #hasExecutionRegistryFacts}. */
    @Override
    public Set<String> sessionsWithExecutionRegistryFacts(String tenantId,
            java.util.Collection<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Set.of();
        }
        Map<String, ExecutionFacts> facts = new HashMap<>();
        Set<String> pending = new HashSet<>(sessionIds);
        while (!pending.isEmpty()) {
            List<Object> arguments = new ArrayList<>();
            arguments.add(tenantId);
            arguments.addAll(pending);
            List<ExecutionFacts> rows =
                    jdbc.query(
                            "SELECT s.session_id, s.parent_session_id, s.workspace_id,"
                                + " s.workspace_generation, s.workspace_storage_id, CASE WHEN"
                                + " r.workspace_id IS NOT NULL AND a.actor_id IS NOT NULL THEN TRUE"
                                + " ELSE FALSE END AS creator_can_execute FROM ma_session s LEFT"
                                + " JOIN ma_workspace r ON r.tenant_id = s.tenant_id AND"
                                + " r.workspace_id = s.workspace_id AND r.workspace_generation ="
                                + " s.workspace_generation AND r.storage_id ="
                                + " s.workspace_storage_id AND r.state = 'ACTIVE' LEFT JOIN"
                                + " ma_workspace_access a ON a.tenant_id = r.tenant_id AND"
                                + " a.workspace_id = r.workspace_id AND a.actor_id ="
                                + " s.creator_actor_key AND a.role IN ('OPERATOR', 'OWNER') WHERE"
                                + " s.tenant_id = ? AND s.session_id IN ("
                                    + placeholders(pending.size())
                                    + ")",
                            (row, index) ->
                                    new ExecutionFacts(
                                            row.getString("session_id"),
                                            row.getString("parent_session_id"),
                                            row.getString("workspace_id"),
                                            (Long) row.getObject("workspace_generation"),
                                            row.getString("workspace_storage_id"),
                                            row.getBoolean("creator_can_execute")),
                            arguments.toArray());
            Set<String> queried = Set.copyOf(pending);
            pending.clear();
            for (ExecutionFacts row : rows) {
                facts.put(row.sessionId(), row);
            }
            for (ExecutionFacts row : rows) {
                if (row.parentId() != null && !facts.containsKey(row.parentId())
                        && !queried.contains(row.parentId())) {
                    pending.add(row.parentId());
                }
            }
        }
        Set<String> verified = new HashSet<>();
        for (String sessionId : sessionIds) {
            ExecutionFacts initial = facts.get(sessionId);
            if (initial == null || initial.workspaceId() == null || initial.storageId() == null
                    || initial.generation() == null) {
                continue;
            }
            Set<String> visited = new HashSet<>();
            ExecutionFacts current = initial;
            while (current != null && visited.add(current.sessionId())
                    && Objects.equals(initial.workspaceId(), current.workspaceId())
                    && Objects.equals(initial.generation(), current.generation())
                    && Objects.equals(initial.storageId(), current.storageId())) {
                if (current.parentId() == null) {
                    if (current.creatorCanExecute()) {
                        verified.add(sessionId);
                    }
                    break;
                }
                current = facts.get(current.parentId());
            }
        }
        return Set.copyOf(verified);
    }

    private record ExecutionFacts(String sessionId, String parentId, String workspaceId,
            Long generation, String storageId, boolean creatorCanExecute) {}

    private boolean hasOpenOperation(String tenantId, String sessionId) {
        return hasOpenOperation(tenantId, sessionId, null);
    }

    // Hook owners can outlive their Turn with an immutable worker context.
    // Only confirmed release permits changing that context's cwd/revision.
    private boolean hasRetainedRuntimeSession(String tenantId, String sessionId) {
        return !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session"
                + " WHERE tenant_id = ? AND harness_session_id = ?"
                + " AND session_state <> 'RELEASED' LIMIT 1", tenantId, sessionId).isEmpty();
    }

    // The bound later-Turn barrier: context-changing operations only —
    // pending command rows, permission-action operations and task cancels
    // (which stop one task and change no Session context) are excluded,
    // matching the recovery scan's own population.
    private boolean hasOpenExecutionOperation(String tenantId,
            String sessionId) {
        Integer operations = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_operation WHERE scope_key = ? AND"
                        + " target_key = ? AND operation_kind IN"
                        + " ('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE') AND state IN"
                        + " ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED', 'UNKNOWN')",
                Integer.class, ManagedSessionStore.sessionScopeKey(tenantId, sessionId), sessionOperationTarget(sessionId));
        return operations != null && operations > 0;
    }

    private boolean hasOpenOperation(String tenantId, String sessionId,
            String excludingOperationId) {
        Integer commands =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_request_receipt WHERE namespace ="
                            + " 'SESSION_COMMAND' AND tenant_key = ? AND tenant_id = ? AND"
                            + " session_id = ? AND state = 'PENDING'",
                        Integer.class,
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                tenantId),
                        tenantId,
                        sessionId);
        // A recovery_blocked task cancel is parked, not open (H4f): its
        // acceptance is reconciled from the task's committed record and
        // it must never hold the Session's lifecycle hostage meanwhile.
        Integer operations =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM"
                                + " ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND (state IN ('PENDING', 'RUNNING',"
                                + " 'UNKNOWN') OR state = 'RECOVERY_BLOCKED' AND operation_kind <>"
                                + " 'TASK_CANCEL') AND operation_id <> ?",
                        Integer.class,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys
                                .identity(
                                        excludingOperationId == null ? "" : excludingOperationId));
        return (commands != null && commands > 0)
                || (operations != null && operations > 0);
    }

    @Override
    public Optional<OperationRecord> findOperation(String tenantId,
            String sessionId, String operationId) {
        return findSessionOperation(tenantId, sessionId, operationId, false)
                .or(() -> findTurnCommandOperation(tenantId, sessionId,
                        operationId));
    }

    @Override
    public List<OperationTarget> findDeliverableOperations(long now,
            int limit) {
        now = lifecycleDatabaseTime();
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
                                    + " ma_operation.session_id AND private_scope.csi_guard ="
                                    + " FALSE) ORDER BY available_at LIMIT ?",
                                operationTargetMapper,
                                now,
                                limit));
        if (targets.size() < limit) {
            targets.addAll(
                    jdbc.query(
                            "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE') AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_until < " + ManagedSchemaTime.SQL_NOW + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.csi_guard = FALSE) ORDER BY claim_until LIMIT ?",
                            operationTargetMapper,
                            limit - targets.size()));
        }
        return List.copyOf(targets);
    }

    @Override
    @Transactional
    public Optional<OperationRecord> claimOperation(String tenantId,
            String sessionId, String operationId, String owner,
            Duration leaseDuration) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        requireLegacyMutation(tenantId, sessionId);
        long now = lifecycleDatabaseTime();
        int updated =
                jdbc.update(
                        "UPDATE ma_operation SET phase = 'RUNNING', state = 'RUNNING', delivery_state = 'LEASED', claim_owner = ?, claim_until = (" + ManagedSchemaTime.SQL_NOW + " + ?), claim_generation = claim_generation + 1, gmt_modified = ? WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
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
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
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

    @Override
    @Transactional
    public boolean completeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            boolean harnessConfirmed) {
        requireLegacyMutation(tenantId, sessionId);
        var target = findOperation(tenantId, sessionId, operationId).orElseThrow();
        if (WorkspaceToolProfiles.lifecycleProtocol(target.lifecycleProtocolVersion())) {
            WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
            ToolPublicationRetentionStore.lockTenant(jdbc, tenantId);
        }
        if (target.kind() == OperationKind.DELETE && !WorkspaceToolProfiles.lifecycleProtocol(target.lifecycleProtocolVersion())) {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenantId, sessionId);
        }
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        if (WorkspaceToolProfiles.lifecycleProtocol(target.lifecycleProtocolVersion()) && target.kind() == OperationKind.DELETE) {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenantId, sessionId);
        }
        OperationRecord operation = findSessionOperation(tenantId, sessionId, operationId, true)
                .orElseThrow(() -> new IllegalStateException("Session operation is unavailable"));
        Boolean leaseLive =
                jdbc.queryForObject(
                        "SELECT claim_until > " + ManagedSchemaTime.SQL_NOW + " FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ? FOR UPDATE",
                        Boolean.class,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
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
                throw WorkspaceLifecycleStore.blocked("workspace_close_identity_unverified");
            }
            lifecycle.verifyCompletion(operation);
        }
        long now = lifecycleDatabaseTime();
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
                        + SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ?",
                harnessConfirmed ? "HARNESS_CONFIRMED" : "JAVA_DURABLE",
                publicId("rcpt"),
                now,
                now,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId),
                tenantId,
                sessionId,
                operationId);
        appendEvent(tenantId, sessionId, null,
                completedEvent(operation.kind()),
                Map.of("sessionId", sessionId, "operationId", operationId),
                operation.kind() == OperationKind.DELETE,
                operationSource(operationId, "completed"), now);
        return true;
    }

    @Override
    @Transactional
    public boolean failOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        long now = lifecycleDatabaseTime();
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
                        + SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ? AND"
                        + " state = 'RUNNING' AND delivery_state = 'LEASED'"
                        + " AND claim_owner = ? AND claim_generation = ?"
                        + " AND claim_until > " + ManagedSchemaTime.SQL_NOW,
                failureCode, publicId("rcpt"), now, now,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId), tenantId, sessionId,
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

    private long lifecycleDatabaseTime() {
        return jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) ->
                        Math.addExact(
                                Math.multiplyExact(row.getLong(1), 1000), row.getLong(2) / 1000));
    }

    @Override
    @Transactional
    public boolean renewLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, Duration duration) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        requireLegacyMutation(tenantId, sessionId);
        long now = lifecycleDatabaseTime();
        int updated =
                jdbc.update(
                        "UPDATE ma_operation SET claim_until = (" + ManagedSchemaTime.SQL_NOW + " + ?), gmt_modified = ? WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        duration.toMillis(),
                        now,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
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

    private void syncLifecycleClaim(String tenantId, String sessionId, String operationId) {
        var rows =
                jdbc.queryForList(
                        "SELECT lifecycle_protocol_version, claim_generation, FLOOR(claim_until) AS claim_lease_until FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ?",
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
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

    @Override
    @Transactional
    public void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt) {
        blockLifecycleOperation(tenantId, sessionId, operationId, owner,
                generation, failureCode, availableAt, false);
    }

    @Override
    @Transactional
    public void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt,
            boolean budgetExempt) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        requireLegacyMutation(tenantId, sessionId);
        long now = lifecycleDatabaseTime();
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
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        failureCode,
                        Math.addExact(now, Math.max(0, availableAt - clock.millis())),
                        now,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
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

    @Override
    @Transactional
    public void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt) {
        retryOperation(tenantId, sessionId, operationId, owner,
                claimGeneration, availableAt, false);
    }

    @Override
    @Transactional
    public void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt, boolean budgetExempt) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        requireLegacyMutation(tenantId, sessionId);
        long delay = Math.max(0, availableAt - clock.millis());
        long now = lifecycleDatabaseTime();
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
                                + SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        availableAt,
                        now,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        sessionOperationTarget(sessionId),
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

    @Override
    @Transactional
    public void markOperationAnswered(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration) {
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId);
        requireLegacyMutation(tenantId, sessionId);
        long now = lifecycleDatabaseTime();
        // Watermark only: the row stays leased and no reschedule runs here —
        // the catch block's own retryOperation (or a throw losing it) decides
        // what happens next. The point is that the answered fact is durable
        // before any recovery read can throw it away (review round 14,
        // R14-3).
        jdbc.update(
                "UPDATE ma_operation SET budget_exempt_attempt ="
                    + " budget_exempt_attempt + 1, gmt_modified = ? WHERE scope_key = ? AND"
                    + " operation_kind IN "
                        + SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ? AND state = 'RUNNING' AND delivery_state ="
                        + " 'LEASED' AND claim_owner = ? AND claim_generation = ? AND"
                        + " claim_until > " + ManagedSchemaTime.SQL_NOW,
                now,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId),
                tenantId,
                sessionId,
                operationId,
                owner,
                claimGeneration);
    }

    public Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        ManagedReceipts.Receipt command = ManagedReceipts.command(jdbc,
                tenantId, operation, idempotencyKey, false);
        if (command == null) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key is already in use.");
        }
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ApiException(HttpStatus.CONFLICT,
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

    public Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey) {
        return findCommand(tenantId, operation, idempotencyKey, false);
    }

    private Optional<CommandRecord> findCommand(String tenantId,
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

    public Optional<SessionRecord> findSession(String tenantId,
            String sessionId) {
        List<SessionRecord> rows =
                jdbc.query(
                        SESSION_WITH_STREAM + " WHERE ma_session.session_kind = 'PUBLIC' AND"
                                + " ma_session.tenant_id = ? AND ma_session.session_id = ?",
                        sessionMapper,
                        tenantId,
                        sessionId);
        return rows.stream().findFirst();
    }

    public Optional<SessionRecord> findSessionById(String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                SESSION_WITH_STREAM + " WHERE ma_session.session_kind = 'PUBLIC' AND"
                        + " ma_session.session_id = ?",
                sessionMapper, sessionId);
        return rows.stream().findFirst();
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        arguments.add(actorId == null ? null
                : ManagedWorkspaceRegistry.actorKey(tenantId, actorId));
        // Keyset on the immutable gmt_create: gmt_modified moves on every
        // event append, so a row can slide backwards into already-visited
        // pages and silently vanish from a paged listing.
        String cursorClause = "";
        if (beforeCreatedAt != null && beforeSessionId != null) {
            cursorClause = " AND (ma_session.gmt_create < ? OR (ma_session.gmt_create = ?"
                    + " AND ma_session.session_id < ?))";
            arguments.add(beforeCreatedAt);
            arguments.add(beforeCreatedAt);
            arguments.add(beforeSessionId);
        }
        arguments.add(limit + 1);
        List<SessionRecord> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION.columns("ma_session") + ", COALESCE(es.last_sequence, 0) AS list_last_sequence,"
                            + " COALESCE(es.replay_floor_sequence, 0) AS list_floor_sequence FROM"
                            + " ma_session LEFT JOIN ma_event_stream es ON es.tenant_id ="
                            + " ma_session.tenant_id AND es.session_id = ma_session.session_id AND"
                            + " es.stream_kind = 'SESSION' AND es.stream_id = X'' WHERE"
                            + " ma_session.session_kind = 'PUBLIC' AND ma_session.tenant_id = ? AND"
                            + " ma_session.status <> 'DELETED' AND (ma_session.workspace_id IS NULL OR EXISTS (SELECT 1"
                            + " FROM ma_workspace_access wa WHERE wa.tenant_id ="
                            + " ma_session.tenant_id AND wa.workspace_id = ma_session.workspace_id"
                            + " AND wa.actor_id = ? AND wa.role IN ('READER', 'OPERATOR',"
                            + " 'OWNER')))"
                                + cursorClause
                                + " ORDER BY ma_session.gmt_create DESC, ma_session.session_id DESC"
                                + " LIMIT ?",
                        sessionListMapper,
                        arguments.toArray());
        boolean hasMore = rows.size() > limit;
        if (hasMore) {
            rows = new ArrayList<>(rows.subList(0, limit));
        }
        return new SessionPage(List.copyOf(rows), hasMore);
    }

    public Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT " + ManagedSchemaProjection.TURN.columns() + " FROM ma_turn WHERE tenant_id = ? AND"
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
                        + " FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id IN ("
                        + placeholders(sessionIds.size()) + ") AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') ORDER BY"
                        + " gmt_create DESC",
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
        List<TurnSummary> rows =
                jdbc.query(
                        "SELECT "
                                + QUALIFIED_TURN_SUMMARY_COLUMNS
                                + " FROM ma_turn turn_record JOIN (SELECT event.session_id,"
                                + " event.turn_id FROM ma_public_event event JOIN (SELECT"
                                + " accepted.session_id, MAX(accepted.sequence_id) AS max_sequence FROM"
                                + " ma_public_event accepted WHERE accepted.stream_kind = 'SESSION' AND accepted.stream_id ="
                                + " X'' AND accepted.tenant_id = ? AND accepted.session_id IN ("
                                + placeholders(sessionIds.size())
                                + ") AND accepted.event_type = 'turn.accepted' GROUP BY"
                                + " accepted.session_id) latest ON latest.session_id ="
                                + " event.session_id AND latest.max_sequence ="
                                + " event.sequence_id WHERE event.tenant_id = ?)"
                                + " latest_turn ON latest_turn.session_id ="
                                + " turn_record.session_id AND latest_turn.turn_id ="
                                + " turn_record.turn_id WHERE turn_record.tenant_id ="
                                + " ?",
                        turnSummaryMapper,
                        arguments.toArray());
        Map<String, TurnSummary> result = new HashMap<>(
                sessionIds.size() * 2);
        for (TurnSummary row : rows) {
            result.put(row.sessionId(), row);
        }
        return result;
    }

    @Override
    public Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds) {
        return ManagedExtensionRecordStore.findModelContexts(jdbc, tenantId, sessionIds);
    }

    @Override
    public List<WebShellModelOption> modelOptions() { return modelCatalog; }

    @Override
    public Map<String, WebShellModelSelection> findModelSelections(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        args.addAll(sessionIds);
        Map<String, WebShellModelSelection> result = new HashMap<>();
        jdbc.query("SELECT session_id, model_id, model_revision FROM ma_session WHERE tenant_id = ?"
                + " AND session_id IN (" + placeholders(sessionIds.size())
                + ") AND session_kind = 'PUBLIC' AND workspace_id IS NOT NULL AND model_id IS NOT NULL",
                row -> {
                    result.put(row.getString("session_id"), new WebShellModelSelection(
                            row.getString("model_id"), row.getLong("model_revision")));
                }, args.toArray());
        return result;
    }

    @Override
    public WebShellModelSelection findTurnModelSelection(String tenantId, String sessionId,
            String promptId) {
        var rows = jdbc.query("SELECT model_id, model_revision FROM ma_turn WHERE tenant_id = ?"
                + " AND session_id = ? AND prompt_id = ?", (row, index) -> row.getString("model_id") == null
                        ? null : new WebShellModelSelection(row.getString("model_id"),
                                row.getLong("model_revision")), tenantId, sessionId, promptId);
        if (rows.size() != 1) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_not_found", "The model snapshot Turn was not found");
        }
        return rows.getFirst();
    }

    @Override
    @Transactional
    public WebShellModelChangeResult changeSessionModel(String tenantId, String actorId,
            String sessionId, String key, String digest, String modelId, long expectedRevision,
            boolean supported) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "unsupported_feature",
                    "Model selection requires a Workspace Session");
        }
        WorkspaceAccess access = workspaces.accessOf(tenantId, actorId, session.workspace().getWorkspaceId());
        if (!access.canRead()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found");
        }
        String scope = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys
                .key("SET_MODEL", sessionId, actorId);
        var namespace = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_COMMAND;
        var scopeKind = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.ACTOR;
        ManagedReceipts.Receipt replay = ManagedReceipts.find(jdbc, namespace, tenantId,
                scopeKind, scope, key, false);
        if (replay != null) {
            if (!digest.equals(replay.requestDigest())
                    || !sessionId.equals(replay.sessionId())
                    || !"SET_MODEL".equals(replay.operation())
                    || !java.util.Arrays.equals(actorId.getBytes(StandardCharsets.UTF_8),
                            replay.actorKey())) {
                throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict",
                        "The idempotency key was reused with different content");
            }
            Map<String, Object> result = readMap(replay.resultJson());
            return new WebShellModelChangeResult(sessionId, new WebShellModelSelection(
                    (String) result.get("modelId"), ((Number) result.get("revision")).longValue()), true);
        }
        if (!access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "session_operation_forbidden",
                    "Only a Workspace operator may change the model");
        }
        if (!supported || modelCatalog.isEmpty() || !workspaceFilesEnabled) {
            throw new ApiException(HttpStatus.CONFLICT, "unsupported_feature", "Model selection is unavailable");
        }
        if (modelCatalog.stream().noneMatch(option -> option.modelId().equals(modelId))) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "unsupported_model", "The model is not published by this host");
        }
        requireIdlePolicyChange(session);
        long current = jdbc.queryForObject("SELECT model_revision FROM ma_session WHERE tenant_id = ?"
                + " AND session_id = ?", Long.class, tenantId, sessionId);
        if (current != expectedRevision || current >= 9_007_199_254_740_991L) {
            throw new ApiException(HttpStatus.CONFLICT, "model_selection_conflict", "The model revision changed");
        }
        long revision = current + 1;
        long now = clock.millis();
        jdbc.update("UPDATE ma_session SET model_id = ?, model_revision = ?, gmt_modified = ?,"
                + " version = version + 1 WHERE tenant_id = ? AND session_id = ? AND model_revision = ?",
                modelId, revision, now, tenantId, sessionId, current);
        ManagedReceipts.insert(jdbc, namespace, tenantId, scopeKind, scope, key, digest,
                "SET_MODEL", actorId.getBytes(StandardCharsets.UTF_8), sessionId, null,
                "COMPLETED", session.status(), true, now);
        jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?",
                writeJson(Map.of("modelId", modelId, "revision", revision)),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.receiptKey(
                        namespace, tenantId, scopeKind, scope, key));
        String sessionScope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String observation = ManagedExtensionProjection.recordKey(sessionId, "hosted_context_usage", "latest");
        jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                + " 'SESSION_RECORD' AND owner_key = ?", sessionScope, observation);
        jdbc.update("DELETE FROM ma_session_record WHERE session_scope_key = ? AND record_key = ?",
                sessionScope, observation);
        appendEvent(tenantId, sessionId, null, "session.model.changed",
                Map.of("modelId", modelId, "revision", revision), false, null, now);
        return new WebShellModelChangeResult(sessionId, new WebShellModelSelection(modelId, revision), false);
    }

    @Override
    public Map<String, WebShellApprovalSelection> findApprovalSelections(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        args.addAll(sessionIds);
        Map<String, WebShellApprovalSelection> result = new HashMap<>();
        jdbc.query("SELECT session_id, COALESCE(selected_approval_mode, approval_mode) AS mode,"
                        + " approval_revision, plan_enabled FROM ma_session WHERE tenant_id=? AND session_id IN ("
                        + placeholders(sessionIds.size()) + ") AND session_kind='PUBLIC'",
                row -> { result.put(row.getString("session_id"), new WebShellApprovalSelection(
                        row.getString("mode"), row.getLong("approval_revision"), row.getBoolean("plan_enabled"))); }, args.toArray());
        return result;
    }

    @Override
    public Set<String> findApprovalOwners(String tenantId, String actorId, List<String> sessionIds) {
        if (sessionIds.isEmpty() || actorId == null || actorId.isEmpty()) {
            return Set.of();
        }
        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        args.add(ManagedWorkspaceRegistry.actorKey(tenantId, actorId));
        args.addAll(sessionIds);
        return new HashSet<>(jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id=?"
                        + " AND COALESCE(owner_actor_key, creator_actor_key)=? AND session_id IN ("
                        + placeholders(sessionIds.size()) + ")", String.class, args.toArray()));
    }

    @Override
    public WebShellApprovalSelection findTurnApprovalSelection(String tenantId, String sessionId,
            String promptId) {
        var rows = jdbc.query("SELECT t.approval_mode, t.approval_revision, t.plan_enabled,"
                        + " s.approval_revision AS selected_revision, s.agent_id, s.agent_definition_digest,"
                        + " s.workspace_id, s.tool_profile FROM ma_turn t JOIN ma_session s"
                        + " ON s.tenant_id=t.tenant_id AND s.session_id=t.session_id"
                        + " WHERE t.tenant_id=? AND t.session_id=? AND t.prompt_id=?", (row, index) -> {
                    if (("qwen-code".equals(row.getString("agent_id"))
                            ? row.getString("agent_definition_digest") != null
                            : row.getString("agent_definition_digest") == null) || row.getString("workspace_id") == null
                            || !(WorkspaceToolProfiles.FILES.equals(row.getString("tool_profile"))
                            || WorkspaceToolProfiles.isPublicShell(row.getString("tool_profile")))) {
                        return null;
                    }
                    String mode = row.getString("approval_mode");
                    if (mode == null && row.getLong("selected_revision") != 0) {
                        throw new ApiException(HttpStatus.CONFLICT, "approval_snapshot_missing", "The Turn has no approval snapshot");
                    }
                    // Legacy prompt replays must preserve the original absence of a selection.
                    return mode == null ? null : new WebShellApprovalSelection(mode, row.getLong("approval_revision"),
                            row.getBoolean("plan_enabled"));
                }, tenantId, sessionId, promptId);
        if (rows.size() != 1) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_not_found", "The Turn was not found");
        }
        return rows.getFirst();
    }

    @Override
    @Transactional
    public WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported) {
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, null, false);
    }

    @Override
    @Transactional
    public WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean requestedPlanMode, boolean planModeSupported) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "unsupported_feature",
                    "Approval selection requires a Workspace Session");
        }
        WorkspaceAccess access = workspaces.accessOf(tenantId, actorId, session.workspace().getWorkspaceId());
        if (!access.canRead()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found");
        }
        if (!workspaces.isSessionOwner(tenantId, actorId, sessionId)
                || !access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "session_operation_forbidden",
                    "Only the Session owner with OPERATOR access may change approval policy");
        }
        String scope = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys
                .key("SET_APPROVAL", sessionId, actorId);
        var namespace = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_COMMAND;
        var scopeKind = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.ACTOR;
        ManagedReceipts.Receipt replay = ManagedReceipts.find(jdbc, namespace, tenantId,
                scopeKind, scope, key, false);
        if (replay != null) {
            if (!digest.equals(replay.requestDigest())
                    || !sessionId.equals(replay.sessionId())
                    || !"SET_APPROVAL".equals(replay.operation())
                    || !java.util.Arrays.equals(actorId.getBytes(StandardCharsets.UTF_8),
                            replay.actorKey())) {
                throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict",
                        "The idempotency key was reused with different content");
            }
            Map<String, Object> result = readMap(replay.resultJson());
            return new WebShellApprovalChangeResult(sessionId, (String) result.get("mode"),
                    ((Number) result.get("revision")).longValue(), true, Boolean.TRUE.equals(result.get("planMode")));
        }
        if (!supported || session.agentDefinitionDigest() != null && !agentDefinitionSupported
                || !workspaceFilesEnabled || !WorkspaceToolProfiles.supportsApprovalSelection(session)
                || WorkspaceToolProfiles.isPublicShell(session.toolProfile()) && !workspaceShellEnabled) {
            throw new ApiException(HttpStatus.CONFLICT, "unsupported_feature", "Approval selection is unavailable");
        }
        if (!WorkspaceToolProfiles.supportsApprovalMode(mode)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "unsupported_approval_mode", "The approval mode is unavailable");
        }
        boolean planMode = requestedPlanMode == null
                ? Boolean.TRUE.equals(jdbc.queryForObject("SELECT plan_enabled FROM ma_session WHERE tenant_id=? AND session_id=?",
                        Boolean.class, tenantId, sessionId)) : requestedPlanMode;
        if (planMode && (!planModeSupported || !supportsPlanMode(session))) {
            throw new ApiException(HttpStatus.CONFLICT, "unsupported_feature", "Plan mode is unavailable");
        }
        requireIdlePolicyChange(session);
        long current = jdbc.queryForObject("SELECT approval_revision FROM ma_session WHERE tenant_id = ?"
                + " AND session_id = ?", Long.class, tenantId, sessionId);
        if (current != expectedRevision || current >= 9_007_199_254_740_991L
                || planMode && current >= 9_007_199_254_740_990L) {
            throw new ApiException(HttpStatus.CONFLICT, "approval_selection_conflict", "The approval revision changed");
        }
        long revision = current + 1;
        long now = clock.millis();
        jdbc.update("UPDATE ma_session SET selected_approval_mode = ?, approval_revision = ?, plan_enabled = ?, gmt_modified = ?,"
                + " version = version + 1 WHERE tenant_id = ? AND session_id = ? AND approval_revision = ?",
                mode, revision, planMode, now, tenantId, sessionId, current);
        ManagedReceipts.insert(jdbc, namespace, tenantId, scopeKind, scope, key, digest,
                "SET_APPROVAL", actorId.getBytes(StandardCharsets.UTF_8), sessionId, null,
                "COMPLETED", session.status(), true, now);
        jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?",
                writeJson(Map.of("mode", mode, "revision", revision, "planMode", planMode)),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.receiptKey(
                        namespace, tenantId, scopeKind, scope, key));
        appendEvent(tenantId, sessionId, null, "session.approval.changed",
                Map.of("mode", mode, "revision", revision, "planMode", planMode), false, null, now);
        return new WebShellApprovalChangeResult(sessionId, mode, revision, false, planMode);
    }

    private void requireIdlePolicyChange(SessionRecord session) {
        String tenantId = session.tenantId();
        String sessionId = session.sessionId();
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, session.workspace().getStorageId());
        requireSessionStatus(session.status(), "ACTIVE");
        requireCwdChangeRegistryFacts(session);
        if (hasActiveTurn(tenantId, sessionId) || hasDecidableAction(session)) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_active", "The Session has an active Turn or approval");
        }
        if (hasOpenOperation(tenantId, sessionId) || hasPendingRenameDelivery(tenantId, sessionId)
                || hasRetainedRuntimeSession(tenantId, sessionId)
                || !jdbc.queryForList("SELECT 1 FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND status = 'RECOVERY_BLOCKED' LIMIT 1", tenantId, sessionId).isEmpty()
                || !jdbc.queryForList("SELECT 1 FROM ma_session_head WHERE tenant_id = ?"
                        + " AND session_id = ? AND head_kind = 'MANAGED_SESSION' AND"
                        + " (state <> 'ACTIVE' OR recovery_status <> 'READY')", tenantId, sessionId).isEmpty()) {
            throw new ApiException(HttpStatus.CONFLICT, "session_context_busy", "The Session requires settlement");
        }
    }

    // Reads leave the Turn's input out; the public view never shows it.
    @Override
    public TurnPage listTurns(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTurnId, int limit) {
        List<Object> arguments = new ArrayList<>(List.of(tenantId,
                sessionId));
        String before = "";
        if (beforeCreatedAt != null) {
            before = " AND (gmt_create < ? OR (gmt_create = ? AND"
                    + " turn_id < ?))";
            arguments.add(beforeCreatedAt);
            arguments.add(beforeCreatedAt);
            arguments.add(beforeTurnId);
        }
        arguments.add(limit + 1);
        List<TurnSummary> rows = jdbc.query("SELECT " + TURN_SUMMARY_COLUMNS
                        + " FROM ma_turn WHERE tenant_id = ? AND"
                        + " session_id = ?" + before + " ORDER BY gmt_create"
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
                        + " ma_turn WHERE tenant_id = ? AND"
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
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id = X''"
                    + " AND tenant_id = ? AND session_id = ? AND sequence_id > ? ORDER BY"
                    + " sequence_id ASC LIMIT ?",
                eventMapper,
                tenantId,
                sessionId,
                afterSequence,
                limit);
    }

    /**
     * The latest environment event of each Session's latest Turn, in one round trip; the Turns are
     * already loaded, so the turn-row join of the single-session read is implied.
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
            // Bound as identity bytes: H2 types row-comparison parameters
            // as VARCHAR, and a command it recompiles after binding (any
            // new session or SET in between) refuses VARBINARY rows against
            // VARCHAR ones. Bytes compare the same on MySQL and MariaDB.
            arguments.add(ManagedSchemaKeys.identity(turn.sessionId()));
            arguments.add(ManagedSchemaKeys.identity(turn.turnId()));
        }
        arguments.add(tenantId);
        // One row per session: the latest environment event of its latest
        // Turn, selected in SQL instead of shipping every match per pair.
        List<EventRecord> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns("event") + " FROM ma_public_event event JOIN (SELECT environment.session_id,"
                            + " MAX(environment.sequence_id) AS max_sequence FROM ma_public_event environment WHERE"
                            + " environment.stream_kind = 'SESSION' AND environment.stream_id = X'' AND environment.tenant_id = ? AND"
                            + " environment.event_type IN ('environment.provisioning', 'environment.ready',"
                            + " 'environment.failed') AND (environment.session_id, environment.turn_id) IN ("
                                + pairs
                                + ") GROUP BY environment.session_id) latest ON latest.session_id ="
                                + " event.session_id AND latest.max_sequence = event.sequence_id"
                                + " WHERE event.stream_kind = 'SESSION' AND event.stream_id = X''"
                                + " AND event.tenant_id = ?",
                        eventMapper,
                        arguments.toArray());
        Map<String, EventRecord> result = new HashMap<>(latestTurns.size() * 2);
        for (EventRecord row : rows) {
            result.put(row.sessionId(), row);
        }
        return result;
    }

    public List<EventRecord> findControlEvents(String tenantId,
            String sessionId, long throughSequence) {
        requireSession(tenantId, sessionId);
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id = X''"
                    + " AND tenant_id = ? AND session_id = ? AND sequence_id <= ? AND event_type"
                    + " NOT IN ('turn.accepted', 'item.output_text.delta', 'item.reasoning.delta',"
                    + " 'item.tool_call.updated', 'item.tool_result.updated') ORDER BY sequence_id"
                    + " ASC",
                eventMapper,
                tenantId,
                sessionId,
                throughSequence);
    }

    public EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit) {
        requireSession(tenantId, sessionId);
        List<EventRecord> rows =
                beforeSequence == null
                        ? jdbc.query(
                                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                                    + " stream_id = X'' AND tenant_id = ? AND session_id = ? ORDER"
                                    + " BY sequence_id DESC LIMIT ?",
                                eventMapper,
                                tenantId,
                                sessionId,
                                limit + 1)
                        : jdbc.query(
                                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                                    + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND"
                                    + " sequence_id < ? ORDER BY sequence_id DESC LIMIT ?",
                                eventMapper,
                                tenantId,
                                sessionId,
                                beforeSequence,
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
        return snapshots.latest(tenantId, sessionId);
    }

    @Override
    public StoreModels.SnapshotPage findSnapshotPage(String tenantId, String sessionId,
            String cursor, long afterSequence, int limit) {
        requireSession(tenantId, sessionId);
        ManagedSnapshotStore.Page page = snapshots.page(tenantId, sessionId, cursor, afterSequence, limit);
        return new StoreModels.SnapshotPage(page.items(), page.hasMore(), page.nextCursor(), page.coveredSequence());
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
        jdbc.query(
                "SELECT s.session_id, p.covered_sequence FROM ma_event_stream s JOIN ma_snapshot p"
                    + " ON p.tenant_id = s.tenant_id AND p.session_id = s.session_id AND"
                    + " p.snapshot_id = s.current_snapshot_id WHERE s.stream_kind = 'SESSION' AND"
                    + " s.stream_id = X'' AND s.tenant_id = ? AND s.session_id IN ("
                        + placeholders(sessionIds.size())
                        + ")",
                reader,
                arguments.toArray());
        return result;
    }

    public ReplayWindow findReplayWindow(String tenantId, String sessionId) {
        List<ReplayWindow> rows =
                jdbc.query(
                        "SELECT s.replay_floor_sequence, p.covered_sequence FROM ma_event_stream s"
                            + " LEFT JOIN ma_snapshot p ON p.tenant_id = s.tenant_id AND"
                            + " p.session_id = s.session_id AND p.snapshot_id ="
                            + " s.current_snapshot_id WHERE s.tenant_id = ? AND s.session_id = ?"
                            + " AND s.stream_kind = 'SESSION' AND s.stream_id = X''",
                        (result, row) ->
                                new ReplayWindow(
                                        result.getLong("replay_floor_sequence"),
                                        result.getLong("covered_sequence")),
                        tenantId,
                        sessionId);
        if (rows.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                    "The Session was not found.");
        }
        return rows.getFirst();
    }

    public List<ReplayFloorTarget> findReplayFloorTargets(int limit) {
        return jdbc.query(
                "SELECT s.tenant_id, s.session_id FROM ma_event_stream s JOIN ma_snapshot p ON p.tenant_id = s.tenant_id AND p.session_id = s.session_id AND p.snapshot_id = s.current_snapshot_id WHERE s.stream_kind = 'SESSION' AND s.stream_id = X'' AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = s.tenant_id AND private_scope.session_id = s.session_id AND private_scope.csi_guard = FALSE) AND p.covered_sequence > s.replay_floor_sequence AND NOT EXISTS (SELECT 1 FROM ma_snapshot older WHERE older.tenant_id = s.tenant_id AND older.session_id = s.session_id AND older.state = 'PUBLISHED' AND older.retain_until > ? AND older.covered_sequence <= s.replay_floor_sequence) AND NOT EXISTS (SELECT 1 FROM ma_turn t JOIN ma_public_event e ON e.tenant_id = t.tenant_id AND e.session_id = t.session_id AND e.turn_id = t.turn_id WHERE t.tenant_id = s.tenant_id AND t.session_id = s.session_id AND t.status IN ('ACCEPTED', 'RUNNING', 'CANCELLING') AND e.stream_kind = 'SESSION' AND e.stream_id = X'' AND e.event_type = 'turn.accepted' AND e.sequence_id <= s.replay_floor_sequence + 1) ORDER BY s.gmt_modified ASC LIMIT ?",
                (row, index) ->
                        new ReplayFloorTarget(
                                row.getString("tenant_id"), row.getString("session_id")),
                clock.millis(),
                limit);
    }

    /**
     * Raises the replay floor, never above the Snapshot's covered sequence, so that a client told
     * to resync can resume from the Snapshot. Nothing prunes events yet; the retention work will
     * call this before pruning.
     */
    @Transactional
    public ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence) {
        requireLegacySessionForUpdate(tenantId, sessionId);
        ReplayWindow window = findReplayWindow(tenantId, sessionId);
        Long protectedSequence =
                jdbc.queryForObject(
                        "SELECT MIN(covered_sequence) FROM ma_snapshot WHERE tenant_id = ? AND"
                            + " session_id = ? AND state = 'PUBLISHED' AND retain_until > ?",
                        Long.class,
                        tenantId,
                        sessionId,
                        clock.millis());
        long floor = Math.min(floorSequence, window.snapshotThroughSequence());
        if (protectedSequence != null) {
            floor = Math.min(floor, protectedSequence);
        }
        Long activeStart =
                jdbc.queryForObject(
                        "SELECT MIN(e.sequence_id) FROM ma_public_event e JOIN ma_turn t ON"
                            + " t.tenant_id = e.tenant_id AND t.session_id = e.session_id AND"
                            + " t.turn_id = e.turn_id WHERE e.tenant_id = ? AND e.session_id = ?"
                            + " AND e.stream_kind = 'SESSION' AND e.stream_id = X'' AND"
                            + " e.event_type = 'turn.accepted' AND t.status IN ('ACCEPTED',"
                            + " 'RUNNING', 'CANCELLING')",
                        Long.class,
                        tenantId,
                        sessionId);
        if (activeStart != null) {
            floor = Math.min(floor, Math.max(0, activeStart - 1));
        }
        if (floor <= window.floorSequence()) {
            return window;
        }
        jdbc.update(
                "UPDATE ma_event_stream SET replay_floor_sequence = ? WHERE tenant_id = ? AND"
                    + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                floor,
                tenantId,
                sessionId);
        return new ReplayWindow(floor, window.snapshotThroughSequence());
    }

    public List<MaterializationTarget> findMaterializationTargets(int limit) {
        // The second disjunct re-selects a session whose drained batch
        // deferred the snapshot rewrite, once the deferral marker is old
        // enough; without it a caught-up idle session would stay stale
        // forever.
        return jdbc.query(
                "SELECT s.tenant_id, s.session_id FROM ma_session s JOIN ma_event_stream p ON p.tenant_id = s.tenant_id AND p.session_id = s.session_id AND p.stream_kind = 'SESSION' AND p.stream_id = X'' WHERE s.session_kind = 'PUBLIC' AND s.csi_guard = FALSE AND s.retired_at IS NULL AND s.status <> 'DELETED' AND p.projection_pending = TRUE AND (p.last_sequence > p.covered_sequence OR (p.snapshot_stale_since IS NOT NULL AND p.snapshot_stale_since <= ?)) ORDER BY p.gmt_modified ASC LIMIT ?",
                (result, row) ->
                        new MaterializationTarget(
                                result.getString("tenant_id"), result.getString("session_id")),
                clock.millis() - SNAPSHOT_REFRESH_MILLIS,
                limit);
    }

    @Transactional
    public MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit) {
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        Long covered = jdbc.queryForObject(
                        "SELECT covered_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                            + " UPDATE",
                Long.class, tenantId, sessionId);
        if (covered == null) {
            throw new IllegalStateException(
                    "Message projection progress is unavailable");
        }
        List<EventRecord> events =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id"
                            + " = X'' AND tenant_id = ? AND session_id = ? AND sequence_id > ?"
                            + " ORDER BY sequence_id ASC LIMIT ?",
                        eventMapper,
                        tenantId,
                        sessionId,
                        covered,
                        limit);
        if (events.isEmpty()) {
            if (snapshotRefreshRequired(tenantId, sessionId, covered, clock.millis(), false)) {
                snapshots.afterCommit(tenantId, sessionId);
            }
            return new MaterializationResult(false, covered);
        }
        long expected = covered + 1;
        Map<String, List<ItemPartRecord>> projectedParts = new LinkedHashMap<>();
        for (EventRecord event : events) {
            if (event.sequence() != expected) {
                // A gap is permanent: appendEvent allocates a sequence under
                // the session row lock this method already holds, so no
                // missing sequence can still appear. Skipping ahead once
                // beats throwing on every scan and wedging the projection.
                LOG.error("Message projection skips a permanent event gap"
                                + " tenant={} session={} missingSequences={}-{}"
                                + " nextEvent={}",
                        tenantId, sessionId, expected, event.sequence() - 1,
                        event.sequence());
                // The skipped range may have carried a turn's terminal
                // event, whose settle is the only write that moves its
                // items off in_progress. Settle those turns' items here, or
                // they would be pinned forever — but only for a turn that is
                // provably over: its terminal event is in the journal (its
                // own materialization settled it already, making this a
                // no-op guard) or its row is not live. A turn whose row is
                // still live (recordHarnessEvents flips it in the same
                // transaction that appends the terminal event, so a live row
                // means the terminal event can still arrive) is settled by
                // its own event or by turn recovery's turn.failed — never
                // here. The remaining guards mirror settleTurnItems (never
                // re-settle a completed item, never push last_sequence
                // backwards).
                jdbc.update("UPDATE ma_message SET item_status ="
                                + " 'failed', last_sequence = CASE WHEN"
                                + " last_sequence < ? THEN ? ELSE"
                                + " last_sequence END, gmt_modified = ?,"
                                + " revision = revision + 1 WHERE tenant_id"
                                + " = ? AND session_id = ? AND item_status"
                                + " = 'in_progress' AND last_sequence < ?"
                                + " AND NOT EXISTS (SELECT 1 FROM"
                                + " ma_public_event terminal WHERE"
                                + " terminal.stream_kind = 'SESSION' AND"
                                + " terminal.stream_id = X'' AND"
                                + " terminal.tenant_id ="
                                + " ma_message.tenant_id AND"
                                + " terminal.session_id ="
                                + " ma_message.session_id AND"
                                + " terminal.turn_id ="
                                + " ma_message.turn_id AND"
                                + " terminal.event_type IN"
                                + " ('turn.completed', 'turn.failed',"
                                + " 'turn.cancelled'))"
                                + " AND NOT EXISTS (SELECT 1 FROM"
                                + " ma_turn live WHERE"
                                + " live.tenant_id ="
                                + " ma_message.tenant_id AND"
                                + " live.session_id ="
                                + " ma_message.session_id AND"
                                + " live.turn_id ="
                                + " ma_message.turn_id AND"
                                + " live.status IN ('ACCEPTED', 'RUNNING',"
                                + " 'CANCELLING'))",
                        event.sequence() - 1, event.sequence() - 1,
                        clock.millis(), tenantId, sessionId,
                        event.sequence());
            }
            materializeEvent(event, projectedParts);
            expected = event.sequence() + 1;
        }
        flushParts(tenantId, sessionId, projectedParts);
        long nextCovered = events.get(events.size() - 1).sequence();
        long now = clock.millis();
        boolean refresh = snapshotRefreshRequired(tenantId, sessionId, nextCovered, now,
                events.stream().anyMatch(EventRecord::terminal));
        jdbc.update(
                "UPDATE ma_event_stream SET covered_sequence = ?, gmt_modified = ?,"
                    + " snapshot_stale_since = COALESCE(snapshot_stale_since, ?) WHERE tenant_id ="
                    + " ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                nextCovered,
                now,
                now,
                tenantId,
                sessionId);
        if (refresh) {
            snapshots.afterCommit(tenantId, sessionId);
        }
        return new MaterializationResult(true, nextCovered);
    }

    @Override
    @Transactional
    public void deferMaterializationTarget(String tenantId,
            String sessionId) {
        requireLegacyMutation(tenantId, sessionId);
        jdbc.update("UPDATE ma_event_stream SET gmt_modified = ? WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                clock.millis(), tenantId, sessionId);
    }

    public List<DispatchTarget> findDispatchable(long now, int limit) {
        // #14387: a Turn marked recovery-blocked (its workflow's Harness
        // generation was lost) is parked, never re-dispatched — without
        // the carve-out the sweep would claim → refuse → release it once
        // per tick forever. A cancel still scans it: settling the Turn
        // cancelled is the cancel's own act, not a re-dispatch.
        return jdbc.query(
                "SELECT tenant_id, session_id, turn_id FROM ma_turn WHERE status IN ('ACCEPTED', 'RUNNING', 'CANCELLING') AND (dispatch_lease_until IS NULL OR dispatch_lease_until < ?) AND (retry_after IS NULL OR retry_after <= ?) AND (status = 'CANCELLING' OR error_code IS NULL OR error_code <> '" + AgentStateStore.WORKFLOW_RECOVERY_BLOCKED + "') AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_turn.tenant_id AND private_scope.session_id = ma_turn.session_id AND private_scope.csi_guard = FALSE) ORDER BY gmt_modified ASC LIMIT ?",
                (result, row) -> new DispatchTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("turn_id")), now, now, limit);
    }

    @Transactional
    public Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET"
                        + " dispatch_owner = ?, dispatch_lease_until = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
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

    @Transactional
    public boolean renewTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        return jdbc.update("UPDATE ma_turn SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", dispatch_lease_until = ?, version = version + 1 WHERE tenant_id = ? AND session_id = ? AND turn_id = ? AND dispatch_owner = ? AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING') AND dispatch_lease_until >= ?",
                now + leaseDuration.toMillis(), tenantId, sessionId, turnId,
                owner, now) == 1;
    }

    @Transactional
    public void releaseTurnLease(String tenantId, String sessionId,
            String turnId, String owner) {
        requireLegacyMutation(tenantId, sessionId);
        jdbc.update("UPDATE ma_turn SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                tenantId, sessionId, turnId, owner);
    }

    @Override
    @Transactional
    public boolean markTurnRecoveryBlocked(String tenantId,
            String sessionId, String turnId, String owner,
            String errorCode, String errorMessage) {
        requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        // The verdict parks the Turn out of the dispatch sweep, so it is
        // fenced by the live dispatch lease like every terminal decision:
        // an owner whose lease already expired holds nothing to park with.
        return jdbc.update("UPDATE ma_turn SET error_code = ?,"
                        + " error_message = ?, dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until >= ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING',"
                        + " 'CANCELLING')",
                errorCode, errorMessage, now, tenantId, sessionId, turnId,
                owner, now) == 1;
    }

    @Override
    @Transactional
    public void deferTurnRetry(String tenantId, String sessionId,
            String turnId, String owner, long retryAfter) {
        scheduleTurnRetry(tenantId, sessionId, turnId, owner, retryAfter,
                false);
    }

    @Transactional
    public void scheduleTurnRetry(String tenantId, String sessionId,
            String turnId, String owner, long retryAfter,
            boolean budgetExempt) {
        requireLegacyMutation(tenantId, sessionId);
        jdbc.update("UPDATE ma_turn SET retry_count = retry_count"
                        + " + 1, consecutive_failures = consecutive_failures"
                        + " + 1, budget_exempt_failures ="
                        + " budget_exempt_failures + ?, retry_after = ?,"
                        + " dispatch_owner = NULL, dispatch_lease_until ="
                        + " NULL, gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ? AND turn_id = ?"
                        + " AND dispatch_owner = ? AND status IN ('ACCEPTED',"
                        + " 'RUNNING', 'CANCELLING')",
                budgetExempt ? 1 : 0, retryAfter, clock.millis(), tenantId,
                sessionId, turnId, owner);
    }

    @Transactional
    public boolean bindHarness(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId) {
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
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
        jdbc.update("UPDATE ma_session SET harness_boot_id = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                harnessBootId, now, tenantId, sessionId);
        return true;
    }

    @Transactional
    public boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId) {
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
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
        int updated = jdbc.update("UPDATE ma_session SET"
                        + " harness_boot_id = ?, gmt_modified = ?, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ? AND harness_boot_id = ?",
                harnessBootId, now, tenantId, sessionId,
                expectedHarnessBootId);
        return updated == 1;
    }

    @Transactional
    public void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner) {
        requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET"
                        + " submission_attempted = TRUE, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND harness_event_epoch IS NULL",
                now, tenantId, sessionId, turnId, owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    /**
     * G3: back out a submission mark whose attempt carries no event epoch, so a new Harness
     * generation may bind and re-submit. A null epoch only proves the admission REPLY never landed:
     * a settled old-generation admission replays idempotently on the journal's commandId when the
     * Turn re-submits, while one still unsettled answers the resubmit with the coded
     * duplicate-admission 409 — the caller adopts the attach's epoch and streams instead of
     * withdrawing again (R10-4). Refuses under the same lease guards as the mark.
     */
    @Transactional
    public boolean withdrawSubmissionAttempted(String tenantId,
            String sessionId, String turnId, String owner) {
        requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET"
                        + " submission_attempted = FALSE, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND submission_attempted = TRUE AND"
                        + " harness_event_epoch IS NULL AND status IN"
                        + " ('ACCEPTED','RUNNING','CANCELLING')",
                now, tenantId, sessionId, turnId, owner, now);
        return updated == 1;
    }

    @Transactional
    public void recordAdmission(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastEventId) {
        // Lock the session row before the turn row: every writer must take
        // the two in this order or InnoDB deadlocks against the
        // session-first paths (e.g. insertCancelCommand).
        requireLegacySessionForUpdate(tenantId, sessionId);
        long now = clock.millis();
        // The admission proves coordination made progress, so the retry
        // budget restarts: it counts consecutive failures without progress.
        // retry_count is not reset — it paces the backoff, which must keep
        // growing across a crash loop that keeps making progress (review
        // round 8, R8-3).
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " CASE WHEN status = 'CANCELLING' THEN status ELSE"
                        + " 'RUNNING' END, harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, consecutive_failures = 0,"
                        + " budget_exempt_failures = 0,"
                        + " gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastEventId, now, tenantId, sessionId, turnId,
                owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        int sessionUpdated = jdbc.update("UPDATE ma_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, gmt_modified = ?,"
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
        settleTurnCommands(tenantId, sessionId, turnId, now);
    }

    @Transactional
    public void recordRecoveryAdmission(String tenantId, String sessionId,
            String turnId, String owner, String expectedTurnEventEpoch,
            String expectedSessionEventEpoch, String eventEpoch,
            long lastEventId) {
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
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
                || !Objects.equals(expectedTurnEventEpoch,
                        turn.harnessEventEpoch())
                || !Objects.equals(expectedSessionEventEpoch,
                        session.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness recovery epoch changed");
        }
        // The recovery admission proves coordination made progress, so the
        // retry budget restarts: it counts consecutive failures without
        // progress. retry_count is not reset — it paces the backoff (review
        // round 8, R8-3).
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " CASE WHEN status = 'CANCELLING' THEN status ELSE"
                        + " 'RUNNING' END, harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, consecutive_failures = 0,"
                        + " budget_exempt_failures = 0,"
                        + " gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND (harness_event_epoch = ? OR"
                        + " (harness_event_epoch IS NULL AND ? IS NULL))",
                eventEpoch, lastEventId, now, tenantId, sessionId, turnId,
                owner, now, expectedTurnEventEpoch, expectedTurnEventEpoch);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        int sessionUpdated = jdbc.update("UPDATE ma_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND (harness_event_epoch = ? OR"
                        + " (harness_event_epoch IS NULL AND ? IS NULL))",
                eventEpoch, lastEventId, now, tenantId, sessionId,
                expectedSessionEventEpoch, expectedSessionEventEpoch);
        if (sessionUpdated != 1) {
            throw new IllegalStateException(
                    "Hosted Harness recovery epoch changed");
        }
        settleTurnCommands(tenantId, sessionId, turnId, now);
    }

    @Transactional
    public void retractContinuationOutput(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId,
            String eventEpoch) {
        requireLegacySessionForUpdate(tenantId, sessionId);
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
                        + " ma_event_stream WHERE tenant_id"
                        + " = ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''"
                        + " FOR UPDATE",
                Long.class, tenantId, sessionId);
        List<EventRecord> deltas =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id"
                            + " = X'' AND tenant_id = ? AND session_id = ? AND turn_id = ? AND"
                            + " event_type IN ('item.output_text.delta', 'item.reasoning.delta')"
                            + " ORDER BY sequence_id ASC",
                        eventMapper,
                        tenantId,
                        sessionId,
                        turnId);
        long firstRetracted = Long.MAX_VALUE;
        for (EventRecord event : deltas) {
            if (event.sourceKey() == null
                    || !event.sourceKey().startsWith(sourcePrefix)) {
                continue;
            }
            Map<String, Object> data = new LinkedHashMap<>(event.data());
            data.put("text", "");
            jdbc.update(
                    "UPDATE ma_public_event SET data_json = ? WHERE tenant_id = ? AND session_id ="
                        + " ? AND stream_kind = 'SESSION' AND stream_id = X'' AND sequence_id = ?",
                    writeJson(data),
                    tenantId,
                    sessionId,
                    event.sequence());
            firstRetracted = Math.min(firstRetracted, event.sequence());
        }
        if (firstRetracted != Long.MAX_VALUE) {
            reassignIdentity(tenantId, sessionId, firstRetracted);
        }
        rebuildTurnText(tenantId, sessionId, turnId, now);
        appendEvent(tenantId, sessionId, turnId, "stream.reconciled", Map.of(),
                false, reconciliationKey, now);
    }

    /**
     * In-band sibling of {@link #retractContinuationOutput} (#13319): a restarted model attempt on
     * the live Harness retracts the published prefix of the message it replaces. The range is keyed
     * by the journal sequence of the message's first delta, which the Harness reports as {@code
     * fromSourceId}; only deltas of the current in-flight message carry source ids at or after it,
     * so earlier committed rounds stay. The cursor advances past the retraction event in the same
     * transaction whether or not the retraction applied, so a crash cannot re-deliver it.
     */
    @Transactional
    public void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId) {
        retractHarnessTurnOutput(tenantId, sessionId, turnId, owner, eventEpoch,
                fromSourceId, retractionSourceId, null, null, null);
    }

    @Transactional
    public void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId, String sourceBootId,
            String sourceEventEpoch, Long throughSourceId) {
        requireLegacyMutation(tenantId, sessionId);
        boolean bounded = throughSourceId != null;
        if (bounded && (sourceBootId == null || sourceEventEpoch == null
                || fromSourceId < 1 || throughSourceId < fromSourceId || throughSourceId >= retractionSourceId)) {
            throw new IllegalArgumentException("Invalid bounded Hosted retraction");
        }
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
        String sourcePrefix = (bounded ? sourceBootId : session.harnessBootId()) + ":"
                + (bounded ? sourceEventEpoch : eventEpoch) + ":";
        String reconciliationKey = "reconcile:inband:" + sourcePrefix + turnId
                + ":" + fromSourceId + (bounded ? ":" + throughSourceId : "");
        if (!hasSourceEvent(tenantId, sessionId, reconciliationKey)) {
            jdbc.queryForObject(
                    "SELECT covered_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                        + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                        + " UPDATE",
                    Long.class,
                    tenantId,
                    sessionId);
            List<EventRecord> deltas =
                    jdbc.query(
                            "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                                + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND"
                                + " turn_id = ? AND event_type IN ('item.output_text.delta',"
                                + " 'item.reasoning.delta') ORDER BY sequence_id ASC",
                            eventMapper,
                            tenantId,
                            sessionId,
                            turnId);
            long firstRetracted = Long.MAX_VALUE;
            for (EventRecord event : deltas) {
                if (event.sourceKey() == null
                        || (!bounded && !event.sourceKey().startsWith(sourcePrefix))
                        || sourceIdOf(event.sourceKey()) < fromSourceId
                        || (bounded && sourceIdOf(event.sourceKey()) > throughSourceId)) {
                    continue;
                }
                Map<String, Object> data = new LinkedHashMap<>(event.data());
                data.put("text", "");
                jdbc.update(
                        "UPDATE ma_public_event SET data_json = ? WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' AND"
                            + " sequence_id = ?",
                        writeJson(data),
                        tenantId,
                        sessionId,
                        event.sequence());
                firstRetracted = Math.min(firstRetracted, event.sequence());
            }
            if (firstRetracted != Long.MAX_VALUE) {
                reassignIdentity(tenantId, sessionId, firstRetracted);
            }
            rebuildTurnText(tenantId, sessionId, turnId, now);
            appendEvent(
                    tenantId,
                    sessionId,
                    turnId,
                    "stream.reconciled",
                    Map.of(),
                    false,
                    reconciliationKey,
                    now);
        }
        int updated = updateHarnessCursor(tenantId, sessionId, turnId, owner,
                eventEpoch, retractionSourceId, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    private void rebuildTurnText(String tenantId, String sessionId, String turnId, long now) {
        Long covered =
                jdbc.queryForObject(
                        "SELECT covered_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                            + " UPDATE",
                        Long.class,
                        tenantId,
                        sessionId);
        Map<String, List<ItemPartRecord>> parts = new LinkedHashMap<>();
        jdbc.query(
                "SELECT item_id, parts_json, body_resource_key FROM ma_message WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ? AND item_role = 'assistant' AND"
                        + " item_type = 'message' FOR UPDATE",
                (org.springframework.jdbc.core.RowCallbackHandler)
                        row -> {
                            var retained =
                                    new ArrayList<>(
                                            readParts(
                                                    row.getString("parts_json"),
                                                    row.getString("body_resource_key"),
                                                    tenantId,
                                                    sessionId));
                            retained.removeIf(
                                    part ->
                                            "output_text".equals(part.type())
                                                    || "reasoning".equals(part.type()));
                            parts.put(row.getString("item_id"), retained);
                        },
                tenantId,
                sessionId,
                turnId);
        List<EventRecord> events =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE tenant_id = ? AND session_id = ? AND"
                                + " stream_kind = 'SESSION' AND stream_id = X'' AND turn_id = ? AND"
                                + " sequence_id <= ? AND event_type IN ('item.output_text.delta',"
                                + " 'item.reasoning.delta', 'turn.completed', 'turn.failed',"
                                + " 'turn.cancelled') ORDER BY sequence_id",
                        eventMapper,
                        tenantId,
                        sessionId,
                        turnId,
                        covered);
        EventRecord terminal = null;
        for (EventRecord event : events) {
            if (List.of("turn.completed", "turn.failed", "turn.cancelled").contains(event.type())) {
                terminal = event;
            } else {
                materializeText(
                        event,
                        "item.reasoning.delta".equals(event.type()) ? "reasoning" : "output_text",
                        parts);
            }
        }
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        var iterator = parts.entrySet().iterator();
        while (iterator.hasNext()) {
            var entry = iterator.next();
            List<ItemPartRecord> retained = entry.getValue();
            if (retained.isEmpty()) {
                ManagedProjectionResourceCollector.release(jdbc, scope, "MESSAGE",
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(scope, entry.getKey()));
                jdbc.update(
                        "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                                + " 'MESSAGE' AND owner_key = ?",
                        scope,
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                scope, entry.getKey()));
                jdbc.update(
                        "DELETE FROM ma_message WHERE tenant_id = ? AND session_id = ? AND item_id"
                                + " = ?",
                        tenantId,
                        sessionId,
                        entry.getKey());
                iterator.remove();
                continue;
            }
            long first =
                    retained.stream().mapToLong(ItemPartRecord::firstSequence).min().orElseThrow();
            long last =
                    retained.stream().mapToLong(ItemPartRecord::lastSequence).max().orElseThrow();
            long created =
                    retained.stream().mapToLong(ItemPartRecord::createdAt).min().orElseThrow();
            long updated =
                    retained.stream().mapToLong(ItemPartRecord::updatedAt).max().orElseThrow();
            String status = "in_progress";
            if (terminal != null) {
                last = Math.max(last, terminal.sequence());
                updated = Math.max(updated, terminal.createdAt());
                status = switch (terminal.type()) {
                    case "turn.completed" -> "completed";
                    case "turn.cancelled" -> "cancelled";
                    default -> "failed";
                };
            }
            jdbc.update(
                    "UPDATE ma_message SET first_sequence = ?, last_sequence = ?, gmt_create = ?,"
                            + " gmt_modified = ?, item_status = ?, revision = revision + 1 WHERE"
                            + " tenant_id = ? AND session_id = ? AND item_id = ?",
                    first,
                    last,
                    created,
                    updated,
                    status,
                    tenantId,
                    sessionId,
                    entry.getKey());
        }
        flushParts(tenantId, sessionId, parts);
        jdbc.update(
                "UPDATE ma_event_stream SET projection_version = projection_version + 1,"
                    + " snapshot_stale_since = ?, gmt_modified = ? WHERE tenant_id = ? AND session_id"
                    + " = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                now,
                now,
                tenantId,
                sessionId);
        if (covered > 0) {
            snapshots.afterCommit(tenantId, sessionId);
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
        requireLegacyMutation(tenantId, sessionId);
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
        if (terminal != null) {
            settleTurnCommands(tenantId, sessionId, turnId, now);
        }
        publishAfterCommit(committed);
    }

    private int updateHarnessCursor(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastSourceId, long now) {
        // Journaling new events proves coordination made progress, so the
        // retry budget restarts: it counts consecutive failures without
        // progress. retry_count is not reset — it paces the backoff (review
        // round 8, R8-3).
        return jdbc.update("UPDATE ma_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, consecutive_failures = 0,"
                        + " budget_exempt_failures = 0,"
                        + " gmt_modified = ?,"
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
        return jdbc.update("UPDATE ma_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, status = ?,"
                        + " error_code = ?, error_message = ?,"
                        + " completed_at = ?, gmt_modified = ?,"
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
        jdbc.update("UPDATE ma_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                eventEpoch, lastSourceId, now, tenantId, sessionId);
        jdbc.update(
                "UPDATE ma_event_stream SET last_sequence = ?, gmt_modified = ? WHERE tenant_id = ?"
                    + " AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                next,
                now,
                tenantId,
                sessionId);
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

    @Override
    @Transactional
    public boolean cancelUnadmittedTurn(String tenantId, String sessionId,
            String turnId, String owner) {
        SessionRecord session = requireLegacySessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        if (!"CANCELLING".equals(turn.status())
                || !owner.equals(turn.dispatchOwner())
                || turn.harnessEventEpoch() != null
                || !turn.submissionAttempted()) {
            return false;
        }
        var heads = WorkspaceOperations.rows(jdbc,
                "SELECT tenant_id, session_id, state, writer_lease_until FROM"
                        + " ma_session_head WHERE tenant_key = ? AND harness_key = ?"
                        + " AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId));
        long now = lifecycleDatabaseTime();
        if (heads.size() != 1 || !tenantId.equals(heads.getFirst().get("tenant_id"))
                || !sessionId.equals(heads.getFirst().get("session_id"))
                || !("SEALED".equals(heads.getFirst().get("state"))
                        || "ACTIVE".equals(heads.getFirst().get("state"))
                                && heads.getFirst().get("writer_lease_until") instanceof Number until
                                && until.longValue() <= now)) {
            return false;
        }
        // The locked, fenced writer cannot admit a late HTTP request. Even an
        // idle journal may contain this prompt's completed admission: replay
        // its real result instead of replacing it with cancellation.
        java.util.Set<String> accepted;
        try {
            accepted = WorkspaceLifecycleStore.requireIdleJournal(jdbc, objectMapper,
                    tenantId, sessionId, false,
                    WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) == 2);
        } catch (ApiException unverified) {
            return false;
        }
        if (accepted.contains(turn.promptId()) || !withdrawSubmissionAttempted(tenantId, sessionId, turnId, owner)) {
            return false;
        }
        cancelBeforeAdmission(tenantId, sessionId, turnId, owner);
        return "CANCELLED".equals(requireTurn(tenantId, sessionId, turnId).status());
    }

    @Transactional
    public void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner) {
        // Session-row lock first; see recordAdmission.
        requireLegacySessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || turn.harnessEventEpoch() != null
                || turn.submissionAttempted()) {
            return;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " 'CANCELLED',"
                        + " completed_at = ?, gmt_modified = ?,"
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
        settleTurnCommands(tenantId, sessionId, turnId, now);
    }

    @Transactional
    public void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message) {
        settleFailedTurn(tenantId, sessionId, turnId, owner, code, message, true);
    }

    @Transactional
    public boolean failRecoveryBlockedTurn(String tenantId, String sessionId,
            String turnId, String owner, String message) {
        return settleFailedTurn(tenantId, sessionId, turnId, owner,
                "managed_runtime_recovery_blocked", message, false);
    }

    private boolean settleFailedTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message, boolean allowCancelling) {
        // Session-row lock first; see recordAdmission.
        requireLegacySessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || !ACTIVE_TURN_STATES.contains(turn.status())
                || !allowCancelling && "CANCELLING".equals(turn.status())) {
            return false;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " 'FAILED',"
                        + " error_code = ?, error_message = ?, completed_at ="
                        + " ?, gmt_modified = ?, dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + (allowCancelling ? " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                                : " ('ACCEPTED', 'RUNNING') AND")
                        + " dispatch_lease_until >= ?",
                code, message, now, now, tenantId, sessionId, turnId, owner,
                now);
        if (updated != 1) {
            return false;
        }
        appendEvent(tenantId, sessionId, turnId, "turn.failed",
                Map.of("code", code, "message", message), true, null, now);
        settleTurnCommands(tenantId, sessionId, turnId, now);
        return true;
    }

    @Transactional
    public void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey) {
        requireLegacySessionForUpdate(tenantId, sessionId);
        if (!hasSourceEvent(tenantId, sessionId, sourceKey)) {
            appendEvent(tenantId, sessionId, turnId, type, data, terminal,
                    sourceKey, clock.millis());
        }
    }

    @Transactional
    public void appendLiveSessionEventIfAbsent(String tenantId,
            String sessionId, String type, Map<String, Object> data,
            String sourceKey) {
        requireLegacyMutation(tenantId, sessionId);
        // A locking read sees the latest committed status, where a plain one
        // could still see the snapshot taken before a deletion committed.
        Optional<SessionRecord> session = jdbc.query(SESSION_WITH_STREAM + " WHERE ma_session.tenant_id = ? AND"
                                        + " ma_session.session_kind = 'PUBLIC' AND"
                                        + " ma_session.session_id = ? FOR UPDATE",
                sessionMapper, tenantId, sessionId).stream()
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

    @Override
    public Optional<String> findLastVisibleStatusBeforeDelete(String tenantId,
            String sessionId) {
        return jdbc.query("SELECT session_status_before FROM ma_operation"
                        + " WHERE scope_key = ? AND operation_kind = 'DELETE'"
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND session_status_before IS NOT NULL"
                        + " ORDER BY gmt_create DESC LIMIT 1",
                (rows, row) -> rows.getString(1),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                sessionOperationTarget(sessionId), tenantId, sessionId)
                .stream().findFirst();
    }

    public SessionRecord requireSession(String tenantId, String sessionId) {
        return findSession(tenantId, sessionId).orElseThrow(() ->
                new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                        "The Session was not found."));
    }

    private boolean snapshotRefreshRequired(String tenantId, String sessionId, long covered, long now, boolean terminal) {
        var published =
                jdbc.query(
                        "SELECT p.published_at, p.covered_sequence, p.projection_version,"
                            + " s.projection_version AS current_projection FROM ma_event_stream s"
                            + " LEFT JOIN ma_snapshot p ON p.tenant_id = s.tenant_id AND"
                            + " p.session_id = s.session_id AND p.snapshot_id ="
                            + " s.current_snapshot_id WHERE s.tenant_id = ? AND s.session_id = ?"
                            + " AND s.stream_kind = 'SESSION' AND s.stream_id = X''",
                        (row, index) ->
                                new Long[] {
                                    nullableLong(row, "published_at"),
                                    nullableLong(row, "covered_sequence"),
                                    nullableLong(row, "projection_version"),
                                    nullableLong(row, "current_projection")
                                },
                        tenantId,
                        sessionId);
        if (published.isEmpty() || published.getFirst()[0] == null) {
            return true;
        }
        Long[] current = published.getFirst();
        if (covered <= current[1] && java.util.Objects.equals(current[2], current[3])) {
            return false;
        }
        return terminal
                || !java.util.Objects.equals(current[2], current[3])
                || now - current[0] >= SNAPSHOT_REFRESH_MILLIS
                || covered - current[1] >= SNAPSHOT_REFRESH_EVENTS;
    }

    private void materializeEvent(EventRecord event, Map<String, List<ItemPartRecord>> projectedParts) {
        switch (event.type()) {
            case "turn.accepted" -> materializeInput(event, projectedParts);
            case "item.output_text.delta" -> materializeText(event,
                    "output_text", projectedParts);
            case "item.reasoning.delta" -> materializeText(event,
                    "reasoning", projectedParts);
            case "item.tool_call.updated", "item.tool_result.updated" -> materializeTool(event);
            case "turn.completed", "turn.failed", "turn.cancelled" ->
                    settleTurnItems(event);
            default -> {
                return;
            }
        }
    }

    private void materializeInput(EventRecord event, Map<String, List<ItemPartRecord>> projectedParts) {
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
                input.stream().anyMatch(block -> "image".equals(block.get("type")) || "resource".equals(block.get("type")))
                        ? Map.of("inputAttachments", input) : Map.of());
        for (int index = 0; index < input.size(); index++) {
            Map<String, Object> block = input.get(index);
            String text = string(block.get("text"));
            if (text == null) {
                text = workflowLaunchSummary(block);
            }
            if (text == null) {
                continue;
            }
            replacePart(event, itemId,
                    "part_" + event.turnId() + "_input_" + index,
                    "input_text", text, projectedParts);
        }
    }

    /**
     * A workflow child's first turn carries one {@code workflow_launch} block and no text (#13803
     * K1): the message names the launch pin exactly as the daemon journal does ({@code
     * workflowLaunchSummaryText} in hosted-workflow-turn.ts), so both projections of the turn
     * agree. The block itself is never given a text key — the daemon parser requires its closed key
     * set.
     */
    private static String workflowLaunchSummary(Map<String, Object> block) {
        if (!"workflow_launch".equals(block.get("type"))
                || !(block.get("definition") instanceof Map<?, ?> pin)) {
            return null;
        }
        String id = string(pin.get("definitionId"));
        String digest = string(pin.get("definitionDigest"));
        if (id == null || digest == null
                || !(pin.get("definitionRevision") instanceof Number revision)) {
            return null;
        }
        return "<workflow " + id + "@" + revision.longValue() + " sha256:"
                + digest.substring(0, Math.min(16, digest.length())) + ">";
    }

    private void materializeText(EventRecord event, String partType, Map<String, List<ItemPartRecord>> projectedParts) {
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
        List<ItemPartRecord> parts = projectedParts.computeIfAbsent(itemId,
                key -> new ArrayList<>(partsForItem(event.tenantId(), event.sessionId(), key)));
        String partId = event.contentPartId() != null ? event.contentPartId() : parts.stream()
                .filter(part -> partType.equals(part.type()))
                .map(ItemPartRecord::partId).findFirst().orElseGet(() ->
                        EventIdentity.textPartId(event.turnId(), partType, event.sequence()));
        upsertItem(event, itemId, "message", "assistant", "in_progress",
                Map.of());
        appendPart(event, itemId, partId, partType, text, projectedParts);
    }

    private void materializeTool(EventRecord event) {
        String itemId = EventIdentity.toolItemId(event.turnId(),
                event.sequence(), event.data());
        String sourceStatus = string(event.data().get("status"));
        // Protocol tokens must fold with Locale.ROOT: under a tr_TR default
        // locale "FAILED" becomes "faıled" and misses these arms.
        String status = switch (sourceStatus == null ? ""
                : sourceStatus.toLowerCase(Locale.ROOT)) {
            case "completed", "success" -> "completed";
            case "failed" -> "failed";
            case "cancelled" -> "cancelled";
            default -> "in_progress";
        };
        Map<String, Object> attributes = existingAttributes(event, itemId);
        if (attributes.get("result") instanceof Map<?, ?> previous) {
            if (!(event.data().get("result") instanceof Map<?, ?> next)
                    || number(next.get("projection_revision"))
                            <= number(previous.get("projection_revision"))) {
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
                        + " ma_message WHERE tenant_id = ? AND"
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
        jdbc.update("UPDATE ma_message SET item_status = ?,"
                        + " last_sequence = CASE WHEN last_sequence < ?"
                        + " THEN ? ELSE last_sequence END, gmt_modified = ?,"
                        + " revision = revision + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND item_status"
                        + " = 'in_progress'",
                status, event.sequence(), event.sequence(),
                event.createdAt(), event.tenantId(), event.sessionId(),
                event.turnId());
    }

    private void upsertItem(EventRecord event, String itemId, String type,
            String role, String status, Map<String, Object> attributes) {
        int updated = jdbc.update("UPDATE ma_message SET"
                        + " item_status = ?, attributes_json = ?,"
                        + " last_sequence = ?, gmt_modified = ?, revision ="
                        + " revision + 1 WHERE tenant_id = ? AND session_id"
                        + " = ? AND item_id = ?",
                status, writeJson(attributes), event.sequence(),
                event.createdAt(), event.tenantId(), event.sessionId(),
                itemId);
        if (updated == 0) {
            jdbc.update("INSERT INTO ma_message (tenant_id,"
                            + " session_id, item_id, turn_id, item_type,"
                            + " item_role, item_status, attributes_json, parts_json,"
                            + " first_sequence, last_sequence, gmt_create,"
                            + " gmt_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]',"
                            + " ?, ?, ?, ?)",
                    event.tenantId(), event.sessionId(), itemId,
                    event.turnId(), type, role, status,
                    writeJson(attributes), event.sequence(), event.sequence(),
                    event.createdAt(), event.createdAt());
        }
    }

    private void replacePart(EventRecord event, String itemId,
            String partId, String type, String text, Map<String, List<ItemPartRecord>> projectedParts) {
        changePart(event, itemId, partId, type, text, false, projectedParts);
    }

    private void appendPart(EventRecord event, String itemId,
            String partId, String type, String text, Map<String, List<ItemPartRecord>> projectedParts) {
        changePart(event, itemId, partId, type, text, true, projectedParts);
    }

    private void changePart(EventRecord event, String itemId, String partId,
            String type, String text, boolean append, Map<String, List<ItemPartRecord>> projectedParts) {
        List<ItemPartRecord> parts = projectedParts.computeIfAbsent(itemId,
                key -> new ArrayList<>(partsForItem(event.tenantId(), event.sessionId(), key)));
        int index = -1;
        for (int current = 0; current < parts.size(); current++) {
            if (partId.equals(parts.get(current).partId())) {
                index = current;
                break;
            }
        }
        ItemPartRecord old = index < 0 ? null : parts.get(index);
        ItemPartRecord next = new ItemPartRecord(partId, type,
                append && old != null ? old.text() + text : text,
                old == null ? event.sequence() : old.firstSequence(), event.sequence(),
                old == null ? event.createdAt() : old.createdAt(), event.createdAt(),
                old == null ? 1 : old.revision() + 1);
        if (index < 0) {
            parts.add(next);
        } else {
            parts.set(index, next);
        }
    }

    private void flushParts(
            String tenantId, String sessionId, Map<String, List<ItemPartRecord>> projectedParts) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        for (var entry : projectedParts.entrySet()) {
            String item = entry.getKey();
            byte[] bytes =
                    writeJson(entry.getValue()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            String owner =
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            scope, item);
            Map<String, Object> previous =
                    jdbc.queryForMap(
                            "SELECT revision, body_resource_key FROM ma_message WHERE tenant_id = ?"
                                    + " AND session_id = ? AND item_id = ? FOR UPDATE",
                            tenantId,
                            sessionId,
                            item);
            long revision = ((Number) previous.get("revision")).longValue();
            if (previous.get("body_resource_key") != null) {
                ManagedProjectionResourceCollector.release(jdbc, scope, "MESSAGE", owner);
            }
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                            + " 'MESSAGE' AND owner_key = ?",
                    scope,
                    owner);
            String resource = null;
            if (bytes.length > 64 * 1024) {
                String digest = WorkspaceEvidenceResources.digest(bytes);
                String id = "message:" + owner + ":" + revision + ":" + digest;
                resource = ManagedSessionStore.resourceKey(scope, id);
                try {
                    jdbc.update(
                            "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, ?, 'managed-message-parts', 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                            resource,
                            scope,
                            tenantId,
                            sessionId,
                            id,
                            bytes.length,
                            digest,
                            bytes);
                } catch (DuplicateKeyException duplicate) {
                    List<Boolean> matching =
                            jdbc.query(
                                    "SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE resource_key = ? FOR UPDATE",
                                    (row, index) ->
                                            scope.equals(row.getString("session_scope_key"))
                                                    && tenantId.equals(row.getString("tenant_id"))
                                                    && sessionId.equals(row.getString("session_id"))
                                                    && id.equals(row.getString("resource_id"))
                                                    && "managed-message-parts"
                                                            .equals(row.getString("kind"))
                                                    && row.getInt("schema_version") == 1
                                                    && row.getLong("byte_length") == bytes.length
                                                    && digest.equals(row.getString("sha256"))
                                                    && java.util.Arrays.equals(
                                                            bytes, row.getBytes("inline_bytes"))
                                                    && "MYSQL_INLINE"
                                                            .equals(row.getString("storage_kind"))
                                                    && "REFERENCED".equals(row.getString("state"))
                                                    && row.getString("deletion_operation_key")
                                                            == null
                                                    && row.getString("publication_id") == null
                                                    && row.getString("object_key") == null
                                                    && row.getString("object_version_id") == null
                                                    && row.getString("encryption_key_id") == null,
                                    resource);
                    if (matching.size() != 1 || !matching.getFirst()) {
                        throw new IllegalStateException(
                                "Immutable message body identity differs.", duplicate);
                    }
                }
                jdbc.update(
                        "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create) VALUES (?, 'MESSAGE', ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                        scope,
                        owner,
                        revision,
                        resource,
                        tenantId,
                        sessionId,
                        id);
            }
            int changed =
                    jdbc.update(
                            "UPDATE ma_message SET parts_json = ?, body_resource_key = ?"
                                    + " WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                            resource == null
                                    ? new String(bytes, java.nio.charset.StandardCharsets.UTF_8)
                                    : "[]",
                            resource,
                            tenantId,
                            sessionId,
                            item);
            if (changed != 1) {
                throw new IllegalStateException("Message disappeared during locked projection.");
            }
        }
    }

    private List<ItemPartRecord> partsForItem(String tenantId, String sessionId, String itemId) {
        List<List<ItemPartRecord>> rows =
                jdbc.query(
                        "SELECT parts_json, body_resource_key FROM ma_message WHERE tenant_id = ?"
                                + " AND session_id = ? AND item_id = ? FOR UPDATE",
                        (row, index) -> readParts(row.getString(1), row.getString(2), tenantId, sessionId),
                        tenantId,
                        sessionId,
                        itemId);
        return rows.isEmpty() ? List.of() : rows.getFirst();
    }

    private List<ItemPartRecord> readParts(String value, String resourceKey, String tenantId, String sessionId) {
        if (resourceKey == null) {
            return readParts(value);
        }
        List<byte[]> rows =
                jdbc.query(
                        "SELECT inline_bytes, byte_length, sha256 FROM ma_resource WHERE"
                            + " resource_key = ? AND session_scope_key = ? AND tenant_id = ? AND"
                            + " session_id = ? AND kind = ? AND schema_version = 1 AND state ="
                            + " 'REFERENCED' AND deletion_operation_key IS NULL",
                        (row, i) -> {
                            byte[] bytes = row.getBytes("inline_bytes");
                            if (bytes == null
                                    || bytes.length != row.getLong("byte_length")
                                    || !WorkspaceEvidenceResources.digest(bytes)
                                            .equals(row.getString("sha256"))) {
                                throw new IllegalStateException(
                                        "Message body resource digest differs.");
                            }
                            return bytes;
                        },
                        resourceKey,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        tenantId,
                        sessionId,
                        "managed-message-parts");
        if (rows.size() != 1) {
            throw new IllegalStateException("Message body resource is unavailable.");
        }
        return readParts(new String(rows.getFirst(), java.nio.charset.StandardCharsets.UTF_8));
    }

    private List<ItemPartRecord> readParts(String value) {
        try {
            return value == null ? List.of() : objectMapper.readValue(value, PARTS_TYPE);
        } catch (java.io.IOException failure) {
            throw new IllegalStateException("Stored message parts are invalid.", failure);
        }
    }

    private List<ItemRecord> snapshotItems(String tenantId, String sessionId, Runnable checkLease) {
        return withParts(
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.MESSAGE.columns() + " FROM ma_message WHERE tenant_id = ? AND session_id = ?"
                                + " ORDER BY first_sequence ASC, item_id ASC",
                        (row, index) -> {
                            if (index % 100 == 0 || row.getString("body_resource_key") != null) {
                                checkLease.run();
                            }
                            return itemMapper.mapRow(row, index);
                        },
                        tenantId,
                        sessionId));
    }

    private List<ItemRecord> allItems(String tenantId, String sessionId) {
        return withParts(jdbc.query("SELECT " + ManagedSchemaProjection.MESSAGE.columns() + " FROM ma_message WHERE"
                        + " tenant_id = ? AND session_id = ? ORDER BY"
                        + " first_sequence ASC",
                itemMapper, tenantId, sessionId));
    }

    private List<ItemRecord> withParts(List<ItemRow> rows) {
        return rows.stream().map(ItemRow::toRecord).toList();
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

    private void requireLegacyMutation(String tenantId, String sessionId) {
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
    }

    private SessionRecord requireLegacySessionForUpdate(String tenantId, String sessionId) {
        return requireSessionForUpdate(tenantId, sessionId, true);
    }

    private SessionRecord requireSessionForUpdate(String tenantId,
            String sessionId) {
        return requireSessionForUpdate(tenantId, sessionId, false);
    }

    private SessionRecord requireSessionForUpdate(
            String tenantId, String sessionId, boolean legacyMutation) {
        try {
            return jdbc.queryForObject(
                    SESSION_WITH_STREAM + " WHERE ma_session.session_kind = 'PUBLIC' AND ma_session.tenant_id ="
                            + " ? AND ma_session.session_id = ? FOR UPDATE",
                    (rows, rowNumber) -> {
                        if (legacyMutation) {
                            ManagedLegacySessionGuard.requireLegacyMutation(rows.getBoolean("csi_guard"));
                        }
                        return sessionMapper.mapRow(rows, rowNumber);
                    },
                    tenantId,
                    sessionId);
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
            return jdbc.queryForObject("SELECT " + ManagedSchemaProjection.TURN.columns() + " FROM ma_turn"
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
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, gmt_create, gmt_modified, model_id, model_revision, approval_mode, approval_revision, plan_enabled) SELECT"
                        + " ?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, ?, model_id,"
                        + " CASE WHEN model_id IS NULL THEN NULL ELSE model_revision END,"
                        + " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
                        + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
                        + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
                        + " 'hosted-workspace-shell/1','hosted-workspace-shell/2')"
                        + " THEN COALESCE(selected_approval_mode, approval_mode) ELSE NULL END,"
                        + " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
                        + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
                        + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
                        + " 'hosted-workspace-shell/1','hosted-workspace-shell/2')"
                        + " THEN approval_revision ELSE NULL END,"
                        + " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
                        + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
                        + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
                        + " 'hosted-workspace-shell/1','hosted-workspace-shell/2')"
                        + " THEN plan_enabled ELSE NULL END"
                        + " FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                tenantId, sessionId, turnId, promptId, writeJson(input),
                payloadDigest, now, now, "qwen-code".getBytes(StandardCharsets.UTF_8),
                "qwen-code".getBytes(StandardCharsets.UTF_8), "qwen-code".getBytes(StandardCharsets.UTF_8),
                "qwen-code".getBytes(StandardCharsets.UTF_8), "qwen-code".getBytes(StandardCharsets.UTF_8),
                "qwen-code".getBytes(StandardCharsets.UTF_8), tenantId, sessionId);
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
                sessionId, turnId, status, null, null, now);
    }

    private void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, String sessionStatusBefore,
            byte[] actorKey, long now) {
        ManagedReceipts.insertCommand(jdbc, tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, status, sessionStatusBefore, actorKey, now);
    }

    // null for an actor id the registry key cannot encode: ManagedReceipts
    // stamps the receipt UNATTRIBUTED, which answers to the creator gate
    // alone.
    private static byte[] commandActorKey(String tenantId, String actorId) {
        if (actorId == null) {
            return null;
        }
        try {
            return ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return null;
        }
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

    // The Session lock orders each new attempt against committed events.
    // Legacy receipts fall back to their original requested event; a
    // re-drive refreshes the boundary without appending another event.
    private boolean supersededByLaterMutation(String tenantId,
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

    private static String mutationSource(String operation,
            String idempotencyKey, String phase) {
        return "control:" + operation + ":" + idempotencyKey + ":" + phase;
    }

    // One lifecycle change at a time: a pending rename or unarchive command
    // blocks an operation, and an open operation blocks both commands.
    /** The latest terminally failed lifecycle operation of the kind: the
     * status the Session carried when it began and the protocol it ran
     * under — both re-pinned by a resumed admission. */
    private Optional<FailedLifecycleOperation> latestFailedLifecycleOperation(
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

    private record FailedLifecycleOperation(String operationId,
            String sessionStatusBefore, int lifecycleProtocolVersion) {
    }

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
                && (hasLiveTurn(session.tenantId(), session.sessionId())
                        || session.workspace() != null && hasDecidableAction(session))) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_active",
                    "The Session has an active Turn.");
        }
    }

    /**
     * #14387: the lifecycle gate's active-Turn count. A Turn marked
     * recovery-blocked is parked out of the dispatch sweep and never
     * drives again — it is evidence of an unwitnessed execution, not live
     * work, so it does not hold a lifecycle operation open. A CANCELLING
     * Turn still blocks: its cancel is in flight.
     */
    private boolean hasLiveTurn(String tenantId, String sessionId) {
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

    private boolean hasDecidableAction(SessionRecord session) {
        long now = lifecycleDatabaseTime();
        for (String options : jdbc.queryForList(
                        "SELECT options_json FROM ma_session_record WHERE session_scope_key = ? AND"
                            + " record_kind = 'ACTION' AND state = 'requested' AND tenant_id = ?"
                            + " AND session_id = ?", String.class,
                ManagedSessionStore.sessionScopeKey(session.tenantId(), session.sessionId()),
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
            case ACTION_RESPONSE, CWD_CHANGE, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    private static String requestedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.close.requested";
            case ARCHIVE -> "session.archive.requested";
            case DELETE -> "session.delete.requested";
            case ACTION_RESPONSE, CWD_CHANGE, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    private static String completedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.closed";
            case ARCHIVE -> "session.archived";
            case DELETE -> "session.deleted";
            case ACTION_RESPONSE, CWD_CHANGE, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
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
                "The Session is " + status.toLowerCase(Locale.ROOT)
                        + " and cannot perform this operation.");
    }

    private EventRecord appendEvent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey, long now) {
        Long sequence =
                jdbc.queryForObject(
                        "SELECT last_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                            + " UPDATE",
                        Long.class,
                        tenantId,
                        sessionId);
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
        jdbc.update("UPDATE ma_event_stream SET last_sequence = ?,"
                        + " gmt_modified = ? WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'SESSION' AND stream_id = X''",
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
        List<EventRecord> events =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id"
                            + " = X'' AND tenant_id = ? AND session_id = ? AND sequence_id >= ?"
                            + " ORDER BY sequence_id ASC",
                        eventMapper,
                        tenantId,
                        sessionId,
                        fromSequence - 1);
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
                jdbc.update(
                        "UPDATE ma_public_event SET item_id = ?, content_part_id = ? WHERE"
                            + " tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION' AND"
                            + " stream_id = X'' AND sequence_id = ?",
                        identity.itemId(),
                        identity.contentPartId(),
                        tenantId,
                        sessionId,
                        event.sequence());
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
        List<Identity> rows =
                jdbc.query(
                        "SELECT event_type, item_id, content_part_id FROM ma_public_event WHERE"
                            + " stream_kind = 'SESSION' AND stream_id = X'' AND tenant_id = ? AND"
                            + " session_id = ? AND sequence_id = ?",
                        (result, row) ->
                                new Identity(
                                        result.getString("event_type"),
                                        result.getString("item_id"),
                                        result.getString("content_part_id")),
                        tenantId,
                        sessionId,
                        sequence);
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
                        + " ma_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                Integer.class, tenantId, sessionId);
        return count != null && count > 0;
    }

    private boolean hasEventType(String tenantId, String sessionId,
            String turnId, String type) {
        Integer count =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                            + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND turn_id ="
                            + " ? AND event_type = ?",
                        Integer.class,
                        tenantId,
                        sessionId,
                        turnId,
                        type);
        return count != null && count > 0;
    }

    private boolean hasSourceEvent(String tenantId, String sessionId,
            String sourceKey) {
        Integer count =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                            + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND source_key"
                            + " = ?",
                        Integer.class,
                        tenantId,
                        sessionId,
                        sourceKey);
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

    public static ContextBinding readBinding(java.sql.ResultSet result)
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

    private static int additiveInt(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        return hasColumn(result, name) ? result.getInt(name) : 0;
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

    private record StreamCounters(long lastSequence, long floorSequence) {}

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
            long revision, List<ItemPartRecord> content) {
        private ItemRecord toRecord() {
            return new ItemRecord(tenantId, sessionId, itemId, turnId, type,
                    role, status, attributes, firstSequence, lastSequence,
                    createdAt, updatedAt, revision, content);
        }
    }
}
