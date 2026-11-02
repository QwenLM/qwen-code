package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExternalRuntimeProvisionerTest {
    @Test
    void restoresOriginalHandleWithoutProvisioningOrStoppingWorker() {
        var api = new Provider();
        var seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeResourceHandle handle;
        RuntimeProvisionRequest request;
        RuntimeLease lease;
        try (var first = provisioner(api)) {
            request = request(first);
            handle = join(first.ensureResource(request, seed, null));
            assertEquals(Map.of("requestId", seed.getProvisionRequestId()), handle.getValue().get("provider"));
            assertEquals(0, api.provisions);
            assertEquals(0, api.observations);
            lease = join(first.provision(request, seed));
            assertEquals(seed.getToken(), lease.getToken());
            assertFalse(handle.toJson().contains(seed.getToken()));
            var boot = (Map<?, ?>) api.provisionRequest.get("boot");
            assertEquals(seed.getToken(), boot.get("token"));
            assertEquals(seed.getLeaseId(), boot.get("leaseId"));
            assertEquals(seed.getGatewayIncarnation(), boot.get("runtimeIncarnation"));
            assertEquals("/workspace", boot.get("workspaceCwd"));
            var scope = (Map<?, ?>) api.provisionRequest.get("scope");
            assertEquals("tenant", scope.get("tenantId"));
            assertEquals("workspace", scope.get("workspaceId"));
            assertEquals("1", scope.get("workspaceGeneration"));
            assertEquals("/workspace", scope.get("workspaceCwd"));
            assertEquals("session", scope.get("isolationClass"));
            assertEquals("harness", scope.get("isolationKey"));
        }
        try (var restored = provisioner(api)) {
            var observed = join(restored.reconcile(request, seed, handle, lease));
            assertEquals(RuntimeObservation.Outcome.READY, observed.getOutcome());
            assertEquals(handle, observed.getHandle());
            assertEquals(lease.getEndpoint(), observed.getEndpoint());
            join(restored.release(request, lease));
            assertTrue(restored.isUsable(lease));
        }
        assertEquals(1, api.provisions);
        assertEquals(seed.getProvisionRequestId(), api.observeRequest.get("provisionRequestId"));
        assertEquals(api.provisionRequest.get("identity"), api.observeRequest.get("identity"));
        assertEquals(api.provisionRequest.get("handle"), api.observeRequest.get("handle"));
    }

    @Test
    void refusesReplacementHandleAndScopeDrift() {
        var api = new Provider();
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            var handle = join(provider.ensureResource(request, seed, null));
            api.handle = Map.of("requestId", "replacement");
            assertEquals(handle, join(provider.ensureResource(request, seed, handle)));
            var mismatch = (RuntimeBrokerException) assertThrows(CompletionException.class,
                    () -> join(provider.provision(request, seed))).getCause();
            assertEquals(409, mismatch.getStatusCode());
            assertEquals("runtime_broker_resource_conflict", mismatch.getCode());
            assertFalse(mismatch.isRetryable());
            api.handle = null;
            var forgotten = (RuntimeBrokerException) assertThrows(CompletionException.class,
                    () -> join(provider.provision(request, seed))).getCause();
            assertEquals(409, forgotten.getStatusCode());
            assertEquals("runtime_broker_resource_conflict", forgotten.getCode());
            assertFalse(forgotten.isRetryable());
            assertEquals(1, api.provisions);
            var otherScope = provider.createRequest(new RuntimeScope("other-tenant", "workspace", "1", "/workspace",
                    "sha256:" + "a".repeat(64), "session"), "harness");
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    join(provider.reconcile(otherScope, seed, handle, null)).getOutcome());
            assertEquals(0, api.observations);
        }
    }

    @Test
    void timeoutIsUnknownAndGoneCannotCreateAReplacement() {
        var api = new Provider();
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            var handle = join(provider.ensureResource(request, seed, null));
            var lease = join(provider.provision(request, seed));
            api.failure = new RuntimeBrokerException(503, "offline", "offline", true);
            assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                    join(provider.reconcile(request, seed, handle, lease)).getOutcome());
            assertTrue(provider.isUsable(lease));
            assertTrue(provider.canRetryFailedConfirm(lease));
            api.failure = null;
            assertEquals(RuntimeObservation.Outcome.READY,
                    join(provider.reconcile(request, seed, handle, lease)).getOutcome());
            api.state = "GONE";
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    join(provider.reconcile(request, seed, handle, lease)).getOutcome());
            assertFalse(provider.isUsable(lease));
            assertFalse(provider.canRetryFailedConfirm(lease));
            assertEquals(1, api.provisions);
        }
    }

    @Test
    void missingOperationObservationDoesNotAllocate() {
        var api = new Provider();
        api.state = "UNKNOWN";
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            var handle = join(provider.ensureResource(request, seed, null));
            var observed = join(provider.reconcile(request, seed, handle, null));
            assertEquals(RuntimeObservation.Outcome.UNKNOWN, observed.getOutcome());
            assertNull(observed.getEndpoint());
            assertEquals(0, api.provisions);
            assertEquals(1, api.observations);
        }
    }

    @Test
    void shutdownDuringReconcileAnswersUnknownInsteadOfConflict() {
        var api = new Provider();
        var provider = provisioner(api);
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var request = request(provider);
        var handle = join(provider.ensureResource(request, seed, null));
        api.closing = provider::close;
        assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                join(provider.reconcile(request, seed, handle, null)).getOutcome());
    }

    @Test
    void shutdownDuringProvisionPollFailsRetryable() {
        var api = new Provider();
        var provider = provisioner(api);
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var request = request(provider);
        join(provider.ensureResource(request, seed, null));
        api.closing = provider::close;
        var failure = (RuntimeBrokerException) assertThrows(CompletionException.class,
                () -> join(provider.provision(request, seed))).getCause();
        assertEquals("runtime_external_unavailable", failure.getCode());
        assertTrue(failure.isRetryable());
    }

    @Test
    void permanentProvisionFailureFreesThePlacement() {
        var api = new Provider();
        api.provisionFailure = new RuntimeBrokerException(404, "runtime_external_provider_failed",
                "Provider path is missing.", false);
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            join(provider.ensureResource(request, seed, null));
            assertThrows(CompletionException.class, () -> join(provider.provision(request, seed)));
            assertThrows(CompletionException.class, () -> join(provider.provision(request, seed)));
            assertEquals(1, api.provisions);
        }
    }

    @Test
    void providerFailureSurfacesWithItsOwnCodeStatusAndRetryableFlag() {
        var api = new Provider();
        api.failure = new RuntimeBrokerException(404, "runtime_external_provider_failed",
                "Provider path is missing.", false);
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            join(provider.ensureResource(request, seed, null));
            var failure = (RuntimeBrokerException) assertThrows(CompletionException.class,
                    () -> join(provider.provision(request, seed))).getCause();
            assertEquals(404, failure.getStatusCode());
            assertEquals("runtime_external_provider_failed", failure.getCode());
            assertFalse(failure.isRetryable());
        }
    }

    @Test
    void abandonedPreCreateAdmissionsDoNotConsumePlacementCapacity() {
        var api = new Provider();
        try (var provider = provisioner(api)) {
            var request = request(provider);
            for (int n = 0; n <= ExternalRuntimeProvisioner.MAX_PLACEMENTS; n++) {
                var bindings = new InMemoryRuntimeBindingRepository();
                var binding = bindings.claimOperation(bindings.findOrCreate(request).getBindingId(),
                        "broker", Duration.ofMinutes(1));
                provider.reserveResource(binding);
            }
            var seed = RuntimeProvisionSeed.create("binding", 1);
            join(provider.ensureResource(request, seed, null));
            assertEquals(0, api.provisions);
            assertEquals(0, api.observations);
        }
    }

    @Test
    void placementCapacityRejectsFreshSeedsButReadmitsAdmittedOnes() {
        var api = new Provider();
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            var admittedHandle = join(provider.ensureResource(request, seed, null));
            for (int n = 0; n < ExternalRuntimeProvisioner.MAX_PLACEMENTS - 1; n++) {
                join(provider.ensureResource(request, RuntimeProvisionSeed.create("binding-" + n, 1), null));
            }
            assertEquals(0, api.provisions);
            assertEquals(0, api.observations);
            // An admitted seed re-admits without rechecking the bound.
            assertEquals(admittedHandle, join(provider.ensureResource(request, seed, admittedHandle)));
            var bindings = new InMemoryRuntimeBindingRepository();
            var fresh = bindings.claimOperation(bindings.findOrCreate(request).getBindingId(),
                    "broker", Duration.ofMinutes(1));
            var failure = assertThrows(RuntimeBrokerException.class, () -> provider.reserveResource(fresh));
            assertEquals(503, failure.getStatusCode());
            assertEquals("runtime_external_capacity", failure.getCode());
            assertTrue(failure.isRetryable());
            var lateFailure = (RuntimeBrokerException) assertThrows(CompletionException.class,
                    () -> join(provider.ensureResource(request, fresh.getProvisionSeed(), null))).getCause();
            assertEquals("runtime_external_capacity", lateFailure.getCode());
            assertTrue(lateFailure.isRetryable());
            assertEquals(admittedHandle, join(provider.ensureResource(request, seed, admittedHandle)));
        }
    }

    @Test
    void startingPollsUntilRunning() {
        var api = new Provider();
        api.startingLeft = 2;
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            join(provider.ensureResource(request, seed, null));
            var lease = join(provider.provision(request, seed));
            assertEquals(seed.getToken(), lease.getToken());
            assertEquals(3, api.observations);
        }
    }

    @Test
    void alwaysStartingExhaustsTheStartupTimeoutRetryably() {
        var api = new Provider();
        api.state = "STARTING";
        var seed = RuntimeProvisionSeed.create("binding", 1);
        try (var provider = provisioner(api)) {
            var request = request(provider);
            join(provider.ensureResource(request, seed, null));
            var failure = (RuntimeBrokerException) assertThrows(CompletionException.class,
                    () -> join(provider.provision(request, seed))).getCause();
            assertEquals("runtime_external_unavailable", failure.getCode());
            assertTrue(failure.isRetryable());
            assertTrue(api.observations > 1, "poll loop must not collapse to one observation");
        }
    }

    @Test
    void brokerPersistsLogicalHandleBeforeLostProvisionReplyAndRetriesSameOperation() throws Exception {
        var api = new Provider();
        var bindings = new InMemoryRuntimeBindingRepository();
        var worker = worker(api);
        try (var provider = provisioner(api);
                var broker = broker(provider, bindings)) {
            api.provisionFailure = new RuntimeBrokerException(503, "timeout", "reply lost", true);
            var lost = (RuntimeBrokerException) assertThrows(CompletionException.class,
                    () -> join(broker.warm("harness"))).getCause();
            assertEquals(503, lost.getStatusCode());
            assertEquals("timeout", lost.getCode());
            assertTrue(lost.isRetryable());
            var retained = bindings.findOrCreate(request(provider));
            assertEquals(RuntimeBindingRecord.State.PROVISIONING, retained.getState());
            var handle = retained.getResourceHandle();
            assertTrue(provider.supportsStartupRecovery(handle));
            assertEquals(Map.of("requestId", retained.getProvisionSeed().getProvisionRequestId()),
                    handle.getValue().get("provider"));
            var originalPost = api.provisionRequest;
            assertEquals(handle.getValue().get("provider"), originalPost.get("handle"));
            assertEquals(0, api.observations);
            api.provisionFailure = null;
            var ready = join(broker.warm("harness"));
            assertEquals(RuntimeBindingRecord.State.READY, ready.getState());
            assertEquals(retained.getBindingId(), ready.getBindingId());
            assertEquals(retained.getGeneration(), ready.getGeneration());
            assertEquals(retained.getProvisionSeed(), ready.getProvisionSeed());
            assertEquals(handle, ready.getResourceHandle());
            assertEquals(originalPost, api.provisionRequest);
            assertEquals(2, api.provisions);
        } finally {
            worker.stop(0);
        }
    }

    @Test
    void brokerShutdownDuringConfirmationDoesNotInvalidateTheReadyBinding() throws Exception {
        var api = new Provider();
        var bindings = new InMemoryRuntimeBindingRepository();
        var worker = worker(api);
        try (var provider = provisioner(api);
                var broker = broker(provider, bindings)) {
            var ready = join(broker.warm("harness"));
            api.closing = broker::close;
            var failure = (RuntimeBrokerException) assertThrows(CompletionException.class,
                    () -> join(broker.warm("harness"))).getCause();
            assertEquals("runtime_external_unavailable", failure.getCode());
            assertTrue(failure.isRetryable());
            assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(ready.getBindingId()).getState());
            assertFalse(provider.isUsable(ready.getLease()));
            assertTrue(provider.canRetryFailedConfirm(ready.getLease()));
            assertEquals(1, api.provisions);
        } finally {
            worker.stop(0);
        }
    }

    @Test
    void brokerRetriesUncertainConfirmationOnOriginalLeaseAndRejectsEndpointDrift() throws Exception {
        var api = new Provider();
        var bindings = new InMemoryRuntimeBindingRepository();
        var worker = worker(api);
        try (var provider = provisioner(api);
                var broker = broker(provider, bindings)) {
            var ready = join(broker.warm("harness"));
            var lease = ready.getLease();
            api.failure = new RuntimeBrokerException(503, "timeout", "timeout", true);
            assertThrows(CompletionException.class, () -> join(broker.warm("harness")));
            assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(ready.getBindingId()).getState());
            assertTrue(provider.isUsable(lease));
            assertTrue(provider.canRetryFailedConfirm(lease));
            var forged = new RuntimeLease(lease.getRuntimeInstanceId(), URI.create("https://other.example/"),
                    lease.getToken(), lease.getLeaseId(), lease.getEpoch());
            assertFalse(provider.isUsable(forged));
            assertFalse(provider.canRetryFailedConfirm(forged));
            api.failure = null;
            assertSameLease(lease, join(broker.warm("harness")).getLease());
            for (String state : new String[] {"UNKNOWN", "STARTING"}) {
                api.state = state;
                var failure = (RuntimeBrokerException) assertThrows(CompletionException.class,
                        () -> join(broker.warm("harness"))).getCause();
                assertEquals("runtime_external_unavailable", failure.getCode());
                assertTrue(failure.isRetryable());
                assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(ready.getBindingId()).getState());
                assertTrue(provider.isUsable(lease));
                assertTrue(provider.canRetryFailedConfirm(lease));
                api.state = "RUNNING";
                assertSameLease(lease, join(broker.warm("harness")).getLease());
            }
            api.endpoint = "https://replacement.example/";
            assertThrows(CompletionException.class, () -> join(broker.warm("harness")));
            assertEquals(RuntimeBindingRecord.State.LOST, bindings.findById(ready.getBindingId()).getState());
            assertFalse(provider.isUsable(lease));
            assertFalse(provider.canRetryFailedConfirm(lease));
            assertEquals(1, api.provisions);
        } finally {
            worker.stop(0);
        }
    }

    private static void assertSameLease(RuntimeLease expected, RuntimeLease actual) {
        assertEquals(expected.getRuntimeInstanceId(), actual.getRuntimeInstanceId());
        assertEquals(expected.getLeaseId(), actual.getLeaseId());
        assertEquals(expected.getEpoch(), actual.getEpoch());
        assertEquals(expected.getToken(), actual.getToken());
        assertEquals(expected.getEndpoint(), actual.getEndpoint());
    }

    private static RuntimeBrokerService broker(ExternalRuntimeProvisioner provider,
            InMemoryRuntimeBindingRepository bindings) {
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(request(provider).getScope()),
                provider, new HttpRuntimeTransport(), bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
    }

    private static HttpServer worker(Provider api) throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/managed-runtime/v2/attest", exchange -> {
            exchange.getRequestBody().readAllBytes();
            var boot = (Map<?, ?>) api.provisionRequest.get("boot");
            var response = new LinkedHashMap<String, Object>();
            boot.forEach((key, value) -> response.put((String) key, value));
            response.remove("type");
            response.remove("version");
            response.remove("token");
            response.put("protocolVersion", 2);
            byte[] bytes = JsonCodec.encode(response);
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        api.endpoint = "http://127.0.0.1:" + server.getAddress().getPort();
        return server;
    }

    private static ExternalRuntimeProvisioner provisioner(Provider api) {
        return new ExternalRuntimeProvisioner(api, "provider-a", Duration.ofSeconds(1));
    }

    private static RuntimeProvisionRequest request(ExternalRuntimeProvisioner provider) {
        return provider.createRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                "sha256:" + "a".repeat(64), "session"), "harness");
    }

    private static <T> T join(CompletionStage<T> stage) {
        return stage.toCompletableFuture().join();
    }

    private static final class Provider implements ExternalRuntimeClient {
        private Map<String, Object> handle;
        private volatile Map<String, Object> provisionRequest;
        private volatile Map<String, Object> observeRequest;
        private RuntimeBrokerException failure;
        private RuntimeBrokerException provisionFailure;
        private Runnable closing;
        private String endpoint = "https://worker.example/";
        private String state = "RUNNING";
        private int startingLeft;
        private int provisions;
        private int observations;

        @Override
        public CompletionStage<Map<String, Object>> provision(Map<String, Object> request) {
            provisions++;
            provisionRequest = request;
            if (provisionFailure != null) {
                return CompletableFuture.failedFuture(provisionFailure);
            }
            return CompletableFuture.completedFuture(Map.of("protocolVersion", 1,
                    "handle", handle == null ? request.get("handle") : handle));
        }

        @Override
        public CompletionStage<Map<String, Object>> observe(Map<String, Object> request) {
            observations++;
            observeRequest = request;
            if (closing != null) {
                closing.run();
            }
            if (failure != null) {
                return CompletableFuture.failedFuture(failure);
            }
            String observed = state;
            if (startingLeft > 0) {
                startingLeft--;
                observed = "STARTING";
            }
            return CompletableFuture.completedFuture(Map.of("protocolVersion", 1, "state", observed,
                    "endpoint", endpoint));
        }
    }
}
