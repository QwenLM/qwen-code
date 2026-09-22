package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/**
 * Executes the existing Managed Runtime v1/v2 protocol for the Broker.
 *
 * <p>Acquire and release must be idempotent by Runtime Session identifier.
 * Attestation must bind the exact provision request, lease, Runtime identity,
 * and scope before a recovered endpoint is reused.
 */
public interface RuntimeTransport {
    default CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return java.util.concurrent.CompletableFuture.failedFuture(
                new RuntimeBrokerException(503,
                        "runtime_broker_attestation_unavailable",
                        "Runtime transport does not support attestation.",
                        false));
    }

    CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session);

    CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> operation);

    CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    CompletionStage<Map<String, Object>> status(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence);

    CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session);
}
