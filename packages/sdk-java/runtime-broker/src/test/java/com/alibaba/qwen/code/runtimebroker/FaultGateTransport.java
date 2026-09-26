package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * The Runtime transport a fault-gate Broker runs with. The v2 worker contract
 * has no Session verbs, and {@link HttpRuntimeTransport} fails
 * {@code acquire} and {@code release} with 501 until they exist, so the
 * service could never reach dispatch. These two verbs are answered locally;
 * everything that crosses to the worker (attest, execute, status, cancel)
 * goes through the production HTTP transport.
 */
final class FaultGateTransport implements RuntimeTransport {
    private final HttpRuntimeTransport runtime;

    FaultGateTransport(HttpRuntimeTransport runtime) {
        this.runtime = runtime;
    }

    @Override
    public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return runtime.attest(lease, request, seed);
    }

    @Override
    public CompletionStage<Void> acquire(RuntimeLease lease,
            RuntimeSession session) {
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public CompletionStage<Object> control(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> operation) {
        return runtime.control(lease, session, operation);
    }

    @Override
    public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        return runtime.execute(lease, session, reference);
    }

    @Override
    public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        return runtime.cancel(lease, session, reference);
    }

    @Override
    public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        return runtime.status(lease, session, reference, afterSequence);
    }

    @Override
    public CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session) {
        return CompletableFuture.completedFuture(true);
    }
}
