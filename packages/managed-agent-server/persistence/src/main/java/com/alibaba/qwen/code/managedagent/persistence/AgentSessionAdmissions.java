package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

final class AgentSessionAdmissions {
    private final AgentEventJournal eventJournal;
    private final AgentSessionCommands sessionCommands;
    private final AgentSessionPolicies sessionPolicies;
    private final AgentStoreRows storeRows;
    private final JdbcManagedExtensionRecordStore configRecords;
    private final ManagedSessionModelConfigs modelConfigs;
    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final String approvalMode;
    private final JdbcManagedWorkspaceRegistry workspaces;
    private final String agentRevision;
    private final List<WebShellModelOption> modelCatalog;
    private final JdbcManagedAgentDefinitionStore definitions;
    private final JdbcManagedSessionSkills creationSkills;
    private final JdbcSessionWorktreeStore sessionWorktrees;
    private final com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages extensionPackages;
    private final boolean workspaceFilesEnabled;
    private final boolean workspaceShellEnabled;
    private final boolean workspaceChildAgentsEnabled;
    private final boolean managedExtensionExecutionEnabled;
    private final List<? extends ManagedAgentSettings.RuntimeBroker.WorkspaceMount> workspaceMounts;
    private final ResidentWorkspaces residentWorkspaces;
    private final WorkspaceCreationRoots createdRoots;
    private final JournalEventTransport journalEventTransport;
    private final boolean journalEventTransportEnabled;

    AgentSessionAdmissions(AgentEventJournal eventJournal,
            AgentSessionCommands sessionCommands,
            AgentSessionPolicies sessionPolicies,
            AgentStoreRows storeRows,
            JdbcManagedExtensionRecordStore configRecords,
            JdbcTemplate jdbc,
            Clock clock,
            String approvalMode,
            JdbcManagedWorkspaceRegistry workspaces,
            String agentRevision,
            List<WebShellModelOption> modelCatalog,
            JdbcManagedAgentDefinitionStore definitions,
            JdbcManagedSessionSkills creationSkills,
            JdbcSessionWorktreeStore sessionWorktrees,
            com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages extensionPackages,
            boolean workspaceFilesEnabled,
            boolean workspaceShellEnabled,
            boolean workspaceChildAgentsEnabled,
            boolean managedExtensionExecutionEnabled,
            List<? extends ManagedAgentSettings.RuntimeBroker.WorkspaceMount> workspaceMounts,
            ResidentWorkspaces residentWorkspaces,
            WorkspaceCreationRoots createdRoots,
            JournalEventTransport journalEventTransport,
            boolean journalEventTransportEnabled, ManagedSessionModelConfigs modelConfigs) {
        this.eventJournal = eventJournal;
        this.sessionCommands = sessionCommands;
        this.sessionPolicies = sessionPolicies;
        this.storeRows = storeRows;
        this.configRecords = configRecords;
        this.modelConfigs = modelConfigs;
        this.jdbc = jdbc;
        this.clock = clock;
        this.approvalMode = approvalMode;
        this.workspaces = workspaces;
        this.agentRevision = agentRevision;
        this.modelCatalog = modelCatalog;
        this.definitions = definitions;
        this.creationSkills = creationSkills;
        this.sessionWorktrees = sessionWorktrees;
        this.extensionPackages = extensionPackages;
        this.workspaceFilesEnabled = workspaceFilesEnabled;
        this.workspaceShellEnabled = workspaceShellEnabled;
        this.workspaceChildAgentsEnabled = workspaceChildAgentsEnabled;
        this.managedExtensionExecutionEnabled = managedExtensionExecutionEnabled;
        this.workspaceMounts = workspaceMounts;
        this.residentWorkspaces = residentWorkspaces;
        this.createdRoots = createdRoots;
        this.journalEventTransport = journalEventTransport;
        this.journalEventTransportEnabled = journalEventTransportEnabled;
    }

    Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest, SessionModelConfig modelConfig, String memoryStoreId) {
        requireModelConfiguration(modelConfig);
        AgentSessionPolicies.AgentPin pin = sessionPolicies.resolveAgentPin(tenantId, agentId, requestedRevision,
                false);
        requireCreationScope(tenantId, idempotencyKey, false);
        Admission admission = insertSession(tenantId, operation, idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                null, actorId, pin);
        ManagedMemoryStore.bind(jdbc, tenantId, actorId, admission.sessionId(), memoryStoreId);
        if (modelConfig != null) {
            modelConfigs.save(tenantId, admission.sessionId(), modelConfig);
        }
        return admission;
    }

    Admission insertWorkspaceSessionCommand(SessionCreationCommand command) {
        String tenantId = command.tenantId();
        String actorId = command.actorId();
        String idempotencyKey = command.idempotencyKey();
        String requestDigest = command.requestDigest();
        String agentId = command.agentId();
        String requestedRevision = command.requestedRevision();
        String title = command.title();
        List<Map<String, Object>> input = command.input();
        String payloadDigest = command.payloadDigest();
        WorkspaceSelection selection = command.selection();
        boolean approvalSelectionSupported = command.approvalSelectionSupported();
        Boolean requestedPlanMode = command.requestedPlanMode();
        boolean planModeSupported = command.planModeSupported();
        List<Map<String, Object>> skills = command.skills();
        boolean publicChildrenSupported = command.publicChildrenSupported();
        String modelId = command.modelId();
        List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> extensionPins =
                command.extensionPins();
        Set<String> extensionLifecycleProfiles = command.extensionLifecycleProfiles();
        JdbcSessionWorktreeStore.Plan worktree = command.worktree();
        SessionModelConfig modelConfig = command.modelConfig();
        if (!input.isEmpty() && !workspaceFilesEnabled) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        // InnoDB's first consistent read must follow the creation's first lock.
        // A selection that may resolve to a Resident Workspace keeps the tenant
        // guard first: its single-Session range lock can deadlock adjacent
        // Workspaces' inserts. Other creations lock the selected Workspace
        // before reading receipts, as resolveForCreation does below. Explicit
        // selections lock one Workspace; default selections retain the tenant
        // scan to preserve the lock order with default switches (see design
        // 2026-11-04-managed-session-admission-tenant-guard).
        if (residentWorkspaces.mayContain(tenantId,
                selection == null ? null : selection.workspaceId())) {
            WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        }
        workspaces.lockSelectionForCreation(tenantId, selection);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (!existing.isEmpty()) {
            return replayWorkspaceCommand(tenantId, actorId,
                    requestDigest, existing.getFirst(), false);
        }
        if (modelConfig != null && modelId != null) {
            throw new ManagedAgentException(400, "invalid_model_config", "Choose either a model ID or a complete configuration.");
        }
        if (modelId != null && (!"qwen-code".equals(agentId) || !workspaceFilesEnabled
                || modelCatalog.stream().noneMatch(option -> option.modelId().equals(modelId)))) {
            throw new ManagedAgentException(400, "unsupported_model",
                    "The model is not published for this Agent.");
        }
        AgentSessionPolicies.AgentPin resolvedPin = sessionPolicies.resolveAgentPin(tenantId, agentId, requestedRevision, true);
        requireCreationScope(tenantId, idempotencyKey, true);
        ResolvedBinding workspace = workspaces.resolveForCreation(tenantId, actorId, selection);
        boolean external = workspaces.isExternal(workspace.binding());
        AgentSessionPolicies.AgentPin pin = ExternalWorkspaceSessionPolicies.creationPin(external, workspaces, workspace.binding(), resolvedPin, command);
        boolean planMode = Boolean.TRUE.equals(requestedPlanMode);
        if (planMode && (!planModeSupported || !approvalSelectionSupported
                || pin.hooks() || pin.mcp() || !(WorkspaceToolProfiles.FILES.equals(pin.toolProfile())
                || WorkspaceToolProfiles.isPublicShell(pin.toolProfile())))) {
            throw new ManagedAgentException(409, "unsupported_feature", "Plan mode is unavailable");
        }
        if (!input.isEmpty() && WorkspaceToolProfiles.isPublicShell(pin.toolProfile())
                && !workspaceShellEnabled) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        requireModelConfiguration(modelConfig);
        if (extensionPins != null) {
            if (extensionPackages == null) {
                throw AgentSessionPolicies.workspaceExecutionUnavailable();
            }
            if ((!WorkspaceToolProfiles.isPublicShell(pin.toolProfile()) && !WorkspaceToolProfiles.MCP.equals(pin.toolProfile()))
                    || !extensionLifecycleProfiles.contains(pin.toolProfile())) {
                throw new ManagedAgentException(409, "unsupported_feature",
                        "Extension configuration requires a negotiated Shell or MCP Session lifecycle profile.");
            }
            extensionPackages.requireSelection(tenantId, actorId, workspace.binding().getWorkspaceId(), extensionPins, command.extensionSelection());
        }
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, workspace.binding().getStorageId());
        boolean sshWorkspace = sessionPolicies.isSshWorkspace(workspace.binding());
        if (sshWorkspace) {
            AgentSessionPolicies.requireSshToolProfile(pin.toolProfile());
            if (pin.mcp()) {
                throw AgentSessionPolicies.workspaceExecutionUnavailable();
            }
        }
        boolean resident = residentWorkspaces.find(workspace.binding()) != null;
        if (resident) {
            if (!workspaceFilesEnabled) {
                throw AgentSessionPolicies.workspaceExecutionUnavailable();
            }
            residentWorkspaces.requireCreation(jdbc, workspace.binding(), pin.toolProfile());
        } else if (!sshWorkspace && !external) {
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, workspace.binding().getStorageId());
        }
        if (!resident && !input.isEmpty()
                && (!WorkspaceExecutionProfile.CONFIG_REF.equals(workspace.configRef())
                        || !WorkspaceExecutionProfile.POLICY_REF.equals(workspace.policyRef())
                        || !sshWorkspace && !external && !configuredStorage(tenantId, workspace.binding().getStorageId()))) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        List<Map<String, Object>> merged = new ArrayList<>();
        if (!skills.isEmpty() && pin.digest() != null) {
            merged.addAll(AgentDefinitionExtensions.skills(storeRows.readMap(definitions.find(tenantId, agentId,
                    Long.parseLong(pin.revision())).orElseThrow().definitionJson()).get("skills"), true));
        }
        merged.addAll(skills);
        var effectiveSkills = AgentDefinitionExtensions.sessionSkills(merged);
        if (worktree != null && sessionWorktrees == null) {
            throw new ManagedAgentException(409, "worktree_unavailable", "Session worktrees are unavailable.");
        }
        ResolvedBinding target = worktree == null ? workspace : worktree.target(workspace);
        Admission admission = insertSession(tenantId, "CREATE_SESSION", idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                target, actorId, pin, null, planMode, modelId);
        ManagedMemoryStore.bind(jdbc, tenantId, actorId, admission.sessionId(), command.memoryStoreId());
        if (modelConfig != null) {
            modelConfigs.save(tenantId, admission.sessionId(), modelConfig);
        }
        if (worktree != null) {
            sessionWorktrees.admit(tenantId, actorId, admission.sessionId(), worktree, workspace);
        }
        if (workspaceChildAgentsEnabled && publicChildrenSupported && !resident && (!sshWorkspace || managedExtensionExecutionEnabled)
                && (managedExtensionExecutionEnabled || "qwen-code".equals(agentId) && pin.digest() == null)
                && WorkspaceToolProfiles.isPublicShell(pin.toolProfile())) {
            jdbc.update("UPDATE ma_session SET public_child_agents_version=1 WHERE tenant_id=? AND session_id=?",
                    tenantId, admission.sessionId());
        }
        if (!skills.isEmpty()) {
            creationSkills.save(tenantId, admission.sessionId(), effectiveSkills);
        }
        if (extensionPins != null) {
            creationSkills.saveInitialSelection(tenantId, admission.sessionId(), extensionPins);
        }
        return admission;
    }

    private void requireModelConfiguration(SessionModelConfig config) {
        if (config != null) {
            if (modelConfigs == null) {
                throw new ManagedAgentException(409, "model_config_unavailable", "The Session model configuration is unavailable.");
            }
            modelConfigs.requireAdmission(config);
        }
    }

    boolean configuredStorage(String tenant, String storage) {
        return workspaceMounts.stream().anyMatch(mount -> tenant.equals(mount.tenantId())
                && storage.equals(mount.storageId())) || createdRoots.resolve(tenant, storage, false) != null;
    }

    /** Trusted internal creation; public requests and definitions cannot select this policy. */
    Admission insertInternalTeamLeadSessionCommand(String tenantId,
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
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        requireCreationScope(tenantId, idempotencyKey, true);
        ResolvedBinding workspace = workspaces.resolveForCreation(tenantId, actorId, selection);
        WorkspaceMigrationAdmission.requireOpen(jdbc, tenantId, workspace.binding().getStorageId());
        if (!WorkspaceExecutionProfile.CONFIG_REF.equals(workspace.configRef())
                || !WorkspaceExecutionProfile.POLICY_REF.equals(workspace.policyRef())
                || !configuredStorage(tenantId, workspace.binding().getStorageId())) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        return insertSession(tenantId, "CREATE_SESSION", idempotencyKey, requestDigest,
                "qwen-code", title, List.of(), null, workspace, actorId,
                new AgentSessionPolicies.AgentPin(agentRevision, null, approvalMode, WorkspaceToolProfiles.INTERNAL_TEAM_LEAD, false, false));
    }

    Optional<Admission> findWorkspaceCreateReplay(String tenantId,
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

    Admission replayWorkspaceSessionCommand(String tenantId,
            String actorId, String idempotencyKey, String requestDigest) {
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (existing.isEmpty()) {
            throw new ManagedAgentException(409,
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
        requireCsiJournalIsolation();
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
        AgentSessionPolicies.AgentPin pin = sessionPolicies.resolveAgentPin(tenantId, "qwen-code", requestedRevision, true);
        ResolvedBinding workspace = workspaces.resolveForCreation(tenantId, actorId, selection);
        if (!registration.storageId().equals(workspace.binding().getStorageId())
                || !CsiFilesRetirementProfile.CONFIG_REF.equals(workspace.configRef())
                || !CsiFilesRetirementProfile.POLICY_REF.equals(workspace.policyRef())) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
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

    void requireCsiJournalIsolation() {
        if (journalEventTransportEnabled || journalEventTransport != null) {
            throw new ManagedAgentException(409, "csi_journal_transport_unsupported",
                    "The private CSI lane requires an isolated journal without an event transport.");
        }
    }

    RuntimeProvisionRequest requireCsiRequest(
            WorkspaceCsiRegistration registration, String sessionId) {
        requireCsiJournalIsolation();
        SessionRecord session = storeRows.requireSessionForUpdate(registration.tenantId(), sessionId);
        if (!CsiFilesRetirementProfile.isProfile(session.toolProfile())
                || session.workspace() == null
                || !"qwen-code".equals(session.agentId())
                || !CsiFilesRetirementProfile.CONTEXT_CONFIG_REF.equals(
                        session.workspace().getContextConfigRef())
                || !registration.storageId().equals(session.workspace().getStorageId())) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        RuntimeProvisionRequest request =
                CsiFilesRetirementProfile.request(
                        session.workspace(), registration.mountRoot(), session.sessionId(), session.toolProfile());
        String saved =
                jdbc.queryForObject(
                        "SELECT runtime_request_key FROM ma_session"
                                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                        String.class,
                        session.tenantId(),
                        session.sessionId());
        if (!request.requestKey().equals(saved)) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        return request;
    }

    Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        return insertChildSession(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage, null, null);
    }

    Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        if (childCwdRelative == null) {
            throw new IllegalArgumentException("An isolated child needs its Workspace directory");
        }
        return insertChildSession(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage,
                childCwdRelative, null);
    }

    Admission insertPublicChildSessionCommand(String tenantId, String parentSessionId,
            String idempotencyKey, String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage, com.fasterxml.jackson.databind.JsonNode snapshot) {
        return insertChildSession(tenantId, parentSessionId, idempotencyKey, requestDigest,
                title, input, payloadDigest, lineage, null, snapshot);
    }

    Admission insertChildSession(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative, com.fasterxml.jackson.databind.JsonNode snapshot) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                ChildSessionCreation.childActorOf(parentSessionId), idempotencyKey);
        if (existing.isEmpty()) {
            WorkspaceMigrationAdmission.requireSessionOpen(jdbc, tenantId, parentSessionId);
        }
        SessionRecord parent = storeRows.requireSessionForUpdate(tenantId,
                parentSessionId);
        if (parent.workspace() == null || residentWorkspaces.find(parent.workspace()) != null || !"ACTIVE".equals(parent.status())
                || CsiFilesRetirementProfile.isProfile(parent.toolProfile())) {
            throw new ManagedAgentException(409,
                    "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        if (parent.publicChildAgentsVersion() == 1) {
            if (snapshot == null || !snapshot.path("version").isIntegralNumber() || !Set.of(1, 2).contains(snapshot.path("version").asInt()) || lineage.depth() != 1
                    || childCwdRelative != null || snapshot.size() != (snapshot.path("version").asInt() == 2 ? 9 : 8)
                    || !snapshot.path("sourcePromptId").isTextual() || snapshot.path("sourcePromptId").asText().isBlank()
                    || snapshot.path("sourcePromptId").asText().length() > 144
                    || !Set.of("default", "auto-edit", "yolo").contains(snapshot.path("approvalMode").asText())
                    || !snapshot.path("approvalRevision").isIntegralNumber() || snapshot.path("approvalRevision").asLong(-1) < 0
                    || !snapshot.path("approvalRevision").canConvertToLong() || snapshot.path("approvalRevision").asLong() > 9_007_199_254_740_991L
                    || !snapshot.path("modelId").isTextual() || snapshot.path("modelId").asText().isBlank()
                    || snapshot.path("modelId").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 512
                    || !snapshot.path("modelRevision").isIntegralNumber() || snapshot.path("modelRevision").asLong(-1) < 0
                    || !snapshot.path("modelRevision").canConvertToLong() || snapshot.path("modelRevision").asLong() > 9_007_199_254_740_991L
                    || !snapshot.has("skillsRef") || snapshot.path("modelRoute").size() != (snapshot.path("modelRoute").has("origin") ? 4 : 3)
                    || !snapshot.path("modelRoute").path("authType").isTextual()
                    || !snapshot.path("modelRoute").path("authType").asText().matches("[a-z][a-z0-9_-]{0,63}")
                    || !snapshot.path("modelRoute").path("endpointDigest").isTextual()
                    || !snapshot.path("modelRoute").path("endpointDigest").asText().matches("[a-f0-9]{64}")
                    || !snapshot.path("modelRoute").path("providerPin").isTextual()
                    || !snapshot.path("modelRoute").path("providerPin").asText().matches("[a-f0-9]{64}")) {
                throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "The public child launch snapshot is invalid");
            }
            if (snapshot.path("version").asInt() == 2) {
                if (configRecords == null) {
                    throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "Package agent validation is unavailable");
                }
                ManagedExtensionAgentLaunch.require(jdbc, configRecords, parent, snapshot);
            }
            if (snapshot.path("modelRoute").has("origin")) {
                var origin = snapshot.path("modelRoute").get("origin");
                if (origin.size() != 4 || !origin.path("modelId").isTextual() || origin.path("modelId").asText().isBlank()
                        || origin.path("modelId").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 512
                        || !origin.path("authType").isTextual()
                        || !origin.path("authType").asText().matches("[a-z][a-z0-9_-]{0,63}")
                        || !origin.path("endpointDigest").isTextual()
                        || !origin.path("endpointDigest").asText().matches("[a-f0-9]{64}")
                        || !origin.path("providerPin").isTextual()
                        || !origin.path("providerPin").asText().matches("[a-f0-9]{64}")) {
                    throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "The public child model origin is invalid");
                }
            }
        } else if (snapshot != null) {
            throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "The parent has no public child admission");
        }
        storeRows.requireLegacyMutation(tenantId, parentSessionId);
        if (!input.isEmpty() && !workspaceFilesEnabled) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        if (!existing.isEmpty()) {
            WorkspaceCommand command = existing.getFirst();
            if (!command.requestDigest().equals(requestDigest)) {
                throw new ManagedAgentException(409,
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
        // addressed by the parent's launch row's unique business key, which
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
            throw new ManagedAgentException(409, "child_run_settled",
                    "The child run already settled; creation owes no more Session.");
        }
        // A child bound to a snapshot reads with the read-only profile
        // whatever its parent's is (#13753 I3): the mode comes from the row
        // this transaction locks, so no caller can bind a snapshot copy to
        // a profile that writes. Only the profile differs from the parent.
        String toolProfile = null;
        if (childCwdRelative != null
                && JdbcChildWorkspaceStore.SNAPSHOT.equals(requireReadyChildWorkspace(
                        tenantId, parentSessionId, lineage.parentChildRunId(),
                        parent.workspace(), childCwdRelative))) {
            toolProfile = WorkspaceToolProfiles.READ;
        }
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
        String turnId = input.isEmpty() ? null : AgentStoreRows.publicId("turn");
        String promptId = input.isEmpty() ? null : UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, agent_revision,"
                        + " agent_definition_digest, title,"
                        + " status, gmt_create, gmt_modified, workspace_id,"
                        + " workspace_generation, workspace_storage_id,"
                        + " cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref,"
                        + " workspace_policy_ref, tool_profile,"
                        + " creator_actor_key, owner_actor_key, owner_only, approval_mode,"
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
                        + ", creator_actor_key, COALESCE(owner_actor_key, creator_actor_key), owner_only, approval_mode,"
                        + " ?, ?, ?, ?"
                        + " FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                ChildSessionCreation.childInsertArgs(sessionId, title, now, childCwdRelative,
                        toolProfile, lineage, tenantId, parentSessionId));
        jdbc.update("INSERT INTO ma_event_stream"
                        + " (tenant_id, session_id, stream_kind, stream_id,"
                        + " covered_sequence, gmt_modified) VALUES"
                        + " (?, ?, 'SESSION', '', 0, ?)",
                tenantId, sessionId, now);
        if (parent.modelConfigDigest() != null) {
            if (modelConfigs == null) {
                throw new ManagedAgentException(409, "model_config_unavailable", "The Session model configuration is unavailable.");
            }
            modelConfigs.inherit(tenantId, parentSessionId, sessionId);
        }
        if (snapshot != null) {
            byte[] owner = jdbc.queryForObject("SELECT COALESCE(owner_actor_key, creator_actor_key) FROM ma_session WHERE tenant_id=? AND session_id=?", byte[].class, tenantId, parentSessionId);
            jdbc.update("UPDATE ma_session SET public_child_agents_version=1, owner_actor_key=?, approval_mode=?, selected_approval_mode=NULL, approval_revision=0, model_id=?, model_revision=1 WHERE tenant_id=? AND session_id=?",
                    owner, snapshot.path("approvalMode").asText(), snapshot.path("modelId").asText(), tenantId, sessionId);
        }
        if (turnId != null) {
            sessionCommands.insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
            SideQueryConversation.mainInputAccepted(jdbc, tenantId, sessionId);
        }
        ManagedReceipts.insertCreation(jdbc, tenantId,
                ManagedWorkspaceRegistry.actorKey(tenantId, ChildSessionCreation.childActorOf(parentSessionId)),
                idempotencyKey, requestDigest, sessionId, turnId, now);
        var inheritedSkills = snapshot == null ? creationSkills.snapshot(tenantId, parentSessionId)
                : creationSkills.fromLaunchReference(tenantId, parentSessionId, snapshot.path("skillsRef"));
        if (inheritedSkills != null) {
            creationSkills.save(tenantId, sessionId, inheritedSkills);
        }
        eventJournal.appendEvent(tenantId, sessionId, null, "session.created",
                Map.of("sessionId", sessionId), false, null, now);
        if (turnId != null) {
            eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                    AgentEventJournal.acceptedData(turnId, input), false, null, now);
        }
        return new Admission(sessionId, turnId, false, true);
    }

    /**
     * Decision 13 of the isolation slice: an isolated child binds only to a ready, unfinished child
     * Workspace prepared from the parent's current Workspace and storage. The locking read
     * serializes the creation against a finish request, which locks the same row. Answers
     * the row's mode (#13753 I3), which its operation's request fixed when it was admitted.
     */
    String requireReadyChildWorkspace(String tenantId,
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
            throw new ManagedAgentException(409, "child_workspace_not_ready",
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
            throw new ManagedAgentException(409, "child_workspace_not_ready",
                    "The child run's Workspace is not ready to bind a child Session.");
        }
        return JdbcChildWorkspaceStore.workspaceMode(requests.getFirst());
    }

    Admission replayChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest) {
        SessionRecord parent = storeRows.requireSessionForUpdate(tenantId, parentSessionId);
        if (CsiFilesRetirementProfile.isProfile(parent.toolProfile())) {
            throw new ManagedAgentException(
                    409,
                    "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        storeRows.requireLegacyMutation(tenantId, parentSessionId);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                ChildSessionCreation.childActorOf(parentSessionId), idempotencyKey);
        if (existing.isEmpty()) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict", "The creation command is missing.");
        }
        WorkspaceCommand command = existing.getFirst();
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        return new Admission(command.sessionId(), command.turnId(), true,
                false);
    }

    Admission replayWorkspaceCommand(String tenantId, String actorId,
            String requestDigest, WorkspaceCommand command, boolean internalTeamLead) {
        SessionRecord session = storeRows.requireSession(tenantId, command.sessionId());
        if (!command.requestDigest().equals(requestDigest)
                || internalTeamLead != WorkspaceToolProfiles.INTERNAL_TEAM_LEAD.equals(session.toolProfile())
                || internalTeamLead && (!"qwen-code".equals(session.agentId())
                        || session.agentDefinitionDigest() != null)) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        ContextBinding bound = session.workspace();
        if (bound == null) {
            throw new ManagedAgentException(409,
                    "workspace_unavailable", "Workspace binding is missing.");
        }
        if (!workspaces.canRead(tenantId, actorId, bound.getWorkspaceId())) {
            throw new ManagedAgentException(404,
                    "workspace_not_found", "Workspace not found.");
        }
        return new Admission(command.sessionId(), command.turnId(), true,
                false);
    }

    // H2 truncates bare BINARY casts; the suffix also prevents NUL-padding aliases.
    List<WorkspaceCommand> findWorkspaceCommand(String tenantId,
            String actorId, String idempotencyKey) {
        ManagedReceipts.Receipt row = ManagedReceipts.creation(jdbc, tenantId,
                ManagedWorkspaceRegistry.actorKey(tenantId, actorId), idempotencyKey);
        return row == null
                ? List.of()
                : List.of(
                        new WorkspaceCommand(
                                row.requestDigest(), row.sessionId(), row.turnId()));
    }

    record WorkspaceCommand(String requestDigest, String sessionId,
            String turnId) {
    }

    void requireCreationScope(String tenantId, String idempotencyKey, boolean workspaceBound) {
        var namespace = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_MODE;
        var scope = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope.TENANT;
        try {
            ManagedReceipts.insert(jdbc, namespace, tenantId, scope, tenantId, idempotencyKey,
                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(Boolean.toString(workspaceBound)),
                    null, null, null, null, "RESERVED", null, workspaceBound, clock.millis());
        } catch (DuplicateKeyException existing) {
            // The independently persisted creation-mode claim cannot be overwritten by replay.
        }
        ManagedReceipts.Receipt existing = ManagedReceipts.find(jdbc, namespace, tenantId, scope,
                tenantId, idempotencyKey, true);
        if (existing == null
                || !Boolean.valueOf(workspaceBound).equals(existing.workspaceBound())) {
            throw new ManagedAgentException(409, "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
    }

    Admission insertSession(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved,
            String actorId, AgentSessionPolicies.AgentPin pin) {
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

    Admission insertSession(
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
            AgentSessionPolicies.AgentPin pin,
            WorkspaceCsiRegistration registration) {
        return insertSession(tenantId, operation, idempotencyKey, requestDigest, agentId, title,
                input, payloadDigest, resolved, actorId, pin, registration, false);
    }

    Admission insertSession(String tenantId, String operation, String idempotencyKey,
            String requestDigest, String agentId, String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved, String actorId, AgentSessionPolicies.AgentPin pin,
            WorkspaceCsiRegistration registration, boolean planMode) {
        return insertSession(tenantId, operation, idempotencyKey, requestDigest, agentId, title,
                input, payloadDigest, resolved, actorId, pin, registration, planMode, null);
    }

    Admission insertSession(String tenantId, String operation, String idempotencyKey,
            String requestDigest, String agentId, String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved, String actorId, AgentSessionPolicies.AgentPin pin,
            WorkspaceCsiRegistration registration, boolean planMode, String modelId) {
        ContextBinding workspace = resolved == null ? null
                : resolved.binding();
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
        String runtimeRequestKey =
                registration == null
                        ? null
                        : CsiFilesRetirementProfile.request(
                                        workspace, registration.mountRoot(), sessionId, CsiFilesRetirementProfile.ACTIVITY_PROFILE)
                                .requestKey();
        String turnId = input.isEmpty() ? null : AgentStoreRows.publicId("turn");
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
                        + " is_plan_enabled, selected_approval_mode, approval_revision, model_id, model_revision) VALUES"
                        + " (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                        ? CsiFilesRetirementProfile.ACTIVITY_PROFILE
                        : workspace == null ? null : pin.toolProfile(),
                actorKey, actorKey,
                runtimeRequestKey, workspace != null || pin.digest() != null ? pin.approvalMode() : "yolo",
                planMode, planMode ? pin.approvalMode() : null, planMode ? 1 : 0, modelId, modelId == null ? 0 : 1);
        jdbc.update("INSERT INTO ma_event_stream"
                        + " (tenant_id, session_id, stream_kind, stream_id,"
                        + " covered_sequence, gmt_modified) VALUES"
                        + " (?, ?, 'SESSION', '', 0, ?)",
                tenantId, sessionId, now);
        if (turnId != null) {
            sessionCommands.insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
            SideQueryConversation.mainInputAccepted(jdbc, tenantId, sessionId);
        }
        if (resolved == null) {
            sessionCommands.insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                    sessionId, turnId, now);
        } else {
            ManagedReceipts.insertCreation(jdbc, tenantId, actorKey,
                    idempotencyKey, requestDigest, sessionId, turnId, now);
        }
        eventJournal.appendEvent(tenantId, sessionId, null, "session.created",
                Map.of("sessionId", sessionId), false, null, now);
        if (turnId != null) {
            eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                    AgentEventJournal.acceptedData(turnId, input), false, null, now);
        }
        return new Admission(sessionId, turnId, false, true);
    }
}
