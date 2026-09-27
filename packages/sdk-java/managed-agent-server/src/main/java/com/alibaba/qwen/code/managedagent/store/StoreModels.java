package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.util.List;
import java.util.Map;

public final class StoreModels {
    private StoreModels() {
    }

    public record SessionRecord(String tenantId, String sessionId,
            String agentId, String title, String status,
            String harnessBootId, String harnessEventEpoch,
            long harnessLastEventId, long lastSequence, long createdAt,
            long updatedAt, Long deletedAt, long version,
            ContextBinding workspace) {
        public SessionRecord(String tenantId, String sessionId,
                String agentId, String title, String status,
                String harnessBootId, String harnessEventEpoch,
                long harnessLastEventId, long lastSequence, long createdAt,
                long updatedAt, Long deletedAt, long version) {
            this(tenantId, sessionId, agentId, title, status, harnessBootId,
                    harnessEventEpoch, harnessLastEventId, lastSequence,
                    createdAt, updatedAt, deletedAt, version, null);
        }
    }

    public record TurnRecord(String tenantId, String sessionId,
            String turnId, String promptId,
            List<Map<String, Object>> input, String payloadDigest,
            String status, boolean submissionAttempted,
            String harnessEventEpoch,
            Long harnessLastEventId, String dispatchOwner,
            Long dispatchLeaseUntil, int retryCount, Long retryAfter,
            String errorCode, String errorMessage, long createdAt,
            long updatedAt, Long completedAt, long version) {
    }

    public record EventRecord(String tenantId, String sessionId,
            long sequence, String eventId, String turnId, String type,
            Map<String, Object> data, boolean terminal, String sourceKey,
            long createdAt) {
    }

    public record CommandRecord(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, String sessionStatusBefore,
            long createdAt, long updatedAt) {
    }

    public enum SessionMutationKind {
        RENAME,
        ARCHIVE,
        UNARCHIVE,
        DELETE
    }

    public record SessionMutationCommand(String sessionId, String status,
            String sessionStatusBefore, boolean replayed) {
    }

    public record Admission(String sessionId, String turnId,
            boolean replayed, boolean commandEffect) {
    }

    public record SessionPage(List<SessionRecord> sessions,
            boolean hasMore) {
    }

    public record EventPage(List<EventRecord> events, boolean hasMore) {
    }

    public record ItemPartRecord(String partId, String type, String text,
            long firstSequence, long lastSequence, long createdAt,
            long updatedAt, long revision) {
    }

    public record ItemRecord(String tenantId, String sessionId,
            String itemId, String turnId, String type, String role,
            String status, Map<String, Object> attributes,
            long firstSequence, long lastSequence, long createdAt,
            long updatedAt, long revision, List<ItemPartRecord> content) {
    }

    public record SnapshotRecord(String tenantId, String sessionId,
            long version, long coveredSequence, List<ItemRecord> items,
            long createdAt, long updatedAt) {
    }

    public record MaterializationTarget(String tenantId, String sessionId) {
    }

    public record MaterializationResult(boolean advanced,
            long coveredSequence) {
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
