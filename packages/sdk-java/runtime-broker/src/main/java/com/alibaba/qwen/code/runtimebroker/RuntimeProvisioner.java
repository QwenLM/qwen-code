package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Starts or reuses one Runtime while honoring the scope isolation class. */
@FunctionalInterface
public interface RuntimeProvisioner extends AutoCloseable {
    CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request);

    default CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return provision(request);
    }

    default CompletionStage<Void> drain(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletionStage<Void> release(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        return CompletableFuture.completedFuture(null);
    }

    default CompletionStage<Boolean> health(RuntimeLease lease) {
        return CompletableFuture.completedFuture(true);
    }

    default CompletionStage<Boolean> health(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        return health(lease);
    }

    @Override
    default void close() {
    }
}
