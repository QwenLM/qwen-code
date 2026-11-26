package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;

import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;

final class RuntimeHarnessLifecycle {
    private final RuntimeProvisioner provisioner;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeDrainCoordinator drainCoordinator;
    private final AtomicBoolean closed;

    RuntimeHarnessLifecycle(RuntimeProvisioner provisioner, RuntimeBindingRepository bindingRepository,
            RuntimeDrainCoordinator drainCoordinator, AtomicBoolean closed) {
        this.provisioner = provisioner;
        this.bindingRepository = bindingRepository;
        this.drainCoordinator = drainCoordinator;
        this.closed = closed;
    }

    public boolean supportsDrainedStop() {
        return provisioner.supportsDrainedStop();
    }

    public boolean supportsDrainedStopKind(String kind) {
        return provisioner.supportsDrainedStopKind(kind);
    }

    public boolean supportsDrainedStop(RuntimeBindingRecord binding) {
        return provisioner.supportsDrainedStop(binding);
    }

    public void requestHarnessDrain(String tenantId, String harnessSessionId) {
        requireOpen(closed);
        bindingRepository.requestHarnessDrain(tenantId, harnessSessionId);
    }

    public CompletionStage<Void> drainHarnessSession(String tenantId, String harnessSessionId) {
        return drainCoordinator.drainHarnessSession(tenantId, harnessSessionId);
    }

    public CompletionStage<List<RuntimeDrainReceipt>> drainHarnessReceipts(String tenantId,
            String harnessSessionId) {
        return drainCoordinator.drainHarnessReceipts(tenantId, harnessSessionId);
    }

    public CompletionStage<Void> drainHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority, boolean stoppedOnly) {
        return drainCoordinator.drainHarnessResources(tenantId, harnessSessionId, authority, stoppedOnly);
    }

    public CompletionStage<Void> prepareHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        return drainCoordinator.prepareHarnessResources(tenantId, harnessSessionId, authority);
    }

    public CompletionStage<Void> retireStorageBinding(String tenantId, String storageId,
            String operationId, String bindingId, long generation) {
        return drainCoordinator.retireStorageBinding(tenantId, storageId, operationId, bindingId, generation);
    }
}
