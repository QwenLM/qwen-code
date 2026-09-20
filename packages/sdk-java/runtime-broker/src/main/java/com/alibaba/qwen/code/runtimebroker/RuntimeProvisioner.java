package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Starts or reuses one Runtime while honoring the scope isolation class. */
@FunctionalInterface
public interface RuntimeProvisioner extends AutoCloseable {
    CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request);

    default String kind() {
        return "legacy";
    }

    default String placementDomain() {
        return "process-local";
    }

    default String runtimeTemplateDigest() {
        return "legacy";
    }

    default boolean supportsDurableRecovery() {
        return false;
    }

    default CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return provision(request);
    }

    default CompletionStage<RuntimeResourceHandle> ensureResource(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle knownHandle) {
        CompletableFuture<RuntimeResourceHandle> failed =
                new CompletableFuture<>();
        failed.completeExceptionally(new UnsupportedOperationException(
                "Provisioner does not support durable recovery"));
        return failed;
    }

    default CompletionStage<RuntimeObservation> reconcile(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return CompletableFuture.completedFuture(
                RuntimeObservation.unknown(handle));
    }

    default CompletionStage<Void> drain(RuntimeResourceContext resource) {
        return drain(resource.getRequest(), resource.getLease());
    }

    default CompletionStage<Void> release(RuntimeResourceContext resource) {
        return release(resource.getRequest(), resource.getLease());
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
