package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * The Runtime transport a fault-gate Broker runs with. The v2 worker contract
 * has no Session verbs, and {@link HttpRuntimeTransport} fails
 * {@code acquire} and {@code release} with 501 until they exist, so the
 * service could never reach dispatch. These two verbs are answered here;
 * everything that crosses to the worker goes through the production HTTP
 * transport.
 *
 * <p>For a MANAGED placement, acquire does what the managed agent server's
 * Workspace transport (W0c-3) does after its authorization and storage
 * ownership checks: it installs the Session's context under an operation ID
 * derived from the Runtime Session ID, then activates the Session's gate.
 * Release closes that gate. Both calls are the production
 * {@link HttpRuntimeTransport} methods, with their receipt checks.
 */
final class FaultGateTransport implements RuntimeTransport {
    private final HttpRuntimeTransport runtime;
    private final ContextBinding context;
    private final RuntimeBindingRepository bindings;
    private final RuntimeSessionRepository sessions;

    FaultGateTransport(HttpRuntimeTransport runtime) {
        this(runtime, null, null, null);
    }

    FaultGateTransport(HttpRuntimeTransport runtime, ContextBinding context,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions) {
        this.runtime = runtime;
        this.context = context;
        this.bindings = bindings;
        this.sessions = sessions;
    }

    @Override
    public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return runtime.attest(lease, request, seed);
    }

    @Override
    public CompletionStage<Void> acquire(RuntimeLease lease,
            RuntimeSession session) {
        if (context == null) {
            return CompletableFuture.completedFuture(null);
        }
        RuntimeSessionRecord record = sessions.findById(session.getScope(),
                session.getRuntimeSessionId());
        RuntimeBindingRecord binding = bindings.findById(
                record.getBindingId());
        String operationId = UUID.nameUUIDFromBytes(session
                .getRuntimeSessionId().getBytes(StandardCharsets.UTF_8))
                .toString();
        return runtime.installContext(binding, record, operationId, context)
                .thenCompose(receipt -> runtime.activateWorkspace(binding,
                        record, context, true));
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
        if (context == null) {
            return CompletableFuture.completedFuture(true);
        }
        RuntimeSessionRecord record = sessions.findById(session.getScope(),
                session.getRuntimeSessionId());
        return runtime.activateWorkspace(bindings.findById(
                record.getBindingId()), record, context, false)
                .thenApply(ignored -> true);
    }
}
