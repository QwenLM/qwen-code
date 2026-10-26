package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    private final AtomicReference<String> accept = new AtomicReference<>();
    private final AtomicReference<byte[]> response = new AtomicReference<>("{\"kind\":\"Pod\"}".getBytes(StandardCharsets.UTF_8));
    private final AtomicInteger status = new AtomicInteger(200);
    private final AtomicInteger calls = new AtomicInteger();
    private final CountDownLatch releaseBody = new CountDownLatch(1);
    private volatile boolean stallBody;
    private volatile boolean stallHeaders;
    private volatile boolean dropResponse;
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
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            accept.set(exchange.getRequestHeaders().getFirst("Accept"));
            if (dropResponse) {
                exchange.close();
                return;
            }
            exchange.getResponseHeaders().set("Location", origin.resolve("/redirected").toString());
            try {
                if (stallHeaders) {
                    releaseBody.await(3, TimeUnit.SECONDS);
                }
                exchange.sendResponseHeaders(status.get(), response.get().length);
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
        status.set(404);
        assertNull(client.getCluster("persistentvolumes", "absent").toCompletableFuture().join());
        int original = calls.get();
        for (String name : new String[] {"../pv", ".", "pv..name", "pv?name", "pv/name", "x".repeat(254)}) {
            assertThrows(IllegalArgumentException.class, () -> client.getCluster("persistentvolumes", name));
        }
        assertThrows(IllegalArgumentException.class, () -> client.getCluster("namespaces", "namespace.with.dots"));
        assertThrows(IllegalArgumentException.class, () -> client.getCluster("clusterroles", "admin"));
        assertThrows(IllegalArgumentException.class,
                () -> client.create("persistentvolumeclaims", "runtimes", Map.of("kind", "PersistentVolumeClaim")));
        assertThrows(IllegalArgumentException.class,
                () -> client.create("validatingadmissionpolicies", "runtimes", Map.of("kind", "ValidatingAdmissionPolicy")));
        assertEquals(original, calls.get());
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

    @Test
    void deletesOnlyTheNamedPodWithExactOptionsAndRotatingCredentials() throws Exception {
        byte[] options = ("{ \"apiVersion\": \"v1\", \"kind\": \"DeleteOptions\","
                + "\"gracePeriodSeconds\":30,\"propagationPolicy\":\"Background\","
                + "\"preconditions\":{\"uid\":\"original-uid\",\"resourceVersion\":\"192\"}}\n")
                .getBytes(StandardCharsets.UTF_8);
        client.deletePod("runtimes", "resident.one", options).toCompletableFuture().join();
        assertEquals("DELETE", method.get());
        assertEquals("/api/v1/namespaces/runtimes/pods/resident.one", path.get());
        assertArrayEquals(options, requestBody.get().getBytes(StandardCharsets.UTF_8));
        assertEquals("application/json", contentType.get());
        assertEquals("application/json", accept.get());
        assertEquals("Bearer token-one", authorization.get());
        Files.writeString(token, "delete-token-two\n");
        client.deletePod("runtimes", "resident.one", options).toCompletableFuture().join();
        assertEquals("Bearer delete-token-two", authorization.get());
        assertEquals(2, calls.get());
    }

    @ParameterizedTest
    @ValueSource(ints = {200, 202, 302, 307, 308, 400, 401, 403, 404, 409, 429, 500, 503})
    void retainsActualDeleteStatusAndUnparsedBytesWithoutRetryOrRedirect(int code) {
        status.set(code);
        byte[] body = new byte[] {0, (byte) 0xff, 1};
        response.set(body);
        var result = client.deletePod("runtimes", "resident-one", new byte[] {'{', '}'})
                .toCompletableFuture().join();
        assertEquals(code, result.status());
        assertArrayEquals(body, result.body());
        assertTrue(result.complete());
        assertEquals(1, calls.get());
        assertEquals("/api/v1/namespaces/runtimes/pods/resident-one", path.get());
    }

    @ParameterizedTest
    @ValueSource(ints = {65535, 65536, 65537})
    void boundsDeleteReplyBytesAndIdentifiesTruncation(int size) {
        byte[] body = new byte[size];
        Arrays.fill(body, (byte) 'x');
        response.set(body);
        status.set(409);
        var result = client.deletePod("runtimes", "resident-one", new byte[] {'{', '}'})
                .toCompletableFuture().join();
        assertEquals(409, result.status());
        assertArrayEquals(Arrays.copyOf(body, Math.min(size, 64 * 1024)), result.body());
        assertEquals(size <= 64 * 1024, result.complete());
        assertEquals(1, calls.get());
    }

    @Test
    void rejectsUnsafeDeleteNamesAndUnboundedOptionsBeforeSending() {
        byte[] options = new byte[] {'{', '}'};
        assertThrows(IllegalArgumentException.class, () -> client.deletePod("../runtimes", "resident", options));
        assertThrows(IllegalArgumentException.class, () -> client.deletePod("runtime.one", "resident", options));
        for (String name : new String[] {"../pod", "pod?name", "pod/name", "pod..name", "x".repeat(254)}) {
            assertThrows(IllegalArgumentException.class, () -> client.deletePod("runtimes", name, options));
        }
        assertThrows(IllegalArgumentException.class, () -> client.deletePod("runtimes", null, options));
        assertThrows(IllegalArgumentException.class, () -> client.deletePod("runtimes", "resident", null));
        assertThrows(IllegalArgumentException.class, () -> client.deletePod("runtimes", "resident", new byte[0]));
        assertThrows(IllegalArgumentException.class,
                () -> client.deletePod("runtimes", "resident", new byte[16 * 1024 + 1]));
        assertEquals(0, calls.get());
        byte[] maximumOptions = ("{}" + " ".repeat(16 * 1024 - 2)).getBytes(StandardCharsets.UTF_8);
        client.deletePod("runtimes", "resident", maximumOptions).toCompletableFuture().join();
        assertArrayEquals(maximumOptions, requestBody.get().getBytes(StandardCharsets.UTF_8));
        assertEquals(1, calls.get());
    }

    @Test
    void failsDeleteWithoutInventingHttpResponseAfterLostReply() {
        dropResponse = true;
        var pending = client.deletePod("runtimes", "resident-one", new byte[] {'{', '}'}).toCompletableFuture();
        assertInstanceOf(IOException.class, assertThrows(CompletionException.class, pending::join).getCause());
        assertEquals(1, calls.get());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void boundsDeleteThatStallsBeforeOrAfterResponseHeaders(boolean beforeHeaders) throws Exception {
        stallHeaders = beforeHeaders;
        stallBody = !beforeHeaders;
        var pending = client.deletePod("runtimes", "resident-one", new byte[] {'{', '}'}).toCompletableFuture();
        var failure = assertThrows(java.util.concurrent.ExecutionException.class,
                () -> pending.get(2, TimeUnit.SECONDS));
        assertTrue(failure.getCause() instanceof HttpTimeoutException || failure.getCause() instanceof TimeoutException);
        assertEquals(1, calls.get());
    }

    @Test
    void failsDeleteBeforeSendingWhenTheTokenIsMissingOrMalformed() throws Exception {
        for (String value : new String[] {"injected\r\nheader", "x".repeat(16 * 1024 + 1)}) {
            Files.writeString(token, value);
            var pending = client.deletePod("runtimes", "resident-one", new byte[] {'{', '}'}).toCompletableFuture();
            assertInstanceOf(IOException.class, assertThrows(CompletionException.class, pending::join).getCause());
        }
        Files.delete(token);
        var pending = client.deletePod("runtimes", "resident-one", new byte[] {'{', '}'}).toCompletableFuture();
        assertInstanceOf(IOException.class, assertThrows(CompletionException.class, pending::join).getCause());
        assertEquals(0, calls.get());
    }

    private static RuntimeBrokerException failure(CompletableFuture<?> pending) {
        var error = assertThrows(CompletionException.class, pending::join);
        return (RuntimeBrokerException) error.getCause();
    }
}
