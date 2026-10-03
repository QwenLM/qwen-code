package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.util.List;
import java.util.Map;

public final class StoreModels {
    private StoreModels() {
    }

    public static String inputItemId(String turnId) {
        return "item_" + turnId + "_input";
    }

    public record SessionRecord(String tenantId, String sessionId,
            String agentId, String agentRevision, String title,
            String status, String harnessBootId, String harnessEventEpoch,
            long harnessLastEventId, long lastSequence,
            long replayFloorSequence, long createdAt, long updatedAt,
            Long deletedAt, long version, ContextBinding workspace,
            String toolProfile) {
        public SessionRecord(String tenantId, String sessionId,
                String agentId, String title, String status,
                String harnessBootId, String harnessEventEpoch,
                long harnessLastEventId, long lastSequence, long createdAt,
                long updatedAt, Long deletedAt, long version) {
            this(tenantId, sessionId, agentId, null, title, status,
                    harnessBootId, harnessEventEpoch, harnessLastEventId,
                    lastSequence, 0, createdAt, updatedAt, deletedAt, version,
                    null, null);
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
            long createdAt, int schemaVersion, int projectionVersion,
            String itemId, String contentPartId) {
        public EventRecord(String tenantId, String sessionId, long sequence,
                String eventId, String turnId, String type,
                Map<String, Object> data, boolean terminal, String sourceKey,
                long createdAt) {
            this(tenantId, sessionId, sequence, eventId, turnId, type, data,
                    terminal, sourceKey, createdAt,
                    EventIdentity.SCHEMA_VERSION,
                    EventIdentity.PROJECTION_VERSION, null, null);
        }
    }

    /**
     * Events at or below {@code floorSequence} may be pruned. A client that
     * falls below it reloads the Snapshot, which covers events through
     * {@code snapshotThroughSequence}.
     */
    public record ReplayWindow(long floorSequence,
            long snapshotThroughSequence) {
    }

    public record CommandRecord(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, String sessionStatusBefore,
            long createdAt, long updatedAt) {
    }

    public enum SessionMutationKind {
        RENAME,
        UNARCHIVE
    }

    public record SessionMutationCommand(String sessionId, String status,
            boolean replayed) {
    }

    public record SessionMutation(SessionRecord session, boolean replayed) {
    }

    public enum OperationKind {
        CLOSE,
        ARCHIVE,
        DELETE,
        ACTION_RESPONSE
    }

    /**
     * A durable lifecycle operation. {@code sessionStatusBefore} is the
     * Session status when it was admitted; only an operation admitted on an
     * active Session closes the Harness.
     */
    public record OperationRecord(String tenantId, String sessionId,
            String operationId, OperationKind kind, String requestDigest,
            String state, String admissionStage, String deliveryState,
            String sessionStatusBefore, String receiptId, String leaseOwner,
            long claimGeneration, int attemptCount, String failureCode) {
        public OperationRecord(String tenantId, String sessionId, String operationId, OperationKind kind,
                String requestDigest, String state, String admissionStage, String deliveryState,
                String sessionStatusBefore, String receiptId, String leaseOwner, long claimGeneration, int attemptCount) {
            this(tenantId, sessionId, operationId, kind, requestDigest, state, admissionStage, deliveryState,
                    sessionStatusBefore, receiptId, leaseOwner, claimGeneration, attemptCount, null);
        }
    }

    public record OperationAdmission(OperationRecord operation,
            boolean replayed) {
    }

    public record OperationTarget(String tenantId, String sessionId,
            String operationId) {
    }

    public record Admission(String sessionId, String turnId,
            boolean replayed, boolean commandEffect) {
    }

    public record SessionPage(List<SessionRecord> sessions,
            boolean hasMore) {
    }

    /** The fields of a Turn that its public view shows, without its input. */
    public record TurnSummary(String sessionId, String turnId, String status,
            long createdAt, Long completedAt, String errorCode) {
    }

    public record TurnPage(List<TurnSummary> turns, boolean hasMore) {
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
