package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletionStage;

/**
 * The Runtime transport a fault-gate Broker runs with. Session lifecycle
 * and tool operations use the production HTTP transport.
 *
 * <p>For a MANAGED placement, acquire does what the managed agent server's
 * Workspace transport (W0c-3) does after its authorization and storage
 * ownership checks: it installs the Session's context under an operation ID
 * derived from the Runtime Session ID, then activates the Session's gate.
 * Release closes provider admission before that gate. These calls use
 * {@link HttpRuntimeTransport}, with its receipt checks.
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
            return runtime.acquire(lease, session);
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
            return runtime.release(lease, session);
        }
        RuntimeSessionRecord record = sessions.findById(session.getScope(),
                session.getRuntimeSessionId());
        return runtime.release(lease, session)
                .thenCompose(ignored -> runtime.activateWorkspace(bindings.findById(
                        record.getBindingId()), record, context, false))
                .thenApply(ignored -> true);
    }
}
