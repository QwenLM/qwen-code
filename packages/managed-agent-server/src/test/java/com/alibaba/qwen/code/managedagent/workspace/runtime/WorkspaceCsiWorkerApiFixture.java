package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiFilesProtocol;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** API placement fixture; the provisioner, Secret boot and worker attestation remain real. */
public final class WorkspaceCsiWorkerApiFixture implements KubernetesRuntimeClient {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String UID = "11111111-1111-4111-8111-111111111111";
    private final Map<String, Map<String, Object>> objects = new ConcurrentHashMap<>();
    public final WorkspaceCsiRegistration registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "runtime",
            "claim", "pvc-uid", "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "handle", "backend", "owned-serial", "/workspace", 1);
    public final CompletableFuture<Map<String, Object>> boot = new CompletableFuture<>();
    public final CompletableFuture<Map<String, Object>> pod = new CompletableFuture<>();
    public final AtomicInteger calls = new AtomicInteger();
    public final AtomicInteger creates = new AtomicInteger();

    public WorkspaceCsiWorkerApiFixture() {
        objects.put("persistentvolumeclaims", object("PersistentVolumeClaim", "claim", "runtime", "pvc-uid",
                Map.of("volumeName", "volume", "volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod")), Map.of("phase", "Bound")));
        objects.put("persistentvolumes", object("PersistentVolume", "volume", null, "pv-uid",
                Map.of("volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"),
                        "claimRef", Map.of("apiVersion", "v1", "kind", "PersistentVolumeClaim", "name", "claim", "namespace", "runtime", "uid", "pvc-uid"),
                        "csi", Map.of("driver", registration.driver(), "volumeHandle", "handle", "fsType", "ext4")), Map.of("phase", "Bound")));
        var namespace = object("Namespace", "runtime", null, UID, Map.of(), Map.of("phase", "Active"));
        map(namespace, "metadata").put("labels", Map.of("pod-security.kubernetes.io/enforce", "restricted", "pod-security.kubernetes.io/enforce-version", "v1.36"));
        objects.put("namespaces", namespace);
        var policy = copy(WorkspaceCsiResourceGuard.policy(registration, "protect"));
        map(policy, "metadata").putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "1"));
        policy.put("status", Map.of("observedGeneration", 1, "typeChecking", Map.of()));
        objects.put("validatingadmissionpolicies", policy);
        var binding = copy(WorkspaceCsiResourceGuard.binding("protect", "protect-binding"));
        map(binding, "metadata").putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "1"));
        objects.put("validatingadmissionpolicybindings", binding);
        objects.put("nodes", object("Node", "node", null, UID, Map.of(), Map.of("conditions", List.of(Map.of("type", "Ready", "status", "True")))));
    }

    public WorkspaceCsiRuntimeProvisioner provisioner(WorkspaceCsiReservationStore storage,
            JdbcRuntimeBindingRepository bindings, RuntimeTransport transport, String origin) {
        var protection = new WorkspaceCsiResourceGuard.ProtectionIdentity(UID, "protect", UID, 1, "protect-binding", UID, 1);
        return new WorkspaceCsiRuntimeProvisioner(storage, bindings, registration, this,
                new WorkspaceCsiResourceGuard(this, registration.clusterDomain(), registration, protection),
                "registry.example/worker@sha256:" + "a".repeat(64), List.of("node", "/opt/qwen/dist/cli.js"),
                Duration.ofSeconds(90), List.of(), transport, ManagedCsiFilesProtocol.authority(origin));
    }

    @Override
    public CompletionStage<Map<String, Object>> get(String resource, String namespace, String name) {
        calls.incrementAndGet();
        var value = objects.get(resource);
        return CompletableFuture.completedFuture(value != null && name.equals(map(value, "metadata").get("name"))
                && namespace.equals(map(value, "metadata").get("namespace")) ? value : null);
    }

    @Override
    public CompletionStage<Map<String, Object>> getCluster(String resource, String name) {
        calls.incrementAndGet();
        var value = objects.get(resource);
        return CompletableFuture.completedFuture(value != null && name.equals(map(value, "metadata").get("name")) ? value : null);
    }

    @Override
    public CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body) {
        calls.incrementAndGet();
        creates.incrementAndGet();
        if (!(resource.equals("pods") || resource.equals("secrets")) || !namespace.equals(registration.namespace())) {
            return CompletableFuture.failedFuture(new IllegalArgumentException("Unexpected fixture creation"));
        }
        var value = copy(body);
        map(value, "metadata").put("uid", UID);
        if (resource.equals("pods")) {
            map(value, "spec").put("nodeName", "node");
            value.put("status", copy(Map.of("phase", "Running", "podIP", "10.4.0.8", "containerStatuses", List.of(Map.of(
                    "name", "runtime", "restartCount", 0, "ready", true, "state", Map.of("running", Map.of("startedAt", "2026-10-03T00:00:00Z")),
                    "containerID", "containerd://" + "b".repeat(64), "imageID", "sha256:" + "d".repeat(64))))));
        }
        objects.put(resource, value);
        if (resource.equals("secrets")) {
            try {
                boot.complete(JSON.readValue(Base64.getDecoder().decode((String) map(value, "data").get("boot.json")),
                        new TypeReference<Map<String, Object>>() { }));
            } catch (java.io.IOException failure) {
                return CompletableFuture.failedFuture(failure);
            }
        } else {
            pod.complete(value);
        }
        return CompletableFuture.completedFuture(value);
    }

    private static Map<String, Object> object(String kind, String name, String namespace, String uid,
            Map<String, Object> spec, Map<String, Object> status) {
        var metadata = new LinkedHashMap<String, Object>(Map.of("name", name, "uid", uid, "resourceVersion", "1"));
        if (namespace != null) {
            metadata.put("namespace", namespace);
        }
        return copy(Map.of("apiVersion", "v1", "kind", kind, "metadata", metadata, "spec", spec, "status", status));
    }

    private static Map<String, Object> copy(Map<String, Object> value) {
        return JSON.convertValue(value, new TypeReference<>() { });
    }

    private static Map<String, Object> map(Map<String, Object> value, String field) {
        return WorkspaceCsiRuntimeIdentity.map(value.get(field));
    }
}
