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

    String WORKFLOW_RECOVERY_BLOCKED = "hosted_workflow_recovery_blocked";

    String RUNTIME_RECOVERY_BLOCKED = "hosted_runtime_recovery_blocked";

    String HARNESS_RECOVERY_BLOCKED = "hosted_harness_recovery_blocked";

    public List<DispatchTarget> findDispatchable(long now, int limit);

    public List<DispatchTarget> findRuntimeRecoveryParked(long now, int limit);

    public Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration);

    public boolean renewTurn(String tenantId, String sessionId, String turnId,
            String owner, Duration leaseDuration);

    public void releaseTurnLease(String tenantId, String sessionId, String turnId,
            String owner);

    public boolean markTurnRecoveryBlocked(String tenantId, String sessionId,
            String turnId, String owner, String errorCode,
            String errorMessage);

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

    public void retractContinuationOutput(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId,
            String eventEpoch);

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
