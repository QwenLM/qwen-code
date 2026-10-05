package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol;
import com.alibaba.qwen.code.runtimebroker.ManagedMcpProtocol;
import com.alibaba.qwen.code.runtimebroker.ManagedHookProtocol;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.ManagedShellProtocol;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CompletableFuture;

final class WorkspaceRuntimeTransport implements RuntimeTransport {
    private final HttpRuntimeTransport delegate;
    private final WorkspaceRuntimeResolver resolver;
    private final WorkspaceExecutionStore ownership;
    private final RuntimeBindingRepository bindings;
    private final RuntimeSessionRepository sessions;

    WorkspaceRuntimeTransport(HttpRuntimeTransport delegate, WorkspaceRuntimeResolver resolver,
            WorkspaceExecutionStore ownership, RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions) {
        this.delegate = delegate;
        this.resolver = resolver;
        this.ownership = ownership;
        this.bindings = bindings;
        this.sessions = sessions;
    }

    @Override
    public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return delegate.attest(lease, request, seed);
    }

    @Override
    public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            return delegate.acquire(lease, session);
        }
        Context context = context(lease, session, true);
        // Reject a missing directory before a new claim can strand storage ownership.
        requireDirectory(session.getScope().getCanonicalCwd(), context.binding().getCwdRelative());
        ownership.claim(context.binding(), context.session());
        // Failure retains ownership: a missing response cannot prove the worker did nothing.
        try {
            return delegate.installContext(context.runtime(), context.session(),
                    UUID.nameUUIDFromBytes(session.getRuntimeSessionId().getBytes(StandardCharsets.UTF_8))
                            .toString(), context.binding())
                    .thenCompose(ignored -> delegate.activateWorkspace(context.runtime(), context.session(),
                            context.binding(), true))
                    .thenAccept(ignored -> {
                        context(lease, session, true);
                        ownership.assertHeld(context.binding(), context.session());
                    })
                    .exceptionally(error -> {
                        throw acquireUncertain(error);
                    });
        } catch (RuntimeException error) {
            throw acquireUncertain(error);
        }
    }

    private static RuntimeBrokerException acquireUncertain(Throwable cause) {
        return new RuntimeBrokerException(503, "runtime_session_acquire_failed",
                "Workspace acquisition failed after storage was claimed.", false, cause);
    }

    @Override
    public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference) {
        Context captureContext = null;
        if (managed(session)) {
            try {
                Context context = context(lease, session, true);
                ownership.assertHeld(context.binding(), context.session());
                if (v3(reference)) {
                    captureContext = requireLocalCapture(context);
                }
            } catch (RuntimeException error) {
                // These checks precede HTTP dispatch, so no tool could have started.
                String code = error instanceof RuntimeBrokerException refusal
                        ? refusal.getCode() : "workspace_unavailable";
                Map<String, Object> result = new LinkedHashMap<>(Map.of("executionStatus", "not_started",
                        "responseParts", List.of(), "error", Map.of("type", code,
                                "message", "Workspace execution was refused before dispatch.")));
                if (v3(reference)) {
                    result.put("capture", null);
                }
                return CompletableFuture.completedFuture(result);
            }
        }
        if (v3(reference)) {
            if (captureContext == null || !"run_shell_command".equals(reference.get("toolName"))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            Map<String, Object> capture = Map.of("tenantId", session.getScope().getTenantId(),
                    "sessionId", session.getHarnessSessionId(), "turnId", reference.get("promptId"),
                    "executionCallId", reference.get("executionCallId"),
                    "bindingGeneration", Long.toString(captureContext.runtime().getGeneration()),
                    "capturePolicy", "complete_required");
            return delegate.executeV3(lease, session, wireReference(reference), capture).thenApply(answer -> {
                if (!"settled".equals(answer.get("state")) || !(answer.get("result") instanceof Map<?, ?>)) {
                    throw WorkspaceExecutionStore.unavailable();
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> result = (Map<String, Object>) answer.get("result");
                return result;
            });
        }
        return delegate.execute(lease, session, reference);
    }

    @Override
    public CompletionStage<Void> installPublication(RuntimeLease lease,
            RuntimeSession session, RuntimePublicationGrant grant) {
        requireOwnedWorkspace(lease, session);
        return delegate.installPublication(lease, session, grant);
    }

    @Override
    public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> payload, Map<String, Object> capture) {
        try {
            requireOwnedWorkspace(lease, session);
        } catch (RuntimeException error) {
            String code = error instanceof RuntimeBrokerException refusal
                    ? refusal.getCode() : "workspace_unavailable";
            Map<String, Object> result = new LinkedHashMap<>(Map.of("executionStatus", "not_started",
                    "responseParts", List.of(), "error", Map.of("type", code,
                            "message", "Workspace execution was refused before dispatch.")));
            result.put("capture", null);
            return CompletableFuture.completedFuture(Map.of("state", "settled", "result", result));
        }
        return delegate.executeV3(lease, session, reference, payload, capture);
    }

    @Override
    public CompletionStage<Map<String, Object>> statusV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        requireOriginalRuntime(lease, session);
        return delegate.statusV3(lease, session, reference, afterSequence);
    }

    @Override
    public CompletionStage<Map<String, Object>> cancelV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        requireOriginalRuntime(lease, session);
        return delegate.cancelV3(lease, session, reference);
    }

    @Override
    public CompletionStage<Map<String, Object>> acknowledgeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> receipt) {
        requireOriginalRuntime(lease, session);
        return delegate.acknowledgeV3(lease, session, reference, receipt);
    }

    @Override
    public CompletionStage<Map<String, Object>> acknowledgeCsi(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> boot, Map<String, Object> expectedPod, Map<String, Object> request,
            Map<String, Object> expectedCaptureIdentity) {
        if (!managed(session)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Context context = context(lease, session, false, true);
        var runtime = context.runtime();
        if (!"kubernetes-workspace".equals(runtime.getRequest().getProvisionerKind())
                || runtime.getState() != RuntimeBindingRecord.State.DRAINING || !runtime.isDrainRequested()
                || runtime.getProvisionSeed() == null || runtime.getAttestationGeneration() <= 0
                || context.session().getState() != RuntimeSessionRecord.State.READY
                || !context.session().getSession().getScope().equals(session.getScope())
                || !Long.toString(runtime.getGeneration()).equals(expectedCaptureIdentity.get("bindingGeneration"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try {
            @SuppressWarnings("unchecked")
            var storage = (Map<String, Object>) boot.get("storage");
            var originalBoot = ManagedCsiProtocol.boot(runtime.getRequest(), runtime.getProvisionSeed(), storage);
            ManagedCsiProtocol.validateAcknowledgementRequest(request, originalBoot, expectedPod);
            ManagedCsiProtocol.validateAcknowledgementIdentity(lease, session, boot, request, expectedCaptureIdentity);
        } catch (RuntimeException failure) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return delegate.acknowledgeCsi(lease, session, boot, expectedPod, request, expectedCaptureIdentity);
    }

    private void requireOwnedWorkspace(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Context context = context(lease, session, true);
        ownership.assertHeld(context.binding(), context.session());
    }

    private void requireOriginalRuntime(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        context(lease, session, false);
    }

    @Override
    public CompletionStage<Void> installPublisher(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> publisher) {
        if (!managed(session)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Context context = requireLocalCapture(context(lease, session, true));
        ownership.assertHeld(context.binding(), context.session());
        return delegate.installPublisherV3(lease, session, publisher);
    }

    @Override
    public CompletionStage<Map<String, Object>> acknowledge(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference, Map<String, Object> receipt) {
        if (!managed(session) || !v3(reference)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        requireLocalCapture(context(lease, session, false));
        return delegate.acknowledgeV3(lease, session, wireReference(reference), receipt)
                .thenApply(WorkspaceRuntimeTransport::projectStatus);
    }

    @Override
    public CompletionStage<Map<String, Object>> status(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference, long afterSequence) {
        if (v3(reference)) {
            if (!managed(session)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            requireLocalCapture(context(lease, session, false));
            return delegate.statusV3(lease, session, wireReference(reference), afterSequence)
                    .thenApply(WorkspaceRuntimeTransport::projectStatus);
        }
        return delegate.status(lease, session, reference, afterSequence);
    }

    @Override
    public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference) {
        if (v3(reference)) {
            if (!managed(session)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            requireLocalCapture(context(lease, session, false));
            return delegate.cancelV3(lease, session, wireReference(reference))
                    .thenApply(WorkspaceRuntimeTransport::projectStatus);
        }
        return delegate.cancel(lease, session, reference);
    }

    private static boolean v3(Map<String, Object> reference) {
        return Integer.valueOf(3).equals(reference.get("runtimeProtocol"));
    }

    private static Context requireLocalCapture(Context context) {
        if (!"local-process".equals(context.runtime().getRequest().getProvisionerKind())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return context;
    }

    private static Map<String, Object> wireReference(Map<String, Object> reference) {
        Map<String, Object> wire = new LinkedHashMap<>();
        for (String field : List.of("sessionId", "promptId", "callId", "toolName", "input")) {
            if (reference.containsKey(field)) {
                wire.put(field, reference.get(field));
            }
        }
        wire.put("argsDigest", reference.get("inputDigest"));
        return Map.copyOf(wire);
    }

    private static Map<String, Object> projectStatus(Map<String, Object> answer) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", answer.get("state"));
        if (answer.containsKey("result")) {
            status.put("result", answer.get("result"));
        }
        return Map.copyOf(status);
    }

    @Override
    public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> operation) {
        if (ManagedMcpProtocol.isOperation(operation) || ManagedHookProtocol.isOperation(operation)
                || ManagedShellProtocol.isOperation(operation)) {
            if (!managed(session)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if (ManagedHookProtocol.isOperation(operation)) {
                ManagedHookProtocol.validateSession(session, operation);
            } else if (ManagedShellProtocol.isOperation(operation)) {
                ManagedShellProtocol.validateSession(session, operation);
            } else {
                ManagedMcpProtocol.validateSession(session, operation);
            }
            boolean recovery = ManagedMcpProtocol.isRecovery(operation) || ManagedHookProtocol.isRecovery(operation)
                    || ManagedShellProtocol.isRecovery(operation);
            Context context = context(lease, session, !recovery);
            if (context.runtime().getState() != RuntimeBindingRecord.State.READY
                    && !(recovery && context.runtime().getState() == RuntimeBindingRecord.State.DRAINING)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if (recovery) {
                if (!ownership.isHeld(context.binding(), context.session())) {
                    throw new RuntimeBrokerException(409, "workspace_busy",
                            "Workspace storage is held by another tool turn.", true);
                }
            } else {
                ownership.assertHeld(context.binding(), context.session());
            }
        } else if (managed(session) && !"history".equals(operation.get("kind"))) {
            Context context = context(lease, session, true);
            ownership.assertHeld(context.binding(), context.session());
        }
        return delegate.control(lease, session, operation);
    }

    @Override
    public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            return delegate.release(lease, session);
        }
        Context context = context(lease, session, false);
        // RELEASING fences later claims; an absent holder needs no physical release.
        if (context.session().getState() == RuntimeSessionRecord.State.RELEASING
                && !context.runtime().isDrainRequested()
                && !ownership.isHeld(context.binding(), context.session())) {
            return CompletableFuture.completedFuture(true);
        }
        return delegate.release(lease, session).thenCompose(released -> {
            if (!Boolean.TRUE.equals(released)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return delegate.activateWorkspace(context.runtime(), context.session(), context.binding(), false);
        })
                .thenApply(ignored -> {
                    ownership.release(context.binding(), context.session());
                    return true;
                });
    }

    private Context context(RuntimeLease lease, RuntimeSession session, boolean authorize) {
        return context(lease, session, authorize, false);
    }

    private Context context(RuntimeLease lease, RuntimeSession session, boolean authorize, boolean originalCsi) {
        ContextBinding binding;
        if (authorize) {
            var resolved = resolver.resolve(session.getHarnessSessionId());
            if (!resolved.scope().equals(session.getScope())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            binding = resolved.binding();
        } else {
            binding = resolver.savedBinding(session.getHarnessSessionId());
        }
        RuntimeSessionRecord record = sessions.findById(session.getScope(), session.getRuntimeSessionId());
        RuntimeBindingRecord runtime = record == null ? null : bindings.findById(record.getBindingId());
        if (runtime == null || runtime.getLease() == null
                || !session.getHarnessSessionId().equals(record.getSession().getHarnessSessionId())
                || !session.getTurnKind().equals(record.getSession().getTurnKind())
                || record.getRuntimeGeneration() != runtime.getGeneration()
                || !runtime.getRequest().getScope().equals(session.getScope())
                || (originalCsi
                        ? !"workspace".equals(session.getScope().getIsolationClass()) || runtime.getRequest().getIsolationKey() != null
                        : !session.getHarnessSessionId().equals(runtime.getRequest().getIsolationKey()))
                || !binding.getStorageId().equals(runtime.getRequest().getStorageId())
                || !binding.getTenantId().equals(session.getScope().getTenantId())
                || !binding.getWorkspaceId().equals(session.getScope().getWorkspaceId())
                || !Long.toString(binding.getWorkspaceGeneration()).equals(
                        session.getScope().getWorkspaceGeneration())
                || !sameLease(lease, runtime.getLease())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return new Context(binding, record, runtime);
    }

    private static void requireDirectory(String root, String cwdRelative) {
        try {
            Path base = Path.of(root);
            Path directory = base.resolve(cwdRelative).normalize();
            if (!directory.startsWith(base) || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                    || !directory.toRealPath().equals(directory)) {
                throw WorkspaceExecutionStore.unavailable();
            }
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private static boolean managed(RuntimeSession session) {
        return WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(session.getScope().getCapabilityDigest());
    }

    private static boolean sameLease(RuntimeLease left, RuntimeLease right) {
        return left.getRuntimeInstanceId().equals(right.getRuntimeInstanceId())
                && left.getEndpoint().equals(right.getEndpoint())
                && left.getToken().equals(right.getToken())
                && left.getLeaseId().equals(right.getLeaseId()) && left.getEpoch() == right.getEpoch();
    }

    private record Context(ContextBinding binding, RuntimeSessionRecord session, RuntimeBindingRecord runtime) {
    }
}
