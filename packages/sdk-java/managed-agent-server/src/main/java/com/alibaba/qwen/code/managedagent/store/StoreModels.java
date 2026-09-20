package com.alibaba.qwen.code.managedagent.store;

import java.util.List;
import java.util.Map;

public final class StoreModels {
    private StoreModels() {
    }

    public record SessionRecord(String tenantId, String sessionId,
            String agentId, String title, String status,
            String harnessBootId, String harnessEventEpoch,
            long harnessLastEventId, long lastSequence, long createdAt,
            long updatedAt, long version) {
    }

    public record TurnRecord(String tenantId, String sessionId,
            String turnId, String promptId,
            List<Map<String, Object>> input, String payloadDigest,
            String status, boolean submissionAttempted,
            String harnessEventEpoch,
            Long harnessLastEventId, String dispatchOwner,
            Long dispatchLeaseUntil, String errorCode, String errorMessage,
            long createdAt, long updatedAt, Long completedAt, long version) {
    }

    public record EventRecord(String tenantId, String sessionId,
            long sequence, String eventId, String turnId, String type,
            Map<String, Object> data, boolean terminal, String sourceKey,
            long createdAt) {
    }

    public record CommandRecord(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, long createdAt) {
    }

    public record Admission(String sessionId, String turnId,
            boolean replayed, boolean commandEffect) {
    }

    public record SessionPage(List<SessionRecord> sessions,
            boolean hasMore) {
    }

    public record EventPage(List<EventRecord> events, boolean hasMore) {
    }

    public record DispatchTarget(String tenantId, String sessionId,
            String turnId) {
    }

    public record ProjectedEvent(String type, Map<String, Object> data,
            boolean terminal, String terminalStatus, String errorCode,
            String errorMessage) {
    }

    public record HarnessEvent(long sourceId, String sourceKey,
            ProjectedEvent projection) {
    }
}
