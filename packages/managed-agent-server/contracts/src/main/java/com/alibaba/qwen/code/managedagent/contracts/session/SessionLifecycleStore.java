package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutation;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Session lifecycle operations: close/archive/delete, context compression,
 * cwd change, task cancel, parked-operation reconciliation and execution facts.
 */
public interface SessionLifecycleStore {
    public OperationAdmission beginOperation(String tenantId, String sessionId,
            OperationKind kind, String actorDigest, String idempotencyKey,
            String requestDigest);

    public default boolean workspaceFilesEnabled() {
        return false;
    }

    public default boolean workspaceShellEnabled() {
        return false;
    }

    public default OperationAdmission beginWorkspaceClose(String tenantId, String sessionId,
            String actorId, String actorDigest, String key, String digest, boolean supported) {
        throw new UnsupportedOperationException("Workspace close is unavailable");
    }

    public OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key,
            String digest, boolean closeSupported);

    public default OperationAdmission beginChildClose(String tenantId, String parentSessionId,
            String childSessionId, String childRunId, String actorDigest, String key,
            String digest, boolean supported) {
        throw new UnsupportedOperationException("Internal child close is unavailable");
    }

    public default OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorId, String actorDigest, String key, String digest, boolean supported, int protocolVersion) {
        if (protocolVersion != 0) {
            throw new UnsupportedOperationException("Workspace lifecycle protocol is unavailable");
        }
        return beginWorkspaceLifecycle(tenantId, sessionId, kind, actorId, actorDigest, key, digest, supported);
    }

    public boolean hasCompletedWorkspaceClose(String tenantId, String sessionId);

    public Set<String> completedWorkspaceCloses(String tenantId,
            List<String> sessionIds);

    public boolean hasExecutionRegistryFacts(String tenantId, String sessionId);

    public Set<String> sessionsWithExecutionRegistryFacts(String tenantId,
            java.util.Collection<String> sessionIds);

    public SessionMutation unarchiveWorkspaceSession(String tenantId, String sessionId,
            String actorId, String scopedKey, String requestDigest);

    public default boolean renewLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, Duration duration) {
        return false;
    }

    public default void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt) {
        throw new UnsupportedOperationException("Lifecycle reconciliation is unavailable");
    }

    public default void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt,
            boolean budgetExempt) {
        if (budgetExempt) {
            throw new UnsupportedOperationException("Lifecycle reconciliation is unavailable");
        }
        blockLifecycleOperation(tenantId, sessionId, operationId, owner,
                generation, failureCode, availableAt);
    }

    public default OperationAdmission beginContextCompression(String tenantId, String sessionId,
            String actorId, String actorDigest, String key, String digest,
            long expectedCompactionRevision, boolean supported) {
        throw new UnsupportedOperationException("Context compression is unavailable");
    }

    public record ContextCompressionState(long compactionRevision, String operationId, boolean available) {
        public ContextCompressionState(long compactionRevision, String operationId) {
            this(compactionRevision, operationId, true);
        }
    }

    public default ContextCompressionState contextCompressionState(String tenantId, String sessionId) {
        return new ContextCompressionState(0, null);
    }

    public default Map<String, ContextCompressionState> contextCompressionStates(String tenantId, List<String> sessionIds) {
        return Map.of();
    }

    public default Map<String, Object> contextCompressionRequest(String tenantId, String sessionId,
            String operationId) { return Map.of(); }

    public default List<OperationTarget> findContextCompressions(int limit) { return List.of(); }

    public default Optional<OperationRecord> claimContextCompression(String tenantId, String sessionId,
            String operationId, String owner, Duration duration) { return Optional.empty(); }

    public default void requireContextCompressionCommit(String tenantId, String sessionId, String operationId) {}

    public default boolean markContextCompressionSubmitted(OperationRecord operation, String owner) {
        return false;
    }

    public default boolean settleContextCompression(OperationRecord operation, String owner,
            String outcome, Long revision, String failureCode) { return false; }

    public default void retryContextCompressionPreparation(OperationRecord operation, String owner, long retryAt) {}

    public default void awaitContextCompression(OperationRecord operation, String owner,
            boolean acceptanceKnown, String failureCode, long retryAt) {}

    public CwdChangeOutcome completeCwdChangeOperation(String tenantId,
            String sessionId, String operationId, String owner,
            long claimGeneration);

    public boolean failCwdChangeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode);

    public record CwdChangeOutcome(boolean completed, String failureCode,
            Long resultContextRevision) {
    }

    public default OperationAdmission beginTaskCancelOperation(String tenantId,
            String sessionId, String taskId, String actorDigest,
            String idempotencyKey, String requestDigest) {
        throw new UnsupportedOperationException("Task cancel is unavailable");
    }

    public default List<OperationTarget> findDeliverableTaskCancels(int limit) {
        return List.of();
    }

    public default boolean settleTaskCancel(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            TaskCancelOutcome outcome, long retryAt) {
        throw new UnsupportedOperationException("Task cancel is unavailable");
    }

    public default List<ParkedOperation> findParkedOperations(int limit) {
        return List.of();
    }

    public default boolean settleParkedOperation(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        throw new UnsupportedOperationException(
                "Operation reconciliation is unavailable");
    }

    public default AcceptanceVerdict turnInputAcceptance(String tenantId,
            String sessionId, String operationId) {
        return AcceptanceVerdict.unknown();
    }

    public default Optional<AcceptanceVerdict> renameAcceptance(ParkedOperation parked) {
        return Optional.of(AcceptanceVerdict.unknown());
    }

    public default boolean settleParkedRename(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        throw new UnsupportedOperationException(
                "Operation reconciliation is unavailable");
    }

    public record TaskCancelOutcome(String status, String failureCode) {
        public static TaskCancelOutcome completed() {
            return new TaskCancelOutcome("completed", null);
        }

        public static TaskCancelOutcome failed(String failureCode) {
            return new TaskCancelOutcome("failed", failureCode);
        }

        public static TaskCancelOutcome recoveryBlocked(String failureCode) {
            return new TaskCancelOutcome("recovery_blocked", failureCode);
        }
    }

    public Optional<OperationRecord> findOperation(String tenantId,
            String sessionId, String operationId);

    public List<OperationTarget> findDeliverableOperations(long now, int limit);

    public Optional<OperationRecord> claimOperation(String tenantId,
            String sessionId, String operationId, String owner,
            Duration leaseDuration);

    public boolean completeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            boolean harnessConfirmed);

    public boolean failOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode);

    public void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt);

    public default void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt, boolean budgetExempt) {
        if (budgetExempt) {
            throw new UnsupportedOperationException(
                    "Budget-exempt retry is unavailable");
        }
        retryOperation(tenantId, sessionId, operationId, owner,
                claimGeneration, availableAt);
    }

    public void markOperationAnswered(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration);
}
