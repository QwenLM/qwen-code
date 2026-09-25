package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Executes the existing Managed Runtime v1/v2 protocol for the Broker.
 *
 * <p>Acquire and release must be idempotent by Runtime Session identifier.
 * Attestation must bind the exact provision request, lease, Runtime identity,
 * and scope before a recovered endpoint is reused.
 * Cancel and status results contain {@code state} with one of
 * {@code prepared}, {@code executing}, {@code cancel_requested},
 * {@code settled}, or {@code unknown}; a settled response must also contain
 * a valid execution result.
 */
public interface RuntimeTransport {
    /**
     * Re-proves the identity behind a restored lease. The default fails
     * closed: a transport that cannot attest can never adopt a binding.
     */
    default CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return CompletableFuture.failedFuture(
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

    /**
     * Looks up the original invocation by its {@code reference} without
     * preparing, attaching, or executing anything. {@code afterSequence} is
     * the last result sequence the Broker recorded. The result contains
     * {@code state}, plus {@code result} when the state is {@code settled};
     * progress fields may accompany them. {@code unknown}
     * means this Runtime holds no record of the reference; it is never
     * evidence that the call did not run. A settled result is the Runtime's
     * own terminal answer, {@code not_started} included. The call must not
     * block, and its stage must complete in bounded time; the service also
     * abandons it after the operation lease duration. Settling runs
     * repository work on the thread that completes the stage, so a
     * transport should not complete it on an I/O thread. The default fails
     * closed, so a transport without the lookup can never settle an
     * execution.
     */
    default CompletionStage<Map<String, Object>> status(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_broker_execution_status_unsupported",
                "Runtime transport does not support execution lookup.",
                false));
    }

    CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session);
}
