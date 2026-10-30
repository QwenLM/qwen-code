package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.ChildWorkspaceProvider;
import com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceCatalog;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspacePhysicalTransport;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

public final class ManagedRuntimeCoordinator implements RuntimeWarmer {
    private final RuntimeBrokerOperations service;
    private final AgentStateStore store;
    private final WorkspaceRuntimeResolver workspaces;
    private final ChildWorkspaceProvider childWorkspaces;
    private final ResidentWorkspaceCatalog residents;
    private final boolean resident;
    private final SshWorkspaceService ssh;
    private final RuntimeProvisioner localProvisioner;
    private final RuntimeBindingRepository extensionBindings;
    private final WorkspacePhysicalTransport extensionTransport;
    private final java.util.Set<String> retired = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private static final java.util.Set<String> LIFECYCLE_FENCED = java.util.Set.of("CLOSING", "CLOSED", "ARCHIVING", "ARCHIVED", "DELETING", "DELETED");
    public ManagedRuntimeCoordinator(RuntimeBrokerOperations service, AgentStateStore store, WorkspaceRuntimeResolver workspaces,
            ChildWorkspaceProvider childWorkspaces, ResidentWorkspaceCatalog residents, boolean resident,
            SshWorkspaceService ssh, RuntimeProvisioner localProvisioner, RuntimeBindingRepository extensionBindings,
            WorkspacePhysicalTransport extensionTransport) {
        this.service = service;
        this.store = store;
        this.workspaces = workspaces;
        this.childWorkspaces = childWorkspaces;
        this.residents = residents;
        this.resident = resident;
        this.ssh = ssh;
        this.localProvisioner = localProvisioner;
        this.extensionBindings = extensionBindings;
        this.extensionTransport = extensionTransport;
    }
    public static HarnessSessionResolver resolver(AgentStateStore store, WorkspaceRuntimeResolver workspaces,
            ManagedAgentSettings properties, String workspaceId, String workspaceCwd,
            com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore workspaceExecutionStore) {
        var broker = properties.getRuntimeBroker();
        return new HarnessSessionResolver() {
            @Override
            public CompletionStage<RuntimeScope> resolve(String sessionId) {
                return resolveScope(sessionId, false, null);
            }

            @Override
            public CompletionStage<RuntimeScope> resolve(String sessionId,
                    RuntimeLifecycleAuthority authority) {
                return resolveScope(sessionId, false, authority);
            }

            @Override
            public CompletionStage<RuntimeScope> resolveAdmission(
                    String sessionId) {
                return resolveScope(sessionId, true, null);
            }

            @Override
            public CompletionStage<RuntimeScope> resolveAdmission(
                    String sessionId, RuntimeLifecycleAuthority authority) {
                return resolveScope(sessionId, true, authority);
            }

            @Override
            public CompletionStage<String> resolveTenant(String sessionId) {
                return store.findSessionById(sessionId)
                        .map(session -> CompletableFuture.completedFuture(
                                session.tenantId()))
                        .orElseGet(() -> CompletableFuture.failedFuture(
                                new IllegalArgumentException(
                                        "Session is not owned by this"
                                                + " service")));
            }

            private CompletionStage<RuntimeScope> resolveScope(
                    String sessionId, boolean admission,
                    RuntimeLifecycleAuthority authority) {
                SessionRecord session = store.findSessionById(sessionId)
                        .orElse(null);
                if (session == null) {
                    CompletableFuture<RuntimeScope> failed =
                            new CompletableFuture<>();
                    failed.completeExceptionally(new IllegalArgumentException(
                            "Session is not owned by this service"));
                    return failed;
                }
                if (session.workspace() != null) {
                    if (workspaces != null) {
                        if (admission && authority == null) {
                            workspaceExecutionStore.requireExternalExecution(session.workspace());
                        }
                        return CompletableFuture.completedFuture(workspaces.resolve(sessionId, authority).scope());
                    }
                    return CompletableFuture.failedFuture(
                            new RuntimeBrokerException(409,
                                    "workspace_unavailable",
                                    "Hosted Workspace execution is not available.",
                                    false));
                }
                // The durable row is the admission fence for closing/closed,
                // archived and deleted Sessions: unlike the in-process
                // retired set it survives restarts and never accumulates in
                // memory. Only the admission resolve fences: release and the
                // unknown-outcome reconcile run after a close and must still
                // resolve the scope to settle the binding.
                if (admission && LIFECYCLE_FENCED.contains(session.status())) {
                    return CompletableFuture.failedFuture(
                            new RuntimeBrokerException(409,
                                    "runtime_broker_session_closed",
                                    "Harness Session is closed.", false));
                }
                return CompletableFuture.completedFuture(new RuntimeScope(
                        session.tenantId(), workspaceId,
                        broker.getWorkspaceGeneration(),
                        workspaceCwd,
                        properties.getHarness().getCapabilityDigest(),
                        broker.getIsolationClass()));
            }
        };
    }

    @Override
    public boolean isEnabled() {
        return true;
    }

    public void configureExtensions(com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages packages) {
        extensionTransport.configureExtensionPreparation((binding, sessionId, operation) -> {
            String tenant = binding.getRequest().getScope().getTenantId();
            @SuppressWarnings("unchecked")
            var selected = (List<java.util.Map<String, Object>>) operation.get("extensions");
            CompletionStage<java.util.Map<String, java.util.Map<String, String>>> delivery =
                    CompletableFuture.completedFuture(new java.util.LinkedHashMap<>());
            java.util.Map<String, Object> manifests = new java.util.LinkedHashMap<>();
            for (var pin : selected) {
                delivery = delivery.thenCompose(settings -> {
                    var parsed = new com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin(
                            (String) pin.get("extensionId"), ((Number) pin.get("packageRevision")).longValue(),
                            (String) pin.get("packageDigest"), pin.get("settingsRevision") == null ? null
                            : ((Number) pin.get("settingsRevision")).longValue());
                    try {
                        var resolved = packages.resolvePin(tenant, binding.getRequest().getScope().getWorkspaceId(), parsed);
                        var manifest = resolved.descriptor().manifest();
                        java.util.Map<String, Object> metadata = new java.util.LinkedHashMap<>(java.util.Map.of(
                                "schemaVersion", manifest.schemaVersion(), "compilerVersion", manifest.compilerVersion(),
                                "name", manifest.name(), "version", manifest.version(),
                                "target", java.util.Map.of("platform", manifest.target().platform(), "arch", manifest.target().arch()),
                                "components", manifest.components()));
                        if (manifest.sourceType() != null) {
                            metadata.put("sourceType", manifest.sourceType());
                            metadata.put("sourceRevision", manifest.sourceRevision());
                        }
                        manifests.put(parsed.extensionId(), metadata);
                        return installExtensionPackage(tenant, sessionId, binding, parsed.packageDigest(), resolved.archive())
                                .thenApply(ignored -> {
                                    settings.put(parsed.extensionId(), resolved.settings());
                                    return settings;
                                });
                    } catch (IOException error) {
                        return CompletableFuture.failedFuture(error);
                    }
                });
            }
            return delivery.thenApply(settings -> {
                java.util.Map<String, Object> prepared = new java.util.LinkedHashMap<>(operation);
                prepared.put("settings", settings);
                prepared.put("packageManifests", manifests);
                prepared.put("toolProfile", store.requireSession(tenant, sessionId).toolProfile());
                return prepared;
            });
        });
    }

    private CompletionStage<java.util.Map<String, Object>> installExtensionPackage(String tenantId,
            String sessionId, com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord expected, String digest, Path archive) {
        SessionRecord session = store.requireSession(tenantId, sessionId);
        var binding = extensionBindings.findById(expected.getBindingId());
        if (binding == null || binding.getGeneration() != expected.getGeneration()
                || !binding.getRequest().equals(expected.getRequest())
                || !java.util.Objects.equals(binding.getProvisionSeed(), expected.getProvisionSeed())
                || !sameExtensionLease(binding.getLease(), expected.getLease())
                || binding.getState() != com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY
                || binding.isDrainRequested() || binding.getLease() == null || session.workspace() == null
                || !tenantId.equals(binding.getRequest().getScope().getTenantId())
                || !session.workspace().getWorkspaceId().equals(binding.getRequest().getScope().getWorkspaceId())
                || !"session".equals(binding.getRequest().getScope().getIsolationClass())
                || !sessionId.equals(binding.getRequest().getIsolationKey())) {
            return CompletableFuture.failedFuture(com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable());
        }
        return extensionTransport.installExtensionPackage(binding, digest, archive).thenApply(result -> {
            var current = extensionBindings.findById(expected.getBindingId());
            if (current == null || current.getGeneration() != binding.getGeneration()
                    || !current.getRequest().equals(binding.getRequest())
                    || !java.util.Objects.equals(current.getProvisionSeed(), binding.getProvisionSeed())
                    || current.getState() != com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY
                    || current.isDrainRequested() || !sameExtensionLease(current.getLease(), binding.getLease())) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            return result;
        });
    }

    private static boolean sameExtensionLease(RuntimeLease left, RuntimeLease right) {
        return left != null && right != null && left.getRuntimeInstanceId().equals(right.getRuntimeInstanceId())
                && left.getLeaseId().equals(right.getLeaseId()) && left.getEpoch() == right.getEpoch()
                && left.getEndpoint().equals(right.getEndpoint()) && left.getToken().equals(right.getToken());
    }

    @Override
    public CompletionStage<Void> warm(String sessionId) {
        if (retired.contains(sessionId)) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(new RuntimeBrokerException(409,
                    "runtime_broker_session_closed",
                    "Harness Session is closed.", false));
            return failed;
        }
        return service.warm(sessionId).thenApply(ignored -> null);
    }

    @Override
    public CompletionStage<Void> drain(String sessionId) {
        // drain() runs while the row still reads CLOSING/DELETING; the
        // admission resolve fences every lifecycle status durably, so only
        // a vanished row needs the in-process entry.
        if (store.findSessionById(sessionId).isEmpty()) {
            retired.add(sessionId);
        }
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public boolean supportsWorkspaceClose() {
        return service.supportsDrainedStop() || resident;
    }

    @Override
    public boolean supportsWorkspaceContextChange(ContextBinding binding) {
        return residents.find(binding) == null;
    }

    @Override
    public boolean supportsWorkspaceClose(com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding binding) {
        if (resident && residents.find(binding) != null) {
            return true;
        }
        if (binding != null && ssh != null && ssh.runtimeStorage(binding) != null) {
            ssh.node(ssh.runtimeStorage(binding).nodeId());
            return true;
        }
        return localProvisioner.supportsDrainedStop();
    }

    @Override
    public void requestWorkspaceClose(String tenantId, String sessionId) {
        service.requestHarnessDrain(tenantId, sessionId);
    }

    @Override
    public CompletionStage<Void> closeWorkspace(String tenantId, String sessionId) {
        var session = store.findSessionById(sessionId).orElse(null);
        if (resident) {
            if (session == null || !tenantId.equals(session.tenantId()) || residents.find(session.workspace()) == null) {
                return CompletableFuture.failedFuture(com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable());
            }
            return service.closeResidentHarnessSession(residents.request(session.workspace()), sessionId);
        }
        return service.drainHarnessSession(tenantId, sessionId);
    }

    @Override
    public CompletionStage<Void> drainWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return service.drainHarnessResources(tenantId, sessionId, authority, false);
    }

    @Override
    public CompletionStage<Void> prepareWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return service.prepareHarnessResources(tenantId, sessionId, authority);
    }

    @Override
    public CompletionStage<Void> recoverStoppedWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return service.drainHarnessResources(tenantId, sessionId, authority, true);
    }

    @Override
    public ChildWorkspaceProvider childWorkspaces() {
        return childWorkspaces;
    }

    @Override
    public void verifyWorkspaceCwdTarget(ContextBinding binding,
            String targetCwdRelative) {
        if (workspaces == null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        workspaces.verifyInstallable(binding, targetCwdRelative);
    }
}
