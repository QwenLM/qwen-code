package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;

import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiFunction;
import java.util.function.Function;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;

final class RuntimeHarnessLifecycle {
    private final RuntimeProvisioner provisioner;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeDrainCoordinator drainCoordinator;
    private final AtomicBoolean closed;
    private final Function<String, CompletionStage<RuntimeScope>> scopeResolver;
    private final BiFunction<RuntimeScope, String, RuntimeProvisionRequest> provisionRequest;

    RuntimeHarnessLifecycle(RuntimeProvisioner provisioner, RuntimeBindingRepository bindingRepository,
            RuntimeDrainCoordinator drainCoordinator, AtomicBoolean closed,
            Function<String, CompletionStage<RuntimeScope>> scopeResolver,
            BiFunction<RuntimeScope, String, RuntimeProvisionRequest> provisionRequest) {
        this.provisioner = provisioner;
        this.bindingRepository = bindingRepository;
        this.drainCoordinator = drainCoordinator;
        this.closed = closed;
        this.scopeResolver = scopeResolver;
        this.provisionRequest = provisionRequest;
    }

    public CompletionStage<RuntimeBindingRecord> findBindingForHarnessSession(
            String tenantId, String harnessSessionId) {
        requireOpen(closed);
        String harnessId = BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        return scopeResolver.apply(harnessId).thenApply(scope -> {
            if (!scope.getTenantId().equals(tenantId)) {
                throw conflict("runtime_session_conflict",
                        "Harness Session belongs to another tenant");
            }
            return bindingRepository.findLatestForRequest(provisionRequest.apply(scope, harnessId));
        });
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
