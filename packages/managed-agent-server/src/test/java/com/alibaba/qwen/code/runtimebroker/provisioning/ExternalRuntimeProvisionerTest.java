package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
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
            assertEquals(seed.getLeaseId(), boot.get("leaseId"));
            assertEquals(seed.getGatewayIncarnation(), boot.get("runtimeIncarnation"));
            assertEquals("/workspace", boot.get("workspaceCwd"));
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
            assertThrows(CompletionException.class, () -> join(provider.provision(request, seed)));
            api.handle = null;
            assertThrows(CompletionException.class, () -> join(provider.provision(request, seed)));
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
    void brokerPersistsLogicalHandleBeforeLostProvisionReplyAndRetriesSameOperation() throws Exception {
        var api = new Provider();
        var bindings = new InMemoryRuntimeBindingRepository();
        var worker = worker(api);
        try (var provider = provisioner(api);
                var broker = broker(provider, bindings)) {
            api.provisionFailure = new RuntimeBrokerException(503, "timeout", "reply lost", true);
            assertThrows(CompletionException.class, () -> join(broker.warm("harness")));
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
    void brokerRetriesUnknownConfirmationOnOriginalLeaseAndRejectsEndpointDrift() throws Exception {
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
            assertEquals(lease, join(broker.warm("harness")).getLease());
            api.state = "UNKNOWN";
            assertThrows(CompletionException.class, () -> join(broker.warm("harness")));
            assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(ready.getBindingId()).getState());
            assertTrue(provider.isUsable(lease));
            api.state = "RUNNING";
            assertEquals(lease, join(broker.warm("harness")).getLease());
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
        private RuntimeBrokerException failure;
        private RuntimeBrokerException provisionFailure;
        private String endpoint = "https://worker.example/";
        private String state = "RUNNING";
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
            if (failure != null) {
                return CompletableFuture.failedFuture(failure);
            }
            return CompletableFuture.completedFuture(Map.of("protocolVersion", 1, "state", state,
                    "endpoint", endpoint));
        }
    }
}
