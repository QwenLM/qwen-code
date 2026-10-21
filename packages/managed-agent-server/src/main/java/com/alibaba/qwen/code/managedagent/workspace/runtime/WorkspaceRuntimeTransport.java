package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
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
import com.alibaba.qwen.code.runtimebroker.provisioning.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHookProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedMcpProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedMonitorProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedShellProtocol;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

final class WorkspaceRuntimeTransport implements RuntimeTransport {
    private final HttpRuntimeTransport delegate;
    private final WorkspaceRuntimeResolver resolver;
    private final java.util.function.Function<String, ContextBinding> savedBindings;
    private final WorkspaceExecutionStore ownership;
    private final RuntimeBindingRepository bindings;
    private final RuntimeSessionRepository sessions;
    // READY Sessions whose mount went back early (#13800): the worker still
    // holds their installation, so their full release must reach it even
    // though the holder is already gone. In memory only — a Broker restart
    // drops the debt and leaves it to the worker's own lifetime.
    private final java.util.Set<String> detachOwed = java.util.concurrent.ConcurrentHashMap.newKeySet();

    WorkspaceRuntimeTransport(HttpRuntimeTransport delegate, WorkspaceRuntimeResolver resolver,
            WorkspaceExecutionStore ownership, RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions) {
        this.delegate = delegate;
        this.resolver = resolver;
        this.savedBindings = resolver::savedBinding;
        this.ownership = ownership;
        this.bindings = bindings;
        this.sessions = sessions;
    }

    WorkspaceRuntimeTransport(HttpRuntimeTransport delegate, WorkspaceExecutionStore ownership,
            RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            java.util.function.Function<String, ContextBinding> savedBindings) {
        this.delegate = delegate;
        this.resolver = null;
        this.ownership = ownership;
        this.bindings = bindings;
        this.sessions = sessions;
        this.savedBindings = savedBindings;
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
        if (!ResidentWorkspaceProfile.selects(session.getScope())) {
            if (LocalProcessRuntimeProvisioner.KIND.equals(context.runtime().getRequest().getProvisionerKind())) {
                WorkspaceRuntimeResolver.requireDirectory(session.getScope().getCanonicalCwd(), context.binding().getCwdRelative());
            } else if (SshRuntimeProvisioner.KIND.equals(context.runtime().getRequest().getProvisionerKind()) && resolver != null) {
                try {
                    resolver.verifyInstallable(context.binding(), context.binding().getCwdRelative());
                } catch (RuntimeBrokerException error) {
                    // Nothing is claimed yet, so the probe verdict is a definite
                    // refusal: surface the workspace_unavailable contract the
                    // Hosted tool turn recognizes instead of the ssh_runtime_*
                    // verdict an unrecognized code would park into Session
                    // recovery. The original verdict stays as the cause.
                    throw WorkspaceExecutionStore.unavailable(error);
                }
            } else {
                throw WorkspaceExecutionStore.unavailable();
            }
        }
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
    public CompletionStage<Void> acknowledgeV2(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference) {
        requireOriginalRuntime(lease, session);
        return delegate.acknowledgeV2(lease, session, reference);
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
        Context context = context(lease, session, false, false, true);
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
        if (!java.util.Set.of(LocalProcessRuntimeProvisioner.KIND, com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner.KIND)
                .contains(context.runtime().getRequest().getProvisionerKind())) {
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
        if (managed(session)) {
            Context selected = context(lease, session, false);
            if (com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner.KIND.equals(selected.runtime().getRequest().getProvisionerKind())
                    && !java.util.Set.of("history", "raw-file-history", "workspace-context").contains(operation.get("kind"))) {
                throw new RuntimeBrokerException(501, "ssh_runtime_control_unsupported",
                        "SSH Runtime supports files and foreground Shell only.", false);
            }
        }
        if (JdbcCsiFilesRetirementGuard.isProfile(session.getScope())) {
            throw new RuntimeBrokerException(501, "csi_control_not_qualified",
                    "Generic CSI runtime controls are not qualified.", false);
        }
        if (ManagedMcpProtocol.isOperation(operation) || ManagedHookProtocol.isOperation(operation)
                || ManagedShellProtocol.isOperation(operation)
                || ManagedMonitorProtocol.isOperation(operation)) {
            if (!managed(session)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if (ManagedHookProtocol.isOperation(operation)) {
                ManagedHookProtocol.validateSession(session, operation);
            } else if (ManagedShellProtocol.isOperation(operation)) {
                ManagedShellProtocol.validateSession(session, operation);
            } else if (ManagedMonitorProtocol.isOperation(operation)) {
                ManagedMonitorProtocol.validateSession(session, operation);
            } else {
                ManagedMcpProtocol.validateSession(session, operation);
            }
            boolean recovery = ManagedMcpProtocol.isRecovery(operation) || ManagedHookProtocol.isRecovery(operation)
                    || ManagedShellProtocol.isRecovery(operation)
                    || ManagedMonitorProtocol.isRecovery(operation);
            Context context = context(lease, session, !recovery, ManagedHookProtocol.isOperation(operation));
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
        String detach = detachKey(context);
        // RELEASING fences later claims; an absent holder needs no physical
        // release unless a mount handback left the worker's detach owed.
        if (context.session().getState() == RuntimeSessionRecord.State.RELEASING
                && !context.runtime().isDrainRequested()
                && !detachOwed.contains(detach)
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
                    detachOwed.remove(detach);
                    return true;
                });
    }

    @Override
    public CompletionStage<Boolean> releaseRetired(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            return CompletableFuture.completedFuture(true);
        }
        Context context = context(lease, session, false);
        RuntimeBindingRecord binding = bindings.findById(context.runtime().getBindingId());
        if (binding != null && binding.getState() == RuntimeBindingRecord.State.LOST) {
            // The LOST family owns this holder; its evidence gate is stricter.
            return CompletableFuture.completedFuture(true);
        }
        boolean proven = binding != null
                && binding.getGeneration() == context.runtime().getGeneration()
                && binding.getState() == RuntimeBindingRecord.State.DRAINING
                && binding.getDrainReceipt() != null
                && binding.getDrainReceipt().matches(binding);
        if (!proven) {
            // Held without proof is a refusal; nothing held is already settled.
            return CompletableFuture.completedFuture(
                    !ownership.isHeld(context.binding(), context.session()));
        }
        ownership.release(context.binding(), context.session());
        detachOwed.remove(detachKey(context));
        return CompletableFuture.completedFuture(true);
    }

    @Override
    public CompletionStage<Boolean> releaseMount(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            return RuntimeTransport.super.releaseMount(lease, session);
        }
        // Only the execution mount: the Session row stays READY so the
        // recovery fleet can still adopt this identity. The worker keeps the
        // installation a re-drive reuses, so the detach stays owed to the
        // later full release, recorded before the holder clears so that
        // release can never take the absent-holder shortcut past it. A
        // RELEASING Session still holding the mount is one whose physical
        // release has not landed yet (a cleanup release that failed at the
        // worker), so it owes the same detach; one with no holder never
        // installed anything and keeps the shortcut.
        Context context = context(lease, session, false);
        if (context.session().getState() == RuntimeSessionRecord.State.READY
                || ownership.isHeld(context.binding(), context.session())) {
            detachOwed.add(detachKey(context));
        }
        ownership.release(context.binding(), context.session());
        return CompletableFuture.completedFuture(true);
    }

    @Override
    public CompletionStage<Void> reclaimMount(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            return CompletableFuture.completedFuture(null);
        }
        Context context = context(lease, session, false);
        if (!ownership.isHeld(context.binding(), context.session())) {
            ownership.claim(context.binding(), context.session());
        }
        return CompletableFuture.completedFuture(null);
    }

    private static String detachKey(Context context) {
        return context.runtime().getBindingId() + '\0' + context.session().getRuntimeGeneration()
                + '\0' + context.session().getRuntimeSessionId();
    }

    private Context context(RuntimeLease lease, RuntimeSession session, boolean authorize) {
        return context(lease, session, authorize, false);
    }

    private Context context(RuntimeLease lease, RuntimeSession session, boolean authorize, boolean hook) {
        return context(lease, session, authorize, hook, false);
    }

    private Context context(RuntimeLease lease, RuntimeSession session, boolean authorize,
            boolean hook, boolean originalCsi) {
        ContextBinding binding;
        if (authorize) {
            var resolved = hook ? resolver.resolveHook(session.getHarnessSessionId(), session.getScope().getLifecycleAuthority())
                    : resolver.resolve(session.getHarnessSessionId(), session.getScope().getLifecycleAuthority());
            if (!resolved.scope().equals(session.getScope())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            binding = resolved.binding();
        } else {
            binding = savedBindings.apply(session.getHarnessSessionId());
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
                        : !(ResidentWorkspaceProfile.selects(runtime.getRequest())
                                || HarnessOwnership.sharesRuntimeSessions(runtime.getRequest())
                                || session.getHarnessSessionId().equals(runtime.getRequest().getIsolationKey())))
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

    private static boolean managed(RuntimeSession session) {
        return WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(session.getScope().getCapabilityDigest())
                || ResidentWorkspaceProfile.selects(session.getScope());
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
