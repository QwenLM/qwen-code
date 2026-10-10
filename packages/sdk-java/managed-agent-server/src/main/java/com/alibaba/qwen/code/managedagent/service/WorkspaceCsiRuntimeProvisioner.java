package com.alibaba.qwen.code.managedagent.service;

import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.VERSION;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.bytes;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.context;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.dns;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.lease;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.map;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.name;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.require;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.same;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.text;
import static com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity.uuid;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.TransactionException;

/** Private CSI placement; ambiguous creation never authorizes adoption or replacement. */
public final class WorkspaceCsiRuntimeProvisioner implements RuntimeProvisioner {
    private static final String BOOT_PATH = "/var/run/qwen-runtime/boot.json";
    private final WorkspaceCsiReservationStore storage;
    private final JdbcRuntimeBindingRepository bindings;
    private final WorkspaceCsiRegistration registration;
    private final KubernetesRuntimeClient api;
    private final WorkspaceCsiResourceGuard guard;
    private final String image;
    private final List<String> command;
    private final List<WorkerArtifact> artifacts;
    private final Duration timeout;
    private final RuntimeTransport transport;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final ThreadLocal<Long> deadline = new ThreadLocal<>();
    private final Map<RuntimeProvisionSeed, RuntimeBindingRecord> claims = new ConcurrentHashMap<>();
    private final Map<RuntimeProvisionSeed, Placement> placements = new ConcurrentHashMap<>();

    public record WorkerArtifact(String configMapName, String uid, String sha256) {
        public WorkerArtifact {
            dns(Objects.requireNonNull(configMapName));
            uuid(Objects.requireNonNull(uid));
            require(sha256 != null && sha256.matches("[0-9a-f]{64}"));
        }
    }

    public WorkspaceCsiRuntimeProvisioner(WorkspaceCsiReservationStore storage,
            JdbcRuntimeBindingRepository bindings, WorkspaceCsiRegistration registration) {
        this(storage, bindings, registration, null, null, null, List.of(), Duration.ofSeconds(30), List.of(), new HttpRuntimeTransport());
    }

    public WorkspaceCsiRuntimeProvisioner(WorkspaceCsiReservationStore storage,
            JdbcRuntimeBindingRepository bindings, WorkspaceCsiRegistration registration, KubernetesRuntimeClient api,
            WorkspaceCsiResourceGuard guard, String image, List<String> command, Duration timeout) {
        this(storage, bindings, registration, api, guard, image, command, timeout, List.of());
    }

    public WorkspaceCsiRuntimeProvisioner(WorkspaceCsiReservationStore storage,
            JdbcRuntimeBindingRepository bindings, WorkspaceCsiRegistration registration, KubernetesRuntimeClient api,
            WorkspaceCsiResourceGuard guard, String image, List<String> command, Duration timeout, List<WorkerArtifact> artifacts) {
        this(storage, bindings, registration, Objects.requireNonNull(api), Objects.requireNonNull(guard),
                image, command, timeout, artifacts, new HttpRuntimeTransport());
    }

    WorkspaceCsiRuntimeProvisioner(WorkspaceCsiReservationStore storage,
            JdbcRuntimeBindingRepository bindings, WorkspaceCsiRegistration registration, KubernetesRuntimeClient api,
            WorkspaceCsiResourceGuard guard, String image, List<String> command, Duration timeout,
            List<WorkerArtifact> artifacts, RuntimeTransport transport) {
        this.storage = Objects.requireNonNull(storage);
        this.bindings = Objects.requireNonNull(bindings);
        this.registration = Objects.requireNonNull(registration);
        this.api = api;
        this.guard = guard;
        this.image = image;
        this.command = List.copyOf(command);
        this.artifacts = List.copyOf(artifacts);
        this.timeout = Objects.requireNonNull(timeout);
        this.transport = Objects.requireNonNull(transport);
        require(!timeout.isZero() && !timeout.isNegative() && timeout.compareTo(Duration.ofMinutes(5)) <= 0);
        if (api != null) {
            require(guard != null && image != null && image.matches("[^\\s]+@sha256:[0-9a-f]{64}")
                    && !command.isEmpty() && command.size() <= 32 && command.stream().allMatch(value ->
                            value != null && !value.isBlank() && value.length() <= 8192 && value.indexOf('\0') < 0)
                    && artifacts.size() <= 48 && artifacts.stream().map(WorkerArtifact::configMapName).distinct().count() == artifacts.size());
        }
    }

    @Override
    public String kind() {
        return WorkspaceCsiReservationStore.PROVISIONER_KIND;
    }

    @Override
    public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
        if (!registration.tenantId().equals(scope.getTenantId()) || !registration.mountRoot().equals(scope.getCanonicalCwd())) {
            throw closed();
        }
        return new RuntimeProvisionRequest(scope, isolationKey, kind(), registration.storageId());
    }

    @Override
    public void reserveResource(RuntimeBindingRecord binding) {
        if (api != null) {
            configured(binding.getRequest(), binding.getProvisionSeed());
        }
        storage.reserve(registration, bindings, binding, reservationId(binding.getProvisionSeed()));
        claims.put(binding.getProvisionSeed(), binding);
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
        return CompletableFuture.failedFuture(closed());
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        var ownedHandle = new AtomicReference<>(knownHandle);
        return async(request, seed, ownedHandle::get, () -> {
            configured(request, seed);
            if (knownHandle != null) {
                observe(request, seed, knownHandle);
                return knownHandle;
            }
            var original = admitted(request, seed);
            var reservation = storage.inspect(registration);
            var boot = com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol.boot(request, seed, storageTuple(reservation));
            require(bytes(boot).length <= 32 * 1024);
            var protection = protection(await(guard.verify()));
            verifyArtifacts();
            require(get("secrets", name(seed)) == null && get("pods", name(seed)) == null);
            admitted(request, seed, original);
            var secret = create("secrets", secret(seed, boot));
            checkObject(secret, secret(seed, boot), null);
            String secretUid = uid(secret);
            admitted(request, seed, original);
            var pod = create("pods", pod(request, seed));
            checkObject(pod, pod(request, seed), null);
            String podUid = uid(pod);
            while (true) {
                admitted(request, seed, original);
                pod = get("pods", name(seed));
                checkObject(pod, pod(request, seed), podUid);
                var running = running(pod);
                if (running != null) {
                    var placement = placement(seed, pod, secretUid, running, protection);
                    var value = new LinkedHashMap<String, Object>();
                    value.put("bindingId", original.getBindingId());
                    value.put("runtimeGeneration", Long.toString(original.getGeneration()));
                    value.put("context", context(boot));
                    value.put("storage", storageTuple(reservation));
                    value.put("placement", placement);
                    value.put("protection", protection);
                    value.put("artifacts", artifactPins());
                    value.put("bootDigest", digest(boot));
                    value.put("podSpecDigest", digest(pod.get("spec")));
                    var receipt = attest(request, seed, placement, storageTuple(reservation));
                    value.put("mount", receipt.get("mount"));
                    value.put("identity", digest(value));
                    var handle = new RuntimeResourceHandle(kind(), VERSION, value);
                    ownedHandle.set(handle);
                    observe(request, seed, handle, true);
                    admitted(request, seed, original);
                    return handle;
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw timeout();
                }
            }
        });
    }

    @Override
    public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        var retained = placements.get(seed);
        return async(request, seed, () -> retained == null ? null : retained.handle(), () -> {
            var placement = placements.get(seed);
            require(placement != null && placement.request().equals(request));
            return observe(request, seed, placement.handle());
        });
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return async(request, seed, () -> handle, () -> {
            try {
                var lease = observe(request, seed, handle);
                require(lastLease == null || sameLease(lastLease, lease));
                return RuntimeObservation.ready(handle, lease.getEndpoint(), lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch());
            } catch (RuntimeException error) {
                forgetPlacement(request, seed, handle);
                return error instanceof RuntimeBrokerException failure && failure.isRetryable()
                        || error instanceof DataAccessException || error instanceof TransactionException
                        ? RuntimeObservation.unknown(handle) : RuntimeObservation.conflict(handle);
            }
        });
    }

    @Override
    public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
        return api != null && handle != null && kind().equals(handle.getKind()) && handle.getVersion() == VERSION;
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        var entry = placements.entrySet().stream().filter(value -> sameLease(value.getValue().lease(), lease)).findFirst();
        if (entry.isEmpty() || !entry.get().getValue().request().equals(request)) {
            return CompletableFuture.failedFuture(closed());
        }
        var seed = entry.get().getKey();
        var handle = entry.get().getValue().handle();
        return async(request, seed, () -> handle, () -> {
            observe(request, seed, handle);
            return null;
        });
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        return placements.values().stream().anyMatch(value -> sameLease(value.lease(), lease));
    }

    @Override
    public void close() {
        executor.shutdownNow();
        claims.clear();
        placements.clear();
    }

    private RuntimeLease observe(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
        return observe(request, seed, handle, false);
    }

    private RuntimeLease observe(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeResourceHandle handle, boolean fresh) {
        configured(request, seed);
        WorkspaceCsiRuntimeIdentity.validate(request, seed, handle);
        var value = handle.getValue();
        var placement = map(value.get("placement"));
        require(image.equals(placement.get("image")) && same(artifactPins(), value.get("artifacts")));
        var reserved = storage.inspect(registration);
        require(("RESERVED".equals(reserved.phase()) || "DRAINING".equals(reserved.phase()))
                && Objects.equals(reserved.bindingId(), value.get("bindingId"))
                && Objects.equals(Long.toString(reserved.runtimeGeneration()), value.get("runtimeGeneration"))
                && seed.getProvisionRequestId().equals(reserved.provisionRequestId()));
        var original = bindings.findById(reserved.bindingId());
        require(original != null && request.equals(original.getRequest()) && seed.equals(original.getProvisionSeed())
                && original.getGeneration() == reserved.runtimeGeneration()
                && !original.isDrainRequested()
                && List.of(RuntimeBindingRecord.State.PROVISIONING, RuntimeBindingRecord.State.READY,
                        RuntimeBindingRecord.State.RECOVERY_BLOCKED).contains(original.getState())
                && (fresh && original.getResourceHandle() == null || handle.equals(original.getResourceHandle())));
        var expectedStorage = storageTuple(reserved);
        expectedStorage.put("reservationRevision", "1");
        require(same(expectedStorage, value.get("storage")));
        checkObservation(request, seed, handle);
        var receipt = attest(request, seed, placement, map(value.get("storage")));
        require(same(receipt.get("mount"), value.get("mount")));
        checkObservation(request, seed, handle);
        var lease = lease(seed, placement);
        remainingMillis();
        placements.put(seed, new Placement(request, handle, lease));
        return lease;
    }

    private void checkObservation(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
        var value = handle.getValue();
        var placement = map(value.get("placement"));
        require(same(protection(await(guard.verify())), value.get("protection")));
        verifyArtifacts();
        var pod = get("pods", name(seed));
        checkObject(pod, pod(request, seed), (String) placement.get("podUid"));
        checkObject(get("secrets", name(seed)), secret(seed, com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol.boot(
                request, seed, map(value.get("storage")))), (String) placement.get("secretUid"));
        require(digest(pod.get("spec")).equals(value.get("podSpecDigest")));
        var running = running(pod);
        require(running != null && same(placement(seed, pod, (String) placement.get("secretUid"), running,
                map(value.get("protection"))), placement));
    }

    private Map<String, Object> attest(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            Map<String, Object> placement, Map<String, Object> tuple) {
        var lease = lease(seed, placement);
        remainingMillis();
        await(transport.attest(lease, request, seed));
        remainingMillis();
        return await(transport.attestCsi(lease, request, seed, tuple, WorkspaceCsiRuntimeIdentity.pod(placement)));
    }

    private RuntimeBindingRecord admitted(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return admitted(request, seed, claims.get(seed));
    }

    private RuntimeBindingRecord admitted(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeBindingRecord expected) {
        require(expected != null && expected.getRequest().equals(request));
        remainingMillis();
        var current = bindings.findById(expected.getBindingId());
        require(current != null && current.getRequest().equals(request) && seed.equals(current.getProvisionSeed())
                && current.getGeneration() == expected.getGeneration() && !current.isDrainRequested()
                && current.getState() == RuntimeBindingRecord.State.PROVISIONING
                && Objects.equals(current.getOperationOwner(), expected.getOperationOwner())
                && current.getOperationGeneration() == expected.getOperationGeneration());
        storage.reserve(registration, bindings, current, reservationId(seed));
        return current;
    }

    private void configured(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        if (api == null) {
            throw closed();
        }
        require(request != null && seed != null && request.isManagedContext() && kind().equals(request.getProvisionerKind())
                && "workspace".equals(request.getScope().getIsolationClass()) && request.getIsolationKey() == null
                && registration.tenantId().equals(request.getScope().getTenantId())
                && registration.storageId().equals(request.getStorageId()) && registration.mountRoot().equals(request.getScope().getCanonicalCwd())
                && !registration.mountRoot().startsWith("/tmp") && !registration.mountRoot().startsWith("/var/run"));
    }

    private Map<String, Object> placement(RuntimeProvisionSeed seed, Map<String, Object> pod, String secretUid,
            Map<String, Object> running, Map<String, Object> protection) {
        String nodeName = text(map(pod.get("spec")), "nodeName", 253);
        remainingMillis();
        var node = await(api.getCluster("nodes", nodeName));
        checkObject(node, Map.of("apiVersion", "v1", "kind", "Node", "metadata", Map.of("name", nodeName)), null);
        var conditions = list(map(node.get("status")).get("conditions")).stream().map(WorkspaceCsiRuntimeIdentity::map)
                .filter(condition -> "Ready".equals(condition.get("type"))).toList();
        require(conditions.size() == 1 && "True".equals(conditions.getFirst().get("status")));
        var result = new LinkedHashMap<String, Object>();
        result.putAll(Map.of("clusterDomain", registration.clusterDomain(), "namespace", registration.namespace(),
                "namespaceUid", protection.get("namespaceUid"), "podName", name(seed), "podUid", uid(pod),
                "secretName", name(seed), "secretUid", secretUid, "nodeName", nodeName, "nodeUid", uid(node)));
        result.putAll(Map.of("containerName", "runtime", "containerId", text(running, "containerID", 128),
                "image", image, "imageId", text(running, "imageID", 512), "podIp", text(map(pod.get("status")), "podIP", 64)));
        require(text(result, "containerId", 128).matches("containerd://[0-9a-f]{64}")
                && text(result, "imageId", 512).matches("[^\\s]*sha256:[0-9a-f]{64}"));
        WorkspaceCsiRuntimeIdentity.endpoint((String) result.get("podIp"));
        return result;
    }

    private Map<String, Object> running(Map<String, Object> pod) {
        if (pod.get("status") == null) {
            return null;
        }
        var status = map(pod.get("status"));
        require(status.get("phase") == null || !List.of("Failed", "Succeeded", "Unknown").contains(status.get("phase")));
        if (status.get("containerStatuses") == null || list(status.get("containerStatuses")).isEmpty()) {
            return null;
        }
        var containers = list(status.get("containerStatuses"));
        require(containers.size() == 1);
        var current = map(containers.getFirst());
        require("runtime".equals(current.get("name")) && current.get("restartCount") instanceof Number
                && ((Number) current.get("restartCount")).doubleValue() == 0
                && !map(current.get("state")).containsKey("terminated"));
        return "Running".equals(status.get("phase")) && Boolean.TRUE.equals(current.get("ready"))
                && map(current.get("state")).keySet().equals(java.util.Set.of("running")) ? current : null;
    }

    private Map<String, Object> secret(RuntimeProvisionSeed seed, Map<String, Object> boot) {
        return Map.of("apiVersion", "v1", "kind", "Secret", "metadata", metadata(seed), "immutable", true,
                "type", "Opaque", "data", Map.of("boot.json", Base64.getEncoder().encodeToString(bytes(boot))));
    }

    private Map<String, Object> pod(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        var args = new ArrayList<>(command);
        args.addAll(List.of("managed-runtime-worker", "--container-boot", BOOT_PATH));
        var mounts = new ArrayList<>(List.of(Map.of("name", "boot", "mountPath", "/var/run/qwen-runtime", "readOnly", true),
                Map.of("name", "workspace", "mountPath", registration.mountRoot()), Map.of("name", "tmp", "mountPath", "/tmp")));
        var volumes = new ArrayList<Map<String, Object>>(List.of(
                Map.of("name", "boot", "secret", Map.of("secretName", name(seed), "defaultMode", 288,
                        "items", List.of(Map.of("key", "boot.json", "path", "boot.json")))),
                Map.of("name", "workspace", "persistentVolumeClaim", Map.of("claimName", registration.pvcName())),
                Map.of("name", "tmp", "emptyDir", Map.of("sizeLimit", "512Mi"))));
        if (!artifacts.isEmpty()) {
            mounts.add(Map.of("name", "worker", "mountPath", "/var/run/qwen-worker-parts", "readOnly", true));
            var sources = new ArrayList<Map<String, Object>>();
            for (int index = 0; index < artifacts.size(); index++) {
                sources.add(Map.of("configMap", Map.of("name", artifacts.get(index).configMapName(),
                        "items", List.of(Map.of("key", "chunk", "path", String.format(java.util.Locale.ROOT, "%03d", index))))));
            }
            volumes.add(Map.of("name", "worker", "projected", Map.of("defaultMode", 292, "sources", sources)));
        }
        var container = Map.of("name", "runtime", "image", image, "imagePullPolicy", "IfNotPresent", "command", args,
                "env", List.of(Map.of("name", "HOME", "value", "/tmp"), Map.of("name", "QWEN_RUNTIME_DIR", "value", "/tmp/qwen"),
                        downward("QWEN_POD_UID", "metadata.uid"), downward("QWEN_POD_NAMESPACE", "metadata.namespace"),
                        downward("QWEN_NODE_NAME", "spec.nodeName")),
                "ports", List.of(Map.of("containerPort", 43190, "name", "runtime")),
                "readinessProbe", Map.of("tcpSocket", Map.of("port", 43190), "periodSeconds", 1),
                "resources", Map.of("requests", Map.of("cpu", "100m", "memory", "256Mi"),
                        "limits", Map.of("cpu", "1", "memory", "1Gi", "ephemeral-storage", "2Gi")),
                "securityContext", Map.of("allowPrivilegeEscalation", false, "readOnlyRootFilesystem", true,
                        "capabilities", Map.of("drop", List.of("ALL"))), "volumeMounts", mounts);
        var spec = new LinkedHashMap<String, Object>();
        spec.putAll(Map.of("restartPolicy", "Never", "automountServiceAccountToken", false,
                "enableServiceLinks", false, "nodeSelector", Map.of("kubernetes.io/os", "linux")));
        spec.put("securityContext", Map.of("runAsNonRoot", true, "runAsUser", 1000, "runAsGroup", 1000, "fsGroup", 1000,
                "seccompProfile", Map.of("type", "RuntimeDefault")));
        spec.put("containers", List.of(container));
        spec.put("volumes", volumes);
        return Map.of("apiVersion", "v1", "kind", "Pod", "metadata", metadata(seed), "spec", spec);
    }

    private Map<String, Object> metadata(RuntimeProvisionSeed seed) {
        return Map.of("name", name(seed), "namespace", registration.namespace());
    }

    private static Map<String, Object> downward(String name, String field) {
        return Map.of("name", name, "valueFrom", Map.of("fieldRef", Map.of("apiVersion", "v1", "fieldPath", field)));
    }

    private void verifyArtifacts() {
        for (var artifact : artifacts) {
            var object = get("configmaps", artifact.configMapName());
            checkObject(object, Map.of("apiVersion", "v1", "kind", "ConfigMap", "immutable", true,
                    "metadata", Map.of("name", artifact.configMapName(), "namespace", registration.namespace())), artifact.uid());
            require(object.get("data") == null || map(object.get("data")).isEmpty());
            var data = map(object.get("binaryData"));
            require(data.keySet().equals(java.util.Set.of("chunk")));
            byte[] chunk = Base64.getDecoder().decode(text(data, "chunk", 1024 * 1024));
            require(chunk.length > 0 && artifact.sha256().equals(rawDigest(chunk)));
        }
    }

    private List<Map<String, Object>> artifactPins() {
        return artifacts.stream().map(value -> Map.<String, Object>of("configMapName", value.configMapName(),
                "uid", value.uid(), "sha256", value.sha256())).toList();
    }

    private static String rawDigest(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private Map<String, Object> storageTuple(WorkspaceCsiReservationStore.Reservation reservation) {
        var result = new LinkedHashMap<String, Object>();
        result.putAll(Map.of("clusterDomain", registration.clusterDomain(), "namespace", registration.namespace(),
                "pvcUid", registration.pvcUid(), "pvUid", registration.pvUid(), "driver", registration.driver(),
                "volumeHandle", registration.volumeHandle(), "backendDomain", registration.backendDomain(),
                "diskSerial", registration.diskSerial(), "physicalKey", registration.physicalKey()));
        result.putAll(Map.of("registrationRevision", Long.toString(registration.revision()),
                "reservationId", reservation.reservationId(), "reservationRevision", Long.toString(reservation.revision())));
        return result;
    }

    private Map<String, Object> protection(WorkspaceCsiResourceGuard.Receipt receipt) {
        require(registration.physicalKey().equals(receipt.physicalKey()) && registration.revision() == receipt.registrationRevision());
        var pin = receipt.protection();
        return Map.of("namespaceUid", pin.namespaceUid(), "policyName", pin.policyName(), "policyUid", pin.policyUid(),
                "policyGeneration", Long.toString(pin.policyGeneration()), "bindingName", pin.bindingName(),
                "bindingUid", pin.bindingUid(), "bindingGeneration", Long.toString(pin.bindingGeneration()));
    }

    private static void checkObject(Map<String, Object> actual, Map<String, Object> expected, String expectedUid) {
        require(actual != null && contains(actual, expected));
        var metadata = map(actual.get("metadata"));
        require(!metadata.containsKey("deletionTimestamp") && !metadata.containsKey("deletionGracePeriodSeconds")
                && (metadata.get("ownerReferences") == null || list(metadata.get("ownerReferences")).isEmpty())
                && (expectedUid == null || expectedUid.equals(uid(actual))));
        uid(actual);
        if ("Pod".equals(actual.get("kind"))) {
            var spec = map(actual.get("spec"));
            require(Set.of("restartPolicy", "automountServiceAccountToken", "enableServiceLinks", "nodeSelector",
                    "securityContext", "containers", "volumes", "nodeName", "serviceAccountName", "serviceAccount",
                    "schedulerName", "priority", "preemptionPolicy", "dnsPolicy", "terminationGracePeriodSeconds",
                    "tolerations", "hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace",
                    "initContainers", "ephemeralContainers", "imagePullSecrets", "priorityClassName").containsAll(spec.keySet()));
            require(map(map(expected.get("spec")).get("securityContext")).keySet()
                    .containsAll(map(spec.get("securityContext")).keySet()));
            require(empty(spec.get("initContainers")) && empty(spec.get("ephemeralContainers"))
                    && !Boolean.TRUE.equals(spec.get("shareProcessNamespace")));
            for (String field : List.of("hostNetwork", "hostPID", "hostIPC")) {
                require(spec.get(field) == null || Boolean.FALSE.equals(spec.get(field)));
            }
            var pvc = list(spec.get("volumes")).stream().map(WorkspaceCsiRuntimeIdentity::map)
                    .filter(volume -> "workspace".equals(volume.get("name"))).findFirst().orElseThrow();
            Object readOnly = map(pvc.get("persistentVolumeClaim")).get("readOnly");
            require(readOnly == null || Boolean.FALSE.equals(readOnly));
            var container = map(list(spec.get("containers")).getFirst());
            require(Set.of("name", "image", "imagePullPolicy", "command", "env", "ports", "readinessProbe",
                    "resources", "securityContext", "volumeMounts", "terminationMessagePath", "terminationMessagePolicy",
                    "args", "envFrom", "lifecycle").containsAll(container.keySet()));
            var security = map(container.get("securityContext"));
            require(Set.of("allowPrivilegeEscalation", "readOnlyRootFilesystem", "capabilities", "privileged",
                    "procMount", "seccompProfile").containsAll(security.keySet()));
            require(Set.of("drop", "add").containsAll(map(security.get("capabilities")).keySet()));
            require(empty(container.get("args")) && empty(container.get("envFrom")) && container.get("lifecycle") == null
                    && !Boolean.TRUE.equals(security.get("privileged")) && empty(map(security.get("capabilities")).get("add"))
                    && (security.get("procMount") == null || "Default".equals(security.get("procMount")))
                    && (security.get("seccompProfile") == null || same(security.get("seccompProfile"), Map.of("type", "RuntimeDefault"))));
        }
    }

    private static boolean empty(Object value) {
        return value == null || value instanceof List<?> list && list.isEmpty();
    }

    private static boolean contains(Object actual, Object expected) {
        if (expected instanceof Map<?, ?> fields) {
            return actual instanceof Map<?, ?> values && fields.entrySet().stream().allMatch(entry -> contains(values.get(entry.getKey()), entry.getValue()));
        }
        if (expected instanceof List<?> fields) {
            if (!(actual instanceof List<?> values) || values.size() != fields.size()) {
                return false;
            }
            for (int index = 0; index < fields.size(); index++) {
                if (!contains(values.get(index), fields.get(index))) {
                    return false;
                }
            }
            return true;
        }
        return same(actual, expected);
    }

    private static List<?> list(Object value) {
        require(value instanceof List<?>);
        return (List<?>) value;
    }

    private static String uid(Map<String, Object> object) {
        String uid = text(map(object.get("metadata")), "uid", 36);
        uuid(uid);
        return uid;
    }

    private Map<String, Object> get(String resource, String name) {
        remainingMillis();
        return await(api.get(resource, registration.namespace(), name));
    }

    private <T> T await(CompletionStage<T> stage) {
        try {
            return stage.toCompletableFuture().orTimeout(remainingMillis(), TimeUnit.MILLISECONDS).join();
        } catch (CompletionException error) {
            if (error.getCause() instanceof RuntimeBrokerException failure) {
                throw failure;
            }
            throw timeout();
        }
    }

    private void forgetPlacement(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
        if (seed != null && handle != null) {
            placements.computeIfPresent(seed, (ignored, current) ->
                    current.request().equals(request) && current.handle().equals(handle) ? null : current);
        }
    }

    private <T> CompletionStage<T> async(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            Supplier<RuntimeResourceHandle> handle, Supplier<T> operation) {
        long until = System.nanoTime() + timeout.toNanos();
        return CompletableFuture.supplyAsync(() -> {
            deadline.set(until);
            try {
                T result = operation.get();
                remainingMillis();
                return result;
            } finally {
                deadline.remove();
            }
        }, executor).orTimeout(timeout.toMillis(), TimeUnit.MILLISECONDS)
                .exceptionallyCompose(error -> {
                    forgetPlacement(request, seed, handle.get());
                    Throwable cause = error;
                    while (cause instanceof CompletionException && cause.getCause() != null) {
                        cause = cause.getCause();
                    }
                    return CompletableFuture.failedFuture(cause instanceof RuntimeBrokerException ? cause : timeout());
                });
    }

    private Map<String, Object> create(String resource, Map<String, Object> body) {
        remainingMillis();
        return await(api.create(resource, registration.namespace(), body));
    }

    private long remainingMillis() {
        Long until = deadline.get();
        long remaining = until == null ? 0 : until - System.nanoTime();
        if (remaining <= 0 || Thread.currentThread().isInterrupted()) {
            throw timeout();
        }
        return Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining));
    }

    private String reservationId(RuntimeProvisionSeed seed) {
        String value = "qwen-csi-reservation/1:" + registration.aliasKey() + ":" + registration.revision() + ":" + seed.getProvisionRequestId();
        return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static boolean sameLease(RuntimeLease first, RuntimeLease second) {
        return first != null && second != null && first.getRuntimeInstanceId().equals(second.getRuntimeInstanceId())
                && first.getEndpoint().equals(second.getEndpoint()) && first.getToken().equals(second.getToken())
                && first.getLeaseId().equals(second.getLeaseId()) && first.getEpoch() == second.getEpoch();
    }

    private static RuntimeBrokerException timeout() {
        return new RuntimeBrokerException(503, "workspace_csi_observation_unavailable", "Workspace CSI observation is unavailable.", true);
    }

    private static RuntimeBrokerException closed() {
        return new RuntimeBrokerException(409, "workspace_csi_provenance_unavailable", "Workspace CSI worker provenance is unavailable.", false);
    }

    private record Placement(RuntimeProvisionRequest request, RuntimeResourceHandle handle, RuntimeLease lease) {
    }
}
