package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Durable Broker staging ledger and single-puller binding claims for Phase 3b
 * runtime-owned background observation.
 */
public interface RuntimeStageStore {
    public record PullerClaim(
            String bindingId,
            long runtimeGeneration,
            String ownerId,
            long pullerGeneration,
            Instant leaseUntil) {
    }

    public record PullableRun(
            String tenantId,
            String workspaceId,
            String harnessSessionId,
            String runtimeSessionId,
            String bindingId,
            long runtimeGeneration,
            String executionCallId) {
    }

    public record StageBatchRequest(
            PullerClaim claim,
            String tenantId,
            String workspaceId,
            String harnessSessionId,
            String executionCallId,
            List<Map<String, Object>> entries) {
    }

    public record StageOutcome(
            boolean committed,
            long stagedThrough,
            boolean terminalSettled,
            boolean wakeMarked,
            boolean hardCapReached) {
    }

    RuntimeStageStore NOOP = new RuntimeStageStore() {
    };

    public default List<PullableRun> findPullableRuns() {
        return List.of();
    }

    public default PullerClaim claimBindingPuller(
            String bindingId,
            long runtimeGeneration,
            String ownerId,
            Duration leaseDuration) {
        return new PullerClaim(
                bindingId,
                runtimeGeneration,
                ownerId,
                1L,
                Instant.now().plus(leaseDuration));
    }

    public default PullerClaim renewBindingPuller(
            PullerClaim claim,
            Duration leaseDuration) {
        return new PullerClaim(
                claim.bindingId(),
                claim.runtimeGeneration(),
                claim.ownerId(),
                claim.pullerGeneration(),
                Instant.now().plus(leaseDuration));
    }

    public default void releaseBindingPuller(PullerClaim claim) {
    }

    public default long highestStagedSequence(String executionCallId) {
        return 0L;
    }

    public default boolean isSessionAtHardCap(String tenantId, String harnessSessionId) {
        return false;
    }

    public default StageOutcome stageBatch(StageBatchRequest request) {
        long max = 0L;
        for (Map<String, Object> entry : request.entries()) {
            Object seq = entry.get("deliverySeq");
            if (seq instanceof Number number && number.longValue() > max) {
                max = number.longValue();
            }
        }
        return new StageOutcome(true, max, false, false, false);
    }

    public default List<Map<String, Object>> listStagedDeliveries(
            String tenantId,
            String harnessSessionId,
            String writerId,
            long writerGeneration) {
        return List.of();
    }

    public default void acknowledgeStagedDeliveries(
            String tenantId,
            String harnessSessionId,
            String writerId,
            long writerGeneration,
            String executionCallId,
            long throughSeq) {
    }

    public default void acknowledgeOnDetach(
            String tenantId,
            String harnessSessionId,
            long writerGeneration,
            Map<String, Long> appliedThrough) {
    }
}
