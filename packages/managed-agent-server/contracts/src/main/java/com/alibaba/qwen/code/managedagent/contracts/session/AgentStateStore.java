package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

public interface AgentStateStore {
    default Optional<SessionRecord> findSession(String tenantId, String sessionId) {
        return findSessionById(sessionId).filter(session -> tenantId.equals(session.tenantId()));
    }

    int SNAPSHOT_REFRESH_EVENTS = 1000;

    public default void failWorktreeInitialTurns(String tenantId, String sessionId, String code) {
        throw new UnsupportedOperationException("Session worktrees are unavailable");
    }

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

    /**
     * D7-2: the durable code a Turn carries while its parked Runtime
     * execution's acceptance is still unknown. The dispatch sweep parks it,
     * and the reconciler re-drives the cancellation load on its RECHECK
     * cadence; the code never settles the Turn by itself. A cancel still
     * scans it — settling the Turn cancelled is the cancel's own act.
     */
    String RUNTIME_RECOVERY_BLOCKED = "hosted_runtime_recovery_blocked";

    String HARNESS_RECOVERY_BLOCKED = "hosted_harness_recovery_blocked";

    public default Admission insertSessionCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return insertSessionCommand(tenantId, null, operation,
                idempotencyKey, requestDigest, agentId, requestedRevision,
                title, input, payloadDigest);
    }

    public Admission insertSessionCommand(String tenantId, String actorId,
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
    public default StoreModels.Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    public default StoreModels.Admission insertPublicChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey, String requestDigest,
            String title, List<Map<String, Object>> input, String payloadDigest,
            StoreModels.SessionLineage lineage, com.fasterxml.jackson.databind.JsonNode snapshot) {
        throw new UnsupportedOperationException("Public child Session creation is unavailable");
    }

    /**
     * The isolation slice (#13753 I1): the same creation, bound to the
     * child run's ready child Workspace. The child's row takes the
     * Workspace's directory instead of the parent's; the creating
     * transaction locks the Workspace row and refuses unless it is ready,
     * unfinished, prepared from the parent's current Workspace and storage,
     * and names {@code childCwdRelative}.
     */
    public default StoreModels.Admission insertChildSessionCommand(String tenantId,
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
    public default String findChildWorkspaceCwd(String tenantId,
            String parentSessionId, String childRunId) {
        return null;
    }

    /** The replay of {@link #insertChildSessionCommand}: same key and
     * digest answers the original admission; either mismatch conflicts. */
    public default StoreModels.Admission replayChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    /** A child Session's persisted lineage, or null for a root Session. */
    public default StoreModels.SessionLineage findChildLineage(String tenantId,
            String sessionId) {
        return null;
    }

    public Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection);

    public Optional<Admission> findWorkspaceCreateReplay(String tenantId,
            String actorId, String idempotencyKey, String requestDigest);

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
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

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title, List<Map<String, Object>> input,
            String payloadDigest, WorkspaceSelection selection, String approvalMode,
            boolean approvalSelectionSupported) {
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest,
                selection, approvalMode);
    }

    public default WebShellSessionOptions workspaceSessionOptions(
            String tenantId, String agentId) {
        throw new UnsupportedOperationException("Approval mode selection is unavailable");
    }

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
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

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId, String requestedRevision,
            String title, List<Map<String, Object>> input, String payloadDigest,
            WorkspaceSelection selection, String approvalMode, boolean approvalSelectionSupported,
            Boolean planMode, boolean planModeSupported, List<Map<String, Object>> skills) {
        if (!skills.isEmpty()) {
            throw new UnsupportedOperationException("Session Skills are unavailable");
        }
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest,
                agentId, requestedRevision, title, input, payloadDigest, selection, approvalMode,
                approvalSelectionSupported, planMode, planModeSupported);
    }

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId, String requestedRevision,
            String title, List<Map<String, Object>> input, String payloadDigest, WorkspaceSelection selection,
            String approvalMode, boolean approvalSelectionSupported, Boolean planMode, boolean planModeSupported,
            List<Map<String, Object>> skills, boolean publicChildrenSupported) {
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest,
                agentId, requestedRevision, title, input, payloadDigest, selection, approvalMode,
                approvalSelectionSupported, planMode, planModeSupported, skills);
    }

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId, String requestedRevision,
            String title, List<Map<String, Object>> input, String payloadDigest, WorkspaceSelection selection,
            String approvalMode, boolean approvalSelectionSupported, Boolean planMode, boolean planModeSupported,
            List<Map<String, Object>> skills, boolean publicChildrenSupported, String modelId) {
        if (modelId != null) {
            throw new UnsupportedOperationException("Initial model selection is unavailable");
        }
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest,
                agentId, requestedRevision, title, input, payloadDigest, selection, approvalMode,
                approvalSelectionSupported, planMode, planModeSupported, skills, publicChildrenSupported);
    }

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId, String requestedRevision,
            String title, List<Map<String, Object>> input, String payloadDigest, WorkspaceSelection selection,
            String approvalMode, boolean approvalSelectionSupported, Boolean planMode, boolean planModeSupported,
            List<Map<String, Object>> skills, boolean publicChildrenSupported, String modelId,
            List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> extensionPins,
            Set<String> extensionLifecycleProfiles) {
        if (extensionPins != null) {
            throw new UnsupportedOperationException("Initial extension selection is unavailable");
        }
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest,
                agentId, requestedRevision, title, input, payloadDigest, selection, approvalMode,
                approvalSelectionSupported, planMode, planModeSupported, skills, publicChildrenSupported, modelId);
    }

    public Admission replayWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest);

    public default Admission insertWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String agentId, String requestedRevision,
            String title, List<Map<String, Object>> input, String payloadDigest, WorkspaceSelection selection,
            String approvalMode, boolean approvalSelectionSupported, Boolean planMode, boolean planModeSupported,
            List<Map<String, Object>> skills, boolean publicChildrenSupported, String modelId,
            List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> extensionPins,
            Set<String> extensionLifecycleProfiles,
            com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan worktree) {
        if (worktree != null) {
            throw new UnsupportedOperationException("Session worktrees are unavailable");
        }
        return insertWorkspaceSessionCommand(tenantId, actorId, idempotencyKey, requestDigest,
                agentId, requestedRevision, title, input, payloadDigest, selection, approvalMode,
                approvalSelectionSupported, planMode, planModeSupported, skills, publicChildrenSupported,
                modelId, extensionPins, extensionLifecycleProfiles);
    }

    public default com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Descriptor findSessionWorktree(
            String tenantId, String sessionId) {
        return null;
    }

    public default Map<String, com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Descriptor> findSessionWorktrees(
            String tenantId, List<String> sessionIds) {
        return Map.of();
    }

    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest);

    /**
     * The actor-carrying variant records the caller on the command receipt,
     * so the receipt's replay answers the actor who recorded it — an
     * OPERATOR's own retry of his own key — and not only the creator. The
     * default drops the actor for implementations that cannot record it.
     */
    public default Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            String actorId) {
        return insertTurnCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, input, payloadDigest);
    }

    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId);

    /** The actor-carrying twin of {@link #insertTurnCommand}. */
    public default Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String actorId) {
        return insertCancelCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, turnId);
    }

    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind);

    /** The actor-carrying twin of {@link #insertTurnCommand}. */
    public default SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId) {
        return beginSessionMutation(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, kind);
    }

    public SessionMutationCommand beginSessionRename(String tenantId, String idempotencyKey,
            String requestDigest, String sessionId, String title);

    /** The actor-carrying twin: the recorded rename answers its recorder. */
    public default SessionMutationCommand beginSessionRename(String tenantId,
            String idempotencyKey, String requestDigest, String sessionId,
            String title, String actorId) {
        return beginSessionRename(tenantId, idempotencyKey, requestDigest,
                sessionId, title);
    }

    public SessionRecord completeSessionRename(String tenantId, String idempotencyKey,
            String sessionId, String title, String harnessBootId, long revision);

    public SessionRecord completeSessionRename(StoreModels.RenameDelivery delivery, String owner, String bootId);

    public void abandonSessionRename(String tenantId, String idempotencyKey,
            String sessionId, long revision, String owner);

    public List<StoreModels.RenameDelivery> deliverableRenames(long now);

    public Optional<StoreModels.RenameDelivery> claimRename(StoreModels.RenameDelivery delivery,
            String owner, Duration lease);

    public void markRenameSubmitted(StoreModels.RenameDelivery delivery, String owner);

    public void retryRename(StoreModels.RenameDelivery delivery, String owner, long availableAt);

    public SessionRecord completeSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId);

    /**
     * Retires the command row of a Session mutation the Harness refused
     * before completion, so the refusal does not leave the Session's
     * later lifecycle changes blocked by a {@code PENDING} row nothing
     * completes. The receipt and digest survive for same-content retries
     * and concurrent completion; completed outcomes remain replayable.
     */
    public void abandonSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId);

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

    public Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest);

    public Optional<CommandRecord> findCommand(String tenantId, String operation,
            String idempotencyKey);

    public Optional<SessionRecord> findSessionById(String sessionId);

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt,
            String beforeSessionId, int limit);

    public SessionPage listSessions(String tenantId, String actorId, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState);

    public SessionPage listSessions(String tenantId, String actorId, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState, String titleQuery);

    public Map<String, WebShellLifecycleOperation> findLatestLifecycleOperations(String tenantId, List<String> sessionIds);

    public Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId);

    /** The active Turn of each given Session, in one round trip. */
    public Map<String, TurnSummary> findActiveTurns(String tenantId,
            List<String> sessionIds);

    /** The latest Turn of each given Session, in one round trip. */
    public Map<String, TurnSummary> findLatestTurns(String tenantId,
            List<String> sessionIds);

    public default Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds) {
        return Map.of();
    }

    public default List<WebShellModelOption> modelOptions() { return List.of(); }

    public default Map<String, WebShellModelSelection> findModelSelections(
            String tenantId, List<String> sessionIds) { return Map.of(); }

    public default WebShellModelChangeResult changeSessionModel(String tenantId, String actorId,
            String sessionId, String key, String digest, String modelId, long expectedRevision,
            boolean supported) {
        throw new UnsupportedOperationException("Model selection is unavailable");
    }

    public default Map<String, WebShellApprovalSelection> findApprovalSelections(
            String tenantId, List<String> sessionIds) { return Map.of(); }

    public default boolean supportsPlanMode(SessionRecord session) { return false; }

    public default boolean hasMcpServers(SessionRecord session) { return false; }

    public default SessionRecord requireMcpManagement(String tenantId, String actorId, String sessionId, String operationId) {
        throw new UnsupportedOperationException("MCP management is unavailable");
    }

    public default void requireMcpSettingsCommit(String tenantId, String workspaceId, String sessionId) {
        throw new UnsupportedOperationException("MCP management is unavailable");
    }

    public default SessionRecord requireExtensionManagement(String tenantId, String actorId, String sessionId, String operationId, boolean mutation) {
        throw new UnsupportedOperationException("Extension management is unavailable");
    }

    public default void requireConfigurationCommit(String tenantId, String workspaceId, String sessionId, JsonNode body) {
        throw new UnsupportedOperationException("Extension management is unavailable");
    }

    public default Set<String> findApprovalOwners(String tenantId, String actorId,
            List<String> sessionIds) { return Set.of(); }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported) {
        throw new UnsupportedOperationException("Approval selection is unavailable");
    }

    public default WebShellApprovalSelection findTurnApprovalSelection(String tenantId, String sessionId,
            String promptId) { return null; }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean planMode, boolean planModeSupported) {
        if (planMode != null) {
            throw new UnsupportedOperationException("Plan mode is unavailable");
        }
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported);
    }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean planMode, boolean planModeSupported,
            boolean liveSupported, Map<String, List<String>> permissionRules, boolean rulesSupported,
            boolean autoSupported) {
        if (permissionRules != null || "auto".equals(mode)) {
            throw new UnsupportedOperationException("Extended approval policy is unavailable");
        }
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, planMode, planModeSupported, liveSupported);
    }

    public default WebShellModelSelection findTurnModelSelection(String tenantId, String sessionId,
            String promptId) { return null; }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean planMode, boolean planModeSupported,
            boolean liveSupported) {
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, planMode, planModeSupported);
    }

    /**
     * The latest environment event of each Session's latest Turn, in one
     * round trip.
     */
    public Map<String, EventRecord> findLatestEnvironmentEvents(String tenantId,
            Map<String, TurnSummary> latestTurns);

    /**
     * A page of a Session's Turns, newest first: by creation time, then by
     * Turn ID, both descending. A position excludes the Turn it names and
     * every newer one.
     */
    public TurnPage listTurns(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTurnId, int limit);

    public Optional<TurnSummary> findTurnSummary(String tenantId, String sessionId,
            String turnId);

    public List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit);

    public List<EventRecord> findControlEvents(String tenantId, String sessionId,
            long throughSequence);

    public EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit);

    public StoreModels.SnapshotPage findSnapshotPage(String tenantId, String sessionId, String cursor, long afterSequence, int limit);

    StoreModels.SnapshotPage findRecentSnapshotPage(String tenantId, String sessionId, String cursor, int limit);

    StoreModels.MessagePage findMessagePage(String tenantId, String sessionId,
            String cursor, int limit, boolean backward);

    public Optional<SnapshotRecord> findSnapshot(String tenantId,
            String sessionId);

    /** The snapshot's covered sequence of each given Session, in one read. */
    public Map<String, Long> findSnapshotCoveredSequences(String tenantId,
            List<String> sessionIds);

    public ReplayWindow findReplayWindow(String tenantId, String sessionId);

    /** The Sessions whose Snapshot covers more than their replay floor. */
    public List<ReplayFloorTarget> findReplayFloorTargets(int limit);

    /**
     * Raises the Session's replay floor, never above the Snapshot's covered
     * sequence, so a client told to resync can resume from the Snapshot.
     */
    public ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence);

    public List<MaterializationTarget> findMaterializationTargets(int limit);

    public MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit);

    /**
     * Rotates a stale materialization target behind the fresher ones by
     * touching only {@code gmt_modified} on its progress row — never
     * {@code covered_sequence}, which the gap guard must freeze on failure.
     */
    public void deferMaterializationTarget(String tenantId, String sessionId);

    public List<DispatchTarget> findDispatchable(long now, int limit);

    /**
     * D7-2: active Turns parked on an unresolved Runtime execution whose
     * recheck is due. They are never dispatched; the reconciler drives a
     * fresh cancellation load instead.
     */
    public List<DispatchTarget> findRuntimeRecoveryParked(long now, int limit);

    public Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration);

    public boolean renewTurn(String tenantId, String sessionId, String turnId,
            String owner, Duration leaseDuration);

    public void releaseTurnLease(String tenantId, String sessionId, String turnId,
            String owner);

    /**
     * #14387: durably marks an active Turn whose recovery was refused —
     * the error code stays on the still-active row for the child result
     * relay to classify from, and the dispatch lease is released so the
     * drive ends without settling the Turn. Never a terminal status: the
     * unwitnessed execution's outcome was never observed. A Harness park
     * backs off before read-only journal observation; it may still settle
     * from later authoritative evidence without replaying execution.
     */
    public boolean markTurnRecoveryBlocked(String tenantId, String sessionId,
            String turnId, String owner, String errorCode,
            String errorMessage);

    /**
     * D7-2: parks an active Turn on {@link #RUNTIME_RECOVERY_BLOCKED} until
     * {@code retryAfter}, releasing the dispatch lease. The Turn keeps its
     * status: only a proven cancel may settle it.
     */
    public boolean parkTurnForRuntimeRecovery(String tenantId, String sessionId,
            String turnId, String owner, String message, long retryAfter);

    public boolean markTurnFailureRecovery(String tenantId, String sessionId,
            String turnId, String owner, String message);

    public boolean requestRecoveryRecheck(String tenantId, String sessionId,
            String turnId);

    public void deferTurnRetry(String tenantId, String sessionId, String turnId,
            String owner, long retryAfter);

    public void scheduleTurnRetry(String tenantId, String sessionId, String turnId,
            String owner, long retryAfter, boolean budgetExempt);

    public boolean bindHarness(String tenantId, String sessionId, String turnId,
            String owner, String harnessBootId);

    public boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId);

    public void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner);

    public boolean withdrawSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner);

    public boolean cancelUnadmittedTurn(String tenantId, String sessionId,
            String turnId, String owner);

    public void recordAdmission(String tenantId, String sessionId, String turnId,
            String owner, String eventEpoch, long lastEventId);

    public void recordRecoveryAdmission(String tenantId, String sessionId,
            String turnId, String owner, String expectedTurnEventEpoch,
            String expectedSessionEventEpoch, String eventEpoch,
            long lastEventId);

    /**
     * Clears non-terminal text from a continuation epoch that did not reach
     * a public terminal event, so the replacement stream is the only copy.
     */
    public void retractContinuationOutput(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId,
            String eventEpoch);

    /**
     * Retracts the published text of the in-flight message a restarted model
     * attempt replaces (#13319): deltas of the Turn in the live epoch with a
     * source id at or after {@code fromSourceId} are emptied, projections are
     * rebuilt, and a {@code stream.reconciled} event is appended. The Harness
     * cursor advances past {@code retractionSourceId} either way.
     */
    public void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId);

    public void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId, String sourceBootId,
            String sourceEventEpoch, Long throughSourceId);

    public void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events);

    public void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner);

    public void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message);

    public boolean failRecoveryBlockedTurn(String tenantId, String sessionId,
            String turnId, String owner, String message);

    public void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey);

    /**
     * Appends a Session event unless one with the source key exists, when
     * the tenant's Session exists and is neither deleted nor being deleted.
     * The Session is locked before its status is read, so a deletion that
     * commits first is always seen.
     */
    public void appendLiveSessionEventIfAbsent(String tenantId, String sessionId,
            String type, Map<String, Object> data, String sourceKey);

    public SessionRecord requireSession(String tenantId, String sessionId);

    public Optional<String> findLastVisibleStatusBeforeDelete(String tenantId,
            String sessionId);
}
