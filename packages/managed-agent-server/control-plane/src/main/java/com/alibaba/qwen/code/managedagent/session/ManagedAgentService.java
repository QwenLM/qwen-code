package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.session.ReplayCursorExpired;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicContentPart;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicItem;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicWorkspace;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionCapabilities;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellContentPart;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellExportPage;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellItem;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionApproval;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionCapabilities;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTurn;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellWorkspace;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ItemPartRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.repository.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

@Service
public class ManagedAgentService implements com.alibaba.qwen.code.managedagent.contracts.session.UserMessagePolicy {
    private final ManagedUserMessagePolicy inputPolicy;
    private final HarnessRules harnessRules;

    private static final Logger LOG = LoggerFactory.getLogger(ManagedAgentService.class);
    private static final String CREATE = "CREATE_SESSION";
    private static final String SUBMIT = "SUBMIT_TURN";
    private static final String CANCEL = "CANCEL_TURN";
    private static final String RENAME = "RENAME_SESSION";
    private static final String UNARCHIVE = "UNARCHIVE_SESSION";
    private static final Pattern IDEMPOTENCY_KEY = Pattern.compile(
            "^[\\x21-\\x7e]{1,128}$");
    // A Turn cursor is the creation time and ID of the last Turn of a page.
    private static final Pattern TURN_CURSOR = Pattern.compile(
            "^(0|[1-9][0-9]{0,18}):([A-Za-z0-9_-]{1,64})$");
    private static final int TURN_ID_MAX_LENGTH = 64;
    /**
     * How long a rename waits for a delivery the background coordinator
     * claimed first. The coordinator scans {@code RENAME} rows a request has
     * just admitted, so its claim can beat this request's own without any
     * concurrent caller.
     */
    private static final java.time.Duration RENAME_CLAIM_SETTLE = java.time.Duration.ofSeconds(2);
    // Catch-up reads of a stream use pages of this size.
    static final int STREAM_PAGE = 100;
    // "text" is the spelling that clients used before the contract.

    // The per-block cap (1M chars) times the per-list cap (100) would
    // otherwise admit ~100M characters in a single command.

    private final AgentStateStore store;
    private final ManagedWorkspaceRegistry workspaces;
    private final RequestDigests digests;
    private final HarnessCoordinator coordinator;
    private final HarnessConnector harness;
    private RuntimeWarmer runtimeWarmer;
    private SessionWorktreeService sessionWorktrees;
    private org.springframework.beans.factory.ObjectProvider<SessionRecoveryService> recoveryServices;
    private java.util.function.Supplier<java.time.Duration> renameLeaseDuration = () -> java.time.Duration.ofSeconds(60);
    private Clock renameClock = Clock.systemUTC();
    private boolean externalFilesConfiguration;

    @Autowired
    void configureRenameDelivery(ManagedAgentSettings properties, @Qualifier("managedAgentClock") Clock clock) {
        renameLeaseDuration = properties.getDispatch()::getLeaseDuration;
        renameClock = clock;
        externalFilesConfiguration = com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE
                .equals(properties.getRuntimeBroker().getProvisioner());
    }

    @Autowired(required = false)
    void setRuntimeWarmer(RuntimeWarmer runtimeWarmer) {
        this.runtimeWarmer = runtimeWarmer;
    }

    @Autowired(required = false)
    public void setSessionWorktrees(SessionWorktreeService value) {
        this.sessionWorktrees = value;
    }

    @Autowired
    void setRecoveryServices(org.springframework.beans.factory.ObjectProvider<SessionRecoveryService> recoveryServices) {
        this.recoveryServices = recoveryServices;
    }

    private boolean supportsClose(SessionRecord session) {
        if (CsiFilesRetirementProfile.PROFILE.equals(session.toolProfile())) {
            return false;
        }
        return session.workspace() == null || RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())
                && (WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile())
                        ? harness.supportsSavedLifecycle(session.toolProfile()) : harness.supportsLifecycle(session.toolProfile()));
    }

    private boolean hasActions(SessionRecord session) {
        // Preserve Action readback when a selected custom Session loses execution support.
        return session.workspace() != null && session.deletedAt() == null
                && ((WorkspaceToolProfiles.supportsApprovalSelection(session)
                && (session.agentDefinitionDigest() != null || supportsApprovalSelection(session))) || !"yolo".equals(session.approvalMode()));
    }

    private boolean supportsApprovalSelection(SessionRecord session) {
        return harness.supportsApprovalSelection()
                && (session.agentDefinitionDigest() == null || harness.supportsAgentDefinitionApprovalSelection());
    }

    private BooleanSupplier artifactReadsEnabled = () -> false;

    @Autowired
    void configureArtifacts(ManagedAgentSettings properties,
            ManagedArtifactReader reader) {
        artifactReadsEnabled = () -> properties.getArtifacts().isEnabled() && reader.supported();
    }

    private boolean hasArtifacts(SessionRecord session) {
        return session.workspace() != null && session.deletedAt() == null
                && !"DELETING".equals(session.status())
                && artifactReadsEnabled.getAsBoolean();
    }

    public ManagedAgentService(AgentStateStore store,
            RequestDigests digests, HarnessCoordinator coordinator,
            HarnessConnector harness, ManagedWorkspaceRegistry workspaces, HarnessRules harnessRules) {
        this.harnessRules = harnessRules;
        this.store = store;
        this.workspaces = workspaces;
        this.digests = digests;
        this.coordinator = coordinator;
        this.harness = harness;
        this.inputPolicy = new ManagedUserMessagePolicy(store, digests, harness, workspaces);
    }

    public CommandAdmission createSession(String tenantId,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks) {
        throw new ManagedAgentException(401, "actor_required",
                "A trusted actor is required.");
    }

    public CommandAdmission createSession(String tenantId, String actorId,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks) {
        return createSession(tenantId, actorId, idempotencyKey, agentId,
                agentRevision, title, metadata, blocks, null);
    }

    public CommandAdmission createSession(String tenantId, String actorId,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata, List<InputBlock> blocks,
            com.alibaba.qwen.code.managedagent.model.SessionModelConfig modelConfig) {
        return createSession(tenantId, principalOf(tenantId, actorId),
                idempotencyKey, agentId, agentRevision, title, metadata, blocks,
                modelConfig);
    }

    /**
     * The ownership-enforcing unbound Session creation. The exact
     * principal is checked on the pre-read replay, the fresh transaction
     * and the concurrent duplicate-key replay before any recorded result
     * is returned.
     */
    public CommandAdmission createSession(SessionPrincipal principal,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks) {
        return createSession(principal, idempotencyKey, agentId, agentRevision,
                title, metadata, blocks, null);
    }

    public CommandAdmission createSession(SessionPrincipal principal,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks,
            com.alibaba.qwen.code.managedagent.model.SessionModelConfig modelConfig) {
        return createSession(principal == null ? null : principal.tenantId(),
                principal, idempotencyKey, agentId, agentRevision, title,
                metadata, blocks, modelConfig);
    }

    /**
     * Unbound creation under an explicit tenant. A present principal enforces
     * ownership (creator-gated replay and an ownership row); a null principal
     * is the legacy tenant-header arm ({@code legacy_create}), which replays
     * and creates tenant-wide without an ownership row.
     */
    private CommandAdmission createSession(String tenantId,
            SessionPrincipal principal, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks,
            com.alibaba.qwen.code.managedagent.model.SessionModelConfig modelConfig) {
        validateIdempotencyKey(idempotencyKey);
        List<Map<String, Object>> input = inputPolicy.input(blocks, false);
        String effectiveTitle = metadataTitle(title, metadata);
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("agentId", agentId);
        if (agentRevision != null) {
            semantic.put("agentRevision", agentRevision);
        }
        semantic.put("title", effectiveTitle);
        semantic.put("input", input);
        if (modelConfig != null) {
            semantic.put("modelConfigDigest", modelConfig.digest());
        }
        String requestDigest = digests.digest(semantic);
        // Replay before the harness gate: re-serving an already-recorded
        // command admits nothing new and must not 503 during a harness
        // outage.
        Admission replay = principal == null
                ? replay(tenantId, CREATE, idempotencyKey, requestDigest)
                : replayOwned(tenantId, CREATE, idempotencyKey, requestDigest,
                        principal);
        if (replay != null) {
            dispatch(tenantId, replay);
            return response(replay);
        }
        requireModelConfiguration(modelConfig);
        if (!input.isEmpty()) {
            requireHarness();
        }
        String payloadDigest = input.isEmpty() ? null
                : harnessRules.payloadDigest(input);
        Admission admission;
        try {
            admission = store.insertSessionCommand(tenantId, principal, CREATE,
                    idempotencyKey, requestDigest, agentId, agentRevision,
                    effectiveTitle, input, payloadDigest, modelConfig);
        } catch (DuplicateKeyException error) {
            admission = principal == null
                    ? store.replayCommand(tenantId, CREATE, idempotencyKey,
                            requestDigest)
                    : replayOwned(tenantId, CREATE, idempotencyKey,
                            requestDigest, principal);
            if (admission == null) {
                throw new ManagedAgentException(409,
                        "idempotency_conflict",
                        "The idempotency key is already in use.");
            }
        }
        dispatch(tenantId, admission);
        return response(admission);
    }

    private Admission replayOwned(String tenantId, String operation,
            String idempotencyKey, String requestDigest,
            SessionPrincipal principal) {
        StoreModels.CommandRecord command = store.findCommand(tenantId,
                operation, idempotencyKey).orElse(null);
        if (command == null) {
            return null;
        }
        store.requireSessionAuthority(tenantId, command.sessionId(),
                principal);
        return store.replayCommand(tenantId, operation, idempotencyKey,
                requestDigest);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection) {
        return createWorkspaceSession(tenantId, actorId, idempotencyKey,
                agentId, agentRevision, title, metadata, blocks, selection, null);
    }

    public WebShellSessionOptions queryWebShellSessionOptions(
            String tenantId, String actorId, String agentId) {
        requireModelActor(actorId);
        var options = store.workspaceSessionOptions(tenantId, agentId);
        if (externalFilesConfiguration) {
            return new WebShellSessionOptions(options.approvalMode(), options.availableApprovalModes(),
                    false, false, false, "qwen-code".equals(agentId) && workspaces.externalFilesAvailable()
                            && !store.modelOptions().isEmpty() && harness.supportsModelSelection());
        }
        if ("qwen-code".equals(agentId) && store.workspaceShellEnabled() && harness.supportsApprovalSelection()) {
            return new WebShellSessionOptions(options.approvalMode(), List.of("default", "auto-edit", "yolo"),
                    harness.supportsPlanMode(), harness.supportsInputAttachments(), harness.supportsSessionSkills(),
                    store.workspaceFilesEnabled() && !store.modelOptions().isEmpty() && harness.supportsModelSelection());
        }
        return new WebShellSessionOptions(options.approvalMode(), options.availableApprovalModes(),
                harness.supportsPlanMode() && harness.supportsAgentDefinitionApprovalSelection()
                        && options.planModeSupported(),
                harness.supportsInputAttachments(), harness.supportsSessionSkills(),
                "qwen-code".equals(agentId) && store.workspaceFilesEnabled() && !store.modelOptions().isEmpty() && harness.supportsModelSelection());
    }

    public WebShellSessionModels queryWebShellSessionModels(String tenantId, String actorId,
            String sessionId) {
        return queryWebShellSessionModels(
                principalOf(tenantId, actorId), sessionId);
    }

    public WebShellSessionModels queryWebShellSessionModels(
            SessionPrincipal principal, String sessionId) {
        requireModelActor(principal == null ? null : principal.userId());
        SessionRecord session = requireReadableSession(principal, sessionId);
        boolean supported = session.modelConfigDigest() == null && session.workspace() != null && store.workspaceFilesEnabled()
                && !store.modelOptions().isEmpty() && harness.supportsModelSelection();
        return new WebShellSessionModels(store.modelOptions(),
                store.findModelSelections(principal.tenantId(),
                        List.of(sessionId)).getOrDefault(sessionId,
                            new WebShellModelSelection(null, 0)), supported);
    }

    public WebShellModelChangeResult changeWebShellSessionModel(String tenantId, String actorId,
            String sessionId, String key, String modelId, long expectedRevision) {
        return changeWebShellSessionModel(
                principalOf(tenantId, actorId), sessionId, key, modelId,
                expectedRevision);
    }

    public WebShellModelChangeResult changeWebShellSessionModel(
            SessionPrincipal principal, String sessionId, String key,
            String modelId, long expectedRevision) {
        requireModelActor(principal == null ? null : principal.userId());
        // The store enforces the read grant immediately before its receipt
        // replay; a visibility pre-read here would tombstone-fence retries of
        // an already-recorded change and answer 404 instead of replaying.
        validateIdempotencyKey(key);
        String digest = digests.digest(Map.of("sessionId", sessionId, "modelId", modelId,
                "expectedRevision", expectedRevision));
        return store.changeSessionModel(principal.tenantId(), principal.userId(),
                sessionId, key, digest, modelId, expectedRevision,
                harness.supportsModelSelection());
    }

    public WebShellSessionApproval queryWebShellSessionApproval(String tenantId, String actorId, String sessionId) {
        return queryWebShellSessionApproval(
                principalOf(tenantId, actorId), sessionId);
    }

    public WebShellSessionApproval queryWebShellSessionApproval(
            SessionPrincipal principal, String sessionId) {
        requireModelActor(principal == null ? null : principal.userId());
        var summary = getWebShellSession(principal, sessionId);
        if (summary.workspace() == null) {
            throw new ManagedAgentException(400,
                    "unsupported_feature", "Approval selection requires a Workspace Session");
        }
        boolean supported = Boolean.TRUE.equals(summary.capabilities().approvalModeChange());
        var selected = store.findApprovalSelections(principal.tenantId(),
                List.of(sessionId)).getOrDefault(sessionId,
                    new WebShellApprovalSelection(summary.approvalMode(), summary.approvalRevision() == null ? 0 : summary.approvalRevision(), summary.planMode()));
        return new WebShellSessionApproval(selected.mode(), selected.revision(),
                supported ? harness.supportsAutoApproval() || "auto".equals(selected.mode())
                        ? List.of("default", "auto", "auto-edit", "yolo") : List.of("default", "auto-edit", "yolo")
                        : selected.mode() == null ? List.of() : List.of(selected.mode()), supported,
                selected.planMode(), summary.planModeSupported(), supported && harness.supportsLiveApprovalSelection(),
                supported && harness.supportsPermissionRules(), selected.permissionRules());
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String mode, long expectedRevision) {
        return changeWebShellSessionApproval(
                principalOf(tenantId, actorId), sessionId, key, mode,
                expectedRevision);
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(
            SessionPrincipal principal, String sessionId, String key, String mode,
            long expectedRevision) {
        return changeWebShellSessionApproval(principal, sessionId, key, mode,
                expectedRevision, null);
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String mode, long expectedRevision, Boolean planMode) {
        return changeWebShellSessionApproval(
                principalOf(tenantId, actorId), sessionId, key, mode,
                expectedRevision, planMode);
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(
            SessionPrincipal principal, String sessionId, String key, String mode,
            long expectedRevision, Boolean planMode) {
        return changeWebShellSessionApproval(principal, sessionId, key, mode,
                expectedRevision, planMode, null);
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String mode, long expectedRevision, Boolean planMode, Map<?, ?> requestedRules) {
        return changeWebShellSessionApproval(
                principalOf(tenantId, actorId), sessionId, key, mode,
                expectedRevision, planMode, requestedRules);
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(
            SessionPrincipal principal, String sessionId, String key, String mode,
            long expectedRevision, Boolean planMode,
            Map<?, ?> requestedRules) {
        requireModelActor(principal == null ? null : principal.userId());
        // The store enforces the read grant immediately before its receipt
        // replay; a visibility pre-read here would tombstone-fence retries of
        // an already-recorded change and answer 404 instead of replaying.
        Map<String, List<String>> rules;
        try {
            rules = harnessRules.permissionRules(requestedRules);
        } catch (IllegalArgumentException invalid) {
            throw new ManagedAgentException(400, "invalid_permission_rules", invalid.getMessage());
        }
        validateIdempotencyKey(key);
        Map<String, Object> semantic = new LinkedHashMap<>(Map.of("sessionId", sessionId,
                "mode", mode, "expectedRevision", expectedRevision));
        if (planMode != null) {
            semantic.put("planMode", planMode);
        }
        if (rules != null) {
            semantic.put("permissionRules", rules);
        }
        String digest = digests.digest(semantic);
        return store.changeSessionApproval(principal.tenantId(), principal.userId(),
                sessionId, key, digest, mode, expectedRevision,
                harness.supportsApprovalSelection(),
                harness.supportsAgentDefinitionApprovalSelection(),
                planMode, harness.supportsPlanMode(), harness.supportsLiveApprovalSelection(), rules,
                harness.supportsPermissionRules(), harness.supportsAutoApproval());
    }

    private static void requireModelActor(String actorId) {
        if (actorId == null || actorId.isEmpty()) {
            throw new ManagedAgentException(401, "actor_required", "A trusted actor is required");
        }
    }

    private void requireModelConfiguration(com.alibaba.qwen.code.managedagent.model.SessionModelConfig configuration) {
        if (configuration != null && !harness.supportsModelConfiguration()) {
            throw new ManagedAgentException(409, "unsupported_feature", "Session model configuration is unavailable.");
        }
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection, String approvalMode) {
        return createWorkspaceSession(tenantId, actorId, idempotencyKey, agentId, agentRevision,
                title, metadata, blocks, selection, approvalMode, null);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection, String approvalMode, Boolean planMode) {
        return createWorkspaceSession(tenantId, actorId, idempotencyKey, agentId, agentRevision,
                title, metadata, blocks, selection, approvalMode, planMode, null);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection, String approvalMode, Boolean planMode,
            List<Map<String, Object>> skills) {
        return createWorkspaceSession(tenantId, actorId, idempotencyKey, agentId, agentRevision,
                title, metadata, blocks, selection, approvalMode, planMode, skills, null);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection, String approvalMode, Boolean planMode,
            List<Map<String, Object>> skills, String modelId) {
        return createWorkspaceSession(tenantId, actorId, idempotencyKey, agentId, agentRevision,
                title, metadata, blocks, selection, approvalMode, planMode, skills, modelId, null);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection, String approvalMode, Boolean planMode,
            List<Map<String, Object>> skills, String modelId,
            List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> extensionPins) {
        return createWorkspaceSession(tenantId, actorId, idempotencyKey, agentId, agentRevision,
                title, metadata, blocks, selection, approvalMode, planMode, skills, modelId, extensionPins, null);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection, String approvalMode, Boolean planMode,
            List<Map<String, Object>> skills, String modelId,
            List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> extensionPins,
            SessionWorktreeService.Request worktree) {
        return createWorkspaceSession(tenantId, actorId, idempotencyKey, agentId, agentRevision, title,
                metadata, blocks, selection, approvalMode, planMode, skills, modelId, extensionPins, worktree, null);
    }

    public CommandAdmission createWorkspaceSession(String tenantId, String actorId, String idempotencyKey,
            String agentId, String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection, String approvalMode, Boolean planMode,
            List<Map<String, Object>> skills, String modelId,
            List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> extensionPins,
            SessionWorktreeService.Request worktree, com.alibaba.qwen.code.managedagent.model.SessionModelConfig modelConfig) {
        validateIdempotencyKey(idempotencyKey);
        if (modelId != null && modelConfig != null) {
            throw new ManagedAgentException(400, "invalid_model_config", "Choose either a model ID or a complete configuration.");
        }
        var additions = AgentDefinitionExtensions.sessionSkills(skills);
        if (actorId == null || actorId.isEmpty()) {
            throw new ManagedAgentException(401,
                    "actor_required", "A trusted actor is required.");
        }
        List<Map<String, Object>> input = inputPolicy.input(blocks, false);
        String effectiveTitle = metadataTitle(title, metadata);
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("agentId", agentId);
        if (agentRevision != null) {
            semantic.put("agentRevision", agentRevision);
        }
        semantic.put("title", effectiveTitle);
        semantic.put("input", input);
        semantic.put("workspace", selection == null
                ? Map.of("default", true)
                : Map.of("workspaceId", selection.workspaceId(),
                        "cwdRelative", selection.cwdRelative()));
        if (approvalMode != null) {
            semantic.put("approvalMode", approvalMode);
        }
        if (planMode != null) {
            semantic.put("planMode", planMode);
        }
        if (!additions.isEmpty()) {
            semantic.put("skills", additions);
        }
        if (modelId != null) {
            semantic.put("modelId", modelId);
        }
        if (modelConfig != null) {
            semantic.put("modelConfigDigest", modelConfig.digest());
        }
        if (extensionPins != null) {
            semantic.put("extensionPins", extensionPins);
        }
        if (worktree != null) {
            semantic.put("worktree", worktree.baseRef() == null ? Map.of() : Map.of("baseRef", worktree.baseRef()));
        }
        String requestDigest = digests.digest(semantic);
        String payloadDigest = input.isEmpty() ? null
                : harnessRules.payloadDigest(input);
        // Replay before the availability gate, like the legacy paths: a
        // recorded success must answer even while Workspace files are off.
        Optional<Admission> recorded = store.findWorkspaceCreateReplay(
                tenantId, actorId, idempotencyKey, requestDigest);
        if (recorded.isPresent()) {
            dispatch(tenantId, recorded.get(), true);
            return response(recorded.get());
        }
        requireModelConfiguration(modelConfig);
        if (externalFilesConfiguration && !workspaces.externalFilesAvailable()) {
            throw new ManagedAgentException(409, "workspace_unavailable", "External Workspace creation is unavailable.");
        }
        if (modelId != null && (!"qwen-code".equals(agentId) || !harness.supportsModelSelection())) {
            throw new ManagedAgentException(409, "unsupported_feature",
                    "Initial model selection is unavailable for this Agent.");
        }
        if (!additions.isEmpty() && !harness.supportsSessionSkills()) {
            throw new ManagedAgentException(409, "unsupported_feature",
                    "The Hosted Harness does not support Session Skills.");
        }
        if (extensionPins != null && !harness.supportsSessionExtensions()) {
            throw new ManagedAgentException(409, "unsupported_feature", "The Hosted Harness does not support extension packages.");
        }
        if (!input.isEmpty() && !harness.isWorkspaceFilesAvailable()) {
            throw new ManagedAgentException(409,
                    "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
        Admission admission;
        Set<String> extensionLifecycleProfiles = extensionPins == null ? Set.of()
                : java.util.stream.Stream.of(WorkspaceToolProfiles.SHELL, WorkspaceToolProfiles.MCP)
                        .filter(harness::supportsLifecycle).collect(java.util.stream.Collectors.toSet());
        if (worktree != null && sessionWorktrees == null) {
            throw new ManagedAgentException(409, "worktree_unavailable", "Session worktrees are unavailable.");
        }
        SessionWorktreeStore.Plan worktreePlan = worktree == null ? null
                : sessionWorktrees.preflight(tenantId, actorId, selection, worktree);
        boolean approvalSelectionSupported = harness.supportsApprovalSelection()
                && ("qwen-code".equals(agentId) || harness.supportsAgentDefinitionApprovalSelection());
        try {
            admission = store.insertWorkspaceSessionCommand(SessionCreationCommand.builder()
                    .tenantId(tenantId)
                    .actorId(actorId)
                    .idempotencyKey(idempotencyKey)
                    .requestDigest(requestDigest)
                    .agentId(agentId)
                    .requestedRevision(agentRevision)
                    .title(effectiveTitle)
                    .input(input)
                    .payloadDigest(payloadDigest)
                    .selection(selection)
                    .requestedApprovalMode(approvalMode)
                    .approvalSelectionSupported(approvalSelectionSupported)
                    .requestedPlanMode(planMode)
                    .planModeSupported(harness.supportsPlanMode())
                    .skills(additions)
                    .publicChildrenSupported(harness.supportsPublicChildAgents())
                    .modelId(modelId)
                    .extensionPins(extensionPins)
                    .extensionLifecycleProfiles(extensionLifecycleProfiles)
                    .worktree(worktreePlan)
                    .modelConfig(modelConfig)
                    .build());
        } catch (DuplicateKeyException error) {
            admission = store.replayWorkspaceSessionCommand(tenantId,
                    actorId, idempotencyKey, requestDigest);
        }
        // A creation with input warms through its first Turn's dispatch.
        if (admission.turnId() == null && worktreeReady(tenantId, admission.sessionId())) {
            coordinator.warmSession(tenantId, admission.sessionId());
        }
        dispatch(tenantId, admission, true);
        return response(admission);
    }

    /**
     * H4b: creates a child Session under its parent's exact Workspace
     * binding, called only by the control plane's child result relay. The
     * idempotency key derives from the parent's committed launch record
     * (tenant | parent | childRunId), so a redriven creation answers the
     * original admission and never mints a second Session, and the launch
     * input becomes the child's first turn. The lineage stamps in the same
     * transaction, and the relay reads it back from the row.
     */
    public CommandAdmission createChildSession(String tenantId,
            String parentSessionId, String childRunId, String description,
            String prompt) {
        return createChildSession(tenantId, parentSessionId, childRunId,
                description, prompt, false);
    }

    /**
     * The same creation; {@code isolated} binds the child to its run's
     * ready child Workspace (#13753 I1) instead of the parent's directory.
     * The child directory joins the request digest, so a replay that names
     * a different binding is an idempotency conflict.
     */
    public CommandAdmission createChildSession(String tenantId,
            String parentSessionId, String childRunId, String description,
            String prompt, boolean isolated) {
        List<InputBlock> blocks = List.of(new InputBlock("input_text",
                description.isBlank() ? prompt
                        : "[" + description + "]\n\n" + prompt));
        List<Map<String, Object>> input = inputPolicy.input(blocks, false);
        String title = description.isBlank() ? "child agent"
                : StringUtils.truncate(description, 256);
        return insertChildSession(tenantId, parentSessionId, childRunId,
                title, input, isolated);
    }

    public CommandAdmission createPublicChildSession(String tenantId, String parentSessionId,
            String childRunId, String description, String prompt, com.fasterxml.jackson.databind.JsonNode snapshot) {
        List<Map<String, Object>> input = inputPolicy.input(List.of(new InputBlock("input_text",
                description.isBlank() ? prompt : "[" + description + "]\n\n" + prompt)), false);
        return insertChildSession(tenantId, parentSessionId, childRunId,
                description.isBlank() ? "child agent" : StringUtils.truncate(description, 256), input, false, snapshot);
    }

    /**
     * The workflow arm of the same creation (#13803 K1): the child's first
     * turn carries one `workflow_launch` block — the workflow the parent
     * launch pinned (id and revision classify, the digest binds the exact
     * script bytes that ride the block) plus its structured arguments —
     * instead of a prompt. Everything else is the prompt arm unchanged:
     * the record-key-derived creation key, the one-transaction lineage,
     * the dispatch of the admitted creation.
     */
    public CommandAdmission createWorkflowChildSession(String tenantId,
            String parentSessionId, String childRunId, String definitionId,
            long definitionRevision, String definitionDigest, String script,
            Object args) {
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("type", "workflow_launch");
        Map<String, Object> definition = new LinkedHashMap<>();
        definition.put("definitionId", definitionId);
        definition.put("definitionRevision", definitionRevision);
        definition.put("definitionDigest", definitionDigest);
        block.put("definition", definition);
        block.put("script", script);
        if (args != null) {
            block.put("args", args);
        }
        List<Map<String, Object>> input = List.of(block);
        String title = StringUtils.truncate(Objects.requireNonNull(definitionId), 256);
        return insertChildSession(tenantId, parentSessionId, childRunId,
                title, input, false);
    }

    /** The shared child creation: parent admitted, lineage stamped, first
     * turn minted from {@code input}, replay by the derived creation key. */
    private CommandAdmission insertChildSession(String tenantId,
            String parentSessionId, String childRunId, String title,
            List<Map<String, Object>> input, boolean isolated) {
        return insertChildSession(tenantId, parentSessionId, childRunId, title, input, isolated, null);
    }

    private CommandAdmission insertChildSession(String tenantId, String parentSessionId,
            String childRunId, String title, List<Map<String, Object>> input, boolean isolated,
            com.fasterxml.jackson.databind.JsonNode snapshot) {
        List<Map<String, Object>> normalizedInput = normalizeInput(input);
        SessionRecord parent = store.requireSession(tenantId, parentSessionId);
        if (parent.workspace() == null || !"ACTIVE".equals(parent.status())
                || CsiFilesRetirementProfile.PROFILE.equals(parent.toolProfile())) {
            throw new ManagedAgentException(409,
                    "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        String creationKey = childCreationKey(parentSessionId, childRunId);
        if (!normalizedInput.isEmpty() && !harness.isWorkspaceFilesAvailable()) {
            throw new ManagedAgentException(409,
                    "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
        StoreModels.SessionLineage parentLineage = store.findChildLineage(
                tenantId, parentSessionId);
        StoreModels.SessionLineage lineage = new StoreModels.SessionLineage(
                parentSessionId,
                parentLineage == null ? parentSessionId
                        : parentLineage.rootSessionId(),
                childRunId, parentLineage == null ? 1
                        : parentLineage.depth() + 1);
        String childCwd = null;
        if (isolated) {
            childCwd = store.findChildWorkspaceCwd(tenantId,
                    parentSessionId, childRunId);
            if (childCwd == null) {
                throw new ManagedAgentException(409,
                        "child_workspace_not_ready",
                        "The child run's Workspace is not ready to bind a child Session.");
            }
        }
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("child", childRunId);
        if (snapshot != null) {
            semantic.put("publicLaunch", snapshot);
        }
        semantic.put("title", title);
        semantic.put("input", normalizedInput);
        if (childCwd != null) {
            semantic.put("workspace", childCwd);
        }
        String requestDigest = digests.digest(semantic);
        StoreModels.Admission admission;
        try {
            admission = snapshot != null
                    ? store.insertPublicChildSessionCommand(tenantId, parentSessionId, creationKey,
                            requestDigest, title, normalizedInput,
                            harnessRules.payloadDigest(normalizedInput), lineage, snapshot)
                    : childCwd == null
                    ? store.insertChildSessionCommand(tenantId,
                            parentSessionId, creationKey, requestDigest, title,
                            normalizedInput,
                            harnessRules.payloadDigest(normalizedInput),
                            lineage)
                    : store.insertChildSessionCommand(tenantId,
                            parentSessionId, creationKey, requestDigest, title,
                            normalizedInput,
                            harnessRules.payloadDigest(normalizedInput),
                            lineage, childCwd);
        } catch (DuplicateKeyException error) {
            admission = store.replayChildSessionCommand(tenantId,
                    parentSessionId, creationKey, requestDigest);
        }
        if (!admission.replayed()) {
            dispatch(tenantId, admission);
        }
        return response(admission);
    }

    /** The derivation of H4a decision 3: the launch's own record key —
     * sha256 hex of the parent's Session id, the `child_run` domain and
     * the run id, joined by NUL, exactly `ManagedExtensionProjection.recordKey`. */
    public static String childCreationKey(String parentSessionId,
            String childRunId) {
        return ManagedExtensionProjection.recordKey(parentSessionId,
                "child_run", childRunId);
    }

    public CommandAdmission submitTurn(String tenantId, String actorId,
            String idempotencyKey, String sessionId,
            List<InputBlock> blocks) {
        return submitTurn(actorId == null ? null
                : SessionPrincipal.ofUser(tenantId, actorId), tenantId,
                idempotencyKey, sessionId, blocks);
    }

    public CommandAdmission submitTurn(SessionPrincipal principal,
            String idempotencyKey, String sessionId,
            List<InputBlock> blocks) {
        return submitTurn(principal,
                principal == null ? null : principal.tenantId(),
                idempotencyKey, sessionId, blocks);
    }

    /**
     * Read-only retry discovery for an embedding caller that must resolve
     * model authorization before allowing a second attempt. It never
     * creates a Turn or dispatches work.
     */
    public Optional<CommandAdmission> findSubmitTurnReplay(
            SessionPrincipal principal, String idempotencyKey,
            String sessionId, List<InputBlock> blocks) {
        validateIdempotencyKey(idempotencyKey);
        List<Map<String, Object>> input = inputPolicy.input(blocks, true);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "input", input));
        String tenantId = principal == null ? null : principal.tenantId();
        SessionRecord session = store.requireSession(tenantId, sessionId);
        inputPolicy.requireSubmitterRole(session, principal);
        Admission replay = replayForCreator(tenantId, SUBMIT,
                idempotencyKey, requestDigest, session, principal);
        return replay == null ? Optional.empty()
                : Optional.of(response(tenantId, replay));
    }

    private CommandAdmission submitTurn(SessionPrincipal principal,
            String tenantId, String idempotencyKey, String sessionId,
            List<InputBlock> blocks) {
        validateIdempotencyKey(idempotencyKey);
        List<Map<String, Object>> input = inputPolicy.input(blocks, true);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "input", input));
        SessionRecord session = store.requireSession(tenantId, sessionId);
        // The role gate stays above the replay: an idempotency key answers
        // its recorded outcome only to an actor authorized for the Session.
        // Its 404 arm doubles as the tombstone fence a grant-less caller
        // would meet below the replay, so a reused key's 409 never leaks to
        // one, and a below-OPERATOR reader never reaches a recorded key —
        // the command family's replay is not actor-scoped (#13619).
        inputPolicy.requireSubmitterRole(session, principal);
        // Replay before the visibility and availability gates, so a
        // recorded submit still answers after a delete and through a
        // Harness outage. See createSession. The gates above pass every
        // operator, but the recorded outcome stays scoped to its recorder
        // and the Session's creator — and the gate runs when the key
        // exists, before any digest comparison: a reused key's
        // idempotency_conflict would otherwise name the live key. The
        // gate's own refusal still differs from a fresh key's for a
        // fellow OPERATOR; only the below-OPERATOR arms answer uniformly.
        Admission replay = replayForCreator(tenantId, SUBMIT,
                idempotencyKey, requestDigest, session, principal);
        if (replay != null) {
            CommandAdmission body = response(tenantId, replay);
            dispatch(tenantId, replay, session.workspace() != null);
            return body;
        }
        // A fresh key against a tombstone answers 404, as every other
        // Session read does; only the recorded outcome above survives the
        // delete. beginLifecycle orders its DELETED 404 the same way,
        // below its replay return. The facts gate follows the replay: it
        // certifies new work only, so a recorded outcome always answers —
        // a re-registration, a DRAINING row or a creator demotion must not
        // retire it.
        inputPolicy.requireVisibleSession(session);
        inputPolicy.requireSubmitterFacts(session, principal);
        requireReadyWorktree(session);
        requireHarness();
        String payloadDigest = harnessRules.payloadDigest(input);
        Admission admission;
        try {
            admission = store.insertTurnCommand(tenantId, SUBMIT,
                    idempotencyKey, requestDigest, sessionId, input,
                    payloadDigest, principal);
        } catch (DuplicateKeyException error) {
            admission = replayForCreator(tenantId, SUBMIT, idempotencyKey,
                    requestDigest, session, principal);
            if (admission == null) {
                throw error;
            }
        }
        requireReplayedAdmission(tenantId, SUBMIT, idempotencyKey, admission,
                session, principal);
        // Built before the dispatcher runs, so the body reports the
        // operation as its admission saved it.
        CommandAdmission body = response(tenantId, admission);
        dispatch(tenantId, admission, session.workspace() != null);
        return body;
    }

    public CommandAdmission cancelTurn(String tenantId, String actorId,
            String idempotencyKey, String sessionId, String turnId) {
        return cancelTurn(actorId == null ? null
                : SessionPrincipal.ofUser(tenantId, actorId), tenantId,
                idempotencyKey, sessionId, turnId);
    }

    public CommandAdmission cancelTurn(SessionPrincipal principal,
            String idempotencyKey, String sessionId, String turnId) {
        return cancelTurn(principal,
                principal == null ? null : principal.tenantId(),
                idempotencyKey, sessionId, turnId);
    }

    private CommandAdmission cancelTurn(SessionPrincipal principal,
            String tenantId, String idempotencyKey, String sessionId,
            String turnId) {
        validateIdempotencyKey(idempotencyKey);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "turnId", turnId));
        SessionRecord session = store.requireSession(tenantId, sessionId);
        // The same split as submitTurn, on cancel's narrower rule — the
        // caller's OPERATOR and the Session's executable shape, never the
        // creator-keyed facts: the role stays above the replay, so a
        // recorded cancel still answers after the Session leaves ACTIVE or
        // Workspace files turn off, and only a fresh key meets the refusals
        // below.
        requireCancellerRole(session, principal);
        Admission replay = replayForCreator(tenantId, CANCEL,
                idempotencyKey, requestDigest, session, principal);
        if (replay != null) {
            CommandAdmission body = response(tenantId, replay);
            dispatch(tenantId, replay, session.workspace() != null);
            return body;
        }
        inputPolicy.requireVisibleSession(session);
        requireCancellerShape(session, principal);
        Admission admission;
        try {
            admission = store.insertCancelCommand(tenantId, CANCEL,
                    idempotencyKey, requestDigest, sessionId, turnId,
                    principal);
        } catch (DuplicateKeyException error) {
            admission = replayForCreator(tenantId, CANCEL, idempotencyKey,
                    requestDigest, session, principal);
            if (admission == null) {
                throw error;
            }
        }
        requireReplayedAdmission(tenantId, CANCEL, idempotencyKey, admission,
                session, principal);
        CommandAdmission body = response(tenantId, admission);
        if (admission.commandEffect()) {
            coordinator.cancel(tenantId, admission.sessionId(),
                    admission.turnId());
        } else {
            dispatch(tenantId, admission, session.workspace() != null);
        }
        return body;
    }

    /**
     * H4f: stops the child Session's running Turn on behalf of its parent
     * run's committed stop request. Two drivers share it: the child result
     * relay while the parent is ACTIVE, and the close cascade (#13875)
     * once the close is admitted — the keyed command makes the hand-off
     * replay-safe. The key derives from the parent, the run and the Turn,
     * so a redriven stop replays its admission and never mints a second
     * cancel; a Turn that already ended answers without effect. The child
     * acts under no caller: the request is the parent authority's own
     * durable record.
     */
    public CommandAdmission cancelChildTurn(String tenantId,
            String parentSessionId, String childSessionId, String childRunId,
            String turnId) {
        String key = childStopKey(parentSessionId, childRunId, turnId);
        String requestDigest = digests.digest(Map.of(
                "sessionId", childSessionId, "turnId", turnId));
        Admission replay = replay(tenantId, CANCEL, key, requestDigest);
        if (replay != null) {
            dispatch(tenantId, replay);
            return response(replay);
        }
        Admission admission;
        try {
            admission = store.insertCancelCommand(tenantId, CANCEL, key,
                    requestDigest, childSessionId, turnId);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, CANCEL, key,
                    requestDigest);
        }
        if (admission.commandEffect()) {
            coordinator.cancel(tenantId, admission.sessionId(),
                    admission.turnId());
        } else {
            dispatch(tenantId, admission);
        }
        return response(admission);
    }

    public SessionMutationResult<PublicSession> renameSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId,
            String title) {
        return renameSession(actorId == null ? null
                : SessionPrincipal.ofUser(tenantId, actorId), tenantId,
                idempotencyKey, sessionId, title);
    }

    public SessionMutationResult<PublicSession> renameSession(
            SessionPrincipal principal, String idempotencyKey,
            String sessionId, String title) {
        return renameSession(principal,
                principal == null ? null : principal.tenantId(),
                idempotencyKey, sessionId, title);
    }

    private SessionMutationResult<PublicSession> renameSession(
            SessionPrincipal principal, String tenantId,
            String idempotencyKey, String sessionId, String title) {
        validateIdempotencyKey(idempotencyKey);
        // A recorded rename answers before the shape and availability gates
        // a deleted Session can no longer pass, but only when the recorded
        // command IS this request — the key is tenant-global, so a key
        // another Session consumed is answered idempotency_conflict by the
        // cross-Session pre-guard below, gating on the caller's own Session
        // rather than the recorded one. The actor gates stay ahead
        // of the outcome, exactly as the fresh path applies them — the
        // OPERATOR role, whose 404 arm covers the read grant, and the
        // creator half, because the recorded outcome stays creator-scoped —
        // and the read-only probe never writes the PENDING row
        // beginSessionRename would create for a fresh key.
        StoreModels.CommandRecord recorded = store.findCommand(tenantId,
                RENAME, idempotencyKey).orElse(null);
        if (recorded != null && !recorded.sessionId().equals(sessionId)) {
            SessionRecord requested = store.requireSession(tenantId, sessionId);
            inputPolicy.requireSubmitterRole(requested, principal);
            requireRecordedSessionGrant(recorded, requested, principal);
        }
        if (recorded != null && recorded.sessionId().equals(sessionId)) {
            // The actor gates run ahead of the digest comparison:
            // evaluating the digest first throws invalid_title for an
            // over-bound title and would split a grant-less caller's
            // answer on the key's liveness (400 against a recorded key,
            // 404 against a fresh one); the uniform answer is the read
            // grant's 404. They also cover a recorded row of ANY status,
            // not only the completed outcome: beginSessionRename below
            // compares key, Session and digest, never the actor, so an
            // unfinished row answered without the gates would hand the
            // recorder's pending delivery — and the recorded outcome it
            // becomes — to any OPERATOR replaying the key, and a
            // different-title replay would answer idempotency_conflict,
            // naming the live key the grant-less caller's uniform 404
            // keeps hidden; a fellow OPERATOR's refusal still differs
            // from a fresh key's.
            SessionRecord session = store.requireSession(tenantId,
                    sessionId);
            inputPolicy.requireSubmitterRole(session, principal);
            if (session.workspace() == null
                    || !recordedByCaller(recorded,
                            principal == null ? null : principal.userId())) {
                requireReplayCreator(session, principal);
            }
            // The replay comparison digests the title as sent, never the
            // validated form: a title that fails validation cannot match a
            // recorded rename, and validating here would throw ahead of
            // the gates. A mismatched title falls through to the fresh
            // path, whose validRenameTitle still answers 400 to an
            // authorized caller. Only a COMPLETED row answers here: the
            // recorder's unfinished row falls through too, so its own
            // retry resumes the delivery below.
            if ("COMPLETED".equals(recorded.status()) && title != null
                    && recorded.requestDigest().equals(
                            digests.digest(Map.of("sessionId", sessionId,
                                    "title", title)))) {
                return new SessionMutationResult<>(publicSession(
                        asLastVisible(session)), true);
            }
        }
        // The fresh-key half answers a tombstone 404, as every other
        // Session read does; the recorded rename above is the only outcome
        // that survives the delete.
        SessionRecord current = inputPolicy.requireVisibleSession(tenantId, sessionId);
        inputPolicy.requireSubmitterRole(current, principal);
        inputPolicy.requireSubmitterFacts(current, principal);
        requireReadyWorktree(current);
        String effectiveTitle = validRenameTitle(title);
        requireHarness();
        if (!harness.supportsFencedTitles()) {
            throw dependencyUnavailable("hosted_harness_unavailable",
                    "The Hosted Harness must support title protocol version 1.");
        }
        SessionMutationCommand command = store.beginSessionRename(tenantId,
                idempotencyKey, renameDigest(sessionId, title), sessionId,
                effectiveTitle,
                principal == null ? null : principal.userId(), principal);
        if (!"COMPLETED".equals(command.status())) {
            String owner = UUID.randomUUID().toString();
            var candidate = new StoreModels.RenameDelivery(tenantId, sessionId,
                    idempotencyKey, effectiveTitle, command.renameRevision(), 0);
            var delivery = store.claimRename(candidate, owner, renameLeaseDuration.get()).orElse(null);
            if (delivery == null) {
                // The dispatcher can claim the row this request just admitted.
                // Wait for that delivery to settle so one request never
                // answers "already being delivered" for its own rename.
                if (awaitRenameSettle(tenantId, idempotencyKey, sessionId,
                        renameDigest(sessionId, title)) != null) {
                    // The settle arm answers a recorded outcome through the
                    // same TOCTOU window as the COMPLETED read-back below:
                    // the pre-read above could not see a key the recorder
                    // committed after it, so the creator gate re-runs here,
                    // and the body serializes the Session as last visible.
                    SessionRecord settled = store.requireSession(tenantId,
                            sessionId);
                    requireReplayActor(tenantId, RENAME, idempotencyKey,
                            settled, principal);
                    return new SessionMutationResult<>(publicSession(
                            asLastVisible(settled)), true);
                }
                throw dependencyUnavailable("hosted_harness_unavailable",
                        "The Session title is already being delivered.");
            }
            try {
                SessionRecord session = store.requireSession(tenantId, sessionId);
                HarnessConnector.Attachment attachment = harness.createOrLoad(tenantId, sessionId,
                        session.harnessBootId() != null, true);
                store.markRenameSubmitted(delivery, owner);
                harness.rename(tenantId, sessionId, effectiveTitle, command.renameRevision());
                session = store.completeSessionRename(delivery, owner, attachment.bootId());
                return new SessionMutationResult<>(publicSession(session),
                        command.replayed());
            } catch (RuntimeException error) {
                try {
                    store.abandonSessionRename(tenantId, idempotencyKey, sessionId,
                            command.renameRevision(), owner);
                    store.retryRename(delivery, owner, renameClock.millis());
                } catch (RuntimeException cleanupError) {
                    LOG.warn("Failed to retire rename tenant={} session={}",
                            tenantId, sessionId, cleanupError);
                }
                if (error instanceof HarnessHttpFailure refusal
                        && refusal.getStatusCode() == 409
                        && "session_mutation_superseded".equals(refusal.getErrorCode())) {
                    throw new ManagedAgentException(409,
                            "session_mutation_superseded",
                            "A later Session title attempt has been admitted.");
                }
                if (error instanceof ManagedAgentException failure) {
                    throw failure;
                }
                if (error instanceof RuntimeBrokerException refusal
                        && !refusal.isRetryable()) {
                    org.springframework.http.HttpStatus status = org.springframework.http.HttpStatus.resolve(
                            refusal.getStatusCode());
                    throw new ManagedAgentException(
                            status == null ? 409 : status.value(),
                            refusal.getCode(), refusal.getMessage());
                }
                // Chain and log the root cause: a plain 503 leaves on-call
                // unable to tell a network fault from a daemon bug. The
                // catch wraps the store calls too, so the WARN names the
                // operation rather than a subsystem the fault may not be in.
                LOG.warn("Managed Agent rename failed tenant={} session={}",
                        tenantId, sessionId, error);
                throw new ManagedAgentException(503,
                        "hosted_harness_unavailable",
                        "The Hosted Harness could not persist the Session title.",
                        error);
            }
        }
        // A replay re-reads the row without the visibility filter: the
        // recorded success must not 404 after a later delete, and the body
        // serializes the Session as it was last visible, so the closed
        // status enum never has to carry "deleted". The recorder/creator
        // gate re-runs on the command row first: the pre-read above could
        // not see a key the recorder committed after it, so this arm would
        // otherwise answer the recorded outcome ungated.
        SessionRecord replayed = store.requireSession(tenantId, sessionId);
        requireReplayActor(tenantId, RENAME, idempotencyKey, replayed,
                principal);
        return new SessionMutationResult<>(publicSession(
                asLastVisible(replayed)), true);
    }

    /**
     * Waits a bounded time for the delivery that won this rename's claim,
     * and answers the recorded command once it completes. Returns null when
     * the row is gone, the digest belongs to another request, or the
     * delivery is still in flight when the wait expires.
     */
    private StoreModels.CommandRecord awaitRenameSettle(String tenantId, String idempotencyKey,
            String sessionId, String digest) {
        long deadline = System.nanoTime() + RENAME_CLAIM_SETTLE.toNanos();
        while (System.nanoTime() < deadline) {
            StoreModels.CommandRecord recorded = store
                    .findCommand(tenantId, RENAME, idempotencyKey).orElse(null);
            if (recorded == null || !recorded.sessionId().equals(sessionId)
                    || !digest.equals(recorded.requestDigest())) {
                return null;
            }
            if ("COMPLETED".equals(recorded.status())) {
                return recorded;
            }
            try {
                Thread.sleep(25);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        return null;
    }

    // An archived Session stays closed, so unarchive needs neither the
    // Harness nor the Runtime.
    public SessionMutationResult<PublicSession> unarchiveSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        var result = unarchive(tenantId, actorId, idempotencyKey, sessionId);
        SessionRecord session = result.replayed()
                ? asLastVisible(result.session()) : result.session();
        return new SessionMutationResult<>(publicSession(session),
                result.replayed());
    }

    public SessionMutationResult<PublicSession> unarchiveSession(
            SessionPrincipal principal, String idempotencyKey,
            String sessionId) {
        var result = unarchive(principal,
                principal == null ? null : principal.tenantId(),
                idempotencyKey, sessionId);
        SessionRecord session = result.replayed()
                ? asLastVisible(result.session()) : result.session();
        return new SessionMutationResult<>(publicSession(session),
                result.replayed());
    }

    public SessionMutationResult<WebShellSession> unarchiveWebShellSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        var result = unarchive(tenantId, actorId, idempotencyKey, sessionId);
        SessionRecord session = result.replayed()
                ? asLastVisible(result.session()) : result.session();
        return new SessionMutationResult<>(webShellSession(session, actorId),
                result.replayed());
    }

    public SessionMutationResult<WebShellSession> unarchiveWebShellSession(
            SessionPrincipal principal, String idempotencyKey,
            String sessionId) {
        var result = unarchive(principal,
                principal == null ? null : principal.tenantId(),
                idempotencyKey, sessionId);
        SessionRecord session = result.replayed()
                ? asLastVisible(result.session()) : result.session();
        return new SessionMutationResult<>(webShellSession(session,
                principal == null ? null : principal.userId()),
                result.replayed());
    }

    private StoreModels.SessionMutation unarchive(String tenantId, String actorId,
            String idempotencyKey, String sessionId) {
        // The callee validates the idempotency key before its Session read;
        // a pre-read here would answer 404 for a missing Session ahead of
        // that 400.
        return unarchive(principalOf(tenantId, actorId), tenantId, idempotencyKey,
                sessionId);
    }

    private StoreModels.SessionMutation unarchive(SessionPrincipal principal,
            String tenantId, String idempotencyKey, String sessionId) {
        validateIdempotencyKey(idempotencyKey);
        SessionRecord target = store.requireSession(tenantId, sessionId);
        if (target.workspace() != null) {
            String actorId = principal == null ? null : principal.userId();
            requireReadGrant(target, principal);
            String scopedKey = digests.digest(Map.of("sessionId", sessionId,
                    "actorDigest", digests.digest(Map.of("actorId", actorId)), "idempotencyKey", idempotencyKey));
            return store.unarchiveWorkspaceSession(tenantId, sessionId, actorId,
                    scopedKey, lifecycleDigest(sessionId, UNARCHIVE));
        }
        inputPolicy.requireLegacyWorkspace(tenantId, principal, sessionId);
        store.findCommand(tenantId, UNARCHIVE, idempotencyKey)
                .ifPresent(command -> requireRecordedSessionGrant(command,
                        target, principal));
        String requestDigest = lifecycleDigest(sessionId, UNARCHIVE);
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                UNARCHIVE, idempotencyKey, requestDigest, sessionId,
                SessionMutationKind.UNARCHIVE,
                principal == null ? null : principal.userId(), principal);
        if (!"COMPLETED".equals(command.status())) {
            SessionRecord session = store.completeSessionMutation(tenantId,
                    UNARCHIVE, idempotencyKey, sessionId,
                    SessionMutationKind.UNARCHIVE, null, null);
            return new StoreModels.SessionMutation(session, command.replayed());
        }
        // Replay without the visibility filter; see renameSession.
        return new StoreModels.SessionMutation(
                asLastVisible(store.requireSession(tenantId, sessionId)),
                true);
    }

    private SessionRecord asLastVisible(SessionRecord session) {
        if (!"DELETED".equals(session.status())) {
            return session;
        }
        return store.findLastVisibleStatusBeforeDelete(session.tenantId(),
                session.sessionId())
                .map(session::withStatus)
                .orElse(session);
    }

    public PublicSession getPublicSession(String tenantId, String actorId,
            String sessionId) {
        return getPublicSession(tenantId, principalOf(tenantId, actorId),
                sessionId);
    }

    public PublicSession getPublicSession(SessionPrincipal principal,
            String sessionId) {
        return getPublicSession(
                principal == null ? null : principal.tenantId(), principal,
                sessionId);
    }

    private PublicSession getPublicSession(String tenantId,
            SessionPrincipal principal, String sessionId) {
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        var recovery = recoveryServices == null ? null : recoveryServices.getIfAvailable();
        return publicSession(session).withRecovery(recovery == null
                ? null : recovery.projection(session, principal));
    }

    public WebShellSession getWebShellSession(String tenantId, String actorId,
            String sessionId) {
        return getWebShellSession(tenantId, principalOf(tenantId, actorId),
                sessionId);
    }

    public WebShellSession getWebShellSession(SessionPrincipal principal,
            String sessionId) {
        return getWebShellSession(
                principal == null ? null : principal.tenantId(), principal,
                sessionId);
    }

    private WebShellSession getWebShellSession(String tenantId,
            SessionPrincipal principal, String sessionId) {
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        String actorId = principal == null ? null : principal.userId();
        var recovery = recoveryServices == null ? null : recoveryServices.getIfAvailable();
        return webShellSession(session, actorId).withRecovery(recovery == null
                ? null : recovery.projection(session, principal));
    }

    public PublicList<PublicSession> listPublicSessions(String tenantId,
            String actorId, String cursor, int requestedLimit) {
        return listPublicSessions(tenantId, actorId, cursor, requestedLimit, null, null);
    }

    public PublicList<PublicSession> listPublicSessions(String tenantId,
            String actorId, String cursor, int requestedLimit, String requestedArchiveState,
            String requestedTitleQuery) {
        return listPublicSessions(tenantId, principalOf(tenantId, actorId),
                cursor, requestedLimit, requestedArchiveState,
                requestedTitleQuery);
    }

    public PublicList<PublicSession> listPublicSessions(
            SessionPrincipal principal, String cursor, int requestedLimit,
            String requestedArchiveState, String requestedTitleQuery) {
        return listPublicSessions(
                principal == null ? null : principal.tenantId(), principal,
                cursor, requestedLimit, requestedArchiveState,
                requestedTitleQuery);
    }

    private PublicList<PublicSession> listPublicSessions(String tenantId,
            SessionPrincipal principal, String cursor, int requestedLimit,
            String requestedArchiveState, String requestedTitleQuery) {
        String archiveState = archiveState(requestedArchiveState);
        String titleQuery = titleQuery(requestedTitleQuery);
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor, archiveState, titleQuery);
        SessionPage page = filteredSessions(tenantId, principal, decoded, limit,
                archiveState, titleQuery);
        return new PublicList<>("list", publicSessions(page.sessions(), page.worktrees()), page.hasMore(),
                nextSessionCursor(page, archiveState, titleQuery));
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            String tenantId, String actorId, String cursor,
            int requestedLimit) {
        return listWebShellSessions(tenantId, actorId, cursor, requestedLimit, null);
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            String tenantId, String actorId, String cursor, int requestedLimit, String requestedArchiveState) {
        return listWebShellSessions(tenantId, actorId, cursor, requestedLimit, requestedArchiveState, null);
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            String tenantId, String actorId, String cursor, int requestedLimit,
            String requestedArchiveState, String requestedTitleQuery) {
        return listWebShellSessions(tenantId, principalOf(tenantId, actorId),
                cursor, requestedLimit, requestedArchiveState,
                requestedTitleQuery);
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            SessionPrincipal principal, String cursor, int requestedLimit,
            String requestedArchiveState, String requestedTitleQuery) {
        return listWebShellSessions(
                principal == null ? null : principal.tenantId(), principal,
                cursor, requestedLimit, requestedArchiveState,
                requestedTitleQuery);
    }

    private WebShellPage<WebShellSession> listWebShellSessions(String tenantId,
            SessionPrincipal principal, String cursor, int requestedLimit,
            String requestedArchiveState, String requestedTitleQuery) {
        String archiveState = archiveState(requestedArchiveState);
        String titleQuery = titleQuery(requestedTitleQuery);
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor, archiveState, titleQuery);
        SessionPage page = filteredSessions(tenantId, principal, decoded, limit,
                archiveState, titleQuery);
        return new WebShellPage<>(webShellSessions(page.sessions(),
                        principal == null ? null : principal.userId(),
                        page.worktrees()),
                nextSessionCursor(page, archiveState, titleQuery), page.hasMore());
    }

    public WebShellPage<WebShellSession> listOwnedWebShellSessions(
            SessionPrincipal principal, String cursor, int requestedLimit,
            String requestedArchiveState, String requestedTitleQuery) {
        if (principal == null) {
            throw new ManagedAgentException(401, "actor_required",
                    "A trusted actor is required.");
        }
        String archiveState = archiveState(requestedArchiveState);
        String titleQuery = titleQuery(requestedTitleQuery);
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor, archiveState, titleQuery);
        SessionPage page = store.listOwnedSessions(principal.tenantId(),
                principal,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.sessionId(), limit,
                archiveState, titleQuery);
        return new WebShellPage<>(webShellSessions(page.sessions(),
                principal.userId(), page.worktrees()),
                nextSessionCursor(page, archiveState, titleQuery),
                page.hasMore());
    }

    private SessionPage filteredSessions(String tenantId,
            SessionPrincipal principal, SessionCursor cursor,
            int limit, String archiveState, String titleQuery) {
        Long createdAt = cursor == null ? null : cursor.createdAt();
        String sessionId = cursor == null ? null : cursor.sessionId();
        return store.listSessions(tenantId, principal, createdAt, sessionId,
                limit, archiveState, titleQuery);
    }

    private static String archiveState(String requested) {
        String state = requested == null ? "all" : requested;
        if (!List.of("all", "unarchived", "archived").contains(state)) {
            throw new ManagedAgentException(400,
                    "invalid_archive_state", "Unknown archive state.");
        }
        return state;
    }

    private static String titleQuery(String requested) {
        if (requested != null && requested.codePointCount(0, requested.length()) > 512) {
            throw new ManagedAgentException(400,
                    "invalid_title_query", "Title query must not exceed 512 characters.");
        }
        if (requested == null) {
            return "";
        }
        int start = 0;
        int end = requested.length();
        while (start < end && titleWhitespace(requested.codePointAt(start))) {
            start += Character.charCount(requested.codePointAt(start));
        }
        while (end > start && titleWhitespace(requested.codePointBefore(end))) {
            end -= Character.charCount(requested.codePointBefore(end));
        }
        return requested.substring(start, end);
    }

    /**
     * A page of a Session's Turns, newest first. Every page checks the
     * Session again, so a cursor never outlives the caller's read access.
     */
    public PublicList<PublicTurn> listPublicTurns(String tenantId,
            String actorId, String sessionId, String cursor,
            int requestedLimit) {
        return listPublicTurns(tenantId, principalOf(tenantId, actorId),
                sessionId, cursor, requestedLimit);
    }

    public PublicList<PublicTurn> listPublicTurns(
            SessionPrincipal principal, String sessionId, String cursor,
            int requestedLimit) {
        return listPublicTurns(
                principal == null ? null : principal.tenantId(), principal,
                sessionId, cursor, requestedLimit);
    }

    private PublicList<PublicTurn> listPublicTurns(String tenantId,
            SessionPrincipal principal, String sessionId, String cursor,
            int requestedLimit) {
        int limit = limit(requestedLimit);
        TurnCursor decoded = decodeTurnCursor(cursor);
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        TurnPage page = store.listTurns(session.tenantId(),
                session.sessionId(),
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.turnId(), limit);
        return new PublicList<>("list", page.turns().stream()
                .map(ManagedAgentService::publicTurn).toList(),
                page.hasMore(), nextTurnCursor(page));
    }

    public PublicTurn getPublicTurn(String tenantId, String actorId,
            String sessionId, String turnId) {
        return getPublicTurn(tenantId, principalOf(tenantId, actorId),
                sessionId, turnId);
    }

    public PublicTurn getPublicTurn(SessionPrincipal principal,
            String sessionId, String turnId) {
        return getPublicTurn(principal == null ? null : principal.tenantId(),
                principal, sessionId, turnId);
    }

    private PublicTurn getPublicTurn(String tenantId,
            SessionPrincipal principal, String sessionId, String turnId) {
        // The path schema counts characters, not UTF-16 units.
        if (turnId.codePointCount(0, turnId.length()) > TURN_ID_MAX_LENGTH) {
            throw new ManagedAgentException(400, "invalid_request",
                    "The Turn id is invalid.");
        }
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        return store.findTurnSummary(session.tenantId(), session.sessionId(),
                turnId)
                .map(ManagedAgentService::publicTurn)
                .orElseThrow(() -> new ManagedAgentException(404,
                        "turn_not_found", "The Turn was not found."));
    }

    public PublicList<PublicEvent> publicEvents(String tenantId,
            String actorId, String sessionId, long afterSequence,
            int requestedLimit) {
        return publicEvents(tenantId, principalOf(tenantId, actorId),
                sessionId, afterSequence, requestedLimit);
    }

    public PublicList<PublicEvent> publicEvents(SessionPrincipal principal,
            String sessionId, long afterSequence, int requestedLimit) {
        return publicEvents(principal == null ? null : principal.tenantId(),
                principal, sessionId, afterSequence, requestedLimit);
    }

    private PublicList<PublicEvent> publicEvents(String tenantId,
            SessionPrincipal principal, String sessionId, long afterSequence,
            int requestedLimit) {
        requireEventCursor(afterSequence);
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        int limit = eventLimit(requestedLimit);
        List<EventRecord> rows = replayableEvents(session, afterSequence,
                limit + 1);
        boolean hasMore = rows.size() > limit;
        List<PublicEvent> events = rows.stream().limit(limit)
                .map(this::publicEvent).toList();
        String nextCursor = hasMore
                ? Long.toString(events.getLast().sequence()) : null;
        return new PublicList<>("list", events, hasMore, nextCursor);
    }

    public PublicItemList listPublicItems(String tenantId, String actorId,
            String sessionId, long afterSequence, int requestedLimit) {
        return listPublicItems(tenantId, actorId, sessionId, null, afterSequence, requestedLimit);
    }

    public PublicItemList listPublicItems(String tenantId, String actorId, String sessionId,
            String cursor, long afterSequence, int requestedLimit) {
        return listPublicItems(tenantId, principalOf(tenantId, actorId),
                sessionId, cursor, afterSequence, requestedLimit);
    }

    public PublicItemList listPublicItems(SessionPrincipal principal,
            String sessionId, String cursor, long afterSequence,
            int requestedLimit) {
        return listPublicItems(
                principal == null ? null : principal.tenantId(), principal,
                sessionId, cursor, afterSequence, requestedLimit);
    }

    private PublicItemList listPublicItems(String tenantId,
            SessionPrincipal principal, String sessionId, String cursor,
            long afterSequence, int requestedLimit) {
        if (afterSequence < 0) {
            throw new ManagedAgentException(400, "invalid_event_cursor", "Item sequence must be non-negative.");
        }
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        var page = store.findMessagePage(session.tenantId(),
                session.sessionId(), cursor, limit(requestedLimit), false,
                afterSequence);
        return new PublicItemList("list", page.items().stream().map(this::publicItem).toList(), page.hasMore(),
                page.nextCursor(), page.throughSequence());
    }

    public WebShellExportPage exportPage(String tenantId, String actorId,
            String sessionId, String cursor, int requestedLimit) {
        return messageExportPage(tenantId, actorId, sessionId, cursor, requestedLimit, false);
    }

    public WebShellExportPage exportPage(SessionPrincipal principal,
            String sessionId, String cursor, int requestedLimit) {
        return messageExportPage(
                principal == null ? null : principal.tenantId(), principal,
                sessionId, cursor, requestedLimit, false);
    }

    public WebShellTranscript transcript(String tenantId, String actorId,
            String sessionId, String cursor, int requestedLimit) {
        return transcript(tenantId, principalOf(tenantId, actorId), sessionId,
                cursor, requestedLimit);
    }

    public WebShellTranscript transcript(SessionPrincipal principal,
            String sessionId, String cursor, int requestedLimit) {
        return transcript(principal == null ? null : principal.tenantId(),
                principal, sessionId, cursor, requestedLimit);
    }

    private WebShellTranscript transcript(String tenantId,
            SessionPrincipal principal, String sessionId, String cursor,
            int requestedLimit) {
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        var page = store.findMessagePage(session.tenantId(), sessionId, cursor,
                requestedLimit, true);
        return new WebShellTranscript(page.items().stream().map(this::webShellItem).toList(),
                page.events().stream().map(this::webShellEvent).toList(), page.coveredSequence(),
                page.nextCursor(), page.hasMore(), page.coveredSequence());
    }

    public WebShellExportPage recentTranscriptItems(String tenantId, String actorId,
            String sessionId, String cursor, int requestedLimit) {
        return recentTranscriptItems(tenantId, principalOf(tenantId, actorId),
                sessionId, cursor, requestedLimit);
    }

    public WebShellExportPage recentTranscriptItems(
            SessionPrincipal principal, String sessionId, String cursor,
            int requestedLimit) {
        return recentTranscriptItems(
                principal == null ? null : principal.tenantId(), principal,
                sessionId, cursor, requestedLimit);
    }

    private WebShellExportPage recentTranscriptItems(String tenantId,
            SessionPrincipal principal, String sessionId, String cursor,
            int requestedLimit) {
        return messageExportPage(tenantId, principal, sessionId, cursor,
                requestedLimit, true);
    }

    private WebShellExportPage messageExportPage(String tenantId, String actorId,
            String sessionId, String cursor, int requestedLimit, boolean backward) {
        return messageExportPage(tenantId, principalOf(tenantId, actorId),
                sessionId, cursor, requestedLimit, backward);
    }

    private WebShellExportPage messageExportPage(String tenantId,
            SessionPrincipal principal, String sessionId, String cursor,
            int requestedLimit, boolean backward) {
        SessionRecord session = requireReadableSession(tenantId, principal,
                sessionId);
        var page = store.findMessagePage(session.tenantId(), sessionId, cursor,
                requestedLimit, backward);
        return new WebShellExportPage(page.items().stream().map(this::webShellItem).toList(),
                page.nextCursor(), page.hasMore(), page.throughSequence());
    }

    // Check the floor after reading events so a concurrent floor advance forces resync.
    private List<EventRecord> replayableEvents(SessionRecord session,
            long afterSequence, int limit) {
        List<EventRecord> events = store.findEvents(session.tenantId(),
                session.sessionId(), afterSequence, limit);
        ReplayWindow window = store.findReplayWindow(session.tenantId(),
                session.sessionId());
        if (afterSequence < window.floorSequence()) {
            throw new ReplayCursorExpired(window);
        }
        return events;
    }

    private static void requireEventCursor(long afterSequence) {
        if (afterSequence < 0) {
            throw new ManagedAgentException(400,
                    "invalid_event_cursor",
                    "Event sequence must be non-negative.");
        }
    }

    /** A page assembled from grouped batch reads instead of per-row ones. */
    private List<PublicSession> publicSessions(List<SessionRecord> sessions) {
        return publicSessions(sessions, sessions.isEmpty() ? Map.of() : store.findSessionWorktrees(
                sessions.getFirst().tenantId(), sessions.stream().filter(session -> session.workspace() != null)
                        .map(SessionRecord::sessionId).toList()));
    }

    private List<PublicSession> publicSessions(List<SessionRecord> sessions,
            Map<String, SessionWorktreeStore.Descriptor> worktrees) {
        if (sessions.isEmpty()) {
            return List.of();
        }
        String tenantId = sessions.getFirst().tenantId();
        List<String> ids = sessions.stream().map(SessionRecord::sessionId)
                .toList();
        Map<String, TurnSummary> activeTurns = store.findActiveTurns(tenantId,
                ids);
        Map<String, Long> coveredSequences = store
                .findMessageCoveredSequences(tenantId, ids);
        Set<String> closed = completedWorkspaceCloses(tenantId, sessions);
        var compressions = store.contextCompressionStates(tenantId, sessions.stream()
                .filter(session -> session.workspace() != null).map(SessionRecord::sessionId).toList());
        return sessions.stream()
                .map(session -> publicSession(session,
                        activeTurns.get(session.sessionId()),
                        coveredSequences.getOrDefault(session.sessionId(), 0L),
                        retention(session, closed), compressions.getOrDefault(session.sessionId(),
                                new AgentStateStore.ContextCompressionState(0, null)), worktrees.get(session.sessionId())))
                .toList();
    }

    /** The workspace-close state of each bound Session, in one read. */
    private Set<String> completedWorkspaceCloses(String tenantId,
            List<SessionRecord> sessions) {
        List<String> bound = sessions.stream()
                .filter(session -> session.workspace() != null)
                .map(SessionRecord::sessionId).toList();
        return bound.isEmpty() ? Set.of()
                : store.completedWorkspaceCloses(tenantId, bound);
    }

    private static boolean retention(SessionRecord session,
            Set<String> closed) {
        return session.workspace() == null
                || closed.contains(session.sessionId())
                        && (!WorkspaceToolProfiles.isShellOrMcp(session.toolProfile())
                                || WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) == 2
                                        && List.of("CLOSED", "ARCHIVED").contains(session.status()));
    }

    private PublicSession publicSession(SessionRecord session) {
        return publicSessions(List.of(session)).getFirst();
    }

    private PublicSession publicSession(SessionRecord session,
            TurnSummary activeTurn, long snapshotCoveredSequence,
            boolean retention, AgentStateStore.ContextCompressionState compression, SessionWorktreeStore.Descriptor worktree) {
        Map<String, Object> metadata = session.title() == null ? Map.of()
                : Map.of("title", session.title());
        // Every route these capabilities gate reads through
        // requireVisibleSession, which answers 404 once deletedAt is set —
        // a replay-after-delete body must not advertise affordances that
        // 404. DELETING stays advertised: those routes still answer while
        // the delete drains.
        boolean visible = session.deletedAt() == null;
        // The lifecycle affordances 404/409 on a tombstone exactly like the
        // content routes, so they take the same gate — as a conjunction,
        // never a replacement: a live Session keeps every flag it had.
        boolean close = visible && supportsClose(session);
        boolean keep = visible && retention;
        return new PublicSession(
                session.sessionId(),
                "agent.session",
                session.agentId(),
                session.agentRevision(),
                session.agentDefinitionDigest(),
                session.status().toLowerCase(Locale.ROOT),
                session.createdAt() / 1000,
                session.updatedAt() / 1000,
                metadata,
                activeTurn == null ? null : publicTurn(activeTurn),
                session.lastSequence(),
                session.replayFloorSequence(),
                snapshotCoveredSequence,
                // Bound close is advertised separately from archive/delete.
                new SessionCapabilities(
                        visible,
                        visible,
                        hasArtifacts(session),
                        visible,
                        session.workspace() == null && visible,
                        visible,
                        hasActions(session), close, keep, keep,
                        visible && supportsDelete(session, retention),
                        foregroundShell(session, worktree),
                        visible && "ACTIVE".equals(session.status()) && session.workspace() != null
                                && ready(worktree) && store.workspaceFilesEnabled() && compression.available() && harness.supportsContextCompression(),
                        childAgentsCapability(session, worktree)),
                publicWorkspace(session, worktree), compression.available() ? compression.compactionRevision() : null, compression.operationId())
                .withWorktree(worktree);
    }

    /** A page assembled from grouped batch reads instead of per-row ones. */
    private List<WebShellSession> webShellSessions(
            List<SessionRecord> sessions, String actorId) {
        return webShellSessions(sessions, actorId, sessions.isEmpty() ? Map.of() : store.findSessionWorktrees(
                sessions.getFirst().tenantId(), sessions.stream().filter(session -> session.workspace() != null)
                        .map(SessionRecord::sessionId).toList()));
    }

    private List<WebShellSession> webShellSessions(List<SessionRecord> sessions, String actorId,
            Map<String, SessionWorktreeStore.Descriptor> worktrees) {
        if (sessions.isEmpty()) {
            return List.of();
        }
        String tenantId = sessions.getFirst().tenantId();
        List<String> ids = sessions.stream().map(SessionRecord::sessionId)
                .toList();
        Map<String, TurnSummary> latestTurns = store.findLatestTurns(tenantId,
                ids);
        Map<String, EventRecord> environmentEvents = store
                .findLatestEnvironmentEvents(tenantId, latestTurns);
        List<String> boundIds = sessions.stream().filter(session -> session.workspace() != null)
                .map(SessionRecord::sessionId).toList();
        Set<String> lifecycleOwners = store.findApprovalOwners(tenantId, actorId, boundIds);
        var lifecycleOperations = store.findLatestLifecycleOperations(tenantId, ids);
        List<String> approvalIds = sessions.stream().filter(WorkspaceToolProfiles::supportsApprovalSelection)
                .map(SessionRecord::sessionId).toList();
        Map<String, WebShellApprovalSelection> approvalSelections = store.findApprovalSelections(tenantId, approvalIds);
        boolean approvalSupported = !approvalIds.isEmpty() && harness.supportsApprovalSelection();
        boolean definitionApprovalSupported = approvalSupported
                && sessions.stream().anyMatch(session -> session.agentDefinitionDigest() != null)
                && harness.supportsAgentDefinitionApprovalSelection();
        Map<String, WebShellModelSelection> modelSelections = store.findModelSelections(tenantId, boundIds);
        var compressions = store.contextCompressionStates(tenantId, boundIds);
        Map<String, WebShellModelContext> modelContexts = store.findModelContexts(tenantId, boundIds);
        boolean modelSelectionSupported = !store.modelOptions().isEmpty() && harness.supportsModelSelection();
        boolean renameSupported = harness.isAvailable() && harness.supportsFencedTitles();
        Set<String> closed = completedWorkspaceCloses(tenantId, sessions);
        boolean compressionSupported = harness.supportsContextCompression();
        // Cwd admission has no Turn execution-profile restriction. One role
        // grant read covers the workspaces of both shapes; the executable
        // facts read covers both id sets, retaining each capability's gates.
        Set<String> shaped = sessions.stream().filter(session -> inputPolicy.maySubmitShape(session, worktrees.get(session.sessionId())))
                .map(SessionRecord::sessionId)
                .collect(java.util.stream.Collectors.toSet());
        Set<String> contextShaped = sessions.stream().filter(session -> mayChangeContextShape(session, worktrees.get(session.sessionId())))
                .map(SessionRecord::sessionId)
                .collect(java.util.stream.Collectors.toSet());
        Set<String> candidateIds = new java.util.HashSet<>(shaped);
        candidateIds.addAll(contextShaped);
        sessions.stream().filter(session -> mayCompressShape(session, worktrees.get(session.sessionId())))
                .map(SessionRecord::sessionId).forEach(candidateIds::add);
        Set<String> grantWorkspaces = candidateIds.isEmpty() ? Set.of()
                : sessions.stream()
                        .filter(session -> candidateIds.contains(
                                session.sessionId()))
                        .map(session -> session.workspace().getWorkspaceId())
                        .collect(java.util.stream.Collectors.toSet());
        Map<String, ManagedWorkspaceRegistry.ReadableGrant> grants =
                grantWorkspaces.isEmpty() || actorId == null
                        || actorId.isEmpty() ? Map.of()
                        : submitterGrants(tenantId, actorId, grantWorkspaces);
        // The admission conjunct this mirrors: the caller's role above,
        // and the creator-keyed execution facts of each candidate Session,
        // batched exactly like the close state — skipped when the grant
        // read already proved nothing on the page can be admitted, the
        // zero-query shape the removed creator chain provided.
        boolean operatorGrant = grants.values().stream().anyMatch(
                ManagedWorkspaceRegistry.ReadableGrant::canCreateSession);
        Set<String> executable =
                candidateIds.isEmpty() || !operatorGrant ? Set.of()
                        : store.sessionsWithExecutionRegistryFacts(tenantId,
                                candidateIds);
        return sessions.stream()
                .map(session -> webShellSession(session,
                        latestTurns.get(session.sessionId()),
                        environmentEvents.get(session.sessionId()),
                        retention(session, closed),
                        session.workspace() == null || lifecycleOwners.contains(session.sessionId()),
                        lifecycleOperations.get(session.sessionId()),
                        inputPolicy.maySubmitWorkspaceTurn(session, grants, executable, worktrees.get(session.sessionId())),
                        mayChangeContext(session, grants, executable, worktrees.get(session.sessionId())),
                        modelContexts.get(session.sessionId()),
                        modelSelections.get(session.sessionId()), modelSelectionSupported, renameSupported,
                        compressionSupported && mayCompressContext(session, grants, executable, worktrees.get(session.sessionId())),
                        compressions.getOrDefault(session.sessionId(),
                                new AgentStateStore.ContextCompressionState(0, null)),
                        approvalSelections.get(session.sessionId()), approvalSupported
                                && WorkspaceToolProfiles.supportsApprovalSelection(session)
                                && (session.agentDefinitionDigest() == null || definitionApprovalSupported)
                                && lifecycleOwners.contains(session.sessionId()), worktrees.get(session.sessionId())))
                .toList();
    }

    // The registry key cannot encode every actor id a filter can supply;
    // that caller's page simply advertises no Workspace Turns.
    private Map<String, ManagedWorkspaceRegistry.ReadableGrant>
            submitterGrants(String tenantId, String actorId,
                    Set<String> workspaceIds) {
        try {
            return workspaces.findReadable(tenantId, actorId, workspaceIds);
        } catch (IllegalArgumentException error) {
            return Map.of();
        }
    }

    private WebShellSession webShellSession(SessionRecord session,
            String actorId) {
        return webShellSessions(List.of(session), actorId).getFirst();
    }

    private WebShellSession webShellSession(SessionRecord session,
            TurnSummary latestTurn, EventRecord environmentEvent,
            boolean retention, boolean lifecycleOwner, WebShellLifecycleOperation lifecycleOperation,
            boolean maySubmit, boolean mayChangeContext,
            WebShellModelContext modelContext, WebShellModelSelection modelSelection,
            boolean modelSelectionSupported, boolean renameSupported,
            boolean compressionSupported, AgentStateStore.ContextCompressionState compression,
            WebShellApprovalSelection approvalSelection, boolean approvalSupported, SessionWorktreeStore.Descriptor worktree) {
        boolean visible = session.deletedAt() == null;
        boolean publicChild = session.publicChildAgentsVersion() == 1
                && store.findChildLineage(session.tenantId(), session.sessionId()) != null;
        maySubmit = maySubmit && !publicChild;
        mayChangeContext = mayChangeContext && !publicChild;
        boolean close = visible && lifecycleOwner && supportsClose(session);
        boolean keep = visible && lifecycleOwner && retention;
        boolean approvalExecutable = approvalSelection == null || approvalSelection.revision() == 0
                || supportsApprovalSelection(session);
        approvalExecutable = approvalExecutable && (approvalSelection == null
                || !approvalSelection.planMode() || harness.supportsPlanMode());
        approvalExecutable = approvalExecutable && (approvalSelection == null
                || (!"auto".equals(approvalSelection.mode()) || harness.supportsAutoApproval())
                && (approvalSelection.permissionRules() == null || harness.supportsPermissionRules()));
        return new WebShellSession(
                session.sessionId(),
                session.title(),
                session.agentId(),
                session.status().toLowerCase(Locale.ROOT),
                session.createdAt(),
                session.updatedAt(),
                latestTurn == null ? null : webShellTurn(latestTurn),
                webShellEnvironment(environmentEvent),
                session.lastSequence(),
                webShellWorkspace(session, worktree),
                // Every Session serves its task list and detail; the tasks come from the
                // Stage H records its Session store holds (H0c). The
                // tombstone gate matches publicSession: every route these
                // capabilities gate 404s once deletedAt is set.
                new WebShellSessionCapabilities(visible,
                        hasArtifacts(session),
                        hasActions(session), maySubmit && approvalExecutable, close, keep, keep,
                        visible && lifecycleOwner && supportsDelete(session, retention),
                        false, foregroundShell(session, worktree),
                        visible && session.modelConfigDigest() == null && modelSelectionSupported && mayChangeContext,
                        visible && approvalSupported && mayChangeContext && !Boolean.FALSE.equals(foregroundShell(session, worktree)),
                        visible && maySubmit && !WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && harness.supportsInputAttachments(),
                        visible && "ACTIVE".equals(session.status()) && renameSupported
                                && (session.workspace() == null || maySubmit),
                        visible && approvalExecutable && compressionSupported && compression.available(),
                        childAgentsCapability(session, worktree)),
                session.workspace() != null || session.agentDefinitionDigest() != null
                        ? approvalSelection == null ? session.approvalMode() : approvalSelection.mode() : null,
                modelContext, modelSelection, approvalSelection == null ? null : approvalSelection.revision(),
                session.workspace() != null || session.agentDefinitionDigest() != null ? session.approvalMode() : null,
                approvalSelection != null && approvalSelection.planMode(), visible && approvalSupported
                        && mayChangeContext && harness.supportsPlanMode() && store.supportsPlanMode(session),
                compression.available() ? compression.compactionRevision() : null, compression.operationId(),
                lifecycleOperation).withWorktree(worktree);
    }

    private boolean supportsDelete(SessionRecord session, boolean retention) {
        if (CsiFilesRetirementProfile.PROFILE.equals(session.toolProfile())) {
            return false;
        }
        return retention || session.workspace() != null
                && RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())
                && (WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile())
                        ? harness.supportsSavedLifecycle(session.toolProfile()) : harness.supportsLifecycle(session.toolProfile()));
    }

    private Boolean childAgentsCapability(SessionRecord session, SessionWorktreeStore.Descriptor worktree) {
        if (session.publicChildAgentsVersion() != 1) {
            return null;
        }
        return session.deletedAt() == null && ready(worktree) && harness.supportsPublicChildAgents()
                && store.findChildLineage(session.tenantId(), session.sessionId()) == null;
    }

    private Boolean foregroundShell(SessionRecord session, SessionWorktreeStore.Descriptor worktree) {
        if (session.workspace() == null || !WorkspaceToolProfiles.isPublicShell(session.toolProfile())) {
            return null;
        }
        return session.deletedAt() == null && ready(worktree) && store.workspaceFilesEnabled() && store.workspaceShellEnabled()
                && WorkspaceToolProfiles.supportsApprovalMode(session.approvalMode())
                && (!"yolo".equals(session.approvalMode()) || supportsApprovalSelection(session));
    }

    private static WebShellWorkspace webShellWorkspace(SessionRecord session, SessionWorktreeStore.Descriptor worktree) {
        return session.workspace() == null ? null
                : new WebShellWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative(),
                        session.workspace().getContextRevision(),
                        workspaceState(worktree));
    }

    private static PublicWorkspace publicWorkspace(SessionRecord session, SessionWorktreeStore.Descriptor worktree) {
        return session.workspace() == null ? null
                : new PublicWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative(),
                        session.workspace().getContextRevision(),
                        workspaceState(worktree));
    }

    private static String workspaceState(SessionWorktreeStore.Descriptor worktree) {
        return ready(worktree) ? "ready" : "preparing".equals(worktree.state()) ? "changing" : "recovery_blocked";
    }

    private static Map<String, Object> webShellEnvironment(
            EventRecord event) {
        if (event == null) {
            return null;
        }
        String state = switch (event.type()) {
            case "environment.provisioning" -> "starting";
            case "environment.ready" -> "ready";
            case "environment.failed" -> "failed";
            default -> throw new IllegalStateException(
                    "Unexpected environment event: " + event.type());
        };
        Map<String, Object> environment = new LinkedHashMap<>();
        environment.put("state", state);
        Object environmentId = event.data().get("environmentId");
        if (environmentId instanceof String) {
            environment.put("environmentId", environmentId);
        }
        Object errorCode = event.data().get("code");
        if (errorCode instanceof String) {
            environment.put("errorCode", errorCode);
        }
        return Map.copyOf(environment);
    }

    private static PublicTurn publicTurn(TurnSummary turn) {
        return new PublicTurn(turn.turnId(), "agent.turn",
                turn.sessionId(), StoreModels.inputItemId(turn.turnId()),
                turn.status().toLowerCase(Locale.ROOT),
                turn.createdAt() / 1000,
                turn.completedAt() == null ? null
                        : turn.completedAt() / 1000,
                turn.errorCode());
    }

    private static WebShellTurn webShellTurn(TurnSummary turn) {
        return new WebShellTurn(turn.turnId(), turn.sessionId(),
                AgentStateStore.HARNESS_RECOVERY_BLOCKED.equals(turn.errorCode())
                        && ("RUNNING".equals(turn.status()) || "ACCEPTED".equals(turn.status()))
                        ? "recovery_blocked" : turn.status().toLowerCase(Locale.ROOT), turn.createdAt(),
                turn.completedAt(), turn.errorCode());
    }

    PublicEvent publicEvent(EventRecord event) {
        return new PublicEvent(event.schemaVersion(),
                event.projectionVersion(), event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.itemId(),
                event.contentPartId(), event.type(), event.createdAt() / 1000,
                event.data(), event.terminal());
    }

    WebShellEvent webShellEvent(EventRecord event) {
        return new WebShellEvent(event.schemaVersion(),
                event.projectionVersion(), event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.itemId(),
                event.contentPartId(), event.type(), event.createdAt(),
                event.data(), event.terminal());
    }

    private PublicItem publicItem(ItemRecord item) {
        return new PublicItem(item.itemId(), "agent.item",
                item.sessionId(), item.turnId(), item.type(), item.role(),
                item.revision(), item.status(), item.content().stream()
                        .map(this::publicContentPart).toList(),
                item.attributes(), item.firstSequence(), item.lastSequence(),
                item.createdAt() / 1000, item.updatedAt() / 1000);
    }

    private PublicContentPart publicContentPart(ItemPartRecord part) {
        return new PublicContentPart(part.partId(), part.type(), part.text(),
                part.firstSequence(), part.lastSequence());
    }

    private WebShellItem webShellItem(ItemRecord item) {
        return new WebShellItem(item.itemId(), item.sessionId(),
                item.turnId(), item.type(), item.role(), item.status(),
                item.content().stream().map(this::webShellContentPart)
                        .toList(),
                item.attributes(), item.firstSequence(), item.lastSequence(),
                item.createdAt(), item.updatedAt());
    }

    private WebShellContentPart webShellContentPart(ItemPartRecord part) {
        return new WebShellContentPart(part.partId(), part.type(), part.text(),
                part.firstSequence(), part.lastSequence());
    }

    private void dispatch(String tenantId, Admission admission) {
        dispatch(tenantId, admission, false);
    }

    private void dispatch(String tenantId, Admission admission,
            boolean workspaceBound) {
        // A replay answers while the Harness is down or the Workspace files
        // are off, but the replay itself must not spend the Turn's
        // pre-admission budget: re-dispatching here would let a client's
        // own retries defer the Turn into a terminal failure. During a
        // Harness outage nothing re-offers the parked Turn until
        // availability returns — the sweep gates on isAvailable() too.
        // During a Workspace-files outage the sweep still re-offers a bound
        // Turn and the outage hold keeps spending the budget: there the
        // sweep is the spender, not the rescuer.
        if (admission.turnId() != null && harness.isAvailable()
                && (!workspaceBound || harness.isWorkspaceFilesAvailable())
                && (worktreeReady(tenantId, admission.sessionId())
                        || store.findTurn(tenantId, admission.sessionId(), admission.turnId())
                                .filter(turn -> "CANCELLING".equals(turn.status())).isPresent())) {
            if (org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive()) {
                org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                        new org.springframework.transaction.support.TransactionSynchronization() {
                            @Override
                            public void afterCommit() { coordinator.dispatch(tenantId, admission.sessionId(), admission.turnId()); }
                        });
            } else {
                coordinator.dispatch(tenantId, admission.sessionId(), admission.turnId());
            }
        }
    }

    private boolean worktreeReady(String tenantId, String sessionId) {
        return ready(store.findSessionWorktree(tenantId, sessionId));
    }

    private static boolean ready(SessionWorktreeStore.Descriptor worktree) {
        return ManagedUserMessagePolicy.ready(worktree);
    }

    String lifecycleDigest(String sessionId, String operation) {
        return digests.digest(Map.of(
                "sessionId", sessionId, "operation", operation));
    }

    private void requireReadyWorktree(SessionRecord session) {
        var worktree = store.findSessionWorktree(session.tenantId(), session.sessionId());
        if (!ready(worktree)) {
            throw new ManagedAgentException(409,
                    worktree.errorCode() == null ? "worktree_" + worktree.state() : worktree.errorCode(),
                    "The Session worktree is not ready.");
        }
    }

    // The digest is computed from the validated title, so validation always
    // runs ahead of beginSessionMutation and its command row.
    private String renameDigest(String sessionId, String title) {
        return digests.digest(Map.of("sessionId", sessionId, "title",
                validRenameTitle(title)));
    }

    // The creator half of the replay gate, deferred into the replay arm:
    // the read-grant and role halves already ran above the replay, and a
    // recorded outcome answers to the actor who recorded it or to the
    // Session's creator. A legacy Session has no per-actor mutation gate
    // at all.
    private void requireReplayCreator(SessionRecord session,
            String actorId) {
        requireReplayCreator(session,
                principalOf(session.tenantId(), actorId));
    }

    private void requireReplayCreator(SessionRecord session,
            SessionPrincipal principal) {
        if (session.workspace() == null) {
            store.requireSessionAuthority(session.tenantId(),
                    session.sessionId(), principal);
            return;
        }
        if (!workspaces.createdSession(session.tenantId(),
                principal == null ? null : principal.userId(),
                session.sessionId())) {
            // Below the recorder/creator pass, so a recorded outcome still
            // answers its own actors on a tombstone; every other actor
            // meets the reads' 404 there, never the live-Session 409 that
            // would name the row.
            if ("DELETED".equals(session.status())) {
                throw new ManagedAgentException(404,
                        "session_not_found", "The Session was not found.");
            }
            throw new ManagedAgentException(409,
                    "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
    }

    // Cancelling aborts work that is already running, so it needs the
    // caller's OPERATOR and the Session's executable shape, not the
    // creator-keyed execution facts new work certifies: the delivery
    // reuses the admitted attachment and re-checks no grants. The role half
    // runs above the replay and the shape half below it, so a recorded
    // cancel still answers through an outage — the same split as submit.
    private void requireCancellerRole(SessionRecord session,
            String actorId) {
        requireCancellerRole(session,
                principalOf(session.tenantId(), actorId));
    }

    private void requireCancellerRole(SessionRecord session,
            SessionPrincipal principal) {
        if (session.workspace() == null) {
            store.requireSessionAuthority(session.tenantId(),
                    session.sessionId(), principal);
            return;
        }
        if (session.workspace() != null
                && !workspaces.accessOf(session.tenantId(),
                        principal == null ? null : principal.userId(),
                        session.workspace().getWorkspaceId())
                        .atLeast(WorkspaceAccess.OPERATOR)) {
            inputPolicy.requireLegacyWorkspace(session, principal);
        }
    }

    private void requireCancellerShape(SessionRecord session,
            String actorId) {
        requireCancellerShape(session,
                principalOf(session.tenantId(), actorId));
    }

    private void requireCancellerShape(SessionRecord session,
            SessionPrincipal principal) {
        if (session.workspace() == null) {
            store.requireSessionAuthority(session.tenantId(),
                    session.sessionId(), principal);
            return;
        }
        if (session.workspace() != null && !inputPolicy.maySubmitShape(session, null)) {
            inputPolicy.requireLegacyWorkspace(session, principal);
        }
    }

    void requireRecoveryOperator(SessionRecord session, String actorId) {
        requireRecoveryOperator(session,
                principalOf(session.tenantId(), actorId));
    }

    void requireRecoveryOperator(SessionRecord session,
            SessionPrincipal principal) {
        requireCancellerRole(session, principal);
        requireCancellerShape(session, principal);
    }

    // The tenant-wide command namespace is shared with callers' keys,
    // which are visible ASCII only (validateIdempotencyKey): the space
    // makes this key one no caller can claim first.
    private String childStopKey(String parentSessionId, String childRunId,
            String turnId) {
        return "child-stop " + digests.digest(Map.of(
                "parentSessionId", parentSessionId, "childRunId", childRunId,
                "turnId", turnId));
    }

    /**
     * H4f: who may cancel a task. A bound Session's tasks run under its
     * Workspace, so the caller needs OPERATOR there, as for cancelling a
     * Turn; a readable caller below it gets {@code 403 task_forbidden}.
     * Unlike the Turn rule, the Session's executable shape is not an
     * authorization fact: a Session that stopped serving work answers the
     * new-request state checks instead. An unbound Session has no role
     * model beyond its read access.
     */
    void requireTaskCanceller(SessionRecord session, String actorId) {
        requireTaskCanceller(session,
                principalOf(session.tenantId(), actorId));
    }

    void requireTaskCanceller(SessionRecord session,
            SessionPrincipal principal) {
        if (session.workspace() == null) {
            store.requireSessionAuthority(session.tenantId(),
                    session.sessionId(), principal);
            return;
        }
        if (session.workspace() != null
                && !workspaces.accessOf(session.tenantId(),
                        principal == null ? null : principal.userId(),
                        session.workspace().getWorkspaceId())
                        .atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(403, "task_forbidden",
                    "Only a Workspace operator may cancel the task.");
        }
    }

    // Model, approval and plan changes share the caller and execution
    // authority checks for changing an existing Session context.
    private boolean mayChangeContext(SessionRecord session,
            Map<String, ManagedWorkspaceRegistry.ReadableGrant> grants,
            java.util.Set<String> executable, SessionWorktreeStore.Descriptor worktree) {
        if (!mayChangeContextShape(session, worktree)) {
            return false;
        }
        var grant = grants.get(session.workspace().getWorkspaceId());
        return grant != null && grant.canCreateSession()
                && executable.contains(session.sessionId());
    }

    private boolean mayCompressShape(SessionRecord session, SessionWorktreeStore.Descriptor worktree) {
        return session.workspace() != null && "ACTIVE".equals(session.status())
                && session.deletedAt() == null && store.workspaceFilesEnabled()
                && ready(worktree);
    }

    private boolean mayCompressContext(SessionRecord session,
            Map<String, ManagedWorkspaceRegistry.ReadableGrant> grants, Set<String> executable, SessionWorktreeStore.Descriptor worktree) {
        if (!mayCompressShape(session, worktree)) {
            return false;
        }
        var grant = grants.get(session.workspace().getWorkspaceId());
        return grant != null && grant.canCreateSession() && executable.contains(session.sessionId());
    }

    private boolean mayChangeContextShape(SessionRecord session, SessionWorktreeStore.Descriptor worktree) {
        return session.workspace() != null && "ACTIVE".equals(session.status())
                && session.deletedAt() == null && store.workspaceFilesEnabled()
                && ready(worktree)
                && (WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile())
                        ? externalContextShapeAllowed(session)
                        : runtimeWarmer == null || runtimeWarmer.supportsWorkspaceContextChange(session.workspace()));
    }

    /**
     * Shape-only answer for the external profile, whose eligibility reads the
     * durable registration. That read refuses an unreadable, ambiguous or
     * undecodable record by throwing, while this predicate renders a capability
     * flag for every row of a Session page — letting it propagate would turn one
     * bad registration into a failed listing for unrelated Sessions.
     *
     * A refusal means eligibility is unproven, so the flag is false. Admission
     * still calls the throwing check on the mutating path, so nothing is
     * admitted on this weaker answer.
     */
    private boolean externalContextShapeAllowed(SessionRecord session) {
        try {
            return workspaces.externalFilesAllowed(session.workspace());
        } catch (RuntimeException unproven) {
            return false;
        }
    }

    void requireLegacyWorkspace(String tenantId, String actorId,
            String sessionId) {
        inputPolicy.requireLegacyWorkspace(tenantId, actorId, sessionId);
    }

    void requireLegacyWorkspace(String tenantId, SessionPrincipal principal,
            String sessionId) {
        inputPolicy.requireLegacyWorkspace(tenantId, principal, sessionId);
    }

    public SessionRecord requireReadableSession(String tenantId,
            String actorId, String sessionId) {
        return requireReadableSession(tenantId,
                principalOf(tenantId, actorId), sessionId);
    }

    public SessionRecord requireReadableSession(SessionPrincipal principal,
            String sessionId) {
        return requireReadableSession(
                principal == null ? null : principal.tenantId(), principal,
                sessionId);
    }

    /**
     * The tenant stays an explicit argument: an actorless legacy caller has a
     * null principal but still reads inside its own tenant, so re-deriving the
     * tenant from the principal would collapse the read to a null-tenant 404.
     */
    public SessionRecord requireReadableSession(String tenantId,
            SessionPrincipal principal, String sessionId) {
        SessionRecord session = inputPolicy.requireVisibleSession(tenantId,
                sessionId);
        requireReadGrant(session, principal);
        return session;
    }

    void requireReadGrant(SessionRecord session, String actorId) {
        requireReadGrant(session,
                principalOf(session.tenantId(), actorId));
    }

    void requireReadGrant(SessionRecord session,
            SessionPrincipal principal) {
        if (session.workspace() == null) {
            // The unified read authority runs for every caller, anonymous
            // included: a present ownership row is the sole authority (a
            // null principal never matches it), while a genuine legacy
            // Session that never wrote a row stays tenant-wide. The action
            // surface reads tenant-wide through requireActionReadableSession
            // instead.
            store.requireSessionReadAuthority(session.tenantId(),
                    session.sessionId(), principal);
            return;
        }
        if (!workspaces.canRead(session.tenantId(),
                principal == null ? null : principal.userId(),
                session.workspace().getWorkspaceId())) {
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
    }

    /**
     * The action surface read: visibility plus the Workspace read grant, but
     * tenant-wide for an unbound Session. The action gate enforces creator
     * authority itself (403 action_forbidden), so a foreign actor must reach
     * it rather than collapse to a 404 at the read.
     */
    public SessionRecord requireActionReadableSession(String tenantId,
            SessionPrincipal principal, String sessionId) {
        SessionRecord session = inputPolicy.requireVisibleSession(tenantId,
                sessionId);
        if (session.workspace() != null && !workspaces.canRead(
                session.tenantId(),
                principal == null ? null : principal.userId(),
                session.workspace().getWorkspaceId())) {
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
        return session;
    }

    public SessionRecord requireActionReadableSession(SessionPrincipal principal,
            String sessionId) {
        return requireActionReadableSession(
                principal == null ? null : principal.tenantId(), principal,
                sessionId);
    }

    private static SessionPrincipal principalOf(String tenantId,
            String actorId) {
        if (actorId == null || actorId.isBlank()) {
            return null;
        }
        return SessionPrincipal.ofUser(tenantId, actorId);
    }

    /**
     * Reads the next catch-up page of a stream.
     *
     * @throws ReplayCursorExpired when the cursor is below the replay floor
     *         when the message projection supplies the resynchronization state
     */
    List<EventRecord> streamEvents(SessionRecord session, long afterSequence) {
        requireEventCursor(afterSequence);
        return replayableEvents(session, afterSequence, STREAM_PAGE);
    }

    private static ManagedAgentException dependencyUnavailable(String code,
            String message) {
        return new ManagedAgentException(503, code,
                message);
    }

    private Admission replay(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        return store.findCommand(tenantId, operation, idempotencyKey)
                .map(ignored -> store.replayCommand(tenantId, operation,
                        idempotencyKey, requestDigest))
                .orElse(null);
    }

    // The creator-gated twin: the moment the key exists the caller must
    // be the actor its receipt recorded or the Session's creator, before
    // the digest comparison runs — its idempotency_conflict would
    // otherwise confirm to another actor that the key is live. A fresh key
    // never gates here; it meets the visibility and shape refusals below
    // the replay.
    private Admission replayForCreator(String tenantId, String operation,
            String idempotencyKey, String requestDigest,
            SessionRecord session, String actorId) {
        return replayForCreator(tenantId, operation, idempotencyKey,
                requestDigest, session,
                principalOf(tenantId, actorId));
    }

    private Admission replayForCreator(String tenantId, String operation,
            String idempotencyKey, String requestDigest,
            SessionRecord session, SessionPrincipal principal) {
        StoreModels.CommandRecord command = store.findCommand(tenantId,
                operation, idempotencyKey).orElse(null);
        if (command == null) {
            return null;
        }
        SessionRecord recordedSession = requireRecordedSessionGrant(command,
                session, principal);
        if (recordedSession.workspace() == null
                || !recordedByCaller(command,
                        principal == null ? null : principal.userId())) {
            requireReplayCreator(recordedSession, principal);
        }
        return store.replayCommand(tenantId, operation, idempotencyKey,
                requestDigest);
    }

    // The answer-side half of that gate. The pre-read can miss a key a
    // racer recorded inside its still-open transaction; the in-store probe
    // and the DuplicateKeyException arm then answer the recorded admission
    // with no gate at all, so a replayed answer re-runs the check on the
    // command row. The read stays a plain probe — never a locking one, so
    // AgentStateStore's replay-probe rule still holds.
    private void requireReplayedAdmission(String tenantId, String operation,
            String idempotencyKey, Admission admission, SessionRecord session,
            String actorId) {
        requireReplayedAdmission(tenantId, operation, idempotencyKey,
                admission, session,
                principalOf(tenantId, actorId));
    }

    private void requireReplayedAdmission(String tenantId, String operation,
            String idempotencyKey, Admission admission, SessionRecord session,
            SessionPrincipal principal) {
        if (!admission.replayed()) {
            return;
        }
        requireReplayActor(tenantId, operation, idempotencyKey, session,
                principal);
    }

    // The probe half, standing alone for the mutation routes whose replay
    // arms carry no Admission: rename's in-store COMPLETED read-back has
    // only the command row to interrogate. The read stays a plain probe —
    // never a locking one, so AgentStateStore's replay-probe rule still
    // holds.
    private void requireReplayActor(String tenantId, String operation,
            String idempotencyKey, SessionRecord session, String actorId) {
        requireReplayActor(tenantId, operation, idempotencyKey, session,
                principalOf(tenantId, actorId));
    }

    private void requireReplayActor(String tenantId, String operation,
            String idempotencyKey, SessionRecord session,
            SessionPrincipal principal) {
        StoreModels.CommandRecord command = store.findCommand(tenantId,
                operation, idempotencyKey).orElse(null);
        if (command == null) {
            return;
        }
        SessionRecord recordedSession = requireRecordedSessionGrant(command,
                session, principal);
        if (recordedSession.workspace() == null
                || !recordedByCaller(command,
                        principal == null ? null : principal.userId())) {
            requireReplayCreator(recordedSession, principal);
        }
    }

    private SessionRecord requireRecordedSessionGrant(
            StoreModels.CommandRecord command, SessionRecord requested,
            SessionPrincipal principal) {
        if (command.sessionId().equals(requested.sessionId())) {
            requireReadGrant(requested, principal);
            return requested;
        }
        // Cross-Session reuse of a tenant-global key. The refusal must match the
        // in-store receipt probe (requireMutationReceiptGrant) so it does not
        // depend on whether the receipt was visible before the insert.
        if (requested.workspace() == null) {
            // Unbound Sessions are private: hide a foreign key's existence by
            // gating on the recorded Session's ownership. A caller that cannot
            // read the recorded Session gets 404; the owner's own collision
            // falls through to idempotency_conflict.
            store.requireSessionAuthority(requested.tenantId(),
                    command.sessionId(), principal);
        } else {
            // Bound Workspace Sessions share their workspace context: gate on
            // the caller's own requested Session, never the recorded Session's
            // read grant (which would answer 404 for a Session the caller owns).
            requireReplayCreator(requested, principal);
        }
        throw new ManagedAgentException(409, "idempotency_conflict",
                "The idempotency key was reused with different content.");
    }

    // The recorder half of the replay admission: a command receipt names
    // the actor whose own retry the recorded outcome answers. An
    // unattributed or unstamped receipt leaves the creator gate in place.
    private boolean recordedByCaller(StoreModels.CommandRecord command,
            String actorId) {
        return command.admitsReplayBy(actorId);
    }

    private void requireHarness() {
        if (!harness.isAvailable()) {
            throw new ManagedAgentException(503,
                    "hosted_harness_disabled",
                    "Hosted Harness is not configured.");
        }
    }

    @Override
    public boolean supportsUserMessageQueue() {
        return inputPolicy.supportsUserMessageQueue();
    }

    @Override
    public SessionRecord authorizeUserMessageActor(String tenantId, String actorId, String sessionId) {
        return inputPolicy.authorizeUserMessageActor(tenantId, actorId,
                sessionId);
    }

    @Override
    public SessionRecord authorizeUserMessageActor(
            SessionPrincipal principal, String sessionId) {
        return inputPolicy.authorizeUserMessageActor(principal, sessionId);
    }

    @Override
    public SessionRecord authorizeUserMessages(String tenantId, String actorId, String sessionId) {
        return inputPolicy.authorizeUserMessages(tenantId, actorId, sessionId);
    }

    @Override
    public SessionRecord authorizeUserMessages(
            SessionPrincipal principal, String sessionId) {
        return inputPolicy.authorizeUserMessages(principal, sessionId);
    }

    @Override
    public List<Map<String, Object>> userMessageInput(List<InputBlock> blocks) {
        return inputPolicy.userMessageInput(blocks);
    }

    /** The input the digest and the column both describe: an unpaired
     * surrogate, which no store column keeps, trades for U+FFFD at
     * admission — before the payload digest, the replay digest and the
     * insert — so all three name one representation. Well-formed
     * surrogate pairs and every non-string value pass through. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> normalizeInput(
            List<Map<String, Object>> input) {
        return ManagedUserMessagePolicy.normalizeInput(input);
    }

    private static Object normalizeValue(Object value) {
        return ManagedUserMessagePolicy.normalizeValue(value);
    }

    static String replaceLoneSurrogates(String text) {
        return ManagedUserMessagePolicy.replaceLoneSurrogates(text);
    }

    private static String metadataTitle(String explicitTitle,
            Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return validTitle(explicitTitle);
        }
        if (metadata.size() > 16) {
            throw new ManagedAgentException(400,
                    "invalid_metadata", "Metadata accepts at most 16 keys.");
        }
        for (Map.Entry<String, Object> entry : metadata.entrySet()) {
            if (!(entry.getValue() instanceof String)
                    || entry.getKey().length() > 64
                    || (!"title".equals(entry.getKey())
                            && ((String) entry.getValue()).length() > 512)) {
                throw new ManagedAgentException(400,
                        "invalid_metadata", "Metadata limits were exceeded.");
            }
            if (!"title".equals(entry.getKey())) {
                throw new ManagedAgentException(400,
                        "unsupported_feature",
                        "Phase 1 persists metadata.title only.");
            }
        }
        Object title = metadata.get("title");
        return validTitle(explicitTitle != null ? explicitTitle
                : title instanceof String ? (String) title : null);
    }

    // One title policy for create, metadata and rename: 256 — the Hosted
    // Harness client's own cap, the only downstream bound that cannot be
    // worked around — plus the control-character rule. A title the API
    // accepts must stay writable through every path.
    private static boolean unicodeBlank(String title) {
        return title.codePoints().allMatch(ManagedAgentService::titleWhitespace);
    }

    private static boolean titleWhitespace(int character) {
        return Character.isWhitespace(character) || Character.isSpaceChar(character)
                || character == 0xfeff;
    }

    private static String validTitle(String title) {
        if (title == null) {
            return null;
        }
        if (title.length() > 256) {
            throw new ManagedAgentException(400, "invalid_title",
                    "Title must not exceed 256 characters.");
        }
        if (title.chars().anyMatch(character -> character <= 31
                || character == 127)) {
            throw new ManagedAgentException(400, "invalid_title",
                    "Title must not contain control characters.");
        }
        return unicodeBlank(title) ? null : title;
    }

    private static String validRenameTitle(String title) {
        if (title == null || unicodeBlank(title)) {
            throw new ManagedAgentException(400, "invalid_title",
                    "Title must contain 1-256 characters.");
        }
        return validTitle(title);
    }

    public static void validateIdempotencyKey(String key) {
        if (key == null || !IDEMPOTENCY_KEY.matcher(key).matches()) {
            throw new ManagedAgentException(400,
                    "invalid_idempotency_key",
                    "Idempotency-Key must contain 1-128 visible characters.");
        }
    }

    private static int limit(int requested) {
        if (requested <= 0 || requested > 100) {
            throw new ManagedAgentException(400, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
        return requested;
    }

    private static int eventLimit(int requested) {
        if (requested <= 0 || requested > 1000) {
            throw new ManagedAgentException(400, "invalid_limit",
                    "Limit must be between 1 and 1000.");
        }
        return requested;
    }

    private static String nextSessionCursor(SessionPage page, String archiveState, String titleQuery) {
        if (!page.hasMore() || page.sessions().isEmpty()) {
            return null;
        }
        SessionRecord last = page.sessions().getLast();
        String prefix = "v3:" + archiveState + ":" + DigestUtils.sha256Hex(titleQuery) + ":";
        return encodeCursor(prefix + last.createdAt() + ":" + last.sessionId());
    }

    private static String encodeCursor(String raw) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    private static SessionCursor decodeCursor(String cursor, String archiveState, String titleQuery) {
        if (StringUtils.isBlank(cursor)) {
            return null;
        }
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
            String prefix = "v3:" + archiveState + ":" + DigestUtils.sha256Hex(titleQuery) + ":";
            if (!decoded.startsWith(prefix)) {
                throw new IllegalArgumentException();
            }
            decoded = decoded.substring(prefix.length());
            int separator = decoded.indexOf(':');
            if (separator <= 0 || separator == decoded.length() - 1) {
                throw new IllegalArgumentException();
            }
            return new SessionCursor(Long.parseLong(
                    decoded.substring(0, separator)),
                    decoded.substring(separator + 1));
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(400,
                    "invalid_cursor", "Session cursor is invalid.");
        }
    }

    private static String nextTurnCursor(TurnPage page) {
        if (!page.hasMore() || page.turns().isEmpty()) {
            return null;
        }
        TurnSummary last = page.turns().getLast();
        String raw = last.createdAt() + ":" + last.turnId();
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                raw.getBytes(StandardCharsets.UTF_8));
    }

    private static TurnCursor decodeTurnCursor(String cursor) {
        if (StringUtils.isBlank(cursor)) {
            return null;
        }
        String decoded;
        try {
            decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            decoded = "";
        }
        var matcher = TURN_CURSOR.matcher(decoded);
        try {
            if (matcher.matches()) {
                return new TurnCursor(Long.parseLong(matcher.group(1)),
                        matcher.group(2));
            }
        } catch (NumberFormatException error) {
            // A creation time beyond a long is not a cursor this server wrote.
        }
        throw new ManagedAgentException(400, "invalid_cursor",
                "Turn cursor is invalid.");
    }

    private static CommandAdmission response(Admission admission) {
        return new CommandAdmission(admission.sessionId(),
                admission.turnId(), "accepted", admission.replayed());
    }

    private CommandAdmission response(String tenantId, Admission admission) {
        var operation = store.findOperation(tenantId, admission.sessionId(),
                Objects.requireNonNull(admission.operationId(), "Turn admission operation"))
                .orElseThrow(() -> new IllegalStateException("Turn admission operation is missing"));
        return new CommandAdmission(admission.sessionId(), admission.turnId(),
                "accepted", admission.replayed(), operation.operationId(),
                operation.admissionStage().toLowerCase(Locale.ROOT),
                operation.deliveryState().toLowerCase(Locale.ROOT));
    }

    private record SessionCursor(long createdAt, String sessionId) {
    }

    private record TurnCursor(long createdAt, String turnId) {
    }

    public record SessionMutationResult<T>(T body, boolean replayed) {
    }
}
