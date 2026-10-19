package com.alibaba.qwen.code.runtimebroker.provisioning;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;


class KubernetesHttpRuntimeClientTest {
    @TempDir
    Path directory;
    private HttpServer server;
    private URI origin;
    private Path token;
    private KubernetesHttpRuntimeClient client;
    private final AtomicReference<String> authorization = new AtomicReference<>();
    private final AtomicReference<String> path = new AtomicReference<>();
    private final AtomicReference<String> method = new AtomicReference<>();
    private final AtomicReference<String> requestBody = new AtomicReference<>();
    private final AtomicReference<String> contentType = new AtomicReference<>();
    private final AtomicReference<byte[]> response = new AtomicReference<>("{\"kind\":\"Pod\"}".getBytes(StandardCharsets.UTF_8));
    private final AtomicInteger status = new AtomicInteger(200);
    private final AtomicInteger calls = new AtomicInteger();
    private final CountDownLatch releaseBody = new CountDownLatch(1);
    private volatile boolean stallBody;
    private java.util.concurrent.ExecutorService executor;

    @BeforeEach
    void start() throws Exception {
        token = directory.resolve("token");
        Files.writeString(token, "token-one\n");
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        executor = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(executor);
        server.createContext("/", exchange -> {
            calls.incrementAndGet();
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            path.set(exchange.getRequestURI().toString());
            method.set(exchange.getRequestMethod());
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            exchange.getResponseHeaders().set("Location", origin.resolve("/redirected").toString());
            exchange.sendResponseHeaders(status.get(), response.get().length);
            try {
                if (stallBody) {
                    releaseBody.await(3, TimeUnit.SECONDS);
                }
                exchange.getResponseBody().write(response.get());
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        server.start();
        origin = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
        client = new KubernetesHttpRuntimeClient(origin, token,
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build(), Duration.ofSeconds(1));
    }

    @AfterEach
    void stop() {
        releaseBody.countDown();
        client.close();
        server.stop(0);
        executor.shutdownNow();
    }

    @Test
    void readsImmutableWorkerArtifactsWithoutAddingConfigMapWriteSupport() {
        client.get("configmaps", "runtimes", "worker-000").toCompletableFuture().join();
        assertEquals("/api/v1/namespaces/runtimes/configmaps/worker-000", path.get());
        assertEquals("GET", method.get());
        assertThrows(IllegalArgumentException.class, () -> client.create("configmaps", "runtimes", Map.of()));
        assertEquals(1, calls.get());
    }

    @Test
    void readsFullSizeArtifactChunksWithBoundedJsonEnvelopeHeadroom() {
        var object = Map.of("kind", "ConfigMap", "binaryData", Map.of("chunk", "A".repeat(1024 * 1024)));
        response.set(JsonCodec.encode(object));
        assertEquals(object, client.get("configmaps", "runtimes", "worker-000").toCompletableFuture().join());
        response.set(JsonCodec.encode(Map.of("binaryData", Map.of("chunk", "A".repeat(1024 * 1024 + 64 * 1024)))));
        assertEquals(502, failure(client.get("configmaps", "runtimes", "worker-000").toCompletableFuture()).getStatusCode());
    }

    @Test
    void readsRotatedTokenForEachNamespacedCall() throws Exception {
        assertEquals(Map.of("kind", "Pod"), client.get("pods", "runtimes", "pod-one").toCompletableFuture().join());
        assertEquals("Bearer token-one", authorization.get());
        assertEquals("/api/v1/namespaces/runtimes/pods/pod-one", path.get());
        assertEquals("GET", method.get());
        Files.writeString(token, "token-two");
        status.set(201);
        client.create("secrets", "runtimes", Map.of("kind", "Secret")).toCompletableFuture().join();
        assertEquals("Bearer token-two", authorization.get());
        assertEquals("/api/v1/namespaces/runtimes/secrets", path.get());
        assertEquals("POST", method.get());
        assertEquals("{\"kind\":\"Secret\"}", requestBody.get());
    }

    @Test
    void readsOnlyExplicitStorageAndProtectionResourcesWithoutClusterWrites() {
        client.get("persistentvolumeclaims", "runtimes", "workspace.claim").toCompletableFuture().join();
        assertEquals("/api/v1/namespaces/runtimes/persistentvolumeclaims/workspace.claim", path.get());
        for (String resource : new String[] {"persistentvolumes", "namespaces", "nodes"}) {
            String name = resource.equals("namespaces") ? "runtimes" : "object.one";
            client.getCluster(resource, name).toCompletableFuture().join();
            assertEquals("/api/v1/" + resource + "/" + name, path.get());
            assertEquals("GET", method.get());
        }
        for (String resource : new String[] {"validatingadmissionpolicies", "validatingadmissionpolicybindings"}) {
            client.getCluster(resource, "workspace.one").toCompletableFuture().join();
            assertEquals("/apis/admissionregistration.k8s.io/v1/" + resource + "/workspace.one", path.get());
            assertEquals("GET", method.get());
        }
        client.getCluster("runtimeclasses", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS).toCompletableFuture().join();
        assertEquals("/apis/node.k8s.io/v1/runtimeclasses/qwen-k2-runc-v1", path.get());
        assertEquals("GET", method.get());
        status.set(404);
        assertNull(client.getCluster("persistentvolumes", "absent").toCompletableFuture().join());
        assertNull(client.getCluster("runtimeclasses", "absent").toCompletableFuture().join());
        int original = calls.get();
        for (String name : new String[] {"../pv", ".", "pv..name", "pv?name", "pv/name", "x".repeat(254)}) {
            assertThrows(IllegalArgumentException.class, () -> client.getCluster("persistentvolumes", name));
        }
        assertThrows(IllegalArgumentException.class, () -> client.getCluster("namespaces", "namespace.with.dots"));
        assertThrows(IllegalArgumentException.class, () -> client.getCluster("clusterroles", "admin"));
        assertThrows(IllegalArgumentException.class, () -> client.getCluster("runtimeclasses", "runtime.with.dots"));
        assertThrows(IllegalArgumentException.class, () -> client.get("runtimeclasses", "runtimes", "qwen-k2-runc-v1"));
        assertThrows(IllegalArgumentException.class,
                () -> client.create("runtimeclasses", "runtimes", Map.of("kind", "RuntimeClass")));
        assertThrows(IllegalArgumentException.class,
                () -> client.create("persistentvolumeclaims", "runtimes", Map.of("kind", "PersistentVolumeClaim")));
        assertThrows(IllegalArgumentException.class,
                () -> client.create("validatingadmissionpolicies", "runtimes", Map.of("kind", "ValidatingAdmissionPolicy")));
        assertEquals(original, calls.get());
    }

    @Test
    void removesOnlyTheSourceGateWithUidVersionAndWholeSpecPreconditions() {
        String uid = "aa36d481-0995-4060-8ce7-f3d42c3e408f";
        var spec = Map.<String, Object>of("restartPolicy", "Never", "schedulingGates",
                List.of(Map.of("name", KubernetesHttpRuntimeClient.CSI_SOURCE_GATE)));
        client.releaseCsiSchedulingGate("runtimes", "original", uid, "314", spec).toCompletableFuture().join();
        assertEquals("PATCH", method.get());
        assertEquals("application/json-patch+json", contentType.get());
        assertEquals("/api/v1/namespaces/runtimes/pods/original", path.get());
        var patch = parseArray(requestBody.get());
        assertEquals(List.of(Map.of("op", "test", "path", "/metadata/uid", "value", uid),
                Map.of("op", "test", "path", "/metadata/resourceVersion", "value", "314"),
                Map.of("op", "test", "path", "/spec", "value", spec),
                Map.of("op", "remove", "path", "/spec/schedulingGates")), patch);
        status.set(409);
        assertEquals(409, failure(client.releaseCsiSchedulingGate("runtimes", "original", uid, "314", spec)
                .toCompletableFuture()).getStatusCode());
        assertEquals(2, calls.get());
        var invalid = new java.util.LinkedHashMap<>(spec);
        invalid.put("nodeName", "bypass");
        assertThrows(IllegalArgumentException.class,
                () -> client.releaseCsiSchedulingGate("runtimes", "original", uid, "314", invalid));
        assertEquals(2, calls.get());
    }

    @Test
    void sendsPreparedNormalDeletionAndPreservesEveryObservedReply() {
        String uid = "aa36d481-0995-4060-8ce7-f3d42c3e408f";
        var request = CsiPodDeletion.prepare("runtimes", "original", uid, "opaque:315");
        byte[] originalBytes = ("{\"apiVersion\":\"v1\",\"kind\":\"DeleteOptions\",\"gracePeriodSeconds\":30,"
                + "\"propagationPolicy\":\"Background\",\"preconditions\":{\"uid\":\"" + uid + "\",\"resourceVersion\":\"opaque:315\"}}")
                .getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(originalBytes, request.bytes());
        byte[] callerCopy = request.bytes();
        callerCopy[0] = 0;
        assertArrayEquals(originalBytes, request.bytes());
        assertEquals("runtimes", request.namespace());
        assertEquals("original", request.name());
        assertEquals(uid, request.uid());
        assertEquals("opaque:315", request.resourceVersion());
        byte[] reply = "{\n \"kind\": \"Status\", \"status\": \"Success\"\n}".getBytes(StandardCharsets.UTF_8);
        response.set(reply);
        for (int code : new int[] {200, 202}) {
            status.set(code);
            var result = client.deleteCsiPod(request).toCompletableFuture().join();
            assertTrue(result.accepted());
            assertEquals(code, result.statusCode());
            assertEquals(request, result.request());
            assertArrayEquals(reply, result.responseBytes());
            byte[] copy = result.responseBytes();
            copy[0] = 0;
            assertArrayEquals(reply, result.responseBytes());
            assertEquals("DELETE", method.get());
            assertEquals("application/json", contentType.get());
            assertArrayEquals(originalBytes, requestBody.get().getBytes(StandardCharsets.UTF_8));
            assertEquals("/api/v1/namespaces/runtimes/pods/original", path.get());
            var options = JsonCodec.parseObject(requestBody.get().getBytes(StandardCharsets.UTF_8), "delete options");
            assertEquals(Map.of("uid", uid, "resourceVersion", "opaque:315"), options.get("preconditions"));
            assertEquals(30, options.get("gracePeriodSeconds"));
            assertEquals("Background", options.get("propagationPolicy"));
            assertEquals(5, options.size());
        }
        for (int code : new int[] {404, 409, 302, 429, 500}) {
            status.set(code);
            var result = client.deleteCsiPod(request).toCompletableFuture().join();
            assertFalse(result.accepted());
            assertEquals(code, result.statusCode());
            assertArrayEquals(reply, result.responseBytes());
            assertArrayEquals(originalBytes, requestBody.get().getBytes(StandardCharsets.UTF_8));
        }
        assertEquals(7, calls.get());
        assertThrows(IllegalArgumentException.class, () -> client.deleteCsiPod(null));
        assertThrows(IllegalArgumentException.class, () -> CsiPodDeletion.prepare("runtimes", "original", uid, ""));
        assertThrows(IllegalArgumentException.class, () -> CsiPodDeletion.prepare("runtimes", "../original", uid, "315"));
        assertEquals(7, calls.get());
    }

    @Test
    void restoresOnlyTheExactSavedDeletionRequest() {
        String uid = "aa36d481-0995-4060-8ce7-f3d42c3e408f";
        var prepared = CsiPodDeletion.prepare("runtimes", "original", uid, "opaque:315");
        byte[] saved = prepared.bytes();
        var restored = CsiPodDeletion.restore("runtimes", "original", uid, "opaque:315", saved);
        saved[0] = 0;
        assertArrayEquals(prepared.bytes(), restored.bytes());
        assertThrows(IllegalArgumentException.class, () -> CsiPodDeletion.restore("runtimes", "original", uid, "316", prepared.bytes()));
        assertThrows(IllegalArgumentException.class, () -> CsiPodDeletion.restore("runtimes", "original", uid, "opaque:315", saved));
        assertThrows(IllegalArgumentException.class, () -> CsiPodDeletion.restore("runtimes", "original", uid, "opaque:315", null));
        assertEquals(0, calls.get());
    }

    @Test
    void oversizedDeleteReplyNeverCreatesAnAcceptedResult() {
        response.set(new byte[1024 * 1024 + 1]);
        var request = CsiPodDeletion.prepare("runtimes", "original", "aa36d481-0995-4060-8ce7-f3d42c3e408f", "315");
        assertEquals(502, failure(client.deleteCsiPod(request).toCompletableFuture()).getStatusCode());
        assertEquals(1, calls.get());
    }

    @Test
    void stalledDeleteBodyRemainsUnknownDespiteAnAcceptedHeader() {
        stallBody = true;
        var request = CsiPodDeletion.prepare("runtimes", "original", "aa36d481-0995-4060-8ce7-f3d42c3e408f", "315");
        try (var bounded = new KubernetesHttpRuntimeClient(origin, token, HttpClient.newHttpClient(), Duration.ofMillis(500))) {
            assertEquals(503, failure(bounded.deleteCsiPod(request).toCompletableFuture()).getStatusCode());
        }
        assertEquals(1, calls.get());
    }

    private static Object parseArray(String value) {
        try { return new com.fasterxml.jackson.databind.ObjectMapper().readValue(value, Object.class); }
        catch (java.io.IOException invalid) { throw new AssertionError(invalid); }
    }

    @Test
    void readsCompleteCurrentCsiLogsWithNativeTimestampsAndNoServerTruncation() throws Exception {
        String logs = "2026-10-01T16:40:42.007Z original CSI line\n";
        response.set(logs.getBytes(StandardCharsets.UTF_8));
        assertEquals(logs, client.readCsiPodLog("csi-plugin-one").toCompletableFuture().join());
        assertEquals("/api/v1/namespaces/kube-system/pods/csi-plugin-one/log"
                + "?container=csi-plugin&timestamps=true&previous=false&follow=false", path.get());
        assertEquals("GET", method.get());
        Files.writeString(token, "rotated-log-token");
        client.readCsiPodLog("csi-plugin-one").toCompletableFuture().join();
        assertEquals("Bearer rotated-log-token", authorization.get());
        int original = calls.get();
        assertThrows(IllegalArgumentException.class, () -> client.readCsiPodLog("../foreign/log"));
        assertEquals(original, calls.get());
    }

    @Test
    void rejectsAbsentRedirectedMalformedAndOversizedNativeLogs() {
        for (int code : new int[] {404, 302, 403}) {
            status.set(code);
            assertFalse(failure(client.readCsiPodLog("csi-plugin-one").toCompletableFuture()).isRetryable());
        }
        status.set(200);
        response.set(new byte[] {(byte) 0xc3, (byte) 0x28});
        assertEquals(502, failure(client.readCsiPodLog("csi-plugin-one").toCompletableFuture()).getStatusCode());
        response.set(new byte[1024 * 1024 + 1]);
        assertEquals(502, failure(client.readCsiPodLog("csi-plugin-one").toCompletableFuture()).getStatusCode());
    }

    @Test
    void distinguishesAbsenceConflictDenialAndTransientFailuresWithoutServerBody() {
        status.set(404);
        response.set("sensitive-error-body".getBytes(StandardCharsets.UTF_8));
        assertNull(client.get("pods", "runtimes", "pod-one").toCompletableFuture().join());
        for (int code : new int[] {401, 403, 409, 429, 500}) {
            status.set(code);
            var failure = failure(client.create("pods", "runtimes", Map.of("kind", "Pod")).toCompletableFuture());
            assertEquals(code, failure.getStatusCode());
            assertEquals(code == 429 || code == 500, failure.isRetryable());
            assertFalse(failure.toString().contains("sensitive-error-body"));
        }
    }

    @Test
    void refusesRedirectAndOversizedOrMalformedSuccessBodies() {
        status.set(302);
        assertFalse(failure(client.get("pods", "runtimes", "pod-one").toCompletableFuture()).isRetryable());
        assertEquals(1, calls.get());
        status.set(200);
        response.set(new byte[1024 * 1024 + 1]);
        assertEquals(502, failure(client.get("pods", "runtimes", "pod-one").toCompletableFuture()).getStatusCode());
        response.set("not-json".getBytes(StandardCharsets.UTF_8));
        assertEquals(502, failure(client.get("pods", "runtimes", "pod-one").toCompletableFuture()).getStatusCode());
    }

    @Test
    void boundsAResponseThatStallsAfterHeaders() throws Exception {
        stallBody = true;
        var pending = client.get("pods", "runtimes", "pod-one").toCompletableFuture();
        assertTrue(failure(pending).isRetryable());
        assertEquals(1, calls.get());
    }

    @Test
    void rejectsUnsafeNamesResourcesAndTokenFilesBeforeSending() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> client.get("pods", "../other", "pod"));
        assertThrows(IllegalArgumentException.class, () -> client.get("pods", "runtimes", "../pod"));
        assertThrows(IllegalArgumentException.class, () -> client.get("pods", "runtimes", null));
        assertThrows(IllegalArgumentException.class, () -> client.get("nodes", "runtimes", "node"));
        Files.writeString(token, "injected\r\nheader");
        assertTrue(failure(client.get("pods", "runtimes", "pod-one").toCompletableFuture()).isRetryable());
        Files.writeString(token, "x".repeat(16 * 1024 + 1));
        failure(client.get("pods", "runtimes", "pod-one").toCompletableFuture());
        assertEquals(0, calls.get());
    }

    @Test
    void productionConstructionRequiresHttpsAndAnExplicitCa() {
        assertThrows(IllegalArgumentException.class, () -> new KubernetesHttpRuntimeClient(origin, token, token));
        assertThrows(IllegalArgumentException.class,
                () -> new KubernetesHttpRuntimeClient(URI.create("https://kubernetes.default.svc"), token, token));
        assertThrows(IllegalArgumentException.class, () -> new KubernetesHttpRuntimeClient(origin, token,
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS).build(), Duration.ofSeconds(1)));
    }

    private static RuntimeBrokerException failure(CompletableFuture<?> pending) {
        var error = assertThrows(CompletionException.class, pending::join);
        return (RuntimeBrokerException) error.getCause();
    }
}
