package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Ensures one physical Runtime resource for a claimed placement. */
public interface RuntimeProvisioner extends AutoCloseable {
    /** Retries for the same request must converge on one live resource. */
    CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request);

    /**
     * Stable kind identifier persisted next to the resource handle so a
     * restored binding is never reconciled by a different provisioner. The
     * default marks a placement without durable identity.
     */
    default String kind() {
        return "legacy";
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
