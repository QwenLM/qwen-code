package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import java.util.concurrent.CompletionStage;

final class WorkspaceRuntimeProvisioner implements RuntimeProvisioner {
    private final RuntimeProvisioner delegate;
    private final WorkspaceRuntimeResolver resolver;

    WorkspaceRuntimeProvisioner(RuntimeProvisioner delegate, WorkspaceRuntimeResolver resolver) {
        this.delegate = delegate;
        this.resolver = resolver;
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
        return delegate.provision(request);
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return delegate.provision(request, seed);
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        return delegate.ensureResource(request, seed, knownHandle);
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return delegate.reconcile(request, seed, handle, lastLease);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        return delegate.confirm(request, lease);
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
