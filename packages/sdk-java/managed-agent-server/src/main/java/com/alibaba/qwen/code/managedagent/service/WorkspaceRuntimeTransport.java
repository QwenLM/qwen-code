package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
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
        return delegate.installContext(context.runtime(), context.session(),
                UUID.nameUUIDFromBytes(session.getRuntimeSessionId().getBytes(StandardCharsets.UTF_8))
                        .toString(), context.binding())
                .thenCompose(ignored -> delegate.activateWorkspace(context.runtime(), context.session(),
                        context.binding(), true))
                .thenAccept(ignored -> {
                    context(lease, session, true);
                    ownership.assertHeld(context.binding(), context.session());
                });
    }

    @Override
    public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference) {
        if (managed(session)) {
            try {
                Context context = context(lease, session, true);
                ownership.assertHeld(context.binding(), context.session());
            } catch (RuntimeException error) {
                // These checks precede HTTP dispatch, so no tool could have started.
                String code = error instanceof RuntimeBrokerException refusal
                        ? refusal.getCode() : "workspace_unavailable";
                return CompletableFuture.completedFuture(Map.of("executionStatus", "not_started",
                        "responseParts", List.of(), "error", Map.of("type", code,
                                "message", "Workspace execution was refused before dispatch.")));
            }
        }
        return delegate.execute(lease, session, reference);
    }

    @Override
    public CompletionStage<Map<String, Object>> status(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference, long afterSequence) {
        return delegate.status(lease, session, reference, afterSequence);
    }

    @Override
    public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference) {
        return delegate.cancel(lease, session, reference);
    }

    @Override
    public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> operation) {
        return delegate.control(lease, session, operation);
    }

    @Override
    public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
        if (!managed(session)) {
            return delegate.release(lease, session);
        }
        Context context = context(lease, session, false);
        return delegate.activateWorkspace(context.runtime(), context.session(), context.binding(), false)
                .thenApply(ignored -> {
                    ownership.release(context.binding(), context.session());
                    return true;
                });
    }

    private Context context(RuntimeLease lease, RuntimeSession session, boolean authorize) {
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
                || !session.getHarnessSessionId().equals(runtime.getRequest().getIsolationKey())
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
