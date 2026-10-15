package com.alibaba.qwen.code.runtimebroker;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.Function;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/** Dispatches saved provider identity without changing placement or lease identity. */
public final class RoutingRuntimeProvisioner implements RuntimeProvisioner {
    private final Map<String, RuntimeProvisioner> delegates;
    private final Function<RuntimeScope, String> kindSelector;
    private final BiConsumer<String, RuntimeLease> leaseRegistrar;
    private final Consumer<RuntimeLease> leaseReleaser;
    private final ConcurrentMap<List<Object>, String> issued = new ConcurrentHashMap<>();

    public RoutingRuntimeProvisioner(Map<String, RuntimeProvisioner> delegates,
            Function<RuntimeScope, String> kindSelector) {
        this(delegates, kindSelector, (kind, lease) -> {});
    }

    public RoutingRuntimeProvisioner(Map<String, RuntimeProvisioner> delegates,
            Function<RuntimeScope, String> kindSelector, BiConsumer<String, RuntimeLease> leaseRegistrar) {
        this(delegates, kindSelector, leaseRegistrar, lease -> {});
    }

    public RoutingRuntimeProvisioner(Map<String, RuntimeProvisioner> delegates,
            Function<RuntimeScope, String> kindSelector, BiConsumer<String, RuntimeLease> leaseRegistrar,
            Consumer<RuntimeLease> leaseReleaser) {
        this.delegates = Map.copyOf(delegates);
        this.kindSelector = java.util.Objects.requireNonNull(kindSelector, "kindSelector");
        this.leaseRegistrar = java.util.Objects.requireNonNull(leaseRegistrar, "leaseRegistrar");
        this.leaseReleaser = java.util.Objects.requireNonNull(leaseReleaser, "leaseReleaser");
        if (delegates.isEmpty() || delegates.entrySet().stream()
                .anyMatch(entry -> !entry.getValue().supportsKind(entry.getKey()))) {
            throw new IllegalArgumentException("Each routed provider must own its exact kind");
        }
    }

    @Override
    public String kind() {
        return "routing";
    }

    @Override
    public boolean supportsKind(String kind) {
        return delegates.containsKey(kind) && delegates.get(kind).supportsKind(kind);
    }

    @Override
    public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
        String selected = kindSelector.apply(scope);
        RuntimeProvisionRequest request = provider(selected).createRequest(scope, isolationKey);
        if (!selected.equals(request.getProvisionerKind())) {
            throw conflict();
        }
        return request;
    }

    @Override
    public void reserveResource(RuntimeBindingRecord binding) {
        provider(binding.getRequest()).reserveResource(binding);
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
        return provider(request).provision(request).thenApply(lease -> remember(request, lease));
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return provider(request).provision(request, seed).thenApply(lease -> remember(request, lease));
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        requireHandleKind(request, knownHandle);
        return provider(request).ensureResource(request, seed, knownHandle).thenApply(handle -> {
            requireHandleKind(request, handle);
            return handle;
        });
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lastLease) {
        requireHandleKind(request, handle);
        return provider(request).reconcile(request, seed, handle, lastLease).thenApply(observation -> {
            if (observation != null && observation.getOutcome() == RuntimeObservation.Outcome.READY) {
                remember(request, new RuntimeLease(observation.getRuntimeInstanceId(), observation.getEndpoint(),
                        seed.getToken(), observation.getLeaseId(), observation.getEpoch()));
            }
            return observation;
        });
    }

    @Override
    public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return handle != null && supportsKind(handle.getKind())
                && provider(handle.getKind()).supportsStartupRecovery(handle);
    }

    @Override
    public boolean supportsDrainedStop() {
        return delegates.values().stream().allMatch(RuntimeProvisioner::supportsDrainedStop);
    }

    @Override
    public boolean supportsDrainedStop(RuntimeBindingRecord binding) {
        return binding != null && supportsKind(binding.getRequest().getProvisionerKind())
                && provider(binding.getRequest()).supportsDrainedStop(binding);
    }

    @Override
    public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
        return provider(binding.getRequest()).stopDrained(binding).thenApply(receipt -> {
            if (receipt != null && receipt.matches(binding) && binding.getLease() != null) {
                issued.remove(leaseKey(binding.getLease()), binding.getRequest().getProvisionerKind());
                leaseReleaser.accept(binding.getLease());
            }
            return receipt;
        });
    }

    @Override
    public CompletionStage<Void> recoverResources(RuntimeBindingRecord binding) {
        return provider(binding.getRequest()).recoverResources(binding);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        return provider(request).confirm(request, lease);
    }

    @Override
    public boolean canRetryFailedConfirm(RuntimeLease lease) {
        String kind = issued.get(leaseKey(lease));
        return kind != null && provider(kind).canRetryFailedConfirm(lease);
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        String kind = issued.get(leaseKey(lease));
        return kind != null && provider(kind).isUsable(lease);
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
        RuntimeProvisioner delegate = provider(request);
        return delegate.release(request, lease).thenRun(() -> {
            if (!delegate.isUsable(lease)) {
                issued.remove(leaseKey(lease), request.getProvisionerKind());
                leaseReleaser.accept(lease);
            }
        });
    }

    @Override
    public void close() {
        for (RuntimeProvisioner delegate : new LinkedHashSet<>(delegates.values())) {
            delegate.close();
        }
        issued.clear();
    }

    private RuntimeLease remember(RuntimeProvisionRequest request, RuntimeLease lease) {
        String previous = issued.putIfAbsent(leaseKey(lease), request.getProvisionerKind());
        if (previous != null && !previous.equals(request.getProvisionerKind())) {
            throw conflict();
        }
        leaseRegistrar.accept(request.getProvisionerKind(), lease);
        return lease;
    }

    private RuntimeProvisioner provider(RuntimeProvisionRequest request) {
        return provider(request.getProvisionerKind());
    }

    private RuntimeProvisioner provider(String kind) {
        RuntimeProvisioner delegate = kind == null ? null : delegates.get(kind);
        if (delegate == null || !delegate.supportsKind(kind)) {
            throw conflict();
        }
        return delegate;
    }

    private static void requireHandleKind(RuntimeProvisionRequest request, RuntimeResourceHandle handle) {
        if (handle != null && !request.getProvisionerKind().equals(handle.getKind())) {
            throw conflict();
        }
    }

    private static List<Object> leaseKey(RuntimeLease lease) {
        return List.of(lease.getRuntimeInstanceId(), lease.getEndpoint(), lease.getToken(),
                lease.getLeaseId(), lease.getEpoch());
    }

    private static RuntimeBrokerException conflict() {
        return new RuntimeBrokerException(409, "runtime_broker_resource_conflict",
                "Saved Runtime provider identity is unavailable or conflicts.", false);
    }
}
