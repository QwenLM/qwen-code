package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Starts or reuses one Runtime while honoring the scope isolation class. */
@FunctionalInterface
public interface RuntimeProvisioner extends AutoCloseable {
    CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request);

    /**
     * Stable kind identifier persisted next to the resource handle so a
     * restored binding is never reconciled by a different provisioner. The
     * default marks a placement without durable identity.
     */
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

    /**
     * Provisions with credentials the Broker created and persisted, so a
     * later Broker process can prove the same identity. The default ignores
     * the seed; such a provisioner can never pass reconciliation.
     */
    default CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return provision(request);
    }

    /**
     * Ensures the physical resource for a durable placement and returns its
     * scheduler handle. The default fails: a provisioner that opts into a
     * durable kind must implement the durable provisioning path.
     */
    default CompletionStage<RuntimeResourceHandle> ensureResource(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle knownHandle) {
        CompletableFuture<RuntimeResourceHandle> failed =
                new CompletableFuture<>();
        failed.completeExceptionally(new UnsupportedOperationException(
                "Provisioner does not support durable recovery"));
        return failed;
    }

    /**
     * Observes the physical resource behind a restored binding without
     * creating or replacing it. The default proves nothing, so a restored
     * binding waits and never guesses.
     */
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
