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
    /**
     * Admits a close, archive or delete, or returns the operation that the
     * same actor already admitted under the key. An archive completes here;
     * a close or delete waits for {@link #completeOperation}.
     */
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

    /** The given Sessions with a completed workspace close, in one read. */
    public Set<String> completedWorkspaceCloses(String tenantId,
            List<String> sessionIds);

    /**
     * Whether the Session's creator-keyed execution facts hold — the
     * Registry still backs the binding exactly, its state is ACTIVE, and
     * the create-command actor keeps OPERATOR or above. This is the
     * passive-attachment subset the execution authority re-verifies, so
     * any admission certifying a run under the creator's grants checks it
     * first.
     */
    public boolean hasExecutionRegistryFacts(String tenantId, String sessionId);

    /** The given Sessions whose execution facts hold, in one read. */
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

    /**
     * Blocks the operation, and when {@code budgetExempt} is true records the
     * attempt as a wait on an external condition (a live journal writer or a
     * stale Harness view) that never consumed the terminal retry budget.
     */
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

    /**
     * Settles a claimed cwd change in one transaction: re-verifies the
     * Session facts, updates the binding directory and context revision,
     * marks the operation completed or failed, and appends
     * {@code session.context.changed} on success.
     *
     * @return the outcome; a contested claim returns {@code null}
     */
    public CwdChangeOutcome completeCwdChangeOperation(String tenantId,
            String sessionId, String operationId, String owner,
            long claimGeneration);

    /**
     * Marks a claimed cwd change terminally failed with its public failure
     * code.
     *
     * @return false when the claim is no longer current — the write was
     *         skipped and the caller must not report a terminal refusal
     */
    public boolean failCwdChangeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode);

    /** The result of a settled cwd change. */
    public record CwdChangeOutcome(boolean completed, String failureCode,
            Long resultContextRevision) {
    }

    /**
     * H4f: admits a public task cancel, or returns the operation the same
     * actor already admitted under the key. The caller has validated the
     * key and checked current access; under the Session lock this replays
     * a retained key first, then — only for a new request — requires an
     * active Session ({@code 409 session_not_active}), the task's
     * {@code cancel} action ({@code 409 task_action_unavailable}) and no
     * other open operation ({@code 409 session_operation_active}).
     */
    public default OperationAdmission beginTaskCancelOperation(String tenantId,
            String sessionId, String taskId, String actorDigest,
            String idempotencyKey, String requestDigest) {
        throw new UnsupportedOperationException("Task cancel is unavailable");
    }

    /** Task cancels due for delivery: pending, or leased past their lease. */
    public default List<OperationTarget> findDeliverableTaskCancels(int limit) {
        return List.of();
    }

    /**
     * Records a leased task cancel's outcome: {@code completed} with a
     * receipt, {@code failed} or {@code recovery_blocked} with its code (the
     * latter parked until {@code retryAt}), only while the claim is still
     * current. A parked cancel is settled only by
     * {@link #settleParkedOperation}.
     *
     * @return false when the claim is no longer current
     */
    public default boolean settleTaskCancel(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            TaskCancelOutcome outcome, long retryAt) {
        throw new UnsupportedOperationException("Task cancel is unavailable");
    }

    /**
     * D7-2: operations parked recovery_blocked because their command's
     * acceptance is unknown, due for reconciliation. No claim ever takes
     * one; only the reconciler reads them.
     */
    public default List<ParkedOperation> findParkedOperations(int limit) {
        return List.of();
    }

    /**
     * D7-2: settles a parked operation from its kind's evidence, only while
     * it is still parked. Committed completes it with a receipt; not
     * committed fails it with the proven code; unknown parks it again until
     * {@code retryAt}.
     *
     * @return false when the operation is no longer parked
     */
    public default boolean settleParkedOperation(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        throw new UnsupportedOperationException(
                "Operation reconciliation is unavailable");
    }

    /**
     * D7-2: what the Session journal proves about a parked Turn input whose
     * submission no Harness answered: committed once the journal holds its
     * prompt's admission, not committed once no writer can still commit it.
     */
    public default AcceptanceVerdict turnInputAcceptance(String tenantId,
            String sessionId, String operationId) {
        return AcceptanceVerdict.unknown();
    }

    /**
     * D7-2: what the Session journal proves about a parked Session title, or
     * empty when its delivery is no longer parked: committed once the journal
     * holds its revision's title, not committed once no writer can still
     * commit it.
     */
    public default Optional<AcceptanceVerdict> renameAcceptance(ParkedOperation parked) {
        return Optional.of(AcceptanceVerdict.unknown());
    }

    /**
     * D7-2: settles a parked Session title, only while it is still parked.
     * Committed completes its command and shows the title; not committed
     * fails it; unknown parks it again until {@code retryAt}.
     *
     * @return false when the title is no longer parked
     */
    public default boolean settleParkedRename(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        throw new UnsupportedOperationException(
                "Operation reconciliation is unavailable");
    }

    /** A task cancel's recorded outcome: its public status and code. */
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

    /**
     * Completes a claimed operation unless another worker claimed it since.
     *
     * @return false when the claim is no longer current
     */
    public boolean completeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            boolean harnessConfirmed);

    /**
     * Binds the Harness boot id of a Session that has no Turn to hang
     * {@link TurnExecutionStore#bindHarness} on — the automation verbs'
     * create of a never-attached Session. Fills the column only when it is
     * still empty, so a Turn that concurrently bound another generation keeps
     * its own binding.
     */
    public void bindSessionHarness(String tenantId, String sessionId,
            String harnessBootId);

    /**
     * Terminates a claimed operation whose retry budget is spent, recording
     * the failure honestly: the operation row goes to FAILED with the
     * failure code kept and delivery_state CONFIRMED so no recovery path
     * re-drives it — and nothing else. The Session keeps its pending status
     * and no completion event is appended, because the settle this operation
     * promised never happened; the receipt the contract requires of every
     * confirmed row certifies nothing.
     *
     * @return false when the claim is no longer current
     */
    public boolean failOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode);

    public void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt);

    /**
     * Retries the operation, and when {@code budgetExempt} is true records
     * the attempt as a wait on an external condition (a live journal writer,
     * a stale Harness view, or the projection lag after the Harness answered
     * an action response) that must not consume the terminal retry budget.
     * The attempt count still grows, so the dispatch backoff keeps
     * stretching.
     */
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

    /**
     * Records that the current attempt reached the Harness (the decision was
     * committed), so a later failure of this attempt stays budget-exempt even
     * when the recovery reads that would reschedule it throw before that
     * write (review round 14, R14-3). The row stays leased; the watermark
     * only makes a re-claimed attempt read budgetExemptAttempt &gt; 0.
     */
    public void markOperationAnswered(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration);
}
