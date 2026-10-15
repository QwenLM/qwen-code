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

    /** Creates placement identity from trusted embedding configuration. */
    default RuntimeProvisionRequest createRequest(RuntimeScope scope,
            String isolationKey) {
        return new RuntimeProvisionRequest(scope, isolationKey, kind());
    }

    /** Short, bounded pre-create admission only; never creates a resource or calls a worker. */
    default void reserveResource(RuntimeBindingRecord binding) {
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
     * <p>
     * The broker keeps the recovery claim renewed for the duration of the
     * call, so a slow observation may take as long as the provisioner's own
     * declared waits. A call that never answers at all is backstopped well
     * past those waits and surfaces as a retryable
     * {@code runtime_broker_reconcile_timeout}. Implementations must not
     * block the calling thread: renewal ticks run on the service's own
     * pool, but the caller may be a completion thread shared with other
     * work, so hand long waits to another executor and return a pending
     * stage.
     */
    default CompletionStage<RuntimeObservation> reconcile(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return CompletableFuture.completedFuture(
                RuntimeObservation.unknown(handle));
    }

    /**
     * Clears only physical holders of the saved generation after durable stop proof.
     * The same backstop as {@link #reconcile} applies: the claim stays
     * renewed for the call, and a never-answering call is retried later.
     */
    default CompletionStage<Void> recoverResources(RuntimeBindingRecord binding) {
        if (binding.getRequest().isManagedContext()) {
            return CompletableFuture.failedFuture(new RuntimeBrokerException(409,
                    "runtime_broker_recovery_blocked", "Workspace recovery cleanup is unavailable.", false));
        }
        return CompletableFuture.completedFuture(null);
    }

    default boolean supportsDrainedStop() {
        return false;
    }

    default CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(409,
                "workspace_close_identity_unverified", "Durable worker stop is unavailable.", false));
    }

    /** Whether saved startup identity can be observed without relaunching it. */
    default boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return false;
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
     * Whether a failed confirmation can be retried against the same owned,
     * still-live resource. Unknown implementations keep the binding fenced.
     */
    default boolean canRetryFailedConfirm(RuntimeLease lease) {
        return false;
    }

    /**
     * Tears down the resource behind a lease the caller has decided to
     * discard, keyed by the complete lease identity so a fenced loser can
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
