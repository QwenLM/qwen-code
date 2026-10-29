package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Pin;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class ApiModels {
    private ApiModels() {
    }

    // The per-block cap is enforced in ManagedAgentService, counted in
    // code points to match the published schema's maxLength; @Size counts
    // UTF-16 units and would disagree on astral-plane text.
    @JsonDeserialize(using = InputBlockDeserializer.class)
    public record InputBlock(@NotBlank String type, String text,
            @JsonProperty("mime_type") String mimeType, String data, String name) {
        public InputBlock(String type, String text) {
            this(type, text, null, null, null);
        }
    }

    public static final class InputBlockDeserializer extends StdDeserializer<InputBlock> {
        public InputBlockDeserializer() { super(InputBlock.class); }

        @Override
        public InputBlock deserialize(JsonParser parser, DeserializationContext context) throws IOException {
            JsonNode node = parser.getCodec().readTree(parser);
            String type = node.path("type").asText();
            Set<String> fields = switch (type) {
                case "input_text", "text" -> Set.of("type", "text");
                case "input_file" -> Set.of("type", "text", "name", "mime_type");
                case "input_image" -> Set.of("type", "data", "mime_type");
                default -> Set.of();
            };
            if (!node.isObject() || node.size() != fields.size()) {
                throw context.weirdStringException(type, InputBlock.class, "Unknown input field or invalid input shape");
            }
            for (String field : fields) {
                if (!node.path(field).isTextual()) {
                    throw context.weirdStringException(type, InputBlock.class, "Input fields must be strings");
                }
            }
            return new InputBlock(type, node.path("text").textValue(), node.path("mime_type").textValue(),
                    node.path("data").textValue(), node.path("name").textValue());
        }
    }

    public record CreateSessionRequest(
            @JsonProperty("agent_id") @NotBlank @Size(max = 128)
                    String agentId,
            @JsonProperty("agent_revision") @Size(max = 128)
                    String agentRevision,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata,
            Boolean stream,
            JsonNode workspace,
            @Size(max = 256) List<@NotNull Map<String, Object>> skills,
            @Size(max = 32) List<@NotNull @Valid Pin> extensionPins, JsonNode worktree) {
        public CreateSessionRequest(String agentId, String agentRevision, List<InputBlock> input,
                Map<String, Object> metadata, Boolean stream, JsonNode workspace, List<Map<String, Object>> skills,
                List<Pin> extensionPins) {
            this(agentId, agentRevision, input, metadata, stream, workspace, skills, extensionPins, null);
        }
        public CreateSessionRequest(String agentId, String agentRevision, List<InputBlock> input,
                Map<String, Object> metadata, Boolean stream, JsonNode workspace, List<Map<String, Object>> skills) {
            this(agentId, agentRevision, input, metadata, stream, workspace, skills, null);
        }
    }

    public record SessionEventRequest(@NotBlank String type,
            @Size(max = 100) List<@Valid InputBlock> input,
            @JsonProperty("turn_id") String turnId) {
    }

    public record UpdateSessionRequest(
            // Single policy owner: ManagedAgentService.validRenameTitle
            // (256 + control-characters + non-blank), so the rename route
            // answers the specific invalid_title code instead of bean
            // validation's generic envelope.
            String title) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CommandAdmission(
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("turn_id") String turnId,
            String status,
            boolean replayed,
            @JsonProperty("operation_id") String operationId,
            @JsonProperty("admission_stage") String admissionStage,
            @JsonProperty("delivery_state") String deliveryState) {
        public CommandAdmission(String sessionId, String turnId,
                String status, boolean replayed) {
            this(sessionId, turnId, status, replayed, null, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicTurn(@JsonProperty("id") String turnId,
            @JsonProperty("object") String object,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("input_item_id") String inputItemId,
            String status,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("completed_at") Long completedAt,
            @JsonProperty("error_code") String errorCode) {
    }

    public record PublicWorkspace(
            @JsonProperty("workspace_id") String workspaceId,
            @JsonProperty("cwd_relative") String cwdRelative,
            @JsonProperty("context_revision") long contextRevision,
            String state) {
    }

    public record WebShellWorkspace(String workspaceId, String cwdRelative,
            long contextRevision, String state) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicSessionWorktree(String id, @JsonProperty("session_id") String sessionId,
            @JsonProperty("workspace_id") String workspaceId, String state, String branch,
            @JsonProperty("base_commit") String baseCommit, @JsonProperty("cwd_relative") String cwdRelative,
            @JsonProperty("operation_id") String operationId, long revision,
            @JsonProperty("error_code") String errorCode) {
    }

    public record SessionCapabilities(
            boolean items,
            boolean snapshots,
            boolean artifacts,
            boolean resync,
            @JsonProperty("session_lifecycle") boolean sessionLifecycle,
            boolean tasks,
            boolean actions,
            @JsonProperty("session_close") boolean sessionClose,
            @JsonProperty("session_archive") boolean sessionArchive,
            @JsonProperty("session_unarchive") boolean sessionUnarchive,
            @JsonProperty("session_delete") boolean sessionDelete,
            @JsonInclude(JsonInclude.Include.NON_NULL) @JsonProperty("foreground_shell") Boolean foregroundShell,
            @JsonProperty("context_compression") boolean contextCompression,
            @JsonInclude(JsonInclude.Include.NON_NULL) @JsonProperty("child_agents") Boolean childAgents) {
        public SessionCapabilities(boolean items, boolean snapshots, boolean artifacts, boolean resync,
                boolean sessionLifecycle, boolean tasks, boolean actions, boolean sessionClose,
                boolean sessionArchive, boolean sessionUnarchive, boolean sessionDelete,
                Boolean foregroundShell, boolean contextCompression) {
            this(items, snapshots, artifacts, resync, sessionLifecycle, tasks, actions, sessionClose,
                    sessionArchive, sessionUnarchive, sessionDelete, foregroundShell, contextCompression, null);
        }
        public SessionCapabilities(boolean items, boolean snapshots, boolean artifacts, boolean resync,
                boolean sessionLifecycle, boolean tasks, boolean actions, boolean sessionClose,
                boolean sessionArchive, boolean sessionUnarchive, boolean sessionDelete,
                Boolean foregroundShell) {
            this(items, snapshots, artifacts, resync, sessionLifecycle, tasks, actions, sessionClose,
                    sessionArchive, sessionUnarchive, sessionDelete, foregroundShell, false);
        }
    }

    public record WebShellSessionCapabilities(boolean tasks, boolean artifacts, boolean actions,
            boolean workspaceTurns, boolean sessionClose, boolean sessionArchive,
            boolean sessionUnarchive, boolean sessionDelete, boolean cwdChange,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean foregroundShell,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean modelChange,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean approvalModeChange,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean inputAttachments,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean rename, boolean contextCompression,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean childAgents) {
        public WebShellSessionCapabilities(boolean tasks, boolean artifacts, boolean actions,
                boolean workspaceTurns, boolean sessionClose, boolean sessionArchive,
                boolean sessionUnarchive, boolean sessionDelete, boolean cwdChange, Boolean foregroundShell,
                Boolean modelChange, Boolean approvalModeChange,
                Boolean inputAttachments, Boolean rename, boolean contextCompression) {
            this(tasks, artifacts, actions, workspaceTurns, sessionClose, sessionArchive, sessionUnarchive,
                    sessionDelete, cwdChange, foregroundShell, modelChange, approvalModeChange,
                    inputAttachments, rename, contextCompression, null);
        }
        public WebShellSessionCapabilities(boolean tasks, boolean artifacts, boolean actions,
                boolean workspaceTurns, boolean sessionClose, boolean sessionArchive,
                boolean sessionUnarchive, boolean sessionDelete, boolean cwdChange, Boolean foregroundShell,
                Boolean modelChange, Boolean approvalModeChange,
                Boolean inputAttachments, Boolean rename) {
            this(tasks, artifacts, actions, workspaceTurns, sessionClose, sessionArchive, sessionUnarchive,
                    sessionDelete, cwdChange, foregroundShell, modelChange, approvalModeChange,
                    inputAttachments, rename, false);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicSession(String id, String object,
            @JsonProperty("agent_id") String agentId,
            @JsonProperty("agent_revision") String agentRevision,
            @JsonProperty("agent_digest") String agentDefinitionDigest,
            String status,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("updated_at") long updatedAt,
            Map<String, Object> metadata,
            @JsonProperty("active_turn") PublicTurn activeTurn,
            @JsonProperty("last_event_id") long lastEventId,
            @JsonProperty("replay_floor_sequence") long replayFloorSequence,
            @JsonProperty("snapshot_through_sequence")
                    long snapshotThroughSequence,
            SessionCapabilities capabilities,
            @JsonProperty("workspace") PublicWorkspace workspace,
            @JsonProperty("compaction_revision") Long compactionRevision,
            @JsonProperty("context_compression_operation_id") String contextCompressionOperationId,
            SessionRecovery recovery,
            PublicSessionWorktree worktree) {
        public PublicSession(String id, String object, String agentId, String agentRevision,
                String agentDefinitionDigest, String status, long createdAt, long updatedAt,
                Map<String, Object> metadata, PublicTurn activeTurn, long lastEventId,
                long replayFloorSequence, long snapshotThroughSequence, SessionCapabilities capabilities,
                PublicWorkspace workspace, Long compactionRevision, String contextCompressionOperationId,
                SessionRecovery recovery) {
            this(id, object, agentId, agentRevision, agentDefinitionDigest, status, createdAt, updatedAt,
                    metadata, activeTurn, lastEventId, replayFloorSequence, snapshotThroughSequence,
                    capabilities, workspace, compactionRevision, contextCompressionOperationId, recovery, null);
        }
        public PublicSession(String id, String object, String agentId, String agentRevision,
                String agentDefinitionDigest, String status, long createdAt, long updatedAt,
                Map<String, Object> metadata, PublicTurn activeTurn, long lastEventId,
                long replayFloorSequence, long snapshotThroughSequence, SessionCapabilities capabilities,
                PublicWorkspace workspace) {
            this(id, object, agentId, agentRevision, agentDefinitionDigest, status, createdAt, updatedAt,
                    metadata, activeTurn, lastEventId, replayFloorSequence, snapshotThroughSequence,
                    capabilities, workspace, 0L, null, null);
        }

        public PublicSession(String id, String object, String agentId,
                String agentRevision, String agentDefinitionDigest,
                String status, long createdAt, long updatedAt,
                Map<String, Object> metadata, PublicTurn activeTurn,
                long lastEventId, long replayFloorSequence,
                long snapshotThroughSequence, SessionCapabilities capabilities,
                PublicWorkspace workspace, Long compactionRevision,
                String contextCompressionOperationId) {
            this(id, object, agentId, agentRevision, agentDefinitionDigest,
                    status, createdAt, updatedAt, metadata, activeTurn,
                    lastEventId, replayFloorSequence, snapshotThroughSequence,
                    capabilities, workspace, compactionRevision,
                    contextCompressionOperationId, null);
        }

        public PublicSession withRecovery(SessionRecovery value) {
            return new PublicSession(id, object, agentId, agentRevision,
                    agentDefinitionDigest, status, createdAt, updatedAt,
                    metadata, activeTurn, lastEventId, replayFloorSequence,
                    snapshotThroughSequence, capabilities, workspace,
                    compactionRevision, contextCompressionOperationId, value, worktree);
        }

        public PublicSession withWorktree(com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore.Descriptor value) {
            return new PublicSession(id, object, agentId, agentRevision,
                    agentDefinitionDigest, status, createdAt, updatedAt,
                    metadata, activeTurn, lastEventId, replayFloorSequence,
                    snapshotThroughSequence, capabilities, workspace,
                    compactionRevision, contextCompressionOperationId, recovery,
                    value == null ? null : new PublicSessionWorktree(value.id(), value.sessionId(), value.workspaceId(),
                            value.state(), value.branch(), value.baseCommit(), value.cwdRelative(), value.operationId(),
                            value.revision(), value.errorCode()));
        }
    }

    public record SessionRecoveryActions(boolean recheck, boolean cancel,
            boolean continueInNewSession) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SessionRecovery(String state, String reasonCode,
            String turnId, boolean nextTurnAllowed,
            SessionRecoveryActions actions, Long nextRecheckAt) {
    }

    public record RecoveryRecheckRequest(@NotBlank @Size(max = 128)
            String turnId) {
    }

    public record WebShellRecoveryRecheckRequest(
            @NotBlank @Size(max = 128) String sessionId,
            @NotBlank @Size(max = 128) String turnId) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicCommandOperation(
            String id,
            @JsonProperty("session_id") String sessionId,
            String type,
            String status,
            @JsonProperty("admission_stage") String admissionStage,
            @JsonProperty("delivery_state") String deliveryState,
            @JsonProperty("receipt_id") String receiptId,
            boolean replayed,
            @JsonProperty("action_resolution") JsonNode actionResolution,
            @JsonProperty("failure_code") String failureCode,
            @JsonProperty("task_id") String taskId) {
        public PublicCommandOperation(String id, String sessionId,
                String type, String status, String admissionStage,
                String deliveryState, String receiptId, boolean replayed,
                JsonNode actionResolution, String failureCode) {
            this(id, sessionId, type, status, admissionStage, deliveryState,
                    receiptId, replayed, actionResolution, failureCode, null);
        }

        public PublicCommandOperation(
                String id,
                String sessionId,
                String type,
                String status,
                String admissionStage,
                String deliveryState,
                String receiptId,
                boolean replayed) {
            this(
                    id,
                    sessionId,
                    type,
                    status,
                    admissionStage,
                    deliveryState,
                    receiptId,
                    replayed,
                    null,
                    null);
        }
    }

    public record PublicList<T>(String object, List<T> data,
            @JsonProperty("has_more") boolean hasMore,
            @JsonProperty("next_cursor") String nextCursor) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicEvent(
            @JsonProperty("schema_version") int schemaVersion,
            @JsonProperty("projection_version") int projectionVersion,
            @JsonProperty("sequence") long sequence,
            @JsonProperty("event_id") String eventId,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("turn_id") String turnId,
            @JsonProperty("item_id") String itemId,
            @JsonProperty("content_part_id") String contentPartId,
            String type,
            @JsonProperty("created_at") long createdAt,
            Map<String, Object> data,
            boolean terminal) {
    }

    public record SessionResyncRequired(String type,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("replay_floor_sequence") long replayFloorSequence,
            @JsonProperty("snapshot_through_sequence")
                    long snapshotThroughSequence,
            String action) {
    }

    public record PublicContentPart(@JsonProperty("part_id") String partId,
            String type, String text,
            @JsonProperty("first_sequence") long firstSequence,
            @JsonProperty("last_sequence") long lastSequence) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicItem(String id, String object,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("turn_id") String turnId, String type, String role,
            long revision, String status, List<PublicContentPart> content,
            Map<String, Object> attributes,
            @JsonProperty("first_sequence") long firstSequence,
            @JsonProperty("last_sequence") long lastSequence,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("updated_at") long updatedAt) {
    }

    public record PublicItemList(String object, List<PublicItem> data,
            @JsonProperty("has_more") boolean hasMore,
            @JsonProperty("next_cursor") String nextCursor,
            @JsonProperty("snapshot_through_sequence")
                    long snapshotThroughSequence) {
    }

    public record WebShellListRequest(String cursor, Integer limit, String archiveState,
            String titleQuery) {
        public WebShellListRequest(String cursor, Integer limit, String archiveState) {
            this(cursor, limit, archiveState, null);
        }
    }

    public record WebShellSessionRequest(@NotBlank String sessionId) {
    }

    public record ManagedMcpServerPin(@NotBlank @Pattern(regexp = "[A-Za-z0-9._:-]{1,128}") String serverId,
            @Min(1) @Max(9_007_199_254_740_991L) long serverRevision,
            @NotBlank @Pattern(regexp = "[a-f0-9]{64}") String definitionDigest) { }

    public record ManagedMcpManagementCommand(@NotBlank String action,
            @NotBlank @Pattern(regexp = "[A-Za-z0-9._:-]{1,128}") String serverId,
            @NotNull @Min(0) @Max(9_007_199_254_740_990L) Long expectedRevision,
            @Valid ManagedMcpServerPin server) { }

    public record WebShellMcpManagementQuery(@NotBlank @Size(max = 128) String sessionId,
            @Size(max = 128) String requestId) { }

    public record WebShellMcpManagementSubmit(@NotBlank @Size(max = 128) String sessionId,
            @Size(max = 128) String requestId, @NotNull String idempotencyKey,
            @NotBlank String action, @NotBlank @Pattern(regexp = "[A-Za-z0-9._:-]{1,128}") String serverId,
            @NotNull @Min(0) @Max(9_007_199_254_740_990L) Long expectedRevision,
            @Valid ManagedMcpServerPin server) { }

    public record WebShellMcpManagementOperationQuery(@NotBlank @Size(max = 128) String sessionId,
            @NotBlank String operationId, @Size(max = 128) String requestId) { }

    public record WebShellRenameRequest(@Size(max = 128) String requestId,
            @NotBlank @Size(max = 128) String sessionId,
            @NotNull String idempotencyKey, String title) {
    }

    public record WebShellRenameResult(String sessionId, String title, boolean replayed) {
    }

    public record WebShellSkill(String name, String description) { }

    public record WebShellSessionSkills(List<WebShellSkill> skills) { }

    public record WebShellTranscriptRequest(@NotBlank String sessionId,
            String cursor, Integer limit,
            @Pattern(regexp = "messages") String view) {
        public WebShellTranscriptRequest(String sessionId, String cursor, Integer limit) {
            this(sessionId, cursor, limit, null);
        }
    }

    public record WebShellStreamRequest(@NotBlank String sessionId,
            Long afterSequence) {
    }

    public record WebShellCreateRequest(@Size(max = 128) String requestId,
            @NotBlank String idempotencyKey,
            @NotBlank @Size(max = 128) String agentId,
            String title,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata,
            JsonNode workspace, String approvalMode, Boolean planMode, String modelId,
            @Size(max = 256) List<@NotNull Map<String, Object>> skills,
            @Size(max = 32) List<@NotNull @Valid Pin> extensionPins, JsonNode worktree) {
        public WebShellCreateRequest(String requestId, String idempotencyKey, String agentId, String title,
                List<InputBlock> input, Map<String, Object> metadata, JsonNode workspace, String approvalMode,
                Boolean planMode, String modelId, List<Map<String, Object>> skills, List<Pin> extensionPins) {
            this(requestId, idempotencyKey, agentId, title, input, metadata, workspace, approvalMode,
                    planMode, modelId, skills, extensionPins, null);
        }
        public WebShellCreateRequest(String requestId, String idempotencyKey, String agentId, String title,
                List<InputBlock> input, Map<String, Object> metadata, JsonNode workspace, String approvalMode,
                Boolean planMode, String modelId, List<Map<String, Object>> skills) {
            this(requestId, idempotencyKey, agentId, title, input, metadata, workspace, approvalMode, planMode, modelId, skills, null);
        }
    }

    public record WebShellSessionOptionsRequest(@NotBlank @Size(max = 128) String agentId) {
    }

    public record WebShellSessionOptions(String approvalMode, List<String> availableApprovalModes,
            boolean planModeSupported, boolean inputAttachments, boolean skillsSupported,
            boolean modelSelectionSupported) {
        public WebShellSessionOptions(String approvalMode, List<String> availableApprovalModes,
                boolean planModeSupported, boolean inputAttachments, boolean skillsSupported) {
            this(approvalMode, availableApprovalModes, planModeSupported, inputAttachments, skillsSupported, false);
        }
        public WebShellSessionOptions(String approvalMode, List<String> availableApprovalModes,
                boolean planModeSupported, boolean inputAttachments) {
            this(approvalMode, availableApprovalModes, planModeSupported, inputAttachments, false);
        }
        public WebShellSessionOptions(String approvalMode, List<String> availableApprovalModes) {
            this(approvalMode, availableApprovalModes, false, false);
        }
    }

    public record WebShellApprovalSelection(String mode, long revision, boolean planMode,
            @JsonInclude(JsonInclude.Include.NON_NULL) Map<String, List<String>> permissionRules) {
        public WebShellApprovalSelection(String mode, long revision, boolean planMode) {
            this(mode, revision, planMode, null);
        }
        public WebShellApprovalSelection(String mode, long revision) {
            this(mode, revision, false);
        }
    }

    public record WebShellSessionApproval(String approvalMode, long approvalRevision,
            List<String> availableApprovalModes, boolean supported, boolean planMode, boolean planModeSupported,
            boolean liveSupported, boolean permissionRulesSupported,
            @JsonInclude(JsonInclude.Include.NON_NULL) Map<String, List<String>> permissionRules) {}

    public record WebShellSessionApprovalRequest(@NotBlank @Size(max = 128) String sessionId) {}

    public record WebShellChangeApprovalRequest(@Size(max = 128) String requestId,
            @NotBlank @Size(max = 128) String sessionId,
            @NotBlank @Size(max = 128) String idempotencyKey,
            @NotBlank String approvalMode,
            @NotNull @Min(0) @Max(9_007_199_254_740_991L) Long expectedRevision, Boolean planMode,
            Map<String, Object> permissionRules) {}

    public record WebShellApprovalChangeResult(String sessionId, String approvalMode,
            long approvalRevision, boolean replayed, boolean planMode,
            @JsonInclude(JsonInclude.Include.NON_NULL) Map<String, List<String>> permissionRules) {
        public WebShellApprovalChangeResult(String sessionId, String approvalMode, long approvalRevision, boolean replayed, boolean planMode) {
            this(sessionId, approvalMode, approvalRevision, replayed, planMode, null);
        }
        public WebShellApprovalChangeResult(String sessionId, String approvalMode, long approvalRevision, boolean replayed) {
            this(sessionId, approvalMode, approvalRevision, replayed, false);
        }
    }

    public record WebShellModelOption(String modelId, String label) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellModelSelection(String modelId, long revision) {}

    public record WebShellSessionModelsRequest(@NotBlank @Size(max = 128) String sessionId) {}

    public record WebShellSessionModels(List<WebShellModelOption> models,
            WebShellModelSelection modelSelection, boolean supported) {}

    public record WebShellChangeModelRequest(@Size(max = 128) String requestId,
            @NotBlank @Size(max = 128) String sessionId,
            @NotBlank @Size(max = 128) String idempotencyKey,
            @NotBlank @Size(max = 512) String modelId,
            @NotNull @Min(0) @Max(9_007_199_254_740_991L) Long expectedRevision) {}

    public record WebShellModelChangeResult(String sessionId,
            WebShellModelSelection modelSelection, boolean replayed) {}

    public record WebShellSubmitRequest(@Size(max = 128) String requestId,
            @NotBlank String idempotencyKey, @NotBlank String sessionId,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata) {
    }

    public record WebShellCancelRequest(@Size(max = 128) String requestId,
            @NotBlank String idempotencyKey, @NotBlank String sessionId,
            @NotBlank String turnId) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellAdmission(String sessionId, String turnId,
            String status, boolean replayed, String operationId,
            String admissionStage, String deliveryState) {
    }

    public record WebShellLifecycleRequest(@NotBlank String sessionId,
            @NotBlank @Size(max = 128) String idempotencyKey,
            @Size(max = 128) String requestId) {
    }

    public record CompressSessionRequest(
            @NotNull @JsonProperty("expected_compaction_revision") Long expectedCompactionRevision) {
    }

    public record WebShellContextCompressionRequest(@Size(max = 128) String requestId,
            @NotBlank @Size(max = 128) String sessionId,
            @NotBlank @Size(max = 128) String idempotencyKey,
            @NotNull Long expectedCompactionRevision) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicContextCompressionOperation(String id,
            @JsonProperty("session_id") String sessionId, String type, String status,
            @JsonProperty("expected_compaction_revision") long expectedCompactionRevision,
            @JsonProperty("compaction_revision") Long compactionRevision,
            String outcome, @JsonProperty("failure_code") String failureCode, boolean replayed) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellContextCompressionOperation(String operationId,
            String sessionId, String type, String status, long expectedCompactionRevision,
            Long compactionRevision, String outcome, String failureCode, boolean replayed) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicCwdOperation(
            String id,
            @JsonProperty("session_id") String sessionId,
            String type,
            String status,
            @JsonProperty("expected_context_revision")
                    long expectedContextRevision,
            @JsonProperty("target_cwd_relative") String targetCwdRelative,
            @JsonProperty("result_context_revision")
                    Long resultContextRevision,
            @JsonProperty("failure_code") String failureCode,
            boolean replayed) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellCwdOperation(
            String operationId,
            String sessionId,
            String type,
            String status,
            long expectedContextRevision,
            String targetCwdRelative,
            Long resultContextRevision,
            String failureCode,
            boolean replayed) {
    }

    public record WebShellOperationRequest(@NotBlank String sessionId,
            @NotBlank @Size(max = 64) String operationId) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellCommandOperation(
            String operationId,
            String sessionId,
            String type,
            String status,
            String admissionStage,
            String deliveryState,
            String receiptId,
            boolean replayed,
            JsonNode actionResolution,
            String failureCode,
            String taskId) {
        public WebShellCommandOperation(String operationId, String sessionId,
                String type, String status, String admissionStage,
                String deliveryState, String receiptId, boolean replayed,
                JsonNode actionResolution, String failureCode) {
            this(operationId, sessionId, type, status, admissionStage,
                    deliveryState, receiptId, replayed, actionResolution,
                    failureCode, null);
        }

        public WebShellCommandOperation(
                String operationId,
                String sessionId,
                String type,
                String status,
                String admissionStage,
                String deliveryState,
                String receiptId,
                boolean replayed) {
            this(
                    operationId,
                    sessionId,
                    type,
                    status,
                    admissionStage,
                    deliveryState,
                    receiptId,
                    replayed,
                    null,
                    null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellTurn(String turnId, String sessionId,
            String status, long submittedAt, Long completedAt,
            String errorCode) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellModelContext(String modelId, Long inputTokens,
            Long contextWindowSize, long observedAt) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellSession(String sessionId, String title,
            String agentId, String status, long createdAt, long updatedAt,
            WebShellTurn activeTurn, Object environment, long lastSequence,
            WebShellWorkspace workspace,
            WebShellSessionCapabilities capabilities, String approvalMode,
            WebShellModelContext modelContext, WebShellModelSelection modelSelection,
            Long approvalRevision, String initialApprovalMode, boolean planMode, boolean planModeSupported,
            Long compactionRevision, String contextCompressionOperationId,
            WebShellLifecycleOperation lifecycleOperation, SessionRecovery recovery,
            com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore.Descriptor worktree) {
        public WebShellSession(String sessionId, String title, String agentId, String status,
                long createdAt, long updatedAt, WebShellTurn activeTurn, Object environment,
                long lastSequence, WebShellWorkspace workspace, WebShellSessionCapabilities capabilities,
                String approvalMode, WebShellModelContext modelContext, WebShellModelSelection modelSelection,
                Long approvalRevision, String initialApprovalMode, boolean planMode, boolean planModeSupported,
                Long compactionRevision, String contextCompressionOperationId,
                WebShellLifecycleOperation lifecycleOperation, SessionRecovery recovery) {
            this(sessionId, title, agentId, status, createdAt, updatedAt, activeTurn, environment, lastSequence,
                    workspace, capabilities, approvalMode, modelContext, modelSelection, approvalRevision,
                    initialApprovalMode, planMode, planModeSupported, compactionRevision,
                    contextCompressionOperationId, lifecycleOperation, recovery, null);
        }
        public WebShellSession(String sessionId, String title, String agentId, String status,
                long createdAt, long updatedAt, WebShellTurn activeTurn, Object environment,
                long lastSequence, WebShellWorkspace workspace, WebShellSessionCapabilities capabilities,
                String approvalMode, WebShellModelContext modelContext, WebShellModelSelection modelSelection,
                Long approvalRevision, String initialApprovalMode, boolean planMode, boolean planModeSupported) {
            this(sessionId, title, agentId, status, createdAt, updatedAt, activeTurn, environment, lastSequence,
                    workspace, capabilities, approvalMode, modelContext, modelSelection, approvalRevision,
                    initialApprovalMode, planMode, planModeSupported, 0L, null, null, null);
        }

        public WebShellSession(String sessionId, String title, String agentId,
                String status, long createdAt, long updatedAt,
                WebShellTurn activeTurn, Object environment, long lastSequence,
                WebShellWorkspace workspace, WebShellSessionCapabilities capabilities,
                String approvalMode, WebShellModelContext modelContext,
                WebShellModelSelection modelSelection, Long approvalRevision,
                String initialApprovalMode, boolean planMode, boolean planModeSupported,
                Long compactionRevision, String contextCompressionOperationId) {
            this(sessionId, title, agentId, status, createdAt, updatedAt,
                    activeTurn, environment, lastSequence, workspace, capabilities,
                    approvalMode, modelContext, modelSelection, approvalRevision,
                    initialApprovalMode, planMode, planModeSupported, compactionRevision,
                    contextCompressionOperationId, null, null);
        }

        public WebShellSession(String sessionId, String title, String agentId,
                String status, long createdAt, long updatedAt,
                WebShellTurn activeTurn, Object environment, long lastSequence,
                WebShellWorkspace workspace, WebShellSessionCapabilities capabilities,
                String approvalMode, WebShellModelContext modelContext,
                WebShellModelSelection modelSelection, Long approvalRevision,
                String initialApprovalMode, boolean planMode, boolean planModeSupported,
                Long compactionRevision, String contextCompressionOperationId,
                WebShellLifecycleOperation lifecycleOperation) {
            this(sessionId, title, agentId, status, createdAt, updatedAt,
                    activeTurn, environment, lastSequence, workspace, capabilities,
                    approvalMode, modelContext, modelSelection, approvalRevision,
                    initialApprovalMode, planMode, planModeSupported, compactionRevision,
                    contextCompressionOperationId, lifecycleOperation, null);
        }

        public WebShellSession withRecovery(SessionRecovery value) {
            return new WebShellSession(sessionId, title, agentId, status,
                    createdAt, updatedAt, activeTurn, environment, lastSequence,
                    workspace, capabilities, approvalMode, modelContext,
                    modelSelection, approvalRevision, initialApprovalMode,
                    planMode, planModeSupported, compactionRevision, contextCompressionOperationId,
                    lifecycleOperation, value, worktree);
        }

        public WebShellSession withWorktree(com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore.Descriptor value) {
            return new WebShellSession(sessionId, title, agentId, status,
                    createdAt, updatedAt, activeTurn, environment, lastSequence,
                    workspace, capabilities, approvalMode, modelContext,
                    modelSelection, approvalRevision, initialApprovalMode,
                    planMode, planModeSupported, compactionRevision, contextCompressionOperationId,
                    lifecycleOperation, recovery, value);
        }
    }

    /**
     * H6b: the definition fields a create or revise request carries. The
     * gate is a JsonNode so an explicit null — which clears a committed
     * gate — stays distinct from an absent field, which keeps it.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AutomationDefinitionRequest(
            @JsonProperty("session_id") String sessionId, String goal,
            String cron, String timezone, String prompt,
            @JsonProperty("session_mode") String sessionMode, String overlap,
            @JsonProperty("catch_up") String catchUp,
            @JsonProperty("catch_up_limit") Long catchUpLimit,
            Boolean enabled, JsonNode gate) {
        public AutomationDefinitionRequest(String sessionId, String goal,
                String cron, String timezone, String prompt,
                String sessionMode, String overlap, String catchUp,
                Long catchUpLimit, Boolean enabled) {
            this(sessionId, goal, cron, timezone, prompt, sessionMode,
                    overlap, catchUp, catchUpLimit, enabled, null);
        }
    }

    /** The recent outcomes of a definition's gate probe. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicAutomationGateStatus(
            @JsonProperty("last_outcome") String lastOutcome,
            @JsonProperty("last_at") long lastAt,
            @JsonProperty("quiet_since_delivery") int quietSinceDelivery,
            @JsonProperty("consecutive_failures") int consecutiveFailures,
            @JsonProperty("last_error") String lastError) {
    }

    /** H6b: one automation definition at its current revision. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicAutomation(String id, String object,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("definition_revision") long definitionRevision,
            String digest, String goal, String cron, String timezone,
            @JsonProperty("session_mode") String sessionMode, String overlap,
            @JsonProperty("catch_up") String catchUp,
            @JsonProperty("catch_up_limit") Long catchUpLimit,
            boolean enabled, String state,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("updated_at") long updatedAt, String gate,
            @JsonProperty("gate_status") PublicAutomationGateStatus gateStatus) {
    }

    /** H5c: one route binding of a channel connection (PublicChannelRoute). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicChannelRoute(
            @JsonProperty("platform_event_id") String platformEventId,
            @JsonProperty("account_generation") long accountGeneration,
            @JsonProperty("semantic_revision") long semanticRevision,
            @JsonProperty("sender_id") String senderId,
            @JsonProperty("chat_id") String chatId,
            @JsonProperty("thread_id") String threadId,
            @JsonProperty("session_id") String sessionId,
            String state,
            @JsonProperty("input_id") String inputId,
            @JsonProperty("staged_attachment_refs")
                    List<String> stagedAttachmentRefs,
            @JsonProperty("created_at") long createdAt) {
    }

    /** H5c: one channel connection with its newest route bindings. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicChannel(String id, String object, String platform,
            @JsonProperty("account_generation") long accountGeneration,
            String state, List<PublicChannelRoute> routes,
            @JsonProperty("created_at") long createdAt) {
    }

    /** H5c: one outbound delivery of a channel. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicChannelDelivery(String id, String object,
            @JsonProperty("channel_id") String channelId,
            @JsonProperty("segment_id") String segmentId,
            int ordinal, String state,
            @JsonProperty("provider_receipt") String providerReceipt,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("updated_at") long updatedAt) {
    }

    /** H6b: one occurrence decision of an automation, with its run's state. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicAutomationRun(String id, String object,
            @JsonProperty("automation_id") String automationId,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("occurrence_key") String occurrenceKey, String slot,
            String trigger, String outcome, String reason,
            @JsonProperty("definition_revision") long definitionRevision,
            String state, @JsonProperty("created_at") long createdAt,
            @JsonProperty("updated_at") long updatedAt) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicTask(String id, String object,
            @JsonProperty("session_id") String sessionId, String kind,
            String state,
            @JsonProperty("definition_revision") Long definitionRevision,
            @JsonProperty("runtime_state") String runtimeState,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("started_at") Long startedAt,
            @JsonProperty("settled_at") Long settledAt,
            @JsonProperty("output_cursor") String outputCursor,
            @JsonProperty("artifact_refs") List<String> artifactRefs,
            @JsonProperty("action_capabilities")
                    List<String> actionCapabilities,
            @JsonProperty("child_session_id") String childSessionId,
            @JsonProperty("stop_requested") Boolean stopRequested,
            @JsonProperty("approval_mode") String approvalMode) {
        public PublicTask(String id, String object, String sessionId, String kind,
                String state, Long definitionRevision, String runtimeState, long createdAt,
                Long startedAt, Long settledAt, String outputCursor, List<String> artifactRefs,
                List<String> actionCapabilities, String childSessionId) {
            this(id, object, sessionId, kind, state, definitionRevision, runtimeState, createdAt,
                    startedAt, settledAt, outputCursor, artifactRefs, actionCapabilities, childSessionId, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellTask(String taskId, String sessionId, String kind,
            String state, Long definitionRevision, String runtimeState,
            long createdAt, Long startedAt, Long settledAt,
            String outputCursor,
            List<String> artifactRefs, List<String> actionCapabilities,
            String childSessionId, Boolean stopRequested, String approvalMode) {
        public WebShellTask(String taskId, String sessionId, String kind, String state,
                Long definitionRevision, String runtimeState, long createdAt, Long startedAt,
                Long settledAt, String outputCursor, List<String> artifactRefs,
                List<String> actionCapabilities, String childSessionId) {
            this(taskId, sessionId, kind, state, definitionRevision, runtimeState, createdAt,
                    startedAt, settledAt, outputCursor, artifactRefs, actionCapabilities, childSessionId, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicTaskEvent(
            @JsonProperty("schema_version") int schemaVersion,
            @JsonProperty("projection_version") int projectionVersion,
            @JsonProperty("task_id") String taskId,
            @JsonProperty("session_id") String sessionId,
            String type, String cursor,
            @JsonProperty("created_at") long createdAt,
            String state,
            @JsonProperty("runtime_state") String runtimeState,
            String text, Boolean truncated,
            @JsonProperty("artifact_id") String artifactId) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellTaskEvent(int schemaVersion, int projectionVersion,
            String taskId, String sessionId, String type, String cursor,
            long createdAt, String state, String runtimeState, String text,
            Boolean truncated, String artifactId) {
    }

    public record WebShellTaskEventQueryRequest(@NotBlank String sessionId,
            @NotBlank String taskId, @Size(max = 512) String after,
            Integer limit) {
    }

    public record PermissionResponse(
            @NotBlank String kind,
            @JsonProperty("input_revision") JsonNode inputRevision,
            @JsonProperty("policy_revision") @NotBlank @Size(max = 128) String policyRevision,
            @JsonProperty("option_id") @NotBlank @Size(max = 128) String optionId) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Action request field: " + name);
        }
    }

    public record WebShellPermissionResponse(
            @NotBlank String kind,
            JsonNode inputRevision,
            @NotBlank @Size(max = 128) String policyRevision,
            @NotBlank @Size(max = 128) String optionId) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Action request field: " + name);
        }
    }

    public record WebShellActionQueryRequest(
            @NotBlank String sessionId, @Size(max = 512) String cursor, Integer limit, Boolean includeChildren) {
        public WebShellActionQueryRequest(String sessionId, String cursor, Integer limit) {
            this(sessionId, cursor, limit, null);
        }
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Action request field: " + name);
        }
    }

    public record WebShellActionGetRequest(
            @NotBlank String sessionId, @NotBlank @Size(max = 128) String actionId) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Action request field: " + name);
        }
    }

    public record WebShellActionRespondRequest(
            @Size(max = 128) String requestId,
            @NotBlank String sessionId,
            @NotBlank @Size(max = 128) String actionId,
            @NotBlank @Size(max = 128) String idempotencyKey,
            @NotNull @Valid WebShellPermissionResponse response) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Action request field: " + name);
        }
    }

    public record PublicActionList(
            List<JsonNode> data,
            @JsonProperty("has_more") boolean hasMore,
            @JsonProperty("next_cursor") String nextCursor) {}

    public record ArtifactAccess(@JsonProperty("can_read_content") boolean canReadContent) { }

    public record ToolResultResponse(JsonNode result, ArtifactAccess access) { }

    public record WebShellToolDetails(JsonNode input, String output, boolean truncated,
            @JsonInclude(JsonInclude.Include.NON_NULL) WebShellShellResult shellResult) { }

    public record WebShellShellResult(String type, int version, String text, String output,
            String directory, Long exitCode, Long signal, Long pid, String error,
            String outcome, List<String> notices, boolean truncated, List<String> outputFiles) { }

    public record ArtifactResponse(JsonNode artifact, ArtifactAccess access) { }

    public record WebShellToolResultRequest(@NotBlank String sessionId,
            @NotBlank String itemId) { }

    public record WebShellArtifactRequest(@NotBlank String sessionId,
            @NotBlank String artifactId) { }

    public record WebShellArtifactQueryRequest(@NotBlank String sessionId,
            String cursor, Integer limit) { }

    public record WebShellTaskQueryRequest(@NotBlank String sessionId,
            String cursor, Integer limit) {
    }

    public record WebShellTaskGetRequest(@NotBlank String sessionId,
            @NotBlank String taskId) {
    }

    /**
     * H4f: {@code requestId} is trace-only and stays out of the digest. A
     * missing key is {@code 400 invalid_request}; a blank or overlong one
     * reaches the service, whose check answers the contract's {@code 400
     * invalid_idempotency_key}.
     */
    public record WebShellTaskCancelRequest(@Size(max = 128) String requestId,
            @NotBlank String sessionId, @NotBlank @Size(max = 128) String taskId,
            @NotNull String idempotencyKey) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException(
                    "Unknown task cancel request field: " + name);
        }
    }

    public record WebShellPage<T>(List<T> data, String nextCursor, boolean hasMore) {
    }

    public record WebShellTaskPage(List<WebShellTask> data, String nextCursor,
            boolean hasMore, @JsonInclude(JsonInclude.Include.NON_NULL) Long activeChildCount) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellEvent(int schemaVersion, int projectionVersion,
            long sequence, String eventId, String sessionId, String turnId,
            String itemId, String contentPartId, String type, long createdAt,
            Map<String, Object> data, boolean terminal) {
    }

    public record WebShellResyncRequired(String type, String sessionId,
            long replayFloorSequence, long snapshotThroughSequence,
            String action) {
    }

    public record WebShellContentPart(String partId, String type, String text,
            long firstSequence, long lastSequence) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellItem(String itemId, String sessionId,
            String turnId, String type, String role, String status,
            List<WebShellContentPart> content,
            Map<String, Object> attributes, long firstSequence,
            long lastSequence, long createdAt, long updatedAt) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellLifecycleOperation(String operationId, String type,
            String status, String failureCode) {
    }

    public record WebShellExportRequest(@NotBlank String sessionId,
            @Size(max = 4096) String cursor, @Min(1) @Max(100) Integer limit,
            @Pattern(regexp = "messages") String view) {
        public WebShellExportRequest(String sessionId, String cursor, Integer limit) {
            this(sessionId, cursor, limit, null);
        }
    }

    public record WebShellExportPage(List<WebShellItem> items, String nextCursor,
            boolean hasMore, long snapshotThroughSequence) {
    }

    public record WebShellTranscript(List<WebShellItem> items,
            List<WebShellEvent> events, long coveredSequence,
            String olderCursor, boolean hasMore, long lastSequence) {
    }

    /**
     * An AgentDefinition revision's content (D8a). The server stores and
     * digests it; a Session pinned to a revision executes its
     * permission_policy, tools, model and instructions (D8b/D8c).
     */
    public record AgentDefinitionRequest(
            @NotNull Map<String, Object> model,
            @NotNull @Size(max = 1_000_000) String instructions,
            @NotNull @Size(max = 1000)
                    List<@NotNull Map<String, Object>> tools,
            @Size(max = 1000) List<@NotNull Map<String, Object>> skills,
            @JsonProperty("mcp_servers") @Size(max = 100)
                    List<@NotNull Map<String, Object>> mcpServers,
            @JsonProperty("hook_catalog") Map<String, Object> hookCatalog,
            @JsonProperty("permission_policy") @NotNull
                    Map<String, Object> permissionPolicy,
            @JsonProperty("environment_template_id") @Size(max = 128)
                    String environmentTemplateId,
            Map<String, Object> metadata) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AgentDefinition(String id, String object, String revision,
            String digest, @JsonProperty("created_at") long createdAt,
            Map<String, Object> metadata) {
    }
}
