package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

final class WorkspaceRuntimeProvisioner implements RuntimeProvisioner {
    private final RuntimeProvisioner delegate;
    private final WorkspaceRuntimeResolver resolver;
    private final WorkspaceExecutionStore executionStore;

    WorkspaceRuntimeProvisioner(RuntimeProvisioner delegate, WorkspaceRuntimeResolver resolver,
            WorkspaceExecutionStore executionStore) {
        this.delegate = delegate;
        this.resolver = resolver;
        this.executionStore = executionStore;
    }

    @Override
    public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
        if (!WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(scope.getCapabilityDigest())) {
            return delegate.createRequest(scope, isolationKey);
        }
        var resolved = resolver.resolve(isolationKey);
        if (!resolved.scope().equals(scope)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return new RuntimeProvisionRequest(scope, isolationKey, kind(), resolved.binding().getStorageId());
    }

    @Override
    public String kind() {
        return delegate.kind();
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
        requireReady(request);
        return delegate.provision(request);
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        requireReady(request);
        return delegate.provision(request, seed);
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        requireReady(request);
        return delegate.ensureResource(request, seed, knownHandle);
    }

    private void requireReady(RuntimeProvisionRequest request) {
        if (!request.isManagedContext() || !executionStore.verifiedRecoveryEnabled()) {
            return;
        }
        var resolved = resolver.resolve(request.getIsolationKey());
        if (!resolved.scope().equals(request.getScope())
                || !resolved.binding().getStorageId().equals(request.getStorageId())) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return delegate.reconcile(request, seed, handle, lastLease);
    }

    @Override
    public boolean supportsDrainedStop() {
        return delegate.supportsDrainedStop();
    }

    @Override
    public CompletionStage<com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
        if (executionStore.hasHolder(binding)) {
            return CompletableFuture.failedFuture(new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(
                    409, "workspace_close_execution_unsettled", "Original Workspace holder remains.", false));
        }
        return delegate.stopDrained(binding);
    }

    @Override
    public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return delegate.supportsStartupRecovery(handle);
    }

    @Override
    public CompletionStage<Void> recoverResources(RuntimeBindingRecord binding) {
        if (!binding.getRequest().isManagedContext()) {
            return delegate.recoverResources(binding);
        }
        executionStore.releaseLost(binding);
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        return delegate.confirm(request, lease);
    }

    @Override
    public boolean canRetryFailedConfirm(RuntimeLease lease) {
        return delegate.canRetryFailedConfirm(lease);
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
        return delegate.release(request, lease);
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        return delegate.isUsable(lease);
    }

    @Override
    public void close() {
        delegate.close();
    }
}
