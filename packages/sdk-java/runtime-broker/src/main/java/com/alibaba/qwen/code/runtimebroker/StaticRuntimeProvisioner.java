package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Returns one preconfigured Runtime lease for contract tests and first integration. */
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
        RuntimeScope scope = request.getScope();
        if ("session".equals(scope.getIsolationClass())) {
            throw new IllegalArgumentException(
                    "Static Runtime cannot provide Session isolation");
        }
        return CompletableFuture.completedFuture(lease);
    }
}
