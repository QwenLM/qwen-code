package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.ContextCompressionState;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.CwdChangeOutcome;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.TaskCancelOutcome;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.RenameDelivery;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

@Repository
@Qualifier("managedAgentTransactionManager")
public class ManagedAgentStore implements AgentStateStore {
    private final AgentEventJournal eventJournal;
    private final AgentSessionQueries sessionQueries;
    private final AgentMessageProjection messageProjection;
    private final AgentSessionPolicies sessionPolicies;
    private final AgentSessionCommands sessionCommands;
    private final AgentLifecycleOperations lifecycleOperations;
    private final AgentSessionAdmissions sessionAdmissions;
    private final AgentTurnExecution turnExecution;
    private final AgentExecutionOperations executionOperations;

    public ManagedAgentStore(JdbcTemplate jdbc, ObjectMapper objectMapper, Clock clock,
            CommittedEventPublisher eventPublisher, ManagedWorkspaceRegistry workspaces,
            ManagedAgentSettings properties, HarnessRules harnessRules) {
        this(jdbc, objectMapper, clock, eventPublisher, workspaces, properties, harnessRules,
                null, new ManagedSessionSkills(jdbc, objectMapper, new RequestDigests(), null), null,
                null, null, null, null, null);
    }

    public ManagedAgentStore(JdbcTemplate jdbc, ObjectMapper objectMapper,
            Clock clock, CommittedEventPublisher eventPublisher,
            ManagedWorkspaceRegistry workspaces, ManagedAgentSettings properties, HarnessRules harnessRules,
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles,
            ManagedSessionSkills creationSkills,
            com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages extensionPackages,
            WorkspaceLifecycleStore lifecycle, ManagedAgentDefinitionStore definitions,
            SessionWorktreeStore sessionWorktrees, JournalEventTransport journalEventTransport,
            ManagedExtensionRecordStore configRecords) {
        this(jdbc, objectMapper, clock, eventPublisher, workspaces, properties, harnessRules,
                worktreeFiles, creationSkills, extensionPackages, lifecycle, definitions,
                sessionWorktrees, journalEventTransport, configRecords, null);
    }

    @Autowired
    public ManagedAgentStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, @Qualifier("managedAgentObjectMapper") ObjectMapper objectMapper,
            @Qualifier("managedAgentClock") Clock clock, CommittedEventPublisher eventPublisher,
            ManagedWorkspaceRegistry workspaces, ManagedAgentSettings properties, HarnessRules harnessRules,
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles,
            ManagedSessionSkills creationSkills,
            com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages extensionPackages,
            @Nullable WorkspaceLifecycleStore lifecycle, @Nullable ManagedAgentDefinitionStore definitions,
            @Nullable SessionWorktreeStore sessionWorktrees, @Nullable JournalEventTransport journalEventTransport,
            @Lazy @Nullable ManagedExtensionRecordStore configRecords, ManagedSessionModelConfigs modelConfigs) {
        String approvalMode =
                properties.getHarness().getApprovalMode().toLowerCase(Locale.ROOT);
        String agentRevision = properties.getAgentRevision();
        List<String> definitionToolProfiles = properties.getDefinitionToolProfiles();
        List<String> definitionModels = properties.getDefinitionModels();
        var modelIds = new HashSet<String>();
        List<WebShellModelOption> modelCatalog = properties.getModelCatalog().stream().map(option -> {
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
        boolean journalEventTransportEnabled = properties.getEventTransport().isEnabled();
        boolean workspaceFilesEnabled = properties.getHarness().isWorkspaceFilesEnabled();
        boolean workspaceShellEnabled = properties.getHarness().isWorkspaceShellEnabled();
        boolean workspaceChildAgentsEnabled = properties.admitsPublicChildAgents();
        boolean managedExtensionExecutionEnabled = properties.getExtensions().isEnabled() && properties.getManagedExtensions().isEnabled();
        long lifecycleHandoffMillis = properties.getSessionStore().getWriterLeaseDuration().toMillis();
        List<? extends ManagedAgentSettings.RuntimeBroker.WorkspaceMount> workspaceMounts = properties.getRuntimeBroker().getWorkspaceMounts();
        ResidentWorkspaces residentWorkspaces = new ResidentWorkspaces(properties.getRuntimeBroker().getResidentWorkspaces());
        WorkspaceCreationRoots createdRoots = new WorkspaceCreationRoots(jdbc, properties);
        if (StringUtils.isBlank(agentRevision)
                || agentRevision.length() > 128) {
            throw new IllegalArgumentException(
                    "qwen.managed-agent.agent-revision must contain 1-128"
                            + " characters");
        }

        AgentStoreRows storeRows = new AgentStoreRows(harnessRules, jdbc, objectMapper);
        this.eventJournal = new AgentEventJournal(storeRows, jdbc, clock, eventPublisher);
        this.sessionQueries = new AgentSessionQueries(storeRows, worktreeFiles, jdbc, modelCatalog);
        this.messageProjection = new AgentMessageProjection(eventJournal, storeRows, jdbc, objectMapper, clock);
        this.sessionPolicies = new AgentSessionPolicies(eventJournal, sessionQueries, storeRows, worktreeFiles, harnessRules, configRecords, jdbc, objectMapper, clock, approvalMode, workspaces, agentRevision, definitionToolProfiles, definitionModels, modelCatalog, definitions, creationSkills, workspaceFilesEnabled, workspaceShellEnabled, residentWorkspaces);
        this.sessionCommands = new AgentSessionCommands(eventJournal, sessionPolicies, storeRows, worktreeFiles, jdbc, clock, workspaces, workspaceFilesEnabled, workspaceShellEnabled);
        this.lifecycleOperations = new AgentLifecycleOperations(eventJournal, sessionCommands, sessionPolicies, sessionQueries, storeRows, jdbc, lifecycle, objectMapper, clock, workspaces, workspaceFilesEnabled, lifecycleHandoffMillis);
        this.sessionAdmissions = new AgentSessionAdmissions(eventJournal, sessionCommands, sessionPolicies, storeRows, configRecords, jdbc, clock, approvalMode, workspaces, agentRevision, modelCatalog, definitions, creationSkills, sessionWorktrees, extensionPackages, workspaceFilesEnabled, workspaceShellEnabled, workspaceChildAgentsEnabled, managedExtensionExecutionEnabled, workspaceMounts, residentWorkspaces, createdRoots, journalEventTransport, journalEventTransportEnabled, modelConfigs);
        this.turnExecution = new AgentTurnExecution(eventJournal, messageProjection, sessionCommands, storeRows, jdbc, objectMapper, clock);
        this.executionOperations = new AgentExecutionOperations(eventJournal, lifecycleOperations, sessionPolicies, sessionQueries, storeRows, worktreeFiles, jdbc, clock, workspaces, workspaceFilesEnabled);
    }

    @Override
    public SessionWorktreeStore.Descriptor findSessionWorktree(String tenantId, String sessionId) {
        return sessionQueries.findSessionWorktree(tenantId, sessionId);
    }

    @Override
    public Map<String, SessionWorktreeStore.Descriptor> findSessionWorktrees(String tenantId, List<String> sessionIds) {
        return sessionQueries.findSessionWorktrees(tenantId, sessionIds);
    }

    @Override
    @Transactional
    public Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return sessionAdmissions.insertSessionCommand(tenantId, actorId, operation, idempotencyKey, requestDigest, agentId, requestedRevision, title, input, payloadDigest);
    }

    @Override
    @Transactional
    public Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest, SessionModelConfig modelConfig) {
        return sessionAdmissions.insertSessionCommand(tenantId, actorId, operation, idempotencyKey, requestDigest, agentId, requestedRevision, title, input, payloadDigest, modelConfig);
    }

    @Override
    @Transactional
    public Admission insertWorkspaceSessionCommand(SessionCreationCommand command) {
        return sessionAdmissions.insertWorkspaceSessionCommand(command);
    }

    @Transactional
    public Admission insertInternalTeamLeadSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest,
            String title, WorkspaceSelection selection) {
        return sessionAdmissions.insertInternalTeamLeadSessionCommand(tenantId, actorId, idempotencyKey, requestDigest, title, selection);
    }

    @Override
    public Optional<Admission> findWorkspaceCreateReplay(String tenantId,
            String actorId, String idempotencyKey, String requestDigest) {
        return sessionAdmissions.findWorkspaceCreateReplay(tenantId, actorId, idempotencyKey, requestDigest);
    }

    @Override
    @Transactional
    public Admission replayWorkspaceSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest) {
        return sessionAdmissions.replayWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest);
    }

    Admission insertCsiSessionCommand(
            WorkspaceCsiRegistration registration,
            String actorId,
            String idempotencyKey,
            String requestDigest,
            String requestedRevision,
            String title,
            WorkspaceSelection selection) {
        return sessionAdmissions.insertCsiSessionCommand(registration, actorId, idempotencyKey, requestDigest, requestedRevision, title, selection);
    }

    RuntimeProvisionRequest requireCsiRequest(
            WorkspaceCsiRegistration registration, String sessionId) {
        return sessionAdmissions.requireCsiRequest(registration, sessionId);
    }

    @Override
    @Transactional
    public Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        return sessionAdmissions.insertChildSessionCommand(tenantId, parentSessionId, idempotencyKey, requestDigest, title, input, payloadDigest, lineage);
    }

    @Override
    @Transactional
    public Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        return sessionAdmissions.insertChildSessionCommand(tenantId, parentSessionId, idempotencyKey, requestDigest, title, input, payloadDigest, lineage, childCwdRelative);
    }

    @Override
    public String findChildWorkspaceCwd(String tenantId,
            String parentSessionId, String childRunId) {
        return sessionQueries.findChildWorkspaceCwd(tenantId, parentSessionId, childRunId);
    }

    @Override
    @Transactional
    public Admission insertPublicChildSessionCommand(String tenantId, String parentSessionId,
            String idempotencyKey, String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage, com.fasterxml.jackson.databind.JsonNode snapshot) {
        return sessionAdmissions.insertPublicChildSessionCommand(tenantId, parentSessionId, idempotencyKey, requestDigest, title, input, payloadDigest, lineage, snapshot);
    }

    @Override
    @Transactional
    public Admission replayChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest) {
        return sessionAdmissions.replayChildSessionCommand(tenantId, parentSessionId, idempotencyKey, requestDigest);
    }

    @Override
    public StoreModels.SessionLineage findChildLineage(String tenantId,
            String sessionId) {
        return sessionQueries.findChildLineage(tenantId, sessionId);
    }

    @Override
    @Transactional
    public WebShellSessionOptions workspaceSessionOptions(
            String tenantId, String agentId) {
        return sessionPolicies.workspaceSessionOptions(tenantId, agentId);
    }

    @Override
    public boolean supportsPlanMode(SessionRecord session) {
        return sessionPolicies.supportsPlanMode(session);
    }

    @Override
    public boolean hasMcpServers(SessionRecord session) {
        return sessionPolicies.hasMcpServers(session);
    }

    @Override
    @Transactional
    public SessionRecord requireMcpManagement(String tenantId, String actorId, String sessionId, String operationId) {
        return sessionPolicies.requireMcpManagement(tenantId, actorId, sessionId, operationId);
    }

    @Override
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.MANDATORY)
    public void requireMcpSettingsCommit(String tenantId, String workspaceId, String sessionId) {
        sessionPolicies.requireMcpSettingsCommit(tenantId, workspaceId, sessionId);
    }

    @Override
    @Transactional
    public SessionRecord requireExtensionManagement(String tenantId, String actorId, String sessionId, String operationId, boolean mutation) {
        return sessionPolicies.requireExtensionManagement(tenantId, actorId, sessionId, operationId, mutation);
    }

    @Override
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.MANDATORY)
    public void requireConfigurationCommit(String tenantId, String workspaceId, String sessionId, JsonNode body) {
        sessionPolicies.requireConfigurationCommit(tenantId, workspaceId, sessionId, body);
    }

    @Transactional
    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest) {
        return sessionCommands.insertTurnCommand(tenantId, operation, idempotencyKey, requestDigest, sessionId, input,
                payloadDigest, (String) null);
    }

    @Transactional
    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            String actorId) {
        return sessionCommands.insertTurnCommand(tenantId, operation, idempotencyKey, requestDigest, sessionId, input, payloadDigest, actorId);
    }

    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId) {
        return sessionCommands.insertCancelCommand(tenantId, operation, idempotencyKey, requestDigest, sessionId,
                turnId, (String) null);
    }

    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String actorId) {
        return sessionCommands.insertCancelCommand(tenantId, operation, idempotencyKey, requestDigest, sessionId, turnId, actorId);
    }

    @Override
    @Transactional
    public SessionMutationCommand beginSessionRename(String tenantId, String key,
            String digest, String sessionId, String title) {
        return sessionCommands.beginSessionRename(tenantId, key, digest, sessionId, title, (String) null);
    }

    @Override
    @Transactional
    public SessionMutationCommand beginSessionRename(String tenantId, String key,
            String digest, String sessionId, String title, String actorId) {
        return sessionCommands.beginSessionRename(tenantId, key, digest, sessionId, title, actorId);
    }

    @Override
    @Transactional
    public SessionRecord completeSessionRename(String tenantId, String key, String sessionId,
            String title, String bootId, long revision) {
        return sessionCommands.completeSessionRename(tenantId, key, sessionId, title, bootId, revision);
    }

    @Override
    @Transactional
    public SessionRecord completeSessionRename(RenameDelivery delivery, String owner, String bootId) {
        return sessionCommands.completeSessionRename(delivery, owner, bootId);
    }

    @Override
    @Transactional
    public void abandonSessionRename(String tenantId, String key, String sessionId, long revision, String owner) {
        sessionCommands.abandonSessionRename(tenantId, key, sessionId, revision, owner);
    }

    @Override
    @Transactional
    public List<RenameDelivery> deliverableRenames(long now) {
        return sessionCommands.deliverableRenames(now);
    }

    @Override
    @Transactional
    public Optional<RenameDelivery> claimRename(RenameDelivery delivery, String owner, Duration lease) {
        return sessionCommands.claimRename(delivery, owner, lease);
    }

    @Override
    public void markRenameSubmitted(RenameDelivery delivery, String owner) {
        sessionCommands.markRenameSubmitted(delivery, owner);
    }

    @Override
    @Transactional
    public void retryRename(RenameDelivery delivery, String owner, long availableAt) {
        sessionCommands.retryRename(delivery, owner, availableAt);
    }

    @Transactional
    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind) {
        return sessionCommands.beginSessionMutation(tenantId, operation, idempotencyKey, requestDigest, sessionId,
                kind, null);
    }

    @Transactional
    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId) {
        return sessionCommands.beginSessionMutation(tenantId, operation, idempotencyKey, requestDigest, sessionId, kind, actorId);
    }

    @Transactional
    public SessionRecord completeSessionMutation(String tenantId,
            String operation, String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId) {
        return sessionCommands.completeSessionMutation(tenantId, operation, idempotencyKey, sessionId, kind, title, harnessBootId);
    }

    @Override
    @Transactional
    public void abandonSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId) {
        sessionCommands.abandonSessionMutation(tenantId, operation, idempotencyKey, sessionId);
    }

    @Override
    @Transactional
    public OperationAdmission beginOperation(String tenantId,
            String sessionId, OperationKind kind, String actorDigest,
            String idempotencyKey, String requestDigest) {
        return lifecycleOperations.beginOperation(tenantId, sessionId, kind, actorDigest, idempotencyKey, requestDigest);
    }

    @Override
    public boolean workspaceFilesEnabled() {
        return sessionPolicies.workspaceFilesEnabled();
    }

    @Override
    public boolean workspaceShellEnabled() {
        return sessionPolicies.workspaceShellEnabled();
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceClose(String tenantId, String sessionId, String actorId,
            String actorDigest, String key, String digest, boolean supported) {
        return lifecycleOperations.beginWorkspaceClose(tenantId, sessionId, actorId, actorDigest, key, digest, supported);
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key, String digest, boolean closeSupported) {
        return lifecycleOperations.beginWorkspaceLifecycle(tenantId, sessionId, kind, actorId, actorDigest, key, digest, closeSupported);
    }

    @Override
    @Transactional
    public OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key, String digest, boolean supported, int protocolVersion) {
        return lifecycleOperations.beginWorkspaceLifecycle(tenantId, sessionId, kind, actorId, actorDigest, key, digest, supported, protocolVersion);
    }

    @Override
    public boolean hasCompletedWorkspaceClose(String tenantId, String sessionId) {
        return sessionQueries.hasCompletedWorkspaceClose(tenantId, sessionId);
    }

    @Override
    public Set<String> completedWorkspaceCloses(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.completedWorkspaceCloses(tenantId, sessionIds);
    }

    @Override
    @Transactional
    public SessionMutation unarchiveWorkspaceSession(String tenantId, String sessionId,
            String actorId, String scopedKey, String requestDigest) {
        return lifecycleOperations.unarchiveWorkspaceSession(tenantId, sessionId, actorId, scopedKey, requestDigest);
    }

    static final String SUBMIT_INPUT_UNCONFIRMED = AgentSessionCommands.SUBMIT_INPUT_UNCONFIRMED;

    static final String CANCEL_UNCONFIRMED = AgentSessionCommands.CANCEL_UNCONFIRMED;

    static final String SESSION_TITLE_UNCONFIRMED = AgentSessionCommands.SESSION_TITLE_UNCONFIRMED;

    static final String SESSION_TITLE_UNDELIVERED = AgentExecutionOperations.SESSION_TITLE_UNDELIVERED;

    @Override
    @Transactional
    public OperationAdmission beginChildClose(String tenantId, String parentSessionId,
            String childSessionId, String childRunId, String actorDigest, String key,
            String digest, boolean supported) {
        return lifecycleOperations.beginChildClose(tenantId, parentSessionId, childSessionId, childRunId, actorDigest, key, digest, supported);
    }

    @Override
    @Transactional
    public OperationAdmission beginContextCompression(String tenantId, String sessionId,
            String actorId, String actorDigest, String key, String digest,
            long expectedCompactionRevision, boolean supported) {
        return executionOperations.beginContextCompression(tenantId, sessionId, actorId, actorDigest, key, digest, expectedCompactionRevision, supported);
    }

    @Override
    public ContextCompressionState contextCompressionState(String tenantId, String sessionId) {
        return executionOperations.contextCompressionState(tenantId, sessionId);
    }

    @Override
    public Map<String, ContextCompressionState> contextCompressionStates(String tenantId, List<String> sessionIds) {
        return executionOperations.contextCompressionStates(tenantId, sessionIds);
    }

    @Override
    public Map<String, Object> contextCompressionRequest(String tenantId, String sessionId, String operationId) {
        return executionOperations.contextCompressionRequest(tenantId, sessionId, operationId);
    }

    @Override
    public List<OperationTarget> findContextCompressions(int limit) {
        return executionOperations.findContextCompressions(limit);
    }

    @Override
    @Transactional
    public Optional<OperationRecord> claimContextCompression(String tenantId, String sessionId,
            String operationId, String owner, Duration duration) {
        return executionOperations.claimContextCompression(tenantId, sessionId, operationId, owner, duration);
    }

    @Override
    public void requireContextCompressionCommit(String tenantId, String sessionId, String operationId) {
        executionOperations.requireContextCompressionCommit(tenantId, sessionId, operationId);
    }

    @Override
    @Transactional
    public boolean markContextCompressionSubmitted(OperationRecord operation, String owner) {
        return executionOperations.markContextCompressionSubmitted(operation, owner);
    }

    @Override
    @Transactional
    public boolean settleContextCompression(OperationRecord operation, String owner,
            String outcome, Long revision, String failureCode) {
        return executionOperations.settleContextCompression(operation, owner, outcome, revision, failureCode);
    }

    @Override
    @Transactional
    public void retryContextCompressionPreparation(OperationRecord operation, String owner, long retryAt) {
        executionOperations.retryContextCompressionPreparation(operation, owner, retryAt);
    }

    @Override
    @Transactional
    public void awaitContextCompression(OperationRecord operation, String owner,
            boolean acceptanceKnown, String failureCode, long retryAt) {
        executionOperations.awaitContextCompression(operation, owner, acceptanceKnown, failureCode, retryAt);
    }

    @Override
    @Transactional
    public CwdChangeOutcome completeCwdChangeOperation(String tenantId,
            String sessionId, String operationId, String owner,
            long claimGeneration) {
        return executionOperations.completeCwdChangeOperation(tenantId, sessionId, operationId, owner, claimGeneration);
    }

    @Override
    @Transactional
    public boolean failCwdChangeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode) {
        return executionOperations.failCwdChangeOperation(tenantId, sessionId, operationId, owner, claimGeneration, failureCode);
    }

    @Override
    @Transactional
    public OperationAdmission beginTaskCancelOperation(String tenantId,
            String sessionId, String taskId, String actorDigest,
            String idempotencyKey, String requestDigest) {
        return executionOperations.beginTaskCancelOperation(tenantId, sessionId, taskId, actorDigest, idempotencyKey, requestDigest);
    }

    @Override
    public List<OperationTarget> findDeliverableTaskCancels(int limit) {
        return executionOperations.findDeliverableTaskCancels(limit);
    }

    @Override
    public List<ParkedOperation> findParkedOperations(int limit) {
        return executionOperations.findParkedOperations(limit);
    }

    @Override
    @Transactional
    public boolean settleParkedOperation(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        return executionOperations.settleParkedOperation(parked, verdict, retryAt);
    }

    @Override
    public AcceptanceVerdict turnInputAcceptance(String tenantId,
            String sessionId, String operationId) {
        return executionOperations.turnInputAcceptance(tenantId, sessionId, operationId);
    }

    @Override
    public Optional<AcceptanceVerdict> renameAcceptance(ParkedOperation parked) {
        return executionOperations.renameAcceptance(parked);
    }

    @Override
    @Transactional
    public boolean settleParkedRename(ParkedOperation parked, AcceptanceVerdict verdict,
            long retryAt) {
        return executionOperations.settleParkedRename(parked, verdict, retryAt);
    }

    @Override
    @Transactional
    public boolean settleTaskCancel(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            TaskCancelOutcome outcome, long retryAt) {
        return executionOperations.settleTaskCancel(tenantId, sessionId, operationId, owner, claimGeneration, outcome, retryAt);
    }

    @Override
    public boolean hasExecutionRegistryFacts(String tenantId,
            String sessionId) {
        return sessionQueries.hasExecutionRegistryFacts(tenantId, sessionId);
    }

    @Override
    public Set<String> sessionsWithExecutionRegistryFacts(String tenantId,
            java.util.Collection<String> sessionIds) {
        return sessionQueries.sessionsWithExecutionRegistryFacts(tenantId, sessionIds);
    }

    @Override
    public Optional<OperationRecord> findOperation(String tenantId,
            String sessionId, String operationId) {
        return lifecycleOperations.findOperation(tenantId, sessionId, operationId);
    }

    @Override
    public List<OperationTarget> findDeliverableOperations(long now,
            int limit) {
        return lifecycleOperations.findDeliverableOperations(now, limit);
    }

    @Override
    @Transactional
    public Optional<OperationRecord> claimOperation(String tenantId,
            String sessionId, String operationId, String owner,
            Duration leaseDuration) {
        return lifecycleOperations.claimOperation(tenantId, sessionId, operationId, owner, leaseDuration);
    }

    @Override
    @Transactional
    public boolean completeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            boolean harnessConfirmed) {
        return lifecycleOperations.completeOperation(tenantId, sessionId, operationId, owner, claimGeneration, harnessConfirmed);
    }

    @Override
    @Transactional
    public boolean failOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode) {
        return lifecycleOperations.failOperation(tenantId, sessionId, operationId, owner, claimGeneration, failureCode);
    }

    @Override
    @Transactional
    public boolean renewLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, Duration duration) {
        return lifecycleOperations.renewLifecycleOperation(tenantId, sessionId, operationId, owner, generation, duration);
    }

    @Override
    @Transactional
    public void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt) {
        lifecycleOperations.blockLifecycleOperation(tenantId, sessionId, operationId, owner, generation, failureCode,
                availableAt, false);
    }

    @Override
    @Transactional
    public void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt,
            boolean budgetExempt) {
        lifecycleOperations.blockLifecycleOperation(tenantId, sessionId, operationId, owner, generation, failureCode, availableAt, budgetExempt);
    }

    @Override
    @Transactional
    public void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt) {
        lifecycleOperations.retryOperation(tenantId, sessionId, operationId, owner,
                claimGeneration, availableAt, false);
    }

    @Override
    @Transactional
    public void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt, boolean budgetExempt) {
        lifecycleOperations.retryOperation(tenantId, sessionId, operationId, owner, claimGeneration, availableAt, budgetExempt);
    }

    @Override
    @Transactional
    public void markOperationAnswered(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration) {
        lifecycleOperations.markOperationAnswered(tenantId, sessionId, operationId, owner, claimGeneration);
    }

    public Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        return sessionCommands.replayCommand(tenantId, operation, idempotencyKey, requestDigest);
    }

    public Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey) {
        return sessionCommands.findCommand(tenantId, operation, idempotencyKey);
    }

    public Optional<SessionRecord> findSession(String tenantId,
            String sessionId) {
        return sessionQueries.findSession(tenantId, sessionId);
    }

    public Optional<SessionRecord> findSessionById(String sessionId) {
        return sessionQueries.findSessionById(sessionId);
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit) {
        return sessionQueries.listSessions(tenantId, actorId, beforeCreatedAt, beforeSessionId, limit, "all", "");
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit, String archiveState) {
        return sessionQueries.listSessions(tenantId, actorId, beforeCreatedAt, beforeSessionId,
                limit, archiveState, "");
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit, String archiveState, String titleQuery) {
        return sessionQueries.listSessions(tenantId, actorId, beforeCreatedAt, beforeSessionId, limit, archiveState, titleQuery);
    }

    public Map<String, WebShellLifecycleOperation>
            findLatestLifecycleOperations(String tenantId, List<String> sessionIds) {
        return sessionQueries.findLatestLifecycleOperations(tenantId, sessionIds);
    }

    public Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId) {
        return sessionQueries.findTurn(tenantId, sessionId, turnId);
    }

    public Map<String, TurnSummary> findActiveTurns(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.findActiveTurns(tenantId, sessionIds);
    }

    public Map<String, TurnSummary> findLatestTurns(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.findLatestTurns(tenantId, sessionIds);
    }

    @Override
    public Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds) {
        return sessionQueries.findModelContexts(tenantId, sessionIds);
    }

    @Override
    public List<WebShellModelOption> modelOptions() {
        return sessionQueries.modelOptions();
    }

    @Override
    public Map<String, WebShellModelSelection> findModelSelections(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.findModelSelections(tenantId, sessionIds);
    }

    @Override
    public WebShellModelSelection findTurnModelSelection(String tenantId, String sessionId,
            String promptId) {
        return sessionQueries.findTurnModelSelection(tenantId, sessionId, promptId);
    }

    @Override
    @Transactional
    public WebShellModelChangeResult changeSessionModel(String tenantId, String actorId,
            String sessionId, String key, String digest, String modelId, long expectedRevision,
            boolean supported) {
        return sessionPolicies.changeSessionModel(tenantId, actorId, sessionId, key, digest, modelId, expectedRevision, supported);
    }

    @Override
    public Map<String, WebShellApprovalSelection> findApprovalSelections(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.findApprovalSelections(tenantId, sessionIds);
    }

    @Override
    public Set<String> findApprovalOwners(String tenantId, String actorId, List<String> sessionIds) {
        return sessionQueries.findApprovalOwners(tenantId, actorId, sessionIds);
    }

    @Override
    public WebShellApprovalSelection findTurnApprovalSelection(String tenantId, String sessionId,
            String promptId) {
        return sessionQueries.findTurnApprovalSelection(tenantId, sessionId, promptId);
    }

    @Override
    @Transactional
    public WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported) {
        return sessionPolicies.changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, null, false, false, null, false, false);
    }

    @Override
    @Transactional
    public WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean requestedPlanMode, boolean planModeSupported) {
        return sessionPolicies.changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, requestedPlanMode, planModeSupported, false, null, false, false);
    }

    @Override
    @Transactional
    public WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean requestedPlanMode, boolean planModeSupported,
            boolean liveSupported) {
        return sessionPolicies.changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, requestedPlanMode, planModeSupported, liveSupported,
                null, false, false);
    }

    @Override
    @Transactional
    public WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean requestedPlanMode, boolean planModeSupported,
            boolean liveSupported, Map<String, List<String>> requestedRules, boolean rulesSupported, boolean autoSupported) {
        return sessionPolicies.changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision, supported, agentDefinitionSupported, requestedPlanMode, planModeSupported, liveSupported, requestedRules, rulesSupported, autoSupported);
    }

    @Override
    public TurnPage listTurns(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTurnId, int limit) {
        return sessionQueries.listTurns(tenantId, sessionId, beforeCreatedAt, beforeTurnId, limit);
    }

    @Override
    public Optional<TurnSummary> findTurnSummary(String tenantId,
            String sessionId, String turnId) {
        return sessionQueries.findTurnSummary(tenantId, sessionId, turnId);
    }

    public List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit) {
        return eventJournal.findEvents(tenantId, sessionId, afterSequence, limit);
    }

    public Map<String, EventRecord> findLatestEnvironmentEvents(
            String tenantId, Map<String, TurnSummary> latestTurns) {
        return eventJournal.findLatestEnvironmentEvents(tenantId, latestTurns);
    }

    public List<EventRecord> findControlEvents(String tenantId,
            String sessionId, long throughSequence) {
        return eventJournal.findControlEvents(tenantId, sessionId, throughSequence);
    }

    public EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit) {
        return eventJournal.findTranscriptEvents(tenantId, sessionId, beforeSequence, limit);
    }

    @Override
    @Transactional(transactionManager = "managedAgentTransactionManager", readOnly = true,
            isolation = org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    public StoreModels.MessagePage findMessagePage(String tenantId, String sessionId,
            String cursor, int limit, boolean backward) {
        return messageProjection.findMessagePage(tenantId, sessionId, cursor, limit, backward, 0);
    }

    @Override
    @Transactional(transactionManager = "managedAgentTransactionManager", readOnly = true,
            isolation = org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    public StoreModels.MessagePage findMessagePage(String tenantId, String sessionId,
            String cursor, int limit, boolean backward, long afterSequence) {
        return messageProjection.findMessagePage(tenantId, sessionId, cursor, limit, backward, afterSequence);
    }

    public Map<String, Long> findMessageCoveredSequences(String tenantId,
            List<String> sessionIds) {
        return messageProjection.findMessageCoveredSequences(tenantId, sessionIds);
    }

    public ReplayWindow findReplayWindow(String tenantId, String sessionId) {
        return messageProjection.findReplayWindow(tenantId, sessionId);
    }

    public List<ReplayFloorTarget> findReplayFloorTargets(int limit) {
        return messageProjection.findReplayFloorTargets(limit);
    }

    @Transactional
    public ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence) {
        return messageProjection.advanceReplayFloor(tenantId, sessionId, floorSequence);
    }

    public List<MaterializationTarget> findMaterializationTargets(int limit) {
        return messageProjection.findMaterializationTargets(limit);
    }

    @Transactional
    public MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit) {
        return messageProjection.materializeNextBatch(tenantId, sessionId, limit);
    }

    @Override
    @Transactional
    public void deferMaterializationTarget(String tenantId,
            String sessionId) {
        messageProjection.deferMaterializationTarget(tenantId, sessionId);
    }

    public List<DispatchTarget> findDispatchable(long now, int limit) {
        return turnExecution.findDispatchable(now, limit);
    }

    public List<DispatchTarget> findRuntimeRecoveryParked(long now, int limit) {
        return turnExecution.findRuntimeRecoveryParked(now, limit);
    }

    @Transactional
    public Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        return turnExecution.claimTurn(tenantId, sessionId, turnId, owner, leaseDuration);
    }

    @Transactional
    public boolean renewTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        return turnExecution.renewTurn(tenantId, sessionId, turnId, owner, leaseDuration);
    }

    @Transactional
    public void releaseTurnLease(String tenantId, String sessionId,
            String turnId, String owner) {
        turnExecution.releaseTurnLease(tenantId, sessionId, turnId, owner);
    }

    @Override
    @Transactional
    public boolean markTurnRecoveryBlocked(String tenantId,
            String sessionId, String turnId, String owner,
            String errorCode, String errorMessage) {
        return turnExecution.markTurnRecoveryBlocked(tenantId, sessionId, turnId, owner, errorCode, errorMessage);
    }

    @Override
    @Transactional
    public boolean markTurnFailureRecovery(String tenantId, String sessionId,
            String turnId, String owner, String message) {
        return turnExecution.markTurnFailureRecovery(tenantId, sessionId, turnId, owner, message);
    }

    @Override
    @Transactional
    public boolean requestRecoveryRecheck(String tenantId, String sessionId,
            String turnId) {
        return turnExecution.requestRecoveryRecheck(tenantId, sessionId, turnId);
    }

    @Override
    @Transactional
    public boolean parkTurnForRuntimeRecovery(String tenantId,
            String sessionId, String turnId, String owner, String message,
            long retryAfter) {
        return turnExecution.parkTurnForRuntimeRecovery(tenantId, sessionId, turnId, owner, message, retryAfter);
    }

    @Override
    @Transactional
    public void deferTurnRetry(String tenantId, String sessionId,
            String turnId, String owner, long retryAfter) {
        turnExecution.deferTurnRetry(tenantId, sessionId, turnId, owner, retryAfter);
    }

    @Transactional
    public void scheduleTurnRetry(String tenantId, String sessionId,
            String turnId, String owner, long retryAfter,
            boolean budgetExempt) {
        turnExecution.scheduleTurnRetry(tenantId, sessionId, turnId, owner, retryAfter, budgetExempt);
    }

    @Transactional
    public boolean bindHarness(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId) {
        return turnExecution.bindHarness(tenantId, sessionId, turnId, owner, harnessBootId);
    }

    @Transactional
    public boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId) {
        return turnExecution.bindRecoveredHarness(tenantId, sessionId, turnId, owner, expectedHarnessBootId, harnessBootId);
    }

    @Transactional
    public void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner) {
        turnExecution.markSubmissionAttempted(tenantId, sessionId, turnId, owner);
    }

    @Transactional
    public boolean withdrawSubmissionAttempted(String tenantId,
            String sessionId, String turnId, String owner) {
        return turnExecution.withdrawSubmissionAttempted(tenantId, sessionId, turnId, owner);
    }

    @Transactional
    public void recordAdmission(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastEventId) {
        turnExecution.recordAdmission(tenantId, sessionId, turnId, owner, eventEpoch, lastEventId);
    }

    @Transactional
    public void recordRecoveryAdmission(String tenantId, String sessionId,
            String turnId, String owner, String expectedTurnEventEpoch,
            String expectedSessionEventEpoch, String eventEpoch,
            long lastEventId) {
        turnExecution.recordRecoveryAdmission(tenantId, sessionId, turnId, owner, expectedTurnEventEpoch, expectedSessionEventEpoch, eventEpoch, lastEventId);
    }

    @Transactional
    public void retractContinuationOutput(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId,
            String eventEpoch) {
        turnExecution.retractContinuationOutput(tenantId, sessionId, turnId, owner, harnessBootId, eventEpoch);
    }

    @Transactional
    public void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId) {
        turnExecution.retractHarnessTurnOutput(tenantId, sessionId, turnId, owner, eventEpoch, fromSourceId,
                retractionSourceId, null, null, null);
    }

    @Transactional
    public void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId, String sourceBootId,
            String sourceEventEpoch, Long throughSourceId) {
        turnExecution.retractHarnessTurnOutput(tenantId, sessionId, turnId, owner, eventEpoch, fromSourceId, retractionSourceId, sourceBootId, sourceEventEpoch, throughSourceId);
    }

    @Transactional
    public void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events) {
        turnExecution.recordHarnessEvents(tenantId, sessionId, turnId, owner, eventEpoch, events);
    }

    @Override
    @Transactional
    public boolean cancelUnadmittedTurn(String tenantId, String sessionId,
            String turnId, String owner) {
        return turnExecution.cancelUnadmittedTurn(tenantId, sessionId, turnId, owner);
    }

    @Transactional
    public void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner) {
        turnExecution.cancelBeforeAdmission(tenantId, sessionId, turnId, owner);
    }

    @Transactional
    public void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message) {
        turnExecution.failTurn(tenantId, sessionId, turnId, owner, code, message);
    }

    @Transactional
    public void failWorktreeInitialTurns(String tenantId, String sessionId, String code) {
        turnExecution.failWorktreeInitialTurns(tenantId, sessionId, code);
    }

    @Transactional
    public boolean failRecoveryBlockedTurn(String tenantId, String sessionId,
            String turnId, String owner, String message) {
        return turnExecution.failRecoveryBlockedTurn(tenantId, sessionId, turnId, owner, message);
    }

    @Transactional
    public void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey) {
        eventJournal.appendPublicEventIfAbsent(tenantId, sessionId, turnId, type, data, terminal, sourceKey);
    }

    @Transactional
    public void appendLiveSessionEventIfAbsent(String tenantId,
            String sessionId, String type, Map<String, Object> data,
            String sourceKey) {
        eventJournal.appendLiveSessionEventIfAbsent(tenantId, sessionId, type, data, sourceKey);
    }

    @Override
    public Optional<String> findLastVisibleStatusBeforeDelete(String tenantId,
            String sessionId) {
        return sessionQueries.findLastVisibleStatusBeforeDelete(tenantId, sessionId);
    }

    public SessionRecord requireSession(String tenantId, String sessionId) {
        return sessionQueries.requireSession(tenantId, sessionId);
    }

    public static ContextBinding readBinding(java.sql.ResultSet result)
            throws java.sql.SQLException {
        return AgentStoreRows.readBinding(result);
    }

    @Override
    @Transactional
    public Admission insertSessionCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return AgentStateStore.super.insertSessionCommand(tenantId, operation, idempotencyKey, requestDigest, agentId, requestedRevision, title, input, payloadDigest);
    }

    @Override
    @Transactional
    public Admission insertSessionCommand(String tenantId, SessionPrincipal principal,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return sessionAdmissions.insertSessionCommand(tenantId, principal, operation,
                idempotencyKey, requestDigest, agentId, requestedRevision, title, input, payloadDigest);
    }

    @Override
    @Transactional
    public Admission insertSessionCommand(String tenantId, SessionPrincipal principal,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest, SessionModelConfig modelConfig) {
        return sessionAdmissions.insertSessionCommand(tenantId, principal, operation,
                idempotencyKey, requestDigest, agentId, requestedRevision, title, input, payloadDigest, modelConfig);
    }

    @Override
    public void requireSessionOwnership(String tenantId, String sessionId, SessionPrincipal principal) {
        sessionQueries.requireSessionOwnership(tenantId, sessionId, principal);
    }

    @Override
    public boolean ownsSession(String tenantId, String sessionId, SessionPrincipal principal) {
        return sessionQueries.ownsSession(tenantId, sessionId, principal);
    }

    @Override
    @Transactional
    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest, SessionPrincipal principal) {
        return sessionCommands.insertTurnCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, input, payloadDigest, principal);
    }

    @Override
    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, SessionPrincipal principal) {
        return sessionCommands.insertCancelCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, turnId, principal);
    }

    @Override
    @Transactional
    public SessionMutationCommand beginSessionRename(String tenantId, String key,
            String digest, String sessionId, String title, String actorId, SessionPrincipal principal) {
        return sessionCommands.beginSessionRename(tenantId, key, digest, sessionId, title, actorId, principal);
    }

    @Override
    @Transactional
    public SessionMutationCommand beginSessionMutation(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            SessionMutationKind kind, String actorId, SessionPrincipal principal) {
        return sessionCommands.beginSessionMutation(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, kind, actorId, principal);
    }

    @Override
    public SessionPage listSessions(String tenantId, SessionPrincipal principal,
            Long beforeCreatedAt, String beforeSessionId, int limit, String archiveState, String titleQuery) {
        return sessionQueries.listSessions(tenantId, principal, beforeCreatedAt, beforeSessionId,
                limit, archiveState, titleQuery);
    }

    @Override
    public SessionPage listOwnedSessions(String tenantId, SessionPrincipal principal,
            Long beforeCreatedAt, String beforeSessionId, int limit, String archiveState, String titleQuery) {
        return sessionQueries.listOwnedSessions(tenantId, principal, beforeCreatedAt, beforeSessionId,
                limit, archiveState, titleQuery);
    }
}
