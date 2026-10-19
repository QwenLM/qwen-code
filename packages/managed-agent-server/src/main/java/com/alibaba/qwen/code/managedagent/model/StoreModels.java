package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.persistence.EventIdentity;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.Arrays;
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
            String approvalMode, String toolProfile,
            String agentDefinitionDigest) {
        public SessionRecord(String tenantId, String sessionId,
                String agentId, String agentRevision, String title,
                String status, String harnessBootId, String harnessEventEpoch,
                long harnessLastEventId, long lastSequence,
                long replayFloorSequence, long createdAt, long updatedAt,
                Long deletedAt, long version, ContextBinding workspace,
                String approvalMode, String toolProfile) {
            this(tenantId, sessionId, agentId, agentRevision, title, status,
                    harnessBootId, harnessEventEpoch, harnessLastEventId,
                    lastSequence, replayFloorSequence, createdAt, updatedAt,
                    deletedAt, version, workspace, approvalMode, toolProfile,
                    null);
        }
        public SessionRecord(String tenantId, String sessionId,
                String agentId, String title, String status,
                String harnessBootId, String harnessEventEpoch,
                long harnessLastEventId, long lastSequence, long createdAt,
                long updatedAt, Long deletedAt, long version) {
            this(tenantId, sessionId, agentId, null, title, status,
                    harnessBootId, harnessEventEpoch, harnessLastEventId,
                    lastSequence, 0, createdAt, updatedAt, deletedAt, version,
                    null, "yolo", null, null);
        }

        public SessionRecord withStatus(String value) {
            return new SessionRecord(tenantId, sessionId, agentId,
                    agentRevision, title, value, harnessBootId,
                    harnessEventEpoch, harnessLastEventId, lastSequence,
                    replayFloorSequence, createdAt, updatedAt, deletedAt,
                    version, workspace, approvalMode, toolProfile,
                    agentDefinitionDigest);
        }
    }

    public record TurnRecord(String tenantId, String sessionId,
            String turnId, String promptId,
            List<Map<String, Object>> input, String payloadDigest,
            String status, boolean submissionAttempted,
            String harnessEventEpoch,
            Long harnessLastEventId, String dispatchOwner,
            Long dispatchLeaseUntil, int retryCount, int consecutiveFailures,
            int budgetExemptFailures, Long retryAfter, String errorCode,
            String errorMessage,
            long createdAt, long updatedAt, Long completedAt,
            long version) {
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
     * {@code snapshotThroughSequence}. A stream reconciliation discards the
     * Snapshot without lowering the floor, so the floor can exceed the
     * coverage while the Items rebuild; the cursor is still served then.
     */
    public record ReplayWindow(long floorSequence,
            long snapshotThroughSequence) {
    }

    public record CommandRecord(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String status, String sessionStatusBefore,
            byte[] actorKey, long createdAt, long updatedAt) {
        /**
         * The recorder half of every command replay gate. A receipt this
         * build writes names its recorder or carries
         * {@code ManagedReceipts.UNATTRIBUTED}, which no actor key equals;
         * only a receipt recorded before the stamp existed reads back NULL.
         * Its recorder was never stored, so it keeps the role-gated replay
         * it was recorded under rather than answering only the creator. A
         * caller without an actor id never passes, so it stays on the
         * creator gate.
         */
        public boolean admitsReplayBy(String actorId) {
            if (actorId == null) {
                return false;
            }
            if (actorKey == null) {
                return true;
            }
            try {
                return Arrays.equals(actorKey,
                        ManagedWorkspaceRegistry.actorKey(tenantId, actorId));
            } catch (IllegalArgumentException error) {
                return false;
            }
        }
    }

    /**
     * H4b: a child Session's ancestry (V54). v1 children run at depth 1;
     * the tree root for a first-level child is the parent Session itself.
     */
    public record SessionLineage(String parentSessionId, String rootSessionId,
            String parentChildRunId, int depth) {
    }

    public enum SessionMutationKind {
        RENAME,
        UNARCHIVE
    }

    public record SessionMutationCommand(String sessionId, String status,
            boolean replayed, long renameRevision) {
        public SessionMutationCommand(String sessionId, String status, boolean replayed) {
            this(sessionId, status, replayed, 0);
        }
    }

    public record RenameDelivery(String tenantId, String sessionId,
            String idempotencyKey, String title, long revision, int attemptCount, long claimGeneration) {
        public RenameDelivery(String tenantId, String sessionId, String idempotencyKey, String title, long revision, int attemptCount) {
            this(tenantId, sessionId, idempotencyKey, title, revision, attemptCount, 0);
        }
    }

    public record SessionMutation(SessionRecord session, boolean replayed) {
    }

    public enum OperationKind {
        CLOSE,
        ARCHIVE,
        DELETE,
        ACTION_RESPONSE,
        CWD_CHANGE,
        TASK_CANCEL,
        SUBMIT_INPUT,
        CANCEL
    }

    /**
     * A durable lifecycle operation. {@code sessionStatusBefore} is the
     * Session status when it was admitted; only an operation admitted on an
     * active Session closes the Harness. The cwd fields, {@code taskId} and
     * {@code failureCode} are set only for the kinds that populate
     * them. {@code budgetExemptAttempt} counts the attempts that never
     * consumed the terminal retry budget:
     * failures that waited on an external condition (a live journal
     * writer, or Java's stale view of a restarted Harness) and, for
     * an action response, every attempt once the Harness has
     * answered — the decision is committed then and only Java's
     * projection lag remains.
     */
    public record OperationRecord(String tenantId, String sessionId,
            String operationId, OperationKind kind, String requestDigest,
            String state, String admissionStage, String deliveryState,
            String sessionStatusBefore, String receiptId, String leaseOwner,
            long claimGeneration, int attemptCount, String targetCwdRelative,
            Long expectedContextRevision, Long resultContextRevision,
            String failureCode, int budgetExemptAttempt,
            int lifecycleProtocolVersion, byte[] actorKey, String taskId) {
        public OperationRecord(String tenantId, String sessionId, String operationId, OperationKind kind,
                String requestDigest, String state, String admissionStage, String deliveryState,
                String sessionStatusBefore, String receiptId, String leaseOwner, long claimGeneration,
                int attemptCount, String targetCwdRelative, Long expectedContextRevision,
                Long resultContextRevision, String failureCode, int lifecycleProtocolVersion, byte[] actorKey) {
            this(tenantId, sessionId, operationId, kind, requestDigest, state, admissionStage, deliveryState,
                    sessionStatusBefore, receiptId, leaseOwner, claimGeneration, attemptCount, targetCwdRelative,
                    expectedContextRevision, resultContextRevision, failureCode, 0, lifecycleProtocolVersion,
                    actorKey, null);
        }

        public OperationRecord(String tenantId, String sessionId, String operationId, OperationKind kind,
                String requestDigest, String state, String admissionStage, String deliveryState, String sessionStatusBefore,
                String receiptId, String leaseOwner, long claimGeneration, int attemptCount, String targetCwdRelative,
                Long expectedContextRevision, Long resultContextRevision, String failureCode) {
            this(tenantId, sessionId, operationId, kind, requestDigest, state, admissionStage, deliveryState,
                    sessionStatusBefore, receiptId, leaseOwner, claimGeneration, attemptCount, targetCwdRelative,
                    expectedContextRevision, resultContextRevision, failureCode, 0, 0, null, null);
        }

        public OperationRecord(String tenantId, String sessionId, String operationId, OperationKind kind,
                String requestDigest, String state, String admissionStage, String deliveryState, String sessionStatusBefore,
                String receiptId, String leaseOwner, long claimGeneration, int attemptCount, String failureCode,
                int lifecycleProtocolVersion) {
            this(tenantId, sessionId, operationId, kind, requestDigest, state, admissionStage, deliveryState,
                    sessionStatusBefore, receiptId, leaseOwner, claimGeneration, attemptCount, null, null, null,
                    failureCode, 0, lifecycleProtocolVersion, null, null);
        }

        public OperationRecord(String tenantId, String sessionId, String operationId, OperationKind kind,
                String requestDigest, String state, String admissionStage, String deliveryState, String sessionStatusBefore,
                String receiptId, String leaseOwner, long claimGeneration, int attemptCount, String failureCode) {
            this(tenantId, sessionId, operationId, kind, requestDigest, state, admissionStage, deliveryState,
                    sessionStatusBefore, receiptId, leaseOwner, claimGeneration, attemptCount, failureCode, 0);
        }

        public OperationRecord(String tenantId, String sessionId, String operationId, OperationKind kind,
                String requestDigest, String state, String admissionStage, String deliveryState,
                String sessionStatusBefore, String receiptId, String leaseOwner, long claimGeneration, int attemptCount) {
            this(tenantId, sessionId, operationId, kind, requestDigest, state, admissionStage, deliveryState,
                    sessionStatusBefore, receiptId, leaseOwner, claimGeneration, attemptCount, null, 0);
        }
    }

    public record OperationAdmission(OperationRecord operation,
            boolean replayed) {
    }

    public record OperationTarget(String tenantId, String sessionId,
            String operationId) {
    }

    /**
     * D7-2: an operation parked recovery_blocked because its command's
     * acceptance is unknown, due for reconciliation from its kind's evidence.
     * The kind is the stored operation kind; sessionId is null for a kind that
     * belongs to no Session.
     */
    public record ParkedOperation(String tenantId, String sessionId,
            String operationId, String kind) {
    }

    /** What an operation's own keyed evidence proves about its command. */
    public enum Acceptance {
        COMMITTED,
        NOT_COMMITTED,
        UNKNOWN
    }

    /**
     * An evidence verdict. A not-committed one names the failure the evidence
     * proves; an unknown one leaves the operation parked.
     */
    public record AcceptanceVerdict(Acceptance acceptance,
            String failureCode) {
        public static AcceptanceVerdict committed() {
            return new AcceptanceVerdict(Acceptance.COMMITTED, null);
        }

        public static AcceptanceVerdict notCommitted(String failureCode) {
            return new AcceptanceVerdict(Acceptance.NOT_COMMITTED,
                    failureCode);
        }

        public static AcceptanceVerdict unknown() {
            return new AcceptanceVerdict(Acceptance.UNKNOWN, null);
        }
    }

    /**
     * {@code operationId} names the durable operation of a Turn input or
     * cancel command (D7-1); it is null for every other command and for a
     * command recorded before the operation existed.
     */
    public record Admission(String sessionId, String turnId,
            boolean replayed, boolean commandEffect, String operationId) {
        public Admission(String sessionId, String turnId, boolean replayed,
                boolean commandEffect) {
            this(sessionId, turnId, replayed, commandEffect, null);
        }
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

    public record SnapshotPage(List<ItemRecord> items, boolean hasMore, String nextCursor, long coveredSequence) {}

    public record SnapshotRecord(String tenantId, String sessionId,
            long version, long coveredSequence, List<ItemRecord> items,
            long createdAt, long updatedAt) {
    }

    public record MaterializationTarget(String tenantId, String sessionId) {
    }

    public record MaterializationResult(boolean advanced,
            long coveredSequence) {
    }

    /** A Session whose Snapshot covers more than its replay floor. */
    public record ReplayFloorTarget(String tenantId, String sessionId) {
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
