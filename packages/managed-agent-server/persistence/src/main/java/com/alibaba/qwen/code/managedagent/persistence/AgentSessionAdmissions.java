package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.StandaloneSkill;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

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
    private final WorkspaceCreationRoots createdRoots;
    private final ChildSessionAdmissions childSessionAdmissions;

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
            WorkspaceCreationRoots createdRoots, ManagedSessionModelConfigs modelConfigs) {
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
        this.createdRoots = createdRoots;
        this.childSessionAdmissions = new ChildSessionAdmissions(jdbc, clock,
                storeRows, eventJournal, sessionCommands, configRecords,
                modelConfigs, creationSkills, workspaceFilesEnabled);
    }

    ChildSessionAdmissions childSessionAdmissions() {
        return childSessionAdmissions;
    }

    Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return insertSessionCommand(tenantId, actorId, operation, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest, null);
    }

    Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest, SessionModelConfig modelConfig) {
        return insertSessionCommand(tenantId, actorId, operation, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest,
                modelConfig, null);
    }

    Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            SessionModelConfig modelConfig, String memoryStoreId) {
        return insertSessionCommand(tenantId,
                actorId == null ? null
                        : SessionPrincipal.ofUser(tenantId, actorId),
                operation, idempotencyKey, requestDigest, agentId,
                requestedRevision, title, input, payloadDigest, modelConfig,
                memoryStoreId);
    }

    Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return insertSessionCommand(tenantId, principal, operation,
                idempotencyKey, requestDigest, agentId, requestedRevision,
                title, input, payloadDigest, null);
    }

    /**
     * Ownership-enforcing creation of an unbound Session, with or without a
     * model configuration. The ownership row lands in the same transaction
     * as the Session, receipt and creation event. A null principal is the
     * legacy actorless arm and yields a row-less tenant-wide Session.
     */
    Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            SessionModelConfig modelConfig) {
        return insertSessionCommand(tenantId, principal, operation, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest,
                modelConfig, null);
    }

    /**
     * The creation entry point: ownership row, Session, receipt, memory
     * binding and model configuration all land in the caller's transaction.
     */
    Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            SessionModelConfig modelConfig, String memoryStoreId) {
        if (principal != null) {
            ManagedSessionPrincipal.requireTenant(tenantId, principal);
        }
        requireModelConfiguration(modelConfig);
        AgentSessionPolicies.AgentPin pin = sessionPolicies.resolveAgentPin(tenantId, agentId, requestedRevision,
                false);
        requireCreationScope(tenantId, idempotencyKey, false);
        Admission admission = insertSession(tenantId, operation, idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                null, principal == null ? null : principal.userId(), pin,
                false, null, principal);
        ManagedMemoryStore.bind(jdbc, tenantId,
                principal == null ? null : principal.userId(),
                admission.sessionId(), memoryStoreId);
        if (modelConfig != null) {
            modelConfigs.save(tenantId, admission.sessionId(), modelConfig);
        }
        return admission;
    }

    /** Requires that the principal owns the unbound Session exactly. */
    void requireSessionOwnership(String tenantId, String sessionId,
            SessionPrincipal principal) {
        ManagedSessionPrincipal.requireOwnership(jdbc, tenantId, sessionId,
                principal);
    }

    /** The read-only twin of {@link #requireSessionOwnership}. */
    boolean ownsSession(String tenantId, String sessionId,
            SessionPrincipal principal) {
        return ManagedSessionPrincipal.owns(jdbc, tenantId, sessionId,
                principal);
    }

    void requireSessionAuthority(String tenantId, String sessionId,
            SessionPrincipal principal) {
        ManagedSessionPrincipal.requireAuthority(jdbc, tenantId, sessionId,
                principal);
    }

    void requireSessionReadAuthority(String tenantId, String sessionId,
            SessionPrincipal principal) {
        ManagedSessionPrincipal.requireReadAuthority(jdbc, tenantId, sessionId,
                principal);
    }

    /** The raw-actor twin: no byte-bounded principal is constructed (R7-1). */
    void requireSessionReadAuthority(String tenantId, String sessionId,
            String actorId) {
        ManagedSessionPrincipal.requireReadAuthority(jdbc, tenantId, sessionId,
                actorId);
    }

    // Pre-admission capability read for default Skill discovery: resolves the
    // same pin admission will use, without locking the Workspace. External
    // storage never admits extension pins, so it answers null.
    String creationToolProfile(String tenantId, String actorId,
            String agentId, String requestedRevision, String workspaceId) {
        AgentSessionPolicies.AgentPin pin = sessionPolicies.resolveAgentPin(tenantId, agentId, requestedRevision, true);
        if (!WorkspaceToolProfiles.isPublicShell(pin.toolProfile())
                && !WorkspaceToolProfiles.MCP.equals(pin.toolProfile())) {
            return pin.toolProfile();
        }
        ResolvedBinding workspace = workspaces.resolveForCreation(
                tenantId, actorId, new WorkspaceSelection(workspaceId, "."));
        return workspaces.isExternal(workspace.binding()) ? null : pin.toolProfile();
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
        // Creations lock the selected Workspace before reading receipts, as
        // resolveForCreation does below. Explicit selections lock one
        // Workspace; default selections retain the tenant scan to preserve
        // the lock order with default switches (see design
        // 2026-11-04-managed-session-admission-tenant-guard).
        workspaces.lockSelectionForCreation(tenantId, selection);
        List<ChildSessionAdmissions.WorkspaceCommand> existing = childSessionAdmissions.findWorkspaceCommand(tenantId,
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
        if (!sshWorkspace && !external) {
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, workspace.binding().getStorageId());
        }
        if (!input.isEmpty()
                && (!WorkspaceExecutionProfile.CONFIG_REF.equals(workspace.configRef())
                        || !WorkspaceExecutionProfile.POLICY_REF.equals(workspace.policyRef())
                        || !sshWorkspace && !external && !configuredStorage(tenantId, workspace.binding().getStorageId()))) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        List<Map<String, Object>> merged = new ArrayList<>(pin.skills());
        List<StandaloneSkill> packageSkills = command.extensionSelection() == null ? List.of() : command.extensionSelection().standaloneSkills();
        var injectedCatalog = ManagedLoopSkill.mergeInto(merged, skills, pin.toolProfile(), command.sessionSkillsSupported(), packageSkills);
        var effectiveSkills = injectedCatalog != null ? injectedCatalog : AgentDefinitionExtensions.sessionSkills(merged, packageSkills);
        if (worktree != null && sessionWorktrees == null) {
            throw new ManagedAgentException(409, "worktree_unavailable", "Session worktrees are unavailable.");
        }
        ResolvedBinding target = worktree == null ? workspace : worktree.target(workspace);
        Admission admission = insertSession(tenantId, "CREATE_SESSION", idempotencyKey,
                requestDigest, agentId, title, input, payloadDigest,
                target, actorId, pin, planMode, modelId);
        ManagedMemoryStore.bind(jdbc, tenantId, actorId, admission.sessionId(), command.memoryStoreId());
        if (modelConfig != null) {
            modelConfigs.save(tenantId, admission.sessionId(), modelConfig);
        }
        if (worktree != null) {
            sessionWorktrees.admit(tenantId, actorId, admission.sessionId(), worktree, workspace);
        }
        if (workspaceChildAgentsEnabled && publicChildrenSupported && (!sshWorkspace || managedExtensionExecutionEnabled)
                && (managedExtensionExecutionEnabled || "qwen-code".equals(agentId) && pin.digest() == null)
                && WorkspaceToolProfiles.isPublicShell(pin.toolProfile())) {
            jdbc.update("UPDATE ma_session SET public_child_agents_version=1 WHERE tenant_id=? AND session_id=?",
                    tenantId, admission.sessionId());
        }
        if (!effectiveSkills.isEmpty() && (!skills.isEmpty() || injectedCatalog != null)) {
            creationSkills.save(tenantId, admission.sessionId(), effectiveSkills, injectedCatalog != null);
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
        List<ChildSessionAdmissions.WorkspaceCommand> existing = childSessionAdmissions.findWorkspaceCommand(tenantId,
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
                new AgentSessionPolicies.AgentPin(agentRevision, null, approvalMode, WorkspaceToolProfiles.INTERNAL_TEAM_LEAD, false, false, List.of()));
    }

    Optional<Admission> findWorkspaceCreateReplay(String tenantId,
            String actorId, String idempotencyKey, String requestDigest) {
        List<ChildSessionAdmissions.WorkspaceCommand> existing = childSessionAdmissions.findWorkspaceCommand(tenantId,
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
        List<ChildSessionAdmissions.WorkspaceCommand> existing = childSessionAdmissions.findWorkspaceCommand(tenantId,
                actorId, idempotencyKey);
        if (existing.isEmpty()) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict", "The creation command is missing.");
        }
        return replayWorkspaceCommand(tenantId, actorId, requestDigest,
                existing.getFirst(), false);
    }

    Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        return childSessionAdmissions.insertChildSessionCommand(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage);
    }

    Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        return childSessionAdmissions.insertChildSessionCommand(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage, childCwdRelative);
    }

    Admission insertPublicChildSessionCommand(String tenantId, String parentSessionId,
            String idempotencyKey, String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage, com.fasterxml.jackson.databind.JsonNode snapshot) {
        return childSessionAdmissions.insertPublicChildSessionCommand(tenantId, parentSessionId, idempotencyKey, requestDigest,
                title, input, payloadDigest, lineage, snapshot);
    }

    Admission replayChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest) {
        storeRows.requireSessionForUpdate(tenantId, parentSessionId);
        storeRows.requireLegacyMutation(tenantId, parentSessionId);
        List<ChildSessionAdmissions.WorkspaceCommand> existing = childSessionAdmissions.findWorkspaceCommand(tenantId,
                ChildSessionAdmissions.childActorOf(parentSessionId), idempotencyKey);
        if (existing.isEmpty()) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict", "The creation command is missing.");
        }
        ChildSessionAdmissions.WorkspaceCommand command = existing.getFirst();
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ManagedAgentException(409,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        return new Admission(command.sessionId(), command.turnId(), true,
                false);
    }

    Admission replayWorkspaceCommand(String tenantId, String actorId,
            String requestDigest, ChildSessionAdmissions.WorkspaceCommand command, boolean internalTeamLead) {
        SessionRecord session = storeRows.requireSession(tenantId, command.sessionId());
        if (!command.requestDigest().equals(requestDigest)
                || internalTeamLead != WorkspaceToolProfiles.isInternalTeamLead(session.toolProfile())
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
        return insertSession(tenantId, operation, idempotencyKey, requestDigest, agentId, title,
                input, payloadDigest, resolved, actorId, pin, false);
    }

    Admission insertSession(String tenantId, String operation, String idempotencyKey,
            String requestDigest, String agentId, String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved, String actorId, AgentSessionPolicies.AgentPin pin,
            boolean planMode) {
        return insertSession(tenantId, operation, idempotencyKey, requestDigest, agentId, title,
                input, payloadDigest, resolved, actorId, pin, planMode, null);
    }

    Admission insertSession(String tenantId, String operation, String idempotencyKey,
            String requestDigest, String agentId, String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved, String actorId, AgentSessionPolicies.AgentPin pin,
            boolean planMode, String modelId) {
        return insertSession(tenantId, operation, idempotencyKey, requestDigest, agentId, title,
                input, payloadDigest, resolved, actorId, pin, planMode, modelId, null);
    }

    Admission insertSession(String tenantId, String operation, String idempotencyKey,
            String requestDigest, String agentId, String title, List<Map<String, Object>> input,
            String payloadDigest, ResolvedBinding resolved, String actorId, AgentSessionPolicies.AgentPin pin,
            boolean planMode, String modelId, SessionPrincipal principal) {
        ContextBinding workspace = resolved == null ? null
                : resolved.binding();
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
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
                        + " creator_actor_key, owner_actor_key, approval_mode,"
                        + " is_plan_enabled, selected_approval_mode, approval_revision, model_id, model_revision) VALUES"
                        + " (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                workspace == null ? null : pin.toolProfile(),
                actorKey, actorKey,
                workspace != null || pin.digest() != null ? pin.approvalMode() : "yolo",
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
            // A present principal writes the durable ownership row; the legacy
            // actorless arm (legacy_create) creates without one and stamps the
            // command receipt with the nullable creator key.
            if (principal != null) {
                ManagedSessionPrincipal.insert(jdbc, tenantId, sessionId,
                        principal, now);
            }
            sessionCommands.insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                    sessionId, turnId, "COMPLETED", null,
                    principal == null ? actorKey
                            : ManagedSessionPrincipal.actorKey(principal), now);
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
