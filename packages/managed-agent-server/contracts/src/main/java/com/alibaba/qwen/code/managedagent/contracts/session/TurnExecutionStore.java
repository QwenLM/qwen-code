package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.model.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;

import java.time.Duration;
import java.util.List;
import java.util.Optional;

/**
 * Turn dispatch, leases, Harness journal writes and recovery marks.
 */
public interface TurnExecutionStore {
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
}
