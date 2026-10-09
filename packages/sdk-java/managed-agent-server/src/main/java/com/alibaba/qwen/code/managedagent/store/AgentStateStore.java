package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
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
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutation;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
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

    Admission replayWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest);

    Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest);

    Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId);

    SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind);

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

    default OperationAdmission beginWorkspaceClose(String tenantId, String sessionId,
            String actorId, String actorDigest, String key, String digest, boolean supported) {
        throw new UnsupportedOperationException("Workspace close is unavailable");
    }

    OperationAdmission beginWorkspaceLifecycle(String tenantId, String sessionId,
            OperationKind kind, String actorId, String actorDigest, String key,
            String digest, boolean closeSupported);

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
     * Admits a controlled same-Workspace cwd change (W2) on a bound Session,
     * or returns the operation the same actor already admitted under the
     * key. The target directory is already normalized and the request digest
     * already covers it; admission checks the creation actor, the current
     * grant, the Registry facts, the expected context revision and the busy
     * barriers in the pinned order of the W2 design.
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

    void retryOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            long availableAt);

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

    List<DispatchTarget> findDispatchable(long now, int limit);

    Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration);

    boolean renewTurn(String tenantId, String sessionId, String turnId,
            String owner, Duration leaseDuration);

    void releaseTurnLease(String tenantId, String sessionId, String turnId,
            String owner);

    void deferTurnRetry(String tenantId, String sessionId, String turnId,
            String owner, long retryAfter);

    void scheduleTurnRetry(String tenantId, String sessionId, String turnId,
            String owner, long retryAfter);

    boolean bindHarness(String tenantId, String sessionId, String turnId,
            String owner, String harnessBootId);

    boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId);

    void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner);

    boolean withdrawSubmissionAttempted(String tenantId, String sessionId,
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

    void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events);

    void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner);

    void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message);

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
