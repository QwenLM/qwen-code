package com.alibaba.qwen.code.runtimebroker;

import java.net.InetAddress;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Session-exclusive ephemeral Pods. Persistent Workspaces and physical retirement remain gated. */
public final class KubernetesRuntimeProvisioner implements RuntimeProvisioner {
    static final int MAX_PLACEMENTS = 1024;
    private static final String KIND = "kubernetes-scratch";
    private static final String IDENTITY = "qwen.ai/runtime-identity";
    private static final String BOOT_PATH = "/var/run/qwen-runtime/boot.json";
    private final KubernetesRuntimeClient client;
    private final String cluster;
    private final String namespace;
    private final String image;
    private final List<String> command;
    private final Duration startupTimeout;
    private final HttpRuntimeTransport transport = new HttpRuntimeTransport();
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final Map<RuntimeProvisionSeed, Placement> placements = new ConcurrentHashMap<>();
    private final Map<List<Object>, Placement> placementsByLease = new ConcurrentHashMap<>();

    public KubernetesRuntimeProvisioner(KubernetesRuntimeClient client, String cluster, String namespace,
            String image, List<String> workerCommand) {
        this(client, cluster, namespace, image, workerCommand, Duration.ofSeconds(30));
    }

    KubernetesRuntimeProvisioner(KubernetesRuntimeClient client, String cluster, String namespace,
            String image, List<String> workerCommand, Duration startupTimeout) {
        if (client == null || image == null || !image.matches("[^\\s]+@sha256:[0-9a-f]{64}")
                || workerCommand == null || workerCommand.isEmpty()
                || workerCommand.stream().anyMatch(value -> value == null || value.isBlank())
                || startupTimeout == null || startupTimeout.isNegative() || startupTimeout.isZero()) {
            throw new IllegalArgumentException("Client, pinned image, worker command and positive timeout are required");
        }
        KubernetesHttpRuntimeClient.dnsLabel(namespace);
        this.client = client;
        this.cluster = BrokerValues.requireId(cluster, "cluster");
        this.namespace = namespace;
        this.image = image;
        this.command = List.copyOf(workerCommand);
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
        admitPlacement(binding.getRequest(), binding.getProvisionSeed(), binding.getResourceHandle());
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        return CompletableFuture.supplyAsync(() -> {
            validate(request, seed);
            String name = name(seed);
            if (knownHandle != null) {
                validateHandle(request, seed, knownHandle);
            }
            Placement retained = admitPlacement(request, seed, knownHandle);
            RuntimeResourceHandle originalHandle = knownHandle == null ? retained.handle() : knownHandle;
            Map<String, Object> secret = get("secrets", name);
            Map<String, Object> pod = get("pods", name);
            if (originalHandle != null) {
                verify(request, seed, originalHandle, pod, secret);
            } else {
                if (secret == null && pod != null) {
                    throw conflict();
                }
                if (secret == null) {
                    Created created = create("secrets", secret(request, seed));
                    secret = created.object();
                    verifyObject(secret, secret(request, seed));
                    // Only a confirmed fresh Secret permits the first Pod create. A
                    // pre-existing Secret may belong to a deleted, previously active Pod.
                    if (created.fresh()) {
                        pod = create("pods", pod(request, seed)).object();
                    } else {
                        pod = get("pods", name);
                    }
                }
                verifyObject(secret, secret(request, seed));
                verifyObject(pod, pod(request, seed));
            }
            RuntimeResourceHandle handle = originalHandle == null
                    ? new RuntimeResourceHandle(KIND, 1, Map.of(
                            "cluster", cluster, "namespace", namespace, "name", name,
                            "podUid", uid(pod), "secretUid", uid(secret),
                            "identity", identity(request, seed)))
                    : originalHandle;
            savePlacement(new Placement(request, seed, handle, null));
            return handle;
        }, executor);
    }

    @Override
    public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return handle != null && KIND.equals(handle.getKind()) && handle.getVersion() == 1;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return CompletableFuture.supplyAsync(() -> {
            validate(request, seed);
            Placement saved = placements.get(seed);
            if (saved == null || saved.handle() == null || !saved.request().equals(request)) {
                throw conflict();
            }
            long deadline = System.nanoTime() + startupTimeout.toNanos();
            while (System.nanoTime() < deadline) {
                RuntimeObservation observed = observe(request, seed, saved.handle());
                if (observed.getOutcome() == RuntimeObservation.Outcome.READY) {
                    savePlacement(new Placement(request, seed, saved.handle(), observed.getEndpoint()));
                    return lease(seed, observed.getEndpoint());
                }
                if (observed.getOutcome() != RuntimeObservation.Outcome.STARTING) {
                    throw conflict();
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw unavailable();
                }
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
                retained = admitPlacement(request, seed, handle);
                RuntimeObservation observation = observe(request, seed, handle);
                savePlacement(new Placement(request, seed, handle, observation.getEndpoint()));
                return observation;
            } catch (RuntimeBrokerException error) {
                if (retained != null) {
                    if (error.isRetryable()) {
                        savePlacement(new Placement(request, seed, handle, null));
                    } else {
                        forgetPlacement(retained);
                    }
                }
                return error.isRetryable() ? RuntimeObservation.unknown(handle) : RuntimeObservation.conflict(handle);
            }
        }, executor);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        Placement saved = placement(lease);
        if (saved == null || !saved.request().equals(request) || !lease.getEndpoint().equals(saved.endpoint())) {
            return CompletableFuture.failedFuture(conflict());
        }
        return reconcile(request, saved.seed(), saved.handle(), lease).thenCompose(observation -> {
            if (observation.getOutcome() == RuntimeObservation.Outcome.UNKNOWN) {
                throw unavailable();
            }
            if (observation.getOutcome() != RuntimeObservation.Outcome.READY
                    || !lease.getEndpoint().equals(observation.getEndpoint())) {
                throw conflict();
            }
            return transport.attest(lease, request, saved.seed()).thenApply(ignored -> null);
        });
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        Placement saved = placement(lease);
        return saved != null && lease.getEndpoint().equals(saved.endpoint());
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
        // A losing Broker operation can share this exact Pod with its winner.
        // This callback supplies no durable physical-retirement authorization.
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

    private Placement admitPlacement(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle) {
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
                throw new RuntimeBrokerException(503, "runtime_kubernetes_capacity",
                        "Kubernetes Runtime placement capacity is exhausted.", true);
            }
            // Reserve before API writes; release cannot prove that a live worker is retired.
            Placement pending = new Placement(request, seed, handle, null);
            placements.put(seed, pending);
            placementsByLease.put(ownershipKey(seed), pending);
            return pending;
        }
    }

    private void savePlacement(Placement value) {
        synchronized (placements) {
            Placement current = placements.get(value.seed());
            if (executor.isShutdown() || current == null || !current.request().equals(value.request())
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

    private RuntimeObservation observe(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle) {
        validateHandle(request, seed, handle);
        Map<String, Object> pod = get("pods", name(seed));
        Map<String, Object> secret = get("secrets", name(seed));
        verify(request, seed, handle, pod, secret);
        Map<?, ?> status = object(pod.get("status"));
        if (status.get("phase") != null && List.of("Failed", "Succeeded", "Unknown").contains(status.get("phase"))) {
            throw conflict();
        }
        Object statuses = status.get("containerStatuses");
        if (!(statuses instanceof List<?> containers) || containers.isEmpty()) {
            return RuntimeObservation.starting(handle);
        }
        if (containers.size() != 1) {
            throw conflict();
        }
        Map<?, ?> container = object(containers.getFirst());
        if (!"runtime".equals(container.get("name"))
                || !Long.valueOf(0).equals(BrokerValues.exactLong(container.get("restartCount")))
                || object(container.get("state")).containsKey("terminated")) {
            throw conflict();
        }
        if (!"Running".equals(status.get("phase")) || !Boolean.TRUE.equals(container.get("ready"))
                || !object(container.get("state")).containsKey("running")) {
            return RuntimeObservation.starting(handle);
        }
        URI endpoint = endpoint(status.get("podIP"));
        return RuntimeObservation.ready(handle, endpoint, seed.getProvisionalRuntimeId(),
                seed.getLeaseId(), seed.getEpoch());
    }

    private void validate(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        if (request == null || seed == null || request.isManagedContext() || !KIND.equals(request.getProvisionerKind())
                || !"session".equals(request.getScope().getIsolationClass())) {
            throw conflict();
        }
        String cwd = request.getScope().getCanonicalCwd();
        if (!cwd.startsWith("/") || Arrays.stream(cwd.substring(1).split("/", -1))
                .anyMatch(part -> part.isEmpty() || part.equals(".") || part.equals(".."))
                || cwd.startsWith("/var/run") || cwd.equals("/tmp")
                || !request.getScope().getCapabilityDigest().matches("sha256:[0-9a-f]{64}")
                || seed.getEpoch() > 9_007_199_254_740_991L) {
            throw conflict();
        }
        if (JsonCodec.encode(boot(request, seed)).length > 32 * 1024) {
            throw conflict();
        }
    }

    private void validateHandle(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle) {
        if (!supportsStartupRecovery(handle) || handle.getValue().size() != 6
                || !cluster.equals(handle.getValue().get("cluster"))
                || !namespace.equals(handle.getValue().get("namespace"))
                || !name(seed).equals(handle.getValue().get("name"))
                || !identity(request, seed).equals(handle.getValue().get("identity"))) {
            throw conflict();
        }
    }

    private void verify(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, Map<String, Object> pod, Map<String, Object> secret) {
        verifyObject(pod, pod(request, seed));
        verifyObject(secret, secret(request, seed));
        if (!uid(pod).equals(handle.getValue().get("podUid"))
                || !uid(secret).equals(handle.getValue().get("secretUid"))) {
            throw conflict();
        }
    }

    private static void verifyObject(Map<String, Object> actual, Map<String, Object> expected) {
        if (actual == null || object(actual.get("metadata")).get("deletionTimestamp") != null
                || !contains(actual, expected)) {
            throw conflict();
        }
        uid(actual);
        if ("Pod".equals(expected.get("kind"))) {
            Map<?, ?> spec = object(actual.get("spec"));
            if (!absentOrEmpty(spec.get("initContainers")) || !absentOrEmpty(spec.get("ephemeralContainers"))) {
                throw conflict();
            }
            Map<?, ?> container = object(((List<?>) spec.get("containers")).getFirst());
            Map<?, ?> security = object(container.get("securityContext"));
            if (!Set.of("allowPrivilegeEscalation", "readOnlyRootFilesystem", "capabilities", "privileged",
                    "seccompProfile", "procMount", "runAsUser", "runAsNonRoot", "runAsGroup").containsAll(security.keySet())
                    || !Set.of("drop", "add").containsAll(object(security.get("capabilities")).keySet())) {
                throw conflict();
            }
            Map<?, ?> podSecurity = object(spec.get("securityContext"));
            for (String field : List.of("runAsUser", "runAsNonRoot", "runAsGroup")) {
                if (security.containsKey(field) && !Objects.equals(security.get(field), podSecurity.get(field))) {
                    throw conflict();
                }
            }
            if (!absentOrEmpty(container.get("args")) || !absentOrEmpty(container.get("envFrom"))
                    || container.get("lifecycle") != null
                    || Boolean.TRUE.equals(security.get("privileged"))
                    || security.get("seccompProfile") != null
                            && !Map.of("type", "RuntimeDefault").equals(security.get("seccompProfile"))
                    || security.get("procMount") != null && !"Default".equals(security.get("procMount"))
                    || !absentOrEmpty(object(security.get("capabilities")).get("add"))) {
                throw conflict();
            }
        }
    }

    private static boolean absentOrEmpty(Object value) {
        return value == null || value instanceof List<?> list && list.isEmpty();
    }

    private static boolean contains(Object actual, Object expected) {
        if (expected instanceof Map<?, ?> map) {
            if (!(actual instanceof Map<?, ?> observed)) {
                return false;
            }
            return map.entrySet().stream().allMatch(entry ->
                    Boolean.FALSE.equals(entry.getValue()) && !observed.containsKey(entry.getKey())
                            && Set.of("hostNetwork", "hostPID", "hostIPC").contains(entry.getKey())
                            || contains(observed.get(entry.getKey()), entry.getValue()));
        }
        if (expected instanceof List<?> list) {
            if (!(actual instanceof List<?> observed) || observed.size() != list.size()) {
                return false;
            }
            for (int i = 0; i < list.size(); i++) {
                if (!contains(observed.get(i), list.get(i))) {
                    return false;
                }
            }
            return true;
        }
        if (expected instanceof Number) {
            return Objects.equals(BrokerValues.exactLong(actual), BrokerValues.exactLong(expected));
        }
        return Objects.equals(actual, expected);
    }

    private Map<String, Object> secret(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return Map.of("apiVersion", "v1", "kind", "Secret", "metadata", metadata(request, seed),
                "immutable", true, "type", "Opaque", "data", Map.of("boot.json",
                        Base64.getEncoder().encodeToString(JsonCodec.encode(canonical(boot(request, seed))))));
    }

    private Map<String, Object> pod(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        List<String> args = new ArrayList<>(command);
        args.addAll(List.of("managed-runtime-worker", "--container-boot", BOOT_PATH));
        Map<String, Object> container = Map.of(
                "name", "runtime", "image", image, "imagePullPolicy", "IfNotPresent", "command", args,
                "env", List.of(Map.of("name", "HOME", "value", "/tmp"),
                        Map.of("name", "QWEN_RUNTIME_DIR", "value", "/tmp/qwen")),
                "ports", List.of(Map.of("containerPort", 43190, "name", "runtime")),
                "readinessProbe", Map.of("tcpSocket", Map.of("port", 43190), "periodSeconds", 1),
                "resources", Map.of("requests", Map.of("cpu", "100m", "memory", "256Mi"),
                        "limits", Map.of("cpu", "1", "memory", "1Gi", "ephemeral-storage", "2Gi")),
                "securityContext", Map.of("allowPrivilegeEscalation", false, "readOnlyRootFilesystem", true,
                        "capabilities", Map.of("drop", List.of("ALL"))),
                "volumeMounts", List.of(Map.of("name", "boot", "mountPath", "/var/run/qwen-runtime", "readOnly", true),
                        Map.of("name", "scratch", "mountPath", request.getScope().getCanonicalCwd()),
                        Map.of("name", "tmp", "mountPath", "/tmp")));
        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("restartPolicy", "Never");
        spec.put("automountServiceAccountToken", false);
        spec.put("hostNetwork", false);
        spec.put("hostPID", false);
        spec.put("hostIPC", false);
        spec.put("enableServiceLinks", false);
        spec.put("securityContext", Map.of("runAsNonRoot", true, "runAsUser", 1000, "runAsGroup", 1000,
                "fsGroup", 1000, "seccompProfile", Map.of("type", "RuntimeDefault")));
        spec.put("containers", List.of(container));
        spec.put("volumes", List.of(Map.of("name", "boot", "secret", Map.of("secretName", name(seed),
                        "defaultMode", 288, "items", List.of(Map.of("key", "boot.json", "path", "boot.json")))),
                Map.of("name", "scratch", "emptyDir", Map.of("sizeLimit", "1Gi")),
                Map.of("name", "tmp", "emptyDir", Map.of("sizeLimit", "512Mi"))));
        return Map.of("apiVersion", "v1", "kind", "Pod", "metadata", metadata(request, seed), "spec", spec);
    }

    private Map<String, Object> metadata(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return Map.of("name", name(seed), "namespace", namespace,
                "labels", Map.of("app.kubernetes.io/managed-by", "qwen-runtime-broker"),
                "annotations", Map.of(IDENTITY, identity(request, seed)));
    }

    private String identity(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        Map<String, Object> boot = new LinkedHashMap<>(boot(request, seed));
        boot.remove("token");
        return digest(Map.of("version", 1, "cluster", cluster, "namespace", namespace,
                "image", image, "command", command, "isolationKey", request.getIsolationKey(), "boot", boot));
    }

    private static Map<String, Object> boot(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
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

    private Map<String, Object> get(String resource, String name) {
        try {
            return client.get(resource, namespace, name).toCompletableFuture().join();
        } catch (CompletionException error) {
            throw apiFailure(error);
        }
    }

    private Created create(String resource, Map<String, Object> body) {
        try {
            return new Created(client.create(resource, namespace, body).toCompletableFuture().join(), true);
        } catch (CompletionException error) {
            RuntimeBrokerException failure = apiFailure(error);
            if (failure.getStatusCode() != 409 && !failure.isRetryable()) {
                throw failure;
            }
            Map<String, Object> observed = get(resource, (String) object(body.get("metadata")).get("name"));
            if (observed == null) {
                throw failure;
            }
            return new Created(observed, false);
        }
    }

    private static RuntimeBrokerException apiFailure(CompletionException error) {
        return error.getCause() instanceof RuntimeBrokerException failure ? failure : unavailable();
    }

    private static Map<?, ?> object(Object value) {
        return value instanceof Map<?, ?> map ? map : Map.of();
    }

    private static String uid(Map<String, Object> resource) {
        Object uid = object(resource.get("metadata")).get("uid");
        if (!(uid instanceof String text) || text.isBlank()) {
            throw conflict();
        }
        return text;
    }

    private static String name(RuntimeProvisionSeed seed) {
        return "qwen-" + digest(seed.getProvisionRequestId()).substring(0, 48);
    }

    private static String digest(Object value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JsonCodec.encode(canonical(value))));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static Object canonical(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            map.forEach((key, child) -> sorted.put((String) key, canonical(child)));
            return sorted;
        }
        if (value instanceof List<?> list) {
            return list.stream().map(KubernetesRuntimeProvisioner::canonical).toList();
        }
        return value;
    }

    private static URI endpoint(Object value) {
        if (!(value instanceof String ip) || !ip.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")) {
            throw conflict();
        }
        try {
            InetAddress address = InetAddress.getByName(ip);
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                    || address.isMulticastAddress()) {
                throw conflict();
            }
            return new URI("http", null, address.getHostAddress(), 43190, "/", null, null);
        } catch (java.io.IOException | java.net.URISyntaxException error) {
            throw conflict();
        }
    }

    private static RuntimeLease lease(RuntimeProvisionSeed seed, URI endpoint) {
        return new RuntimeLease(seed.getProvisionalRuntimeId(), endpoint, seed.getToken(), seed.getLeaseId(), seed.getEpoch());
    }

    private static RuntimeBrokerException conflict() {
        return new RuntimeBrokerException(409, "runtime_broker_resource_conflict",
                "Kubernetes Runtime identity or lifecycle is not safe to adopt.", false);
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(503, "runtime_kubernetes_unavailable", "Kubernetes Runtime is unavailable.", true);
    }

    private record Placement(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, URI endpoint) { }

    private record Created(Map<String, Object> object, boolean fresh) { }
}
