package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import org.apache.commons.codec.digest.DigestUtils;

import java.net.URI;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Session-exclusive scratch workers placed by an operator-run HTTP provider.
 *
 * <p>The provider receives the Broker-minted boot document, echoes the logical
 * request handle and reports the worker's HTTP(S) origin. The Broker keeps every
 * identity decision: the handle is bound to a digest of the token-free boot
 * document, and every endpoint is attested before use. Like the Kubernetes
 * scratch provider, {@link #release} is never treated as authority to stop a
 * worker another Broker may own.
 *
 * <p>This class also owns the transport, identity and recovery mechanics shared
 * by the external kind family ({@link ExternalRuntimeKinds}). The default
 * profile is {@code external-scratch}: it refuses managed-context (registered
 * Workspace) requests. {@link ExternalWorkspaceProvisioner} overrides only the
 * profile hooks — the boot document, the profile admission rules and the
 * storage evidence — so the two kinds cannot drift apart in placement,
 * recovery, idempotency or release semantics.
 */
public class ExternalRuntimeProvisioner implements RuntimeProvisioner {
    public static final String KIND = "external-scratch";
    static final int MAX_PLACEMENTS = 1024;
    private static final int HANDLE_VERSION = 1;
    private static final int BOOT_LIMIT = 32 * 1024;
    private final ExternalRuntimeClient client;
    private final String providerId;
    private final Duration startupTimeout;
    private final HttpRuntimeTransport transport = new HttpRuntimeTransport();
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final Map<RuntimeProvisionSeed, Placement> placements = new ConcurrentHashMap<>();
    private final Map<List<Object>, Placement> placementsByLease = new ConcurrentHashMap<>();

    public ExternalRuntimeProvisioner(ExternalRuntimeClient client, String providerId, Duration startupTimeout) {
        if (client == null || startupTimeout == null || startupTimeout.isNegative() || startupTimeout.isZero()) {
            throw new IllegalArgumentException("Client and positive startup timeout are required");
        }
        this.client = client;
        this.providerId = BrokerValues.requireId(providerId, "providerId");
        this.startupTimeout = startupTimeout;
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
        return CompletableFuture.failedFuture(conflict());
    }

    @Override
    public void reserveResource(RuntimeBindingRecord binding) {
        if (binding == null || binding.getState() != RuntimeBindingRecord.State.PROVISIONING
                || binding.isDrainRequested() || binding.getOperationOwner() == null) {
            throw conflict();
        }
        validate(binding.getRequest(), binding.getProvisionSeed());
        if (binding.getResourceHandle() != null) {
            validateHandle(binding.getRequest(), binding.getProvisionSeed(), binding.getResourceHandle());
        }
        admitPlacement(binding.getRequest(), binding.getProvisionSeed(), binding.getResourceHandle(), false);
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        return CompletableFuture.supplyAsync(() -> {
            validate(request, seed);
            if (knownHandle != null) {
                validateHandle(request, seed, knownHandle);
            }
            Placement retained = admitPlacement(request, seed, knownHandle, true);
            RuntimeResourceHandle original = knownHandle != null ? knownHandle : retained.handle();
            RuntimeResourceHandle handle = original != null ? original
                    : new RuntimeResourceHandle(kind(), HANDLE_VERSION, Map.of(
                            "providerId", providerId,
                            "provisionRequestId", seed.getProvisionRequestId(),
                            "identity", identity(request, seed),
                            "provider", Map.of("requestId", seed.getProvisionRequestId())));
            savePlacement(new Placement(request, seed, handle, retained.endpoint()));
            return handle;
        }, executor);
    }

    @Override
    public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return handle != null && kind().equals(handle.getKind()) && handle.getVersion() == HANDLE_VERSION;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return CompletableFuture.supplyAsync(() -> {
            validate(request, seed);
            Placement saved = placements.get(seed);
            if (saved == null || saved.handle() == null || !saved.request().equals(request)) {
                throw conflict();
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("protocolVersion", 1);
            body.put("provisionRequestId", seed.getProvisionRequestId());
            body.put("identity", identity(request, seed));
            body.put("scope", scope(request));
            body.put("boot", bootDocument(request, seed));
            body.put("handle", saved.handle().getValue().get("provider"));
            Map<String, Object> response;
            try {
                response = call(client.provision(Map.copyOf(body)));
            } catch (RuntimeBrokerException error) {
                // A permanent outcome frees this seed's bounded retry slot; a
                // retryable one keeps it so the original resource stays recoverable.
                if (!error.isRetryable()) {
                    forgetPlacement(saved);
                }
                throw error;
            }
            if (!saved.handle().getValue().get("provider").equals(response.get("handle"))) {
                forgetPlacement(saved);
                throw conflict();
            }
            long deadline = System.nanoTime() + startupTimeout.toNanos();
            long pause = 200;
            try {
                while (System.nanoTime() < deadline) {
                    RuntimeObservation observed = observe(request, seed, saved.handle());
                    if (observed.getOutcome() == RuntimeObservation.Outcome.READY) {
                        savePlacement(new Placement(request, seed, saved.handle(), observed.getEndpoint()));
                        return lease(seed, observed.getEndpoint());
                    }
                    if (observed.getOutcome() != RuntimeObservation.Outcome.STARTING
                            && observed.getOutcome() != RuntimeObservation.Outcome.UNKNOWN) {
                        throw conflict();
                    }
                    try {
                        Thread.sleep(pause);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw unavailable();
                    }
                    pause = Math.min(pause * 2, 2_000);
                }
            } catch (RuntimeBrokerException error) {
                // A permanent outcome frees this seed's bounded retry slot; a
                // retryable one keeps it so the original resource stays recoverable.
                if (!error.isRetryable()) {
                    forgetPlacement(saved);
                }
                throw error;
            }
            throw unavailable();
        }, executor);
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return CompletableFuture.supplyAsync(() -> {
            Placement retained = null;
            try {
                validate(request, seed);
                validateHandle(request, seed, handle);
                if (lastLease != null && !seed.matches(lastLease)) {
                    throw conflict();
                }
                retained = admitPlacement(request, seed, handle, true);
                RuntimeObservation observation = observe(request, seed, handle);
                URI originalEndpoint = retained.endpoint() != null ? retained.endpoint()
                        : lastLease == null ? null : lastLease.getEndpoint();
                if ((lastLease != null && !lastLease.getEndpoint().equals(originalEndpoint))
                        || (observation.getOutcome() == RuntimeObservation.Outcome.READY
                        && originalEndpoint != null && !originalEndpoint.equals(observation.getEndpoint()))) {
                    throw conflict();
                }
                // UNKNOWN loses readiness evidence, not ownership of the original endpoint.
                savePlacement(new Placement(request, seed, handle,
                        observation.getEndpoint() == null ? originalEndpoint : observation.getEndpoint()));
                return observation;
            } catch (RuntimeBrokerException error) {
                if (retained != null && !error.isRetryable()) {
                    forgetPlacement(retained);
                }
                return error.isRetryable() ? RuntimeObservation.unknown(handle) : RuntimeObservation.conflict(handle);
            }
        }, executor);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        Placement saved = placement(lease);
        if (saved == null || !saved.request().equals(request) || !lease.getEndpoint().equals(saved.endpoint())) {
            return CompletableFuture.failedFuture(executor.isShutdown() ? unavailable() : conflict());
        }
        return reconcile(request, saved.seed(), saved.handle(), lease).thenCompose(observation -> {
            if (observation.getOutcome() == RuntimeObservation.Outcome.UNKNOWN
                    || observation.getOutcome() == RuntimeObservation.Outcome.STARTING) {
                throw unavailable();
            }
            if (observation.getOutcome() != RuntimeObservation.Outcome.READY
                    || !lease.getEndpoint().equals(observation.getEndpoint())) {
                forgetPlacement(saved);
                throw conflict();
            }
            return transport.attest(lease, request, saved.seed()).thenApply(ignored -> null);
        });
    }

    @Override
    public boolean canRetryFailedConfirm(RuntimeLease lease) {
        return executor.isShutdown() || isUsable(lease);
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        Placement saved = placement(lease);
        return saved != null && lease.getEndpoint().equals(saved.endpoint());
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
        // Also called when an operation loses its CAS or attestation fails, so it
        // cannot authorize a physical stop of a worker the winner may be using.
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public void close() {
        executor.shutdownNow();
        synchronized (placements) {
            placements.clear();
            placementsByLease.clear();
        }
    }

    private RuntimeObservation observe(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle) {
        validateHandle(request, seed, handle);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 1);
        body.put("provisionRequestId", seed.getProvisionRequestId());
        body.put("identity", identity(request, seed));
        body.put("handle", handle.getValue().get("provider"));
        Map<String, Object> response = call(client.observe(Map.copyOf(body)));
        return observation(request, seed, handle, response);
    }

    /**
     * Maps one provider observe response onto a Broker observation. Profiles that
     * carry extra evidence override this and delegate the state mapping here.
     */
    protected RuntimeObservation observation(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, Map<String, Object> response) {
        Object state = response.get("state");
        if ("RUNNING".equals(state)) {
            return RuntimeObservation.ready(handle, endpoint(response.get("endpoint")),
                    seed.getProvisionalRuntimeId(), seed.getLeaseId(), seed.getEpoch());
        }
        if ("STARTING".equals(state)) {
            return RuntimeObservation.starting(handle);
        }
        if ("UNKNOWN".equals(state)) {
            return RuntimeObservation.unknown(handle);
        }
        // GONE, or anything the contract does not name, blocks adoption: a vanished
        // external worker is never silently replaced under the original identity.
        throw conflict();
    }

    /**
     * Builds the boot document sent to the provider. The default is the shipped
     * boot-v1 scratch document; profiles add their own closed members.
     */
    protected Map<String, Object> bootDocument(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return boot(request, seed);
    }

    /**
     * Profile-specific admission rules, evaluated inside {@link #validate} before
     * the boot size bound. The default refuses managed-context requests.
     */
    protected void validateProfile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        if (request.isManagedContext()) {
            throw conflict();
        }
    }

    private Placement admitPlacement(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, boolean retain) {
        synchronized (placements) {
            if (executor.isShutdown()) {
                throw unavailable();
            }
            Placement saved = placements.get(seed);
            if (saved != null) {
                if (!saved.request().equals(request) || (saved.handle() != null && handle != null
                        && !saved.handle().equals(handle))) {
                    throw conflict();
                }
                return saved;
            }
            if (placementsByLease.containsKey(ownershipKey(seed))) {
                throw conflict();
            }
            if (placements.size() >= MAX_PLACEMENTS) {
                throw new RuntimeBrokerException(503, "runtime_external_capacity",
                        "External Runtime placement capacity is exhausted.", true);
            }
            Placement pending = new Placement(request, seed, handle, null);
            if (retain) {
                placements.put(seed, pending);
                placementsByLease.put(ownershipKey(seed), pending);
            }
            return pending;
        }
    }

    private void savePlacement(Placement value) {
        synchronized (placements) {
            if (executor.isShutdown()) {
                throw unavailable();
            }
            Placement current = placements.get(value.seed());
            if (current == null || !current.request().equals(value.request())
                    || (current.handle() != null && !current.handle().equals(value.handle()))) {
                throw conflict();
            }
            placements.put(value.seed(), value);
            placementsByLease.put(ownershipKey(value.seed()), value);
        }
    }

    private void forgetPlacement(Placement observed) {
        synchronized (placements) {
            Placement current = placements.get(observed.seed());
            if (current != null && current.request().equals(observed.request())
                    && Objects.equals(current.handle(), observed.handle())) {
                placements.remove(observed.seed());
                placementsByLease.remove(ownershipKey(observed.seed()));
            }
        }
    }

    private Placement placement(RuntimeLease lease) {
        if (lease == null) {
            return null;
        }
        synchronized (placements) {
            return placementsByLease.get(List.of(lease.getRuntimeInstanceId(), lease.getLeaseId(),
                    lease.getEpoch(), lease.getToken()));
        }
    }

    private static List<Object> ownershipKey(RuntimeProvisionSeed seed) {
        return List.of(seed.getProvisionalRuntimeId(), seed.getLeaseId(), seed.getEpoch(), seed.getToken());
    }

    private void validate(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        if (request == null || seed == null || !kind().equals(request.getProvisionerKind())
                || !"session".equals(request.getScope().getIsolationClass())) {
            throw conflict();
        }
        String cwd = request.getScope().getCanonicalCwd();
        if (!cwd.startsWith("/") || Arrays.stream(cwd.substring(1).split("/", -1))
                .anyMatch(part -> part.isEmpty() || part.equals(".") || part.equals(".."))
                || !request.getScope().getCapabilityDigest().matches("sha256:[0-9a-f]{64}")
                || seed.getEpoch() > 9_007_199_254_740_991L) {
            throw conflict();
        }
        validateProfile(request, seed);
        if (JsonCodec.encode(bootDocument(request, seed)).length > BOOT_LIMIT) {
            throw conflict();
        }
    }

    private void validateHandle(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle) {
        if (!supportsStartupRecovery(handle) || handle.getValue().size() != 4
                || !providerId.equals(handle.getValue().get("providerId"))
                || !seed.getProvisionRequestId().equals(handle.getValue().get("provisionRequestId"))
                || !identity(request, seed).equals(handle.getValue().get("identity"))) {
            throw conflict();
        }
        if (!Map.of("requestId", seed.getProvisionRequestId()).equals(handle.getValue().get("provider"))) {
            throw conflict();
        }
    }

    private String identity(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        Map<String, Object> boot = new LinkedHashMap<>(bootDocument(request, seed));
        boot.remove("token");
        return digest(Map.of("version", 1, "providerId", providerId,
                "isolationKey", request.getIsolationKey(), "boot", boot));
    }

    private static Map<String, Object> scope(RuntimeProvisionRequest request) {
        RuntimeScope scope = request.getScope();
        return Map.of("tenantId", scope.getTenantId(), "workspaceId", scope.getWorkspaceId(),
                "workspaceGeneration", scope.getWorkspaceGeneration(), "workspaceCwd", scope.getCanonicalCwd(),
                "isolationClass", scope.getIsolationClass(), "isolationKey", request.getIsolationKey());
    }

    static Map<String, Object> boot(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        RuntimeScope scope = request.getScope();
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("type", "boot");
        value.put("version", 1);
        value.put("runtimeInstanceId", seed.getProvisionalRuntimeId());
        value.put("runtimeIncarnation", seed.getGatewayIncarnation());
        value.put("leaseId", seed.getLeaseId());
        value.put("provisionRequestId", seed.getProvisionRequestId());
        value.put("token", seed.getToken());
        value.put("epoch", seed.getEpoch());
        value.put("tenantId", scope.getTenantId());
        value.put("workspaceId", scope.getWorkspaceId());
        value.put("workspaceGeneration", scope.getWorkspaceGeneration());
        value.put("workspaceCwd", scope.getCanonicalCwd());
        value.put("capabilityDigest", scope.getCapabilityDigest());
        value.put("isolationClass", scope.getIsolationClass());
        return value;
    }

    private static URI endpoint(Object value) {
        if (!(value instanceof String text)) {
            throw conflict();
        }
        try {
            return BrokerValues.requireOrigin(URI.create(text), "External Runtime endpoint");
        } catch (IllegalArgumentException error) {
            throw conflict();
        }
    }

    private Map<String, Object> call(CompletionStage<Map<String, Object>> stage) {
        try {
            Map<String, Object> response = stage.toCompletableFuture().join();
            if (response == null || !Long.valueOf(1).equals(BrokerValues.exactLong(response.get("protocolVersion")))) {
                throw conflict();
            }
            return response;
        } catch (CompletionException error) {
            if (error.getCause() instanceof RuntimeBrokerException failure) {
                throw failure;
            }
            throw unavailable();
        }
    }

    /** Canonical-JSON SHA-256, the digest discipline every external identity uses. */
    protected static String canonicalDigest(Object value) {
        return digest(value);
    }

    private static String digest(Object value) {
        return DigestUtils.sha256Hex(JsonCodec.encode(canonical(value)));
    }

    private static Object canonical(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            map.forEach((key, child) -> sorted.put((String) key, canonical(child)));
            return sorted;
        }
        if (value instanceof List<?> list) {
            return list.stream().map(ExternalRuntimeProvisioner::canonical).toList();
        }
        return value;
    }

    private static RuntimeLease lease(RuntimeProvisionSeed seed, URI endpoint) {
        return new RuntimeLease(seed.getProvisionalRuntimeId(), endpoint, seed.getToken(), seed.getLeaseId(),
                seed.getEpoch());
    }

    private static RuntimeBrokerException conflict() {
        return new RuntimeBrokerException(409, "runtime_broker_resource_conflict",
                "External Runtime identity or lifecycle is not safe to adopt.", false);
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(503, "runtime_external_unavailable",
                "External Runtime provider is unavailable.", true);
    }

    private record Placement(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, URI endpoint) { }
}
