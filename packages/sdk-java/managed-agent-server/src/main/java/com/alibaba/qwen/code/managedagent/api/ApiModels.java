package com.alibaba.qwen.code.managedagent.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import jakarta.validation.constraints.NotNull;
import com.fasterxml.jackson.annotation.JsonAnySetter;

public final class ApiModels {
    private ApiModels() {
    }

    public record InputBlock(@NotBlank String type,
            @NotBlank @Size(max = 1_000_000) String text) {
    }

    public record CreateSessionRequest(
            @JsonProperty("agent_id") @NotBlank @Size(max = 128)
                    String agentId,
            @JsonProperty("agent_revision") @Size(max = 128)
                    String agentRevision,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata,
            Boolean stream,
            JsonNode workspace) {
    }

    public record SessionEventRequest(@NotBlank String type,
            @Size(max = 100) List<@Valid InputBlock> input,
            @JsonProperty("turn_id") String turnId) {
    }

    public record UpdateSessionRequest(
            @NotBlank @Size(max = 256) String title) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CommandAdmission(
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("turn_id") String turnId,
            String status,
            boolean replayed) {
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
            @JsonProperty("session_delete") boolean sessionDelete) {
    }

    public record WebShellSessionCapabilities(boolean tasks, boolean artifacts, boolean actions,
            boolean workspaceTurns, boolean sessionClose, boolean sessionArchive, boolean sessionUnarchive,
            boolean sessionDelete) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicSession(String id, String object,
            @JsonProperty("agent_id") String agentId,
            @JsonProperty("agent_revision") String agentRevision,
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
            @JsonProperty("workspace") PublicWorkspace workspace) {
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
            @JsonProperty("failure_code") String failureCode) {
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

    public record WebShellListRequest(String cursor, Integer limit) {
    }

    public record WebShellSessionRequest(@NotBlank String sessionId) {
    }

    public record WebShellTranscriptRequest(@NotBlank String sessionId,
            String cursor, Integer limit) {
    }

    public record WebShellStreamRequest(@NotBlank String sessionId,
            Long afterSequence) {
    }

    public record WebShellCreateRequest(@Size(max = 128) String requestId,
            @NotBlank String idempotencyKey,
            @NotBlank @Size(max = 128) String agentId,
            String environmentId, String title,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata,
            JsonNode workspace) {
    }

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
            String status, boolean replayed) {
    }

    public record WebShellLifecycleRequest(@NotBlank String sessionId,
            @NotBlank @Size(max = 128) String idempotencyKey) {
    }

    public record ChangeCwdRequest(
            @NotNull @JsonProperty("cwd_relative") String cwdRelative,
            @NotNull @JsonProperty("expected_context_revision")
                    Long expectedContextRevision) {
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

    public record WebShellChangeCwdRequest(
            @Size(max = 128) String requestId,
            @NotBlank String sessionId,
            @NotBlank @Size(max = 128) String idempotencyKey,
            @NotNull String cwdRelative,
            @NotNull Long expectedContextRevision) {
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
            String failureCode) {
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
            String errorCode, Map<String, Object> usage) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellSession(String sessionId, String title,
            String agentId, String status, long createdAt, long updatedAt,
            WebShellTurn activeTurn, Object environment, long lastSequence,
            WebShellWorkspace workspace,
            WebShellSessionCapabilities capabilities) {
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
                    List<String> actionCapabilities) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellTask(String taskId, String sessionId, String kind,
            String state, Long definitionRevision, String runtimeState,
            long createdAt, Long startedAt, Long settledAt,
            String outputCursor,
            List<String> artifactRefs, List<String> actionCapabilities) {
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
            @NotBlank String sessionId, @Size(max = 512) String cursor, Integer limit) {
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

    public record WebShellPage<T>(List<T> data, String nextCursor,
            boolean hasMore) {
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

    public record WebShellTranscript(List<WebShellItem> items,
            List<WebShellEvent> events, long coveredSequence,
            String olderCursor, boolean hasMore, long lastSequence) {
    }

    /**
     * An AgentDefinition revision's content (D8a). The server stores and
     * digests it; no field changes Session execution yet.
     */
    public record AgentDefinitionRequest(
            @NotNull Map<String, Object> model,
            @NotNull @Size(max = 1_000_000) String instructions,
            @NotNull @Size(max = 1000)
                    List<@NotNull Map<String, Object>> tools,
            @Size(max = 1000) List<@NotNull Map<String, Object>> skills,
            @JsonProperty("mcp_servers") @Size(max = 100)
                    List<@NotNull Map<String, Object>> mcpServers,
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
