package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.List;

/** Persistence boundary for physical Runtime generations. */
public interface RuntimeBindingRepository {
    /** Inserts only while the parent generation is READY and not draining.
     * Must share the generation lock used by compareAndSet. */
    public RuntimeSessionRecord admitSession(RuntimeSessionRepository sessions,
            RuntimeSessionRecord candidate);

    /** Creates a RELEASED receipt under the same generation lock as admission. */
    public default RuntimeSessionRecord createSessionTombstone(RuntimeSessionRepository sessions,
            RuntimeSessionRecord candidate) {
        throw new RuntimeBrokerException(501, "runtime_session_tombstone_unavailable",
                "Runtime repository does not support atomic Session retirement", false);
    }

    /** Rechecks admission for an existing READY Session without inserting or updating it. */
    public default RuntimeSessionRecord requireSessionAdmission(RuntimeSessionRepository sessions,
            RuntimeSessionRecord expected) {
        throw new RuntimeBrokerException(501, "runtime_session_admission_unavailable",
                "Runtime repository does not support atomic Session admission checks", false);
    }

    /** Existing idempotency receipts remain readable after admission closes. */
    public ToolExecutionRecord admitExecution(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord candidate);

    /** Authorizes DISPATCHING to EXECUTING under the parent admission lock.
     * Native repositories retain the locked parent version and dispatch generation.
     * A dispatch coordinator claim alone grants no execution permission. */
    public default ToolExecutionRecord authorizeDispatch(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord expected,
            String owner, long dispatchGeneration) {
        throw new RuntimeBrokerException(501, "runtime_dispatch_admission_unavailable",
                "Runtime repository does not support atomic dispatch admission", false);
    }

    /** Performs one bounded recovery transaction under the exact generation
     * claim. Returns LOST while more work or physical stop proof is needed. */
    public RuntimeBindingRecord recoverLost(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected);

    /** Finalizes a stopped generation after its provisioner cleared physical holders. */
    public RuntimeBindingRecord finishLostRecovery(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected);

    /** Bounded maintenance candidates, ordered by binding ID after the exclusive cursor. */
    public List<RuntimeBindingRecord> findRecoveryCandidates(String provisionerKind, String afterBindingId, int limit);

    /** Finalizes release under the parent generation lock; managed LOST requires generation recovery. */
    public RuntimeSessionRecord completeSessionRelease(RuntimeSessionRepository sessions,
            RuntimeSessionRecord expected);

    /** Atomically releases one original Session and its holder under a live drain claim and persisted stop receipt. */
    public default RuntimeSessionRecord completeStoppedSessionRelease(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeSessionRecord expected, RuntimeBindingRecord claim) {
        throw new RuntimeBrokerException(501, "runtime_stopped_release_unavailable",
                "Runtime repository does not support stopped Session release", false);
    }

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
    public RuntimeSessionRecord beginSessionRelease(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeSessionRecord expected);

    public void requestHarnessDrain(String tenantId, String harnessSessionId);

    public boolean isHarnessDraining(String tenantId, String harnessSessionId);

    public default boolean isHarnessAdmissionClosed(String tenantId, String harnessSessionId) {
        return isHarnessDraining(tenantId, harnessSessionId);
    }

    public default void requireHarnessAdmission(RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        if (authority != null || isHarnessDraining(scope.getTenantId(), harnessSessionId)) {
            throw new RuntimeBrokerException(409, "runtime_admission_closed", "Session admission is closed", false);
        }
    }

    public default boolean requireHarnessRecovery(RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        if (authority != null) {
            requireHarnessCleanup(scope, harnessSessionId, authority);
        }
        return authority != null;
    }

    public default void requireHarnessCleanup(RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        throw new RuntimeBrokerException(409, "runtime_admission_closed", "Lifecycle cleanup is unavailable", false);
    }

    public default void requireHookAdmission(RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        requireHarnessAdmission(scope, harnessSessionId, authority);
    }

    /** As the scope-only check, for a Runtime Session on {@code bindingRequest}; see {@link HarnessOwnership}. */
    public default void requireHarnessAdmission(RuntimeProvisionRequest bindingRequest, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority) {
        requireHarnessAdmission(scope, harnessSessionId, authority);
    }

    /** As the scope-only check, for a Runtime Session on {@code bindingRequest}; see {@link HarnessOwnership}. */
    public default boolean requireHarnessRecovery(RuntimeProvisionRequest bindingRequest, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority) {
        return requireHarnessRecovery(scope, harnessSessionId, authority);
    }

    /** As the scope-only check, for a Runtime Session on {@code bindingRequest}; see {@link HarnessOwnership}. */
    public default void requireHarnessCleanup(RuntimeProvisionRequest bindingRequest, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority) {
        requireHarnessCleanup(scope, harnessSessionId, authority);
    }

    /** As the scope-only check, for a Runtime Session on {@code bindingRequest}; see {@link HarnessOwnership}. */
    public default void requireHookAdmission(RuntimeProvisionRequest bindingRequest, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority) {
        requireHookAdmission(scope, harnessSessionId, authority);
    }

    public List<RuntimeBindingRecord> findByHarnessSession(String tenantId, String harnessSessionId,
            String afterBindingId, int limit);

    public void requestStorageFence(String tenantId, String storageId, String operationId);

    public boolean isStorageFenced(String tenantId, String storageId, String operationId);

    public List<RuntimeBindingRecord> findByStorage(String tenantId, String storageId, String afterBindingId, int limit);

    public RuntimeBindingRecord findOrCreate(RuntimeProvisionRequest request);

    public RuntimeBindingRecord findActive(RuntimeProvisionRequest request);

    public List<RuntimeBindingRecord> findActiveByIsolationKey(RuntimeScope scope,
            String isolationKey);

    public RuntimeBindingRecord findById(String bindingId);

    public RuntimeBindingRecord compareAndSet(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement);

    public RuntimeBindingRecord claimOperation(String bindingId, String owner,
            Duration leaseDuration);

    public RuntimeBindingRecord renewOperation(String bindingId, String owner,
            long operationGeneration, Duration leaseDuration);

    /** Clears the caller's operation claim so another Broker can take over
     * without waiting for the lease to lapse. Returns the updated record,
     * or null when the claim no longer matches. Releasing a lapsed claim is
     * permitted cleanup. */
    public RuntimeBindingRecord releaseOperation(String bindingId, String owner,
            long operationGeneration);
}
