package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.Supplier;

/** Places one Session-isolated generation on a trusted SSH host. */
public final class SshRuntimeProvisioner implements RuntimeProvisioner {
    public static final String KIND = "ssh-process";
    private static final Set<String> HANDLE_FIELDS = Set.of("nodeId", "resourceId", "storageId", "mountRoot", "registration");
    private static final Set<String> PROOF_FIELDS = Set.of("version", "resourceId", "bindingId", "bindingGeneration",
            "provisionRequestId", "runtimeInstanceId", "runtimeIncarnation", "leaseId", "epoch", "retirementId", "retiredAt");
    private final Function<String, SshRuntimeNode> nodes;
    private final Function<RuntimeScope, SshRuntimeStorage> storages;
    private final SshConnectionManager connections;
    private final HttpRuntimeTransport transport;
    private final ExecutorService executor = new ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(64), Thread.ofPlatform().daemon().name("runtime-ssh-provisioner-", 0).factory());
    private final ConcurrentMap<List<Object>, Owned> owned = new ConcurrentHashMap<>();
    private volatile boolean closed;

    public SshRuntimeProvisioner(Function<String, SshRuntimeNode> nodes,
            Function<RuntimeScope, SshRuntimeStorage> storages, SshConnectionManager connections,
            HttpRuntimeTransport transport) {
        this.nodes = java.util.Objects.requireNonNull(nodes, "nodes");
        this.storages = java.util.Objects.requireNonNull(storages, "storages");
        this.connections = java.util.Objects.requireNonNull(connections, "connections");
        this.transport = java.util.Objects.requireNonNull(transport, "transport");
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
        SshRuntimeStorage storage = storage(scope);
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope, isolationKey, KIND, storage.storageId());
        requireRequest(request);
        return request;
    }

    @Override
    public void reserveResource(RuntimeBindingRecord binding) {
        requireRequest(binding.getRequest());
        SshRuntimeStorage storage = storage(binding.getRequest().getScope());
        node(storage.nodeId());
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
        return CompletableFuture.failedFuture(conflict());
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        return submit(() -> {
            RuntimeResourceHandle handle = handle(request, seed);
            if (knownHandle != null && (!supported(knownHandle)
                    || !BrokerValues.sameJsonMap(knownHandle.getValue(), handle.getValue()))) {
                throw conflict();
            }
            if (knownHandle != null) {
                handle = knownHandle;
            }
            var result = connections.bootstrap(node(text(handle, "nodeId")), ensure(request, seed, handle, false));
            verifyResource(result, handle);
            return handle;
        });
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return submit(() -> {
            RuntimeResourceHandle handle = handle(request, seed);
            SshRuntimeNode node = node(text(handle, "nodeId"));
            Map<String, Object> result = awaitStartup(node, handle,
                    connections.bootstrap(node, ensure(request, seed, handle, true)));
            if (!"READY".equals(result.get("state"))) {
                throw new RuntimeBrokerException(503, "ssh_runtime_start_pending",
                        "Original SSH worker has not completed startup.", true);
            }
            return ready(request, seed, handle, node, result, null);
        });
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return submit(() -> {
            requireHandle(request, seed, handle);
            SshRuntimeNode node = node(text(handle, "nodeId"));
            Map<String, Object> result = awaitStartup(node, handle,
                    connections.bootstrap(node, operation(node, handle, "observe")));
            return switch ((String) result.get("state")) {
                case "READY" -> {
                    RuntimeLease lease = ready(request, seed, handle, node, result, lastLease);
                    yield RuntimeObservation.ready(handle, lease.getEndpoint(), lease.getRuntimeInstanceId(),
                            lease.getLeaseId(), lease.getEpoch());
                }
                case "INTENT", "STARTING" -> RuntimeObservation.starting(handle);
                default -> RuntimeObservation.unknown(handle);
            };
        });
    }

    @Override
    public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return supported(handle);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        return submit(() -> {
            Owned original = owned.get(leaseKey(lease));
            if (original == null || !original.request().equals(request)) {
                throw conflict();
            }
            transport.attest(lease, request, original.seed()).toCompletableFuture().join();
            return null;
        });
    }

    @Override
    public boolean canRetryFailedConfirm(RuntimeLease lease) {
        return isUsable(lease);
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        return !closed && owned.containsKey(leaseKey(lease));
    }

    @Override
    public boolean supportsDrainedStop() {
        return true;
    }

    @Override
    public boolean supportsDrainedStop(RuntimeBindingRecord binding) {
        return binding != null && KIND.equals(binding.getRequest().getProvisionerKind())
                && binding.getRequest().isManagedContext()
                && WorkspaceExecutionProfile.admitsIsolationClass(binding.getRequest().getScope().getIsolationClass())
                && WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(binding.getRequest().getScope().getCapabilityDigest());
    }

    @Override
    public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
        if (!supportsDrainedStop(binding) || !binding.isDrainRequested() || binding.getProvisionSeed() == null) {
            return RuntimeProvisioner.super.stopDrained(binding);
        }
        return submit(() -> {
            RuntimeResourceHandle handle = binding.getResourceHandle() == null
                    ? handle(binding.getRequest(), binding.getProvisionSeed()) : binding.getResourceHandle();
            requireHandle(binding.getRequest(), binding.getProvisionSeed(), handle);
            SshRuntimeNode node = node(text(handle, "nodeId"));
            if (binding.getResourceHandle() == null) {
                verifyResource(connections.bootstrap(node, ensure(binding.getRequest(),
                        binding.getProvisionSeed(), handle, false)), handle);
            }
            String retirementId = UUID.nameUUIDFromBytes(("ssh-runtime-retire/1:" + text(handle, "resourceId"))
                    .getBytes(StandardCharsets.UTF_8)).toString();
            Map<String, Object> command = new LinkedHashMap<>(operation(node, handle, "stop"));
            command.put("retirementId", retirementId);
            Map<String, Object> result = connections.bootstrap(node, Map.copyOf(command));
            verifyResource(result, handle);
            if (!"RETIRED".equals(result.get("state")) || !(result.get("cleanProof") instanceof Map<?, ?> proof)) {
                throw stopUnconfirmed();
            }
            RuntimeProvisionSeed seed = binding.getProvisionSeed();
            if (!proof.keySet().equals(PROOF_FIELDS)
                    || !number(proof.get("version"), 1)
                    || !text(handle, "resourceId").equals(proof.get("resourceId"))
                    || !binding.getBindingId().equals(proof.get("bindingId"))
                    || !number(proof.get("bindingGeneration"), binding.getGeneration())
                    || !seed.getProvisionRequestId().equals(proof.get("provisionRequestId"))
                    || !seed.getProvisionalRuntimeId().equals(proof.get("runtimeInstanceId"))
                    || !seed.getGatewayIncarnation().equals(proof.get("runtimeIncarnation"))
                    || !seed.getLeaseId().equals(proof.get("leaseId"))
                    || !number(proof.get("epoch"), seed.getEpoch())
                    || !retirementId.equals(proof.get("retirementId"))
                    || !(proof.get("retiredAt") instanceof String retiredAt)) {
                throw conflict();
            }
            Instant stoppedAt;
            try {
                stoppedAt = Instant.parse(retiredAt);
            } catch (RuntimeException failure) {
                throw conflict();
            }
            if (binding.getLease() != null) {
                owned.remove(leaseKey(binding.getLease()));
                connections.forget(binding.getLease());
            }
            return new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                    seed.getProvisionRequestId(), handle, stoppedAt);
        });
    }

    @Override
    public void close() {
        closed = true;
        // Let queued control futures run their closed checks instead of abandoning them.
        executor.shutdown();
        owned.clear();
        connections.close();
    }

    private <T> CompletionStage<T> submit(Supplier<T> operation) {
        try {
            return CompletableFuture.supplyAsync(operation, executor);
        } catch (RejectedExecutionException full) {
            return CompletableFuture.failedFuture(new RuntimeBrokerException(503, "ssh_runtime_busy",
                    "SSH Runtime control capacity is unavailable.", true));
        }
    }

    private RuntimeLease ready(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, SshRuntimeNode node, Map<String, Object> result, RuntimeLease lastLease) {
        if (!(result.get("ready") instanceof Map<?, ?> raw)) {
            throw conflict();
        }
        URI endpoint = ManagedContextProtocol.ready(object(raw), ManagedContextProtocol.boot(request, seed));
        RuntimeLease lease = new RuntimeLease(seed.getProvisionalRuntimeId(), endpoint, seed.getToken(),
                seed.getLeaseId(), seed.getEpoch());
        if (lastLease != null && (!seed.matches(lastLease) || !lastLease.getEndpoint().equals(lease.getEndpoint()))) {
            throw conflict();
        }
        connections.register(lease, node);
        transport.attest(lease, request, seed).toCompletableFuture().join();
        owned.put(leaseKey(lease), new Owned(request, seed));
        return lease;
    }

    private Map<String, Object> awaitStartup(SshRuntimeNode node, RuntimeResourceHandle handle, Map<String, Object> result) {
        long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        verifyResource(result, handle);
        while ("STARTING".equals(result.get("state")) && System.nanoTime() < deadline) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                throw new RuntimeBrokerException(503, "ssh_runtime_start_pending", "Original SSH worker startup was interrupted.", true, failure);
            }
            result = connections.bootstrap(node, operation(node, handle, "observe"));
            verifyResource(result, handle);
        }
        if ("STARTING".equals(result.get("state"))) {
            throw new RuntimeBrokerException(503, "ssh_runtime_start_pending", "Original SSH worker has not completed startup.", true);
        }
        if ("RETIRED".equals(result.get("state"))) {
            throw new RuntimeBrokerException(409, "ssh_runtime_recovery_blocked", "Original SSH worker has already retired.", false);
        }
        if ("FAILED".equals(result.get("state"))) {
            throw new RuntimeBrokerException(409, "ssh_runtime_launch_failed",
                    "Original SSH launch failed before creating a worker and can only be retired.", false);
        }
        return result;
    }

    private RuntimeResourceHandle handle(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        requireRequest(request);
        if (seed == null || closed) {
            throw conflict();
        }
        SshRuntimeStorage storage = storage(request.getScope());
        if (!storage.storageId().equals(request.getStorageId())) {
            throw conflict();
        }
        node(storage.nodeId());
        String resourceId = UUID.nameUUIDFromBytes(("ssh-runtime-resource/1:" + seed.getProvisionRequestId())
                .getBytes(StandardCharsets.UTF_8)).toString();
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("nodeId", storage.nodeId());
        value.put("resourceId", resourceId);
        value.put("storageId", storage.storageId());
        value.put("mountRoot", storage.mountRoot());
        value.put("registration", storage.registration());
        return new RuntimeResourceHandle(KIND, 1, value);
    }

    private void requireHandle(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
        if (!supported(handle) || !BrokerValues.sameJsonMap(handle(request, seed).getValue(), handle.getValue())) {
            throw conflict();
        }
    }

    private Map<String, Object> ensure(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, boolean launch) {
        SshRuntimeNode node = node(text(handle, "nodeId"));
        Map<String, Object> command = new LinkedHashMap<>(operation(node, handle, "ensure"));
        Map<String, Object> registration = object((Map<?, ?>) handle.getValue().get("registration"));
        command.put("bindingId", seed.getProvisionalRuntimeId());
        command.put("bindingGeneration", seed.getEpoch());
        command.put("boot", ManagedContextProtocol.boot(request, seed));
        command.put("identity", registration.get("identity"));
        command.put("marker", registration.get("marker"));
        command.put("expectedQwenVersion", registration.get("qwenVersion"));
        command.put("workerEntry", node.qwenEntry());
        command.put("launch", launch);
        return Map.copyOf(command);
    }

    private static Map<String, Object> operation(SshRuntimeNode node, RuntimeResourceHandle handle, String operation) {
        return Map.of("protocolVersion", 1, "operation", operation, "nodeId", node.nodeId(),
                "stateDirectory", node.stateDirectory(), "resourceId", text(handle, "resourceId"));
    }

    private static void verifyResource(Map<String, Object> result, RuntimeResourceHandle handle) {
        if (!text(handle, "resourceId").equals(result.get("resourceId"))
                || !(result.get("state") instanceof String state)
                || !Set.of("INTENT", "STARTING", "READY", "BLOCKED", "FAILED", "RETIRED").contains(state)) {
            throw conflict();
        }
        if ("BLOCKED".equals(state)) {
            throw new RuntimeBrokerException(409, "ssh_runtime_recovery_blocked",
                    "Original SSH worker cannot be replaced or recovered automatically.", false);
        }
    }

    private static void requireRequest(RuntimeProvisionRequest request) {
        if (request == null || !KIND.equals(request.getProvisionerKind()) || !request.isManagedContext()
                || !WorkspaceExecutionProfile.admitsIsolationClass(request.getScope().getIsolationClass())
                || !WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(request.getScope().getCapabilityDigest())) {
            throw conflict();
        }
    }

    private SshRuntimeStorage storage(RuntimeScope scope) {
        SshRuntimeStorage storage = storages.apply(scope);
        if (storage == null || !scope.getCanonicalCwd().equals(storage.mountRoot())) {
            throw conflict();
        }
        return storage;
    }

    private SshRuntimeNode node(String nodeId) {
        SshRuntimeNode node = nodes.apply(nodeId);
        if (node == null || !nodeId.equals(node.nodeId())) {
            throw conflict();
        }
        return node;
    }

    private static boolean supported(RuntimeResourceHandle handle) {
        return handle != null && KIND.equals(handle.getKind()) && handle.getVersion() == 1
                && handle.getValue().keySet().equals(HANDLE_FIELDS);
    }

    private static String text(RuntimeResourceHandle handle, String key) {
        if (!(handle.getValue().get(key) instanceof String value)) {
            throw conflict();
        }
        return value;
    }

    private static Map<String, Object> object(Map<?, ?> raw) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (var entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw conflict();
            }
            result.put(key, entry.getValue());
        }
        return BrokerValues.immutableMap(result);
    }

    private static boolean number(Object value, long expected) {
        return Long.valueOf(expected).equals(BrokerValues.exactLong(value));
    }

    private static List<Object> leaseKey(RuntimeLease lease) {
        return List.of(lease.getRuntimeInstanceId(), lease.getEndpoint(), lease.getToken(),
                lease.getLeaseId(), lease.getEpoch());
    }

    private static RuntimeBrokerException conflict() {
        return new RuntimeBrokerException(409, "ssh_runtime_identity_conflict", "SSH Runtime placement identity conflicts.", false);
    }

    private static RuntimeBrokerException stopUnconfirmed() {
        return new RuntimeBrokerException(503, "ssh_runtime_stop_unconfirmed", "Original SSH worker stop is not confirmed.", true);
    }

    private record Owned(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
    }
}
