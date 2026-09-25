package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class KubernetesRuntimeProvisionerTest {
    @Test
    void ensuresOnceAndRefreshesTheObservedEndpoint() throws Exception {
        FakeClient client = new FakeClient();
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);

        RuntimeResourceHandle first = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);
        RuntimeResourceHandle duplicate = provisioner.ensureResource(request,
                seed, first).toCompletableFuture().get(1, TimeUnit.SECONDS);

        assertEquals(first, duplicate);
        assertEquals(1, client.secretCreates.get());
        assertEquals(1, client.podCreates.get());
        Map<String, Object> container = objectList(
                object(client.pod, "spec"), "containers").get(0);
        assertEquals(List.of("--boot-env"), container.get("args"));
        Map<String, Object> boot = JsonCodec.parseObject(Base64.getDecoder()
                .decode((String) object(client.secret, "data")
                        .get("boot.json")), "Kubernetes boot");
        assertEquals("0.0.0.0", boot.get("listenHostname"));
        assertEquals(4190, boot.get("listenPort"));
        assertEquals(RuntimeObservation.Outcome.STARTING,
                provisioner.reconcile(request, seed, first, null)
                        .toCompletableFuture().get(1, TimeUnit.SECONDS)
                        .getOutcome());

        client.ready("10.2.3.4", "3");
        RuntimeObservation ready = provisioner.reconcile(request, seed,
                first, null).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);
        assertEquals(RuntimeObservation.Outcome.READY, ready.getOutcome());
        assertEquals(URI.create("http://10.2.3.4:4190/"),
                ready.getEndpoint());
        assertNotEquals(first, ready.getHandle());

        client.ready("10.2.3.9", "4");
        RuntimeObservation moved = provisioner.reconcile(request, seed,
                ready.getHandle(), null).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);
        assertEquals(URI.create("http://10.2.3.9:4190/"),
                moved.getEndpoint());
        assertEquals(1, client.podCreates.get());
    }

    @Test
    void apiUncertaintyDoesNotCreateOrDeleteAnything() throws Exception {
        FakeClient client = new FakeClient();
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);
        RuntimeResourceHandle handle = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);
        int creates = client.secretCreates.get() + client.podCreates.get();
        client.failReads = true;

        RuntimeObservation observation = provisioner.reconcile(request, seed,
                handle, null).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);

        assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                observation.getOutcome());
        assertEquals(creates,
                client.secretCreates.get() + client.podCreates.get());
        assertEquals(0, client.deletes.get());
    }

    @Test
    void nonRetryableApiFailureIsARecoveryConflict() throws Exception {
        FakeClient client = new FakeClient();
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);
        RuntimeResourceHandle handle = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);
        client.readFailure = new RuntimeBrokerException(409,
                "runtime_broker_resource_conflict", "conflict", false);

        RuntimeObservation observation = provisioner.reconcile(request, seed,
                handle, null).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);

        assertEquals(RuntimeObservation.Outcome.CONFLICT,
                observation.getOutcome());
    }

    @Test
    void rejectsSameNameWithAnotherUidWithoutDeletingIt() throws Exception {
        FakeClient client = new FakeClient();
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);
        RuntimeResourceHandle handle = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);
        client.replacePodUid("replacement-pod");

        assertEquals(RuntimeObservation.Outcome.CONFLICT,
                provisioner.reconcile(request, seed, handle, null)
                        .toCompletableFuture().get(1, TimeUnit.SECONDS)
                        .getOutcome());
        RuntimeResourceContext resource = new RuntimeResourceContext(request,
                seed, handle, null);
        assertThrows(Exception.class, () -> provisioner.release(resource)
                .toCompletableFuture().get(1, TimeUnit.SECONDS));
        assertEquals(0, client.deletes.get());
    }

    @Test
    void releaseUsesUidPreconditionsAndIsIdempotent() throws Exception {
        FakeClient client = new FakeClient();
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);
        RuntimeResourceHandle handle = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);
        RuntimeResourceContext resource = new RuntimeResourceContext(request,
                seed, handle, null);

        provisioner.release(resource).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);
        provisioner.release(resource).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);

        assertEquals(List.of("pod-uid", "secret-uid"), client.deletedUids);
        assertEquals(java.util.Arrays.asList(null, null),
                client.deletedResourceVersions);
        assertEquals(2, client.deletes.get());
    }

    @Test
    void lostCreateResponseIsDiscoveredWithoutDuplication() throws Exception {
        FakeClient client = new FakeClient();
        client.loseFirstPodCreateResponse = true;
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);

        assertThrows(Exception.class, () -> provisioner.ensureResource(
                request, seed, null).toCompletableFuture()
                .get(1, TimeUnit.SECONDS));
        RuntimeResourceHandle recovered = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);

        assertEquals("kubernetes", recovered.getKind());
        assertEquals(1, client.secretCreates.get());
        assertEquals(1, client.podCreates.get());
        Map<String, Object> labels = object(object(client.pod, "metadata"),
                "labels");
        assertFalse(labels.toString().contains("tenant-secret"));
        assertFalse(recovered.getValue().toString().contains(
                seed.getToken()));
    }

    @Test
    void rejectsFractionalHandleSchemaVersions() throws Exception {
        FakeClient client = new FakeClient();
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);
        RuntimeResourceHandle handle = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);
        Map<String, Object> value = new LinkedHashMap<>(handle.getValue());
        value.put("schemaVersion", 1.5);
        RuntimeResourceHandle malformed = new RuntimeResourceHandle(
                handle.getKind(), handle.getVersion(), value);

        assertThrows(RuntimeBrokerException.class, () ->
                provisioner.reconcile(request, seed, malformed, null));
    }

    @Test
    void rejectsANonIpPodEndpoint() throws Exception {
        FakeClient client = new FakeClient();
        KubernetesRuntimeProvisioner provisioner = provisioner(client);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeProvisionRequest request = request(provisioner);
        RuntimeResourceHandle handle = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(1, TimeUnit.SECONDS);
        client.ready("runtime.internal", "3");

        RuntimeObservation observation = provisioner.reconcile(request, seed,
                handle, null).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);

        assertEquals(RuntimeObservation.Outcome.CONFLICT,
                observation.getOutcome());
    }

    @Test
    void checksContainerPathsAsPosixWhateverTheHostOs() {
        FakeClient client = new FakeClient();
        for (String accepted : List.of("/", "/usr/bin/node",
                "/app/dist/cli.js")) {
            new KubernetesRuntimeProvisioner(client, "cluster-a",
                    "qwen-runtimes", "registry/qwen-runtime:test", 4190,
                    accepted, "/app/dist/cli.js", "/app/dist/cli.js",
                    null, null);
        }
        for (String rejected : List.of("usr/bin/node", "C:\\node.exe",
                "//usr/bin/node", "/usr//bin/node", "/usr/./bin/node",
                "/usr/../bin/node", "/usr/bin/", "/usr/bin/node/.",
                "/usr/bin/\u0000node")) {
            IllegalArgumentException error = assertThrows(
                    IllegalArgumentException.class,
                    () -> new KubernetesRuntimeProvisioner(client,
                            "cluster-a", "qwen-runtimes",
                            "registry/qwen-runtime:test", 4190, rejected,
                            "/app/dist/cli.js", "/app/dist/cli.js", null,
                            null),
                    rejected);
            assertEquals("nodeExecutable must be an absolute normalized path",
                    error.getMessage());
        }
    }

    private static KubernetesRuntimeProvisioner provisioner(
            FakeClient client) {
        return new KubernetesRuntimeProvisioner(client, "cluster-a",
                "qwen-runtimes", "registry/qwen-runtime:test", 4190,
                "/usr/bin/node", "/app/dist/cli.js", "/app/dist/cli.js",
                "runtime-account", "workspace-pvc");
    }

    private static RuntimeProvisionRequest request(
            KubernetesRuntimeProvisioner provisioner) {
        RuntimeScope scope = new RuntimeScope("tenant-secret",
                "1c383764c575991f", "generation", "/workspace/private",
                "capability", "workspace");
        return new RuntimeProvisionRequest(scope, null, provisioner.kind(),
                provisioner.placementDomain(),
                provisioner.runtimeTemplateDigest());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Map<String, Object> parent,
            String field) {
        return (Map<String, Object>) parent.get(field);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> objectList(
            Map<String, Object> parent, String field) {
        return (List<Map<String, Object>>) parent.get(field);
    }

    private static final class FakeClient implements KubernetesRuntimeClient {
        private final AtomicInteger secretCreates = new AtomicInteger();
        private final AtomicInteger podCreates = new AtomicInteger();
        private final AtomicInteger deletes = new AtomicInteger();
        private final java.util.ArrayList<String> deletedUids =
                new java.util.ArrayList<>();
        private final java.util.ArrayList<String> deletedResourceVersions =
                new java.util.ArrayList<>();
        private Map<String, Object> secret;
        private Map<String, Object> pod;
        private boolean failReads;
        private RuntimeException readFailure;
        private boolean loseFirstPodCreateResponse;

        @Override
        public CompletionStage<Map<String, Object>> getSecret(
                String namespace, String name) {
            return read(secret);
        }

        @Override
        public CompletionStage<Map<String, Object>> createSecret(
                String namespace, String name, Map<String, Object> body) {
            secretCreates.incrementAndGet();
            secret = created(body, "secret-uid", "1");
            return CompletableFuture.completedFuture(secret);
        }

        @Override
        public CompletionStage<Map<String, Object>> getPod(String namespace,
                String name) {
            return read(pod);
        }

        @Override
        public CompletionStage<Map<String, Object>> createPod(
                String namespace, String name, Map<String, Object> body) {
            podCreates.incrementAndGet();
            pod = created(body, "pod-uid", "2");
            pod.put("status", Map.of("phase", "Pending"));
            if (loseFirstPodCreateResponse) {
                loseFirstPodCreateResponse = false;
                return CompletableFuture.failedFuture(new RuntimeException(
                        "response lost"));
            }
            return CompletableFuture.completedFuture(pod);
        }

        @Override
        public CompletionStage<Void> deleteSecret(String namespace,
                String name, String uid, String resourceVersion) {
            if (secret != null && !uid.equals(uid(secret))) {
                return CompletableFuture.failedFuture(conflict());
            }
            if (secret != null) {
                deletedUids.add(uid);
                deletedResourceVersions.add(resourceVersion);
                deletes.incrementAndGet();
                secret = null;
            }
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Void> deletePod(String namespace,
                String name, String uid, String resourceVersion) {
            if (pod != null && !uid.equals(uid(pod))) {
                return CompletableFuture.failedFuture(conflict());
            }
            if (pod != null) {
                deletedUids.add(uid);
                deletedResourceVersions.add(resourceVersion);
                deletes.incrementAndGet();
                pod = null;
            }
            return CompletableFuture.completedFuture(null);
        }

        void ready(String podIp, String resourceVersion) {
            Map<String, Object> metadata = new LinkedHashMap<>(
                    object(pod, "metadata"));
            metadata.put("resourceVersion", resourceVersion);
            Map<String, Object> updated = new LinkedHashMap<>(pod);
            updated.put("metadata", metadata);
            updated.put("status", Map.of("phase", "Running", "podIP",
                    podIp, "conditions", List.of(Map.of("type", "Ready",
                            "status", "True"))));
            pod = updated;
        }

        void replacePodUid(String uid) {
            Map<String, Object> metadata = new LinkedHashMap<>(
                    object(pod, "metadata"));
            metadata.put("uid", uid);
            Map<String, Object> replacement = new LinkedHashMap<>(pod);
            replacement.put("metadata", metadata);
            pod = replacement;
        }

        private CompletionStage<Map<String, Object>> read(
                Map<String, Object> value) {
            if (readFailure != null) {
                return CompletableFuture.failedFuture(readFailure);
            }
            if (failReads) {
                return CompletableFuture.failedFuture(new RuntimeException(
                        "Kubernetes API timeout"));
            }
            return CompletableFuture.completedFuture(value);
        }

        private static Map<String, Object> created(
                Map<String, Object> body, String uid,
                String resourceVersion) {
            Map<String, Object> created = new LinkedHashMap<>(body);
            Map<String, Object> metadata = new LinkedHashMap<>(
                    object(body, "metadata"));
            metadata.put("uid", uid);
            metadata.put("resourceVersion", resourceVersion);
            created.put("metadata", metadata);
            return created;
        }

        private static String uid(Map<String, Object> resource) {
            return (String) object(resource, "metadata").get("uid");
        }

        private static RuntimeBrokerException conflict() {
            return new RuntimeBrokerException(409,
                    "runtime_broker_resource_conflict", "conflict", false);
        }
    }

}
