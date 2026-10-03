package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FakeKubernetesRuntimeClient.map;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class KubernetesRuntimeProvisionerTest {
    static final String IMAGE = "registry.example/qwen@sha256:" + "a".repeat(64);
    static final List<String> COMMAND = List.of("node", "/opt/qwen/dist/cli.js");
    static final RuntimeProvisionSeed SEED = RuntimeProvisionSeed.create("binding", 1);

    static KubernetesRuntimeProvisioner provisioner(FakeKubernetesRuntimeClient client) {
        return new KubernetesRuntimeProvisioner(client, "cluster-a", "runtimes", IMAGE, COMMAND,
                Duration.ofMillis(250));
    }

    static RuntimeProvisionRequest request(KubernetesRuntimeProvisioner provisioner, String directory) {
        return provisioner.createRequest(new RuntimeScope("tenant", "workspace", "1", directory,
                "sha256:" + "a".repeat(64), "session"), "harness");
    }

    @Test
    void createsOnePodAndSecretAndAdoptsTheSameHandleAfterRestart() {
        var api = new FakeKubernetesRuntimeClient();
        RuntimeResourceHandle handle;
        RuntimeProvisionRequest request;
        RuntimeLease lease;
        try (var first = provisioner(api)) {
            request = request(first, "/workspace");
            handle = join(first.ensureResource(request, SEED, null));
            assertEquals(handle, join(first.ensureResource(request, SEED, null)));
            lease = join(first.provision(request, SEED));
            assertEquals(URI.create("http://10.42.0.8:43190/"), lease.getEndpoint());
            assertEquals(SEED.getToken(), lease.getToken());
            assertFalse(handle.toJson().contains(SEED.getToken()));
            assertEquals(2, api.creates);
            assertEquals("Never", map(api.object("pods").get("spec")).get("restartPolicy"));
            assertEquals(false, map(api.object("pods").get("spec")).get("automountServiceAccountToken"));
            assertFalse(new String(JsonCodec.encode(api.object("pods")), java.nio.charset.StandardCharsets.UTF_8)
                    .contains("persistentVolumeClaim"));
            var data = map(api.object("secrets").get("data"));
            var boot = JsonCodec.parseObject(Base64.getDecoder().decode((String) data.get("boot.json")), "boot");
            assertEquals(14, boot.size());
            assertEquals(SEED.getGatewayIncarnation(), boot.get("runtimeIncarnation"));
        }
        try (var restored = provisioner(api)) {
            var observation = join(restored.reconcile(request, SEED, handle, lease));
            assertEquals(RuntimeObservation.Outcome.READY, observation.getOutcome());
            assertEquals(handle, observation.getHandle());
            assertEquals(lease.getEndpoint(), join(restored.provision(request, SEED)).getEndpoint());
            join(restored.release(request, lease));
            assertTrue(restored.isUsable(lease));
        }
        assertEquals(2, api.creates);
        assertEquals(2, api.objects.size());
    }

    @Test
    void resolvesALostPodCreateReplyWithoutCreatingAgain() {
        var api = new FakeKubernetesRuntimeClient();
        api.loseCreateReply = "pods";
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            var handle = join(provisioner.ensureResource(request, SEED, null));
            assertEquals(handle, join(provisioner.ensureResource(request, SEED, handle)));
            assertEquals(2, api.creates);
        }
    }

    @Test
    void doesNotRecreatePodBesideAnAmbiguousExistingSecret() {
        var api = new FakeKubernetesRuntimeClient();
        api.loseCreateReply = "secrets";
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            failure(provisioner.ensureResource(request, SEED, null));
            failure(provisioner.ensureResource(request, SEED, null));
            assertEquals(1, api.creates);
        }
    }

    @Test
    void rejectsMissingAndChangedObjectsWithoutWritesDuringRecovery() {
        List<Consumer<FakeKubernetesRuntimeClient>> mutations = List.of(
                api -> api.remove("pods"), api -> api.remove("secrets"),
                api -> map(api.object("pods").get("metadata")).put("uid", "replacement"),
                api -> map(api.object("secrets").get("metadata")).put("uid", "replacement"),
                api -> map(api.object("pods").get("metadata")).put("deletionTimestamp", "now"),
                api -> map(api.object("pods").get("status")).put("phase", "Succeeded"),
                api -> status(api).put("restartCount", 1),
                api -> status(api).put("state", Map.of("terminated", Map.of("exitCode", 0))),
                api -> map(api.object("secrets").get("data")).put("boot.json", "e30="),
                api -> container(api).put("image", "other@sha256:" + "b".repeat(64)),
                api -> container(api).put("command", List.of("another-worker")),
                api -> container(api).put("envFrom", List.of(Map.of("secretRef", Map.of("name", "other")))),
                api -> container(api).put("args", List.of("extra-argument")),
                api -> map(api.object("pods").get("spec")).put("initContainers", List.of(Map.of("name", "other"))),
                api -> map(api.object("pods").get("spec")).put("automountServiceAccountToken", true));
        for (var mutate : mutations) {
            var api = new FakeKubernetesRuntimeClient();
            try (var provisioner = provisioner(api)) {
                var request = request(provisioner, "/workspace");
                var handle = join(provisioner.ensureResource(request, SEED, null));
                var lease = join(provisioner.provision(request, SEED));
                assertTrue(provisioner.isUsable(lease));
                mutate.accept(api);
                var observed = join(provisioner.reconcile(request, SEED, handle, null));
                assertEquals(RuntimeObservation.Outcome.CONFLICT, observed.getOutcome());
                assertFalse(provisioner.isUsable(lease));
                assertEquals(2, api.creates);
            }
        }
    }

    @Test
    void refusesAChangedPlacementBeforeCallingTheApi() {
        var api = new FakeKubernetesRuntimeClient();
        try (var first = provisioner(api);
                var changed = new KubernetesRuntimeProvisioner(api, "cluster-b", "runtimes", IMAGE, COMMAND)) {
            var request = request(first, "/workspace");
            var handle = join(first.ensureResource(request, SEED, null));
            int reads = api.reads;
            failure(changed.ensureResource(request, SEED, handle));
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    join(changed.reconcile(request, SEED, handle, null)).getOutcome());
            assertEquals(reads, api.reads);
        }
    }

    @Test
    void observesApiOutageAsUnknownAndNeverReplacesThePod() {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            var handle = join(provisioner.ensureResource(request, SEED, null));
            var lease = join(provisioner.provision(request, SEED));
            api.readFailure = new RuntimeBrokerException(503, "offline", "offline", true);
            assertEquals(503, failure(provisioner.confirm(request, lease)).getStatusCode());
            assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                    join(provisioner.reconcile(request, SEED, handle, null)).getOutcome());
            assertFalse(provisioner.isUsable(lease));
            assertEquals(2, api.creates);
        }
    }

    @Test
    void invalidatesTheLocallyUsableLeaseWhenTheObservedEndpointChanges() {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            var handle = join(provisioner.ensureResource(request, SEED, null));
            var original = join(provisioner.provision(request, SEED));
            map(api.object("pods").get("status")).put("podIP", "10.42.0.9");
            var observed = join(provisioner.reconcile(request, SEED, handle, original));
            assertEquals(RuntimeObservation.Outcome.READY, observed.getOutcome());
            assertFalse(provisioner.isUsable(original));
            assertEquals(observed.getEndpoint(), join(provisioner.provision(request, SEED)).getEndpoint());
            assertEquals(2, api.creates);
        }
    }

    @Test
    void pendingPodStaysStartingAndProvisioningTimesOut() {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            var handle = join(provisioner.ensureResource(request, SEED, null));
            api.object("pods").put("status", Map.of("phase", "Pending"));
            assertEquals(RuntimeObservation.Outcome.STARTING,
                    join(provisioner.reconcile(request, SEED, handle, null)).getOutcome());
            assertTrue(failure(provisioner.provision(request, SEED)).isRetryable());
            assertEquals(2, api.creates);
        }
    }

    @Test
    void requiresAHandleAndRefusesManagedContextBeforeApiCalls() {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            failure(provisioner.provision(request, SEED));
            failure(provisioner.provision(request));
            failure(provisioner.ensureResource(new RuntimeProvisionRequest(request.getScope(), "harness",
                    provisioner.kind(), "storage:a"), SEED, null));
            assertEquals(0, api.reads);
            assertEquals(0, api.creates);
        }
    }

    @Test
    void rejectsUnsafeContainerPathsBeforeCallingTheApi() {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            for (String cwd : List.of("relative", "/", "/tmp", "/var/run/qwen-runtime",
                    "/a//b", "/a/./b", "/a/../b", "/a/")) {
                failure(provisioner.ensureResource(request(provisioner, cwd), SEED, null));
            }
            var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace", "invalid", "session");
            failure(provisioner.ensureResource(provisioner.createRequest(scope, "harness"), SEED, null));
            var encoded = new LinkedHashMap<>(JsonCodec.parseObject(SEED.encode(), "seed"));
            encoded.put("epoch", 9_007_199_254_740_992L);
            failure(provisioner.ensureResource(request(provisioner, "/workspace"),
                    RuntimeProvisionSeed.decode(JsonCodec.encode(encoded)), null));
            assertEquals(0, api.reads);
            assertEquals(0, api.creates);
        }
    }

    @Test
    void rejectsEndpointsOutsidePodAddressSemantics() {
        for (String ip : List.of("127.0.0.1", "0.0.0.0", "169.254.169.254", "224.0.0.1", "::1", "fd00::1", "example.com", "10.1")) {
            var api = new FakeKubernetesRuntimeClient();
            api.podIp = ip;
            try (var provisioner = provisioner(api)) {
                var request = request(provisioner, "/workspace");
                var handle = join(provisioner.ensureResource(request, SEED, null));
                assertEquals(RuntimeObservation.Outcome.CONFLICT,
                        join(provisioner.reconcile(request, SEED, handle, null)).getOutcome());
            }
        }
    }

    static Map<String, Object> container(FakeKubernetesRuntimeClient api) {
        return map(((List<?>) map(api.object("pods").get("spec")).get("containers")).getFirst());
    }

    static Map<String, Object> status(FakeKubernetesRuntimeClient api) {
        return map(((List<?>) map(api.object("pods").get("status")).get("containerStatuses")).getFirst());
    }

    static RuntimeBrokerException failure(CompletionStage<?> result) {
        return (RuntimeBrokerException) assertThrows(CompletionException.class,
                () -> result.toCompletableFuture().join()).getCause();
    }

    static <T> T join(CompletionStage<T> result) {
        return result.toCompletableFuture().join();
    }
}
