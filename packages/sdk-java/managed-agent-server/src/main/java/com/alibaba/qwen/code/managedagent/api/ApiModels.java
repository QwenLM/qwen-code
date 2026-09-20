package com.alibaba.qwen.code.managedagent.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;

public final class ApiModels {
    private ApiModels() {
    }

    public record InputBlock(@NotBlank String type,
            @NotBlank @Size(max = 1_000_000) String text) {
    }

    public record CreateSessionRequest(
            @JsonProperty("agent_id") @NotBlank @Size(max = 128)
                    String agentId,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata,
            Boolean stream) {
    }

    public record SessionEventRequest(@NotBlank String type,
            @Size(max = 100) List<@Valid InputBlock> input,
            @JsonProperty("turn_id") String turnId) {
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
            String status,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("completed_at") Long completedAt,
            @JsonProperty("error_code") String errorCode) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicSession(String id, String object,
            @JsonProperty("agent_id") String agentId,
            String status,
            @JsonProperty("created_at") long createdAt,
            @JsonProperty("updated_at") long updatedAt,
            Map<String, Object> metadata,
            @JsonProperty("active_turn") PublicTurn activeTurn,
            @JsonProperty("last_event_id") long lastEventId) {
    }

    public record PublicList<T>(String object, List<T> data,
            @JsonProperty("has_more") boolean hasMore,
            @JsonProperty("next_cursor") String nextCursor) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicEvent(@JsonProperty("sequence") long sequence,
            @JsonProperty("event_id") String eventId,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("turn_id") String turnId,
            String type,
            @JsonProperty("created_at") long createdAt,
            Map<String, Object> data,
            boolean terminal) {
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
            Long afterSequence, Integer limit) {
    }

    public record WebShellCreateRequest(String requestId,
            @NotBlank String idempotencyKey,
            @NotBlank @Size(max = 128) String agentId,
            String environmentId, String title,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata) {
    }

    public record WebShellSubmitRequest(String requestId,
            @NotBlank String idempotencyKey, @NotBlank String sessionId,
            @Size(max = 100) List<@Valid InputBlock> input,
            Map<String, Object> metadata) {
    }

    public record WebShellCancelRequest(String requestId,
            @NotBlank String idempotencyKey, @NotBlank String sessionId,
            @NotBlank String turnId) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellAdmission(String sessionId, String turnId,
            String status, boolean replayed) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellTurn(String turnId, String sessionId,
            String status, long submittedAt, Long completedAt,
            String errorCode, Map<String, Object> usage) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellSession(String sessionId, String title,
            String agentId, String status, long createdAt, long updatedAt,
            WebShellTurn activeTurn, Object environment, long lastSequence) {
    }

    public record WebShellPage<T>(List<T> data, String nextCursor,
            boolean hasMore) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WebShellEvent(long sequence, String eventId,
            String sessionId, String turnId, String type, long createdAt,
            Map<String, Object> data, boolean terminal) {
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
}
