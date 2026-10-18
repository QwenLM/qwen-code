package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutation;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnSummary;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

public interface AgentStateStore {
    /**
     * #14387: the durable error code a workflow Turn carries once its
     * recovery was refused — the Harness generation running it was lost
     * and its deterministic in-process work must never be re-executed
     * while the first run's outcome stays unwitnessed. The Turn is never
     * settled: the code stays on the active row for the child result
     * relay to classify the record blocked from, and the dispatch sweep
     * parks the row (a cancel still scans it — settling the Turn
     * cancelled is the cancel's own act).
     */
    String WORKFLOW_RECOVERY_BLOCKED = "hosted_workflow_recovery_blocked";

    // The annotation must sit on the default itself: the delegating body runs
    // on the target instance, so without it the self-call bypasses the proxy.
    @org.springframework.transaction.annotation.Transactional
    default Admission insertSessionCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return insertSessionCommand(tenantId, null, operation,
                idempotencyKey, requestDigest, agentId, requestedRevision,
                title, input, payloadDigest);
    }

    Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest);

    /**
     * H4b: creates a child Session under its parent's exact binding,
     * stamping the lineage in the same transaction. The idempotency key
     * derives from the parent's committed launch, so a replay returns the
     * original admission and never mints a second Session. The caller is
     * the control plane (the relay), so this path deliberately skips the
     * public actor/workspace checks — the parent's row carries them.
     */
    default StoreModels.Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    /**
     * The isolation slice (#13753 I1): the same creation, bound to the
     * child run's ready child Workspace. The child's row takes the
     * Workspace's directory instead of the parent's; the creating
     * transaction locks the Workspace row and refuses unless it is ready,
     * unfinished, prepared from the parent's current Workspace and storage,
     * and names {@code childCwdRelative}.
     */
    default StoreModels.Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    /**
     * The child directory a child run's Workspace recorded, or null before
     * its layout was recorded. Readiness is the creating transaction's to
     * check, so a replay still answers once the Workspace moved on.
     */
    default String findChildWorkspaceCwd(String tenantId,
            String parentSessionId, String childRunId) {
        return null;
    }

    /** The replay of {@link #insertChildSessionCommand}: same key and
     * digest answers the original admission; either mismatch conflicts. */
    default StoreModels.Admission replayChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    /** A child Session's persisted lineage, or null for a root Session. */
    default StoreModels.SessionLineage findChildLineage(String tenantId,
            String sessionId) {
        return null;
    }

    Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection);

    Optional<Admission> findWorkspaceCreateReplay(String tenantId,
            String actorId, String idempotencyKey, String requestDigest);

    @org.springframework.transaction.annotation.Transactional
    default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection, String approvalMode) {
        if (approvalMode != null) {
            throw new UnsupportedOperationException("Approval mode selection is unavailable");
        }
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest, selection);
    }

    @org.springframework.transaction.annotation.Transactional
    default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title, List<Map<String, Object>> input,
            String payloadDigest, WorkspaceSelection selection, String approvalMode,
            boolean approvalSelectionSupported) {
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest,
                selection, approvalMode);
    }

    default WebShellSessionOptions workspaceSessionOptions(
            String tenantId, String agentId) {
        throw new UnsupportedOperationException("Approval mode selection is unavailable");
    }

    @org.springframework.transaction.annotation.Transactional
    default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId, String requestedRevision,
            String title, List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection, String approvalMode, boolean approvalSelectionSupported,
            Boolean planMode, boolean planModeSupported) {
        if (Boolean.TRUE.equals(planMode)) {
            throw new UnsupportedOperationException("Plan mode is unavailable");
        }
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest,
                agentId, requestedRevision, title, input, payloadDigest, selection,
                approvalMode, approvalSelectionSupported);
    }

    Admission replayWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest);

    Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest);

    /**
     * The actor-carrying variant records the caller on the command receipt,
     * so the receipt's replay answers the actor who recorded it — an
     * OPERATOR's own retry of his own key — and not only the creator. The
     * default drops the actor for implementations that cannot record it.
     */
    default Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            String actorId) {
        return insertTurnCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, input, payloadDigest);
    }

    Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId);

    /** The actor-carrying twin of {@link #insertTurnCommand}. */
    default Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String actorId) {
        return insertCancelCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, turnId);
    }

    SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind);

    /** The actor-carrying twin of {@link #insertTurnCommand}. */
    default SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId) {
        return beginSessionMutation(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, kind);
    }

    SessionMutationCommand beginSessionRename(String tenantId, String idempotencyKey,
            String requestDigest, String sessionId, String title);

    /** The actor-carrying twin: the recorded rename answers its recorder. */
    default SessionMutationCommand beginSessionRename(String tenantId,
            String idempotencyKey, String requestDigest, String sessionId,
            String title, String actorId) {
        return beginSessionRename(tenantId, idempotencyKey, requestDigest,
                sessionId, title);
    }

    SessionRecord completeSessionRename(String tenantId, String idempotencyKey,
            String sessionId, String title, String harnessBootId, long revision);

    SessionRecord completeSessionRename(StoreModels.RenameDelivery delivery, String owner, String bootId);

    void abandonSessionRename(String tenantId, String idempotencyKey,
            String sessionId, long revision, String owner);

    List<StoreModels.RenameDelivery> deliverableRenames(long now);

    Optional<StoreModels.RenameDelivery> claimRename(StoreModels.RenameDelivery delivery,
            String owner, Duration lease);

    void markRenameSubmitted(StoreModels.RenameDelivery delivery, String owner);

    void retryRename(StoreModels.RenameDelivery delivery, String owner, long availableAt);

    SessionRecord completeSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId);

    /**
     * Retires the command row of a Session mutation the Harness refused
     * before completion, so the refusal does not leave the Session's
     * later lifecycle changes blocked by a {@code PENDING} row nothing
     * completes. The receipt and digest survive for same-content retries
     * and concurrent completion; completed outcomes remain replayable.
     */
    void abandonSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId);

    /**
     * Admits a close, archive or delete, or returns the operation that the
     * same actor already admitted under the key. An archive completes here;
     * a close or delete waits for {@link #completeOperation}.
     */
    OperationAdmission beginOperation(String tenantId, String sessionId,
            OperationKind kind, String actorDigest, String idempotencyKey,
            String requestDigest);

    default boolean workspaceFilesEnabled() {
        return false;
    }

    default boolean workspaceShellEnabled() {
        return false;
    }

    default OperationAdmission beginWorkspaceClose(String tenantId, String sessionId,
            String actorId, String actorDigest, String key, String digest, boolean supported) {
        throw new UnsupportedOperationException("Workspace close is unavailable");
    }

    OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key,
            String digest, boolean closeSupported);

    default OperationAdmission beginChildClose(String tenantId, String parentSessionId,
            String childSessionId, String childRunId, String actorDigest, String key,
            String digest, boolean supported) {
        throw new UnsupportedOperationException("Internal child close is unavailable");
    }

    default OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId, OperationKind kind,
            String actorId, String actorDigest, String key, String digest, boolean supported, int protocolVersion) {
        if (protocolVersion != 0) {
            throw new UnsupportedOperationException("Workspace lifecycle protocol is unavailable");
        }
        return beginWorkspaceLifecycle(tenantId, sessionId, kind, actorId, actorDigest, key, digest, supported);
    }

    boolean hasCompletedWorkspaceClose(String tenantId, String sessionId);

    /** The given Sessions with a completed workspace close, in one read. */
    Set<String> completedWorkspaceCloses(String tenantId,
            List<String> sessionIds);

    /**
     * Whether the Session's creator-keyed execution facts hold — the
     * Registry still backs the binding exactly, its state is ACTIVE, and
     * the create-command actor keeps OPERATOR or above. This is the
     * passive-attachment subset the execution authority re-verifies, so
     * any admission certifying a run under the creator's grants checks it
     * first.
     */
    boolean hasExecutionRegistryFacts(String tenantId, String sessionId);

    /** The given Sessions whose execution facts hold, in one read. */
    Set<String> sessionsWithExecutionRegistryFacts(String tenantId,
            java.util.Collection<String> sessionIds);

    SessionMutation unarchiveWorkspaceSession(String tenantId, String sessionId,
            String actorId, String scopedKey, String requestDigest);

    default boolean renewLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, Duration duration) {
        return false;
    }

    default void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt) {
        throw new UnsupportedOperationException("Lifecycle reconciliation is unavailable");
    }

    /**
     * Blocks the operation, and when {@code budgetExempt} is true records the
     * attempt as a wait on an external condition (a live journal writer or a
     * stale Harness view) that never consumed the terminal retry budget.
     */
    default void blockLifecycleOperation(String tenantId, String sessionId, String operationId,
            String owner, long generation, String failureCode, long availableAt,
            boolean budgetExempt) {
        if (budgetExempt) {
            throw new UnsupportedOperationException("Lifecycle reconciliation is unavailable");
        }
        blockLifecycleOperation(tenantId, sessionId, operationId, owner,
                generation, failureCode, availableAt);
    }

    /**
     * Admits a controlled same-Workspace cwd change (W2) on a bound Session,
     * or returns the operation the same actor already admitted under the
     * key. The target directory is already normalized and the request digest
     * already covers it; admission checks the read grant, replays under the
     * key, then the caller's Workspace role, the deployment gate, the
     * Session state, the creator-keyed Registry facts, the expected context
     * revision and the busy barriers in the pinned order.
     */
    OperationAdmission beginCwdChangeOperation(String tenantId,
            String sessionId, String actorId, String actorDigest,
            String idempotencyKey, String requestDigest,
            String targetCwdRelative, long expectedContextRevision);

    /**
     * Settles a claimed cwd change in one transaction: re-verifies the
     * Session facts, updates the binding directory and context revision,
     * marks the operation completed or failed, and appends
     * {@code session.context.changed} on success.
     *
     * @return the outcome; a contested claim returns {@code null}
     */
    CwdChangeOutcome completeCwdChangeOperation(String tenantId,
            String sessionId, String operationId, String owner,
            long claimGeneration);

    /**
     * Marks a claimed cwd change terminally failed with its public failure
     * code.
     *
     * @return false when the claim is no longer current — the write was
     *         skipped and the caller must not report a terminal refusal
     */
    boolean failCwdChangeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode);

    /** The result of a settled cwd change. */
    record CwdChangeOutcome(boolean completed, String failureCode,
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
    default OperationAdmission beginTaskCancelOperation(String tenantId,
            String sessionId, String taskId, String actorDigest,
            String idempotencyKey, String requestDigest) {
        throw new UnsupportedOperationException("Task cancel is unavailable");
    }

    /** Task cancels due for delivery: pending, or leased past their lease. */
    default List<OperationTarget> findDeliverableTaskCancels(int limit) {
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
    default boolean settleTaskCancel(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            TaskCancelOutcome outcome, long retryAt) {
        throw new UnsupportedOperationException("Task cancel is unavailable");
    }

    /**
     * D7-2: operations parked recovery_blocked because their command's
     * acceptance is unknown, due for reconciliation. No claim ever takes
     * one; only the reconciler reads them.
     */
    default List<ParkedOperation> findParkedOperations(int limit) {
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
    default boolean settleParkedOperation(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        throw new UnsupportedOperationException(
                "Operation reconciliation is unavailable");
    }

    /**
     * D7-2: what the Session journal proves about a parked Turn input whose
     * submission no Harness answered: committed once the journal holds its
     * prompt's admission, not committed once no writer can still commit it.
     */
    default AcceptanceVerdict turnInputAcceptance(String tenantId,
            String sessionId, String operationId) {
        return AcceptanceVerdict.unknown();
    }

    /**
     * D7-2: what the Session journal proves about a parked Session title, or
     * empty when its delivery is no longer parked: committed once the journal
     * holds its revision's title, not committed once no writer can still
     * commit it.
     */
    default Optional<AcceptanceVerdict> renameAcceptance(ParkedOperation parked) {
        return Optional.of(AcceptanceVerdict.unknown());
    }

    /**
     * D7-2: settles a parked Session title, only while it is still parked.
     * Committed completes its command and shows the title; not committed
     * fails it; unknown parks it again until {@code retryAt}.
     *
     * @return false when the title is no longer parked
     */
    default boolean settleParkedRename(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        throw new UnsupportedOperationException(
                "Operation reconciliation is unavailable");
    }

    /** A task cancel's recorded outcome: its public status and code. */
    record TaskCancelOutcome(String status, String failureCode) {
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

    Optional<OperationRecord> findOperation(String tenantId,
            String sessionId, String operationId);

    List<OperationTarget> findDeliverableOperations(long now, int limit);

    Optional<OperationRecord> claimOperation(String tenantId,
            String sessionId, String operationId, String owner,
            Duration leaseDuration);

    /**
     * Completes a claimed operation unless another worker claimed it since.
     *
     * @return false when the claim is no longer current
     */
    boolean completeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            boolean harnessConfirmed);

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
    boolean failOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode);

    void retryOperation(String tenantId, String sessionId,
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
    default void retryOperation(String tenantId, String sessionId,
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
    void markOperationAnswered(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration);

    Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest);

    Optional<CommandRecord> findCommand(String tenantId, String operation,
            String idempotencyKey);

    Optional<SessionRecord> findSessionById(String sessionId);

    SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt,
            String beforeSessionId, int limit);

    Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId);

    /** The active Turn of each given Session, in one round trip. */
    Map<String, TurnSummary> findActiveTurns(String tenantId,
            List<String> sessionIds);

    /** The latest Turn of each given Session, in one round trip. */
    Map<String, TurnSummary> findLatestTurns(String tenantId,
            List<String> sessionIds);

    default Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds) {
        return Map.of();
    }

    default List<WebShellModelOption> modelOptions() { return List.of(); }

    default Map<String, WebShellModelSelection> findModelSelections(
            String tenantId, List<String> sessionIds) { return Map.of(); }

    default WebShellModelChangeResult changeSessionModel(String tenantId, String actorId,
            String sessionId, String key, String digest, String modelId, long expectedRevision,
            boolean supported) {
        throw new UnsupportedOperationException("Model selection is unavailable");
    }

    default Map<String, WebShellApprovalSelection> findApprovalSelections(
            String tenantId, List<String> sessionIds) { return Map.of(); }

    default boolean supportsPlanMode(SessionRecord session) { return false; }

    default Set<String> findApprovalOwners(String tenantId, String actorId,
            List<String> sessionIds) { return Set.of(); }

    default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported) {
        throw new UnsupportedOperationException("Approval selection is unavailable");
    }

    default WebShellApprovalSelection findTurnApprovalSelection(String tenantId, String sessionId,
            String promptId) { return null; }

    default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean planMode, boolean planModeSupported) {
        if (planMode != null) {
            throw new UnsupportedOperationException("Plan mode is unavailable");
        }
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported);
    }

    default WebShellModelSelection findTurnModelSelection(String tenantId, String sessionId,
            String promptId) { return null; }

    /**
     * The latest environment event of each Session's latest Turn, in one
     * round trip.
     */
    Map<String, EventRecord> findLatestEnvironmentEvents(String tenantId,
            Map<String, TurnSummary> latestTurns);

    /**
     * A page of a Session's Turns, newest first: by creation time, then by
     * Turn ID, both descending. A position excludes the Turn it names and
     * every newer one.
     */
    TurnPage listTurns(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTurnId, int limit);

    Optional<TurnSummary> findTurnSummary(String tenantId, String sessionId,
            String turnId);

    List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit);

    List<EventRecord> findControlEvents(String tenantId, String sessionId,
            long throughSequence);

    EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit);

    StoreModels.SnapshotPage findSnapshotPage(String tenantId, String sessionId, String cursor, long afterSequence, int limit);

    Optional<SnapshotRecord> findSnapshot(String tenantId,
            String sessionId);

    /** The snapshot's covered sequence of each given Session, in one read. */
    Map<String, Long> findSnapshotCoveredSequences(String tenantId,
            List<String> sessionIds);

    ReplayWindow findReplayWindow(String tenantId, String sessionId);

    /** The Sessions whose Snapshot covers more than their replay floor. */
    List<ReplayFloorTarget> findReplayFloorTargets(int limit);

    /**
     * Raises the Session's replay floor, never above the Snapshot's covered
     * sequence, so a client told to resync can resume from the Snapshot.
     */
    ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence);

    List<MaterializationTarget> findMaterializationTargets(int limit);

    MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit);

    /**
     * Rotates a stale materialization target behind the fresher ones by
     * touching only {@code gmt_modified} on its progress row — never
     * {@code covered_sequence}, which the gap guard must freeze on failure.
     */
    void deferMaterializationTarget(String tenantId, String sessionId);

    List<DispatchTarget> findDispatchable(long now, int limit);

    Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration);

    boolean renewTurn(String tenantId, String sessionId, String turnId,
            String owner, Duration leaseDuration);

    void releaseTurnLease(String tenantId, String sessionId, String turnId,
            String owner);

    /**
     * #14387: durably marks an active Turn whose recovery was refused —
     * the error code stays on the still-active row for the child result
     * relay to classify from, and the dispatch lease is released so the
     * drive ends without settling the Turn. Never a terminal status: the
     * unwitnessed execution's outcome was never observed.
     */
    boolean markTurnRecoveryBlocked(String tenantId, String sessionId,
            String turnId, String owner, String errorCode,
            String errorMessage);

    void deferTurnRetry(String tenantId, String sessionId, String turnId,
            String owner, long retryAfter);

    void scheduleTurnRetry(String tenantId, String sessionId, String turnId,
            String owner, long retryAfter, boolean budgetExempt);

    boolean bindHarness(String tenantId, String sessionId, String turnId,
            String owner, String harnessBootId);

    boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId);

    void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner);

    boolean withdrawSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner);

    boolean cancelUnadmittedTurn(String tenantId, String sessionId,
            String turnId, String owner);

    void recordAdmission(String tenantId, String sessionId, String turnId,
            String owner, String eventEpoch, long lastEventId);

    void recordRecoveryAdmission(String tenantId, String sessionId,
            String turnId, String owner, String expectedTurnEventEpoch,
            String expectedSessionEventEpoch, String eventEpoch,
            long lastEventId);

    /**
     * Clears non-terminal text from a continuation epoch that did not reach
     * a public terminal event, so the replacement stream is the only copy.
     */
    void retractContinuationOutput(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId,
            String eventEpoch);

    /**
     * Retracts the published text of the in-flight message a restarted model
     * attempt replaces (#13319): deltas of the Turn in the live epoch with a
     * source id at or after {@code fromSourceId} are emptied, projections are
     * rebuilt, and a {@code stream.reconciled} event is appended. The Harness
     * cursor advances past {@code retractionSourceId} either way.
     */
    void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId);

    void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId, String sourceBootId,
            String sourceEventEpoch, Long throughSourceId);

    void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events);

    void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner);

    void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message);

    boolean failRecoveryBlockedTurn(String tenantId, String sessionId,
            String turnId, String owner, String message);

    void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey);

    /**
     * Appends a Session event unless one with the source key exists, when
     * the tenant's Session exists and is neither deleted nor being deleted.
     * The Session is locked before its status is read, so a deletion that
     * commits first is always seen.
     */
    void appendLiveSessionEventIfAbsent(String tenantId, String sessionId,
            String type, Map<String, Object> data, String sourceKey);

    SessionRecord requireSession(String tenantId, String sessionId);

    Optional<String> findLastVisibleStatusBeforeDelete(String tenantId,
            String sessionId);
}
