package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.persistence.AgentDefinitionCompiler;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

final class AgentSessionPolicies {
    // The public Shell members must track WorkspaceToolProfiles.isPublicShell:
    // creation admits extension pins for every public Shell, so apply must not
    // refuse a revision (shell/3) that creation accepted.
    private static final Set<String> EXTENSION_APPLY_PROFILES = Set.of(WorkspaceToolProfiles.SHELL,
            WorkspaceToolProfiles.SHELL_V3, WorkspaceToolProfiles.SHELL_V4, WorkspaceToolProfiles.MCP,
            WorkspaceToolProfiles.FILES, WorkspaceToolProfiles.READ);

    private final AgentEventJournal eventJournal;
    private final AgentSessionQueries sessionQueries;
    private final AgentStoreRows storeRows;
    private final com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles;
    private final HarnessRules harnessRules;
    private final JdbcManagedExtensionRecordStore configRecords;
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final String approvalMode;
    private final JdbcManagedWorkspaceRegistry workspaces;
    private final String agentRevision;
    private final List<String> definitionToolProfiles;
    private final List<String> definitionModels;
    private final List<WebShellModelOption> modelCatalog;
    private final JdbcManagedAgentDefinitionStore definitions;
    private final JdbcManagedSessionSkills creationSkills;
    private final boolean workspaceFilesEnabled;
    private final boolean workspaceShellEnabled;
    private final ResidentWorkspaces residentWorkspaces;

    AgentSessionPolicies(AgentEventJournal eventJournal,
            AgentSessionQueries sessionQueries,
            AgentStoreRows storeRows,
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles,
            HarnessRules harnessRules,
            JdbcManagedExtensionRecordStore configRecords,
            JdbcTemplate jdbc,
            ObjectMapper objectMapper,
            Clock clock,
            String approvalMode,
            JdbcManagedWorkspaceRegistry workspaces,
            String agentRevision,
            List<String> definitionToolProfiles,
            List<String> definitionModels,
            List<WebShellModelOption> modelCatalog,
            JdbcManagedAgentDefinitionStore definitions,
            JdbcManagedSessionSkills creationSkills,
            boolean workspaceFilesEnabled,
            boolean workspaceShellEnabled,
            ResidentWorkspaces residentWorkspaces) {
        this.eventJournal = eventJournal;
        this.sessionQueries = sessionQueries;
        this.storeRows = storeRows;
        this.worktreeFiles = worktreeFiles;
        this.harnessRules = harnessRules;
        this.configRecords = configRecords;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.approvalMode = approvalMode;
        this.workspaces = workspaces;
        this.agentRevision = agentRevision;
        this.definitionToolProfiles = definitionToolProfiles;
        this.definitionModels = definitionModels;
        this.modelCatalog = modelCatalog;
        this.definitions = definitions;
        this.creationSkills = creationSkills;
        this.workspaceFilesEnabled = workspaceFilesEnabled;
        this.workspaceShellEnabled = workspaceShellEnabled;
        this.residentWorkspaces = residentWorkspaces;
    }

    static final Pattern DEFINITION_REVISION = Pattern.compile(
            "^[1-9][0-9]{0,17}$");

    static ManagedAgentException workspaceExecutionUnavailable() {
        return new ManagedAgentException(409,
                "workspace_unavailable",
                "Hosted Workspace execution is not available.");
    }

    /**
     * The execution identity a new Session pins (D8b): for the built-in {@code qwen-code} agent the
     * deployment revision with no definition digest; for a stored definition the resolved revision,
     * its digest and the approval mode and tool profile compiled from its content (D8c-1).
     */
    record AgentPin(String revision, String digest,
            String approvalMode, String toolProfile, boolean hooks, boolean mcp) {
    }

    boolean isSshWorkspace(ContextBinding binding) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE alias_key = ? AND storage_kind = 'SSH_LOCAL'",
                Long.class, RuntimeAdmissionFences.storageAliasKey(binding.getTenantId(), binding.getStorageId())) == 1;
    }

    static void requireSshToolProfile(String profile) {
        // The loop revision shell/3 is a public shell too: its journal-based
        // loop_wakeup/cron union is runtime-agnostic, so the SSH lane admits it
        // exactly like shell/1 (D3).
        if (!WorkspaceToolProfiles.FILES.equals(profile) && !WorkspaceToolProfiles.isPublicShell(profile)) {
            throw workspaceExecutionUnavailable();
        }
    }

    WebShellSessionOptions workspaceSessionOptions(
            String tenantId, String agentId) {
        AgentPin pin = resolveAgentPin(tenantId, agentId, null, true);
        return new WebShellSessionOptions(
                pin.approvalMode(), availableApprovalModes(pin),
                !pin.hooks() && !pin.mcp() && (WorkspaceToolProfiles.FILES.equals(pin.toolProfile())
                        || WorkspaceToolProfiles.isPublicShell(pin.toolProfile())), false);
    }

    static List<String> availableApprovalModes(AgentPin pin) {
        return pin.digest() != null ? List.of(pin.approvalMode())
                : WorkspaceToolProfiles.isPublicShell(pin.toolProfile())
                        ? List.of("default", "auto-edit")
                        : List.of("default", "auto-edit", "yolo");
    }

    boolean supportsPlanMode(SessionRecord session) {
        return (WorkspaceToolProfiles.FILES.equals(session.toolProfile())
                || WorkspaceToolProfiles.isPublicShell(session.toolProfile()))
                && WorkspaceToolProfiles.supportsApprovalSelection(session)
                && sessionQueries.findChildLineage(session.tenantId(), session.sessionId()) == null
                && !hasMcpServers(session)
                && (session.agentDefinitionDigest() == null
                || !definitions.pinnedContent(session).containsKey("hook_catalog"));
    }

    // Called only for a new admission; a retry has already replayed and
    // never resolves a definition again.
    AgentPin resolveAgentPin(String tenantId, String agentId,
            String requested, boolean workspaceBound) {
        if ("qwen-code".equals(agentId)) {
            if (requested != null && !requested.equals(agentRevision)) {
                throw new ManagedAgentException(400,
                        "unsupported_feature",
                        "Only the current agent revision can be selected.");
            }
            String toolProfile = workspaceBound
                    ? (workspaceShellEnabled ? WorkspaceToolProfiles.SHELL
                            : WorkspaceToolProfiles.FILES)
                    : null;
            return new AgentPin(agentRevision, null, approvalMode, toolProfile, false, false);
        }
        if (definitions == null) {
            throw ManagedAgentDefinitionStore.notFound();
        }
        JdbcManagedAgentDefinitionStore.DefinitionRevision revision =
                resolveDefinitionRevision(tenantId, agentId, requested);
        AgentDefinitionCompiler.Compiled compiled =
                AgentDefinitionCompiler.compile(revision.definitionJson(),
                        workspaceBound, approvalMode, definitionToolProfiles,
                        definitionModels);
        Map<String, Object> content = storeRows.readMap(revision.definitionJson());
        return new AgentPin(Long.toString(revision.revision()),
                revision.digest(), compiled.approvalMode(),
                compiled.toolProfile(), content.containsKey("hook_catalog"),
                !AgentDefinitionExtensions.mcpServers(content.get("mcp_servers"), compiled.toolProfile()).isEmpty());
    }

    boolean hasMcpServers(SessionRecord session) {
        if (WorkspaceToolProfiles.READ.equals(session.toolProfile())) {
            return false;
        }
        boolean pinned = session.agentDefinitionDigest() != null && !AgentDefinitionExtensions.mcpServers(
                definitions.pinnedContent(session).get("mcp_servers"), session.toolProfile()).isEmpty();
        return ManagedMcpSettings.find(jdbc, session.tenantId(), session.sessionId()) != null || pinned;
    }

    SessionRecord requireMcpManagement(String tenantId, String actorId, String sessionId, String operationId) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        ManagedWorkspaceRegistry.requireSessionVisibility(
                session, actorId, workspaces);
        if (session.workspace() == null || "DELETED".equals(session.status())) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found.");
        }
        WorkspaceAccess access = workspaces.accessOf(tenantId, actorId, session.workspace().getWorkspaceId());
        if (!access.canRead()) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found.");
        }
        if (!access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(403, "session_operation_forbidden",
                    "Only a Workspace operator may manage MCP servers.");
        }
        if (!WorkspaceToolProfiles.isPublicShell(session.toolProfile()) && !WorkspaceToolProfiles.MCP.equals(session.toolProfile())
                || !workspaceFilesEnabled || !workspaceShellEnabled && WorkspaceToolProfiles.isPublicShell(session.toolProfile())
                || isSshWorkspace(session.workspace()) || residentWorkspaces.find(session.workspace()) != null
                || sessionQueries.findChildLineage(tenantId, sessionId) != null) {
            throw new ManagedAgentException(409, "unsupported_feature", "MCP management is unavailable.");
        }
        requireSessionStatus(session.status(), "ACTIVE");
        requireCwdChangeRegistryFacts(session);
        WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, tenantId, session.workspace().getStorageId());
        boolean replay = operationId != null && !jdbc.queryForList("SELECT 1 FROM ma_session_journal_tx"
                + " WHERE tenant_id=? AND session_id=? AND command_id=? AND operation='manageMcp' LIMIT 1",
                tenantId, sessionId, operationId).isEmpty();
        if (operationId != null && !replay) {
            ManagedConfigStore.requireOpen(jdbc, tenantId, sessionId);
            requireMcpManagementIdle(session);
        }
        return session;
    }

    void requireMcpSettingsCommit(String tenantId, String workspaceId, String sessionId) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() == null || !workspaceId.equals(session.workspace().getWorkspaceId())
                || !WorkspaceToolProfiles.isPublicShell(session.toolProfile()) && !WorkspaceToolProfiles.MCP.equals(session.toolProfile())
                || sessionQueries.findChildLineage(tenantId, sessionId) != null) {
            throw new ManagedAgentException(409, "unsupported_feature", "MCP management is unavailable.");
        }
        requireSessionStatus(session.status(), "ACTIVE");
        requireMcpManagementIdle(session);
    }

    SessionRecord requireExtensionManagement(String tenantId, String actorId, String sessionId, String operationId, boolean mutation) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        ManagedWorkspaceRegistry.requireSessionVisibility(
                session, actorId, workspaces);
        if (session.workspace() == null || "DELETED".equals(session.status())) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found.");
        }
        WorkspaceAccess access = workspaces.accessOf(tenantId, actorId, session.workspace().getWorkspaceId());
        if (!access.canRead()) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found.");
        }
        if (!access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(403,
                "session_operation_forbidden", "Only a Workspace operator may apply extensions.");
        }
        var lineage = sessionQueries.findChildLineage(tenantId, sessionId);
        JsonNode current = ManagedMcpSettings.find(jdbc, tenantId, sessionId);
        boolean same = ManagedConfigInstall.isPackageConfig(current) && operationId != null
                && operationId.equals(current.path("operationId").asText());
        if (mutation && (lineage != null && (!same || !childExtensionBootstrapCommand(session, lineage).equals(current.path("command")))
                || !workspaceFilesEnabled
                || !EXTENSION_APPLY_PROFILES.contains(session.toolProfile()))) {
            throw new ManagedAgentException(409, "unsupported_feature", "Extension management is unavailable.");
        }
        if (mutation) {
            requireSessionStatus(session.status(), "ACTIVE");
            requireCwdChangeRegistryFacts(session);
            WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, tenantId, session.workspace().getStorageId());
            if (!same) {
                ManagedConfigStore.requireOpen(jdbc, tenantId, sessionId);
                requireMcpManagementIdle(session);
            }
        }
        return session;
    }

    boolean canApplyExtensions(SessionRecord session) {
        return workspaceFilesEnabled && "ACTIVE".equals(session.status())
                && EXTENSION_APPLY_PROFILES.contains(session.toolProfile())
                && sessionQueries.findChildLineage(session.tenantId(), session.sessionId()) == null
                && !hasActiveTurn(session.tenantId(), session.sessionId());
    }

    void requireConfigurationCommit(String tenantId, String workspaceId, String sessionId, JsonNode body) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (session.workspace() == null || !workspaceId.equals(session.workspace().getWorkspaceId())) {
            throw new ManagedAgentException(409, "unsupported_feature", "Extension management is unavailable.");
        }
        requireSessionStatus(session.status(), "ACTIVE");
        var lineage = sessionQueries.findChildLineage(tenantId, sessionId);
        if (lineage != null) {
            requireChildExtensionBootstrap(session, lineage, body);
            return;
        }
        Map<String, Object> initial = creationSkills.initialSelection(tenantId, sessionId);
        if (initial != null) {
            if (initial.get("operationId").equals(body.path("command").path("operationId").asText())) {
                boolean beforeModel = jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id=? AND session_id=?", Integer.class,
                        tenantId, sessionId) <= 1
                        && jdbc.queryForList("SELECT turn_id FROM ma_turn WHERE tenant_id=? AND session_id=? AND is_submission_attempted=TRUE LIMIT 1 FOR UPDATE",
                                tenantId, sessionId).isEmpty();
                if (!beforeModel || !isBootstrapRevision(body)
                        || !objectMapper.valueToTree(initial).equals(body.path("command"))) {
                    throw new ManagedAgentException(409, "extension_initialization_conflict", "Initial extension selection conflicts with its creation receipt.");
                }
                return;
            }
            JsonNode configuration = ManagedMcpSettings.find(jdbc, tenantId, sessionId);
            if (configuration == null || !Set.of("active", "failed").contains(configuration.path("phase").asText())) {
                throw new ManagedAgentException(409, "extension_initialization_required", "Initial extension configuration must settle first.");
            }
        }
        // Every phase observes the same locked Session row as Turn admission.
        // A precommit stage may lose its idle window; it cannot commit over a new Turn.
        requireMcpManagementIdle(session);
    }

    void requireChildExtensionBootstrap(SessionRecord child, StoreModels.SessionLineage lineage, JsonNode body) {
        JsonNode command = childExtensionBootstrapCommand(child, lineage);
        boolean onlyInitialTurn = jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id=? AND session_id=?", Integer.class,
                child.tenantId(), child.sessionId()) <= 1
                && jdbc.queryForList("SELECT turn_id FROM ma_turn WHERE tenant_id=? AND session_id=? AND is_submission_attempted=TRUE LIMIT 1 FOR UPDATE",
                        child.tenantId(), child.sessionId()).isEmpty();
        if (!onlyInitialTurn || !isBootstrapRevision(body) || !command.equals(body.path("command"))) {
            throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "Child extension bootstrap conflicts with its launch snapshot");
        }
    }

    static boolean isBootstrapRevision(JsonNode body) {
        return "apply".equals(body.path("mode").asText()) && body.path("previousConfigRevision").asLong(-1) == 0
                && body.path("configRevision").asLong(-1) == 1
                || "recoverPrevious".equals(body.path("mode").asText()) && body.path("previousConfigRevision").asLong(-1) == 1
                && body.path("configRevision").asLong(-1) == 2;
    }

    JsonNode childExtensionBootstrapCommand(SessionRecord child, StoreModels.SessionLineage lineage) {
        if (configRecords == null) {
            throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "Package agent validation is unavailable");
        }
        var run = configRecords.findRecord(child.tenantId(), lineage.parentSessionId(), "child_run", lineage.parentChildRunId()).orElseThrow();
        var envelope = configRecords.readRecordResource(child.tenantId(), lineage.parentSessionId(), run.required("inputRef"));
        var launch = envelope.path("publicLaunch");
        if (launch.path("version").asInt() != 2) {
            throw new ManagedAgentException(409, "unsupported_feature", "Child extension updates are unavailable");
        }
        var ref = launch.required("extensionAgent").required("bundleRef");
        var bundle = configRecords.readRecordResource(child.tenantId(), lineage.parentSessionId(), ref);
        var pins = objectMapper.createArrayNode();
        for (var entry : bundle.required("packages")) {
            pins.add(entry.required("pin"));
        }
        String operation = ManagedConfigInstall.derivedOperationId("managed-extension-child:", child.sessionId() + ":" + ref.required("digest").asText());
        return objectMapper.createObjectNode().put("operationId", operation)
                .put("actorKey", DigestUtils.sha256Hex("managed-extension-child:" + child.sessionId()))
                .put("expectedRevision", 0).set("extensions", pins);
    }

    void requireMcpManagementIdle(SessionRecord session) {
        String tenantId = session.tenantId();
        String sessionId = session.sessionId();
        // The journal may already have a consistent-read snapshot; these reads must observe the
        // Plan/Turn admission that won the same Session row before this settings commit.
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT is_plan_enabled FROM ma_session WHERE tenant_id=? AND session_id=? FOR UPDATE",
                Boolean.class, tenantId, sessionId))) {
            throw new ManagedAgentException(409, "unsupported_feature", "Disable Plan mode before managing MCP servers.");
        }
        if (!jdbc.queryForList("SELECT turn_id FROM ma_turn WHERE tenant_id=? AND session_id=?"
                + " AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING') LIMIT 1 FOR UPDATE", tenantId, sessionId).isEmpty()) {
            throw new ManagedAgentException(409, "turn_active", "The Session has an active Turn or approval.");
        }
        if (!jdbc.queryForList("SELECT record_id FROM ma_session_record WHERE record_kind='DOMAIN'"
                + " AND session_scope_key=? AND tenant_id=? AND session_id=? AND domain='child_run'"
                + " AND settled_at IS NULL LIMIT 1 FOR UPDATE", ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId).isEmpty()) {
            throw new ManagedAgentException(409, "session_context_busy", "The Session has an unsettled child run.");
        }
        long now = storeRows.lifecycleDatabaseTime();
        for (String options : jdbc.queryForList("SELECT options_json FROM ma_session_record WHERE session_scope_key=?"
                + " AND record_kind='ACTION' AND state='requested' AND tenant_id=? AND session_id=? FOR UPDATE",
                String.class, ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId)) {
            Object expiresAt = storeRows.readMap(options).get("expiresAt");
            if (expiresAt instanceof Number expiration && now < expiration.longValue()) {
                throw new ManagedAgentException(409, "turn_active", "The Session has an active Turn or approval.");
            }
        }
        if (!jdbc.queryForList("SELECT operation_id FROM ma_operation WHERE scope_key=? AND target_key=?"
                + " AND operation_kind IN " + AgentStoreRows.SESSION_OPERATION_KINDS
                + " AND (state IN ('PENDING', 'RUNNING', 'UNKNOWN') OR state='RECOVERY_BLOCKED' AND operation_kind <> 'TASK_CANCEL')"
                + " LIMIT 1 FOR UPDATE", ManagedSessionStore.sessionScopeKey(tenantId, sessionId), AgentStoreRows.sessionOperationTarget(sessionId)).isEmpty()
                || !jdbc.queryForList("SELECT receipt_key FROM ma_request_receipt WHERE namespace='SESSION_COMMAND'"
                        + " AND tenant_key=? AND tenant_id=? AND session_id=? AND state='PENDING' LIMIT 1 FOR UPDATE",
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(tenantId), tenantId, sessionId).isEmpty()) {
            throw new ManagedAgentException(409, "session_context_busy", "The Session has an active operation.");
        }
    }

    JdbcManagedAgentDefinitionStore.DefinitionRevision resolveDefinitionRevision(
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

    boolean workspaceFilesEnabled() {
        return workspaceFilesEnabled;
    }

    boolean workspaceShellEnabled() {
        return workspaceShellEnabled;
    }

    void requireCwdChangeRegistryFacts(SessionRecord session) {
        JdbcSessionWorktreeStore.requireReady(worktreeFiles, jdbc, session.tenantId(), session.sessionId());
        if (!sessionQueries.hasExecutionRegistryFacts(session.tenantId(),
                session.sessionId())) {
            throw workspaceExecutionUnavailable();
        }
    }

    boolean hasOpenOperation(String tenantId, String sessionId) {
        return hasOpenOperation(tenantId, sessionId, null);
    }

    // Hook owners can outlive their Turn with an immutable worker context.
    // Only confirmed release permits changing that context's cwd/revision.
    boolean hasRetainedRuntimeSession(String tenantId, String sessionId) {
        return !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session"
                + " WHERE tenant_id = ? AND harness_session_id = ?"
                + " AND session_state <> 'RELEASED' LIMIT 1", tenantId, sessionId).isEmpty();
    }

    // The bound later-Turn barrier: context-changing operations only —
    // pending command rows, permission-action operations and task cancels
    // (which stop one task and change no Session context) are excluded,
    // matching the recovery scan's own population.
    boolean hasOpenExecutionOperation(String tenantId,
            String sessionId) {
        if (ManagedConfigStore.blocked(jdbc, tenantId, sessionId)) {
            return true;
        }
        Integer operations = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_operation WHERE scope_key = ? AND"
                        + " target_key = ? AND operation_kind IN"
                        + " ('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE', 'CONTEXT_COMPRESSION') AND state IN"
                        + " ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED', 'UNKNOWN')",
                Integer.class, ManagedSessionStore.sessionScopeKey(tenantId, sessionId), AgentStoreRows.sessionOperationTarget(sessionId));
        return operations != null && operations > 0;
    }

    boolean hasOpenOperation(String tenantId, String sessionId,
            String excludingOperationId) {
        if (ManagedConfigStore.blocked(jdbc, tenantId, sessionId)) {
            return true;
        }
        Integer commands =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_request_receipt WHERE namespace ="
                            + " 'SESSION_COMMAND' AND tenant_key = ? AND tenant_id = ? AND"
                            + " session_id = ? AND state = 'PENDING'",
                        Integer.class,
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
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
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND (state IN ('PENDING', 'RUNNING',"
                                + " 'UNKNOWN') OR state = 'RECOVERY_BLOCKED' AND operation_kind <>"
                                + " 'TASK_CANCEL') AND operation_id <> ?",
                        Integer.class,
                        ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys
                                .identity(
                                        excludingOperationId == null ? "" : excludingOperationId));
        return (commands != null && commands > 0)
                || (operations != null && operations > 0);
    }

    WebShellModelChangeResult changeSessionModel(String tenantId, String actorId,
            String sessionId, String key, String digest, String modelId, long expectedRevision,
            boolean supported) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        ManagedWorkspaceRegistry.requireSessionVisibility(
                session, actorId, workspaces);
        if (session.workspace() == null) {
            throw new ManagedAgentException(400, "unsupported_feature",
                    "Model selection requires a Workspace Session");
        }
        WorkspaceAccess access = workspaces.accessOf(tenantId, actorId, session.workspace().getWorkspaceId());
        if (!access.canRead()) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found");
        }
        String scope = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys
                .key("SET_MODEL", sessionId, actorId);
        var namespace = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace.SESSION_COMMAND;
        var scopeKind = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope.ACTOR;
        ManagedReceipts.Receipt replay = ManagedReceipts.find(jdbc, namespace, tenantId,
                scopeKind, scope, key, false);
        if (replay != null) {
            if (!digest.equals(replay.requestDigest())
                    || !sessionId.equals(replay.sessionId())
                    || !"SET_MODEL".equals(replay.operation())
                    || !java.util.Arrays.equals(actorId.getBytes(StandardCharsets.UTF_8),
                            replay.actorKey())) {
                throw new ManagedAgentException(409, "idempotency_conflict",
                        "The idempotency key was reused with different content");
            }
            Map<String, Object> result = storeRows.readMap(replay.resultJson());
            return new WebShellModelChangeResult(sessionId, new WebShellModelSelection(
                    (String) result.get("modelId"), ((Number) result.get("revision")).longValue()), true);
        }
        if (!access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(403, "session_operation_forbidden",
                    "Only a Workspace operator may change the model");
        }
        if (session.modelConfigDigest() != null) {
            throw new ManagedAgentException(409, "model_config_immutable", "This Session has an immutable model configuration.");
        }
        if (!supported || modelCatalog.isEmpty() || !workspaceFilesEnabled) {
            throw new ManagedAgentException(409, "unsupported_feature", "Model selection is unavailable");
        }
        if (modelCatalog.stream().noneMatch(option -> option.modelId().equals(modelId))) {
            throw new ManagedAgentException(400, "unsupported_model", "The model is not published by this host");
        }
        // 模型选择只影响后续受理，已受理回合继续使用自己的不可变模型快照。
        requirePolicyChange(session, true);
        long current = jdbc.queryForObject("SELECT model_revision FROM ma_session WHERE tenant_id = ?"
                + " AND session_id = ?", Long.class, tenantId, sessionId);
        if (current != expectedRevision || current >= 9_007_199_254_740_991L) {
            throw new ManagedAgentException(409, "model_selection_conflict", "The model revision changed");
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
                storeRows.writeJson(Map.of("modelId", modelId, "revision", revision)),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.receiptKey(
                        namespace, tenantId, scopeKind, scope, key));
        ManagedModelDiagnosticProjection.clearLegacyModelContext(jdbc, tenantId, sessionId);
        ManagedModelDiagnosticProjection.invalidateModelContext(jdbc, tenantId, sessionId);
        eventJournal.appendEvent(tenantId, sessionId, null, "session.model.changed",
                Map.of("modelId", modelId, "revision", revision), false, null, now);
        return new WebShellModelChangeResult(sessionId, new WebShellModelSelection(modelId, revision), false);
    }

    WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean requestedPlanMode, boolean planModeSupported,
            boolean liveSupported, Map<String, List<String>> requestedRules, boolean rulesSupported, boolean autoSupported) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        ManagedWorkspaceRegistry.requireSessionVisibility(
                session, actorId, workspaces);
        if (session.workspace() == null) {
            throw new ManagedAgentException(400, "unsupported_feature",
                    "Approval selection requires a Workspace Session");
        }
        WorkspaceAccess access = workspaces.accessOf(tenantId, actorId, session.workspace().getWorkspaceId());
        if (!access.canRead()) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found");
        }
        if (!workspaces.isSessionOwner(tenantId, actorId, sessionId)
                || !access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(403, "session_operation_forbidden",
                    "Only the Session owner with OPERATOR access may change approval policy");
        }
        String scope = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys
                .key("SET_APPROVAL", sessionId, actorId);
        var namespace = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace.SESSION_COMMAND;
        var scopeKind = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope.ACTOR;
        long now = clock.millis();
        // A locking read of a missing receipt can gap-lock unrelated Sessions.
        try {
            ManagedReceipts.insert(jdbc, namespace, tenantId, scopeKind, scope, key, digest,
                    "SET_APPROVAL", actorId.getBytes(StandardCharsets.UTF_8), sessionId, null,
                    "COMPLETED", session.status(), true, now);
        } catch (DuplicateKeyException duplicate) {
            ManagedReceipts.Receipt replay = ManagedReceipts.find(jdbc, namespace, tenantId,
                    scopeKind, scope, key, true);
            if (replay == null) {
                throw duplicate;
            }
            if (!digest.equals(replay.requestDigest())
                    || !sessionId.equals(replay.sessionId())
                    || !"SET_APPROVAL".equals(replay.operation())
                    || !java.util.Arrays.equals(actorId.getBytes(StandardCharsets.UTF_8),
                            replay.actorKey())) {
                throw new ManagedAgentException(409, "idempotency_conflict",
                        "The idempotency key was reused with different content");
            }
            Map<String, Object> result = storeRows.readMap(replay.resultJson());
            return new WebShellApprovalChangeResult(sessionId, (String) result.get("mode"),
                    ((Number) result.get("revision")).longValue(), true, Boolean.TRUE.equals(result.get("planMode")),
                    result.get("permissionRules") instanceof Map<?, ?> rules ? harnessRules.nonEmptyPermissionRules(harnessRules.permissionRules(rules)) : null);
        }
        if (!supported || session.agentDefinitionDigest() != null && !agentDefinitionSupported
                || !workspaceFilesEnabled || !WorkspaceToolProfiles.supportsApprovalSelection(session)
                || WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile())
                        && (!ExternalWorkspaceSessionPolicies.externalFilesAllowedOrRefuse(workspaces, session.workspace())
                                || sessionQueries.findChildLineage(tenantId, sessionId) != null)
                || WorkspaceToolProfiles.isPublicShell(session.toolProfile()) && !workspaceShellEnabled) {
            throw new ManagedAgentException(409, "unsupported_feature", "Approval selection is unavailable");
        }
        if (!WorkspaceToolProfiles.supportsApprovalMode(mode) || "auto".equals(mode) && !autoSupported) {
            throw new ManagedAgentException(400, "unsupported_approval_mode", "The approval mode is unavailable");
        }
        var currentPolicy = jdbc.queryForMap("SELECT approval_revision, permission_rules_json, is_plan_enabled FROM ma_session WHERE tenant_id=? AND session_id=? FOR UPDATE",
                tenantId, sessionId);
        Map<String, List<String>> rules = requestedRules == null ? storeRows.readPermissionRules((String) currentPolicy.get("permission_rules_json"))
                : harnessRules.nonEmptyPermissionRules(harnessRules.permissionRules(requestedRules));
        if ((requestedRules != null || rules != null) && !rulesSupported) {
            throw new ManagedAgentException(409, "unsupported_feature", "Permission rules are unavailable");
        }
        boolean planMode = requestedPlanMode == null
                ? Boolean.TRUE.equals(currentPolicy.get("is_plan_enabled")) : requestedPlanMode;
        if (planMode && (!planModeSupported || !supportsPlanMode(session))) {
            throw new ManagedAgentException(409, "unsupported_feature", "Plan mode is unavailable");
        }
        if (requestedRules != null && requestedPlanMode == null) {
            if (hasActiveTurn(tenantId, sessionId) || hasDecidableAction(session)) {
                throw new ManagedAgentException(409, "turn_active", "The Session has an active Turn or approval");
            }
            if (hasOpenOperation(tenantId, sessionId)) {
                throw new ManagedAgentException(409, "session_context_busy", "The Session requires settlement");
            }
        }
        requirePolicyChange(session, requestedPlanMode == null && (liveSupported || requestedRules != null));
        long current = ((Number) currentPolicy.get("approval_revision")).longValue();
        if (current != expectedRevision || current >= 9_007_199_254_740_991L
                || planMode && current >= 9_007_199_254_740_990L) {
            throw new ManagedAgentException(409, "approval_selection_conflict", "The approval revision changed");
        }
        long revision = current + 1;
        int changed = jdbc.update("UPDATE ma_session SET selected_approval_mode = ?, approval_revision = ?, is_plan_enabled = ?, permission_rules_json = ?, gmt_modified = ?,"
                + " version = version + 1 WHERE tenant_id = ? AND session_id = ? AND approval_revision = ?",
                mode, revision, planMode, rules == null ? null : storeRows.writeJson(rules), now, tenantId, sessionId, current);
        if (changed != 1) {
            throw new ManagedAgentException(409, "approval_selection_conflict", "The approval revision changed");
        }
        ManagedModelDiagnosticProjection.invalidateModelContext(jdbc, tenantId, sessionId);
        Map<String, Object> result = new LinkedHashMap<>(Map.of("mode", mode, "revision", revision, "planMode", planMode));
        if (rules != null) {
            result.put("permissionRules", rules);
        }
        jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?",
                storeRows.writeJson(result),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.receiptKey(
                        namespace, tenantId, scopeKind, scope, key));
        eventJournal.appendEvent(tenantId, sessionId, null, "session.approval.changed",
                result, false, null, now);
        return new WebShellApprovalChangeResult(sessionId, mode, revision, false, planMode, rules);
    }

    void requirePublicChildImmutable(SessionRecord session) {
        if (session.publicChildAgentsVersion() == 1 && sessionQueries.findChildLineage(session.tenantId(), session.sessionId()) != null) {
            throw new ManagedAgentException(409, "unsupported_feature", "Public child Sessions cannot change their delegated execution");
        }
    }

    void requireExternalTurnAllowed(String tenantId, String actorId, String sessionId,
            SessionRecord session, List<Map<String, Object>> input) {
        if (!WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile())
                || !ExternalWorkspaceSessionPolicies.externalFilesAllowedOrRefuse(workspaces, session.workspace())
                || !workspaces.accessOf(tenantId, actorId, session.workspace().getWorkspaceId()).canCreate()
                || !"qwen-code".equals(session.agentId()) || session.agentDefinitionDigest() != null
                || sessionQueries.findChildLineage(tenantId, sessionId) != null || session.publicChildAgentsVersion() != 0
                || hasMcpServers(session) || !creationSkills.effective(session).isEmpty()
                || creationSkills.initialSelection(tenantId, sessionId) != null
                || Boolean.TRUE.equals(jdbc.queryForObject("SELECT is_plan_enabled FROM ma_session WHERE tenant_id=? AND session_id=?",
                        Boolean.class, tenantId, sessionId))
                || input.stream().anyMatch(block -> !Set.of("input_text", "text").contains(block.get("type")))) {
            throw workspaceExecutionUnavailable();
        }
    }

    void requirePolicyChange(SessionRecord session, boolean live) {
        requirePublicChildImmutable(session);
        String tenantId = session.tenantId();
        String sessionId = session.sessionId();
        WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, tenantId, session.workspace().getStorageId());
        requireSessionStatus(session.status(), "ACTIVE");
        requireCwdChangeRegistryFacts(session);
        if (!live && (hasActiveTurn(tenantId, sessionId) || hasDecidableAction(session))) {
            throw new ManagedAgentException(409, "turn_active", "The Session has an active Turn or approval");
        }
        if ((live ? hasOpenExecutionOperation(tenantId, sessionId) : hasOpenOperation(tenantId, sessionId))
                || !live && hasRetainedRuntimeSession(tenantId, sessionId)
                || !jdbc.queryForList("SELECT 1 FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND (status IN ('RECOVERY_BLOCKED', 'CANCELLING') OR status IN ('ACCEPTED', 'RUNNING')"
                        + " AND error_code IN (?, ?, ?)) LIMIT 1", tenantId, sessionId,
                        AgentStateStore.RUNTIME_RECOVERY_BLOCKED, AgentStateStore.WORKFLOW_RECOVERY_BLOCKED,
                        AgentStateStore.HARNESS_RECOVERY_BLOCKED).isEmpty()
                || !jdbc.queryForList("SELECT 1 FROM ma_session_head WHERE tenant_id = ?"
                        + " AND session_id = ? AND head_kind = 'MANAGED_SESSION' AND"
                        + " (state <> 'ACTIVE' OR recovery_status <> 'READY')", tenantId, sessionId).isEmpty()) {
            throw new ManagedAgentException(409, "session_context_busy", "The Session requires settlement");
        }
    }

    void requireNoOpenOperation(String tenantId, String sessionId) {
        if (hasOpenOperation(tenantId, sessionId)) {
            throw new ManagedAgentException(409,
                    "session_operation_active",
                    "The Session already has a lifecycle operation in progress.");
        }
    }

    boolean hasDecidableAction(SessionRecord session) {
        long now = storeRows.lifecycleDatabaseTime();
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

    static void requireSessionStatus(String actual,
            String expected) {
        if (!expected.equals(actual)) {
            throw sessionStateConflict(actual);
        }
    }

    static ManagedAgentException sessionStateConflict(String status) {
        return new ManagedAgentException(409,
                "session_state_conflict",
                "The Session is " + status.toLowerCase(Locale.ROOT)
                        + " and cannot perform this operation.");
    }

    boolean hasActiveTurn(String tenantId, String sessionId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                Integer.class, tenantId, sessionId);
        return count != null && count > 0;
    }
}
