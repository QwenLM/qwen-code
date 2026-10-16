package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.managedagent.store.ResidentWorkspaces;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletionStage;

final class ResidentWorkspaceProvisioner implements RuntimeProvisioner {
    private final ResidentWorkspaces residents;
    private final Map<ResidentWorkspace, WorkspaceCsiRuntimeProvisioner> providers = new LinkedHashMap<>();

    ResidentWorkspaceProvisioner(ManagedAgentProperties properties, JdbcTemplate jdbc,
            PlatformTransactionManager manager, JdbcRuntimeBindingRepository bindings) {
        var config = properties.getRuntimeBroker();
        residents = new ResidentWorkspaces(config.getResidentWorkspaces());
        if (config.getResidentWorkspaces().isEmpty() || !"workspace".equals(config.getIsolationClass())
                || config.isTrustedLocalRebootRecovery() || config.isVerifiedWorkspaceRecoveryEnabled()
                || config.isChildWorkspacesEnabled() || !config.getWorkspaceMounts().isEmpty()
                || !properties.getHarness().isWorkspaceFilesEnabled() || properties.getHarness().isWorkspaceShellEnabled()
                || config.getResidentKubernetesApiUrl().isBlank() || config.getResidentKubernetesTokenFile().isBlank()
                || config.getResidentKubernetesCaFile().isBlank() || !bindings.usesDataSource(jdbc.getDataSource())) {
            throw new IllegalStateException("Resident Workspace requires exclusive CSI/files configuration");
        }
        var api = new KubernetesHttpRuntimeClient(URI.create(config.getResidentKubernetesApiUrl()),
                Path.of(config.getResidentKubernetesTokenFile()), Path.of(config.getResidentKubernetesCaFile()));
        var storage = new WorkspaceCsiReservationStore(jdbc, manager, new com.fasterxml.jackson.databind.ObjectMapper());
        for (var selected : config.getResidentWorkspaces()) {
            ResidentWorkspaces.requireRegistration(jdbc, selected);
            var guard = new WorkspaceCsiResourceGuard(api, selected.registration().clusterDomain(),
                    selected.registration(), selected.protection());
            providers.put(selected, new WorkspaceCsiRuntimeProvisioner(storage, bindings, selected.registration(),
                    api, guard, selected.image(), selected.command(), Duration.ofSeconds(30), selected.artifacts()));
        }
    }

    private WorkspaceCsiRuntimeProvisioner selected(RuntimeProvisionRequest request) {
        var mapping = residents.require(request.getScope());
        if (request.getIsolationKey() != null || !mapping.registration().storageId().equals(request.getStorageId())
                || !kind().equals(request.getProvisionerKind())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return providers.get(mapping);
    }

    @Override
    public String kind() { return WorkspaceCsiReservationStore.PROVISIONER_KIND; }

    @Override
    public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
        var mapping = residents.require(scope);
        if (isolationKey != null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return new RuntimeProvisionRequest(scope, null, kind(), mapping.registration().storageId());
    }

    @Override
    public void reserveResource(RuntimeBindingRecord binding) { selected(binding.getRequest()).reserveResource(binding); }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) { return selected(request).provision(request); }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return selected(request).provision(request, seed);
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle) { return selected(request).ensureResource(request, seed, handle); }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lease) { return selected(request).reconcile(request, seed, handle, lease); }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) { return selected(request).confirm(request, lease); }

    @Override
    public boolean isUsable(RuntimeLease lease) { return providers.values().stream().anyMatch(value -> value.isUsable(lease)); }

    @Override
    public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return providers.values().stream().anyMatch(value -> value.supportsStartupRecovery(handle));
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
        return java.util.concurrent.CompletableFuture.failedFuture(WorkspaceExecutionStore.unavailable());
    }

    @Override
    public void close() { providers.values().forEach(WorkspaceCsiRuntimeProvisioner::close); }
}
