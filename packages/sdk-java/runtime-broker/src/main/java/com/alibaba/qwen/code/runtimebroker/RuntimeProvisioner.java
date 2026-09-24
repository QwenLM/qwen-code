package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Ensures one physical Runtime resource for a claimed placement. */
public interface RuntimeProvisioner extends AutoCloseable {
    /** Retries for the same request must converge on one live resource. */
    CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request);

    /**
     * Proves a lease this process already treats as ready still answers
     * attestation. The default accepts the in-memory lease.
     */
    default CompletionStage<Void> confirm(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        return CompletableFuture.completedFuture(null);
    }

    /**
     * Tears down the resource behind a lease the caller has decided to
     * discard, keyed by the lease's runtime instance so a fenced loser can
     * never kill the winning resource for the same request. The default
     * has nothing to release.
     */
    default CompletionStage<Void> release(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        return CompletableFuture.completedFuture(null);
    }

    /**
     * Cheap local check whether the resource behind a lease is still
     * usable. The default has no resource that can die.
     */
    default boolean isUsable(RuntimeLease lease) {
        return true;
    }

    @Override
    default void close() {
    }
}
