package com.alibaba.qwen.code.managedagent.contracts.sidequery;

import java.util.List;
import java.util.Map;

public final class ManagedSideQueryModels {
    public static final String PROCESSING_VERSION = "side-query/1";
    public static final long DEADLINE_MILLIS = 300_000;

    private ManagedSideQueryModels() {}

    public record Create(String kind, String trigger, String question,
            String idempotencyKey, String expectedContentVersion,
            Long expectedMainInputBoundary) {}

    public record Prefix(long journalRevision, long committedSequence,
            String lastCommitDigest, long completedTurnSequence,
            String contentVersion, long completedUserTurnCount,
            long mainInputBoundary) {}

    public record Context(String actorScopeKey, String contentVersion,
            long completedUserTurnCount, long mainInputBoundary,
            boolean automaticEligible, boolean generationAvailable,
            String unavailableReason, String latestRecapContentVersion,
            Long latestRecapUserTurnCount) {}

    public record Query(String queryId, String sessionId, String kind,
            String trigger, String question, String status, String outcome,
            Prefix source, long resultRevision, String text,
            Map<String, Object> usage, String errorCode,
            long createdAt, long updatedAt, long deadlineAt) {
        public boolean terminal() {
            return !"preparing".equals(status) && !"running".equals(status);
        }
    }

    public record Admission(Query query, boolean replayed, boolean dispatch) {}
    public record Page(List<Query> items, String nextCursor) {}
    public record Claim(String instanceId, String bootId, long generation, String token) {}
    public record Pair(String question, String text) {}
    public record FrozenInput(String queryId, String tenantId, String sessionId, String workspaceId,
            String kind, String question, Prefix source, List<Pair> privateHistory,
            String processingVersion, String modelConfigDigest, long deadlineAt,
            String inputResourceId, String inputDigest) {}
    public record InputPublication(String resourceId, String digest, List<String> resourceIds) {}
    public record ResultUpdate(String status, String outcome, String text,
            Map<String, Object> usage, String errorCode) {}
}
