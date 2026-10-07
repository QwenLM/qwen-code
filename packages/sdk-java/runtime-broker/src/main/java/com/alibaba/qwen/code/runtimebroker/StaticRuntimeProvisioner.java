package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Returns one pre-attested lease. Static placements do not keep a
 * recoverable identity, matching {@code requiresDurableIdentity}.
 */
public final class StaticRuntimeProvisioner implements RuntimeProvisioner {
    private final RuntimeLease lease;

    public StaticRuntimeProvisioner(RuntimeLease lease) {
        if (lease == null) {
            throw new IllegalArgumentException("lease is required");
        }
        this.lease = lease;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        return CompletableFuture.completedFuture(lease);
    }

    @Override
    public String kind() {
        return "static";
    }
}
