package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.List;

/** Persistence boundary for physical Runtime generations. */
public interface RuntimeBindingRepository {
    /** Inserts only while the parent generation is READY and not draining.
     * Must share the generation lock used by compareAndSet. */
    RuntimeSessionRecord admitSession(RuntimeSessionRepository sessions,
            RuntimeSessionRecord candidate);

    /** Existing idempotency receipts remain readable after admission closes. */
    ToolExecutionRecord admitExecution(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord candidate);

    /** Authorizes DISPATCHING to EXECUTING under the parent admission lock.
     * Native repositories retain the locked parent version and dispatch generation.
     * A dispatch coordinator claim alone grants no execution permission. */
    default ToolExecutionRecord authorizeDispatch(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord expected,
            String owner, long dispatchGeneration) {
        throw new RuntimeBrokerException(501, "runtime_dispatch_admission_unavailable",
                "Runtime repository does not support atomic dispatch admission", false);
    }

    /** Performs one bounded recovery transaction under the exact generation
     * claim. Returns LOST while more work or physical stop proof is needed. */
    RuntimeBindingRecord recoverLost(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected);

    /** Finalizes a stopped generation after its provisioner cleared physical holders. */
    RuntimeBindingRecord finishLostRecovery(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected);

    /** Bounded maintenance candidates, ordered by binding ID after the exclusive cursor. */
    List<RuntimeBindingRecord> findRecoveryCandidates(String provisionerKind, String afterBindingId, int limit);

    /** Finalizes release under the parent generation lock; managed LOST requires generation recovery. */
    RuntimeSessionRecord completeSessionRelease(RuntimeSessionRepository sessions,
            RuntimeSessionRecord expected);

    /**
     * Moves the Session to RELEASING in one decision with the no-active-
     * execution check, under the same Session row lock admission takes, so
     * two Broker processes cannot interleave an admission into the gap.
     * Returns null when the row no longer matches {@code expected}, the
     * current record when it is already RELEASING or RELEASED, throws
     * {@code runtime_session_busy} when an execution is still active, and
     * throws {@code runtime_session_not_ready} when the Session is in any
     * other state.
     */
    RuntimeSessionRecord beginSessionRelease(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeSessionRecord expected);

    void requestHarnessDrain(String tenantId, String harnessSessionId);

    boolean isHarnessDraining(String tenantId, String harnessSessionId);

    default boolean isHarnessAdmissionClosed(String tenantId, String harnessSessionId) {
        return isHarnessDraining(tenantId, harnessSessionId);
    }

    default void requireHarnessAdmission(RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        if (authority != null || isHarnessDraining(scope.getTenantId(), harnessSessionId)) {
            throw new RuntimeBrokerException(409, "runtime_admission_closed", "Session admission is closed", false);
        }
    }

    default void requireHookAdmission(RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        requireHarnessAdmission(scope, harnessSessionId, authority);
    }

    default void verifyHarnessStopped(java.sql.Connection connection, String tenantId, String harnessSessionId)
            throws java.sql.SQLException {
        throw new RuntimeBrokerException(409, "workspace_close_identity_unverified", "Stop verification is unavailable", false);
    }

    List<RuntimeBindingRecord> findByHarnessSession(String tenantId, String harnessSessionId,
            String afterBindingId, int limit);

    void requestStorageFence(String tenantId, String storageId, String operationId);

    boolean isStorageFenced(String tenantId, String storageId, String operationId);

    List<RuntimeBindingRecord> findByStorage(String tenantId, String storageId, String afterBindingId, int limit);

    RuntimeBindingRecord findOrCreate(RuntimeProvisionRequest request);

    RuntimeBindingRecord findActive(RuntimeProvisionRequest request);

    List<RuntimeBindingRecord> findActiveByIsolationKey(RuntimeScope scope,
            String isolationKey);

    RuntimeBindingRecord findById(String bindingId);

    RuntimeBindingRecord compareAndSet(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement);

    RuntimeBindingRecord claimOperation(String bindingId, String owner,
            Duration leaseDuration);

    RuntimeBindingRecord renewOperation(String bindingId, String owner,
            long operationGeneration, Duration leaseDuration);

    /** Clears the caller's operation claim so another Broker can take over
     * without waiting for the lease to lapse. Returns the updated record,
     * or null when the claim no longer matches. Releasing a lapsed claim is
     * permitted cleanup. */
    RuntimeBindingRecord releaseOperation(String bindingId, String owner,
            long operationGeneration);
}
