package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Executes protocol operations against one attested Runtime lease.
 *
 * <p>Acquire and release must be idempotent by Runtime Session identifier.
 * Execute results must contain a string {@code executionStatus}. Cancel
 * results must contain {@code state} with one of {@code prepared},
 * {@code executing}, {@code cancel_requested}, {@code settled}, or
 * {@code unknown}; a settled response must also contain a valid execution
 * result. Status results use the same states. Release acknowledges
 * completion only with {@code true}.
 */
public interface RuntimeTransport {
    /**
     * Re-proves the identity behind a restored lease. The default fails
     * closed: a transport that cannot attest can never adopt a binding.
     */
    default CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        CompletableFuture<RuntimeAttestation> failed =
                new CompletableFuture<>();
        failed.completeExceptionally(new RuntimeBrokerException(503,
                "runtime_broker_attestation_unavailable",
                "Runtime transport does not support attestation.", false));
        return failed;
    }

    /**
     * Installs directory context only; does not activate a Session. The
     * Session record must be ACQUIRING or READY and name this binding at its
     * current generation. The binding must be READY with no drain requested
     * and hold the Session's placement: its scope and, under session
     * isolation, its Harness Session.
     */
    default CompletionStage<Map<String, Object>> installContext(
            RuntimeBindingRecord runtime, RuntimeSessionRecord session,
            String operationId, ContextBinding binding) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "managed_runtime_incompatible",
                "Runtime transport does not support context installation.", false));
    }

    CompletionStage<Void> acquire(RuntimeLease lease,
            RuntimeSession session);

    default CompletionStage<Void> installPublisher(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> publisher) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "managed_tool_publisher_unavailable",
                "Runtime transport does not support output publication.", false));
    }

    default CompletionStage<Map<String, Object>> acknowledge(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> receipt) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "managed_tool_result_acknowledge_unsupported",
                "Runtime transport does not support result acknowledgement.", false));
    }

    CompletionStage<Object> control(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> operation);

    CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    default CompletionStage<Void> installPublication(RuntimeLease lease,
            RuntimeSession session, RuntimePublicationGrant grant) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_publication_unsupported",
                "Runtime transport does not support publication grants.", false));
    }

    default CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> payload, Map<String, Object> capture) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_tool_v3_unsupported",
                "Runtime transport does not support Tool v3.", false));
    }

    default CompletionStage<Map<String, Object>> statusV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_tool_v3_unsupported", "Runtime transport does not support Tool v3 status.", false));
    }

    default CompletionStage<Map<String, Object>> cancelV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_tool_v3_unsupported", "Runtime transport does not support Tool v3 cancel.", false));
    }

    default CompletionStage<Map<String, Object>> acknowledgeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> receipt) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_tool_v3_unsupported", "Runtime transport does not support Tool v3 ACK.", false));
    }

    default CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> payload) {
        Map<String, Object> request = new java.util.LinkedHashMap<>(reference);
        request.remove("dispatchMode");
        request.putAll(payload);
        return execute(lease, session, Map.copyOf(request));
    }

    CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    /**
     * Looks up the original invocation by its {@code reference} without
     * preparing, attaching, or executing anything. {@code afterSequence} is
     * the last result sequence the Broker recorded; this contract version
     * returns no events after it. The result contains only {@code state},
     * plus {@code result} when the state is {@code settled}. {@code unknown}
     * means this Runtime holds no record of the reference; it is never
     * evidence that the call did not run. A settled result is the Runtime's
     * own terminal answer, {@code not_started} included. The call must not
     * block, and its stage must complete in bounded time; the service also
     * abandons it after the operation lease duration. Settling runs
     * repository work on the thread that completes the stage, so a
     * transport should not complete it on an I/O thread. The default fails
     * closed, so a transport without the lookup can never settle an
     * execution.
     *
     * <p>An HTTP adapter must validate the wire envelope and project it to
     * this shape, stripping {@code protocolVersion} and {@code lastSequence}.
     * The Broker does not consume the Runtime's response cursor yet.
     */
    default CompletionStage<Map<String, Object>> status(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_execution_status_unsupported",
                "Runtime transport does not support execution lookup.",
                false));
    }

    CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session);
}
