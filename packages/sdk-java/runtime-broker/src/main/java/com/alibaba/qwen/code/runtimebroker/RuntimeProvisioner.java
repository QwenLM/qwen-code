package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Ensures one physical Runtime resource for a claimed placement. */
public interface RuntimeProvisioner {
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
}
