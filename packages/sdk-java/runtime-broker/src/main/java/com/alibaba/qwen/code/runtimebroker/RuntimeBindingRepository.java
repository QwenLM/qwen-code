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
