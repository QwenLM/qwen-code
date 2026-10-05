package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FakeKubernetesRuntimeClient.map;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Duration;
import java.util.Base64;
import java.util.Collection;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletionStage;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

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
    void boundsReleasedAndUnknownPlacementsWithoutEvictingOtherLiveSeeds() {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            var handle = join(provisioner.ensureResource(request, SEED, null));
            var live = join(provisioner.provision(request, SEED));
            for (int index = 1; index < KubernetesRuntimeProvisioner.MAX_PLACEMENTS; index++) {
                var seed = RuntimeProvisionSeed.create("binding-" + index, 1);
                join(provisioner.ensureResource(request, seed, null));
                join(provisioner.release(request, join(provisioner.provision(request, seed))));
            }
            join(provisioner.release(request, live));
            var extra = RuntimeProvisionSeed.create("extra", 1);
            assertEquals("runtime_kubernetes_capacity", failure(provisioner.ensureResource(request, extra, null)).getCode());
            var bindings = new InMemoryRuntimeBindingRepository();
            var binding = bindings.findOrCreate(request);
            var claimed = bindings.claimOperation(binding.getBindingId(), "owner", Duration.ofSeconds(30));
            assertEquals("runtime_kubernetes_capacity", assertThrows(RuntimeBrokerException.class,
                    () -> provisioner.reserveResource(claimed)).getCode());
            assertTrue(provisioner.isUsable(live));
            assertEquals(2 * KubernetesRuntimeProvisioner.MAX_PLACEMENTS, api.creates);
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    join(provisioner.reconcile(request, extra, handle, null)).getOutcome());
            assertTrue(provisioner.isUsable(live));

            api.readFailure = new RuntimeBrokerException(503, "offline", "offline", true);
            assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                    join(provisioner.reconcile(request, SEED, handle, live)).getOutcome());
            assertFalse(provisioner.isUsable(live));
            assertEquals("runtime_kubernetes_capacity", failure(provisioner.ensureResource(request, extra, null)).getCode());
            api.readFailure = null;
            assertEquals(RuntimeObservation.Outcome.READY,
                    join(provisioner.reconcile(request, SEED, handle, live)).getOutcome());
            assertTrue(provisioner.isUsable(live));
            assertEquals(2 * KubernetesRuntimeProvisioner.MAX_PLACEMENTS, api.creates);

            api.objects.remove("pods/runtimes/" + handle.getValue().get("name"));
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    join(provisioner.reconcile(request, SEED, handle, live)).getOutcome());
            assertFalse(provisioner.isUsable(live));
            join(provisioner.ensureResource(request, extra, null));
            assertEquals(2 * KubernetesRuntimeProvisioner.MAX_PLACEMENTS + 2, api.creates);
        }
    }

    @Test
    void concurrentAdmissionCannotExceedThePlacementCap() {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            for (int index = 0; index < KubernetesRuntimeProvisioner.MAX_PLACEMENTS - 1; index++) {
                join(provisioner.ensureResource(request, RuntimeProvisionSeed.create("binding-" + index, 1), null));
            }
            var contenders = List.of(
                    provisioner.ensureResource(request, RuntimeProvisionSeed.create("contender-a", 1), null),
                    provisioner.ensureResource(request, RuntimeProvisionSeed.create("contender-b", 1), null));
            int admitted = 0;
            for (var contender : contenders) {
                try {
                    join(contender);
                    admitted++;
                } catch (CompletionException error) {
                    assertEquals("runtime_kubernetes_capacity", ((RuntimeBrokerException) error.getCause()).getCode());
                }
            }
            assertEquals(1, admitted);
            assertEquals(2 * KubernetesRuntimeProvisioner.MAX_PLACEMENTS, api.creates);
        }
    }

    @Test
    void leaseLookupsNeverScanTheSeedMapAndCheckEveryFence() throws ReflectiveOperationException {
        var api = new FakeKubernetesRuntimeClient();
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            var handle = join(provisioner.ensureResource(request, SEED, null));
            var live = join(provisioner.provision(request, SEED));
            var field = KubernetesRuntimeProvisioner.class.getDeclaredField("placements");
            field.setAccessible(true);
            var guarded = new ConcurrentHashMap<RuntimeProvisionSeed, Object>() {
                @Override
                public Collection<Object> values() {
                    throw new AssertionError("Lease lookups must not scan placements");
                }
            };
            ((Map<?, ?>) field.get(provisioner)).forEach((key, value) -> guarded.put((RuntimeProvisionSeed) key, value));
            field.set(provisioner, guarded);
            assertTrue(provisioner.isUsable(live));
            for (var miss : List.of(
                    new RuntimeLease("other", live.getEndpoint(), live.getToken(), live.getLeaseId(), live.getEpoch()),
                    new RuntimeLease(live.getRuntimeInstanceId(), live.getEndpoint(), "other", live.getLeaseId(), live.getEpoch()),
                    new RuntimeLease(live.getRuntimeInstanceId(), live.getEndpoint(), live.getToken(), "other", live.getEpoch()),
                    new RuntimeLease(live.getRuntimeInstanceId(), live.getEndpoint(), live.getToken(), live.getLeaseId(), live.getEpoch() + 1),
                    new RuntimeLease(live.getRuntimeInstanceId(), URI.create("http://10.42.0.9:43190/"), live.getToken(), live.getLeaseId(), live.getEpoch()))) {
                assertFalse(provisioner.isUsable(miss));
                assertEquals(409, failure(provisioner.confirm(request, miss)).getStatusCode());
            }
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    join(provisioner.reconcile(request(provisioner, "/different"), SEED, handle, live)).getOutcome());
            assertTrue(provisioner.isUsable(live));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-pod", "missing-all", "replaced-pod"})
    void pendingAdmissionNeverShadowsTheSuppliedOriginalHandle(String mutation) {
        var api = new FakeKubernetesRuntimeClient();
        RuntimeResourceHandle original;
        RuntimeProvisionRequest request;
        try (var first = provisioner(api)) {
            request = request(first, "/workspace");
            original = join(first.ensureResource(request, SEED, null));
        }
        try (var restored = provisioner(api)) {
            api.readFailure = new RuntimeBrokerException(503, "offline", "offline", true);
            assertEquals(503, failure(restored.ensureResource(request, SEED, null)).getStatusCode());
            api.readFailure = null;
            switch (mutation) {
                case "missing-pod" -> api.remove("pods");
                case "missing-all" -> api.objects.clear();
                case "replaced-pod" -> map(api.object("pods").get("metadata")).put("uid", "replacement");
                default -> throw new AssertionError(mutation);
            }
            assertEquals(409, failure(restored.ensureResource(request, SEED, original)).getStatusCode());
            assertEquals(2, api.creates);
        }
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
                api -> map(container(api).get("securityContext")).put("seccompProfile", Map.of("type", "Unconfined")),
                api -> map(container(api).get("securityContext")).put("seccompProfile", Map.of("type", "Localhost", "localhostProfile", "custom")),
                api -> map(container(api).get("securityContext")).put("procMount", "Unmasked"),
                api -> map(container(api).get("securityContext")).put("runAsUser", 0),
                api -> map(container(api).get("securityContext")).put("runAsNonRoot", false),
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
    void refusesContainerSecurityOverridesInTheCreateResponse() {
        for (var override : List.of(Map.<String, Object>of("seccompProfile", Map.of("type", "Unconfined")),
                Map.<String, Object>of("procMount", "Unmasked"), Map.<String, Object>of("runAsUser", 0),
                Map.<String, Object>of("runAsNonRoot", false), Map.<String, Object>of("runAsGroup", 0),
                Map.<String, Object>of("seLinuxOptions", Map.of("type", "unconfined_t")))) {
            var api = new FakeKubernetesRuntimeClient();
            api.podCreated = pod -> map(container(api).get("securityContext")).putAll(override);
            try (var provisioner = provisioner(api)) {
                failure(provisioner.ensureResource(request(provisioner, "/workspace"), SEED, null));
                assertEquals(2, api.creates);
            }
        }
    }

    @Test
    void acceptsExplicitRuntimeDefaultContainerSecurityControls() {
        var api = new FakeKubernetesRuntimeClient();
        api.podCreated = pod -> map(container(api).get("securityContext")).putAll(Map.of(
                "seccompProfile", Map.of("type", "RuntimeDefault"), "procMount", "Default",
                "runAsUser", 1000, "runAsNonRoot", true, "runAsGroup", 1000));
        try (var provisioner = provisioner(api)) {
            var request = request(provisioner, "/workspace");
            var handle = join(provisioner.ensureResource(request, SEED, null));
            var lease = join(provisioner.provision(request, SEED));
            assertEquals(RuntimeObservation.Outcome.READY,
                    join(provisioner.reconcile(request, SEED, handle, lease)).getOutcome());
            assertTrue(provisioner.isUsable(lease));
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
