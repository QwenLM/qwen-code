package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
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
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellItem;
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
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ItemPartRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeWarmer;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
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
public class ManagedAgentService {
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
    // Catch-up reads of a stream use pages of this size.
    static final int STREAM_PAGE = 100;
    // A context stays ready until cwd changes arrive (W2).
    private static final String WORKSPACE_STATE = "ready";
    // "text" is the spelling that clients used before the contract.
    private static final Set<String> INPUT_TYPES = Set.of("input_text",
            "text");
    // The per-block cap (1M chars) times the per-list cap (100) would
    // otherwise admit ~100M characters in a single command.
    private static final int MAX_AGGREGATE_INPUT_CHARS = 4 * 1000 * 1000;
    private static final int MAX_BLOCK_INPUT_CHARS = 1000 * 1000;
    private final AgentStateStore store;
    private final ManagedWorkspaceRegistry workspaces;
    private final RequestDigests digests;
    private final HarnessCoordinator coordinator;
    private final HarnessConnector harness;
    private RuntimeWarmer runtimeWarmer;
    private JavaDurableAdmission javaDurableAdmission;
    private ManagedAgentProperties.Dispatch renameDispatch = new ManagedAgentProperties.Dispatch();
    private Clock renameClock = Clock.systemUTC();

    @Autowired
    void configureRenameDelivery(ManagedAgentProperties properties, Clock clock) {
        renameDispatch = properties.getDispatch();
        renameClock = clock;
    }

    @Autowired(required = false)
    void setRuntimeWarmer(RuntimeWarmer runtimeWarmer) {
        this.runtimeWarmer = runtimeWarmer;
    }

    // D7-3: present only when the deployment enables the java_durable
    // admission profile (JavaDurableAdmissionConfiguration); null keeps
    // every admission on its harness_confirmed response.
    @Autowired(required = false)
    void setJavaDurableAdmission(JavaDurableAdmission javaDurableAdmission) {
        this.javaDurableAdmission = javaDurableAdmission;
    }

    private boolean supportsClose(SessionRecord session) {
        if (CsiFilesRetirementProfile.PROFILE.equals(session.toolProfile())) {
            return false;
        }
        return session.workspace() == null || RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())
                && harness.supportsLifecycle(session.toolProfile());
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
    void configureArtifacts(ManagedAgentProperties properties,
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
            HarnessConnector harness, ManagedWorkspaceRegistry workspaces) {
        this.store = store;
        this.workspaces = workspaces;
        this.digests = digests;
        this.coordinator = coordinator;
        this.harness = harness;
    }

    public CommandAdmission createSession(String tenantId,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks) {
        return createSession(tenantId, null, idempotencyKey, agentId,
                agentRevision, title, metadata, blocks);
    }

    public CommandAdmission createSession(String tenantId, String actorId,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks) {
        validateIdempotencyKey(idempotencyKey);
        List<Map<String, Object>> input = input(blocks, false);
        String effectiveTitle = metadataTitle(title, metadata);
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("agentId", agentId);
        if (agentRevision != null) {
            semantic.put("agentRevision", agentRevision);
        }
        semantic.put("title", effectiveTitle);
        semantic.put("input", input);
        String requestDigest = digests.digest(semantic);
        // Replay before the harness gate: re-serving an already-recorded
        // command admits nothing new and must not 503 during a harness
        // outage.
        Admission replay = replay(tenantId, CREATE, idempotencyKey,
                requestDigest);
        if (replay != null) {
            dispatch(tenantId, replay);
            return response(replay);
        }
        if (!input.isEmpty()) {
            requireHarness();
        }
        String payloadDigest = input.isEmpty() ? null
                : SubmitHarnessTurn.computePayloadDigest(input);
        Admission admission;
        try {
            admission = store.insertSessionCommand(tenantId, actorId, CREATE,
                    idempotencyKey, requestDigest, agentId, agentRevision,
                    effectiveTitle, input, payloadDigest);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, CREATE,
                    idempotencyKey, requestDigest);
        }
        dispatch(tenantId, admission);
        return response(admission);
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
        if ("qwen-code".equals(agentId) && store.workspaceShellEnabled() && harness.supportsApprovalSelection()) {
            return new WebShellSessionOptions(options.approvalMode(), List.of("default", "auto-edit", "yolo"),
                    harness.supportsPlanMode(), harness.supportsInputAttachments());
        }
        return new WebShellSessionOptions(options.approvalMode(), options.availableApprovalModes(),
                harness.supportsPlanMode() && harness.supportsAgentDefinitionApprovalSelection()
                        && options.planModeSupported(),
                harness.supportsInputAttachments());
    }

    public WebShellSessionModels queryWebShellSessionModels(String tenantId, String actorId,
            String sessionId) {
        requireModelActor(actorId);
        SessionRecord session = requireReadableSession(tenantId, actorId, sessionId);
        boolean supported = session.workspace() != null && store.workspaceFilesEnabled()
                && !store.modelOptions().isEmpty() && harness.supportsModelSelection();
        return new WebShellSessionModels(store.modelOptions(),
                store.findModelSelections(tenantId, List.of(sessionId)).getOrDefault(sessionId,
                        new WebShellModelSelection(null, 0)), supported);
    }

    public WebShellModelChangeResult changeWebShellSessionModel(String tenantId, String actorId,
            String sessionId, String key, String modelId, long expectedRevision) {
        requireModelActor(actorId);
        validateIdempotencyKey(key);
        String digest = digests.digest(Map.of("sessionId", sessionId, "modelId", modelId,
                "expectedRevision", expectedRevision));
        return store.changeSessionModel(tenantId, actorId, sessionId, key, digest, modelId,
                expectedRevision, harness.supportsModelSelection());
    }

    public WebShellSessionApproval queryWebShellSessionApproval(String tenantId, String actorId, String sessionId) {
        requireModelActor(actorId);
        var summary = getWebShellSession(tenantId, actorId, sessionId);
        if (summary.workspace() == null) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature", "Approval selection requires a Workspace Session");
        }
        boolean supported = Boolean.TRUE.equals(summary.capabilities().approvalModeChange());
        return new WebShellSessionApproval(summary.approvalMode(),
                summary.approvalRevision() == null ? 0 : summary.approvalRevision(),
                supported ? List.of("default", "auto-edit", "yolo")
                        : summary.approvalMode() == null ? List.of() : List.of(summary.approvalMode()), supported,
                summary.planMode(), summary.planModeSupported());
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String mode, long expectedRevision) {
        return changeWebShellSessionApproval(tenantId, actorId, sessionId, key, mode, expectedRevision, null);
    }

    public WebShellApprovalChangeResult changeWebShellSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String mode, long expectedRevision, Boolean planMode) {
        requireModelActor(actorId);
        validateIdempotencyKey(key);
        Map<String, Object> semantic = new LinkedHashMap<>(Map.of("sessionId", sessionId,
                "mode", mode, "expectedRevision", expectedRevision));
        if (planMode != null) {
            semantic.put("planMode", planMode);
        }
        String digest = digests.digest(semantic);
        return store.changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode,
                expectedRevision, harness.supportsApprovalSelection(), harness.supportsAgentDefinitionApprovalSelection(),
                planMode, harness.supportsPlanMode());
    }

    private static void requireModelActor(String actorId) {
        if (actorId == null || actorId.isEmpty()) {
            throw new ManagedAgentException(HttpStatus.UNAUTHORIZED, "actor_required", "A trusted actor is required");
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
        validateIdempotencyKey(idempotencyKey);
        if (actorId == null || actorId.isEmpty()) {
            throw new ManagedAgentException(HttpStatus.UNAUTHORIZED,
                    "actor_required", "A trusted actor is required.");
        }
        List<Map<String, Object>> input = input(blocks, false);
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
        String requestDigest = digests.digest(semantic);
        String payloadDigest = input.isEmpty() ? null
                : SubmitHarnessTurn.computePayloadDigest(input);
        // Replay before the availability gate, like the legacy paths: a
        // recorded success must answer even while Workspace files are off.
        Optional<Admission> recorded = store.findWorkspaceCreateReplay(
                tenantId, actorId, idempotencyKey, requestDigest);
        if (recorded.isPresent()) {
            dispatch(tenantId, recorded.get(), true);
            return response(recorded.get());
        }
        if (!input.isEmpty() && !harness.isWorkspaceFilesAvailable()) {
            throw new ManagedAgentException(HttpStatus.CONFLICT,
                    "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
        Admission admission;
        try {
            admission = approvalMode == null && planMode == null
                    ? store.insertWorkspaceSessionCommand(tenantId,
                            actorId, idempotencyKey, requestDigest, agentId,
                            agentRevision, effectiveTitle, input, payloadDigest, selection)
                    : store.insertWorkspaceSessionCommand(tenantId,
                            actorId, idempotencyKey, requestDigest, agentId,
                            agentRevision, effectiveTitle, input, payloadDigest,
                            selection, approvalMode, harness.supportsApprovalSelection()
                                    && ("qwen-code".equals(agentId) || harness.supportsAgentDefinitionApprovalSelection()),
                            planMode, harness.supportsPlanMode());
        } catch (DuplicateKeyException error) {
            admission = store.replayWorkspaceSessionCommand(tenantId,
                    actorId, idempotencyKey, requestDigest);
        }
        // A creation with input warms through its first Turn's dispatch.
        if (admission.turnId() == null) {
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
        List<Map<String, Object>> input = input(blocks, false);
        String title = description.isBlank() ? "child agent"
                : StringUtils.truncate(description, 256);
        return insertChildSession(tenantId, parentSessionId, childRunId,
                title, input, isolated);
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
        List<Map<String, Object>> normalizedInput = normalizeInput(input);
        SessionRecord parent = store.requireSession(tenantId, parentSessionId);
        if (parent.workspace() == null || !"ACTIVE".equals(parent.status())
                || CsiFilesRetirementProfile.PROFILE.equals(parent.toolProfile())) {
            throw new ManagedAgentException(HttpStatus.CONFLICT,
                    "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        String creationKey = childCreationKey(parentSessionId, childRunId);
        if (!normalizedInput.isEmpty() && !harness.isWorkspaceFilesAvailable()) {
            throw new ManagedAgentException(HttpStatus.CONFLICT,
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
                throw new ManagedAgentException(HttpStatus.CONFLICT,
                        "child_workspace_not_ready",
                        "The child run's Workspace is not ready to bind a child Session.");
            }
        }
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("child", childRunId);
        semantic.put("title", title);
        semantic.put("input", normalizedInput);
        if (childCwd != null) {
            semantic.put("workspace", childCwd);
        }
        String requestDigest = digests.digest(semantic);
        StoreModels.Admission admission;
        try {
            admission = childCwd == null
                    ? store.insertChildSessionCommand(tenantId,
                            parentSessionId, creationKey, requestDigest, title,
                            normalizedInput,
                            SubmitHarnessTurn.computePayloadDigest(normalizedInput),
                            lineage)
                    : store.insertChildSessionCommand(tenantId,
                            parentSessionId, creationKey, requestDigest, title,
                            normalizedInput,
                            SubmitHarnessTurn.computePayloadDigest(normalizedInput),
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
        return submitTurn(tenantId, actorId, idempotencyKey, sessionId,
                blocks, null);
    }

    /**
     * Admits a Turn input. An admission that asks for the java_durable
     * profile (D7-3) is answered with the submit_input operation it saved,
     * as the profile reports it; the request digest leaves the profile out,
     * so a retry under the key replays the same command in either view.
     */
    public CommandAdmission submitTurn(String tenantId, String actorId,
            String idempotencyKey, String sessionId,
            List<InputBlock> blocks, String admissionProfile) {
        boolean durable = requireAdmissionProfile(admissionProfile);
        validateIdempotencyKey(idempotencyKey);
        List<Map<String, Object>> input = input(blocks, true);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "input", input));
        SessionRecord session = store.requireSession(tenantId, sessionId);
        // The role gate stays above the replay: an idempotency key answers
        // its recorded outcome only to an actor authorized for the Session.
        // Its 404 arm doubles as the tombstone fence a grant-less caller
        // would meet below the replay, so a reused key's 409 never leaks to
        // one, and a below-OPERATOR reader never reaches a recorded key —
        // the command family's replay is not actor-scoped (#13619).
        requireSubmitterRole(session, actorId);
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
                idempotencyKey, requestDigest, session, actorId);
        if (replay != null) {
            CommandAdmission body = response(tenantId, replay, durable);
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
        requireVisibleSession(session);
        requireSubmitterFacts(session, actorId);
        requireHarness();
        String payloadDigest = SubmitHarnessTurn.computePayloadDigest(input);
        Admission admission;
        try {
            admission = store.insertTurnCommand(tenantId, SUBMIT,
                    idempotencyKey, requestDigest, sessionId, input,
                    payloadDigest, actorId);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, SUBMIT,
                    idempotencyKey, requestDigest);
        }
        requireReplayedAdmission(tenantId, SUBMIT, idempotencyKey, admission,
                session, actorId);
        // Built before the dispatcher runs, so the body reports the
        // operation as its admission saved it.
        CommandAdmission body = response(tenantId, admission, durable);
        dispatch(tenantId, admission, session.workspace() != null);
        return body;
    }

    public CommandAdmission cancelTurn(String tenantId, String actorId,
            String idempotencyKey, String sessionId, String turnId) {
        return cancelTurn(tenantId, actorId, idempotencyKey, sessionId,
                turnId, null);
    }

    /** Admits a Turn cancel; the profile works as for submitTurn. */
    public CommandAdmission cancelTurn(String tenantId, String actorId,
            String idempotencyKey, String sessionId, String turnId,
            String admissionProfile) {
        boolean durable = requireAdmissionProfile(admissionProfile);
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
        requireCancellerRole(session, actorId);
        Admission replay = replayForCreator(tenantId, CANCEL,
                idempotencyKey, requestDigest, session, actorId);
        if (replay != null) {
            CommandAdmission body = response(tenantId, replay, durable);
            dispatch(tenantId, replay, session.workspace() != null);
            return body;
        }
        requireVisibleSession(session);
        requireCancellerShape(session, actorId);
        Admission admission;
        try {
            admission = store.insertCancelCommand(tenantId, CANCEL,
                    idempotencyKey, requestDigest, sessionId, turnId,
                    actorId);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, CANCEL,
                    idempotencyKey, requestDigest);
        }
        requireReplayedAdmission(tenantId, CANCEL, idempotencyKey, admission,
                session, actorId);
        CommandAdmission body = response(tenantId, admission, durable);
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
        validateIdempotencyKey(idempotencyKey);
        // A recorded rename answers before the shape and availability gates
        // a deleted Session can no longer pass, but only when the recorded
        // command IS this request — the key is tenant-global, so a key
        // another Session consumed falls through to beginSessionRename,
        // which answers idempotency_conflict. The actor gates stay ahead
        // of the outcome, exactly as the fresh path applies them — the
        // OPERATOR role, whose 404 arm covers the read grant, and the
        // creator half, because the recorded outcome stays creator-scoped —
        // and the read-only probe never writes the PENDING row
        // beginSessionRename would create for a fresh key.
        StoreModels.CommandRecord recorded = store.findCommand(tenantId,
                RENAME, idempotencyKey).orElse(null);
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
            requireSubmitterRole(session, actorId);
            if (!recordedByCaller(recorded, actorId)) {
                requireReplayCreator(session, actorId);
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
        SessionRecord current = requireVisibleSession(tenantId, sessionId);
        requireSubmitterRole(current, actorId);
        requireSubmitterFacts(current, actorId);
        // A row written before the bound was unified can still hold a title
        // past 256: echoing that stored title back is a no-op rewrite,
        // tolerated in the row but never forwarded to the Harness — its own
        // 256-unit client cap is the bound the policy protects.
        if (title != null && title.length() > 256
                && title.equals(current.title())) {
            return new SessionMutationResult<>(publicSession(current), false);
        }
        String effectiveTitle = validRenameTitle(title);
        requireHarness();
        if (!harness.supportsFencedTitles()) {
            throw dependencyUnavailable("hosted_harness_unavailable",
                    "The Hosted Harness must support title protocol version 1.");
        }
        SessionMutationCommand command = store.beginSessionRename(tenantId,
                idempotencyKey, renameDigest(sessionId, title), sessionId,
                effectiveTitle, actorId);
        if (!"COMPLETED".equals(command.status())) {
            String owner = UUID.randomUUID().toString();
            var candidate = new StoreModels.RenameDelivery(tenantId, sessionId,
                    idempotencyKey, effectiveTitle, command.renameRevision(), 0);
            var delivery = store.claimRename(candidate, owner, renameDispatch.getLeaseDuration()).orElse(null);
            if (delivery == null) {
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
                if (error instanceof DaemonHttpException refusal
                        && refusal.getStatusCode() == HttpStatus.CONFLICT.value()
                        && "session_mutation_superseded".equals(refusal.getErrorCode())) {
                    throw new ManagedAgentException(HttpStatus.CONFLICT,
                            "session_mutation_superseded",
                            "A later Session title attempt has been admitted.");
                }
                if (error instanceof ManagedAgentException failure) {
                    throw failure;
                }
                if (error instanceof RuntimeBrokerException refusal
                        && !refusal.isRetryable()) {
                    HttpStatus status = HttpStatus.resolve(
                            refusal.getStatusCode());
                    throw new ManagedAgentException(
                            status == null ? HttpStatus.CONFLICT : status,
                            refusal.getCode(), refusal.getMessage());
                }
                // Chain and log the root cause: a plain 503 leaves on-call
                // unable to tell a network fault from a daemon bug. The
                // catch wraps the store calls too, so the WARN names the
                // operation rather than a subsystem the fault may not be in.
                LOG.warn("Managed Agent rename failed tenant={} session={}",
                        tenantId, sessionId, error);
                throw new ManagedAgentException(HttpStatus.SERVICE_UNAVAILABLE,
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
                actorId);
        return new SessionMutationResult<>(publicSession(
                asLastVisible(replayed)), true);
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

    public SessionMutationResult<WebShellSession> unarchiveWebShellSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        var result = unarchive(tenantId, actorId, idempotencyKey, sessionId);
        SessionRecord session = result.replayed()
                ? asLastVisible(result.session()) : result.session();
        return new SessionMutationResult<>(webShellSession(session, actorId),
                result.replayed());
    }

    private StoreModels.SessionMutation unarchive(String tenantId, String actorId,
            String idempotencyKey, String sessionId) {
        validateIdempotencyKey(idempotencyKey);
        SessionRecord target = store.requireSession(tenantId, sessionId);
        if (target.workspace() != null) {
            requireReadGrant(target, actorId);
            String scopedKey = digests.digest(Map.of("sessionId", sessionId,
                    "actorDigest", digests.digest(Map.of("actorId", actorId)), "idempotencyKey", idempotencyKey));
            return store.unarchiveWorkspaceSession(tenantId, sessionId, actorId,
                    scopedKey, lifecycleDigest(sessionId, UNARCHIVE));
        }
        requireLegacyWorkspace(tenantId, actorId, sessionId);
        String requestDigest = lifecycleDigest(sessionId, UNARCHIVE);
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                UNARCHIVE, idempotencyKey, requestDigest, sessionId,
                SessionMutationKind.UNARCHIVE);
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
        return publicSession(requireReadableSession(tenantId, actorId,
                sessionId));
    }

    public WebShellSession getWebShellSession(String tenantId, String actorId,
            String sessionId) {
        return webShellSession(requireReadableSession(tenantId, actorId,
                sessionId), actorId);
    }

    public PublicList<PublicSession> listPublicSessions(String tenantId,
            String actorId, String cursor, int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId, actorId,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        return new PublicList<>("list", publicSessions(page.sessions()),
                page.hasMore(), nextCursor(page));
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            String tenantId, String actorId, String cursor,
            int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId, actorId,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        return new WebShellPage<>(webShellSessions(page.sessions(), actorId),
                nextCursor(page), page.hasMore());
    }

    /**
     * A page of a Session's Turns, newest first. Every page checks the
     * Session again, so a cursor never outlives the caller's read access.
     */
    public PublicList<PublicTurn> listPublicTurns(String tenantId,
            String actorId, String sessionId, String cursor,
            int requestedLimit) {
        int limit = limit(requestedLimit);
        TurnCursor decoded = decodeTurnCursor(cursor);
        requireReadableSession(tenantId, actorId, sessionId);
        TurnPage page = store.listTurns(tenantId, sessionId,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.turnId(), limit);
        return new PublicList<>("list", page.turns().stream()
                .map(ManagedAgentService::publicTurn).toList(),
                page.hasMore(), nextTurnCursor(page));
    }

    public PublicTurn getPublicTurn(String tenantId, String actorId,
            String sessionId, String turnId) {
        // The path schema counts characters, not UTF-16 units.
        if (turnId.codePointCount(0, turnId.length()) > TURN_ID_MAX_LENGTH) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "The Turn id is invalid.");
        }
        requireReadableSession(tenantId, actorId, sessionId);
        return store.findTurnSummary(tenantId, sessionId, turnId)
                .map(ManagedAgentService::publicTurn)
                .orElseThrow(() -> new ManagedAgentException(HttpStatus.NOT_FOUND,
                        "turn_not_found", "The Turn was not found."));
    }

    public PublicList<PublicEvent> publicEvents(String tenantId,
            String actorId, String sessionId, long afterSequence,
            int requestedLimit) {
        requireEventCursor(afterSequence);
        SessionRecord session = requireReadableSession(tenantId, actorId,
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
        if (afterSequence < 0) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_event_cursor", "Item sequence must be non-negative.");
        }
        requireReadableSession(tenantId, actorId, sessionId);
        var page = store.findSnapshotPage(tenantId, sessionId, cursor, afterSequence, limit(requestedLimit));
        return new PublicItemList("list", page.items().stream().map(this::publicItem).toList(), page.hasMore(),
                page.nextCursor(), page.coveredSequence());
    }

    public WebShellTranscript transcript(String tenantId, String actorId,
            String sessionId, String cursor, int requestedLimit) {
        SessionRecord session = requireReadableSession(tenantId, actorId,
                sessionId);
        int limit = eventLimit(requestedLimit);
        if (StringUtils.isBlank(cursor)) {
            SnapshotRecord snapshot = store.findSnapshot(tenantId, sessionId)
                    .orElse(null);
            if (snapshot != null) {
                long visibleSequence = Math.max(session.lastSequence(),
                        snapshot.coveredSequence());
                List<EventRecord> events = new ArrayList<>(
                        store.findControlEvents(tenantId, sessionId,
                                snapshot.coveredSequence()));
                events.addAll(tailEvents(tenantId, sessionId,
                        snapshot.coveredSequence(), visibleSequence));
                return new WebShellTranscript(snapshot.items().stream()
                        .map(this::webShellItem).toList(),
                        events.stream().map(this::webShellEvent).toList(),
                        snapshot.coveredSequence(), null, false,
                        visibleSequence);
            }
        }
        EventPage page = store.findTranscriptEvents(tenantId, sessionId,
                transcriptCursor(cursor), limit);
        List<WebShellEvent> events = page.events().stream()
                .map(this::webShellEvent).toList();
        String olderCursor = page.hasMore() && !events.isEmpty()
                ? Long.toString(events.get(0).sequence()) : null;
        return new WebShellTranscript(List.of(), events, 0, olderCursor,
                page.hasMore(), session.lastSequence());
    }

    // Events are read before the floor: a floor that is not above the cursor
    // after the read was not above it during the read either, so no event
    // after the cursor had been pruned. A stream reconciliation discards the
    // Snapshot without lowering the floor, so the floor can exceed the
    // coverage while the Items rebuild; nothing prunes events yet, so such
    // a cursor is still served instead of looping 409/resync until the
    // rebuild finishes. The pruning work must revisit this condition once
    // rows below the floor can be gone.
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
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                    "invalid_event_cursor",
                    "Event sequence must be non-negative.");
        }
    }

    /** A page assembled from grouped batch reads instead of per-row ones. */
    private List<PublicSession> publicSessions(List<SessionRecord> sessions) {
        if (sessions.isEmpty()) {
            return List.of();
        }
        String tenantId = sessions.getFirst().tenantId();
        List<String> ids = sessions.stream().map(SessionRecord::sessionId)
                .toList();
        Map<String, TurnSummary> activeTurns = store.findActiveTurns(tenantId,
                ids);
        Map<String, Long> coveredSequences = store
                .findSnapshotCoveredSequences(tenantId, ids);
        Set<String> closed = completedWorkspaceCloses(tenantId, sessions);
        return sessions.stream()
                .map(session -> publicSession(session,
                        activeTurns.get(session.sessionId()),
                        coveredSequences.getOrDefault(session.sessionId(), 0L),
                        retention(session, closed)))
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
            boolean retention) {
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
                        foregroundShell(session),
                        javaDurableAdmission == null ? null : visible),
                publicWorkspace(session));
    }

    /** A page assembled from grouped batch reads instead of per-row ones. */
    private List<WebShellSession> webShellSessions(
            List<SessionRecord> sessions, String actorId) {
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
        List<String> approvalIds = sessions.stream().filter(WorkspaceToolProfiles::supportsApprovalSelection)
                .map(SessionRecord::sessionId).toList();
        Map<String, WebShellApprovalSelection> approvalSelections = store.findApprovalSelections(tenantId, approvalIds);
        Set<String> approvalOwners = store.findApprovalOwners(tenantId, actorId, approvalIds);
        boolean approvalSupported = !approvalIds.isEmpty() && harness.supportsApprovalSelection();
        boolean definitionApprovalSupported = approvalSupported
                && sessions.stream().anyMatch(session -> session.agentDefinitionDigest() != null)
                && harness.supportsAgentDefinitionApprovalSelection();
        Map<String, WebShellModelSelection> modelSelections = store.findModelSelections(tenantId, boundIds);
        Map<String, WebShellModelContext> modelContexts = store.findModelContexts(tenantId, boundIds);
        boolean modelSelectionSupported = !store.modelOptions().isEmpty() && harness.supportsModelSelection();
        Set<String> closed = completedWorkspaceCloses(tenantId, sessions);
        // Cwd admission has no Turn execution-profile restriction. One role
        // grant read covers the workspaces of both shapes; the executable
        // facts read covers both id sets, retaining each capability's gates.
        Set<String> shaped = sessions.stream().filter(this::maySubmitShape)
                .map(SessionRecord::sessionId)
                .collect(java.util.stream.Collectors.toSet());
        Set<String> cwdShaped = sessions.stream().filter(this::mayChangeCwdShape)
                .map(SessionRecord::sessionId)
                .collect(java.util.stream.Collectors.toSet());
        Set<String> candidateIds = new java.util.HashSet<>(shaped);
        candidateIds.addAll(cwdShaped);
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
                        maySubmitWorkspaceTurn(session, grants, executable),
                        mayChangeCwd(session, grants, executable),
                        modelContexts.get(session.sessionId()),
                        modelSelections.get(session.sessionId()), modelSelectionSupported,
                        approvalSelections.get(session.sessionId()), approvalSupported
                                && (session.agentDefinitionDigest() == null || definitionApprovalSupported)
                                && approvalOwners.contains(session.sessionId())))
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
            boolean retention, boolean maySubmit, boolean mayChangeCwd,
            WebShellModelContext modelContext, WebShellModelSelection modelSelection,
            boolean modelSelectionSupported, WebShellApprovalSelection approvalSelection, boolean approvalSupported) {
        boolean visible = session.deletedAt() == null;
        boolean close = visible && supportsClose(session);
        boolean keep = visible && retention;
        boolean approvalExecutable = approvalSelection == null || approvalSelection.revision() == 0
                || supportsApprovalSelection(session);
        approvalExecutable = approvalExecutable && (approvalSelection == null
                || !approvalSelection.planMode() || harness.supportsPlanMode());
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
                webShellWorkspace(session),
                // Every Session serves its task list and detail; the tasks come from the
                // Stage H records its Session store holds (H0c). The
                // tombstone gate matches publicSession: every route these
                // capabilities gate 404s once deletedAt is set.
                new WebShellSessionCapabilities(visible,
                        hasArtifacts(session),
                        hasActions(session), maySubmit && approvalExecutable, close, keep, keep,
                        visible && supportsDelete(session, retention),
                        mayChangeCwd && approvalExecutable, foregroundShell(session),
                        visible && modelSelectionSupported && mayChangeCwd,
                        visible && approvalSupported && mayChangeCwd && !Boolean.FALSE.equals(foregroundShell(session)),
                        javaDurableAdmission == null ? null : visible,
                        visible && maySubmit && harness.supportsInputAttachments()),
                session.workspace() != null || session.agentDefinitionDigest() != null
                        ? approvalSelection == null ? session.approvalMode() : approvalSelection.mode() : null,
                modelContext, modelSelection, approvalSelection == null ? null : approvalSelection.revision(),
                session.workspace() != null || session.agentDefinitionDigest() != null ? session.approvalMode() : null,
                approvalSelection != null && approvalSelection.planMode(), visible && approvalSupported
                        && mayChangeCwd && harness.supportsPlanMode() && store.supportsPlanMode(session));
    }

    private boolean supportsDelete(SessionRecord session, boolean retention) {
        if (CsiFilesRetirementProfile.PROFILE.equals(session.toolProfile())) {
            return false;
        }
        return retention || session.workspace() != null
                && RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())
                && harness.supportsLifecycle(session.toolProfile());
    }

    private Boolean foregroundShell(SessionRecord session) {
        if (session.workspace() == null || !WorkspaceToolProfiles.isPublicShell(session.toolProfile())) {
            return null;
        }
        return session.deletedAt() == null && store.workspaceFilesEnabled() && store.workspaceShellEnabled()
                && WorkspaceToolProfiles.supportsApprovalMode(session.approvalMode())
                && (!"yolo".equals(session.approvalMode()) || supportsApprovalSelection(session));
    }

    private static WebShellWorkspace webShellWorkspace(SessionRecord session) {
        return session.workspace() == null ? null
                : new WebShellWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative(),
                        session.workspace().getContextRevision(),
                        WORKSPACE_STATE);
    }

    private static PublicWorkspace publicWorkspace(SessionRecord session) {
        return session.workspace() == null ? null
                : new PublicWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative(),
                        session.workspace().getContextRevision(),
                        WORKSPACE_STATE);
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
                turn.status().toLowerCase(Locale.ROOT), turn.createdAt(),
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

    private List<EventRecord> tailEvents(String tenantId, String sessionId,
            long afterSequence, long throughSequence) {
        List<EventRecord> result = new ArrayList<>();
        long cursor = afterSequence;
        while (cursor < throughSequence) {
            // Paged at the snapshot gate's lag bound: a session whose
            // snapshot lags within the gate is served in one round trip.
            List<EventRecord> page = store.findEvents(tenantId, sessionId,
                    cursor, ManagedAgentStore.SNAPSHOT_REFRESH_EVENTS);
            if (page.isEmpty()) {
                break;
            }
            for (EventRecord event : page) {
                if (event.sequence() > throughSequence) {
                    return List.copyOf(result);
                }
                result.add(event);
                cursor = event.sequence();
            }
        }
        return List.copyOf(result);
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
                && (!workspaceBound || harness.isWorkspaceFilesAvailable())) {
            coordinator.dispatch(tenantId, admission.sessionId(),
                    admission.turnId());
        }
    }

    String lifecycleDigest(String sessionId, String operation) {
        return digests.digest(Map.of(
                "sessionId", sessionId, "operation", operation));
    }

    // Later Turns of a Workspace-bound Session run under the creator's
    // Workspace grants (WorkspaceExecutionStore.authorize), so new-work
    // admission certifies two conjuncts: the caller holds OPERATOR
    // (requireSubmitterRole), and the Session's creator-keyed execution
    // facts still hold (requireSubmitterFacts). The command family's
    // replay is NOT actor-scoped (#13619), so the role gate runs before
    // the replay: below-OPERATOR never reaches a recorded key. The facts
    // gate follows the replay: it certifies new work only, so a recorded
    // completed outcome always answers — a Workspace re-registration, a
    // DRAINING row or a creator demotion must not retire it. Cancelling
    // has its own, narrower rule (requireCancellerRole/Shape).
    private void requireSubmitterRole(SessionRecord session,
            String actorId) {
        if (session.workspace() != null
                && !workspaces.accessOf(session.tenantId(), actorId,
                        session.workspace().getWorkspaceId())
                        .atLeast(WorkspaceAccess.OPERATOR)) {
            requireLegacyWorkspace(session, actorId);
        }
    }

    private void requireSubmitterFacts(SessionRecord session,
            String actorId) {
        if (session.workspace() != null
                && !maySubmitWorkspaceTurn(session, actorId)) {
            requireLegacyWorkspace(session, actorId);
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
        if (session.workspace() != null
                && !workspaces.createdSession(session.tenantId(), actorId,
                        session.sessionId())) {
            // Below the recorder/creator pass, so a recorded outcome still
            // answers its own actors on a tombstone; every other actor
            // meets the reads' 404 there, never the live-Session 409 that
            // would name the row.
            if ("DELETED".equals(session.status())) {
                throw new ManagedAgentException(HttpStatus.NOT_FOUND,
                        "session_not_found", "The Session was not found.");
            }
            throw new ManagedAgentException(HttpStatus.CONFLICT,
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
        if (session.workspace() != null
                && !workspaces.accessOf(session.tenantId(), actorId,
                        session.workspace().getWorkspaceId())
                        .atLeast(WorkspaceAccess.OPERATOR)) {
            requireLegacyWorkspace(session, actorId);
        }
    }

    private void requireCancellerShape(SessionRecord session,
            String actorId) {
        if (session.workspace() != null && !maySubmitShape(session)) {
            requireLegacyWorkspace(session, actorId);
        }
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
        if (session.workspace() != null
                && !workspaces.accessOf(session.tenantId(), actorId,
                        session.workspace().getWorkspaceId())
                        .atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(HttpStatus.FORBIDDEN, "task_forbidden",
                    "Only a Workspace operator may cancel the task.");
        }
    }

    private boolean maySubmitWorkspaceTurn(SessionRecord session,
            String actorId) {
        if (!maySubmitShape(session) || actorId == null
                || actorId.isEmpty()) {
            return false;
        }
        // findReadable throws on an actor id the registry key cannot
        // encode; that caller is simply not a submitter.
        ManagedWorkspaceRegistry.WorkspaceSummary summary;
        try {
            summary = workspaces.findReadable(session.tenantId(), actorId,
                    session.workspace().getWorkspaceId());
        } catch (IllegalArgumentException error) {
            return false;
        }
        // The caller's role and registry state, and on top of them the
        // creator-keyed facts the execution authority re-verifies: the
        // Registry still backs the binding exactly and stays ACTIVE, and
        // the create-command actor keeps OPERATOR or above — after a
        // demotion or re-registration admission refuses first instead of
        // accepting a Turn that can only fail.
        return summary != null && summary.canCreateSession()
                && store.hasExecutionRegistryFacts(session.tenantId(),
                        session.sessionId());
    }

    // The page twin of the singular: the same rule answered from the two
    // batch reads the assembler already made — the caller's role from the
    // grant batch, the creator-keyed facts of each submit-shaped Session
    // from the facts batch.
    private boolean maySubmitWorkspaceTurn(SessionRecord session,
            Map<String, ManagedWorkspaceRegistry.ReadableGrant> grants,
            java.util.Set<String> executable) {
        if (!maySubmitShape(session)) {
            return false;
        }
        var grant = grants.get(session.workspace().getWorkspaceId());
        return grant != null && grant.canCreateSession()
                && executable.contains(session.sessionId());
    }

    // The cwd twin of the submit predicate above, mirroring admitCwdChange:
    // the caller's OPERATOR-or-above role (canCreateSession) and the same
    // creator-keyed executable facts admission re-checks — a capability
    // must not certify what admission would refuse.
    private boolean mayChangeCwd(SessionRecord session,
            Map<String, ManagedWorkspaceRegistry.ReadableGrant> grants,
            java.util.Set<String> executable) {
        if (!mayChangeCwdShape(session)) {
            return false;
        }
        var grant = grants.get(session.workspace().getWorkspaceId());
        return grant != null && grant.canCreateSession()
                && executable.contains(session.sessionId());
    }

    private boolean maySubmitShape(SessionRecord session) {
        if (session.workspace() == null
                || !harness.isWorkspaceFilesAvailable()) {
            return false;
        }
        // The authority execution cites (WorkspaceExecutionStore
        // .authorizePassiveAttachment) fixes these at creation: a Session
        // that fails them can never execute, so admission must not certify
        // it. Empty bound creation skips that validation by design.
        return "ACTIVE".equals(session.status()) && session.deletedAt() == null
                && ("qwen-code".equals(session.agentId())
                        || session.agentDefinitionDigest() != null)
                && WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        session.workspace().getContextConfigRef());
    }

    private boolean mayChangeCwdShape(SessionRecord session) {
        return session.workspace() != null && "ACTIVE".equals(session.status())
                && session.deletedAt() == null && store.workspaceFilesEnabled()
                && (runtimeWarmer == null || runtimeWarmer.supportsWorkspaceCwdChange(session.workspace()));
    }

    void requireLegacyWorkspace(String tenantId, String actorId,
            String sessionId) {
        requireLegacyWorkspace(store.requireSession(tenantId, sessionId),
                actorId);
    }

    // The submitter family's bound-refusal split: an actor without a read
    // grant gets the invisible 404, a readable actor below OPERATOR the
    // 403 of the sibling lifecycle refusal, and an OPERATOR blocked by the
    // shape gates or the creator-keyed facts the family's domain 409.
    private void requireLegacyWorkspace(SessionRecord session,
            String actorId) {
        if (session.workspace() != null) {
            // A tombstone is invisible to every actor shape, as the reads
            // answer: the fence stands above the role split, whose 403/409
            // codes are live-Session answers. An unbound tombstone needs no
            // fence here — its 404 stands below the replay in
            // beginSessionMutation, and a recorded lifecycle outcome must
            // keep answering above it.
            if ("DELETED".equals(session.status())) {
                throw new ManagedAgentException(HttpStatus.NOT_FOUND,
                        "session_not_found", "The Session was not found.");
            }
            String workspaceId = session.workspace().getWorkspaceId();
            WorkspaceAccess access = workspaces.accessOf(session.tenantId(),
                    actorId, workspaceId);
            if (!access.canRead()) {
                throw new ManagedAgentException(HttpStatus.NOT_FOUND,
                        "session_not_found", "The Session was not found.");
            }
            if (access.atLeast(WorkspaceAccess.OPERATOR)) {
                throw new ManagedAgentException(HttpStatus.CONFLICT,
                        "workspace_unavailable",
                        "Hosted Workspace execution is not available.");
            }
            throw new ManagedAgentException(HttpStatus.FORBIDDEN,
                    "session_operation_forbidden",
                    "Only a Workspace operator may use the Session.");
        }
    }

    public SessionRecord requireReadableSession(String tenantId,
            String actorId, String sessionId) {
        SessionRecord session = requireVisibleSession(tenantId, sessionId);
        requireReadGrant(session, actorId);
        return session;
    }

    void requireReadGrant(SessionRecord session, String actorId) {
        if (session.workspace() != null && !workspaces.canRead(session.tenantId(),
                actorId, session.workspace().getWorkspaceId())) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND,
                    "session_not_found", "The Session was not found.");
        }
    }

    /**
     * Reads the next catch-up page of a stream.
     *
     * @throws ReplayCursorExpired when the cursor is below the replay floor
     *         while the Snapshot backs it
     */
    List<EventRecord> streamEvents(SessionRecord session, long afterSequence) {
        requireEventCursor(afterSequence);
        return replayableEvents(session, afterSequence, STREAM_PAGE);
    }

    private SessionRecord requireVisibleSession(String tenantId,
            String sessionId) {
        return requireVisibleSession(store.requireSession(tenantId,
                sessionId));
    }

    private SessionRecord requireVisibleSession(SessionRecord session) {
        if ("DELETED".equals(session.status())) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND,
                    "session_not_found", "The Session was not found.");
        }
        return session;
    }

    private static ManagedAgentException dependencyUnavailable(String code,
            String message) {
        return new ManagedAgentException(HttpStatus.SERVICE_UNAVAILABLE, code,
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
        StoreModels.CommandRecord command = store.findCommand(tenantId,
                operation, idempotencyKey).orElse(null);
        if (command == null) {
            return null;
        }
        if (!recordedByCaller(command, actorId)) {
            requireReplayCreator(session, actorId);
        }
        return store.replayCommand(tenantId, operation, idempotencyKey,
                requestDigest);
    }

    // The answer-side half of that gate. The pre-read can miss a key a
    // racer recorded inside its still-open transaction; the in-store probe
    // and the DuplicateKeyException arm then answer the recorded admission
    // with no gate at all, so a replayed answer re-runs the check on the
    // command row. The read stays a plain probe — never a locking one, so
    // ManagedAgentStore's replay-probe rule still holds.
    private void requireReplayedAdmission(String tenantId, String operation,
            String idempotencyKey, Admission admission, SessionRecord session,
            String actorId) {
        if (!admission.replayed()) {
            return;
        }
        requireReplayActor(tenantId, operation, idempotencyKey, session,
                actorId);
    }

    // The probe half, standing alone for the mutation routes whose replay
    // arms carry no Admission: rename's in-store COMPLETED read-back has
    // only the command row to interrogate. The read stays a plain probe —
    // never a locking one, so ManagedAgentStore's replay-probe rule still
    // holds.
    private void requireReplayActor(String tenantId, String operation,
            String idempotencyKey, SessionRecord session, String actorId) {
        store.findCommand(tenantId, operation, idempotencyKey)
                .filter(command -> !recordedByCaller(command, actorId))
                .ifPresent(command -> requireReplayCreator(session,
                        actorId));
    }

    // The recorder half of the replay admission: a command receipt names
    // the actor whose own retry the recorded outcome answers. An
    // unattributed one — server-keyed — leaves the creator gate alone, and
    // one recorded before the stamp keeps its role-gated replay; see
    // CommandRecord.admitsReplayBy.
    private boolean recordedByCaller(StoreModels.CommandRecord command,
            String actorId) {
        return command.admitsReplayBy(actorId);
    }

    private void requireHarness() {
        if (!harness.isAvailable()) {
            throw new ManagedAgentException(HttpStatus.SERVICE_UNAVAILABLE,
                    "hosted_harness_disabled",
                    "Hosted Harness is not configured.");
        }
    }

    private List<Map<String, Object>> input(List<InputBlock> blocks,
            boolean required) {
        if (blocks == null || blocks.isEmpty()) {
            if (required) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                        "input_required", "At least one input is required.");
            }
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        long totalChars = 0;
        for (InputBlock block : blocks) {
            if (block != null && !INPUT_TYPES.contains(block.type())) {
                result.add(ManagedInputAttachments.normalize(block));
                continue;
            }
            if (block == null || block.text() == null || block.text().isEmpty()
                    || block.mimeType() != null || block.name() != null || block.data() != null) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                        "unsupported_input",
                        "Expected non-empty text, a text file or an image.");
            }
            // Code points, matching the published schema's maxLength; a
            // String.length() count would disagree on astral-plane text.
            int blockChars = block.text().codePointCount(0,
                    block.text().length());
            if (blockChars > MAX_BLOCK_INPUT_CHARS) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                        "invalid_input",
                        "Input block exceeds the " + MAX_BLOCK_INPUT_CHARS
                                + " character per-block limit.");
            }
            totalChars += blockChars;
            if (totalChars > MAX_AGGREGATE_INPUT_CHARS) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                        "invalid_input",
                        "Input exceeds the " + MAX_AGGREGATE_INPUT_CHARS
                                + " character aggregate limit.");
            }
            result.add(Map.of("type", "text", "text",
                    replaceLoneSurrogates(block.text())));
        }
        var normalized = normalizeInput(result);
        if (normalized.stream().anyMatch(block -> !"text".equals(block.get("type")))
                && digests.byteLength(normalized) > ManagedInputAttachments.MAX_INPUT_BYTES) {
            throw new ManagedAgentException(HttpStatus.PAYLOAD_TOO_LARGE, "input_too_large",
                    "An input containing attachments must fit within 8 MiB of encoded JSON.");
        }
        return normalized;
    }

    /** The input the digest and the column both describe: an unpaired
     * surrogate, which no store column keeps, trades for U+FFFD at
     * admission — before the payload digest, the replay digest and the
     * insert — so all three name one representation. Well-formed
     * surrogate pairs and every non-string value pass through. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> normalizeInput(
            List<Map<String, Object>> input) {
        List<Map<String, Object>> result = new ArrayList<>(input.size());
        for (Map<String, Object> block : input) {
            result.add((Map<String, Object>) normalizeValue(block));
        }
        return List.copyOf(result);
    }

    private static Object normalizeValue(Object value) {
        if (value instanceof String text) {
            return replaceLoneSurrogates(text);
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>(map.size());
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                copy.put(replaceLoneSurrogates((String) entry.getKey()),
                        normalizeValue(entry.getValue()));
            }
            return copy;
        }
        if (value instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            for (Object item : list) {
                copy.add(normalizeValue(item));
            }
            return Collections.unmodifiableList(copy);
        }
        return value;
    }

    static String replaceLoneSurrogates(String text) {
        StringBuilder out = null;
        int written = 0;
        for (int i = 0; i < text.length(); i++) {
            char current = text.charAt(i);
            if (Character.isHighSurrogate(current)) {
                if (i + 1 < text.length()
                        && Character.isLowSurrogate(text.charAt(i + 1))) {
                    i++; // a well-formed pair passes through unchanged
                    continue;
                }
            } else if (!Character.isLowSurrogate(current)) {
                continue;
            }
            if (out == null) {
                out = new StringBuilder(text.length());
            }
            out.append(text, written, i).append('�');
            written = i + 1;
        }
        if (out == null) {
            return text;
        }
        out.append(text, written, text.length());
        return out.toString();
    }

    private static String metadataTitle(String explicitTitle,
            Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return validTitle(explicitTitle);
        }
        if (metadata.size() > 16) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                    "invalid_metadata", "Metadata accepts at most 16 keys.");
        }
        for (Map.Entry<String, Object> entry : metadata.entrySet()) {
            if (!(entry.getValue() instanceof String)
                    || entry.getKey().length() > 64
                    || (!"title".equals(entry.getKey())
                            && ((String) entry.getValue()).length() > 512)) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                        "invalid_metadata", "Metadata limits were exceeded.");
            }
            if (!"title".equals(entry.getKey())) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
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
        return title.codePoints().allMatch(character -> Character.isWhitespace(character)
                || Character.isSpaceChar(character) || character == 0xfeff);
    }

    private static String validTitle(String title) {
        if (title == null) {
            return null;
        }
        if (title.length() > 256) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_title",
                    "Title must not exceed 256 characters.");
        }
        if (title.chars().anyMatch(character -> character <= 31
                || character == 127)) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_title",
                    "Title must not contain control characters.");
        }
        return unicodeBlank(title) ? null : title;
    }

    private static String validRenameTitle(String title) {
        if (title == null || unicodeBlank(title)) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_title",
                    "Title must contain 1-256 characters.");
        }
        return validTitle(title);
    }

    public static void validateIdempotencyKey(String key) {
        if (key == null || !IDEMPOTENCY_KEY.matcher(key).matches()) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                    "invalid_idempotency_key",
                    "Idempotency-Key must contain 1-128 visible characters.");
        }
    }

    private static int limit(int requested) {
        if (requested <= 0 || requested > 100) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
        return requested;
    }

    private static int eventLimit(int requested) {
        if (requested <= 0 || requested > 1000) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 1000.");
        }
        return requested;
    }

    private static String nextCursor(SessionPage page) {
        if (!page.hasMore() || page.sessions().isEmpty()) {
            return null;
        }
        SessionRecord last = page.sessions().get(page.sessions().size() - 1);
        String raw = last.createdAt() + ":" + last.sessionId();
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                raw.getBytes(StandardCharsets.UTF_8));
    }

    private static SessionCursor decodeCursor(String cursor) {
        if (StringUtils.isBlank(cursor)) {
            return null;
        }
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
            int separator = decoded.indexOf(':');
            if (separator <= 0 || separator == decoded.length() - 1) {
                throw new IllegalArgumentException();
            }
            return new SessionCursor(Long.parseLong(
                    decoded.substring(0, separator)),
                    decoded.substring(separator + 1));
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
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
        throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_cursor",
                "Turn cursor is invalid.");
    }

    private static Long transcriptCursor(String cursor) {
        if (StringUtils.isBlank(cursor)) {
            return null;
        }
        try {
            long value = Long.parseLong(cursor);
            if (value <= 0) {
                throw new NumberFormatException();
            }
            return value;
        } catch (NumberFormatException error) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                    "invalid_cursor", "Transcript cursor is invalid.");
        }
    }

    private static CommandAdmission response(Admission admission) {
        return new CommandAdmission(admission.sessionId(),
                admission.turnId(), "accepted", admission.replayed());
    }

    /**
     * D7-3: whether an admission asked for the java_durable profile. Asking
     * for it on a deployment without the profile is refused before anything
     * is read or written, rather than answered with harness_confirmed
     * semantics the caller did not ask for.
     */
    private boolean requireAdmissionProfile(String admissionProfile) {
        if (!JavaDurableAdmission.JAVA_DURABLE.equals(admissionProfile)) {
            return false;
        }
        if (javaDurableAdmission == null) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature",
                    "java_durable admission is not enabled on this deployment.");
        }
        return true;
    }

    /**
     * The java_durable view names the command's operation with its latest
     * stage and state; a command recorded before D7-1 saved operations
     * keeps the legacy body.
     */
    private CommandAdmission response(String tenantId, Admission admission,
            boolean durable) {
        JavaDurableAdmission.Operation operation = durable
                ? javaDurableAdmission.operation(tenantId, admission) : null;
        if (operation == null) {
            return response(admission);
        }
        return new CommandAdmission(admission.sessionId(), admission.turnId(),
                "accepted", admission.replayed(), operation.operationId(),
                operation.admissionStage(), operation.deliveryState());
    }

    private record SessionCursor(long createdAt, String sessionId) {
    }

    private record TurnCursor(long createdAt, String turnId) {
    }

    public record SessionMutationResult<T>(T body, boolean replayed) {
    }
}
