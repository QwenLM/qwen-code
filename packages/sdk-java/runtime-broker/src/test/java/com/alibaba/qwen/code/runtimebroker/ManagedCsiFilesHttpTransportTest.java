package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.ManagedCsiFilesProtocolTest.map;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class ManagedCsiFilesHttpTransportTest {
    @Test
    void actualPrivateProducersUseOnlyCsi2AndVerifyOriginalIdentityAndIncarnation() throws Exception {
        var fixture = ManagedCsiFilesProtocolTest.fixtures();
        var request = ManagedCsiFilesProtocolTest.request(fixture);
        var seed = ManagedCsiFilesProtocolTest.seed(fixture);
        var boot = map(fixture.get("boot"));
        var storage = map(boot.get("storage"));
        var pod = map(fixture.get("expectedPod"));
        var paths = List.of(ManagedCsiFilesProtocol.CONTEXT_ATTEST_PATH, ManagedCsiFilesProtocol.ATTEST_PATH, ManagedCsiFilesProtocol.CONTEXT_PATH);
        var bodies = List.of(map(fixture.get("contextAttestationRequest")), map(fixture.get("attestationRequest")), map(fixture.get("installationRequest")));
        var replies = List.of(map(fixture.get("contextAttestationResponse")), map(fixture.get("attestationResponse")), map(fixture.get("installationResponse")));
        var calls = new AtomicInteger();
        var errors = new ConcurrentLinkedQueue<Throwable>();
        var badReply = new AtomicReference<byte[]>();
        var header = new AtomicReference<>(seed.getGatewayIncarnation());
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try {
                int index = calls.getAndIncrement();
                int operation = index < 3 ? index : 0;
                assertEquals(paths.get(operation), exchange.getRequestURI().toString());
                assertEquals("POST", exchange.getRequestMethod());
                assertEquals("Bearer " + seed.getToken(), exchange.getRequestHeaders().getFirst("Authorization"));
                assertEquals("no-store", exchange.getRequestHeaders().getFirst("Cache-Control"));
                assertEquals(seed.getLeaseId(), exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Id"));
                assertEquals(Long.toString(seed.getEpoch()), exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Epoch"));
                assertTrue(BrokerValues.sameJsonMap(bodies.get(operation), ManagedCsiFilesProtocol.parse(exchange.getRequestBody().readAllBytes())));
                byte[] bytes = badReply.get() == null ? JsonCodec.encode(replies.get(operation)) : badReply.get();
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.getResponseHeaders().set("X-Qwen-Managed-Runtime-Incarnation", header.get());
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (Throwable error) {
                errors.add(error);
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            var transport = new HttpRuntimeTransport();
            assertEquals(request.getStorageId(), transport.attest(lease, request, seed).toCompletableFuture().join().getStorageId());
            assertTrue(BrokerValues.sameJsonMap(replies.get(1), transport.attestCsi(lease, request, seed, storage, pod).toCompletableFuture().join()));
            var value = map(map(fixture.get("installationRequest")).get("context"));
            var context = map(value.get("binding"));
            var binding = new ContextBinding((String) context.get("tenantId"), (String) context.get("workspaceId"),
                    Long.parseLong((String) context.get("workspaceGeneration")), (String) context.get("storageId"), ".",
                    (String) context.get("contextConfigRef"), 1);
            Instant now = Instant.now();
            var runtime = new RuntimeBindingRecord("binding-1", request, seed, 1, RuntimeBindingRecord.State.READY, lease,
                    new RuntimeResourceHandle("kubernetes-workspace", 2, Map.of("fixture", "not-production-placement")),
                    1, false, null, null, 0, 0, now, now, now);
            var session = new RuntimeSession(request.getIsolationKey(), request.getIsolationKey(), "bootstrap", request.getScope());
            var record = new RuntimeSessionRecord(session, runtime.getBindingId(), runtime.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, now);
            assertTrue(BrokerValues.sameJsonMap(map(replies.get(2).get("context")), transport.installContext(runtime, record,
                    "install-01", binding).toCompletableFuture().join()));
            badReply.set("{\"protocolVersion\":2,\"protocolVersion\":2}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertThrows(CompletionException.class, () -> transport.attest(lease, request, seed).toCompletableFuture().join());
            badReply.set(null);
            header.set("foreign-incarnation");
            assertThrows(CompletionException.class, () -> transport.attest(lease, request, seed).toCompletableFuture().join());
            var foreignSession = new RuntimeSession(request.getIsolationKey(), "other-runtime-session", "bootstrap", request.getScope());
            var foreign = new RuntimeSessionRecord(foreignSession, runtime.getBindingId(), runtime.getGeneration(), RuntimeSessionRecord.State.READY, 0, now);
            assertThrows(IllegalArgumentException.class, () -> transport.installContext(runtime, foreign, "install-01", binding));
            assertEquals(5, calls.get());
            assertEquals(List.of(), new ArrayList<>(errors));
        } finally {
            server.stop(0);
        }
    }
}
