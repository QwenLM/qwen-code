package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletionException;
import org.junit.jupiter.api.Test;

class ManagedCsiHttpTransportTest {
    @Test
    void sendsOneAuthenticatedCsiRequestAndRefusesCrossedStorageOrContextOnlyReplies() throws Exception {
        var fixtures = ManagedContextProtocol.parse(Files.readAllBytes(
                Path.of("../../cli/src/serve/contracts/managed-csi-v1.fixtures.json")));
        var boot = map(fixtures.get("boot"));
        var context = map(boot.get("context"));
        var storage = map(boot.get("storage"));
        var pod = map(fixtures.get("expectedPod"));
        var scope = new RuntimeScope((String) context.get("tenantId"), (String) context.get("workspaceId"),
                (String) context.get("workspaceGeneration"), (String) context.get("mountRoot"),
                (String) context.get("capabilityDigest"), (String) context.get("isolationClass"));
        var request = new RuntimeProvisionRequest(scope,
                scope.getIsolationClass().equals("session") ? "harness" : null,
                "kubernetes-workspace", (String) context.get("storageId"));
        var seed = new RuntimeProvisionSeed((String) context.get("provisionRequestId"),
                (String) context.get("runtimeInstanceId"), (String) context.get("runtimeIncarnation"),
                (String) context.get("leaseId"), BrokerValues.exactLong(context.get("epoch")),
                (String) context.get("token"));
        var original = map(fixtures.get("attestationResponse"));
        var crossed = new LinkedHashMap<>(original);
        crossed.put("pod", Map.of("uid", "22222222-2222-3333-4444-555555555555",
                "namespace", pod.get("namespace"), "nodeName", pod.get("nodeName")));
        var answers = new ArrayList<>(java.util.List.of(original, crossed, original.get("context")));
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        var errors = new java.util.concurrent.ConcurrentLinkedQueue<Throwable>();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try {
                assertEquals(ManagedCsiProtocol.ATTEST_PATH, exchange.getRequestURI().toString());
                assertEquals("POST", exchange.getRequestMethod());
                assertEquals("Bearer " + seed.getToken(), exchange.getRequestHeaders().getFirst("Authorization"));
                assertEquals("no-store", exchange.getRequestHeaders().getFirst("Cache-Control"));
                assertEquals(seed.getLeaseId(), exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Id"));
                assertEquals(Long.toString(seed.getEpoch()), exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Epoch"));
                assertEquals(fixtures.get("attestationRequest"), ManagedContextProtocol.parse(exchange.getRequestBody().readAllBytes()));
                byte[] bytes = JsonCodec.encode(answers.get(calls.getAndIncrement()));
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.getResponseHeaders().set("Content-Type", "application/json");
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
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:" + server.getAddress().getPort()), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            var transport = new HttpRuntimeTransport();
            assertEquals(original, transport.attestCsi(lease, request, seed, storage, pod).toCompletableFuture().join());
            for (int index = 0; index < 2; index++) {
                var failure = assertInstanceOf(RuntimeBrokerException.class, assertThrows(CompletionException.class,
                        () -> transport.attestCsi(lease, request, seed, storage, pod).toCompletableFuture().join()).getCause());
                assertEquals("workspace_csi_identity_conflict", failure.getCode());
                assertFalse(failure.isRetryable());
            }
            var foreign = new RuntimeLease("other-runtime", lease.getEndpoint(), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            assertThrows(IllegalArgumentException.class, () -> transport.attestCsi(foreign, request, seed, storage, pod));
            var invalidPod = new LinkedHashMap<>(pod);
            invalidPod.put("nodeName", "node.");
            assertThrows(IllegalArgumentException.class, () -> transport.attestCsi(lease, request, seed, storage, invalidPod));
            var redirects = new HttpRuntimeTransport(java.net.http.HttpClient.newBuilder()
                    .followRedirects(java.net.http.HttpClient.Redirect.ALWAYS).build());
            assertThrows(IllegalArgumentException.class, () -> redirects.attestCsi(lease, request, seed, storage, pod));
            assertEquals(3, calls.get());
            assertEquals(java.util.List.of(), new ArrayList<>(errors));
        } finally {
            server.stop(0);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }
}
