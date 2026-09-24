package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class HttpRuntimeTransportTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer server;
    private HttpRuntimeTransport transport;
    private JsonNode suite;
    private final AtomicReference<Reply> reply = new AtomicReference<>();
    private final AtomicReference<byte[]> captured = new AtomicReference<>();
    private final AtomicReference<String> capturedAuthorization =
            new AtomicReference<>();
    private final AtomicReference<String> capturedCacheControl =
            new AtomicReference<>();
    private final AtomicReference<String> capturedPath =
            new AtomicReference<>();
    private final AtomicReference<Headers> capturedHeaders =
            new AtomicReference<>();
    private final CountDownLatch requested = new CountDownLatch(1);

    @BeforeEach
    void setUp() throws IOException {
        suite = JSON.readTree(ManagedRuntimeAttestationConformanceTest
                .contractDirectory()
                .resolve("managed-runtime-attestation-v2.fixtures.json")
                .toFile());
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requested.countDown();
            captured.set(exchange.getRequestBody().readAllBytes());
            capturedAuthorization.set(exchange.getRequestHeaders()
                    .getFirst("Authorization"));
            capturedCacheControl.set(exchange.getRequestHeaders()
                    .getFirst("Cache-Control"));
            capturedPath.set(exchange.getRequestURI().getRawPath());
            capturedHeaders.set(exchange.getRequestHeaders());
            Reply planned = reply.get();
            exchange.getResponseHeaders().set("Cache-Control",
                    planned.cacheControl);
            exchange.getResponseHeaders().set("Content-Type",
                    planned.contentType);
            exchange.sendResponseHeaders(planned.status, planned.body.length);
            exchange.getResponseBody().write(planned.body);
            exchange.close();
        });
        server.start();
        transport = new HttpRuntimeTransport();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    @Test
    void forwardsTheManagedRuntimeProtocolWithLeaseFencing()
            throws Exception {
        List<CapturedRequest> requests = new ArrayList<>();
        HttpServer worker = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        worker.createContext("/internal/managed-runtime/", exchange ->
                respond(exchange, requests));
        worker.start();
        try {
            URI endpoint = URI.create("http://127.0.0.1:"
                    + worker.getAddress().getPort());
            RuntimeLease lease = new RuntimeLease("runtime-1", endpoint,
                    "runtime-token", "lease-1", 7);
            RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                    "generation-1", "/workspace", "capability-digest",
                    "workspace");
            RuntimeSession session = new RuntimeSession("harness",
                    "runtime-session", "bootstrap", scope);
            HttpRuntimeTransport workerTransport = new HttpRuntimeTransport();

            assertNull(workerTransport.acquire(lease, session)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            assertEquals("manifest", object(workerTransport.control(lease,
                    session, operation("manifest")).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS)).get("kind"));
            assertEquals("success", workerTransport.execute(lease, session,
                    reference()).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS).get("executionStatus"));
            assertEquals("executing", workerTransport.status(lease, session,
                    reference(), 3).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS).get("state"));
            assertEquals("settled", workerTransport.cancel(lease, session,
                    reference()).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS).get("state"));
            assertTrue(workerTransport.release(lease, session)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            RuntimeProvisionSeed seed = new RuntimeProvisionSeed(
                    "provision-1", "runtime-1", "incarnation-1", "lease-1",
                    7, "runtime-token");
            RuntimeAttestation attestation = workerTransport.attest(lease,
                    new RuntimeProvisionRequest(scope, null,
                            "test-scheduler", "test-cluster",
                            "sha256:template"), seed).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            assertEquals(7, requests.size());
            assertEquals("/internal/managed-runtime/v1/prepare",
                    requests.get(0).path);
            assertEquals("/internal/managed-runtime/v2/manifest",
                    requests.get(1).path);
            assertEquals("/internal/managed-runtime/v2/status",
                    requests.get(3).path);
            assertEquals(3, requests.get(3).body.get("afterSeq"));
            assertEquals("Bearer runtime-token",
                    requests.get(0).authorization);
            assertEquals("lease-1", requests.get(0).leaseId);
            assertEquals("7", requests.get(0).leaseEpoch);
            assertEquals("tenant", requests.get(0).body.get("tenantId"));
            assertEquals("workspace",
                    requests.get(0).body.get("workspaceId"));
            assertEquals("/workspace",
                    requests.get(0).body.get("workspaceCwd"));
            assertEquals("runtime-session",
                    requests.get(0).body.get("sessionId"));
            assertEquals(1, requests.get(0).body.get("protocolVersion"));
            assertEquals(2, requests.get(1).body.get("protocolVersion"));
            assertEquals("runtime-1", attestation.getRuntimeInstanceId());
            assertEquals("incarnation-1",
                    attestation.getRuntimeIncarnation());
            assertEquals(scope, attestation.getScope());
            assertEquals("/internal/managed-runtime/v2/attest",
                    requests.get(6).path);
            assertEquals("generation-1",
                    requests.get(6).body.get("workspaceGeneration"));
            assertEquals("provision-1",
                    requests.get(6).body.get("provisionRequestId"));
        } finally {
            worker.stop(0);
        }
    }

    @Test
    void sendsThePreviewAttestRequestForTheSharedSuccessFixture()
            throws Exception {
        JsonNode success = find("success");
        reply.set(json(200, JSON.writeValueAsBytes(
                success.required("expected").required("body"))));

        RuntimeAttestation proof = attest().toCompletableFuture()
                .get(2, TimeUnit.SECONDS);

        JsonNode identity = suite.required("identity");
        JsonNode sent = JSON.readTree(captured.get());
        assertEquals(HttpRuntimeTransport.PATH, capturedPath.get());
        assertNull(URI.create("http://127.0.0.1" + capturedPath.get())
                .getRawQuery());
        assertEquals("Bearer " + identity.required("token").textValue(),
                capturedAuthorization.get());
        assertEquals("no-store", capturedCacheControl.get());
        assertEquals(success.required("request").required("body"), sent);
        assertEquals(identity.required("runtimeInstanceId").textValue(),
                proof.getRuntimeInstanceId());
        assertEquals(identity.required("runtimeIncarnation").textValue(),
                proof.getRuntimeIncarnation());
        assertEquals(identity.required("workspaceId").textValue(),
                proof.getScope().getWorkspaceId());
    }

    @Test
    void classifiesEverySharedFixtureOutcome() throws Exception {
        for (JsonNode fixture : suite.required("cases")) {
            JsonNode expected = fixture.required("expected");
            int status = expected.required("status").intValue();
            byte[] body = status == 200
                    ? JSON.writeValueAsBytes(expected.required("body"))
                    : errorBody(expected);
            reply.set(json(status, body));
            if (status == 200) {
                attest().toCompletableFuture().get(2, TimeUnit.SECONDS);
                continue;
            }
            RuntimeBrokerException failure = awaitFailure();
            assertEquals(status, failure.getStatusCode(),
                    fixture.required("id").textValue());
            assertEquals(expected.required("classification").textValue(),
                    HttpRuntimeTransport.classificationFor(status),
                    fixture.required("id").textValue());
            if (expected.has("code")) {
                assertEquals(expected.required("code").textValue(),
                        failure.getCode(), fixture.required("id").textValue());
            }
            assertFalse(failure.isRetryable(),
                    fixture.required("id").textValue());
        }
    }

    @Test
    void rejectsAProofThatDoesNotMatchTheSeed() throws IOException {
        ObjectNode body = successBody();
        body.put("workspaceId", "workspace-b");
        reply.set(json(200, JSON.writeValueAsBytes(body)));

        RuntimeBrokerException failure = awaitFailure();

        assertEquals(409, failure.getStatusCode());
        assertEquals("managed_runtime_identity_conflict", failure.getCode());
        assertFalse(failure.isRetryable());
    }

    @Test
    void rejectsAnInvalidIsolationClassAsProtocolFailure() throws IOException {
        ObjectNode body = successBody();
        body.put("isolationClass", "tenant");
        reply.set(json(200, JSON.writeValueAsBytes(body)));

        RuntimeBrokerException failure = awaitFailure();

        assertEquals(400, failure.getStatusCode());
        assertEquals("managed_runtime_attestation_invalid", failure.getCode());
        assertFalse(failure.isRetryable());
    }

    @Test
    void rejectsAnOversizedAttestationResponse() {
        reply.set(json(200, new byte[HttpRuntimeTransport.BODY_LIMIT_BYTES
                + 1]));

        RuntimeBrokerException failure = awaitFailure();

        assertEquals(413, failure.getStatusCode());
        assertEquals("managed_runtime_attestation_too_large",
                failure.getCode());
        assertFalse(failure.isRetryable());
    }

    @Test
    void keepsAnOversizedServerFailureRetryable() {
        reply.set(json(503, new byte[HttpRuntimeTransport.BODY_LIMIT_BYTES
                + 1]));

        RuntimeBrokerException failure = awaitFailure();

        assertEquals(503, failure.getStatusCode());
        assertEquals("managed_runtime_unavailable", failure.getCode());
        assertTrue(failure.isRetryable());
    }

    @Test
    void failsWhenTheResponseBodyStallsPastTheRequestTimeout()
            throws Exception {
        HttpServer stalled = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        stalled.createContext("/", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(200, 64);
            try {
                Thread.sleep(2_000);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                return;
            }
            exchange.getResponseBody().write(new byte[64]);
            exchange.close();
        });
        stalled.start();
        HttpRuntimeTransport impatient = new HttpRuntimeTransport(
                HttpClient.newHttpClient(), Duration.ofMillis(300));
        JsonNode identity = suite.required("identity");
        RuntimeScope scope = new RuntimeScope(
                identity.required("tenantId").textValue(),
                identity.required("workspaceId").textValue(),
                identity.required("workspaceGeneration").textValue(),
                identity.required("workspaceCwd").textValue(),
                identity.required("capabilityDigest").textValue(),
                identity.required("isolationClass").textValue());
        RuntimeLease lease = new RuntimeLease(
                identity.required("runtimeInstanceId").textValue(),
                URI.create("http://127.0.0.1:" + stalled.getAddress().getPort()
                        + "/"),
                identity.required("token").textValue(),
                identity.required("leaseId").textValue(),
                identity.required("epoch").longValue());
        RuntimeProvisionSeed seed = new RuntimeProvisionSeed(
                identity.required("provisionRequestId").textValue(),
                identity.required("runtimeInstanceId").textValue(),
                identity.required("runtimeIncarnation").textValue(),
                identity.required("leaseId").textValue(),
                identity.required("epoch").longValue(),
                identity.required("token").textValue());
        long started = System.nanoTime();
        try {
            ExecutionException thrown = assertThrows(ExecutionException.class,
                    () -> impatient.attest(lease,
                            new RuntimeProvisionRequest(scope, "session-1"),
                            seed).toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            Throwable cause = thrown.getCause();
            assertTrue(cause instanceof RuntimeBrokerException);
            RuntimeBrokerException failure = (RuntimeBrokerException) cause;
            assertEquals(503, failure.getStatusCode());
            assertTrue(failure.isRetryable());
            assertTrue(System.nanoTime() - started < 1_500_000_000L);
            CompletableFuture<RuntimeAttestation> pending =
                    impatient.attest(lease,
                            new RuntimeProvisionRequest(scope, "session-1"),
                            seed).toCompletableFuture();
            assertTrue(pending.cancel(true));
            assertTrue(pending.isCancelled());
        } finally {
            stalled.stop(0);
        }
    }

    @Test
    void closesTheConnectionOnTheDeadlineAndOnCallerCancel() throws Exception {
        for (boolean callerCancels : new boolean[] {false, true}) {
            CountDownLatch closed = new CountDownLatch(1);
            HttpServer drip = HttpServer.create(
                    new InetSocketAddress("127.0.0.1", 0), 0);
            drip.setExecutor(Executors.newCachedThreadPool());
            drip.createContext("/", exchange -> {
                exchange.getRequestBody().readAllBytes();
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.getResponseHeaders().set("Content-Type",
                        "application/json");
                exchange.sendResponseHeaders(200, 1 << 20);
                OutputStream out = exchange.getResponseBody();
                try {
                    for (int tick = 0; tick < 200; tick++) {
                        out.write(' ');
                        out.flush();
                        Thread.sleep(25);
                    }
                } catch (IOException gone) {
                    closed.countDown();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            });
            drip.start();
            try {
                HttpRuntimeTransport client = new HttpRuntimeTransport(
                        HttpClient.newBuilder()
                                .version(HttpClient.Version.HTTP_1_1).build(),
                        Duration.ofMillis(callerCancels ? 10_000 : 300));
                CompletableFuture<RuntimeAttestation> pending =
                        attest(client, drip.getAddress().getPort())
                                .toCompletableFuture();
                if (callerCancels) {
                    Thread.sleep(200);
                    pending.cancel(true);
                }
                assertTrue(closed.await(2, TimeUnit.SECONDS),
                        callerCancels ? "caller cancel" : "deadline");
            } finally {
                drip.stop(0);
            }
        }
    }

    @Test
    void treatsNotFoundAsIncompatible() {
        reply.set(json(404, "{}".getBytes(StandardCharsets.UTF_8)));

        RuntimeBrokerException failure = awaitFailure();

        assertEquals(404, failure.getStatusCode());
        assertEquals("managed_runtime_incompatible", failure.getCode());
        assertFalse(failure.isRetryable());
    }

    @Test
    void keepsServerFailuresRetryable() {
        reply.set(json(503, "{}".getBytes(StandardCharsets.UTF_8)));

        RuntimeBrokerException failure = awaitFailure();

        assertEquals(503, failure.getStatusCode());
        assertEquals("managed_runtime_unavailable", failure.getCode());
        assertTrue(failure.isRetryable());
    }

    @Test
    void sendsEveryFixtureRequestHeader() throws Exception {
        JsonNode success = find("success");
        reply.set(json(200, JSON.writeValueAsBytes(
                success.required("expected").required("body"))));

        attest().toCompletableFuture().get(2, TimeUnit.SECONDS);

        success.required("request").required("headers").properties()
                .forEach(header -> assertEquals(
                        List.of(header.getValue().textValue()),
                        capturedHeaders.get().get(header.getKey()),
                        header.getKey()));
    }

    @Test
    void sendsTheSameFixtureHeadersWhenExecuting() throws Exception {
        reply.set(json(200, JSON.writeValueAsBytes(Map.of(
                "protocolVersion", 2,
                "result", Map.of("executionStatus", "success")))));

        transport.execute(lease(server.getAddress().getPort()),
                new RuntimeSession("harness", "session-1", "bootstrap",
                        scope()), Map.of("callId", "tool"))
                .toCompletableFuture().get(2, TimeUnit.SECONDS);

        assertEquals("/internal/managed-runtime/v2/execute",
                capturedPath.get());
        find("success").required("request").required("headers")
                .properties().forEach(header -> assertEquals(
                        List.of(header.getValue().textValue()),
                        capturedHeaders.get().get(header.getKey()),
                        header.getKey()));
    }

    @Test
    void rejectsAMalformedSuccessResponse() throws IOException {
        byte[] valid = JSON.writeValueAsBytes(successBody());
        ObjectNode unknownField = successBody();
        unknownField.put("debug", true);
        ObjectNode newerProtocol = successBody();
        newerProtocol.put("protocolVersion", 3);
        ObjectNode fractionalEpoch = successBody();
        fractionalEpoch.put("epoch", 4.5);
        ObjectNode fractionalProtocol = successBody();
        fractionalProtocol.put("protocolVersion", 2.5);
        ObjectNode roundedProtocol = successBody();
        roundedProtocol.put("protocolVersion",
                new BigDecimal("1.9999999999999999"));
        Map<String, Reply> replies = new LinkedHashMap<>();
        replies.put("cache", new Reply(200, valid, "private",
                "application/json"));
        replies.put("type", new Reply(200, valid, "no-store", "text/plain"));
        replies.put("charset", new Reply(200, valid, "no-store",
                "application/json; charset=utf-16"));
        replies.put("field", json(200, JSON.writeValueAsBytes(unknownField)));
        replies.put("version",
                json(200, JSON.writeValueAsBytes(newerProtocol)));
        replies.put("fractional version",
                json(200, JSON.writeValueAsBytes(fractionalProtocol)));
        replies.put("rounded version",
                json(200, JSON.writeValueAsBytes(roundedProtocol)));
        replies.put("epoch",
                json(200, JSON.writeValueAsBytes(fractionalEpoch)));
        for (Map.Entry<String, Reply> planned : replies.entrySet()) {
            reply.set(planned.getValue());

            RuntimeBrokerException failure = awaitFailure(planned.getKey());

            assertEquals(400, failure.getStatusCode(), planned.getKey());
            assertEquals("managed_runtime_attestation_invalid",
                    failure.getCode(), planned.getKey());
            assertFalse(failure.isRetryable(), planned.getKey());
        }
    }

    @Test
    void rejectsAProofFromAnotherRuntimeLeaseOrProvision() throws IOException {
        String[][] changes = {
            {"runtimeInstanceId", "runtime-other"},
            {"runtimeIncarnation", "boot-other"},
            {"leaseId", "lease-other"},
            {"provisionRequestId", "provision-other"},
        };
        for (String[] change : changes) {
            ObjectNode body = successBody();
            body.put(change[0], change[1]);
            reply.set(json(200, JSON.writeValueAsBytes(body)));

            RuntimeBrokerException failure = awaitFailure(change[0]);

            assertEquals(409, failure.getStatusCode(), change[0]);
            assertEquals("managed_runtime_identity_conflict",
                    failure.getCode(), change[0]);
            assertFalse(failure.isRetryable(), change[0]);
        }
        long epoch = successBody().required("epoch").longValue();
        for (long otherEpoch : new long[] {epoch + 1, epoch - 1}) {
            ObjectNode body = successBody();
            body.put("epoch", otherEpoch);
            reply.set(json(200, JSON.writeValueAsBytes(body)));
            String label = "epoch " + otherEpoch;

            RuntimeBrokerException failure = awaitFailure(label);

            assertEquals(409, failure.getStatusCode(), label);
            assertEquals("managed_runtime_identity_conflict",
                    failure.getCode(), label);
            assertFalse(failure.isRetryable(), label);
        }
    }

    @Test
    void refusesASeedThatDoesNotBindTheLease() throws InterruptedException {
        JsonNode identity = suite.required("identity");
        String leaseId = identity.required("leaseId").textValue();
        long epoch = identity.required("epoch").longValue();
        String token = identity.required("token").textValue();
        int port = server.getAddress().getPort();

        assertThrows(IllegalArgumentException.class, () -> attest(transport,
                port, leaseId, epoch, "other-token"));
        assertThrows(IllegalArgumentException.class, () -> attest(transport,
                port, "other-lease", epoch, token));
        assertThrows(IllegalArgumentException.class, () -> attest(transport,
                port, leaseId, epoch + 1, token));
        assertThrows(IllegalArgumentException.class, () -> attest(transport,
                port, leaseId, epoch - 1, token));
        assertFalse(requested.await(200, TimeUnit.MILLISECONDS));
    }

    @Test
    void acceptsAResponseOfExactlyTheLimit() throws Exception {
        assertEquals(suite.required("route").required("responseBodyLimitBytes")
                .intValue(), HttpRuntimeTransport.BODY_LIMIT_BYTES);
        byte[] proof = JSON.writeValueAsBytes(successBody());
        byte[] padded = new byte[HttpRuntimeTransport.BODY_LIMIT_BYTES];
        Arrays.fill(padded, (byte) ' ');
        System.arraycopy(proof, 0, padded, 0, proof.length);
        reply.set(json(200, padded));

        attest().toCompletableFuture().get(2, TimeUnit.SECONDS);
    }

    @Test
    void stopsReadingAtTheLimitWithoutWaitingForTheDeclaredBody()
            throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch closed = new CountDownLatch(1);
        HttpServer endless = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        endless.createContext("/", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(200, 1L << 30);
            OutputStream out = exchange.getResponseBody();
            try {
                // Keep the declared body coming: only the client closing
                // its side can end this exchange early.
                while (!release.await(5, TimeUnit.MILLISECONDS)) {
                    out.write(new byte[HttpRuntimeTransport.BODY_LIMIT_BYTES
                            + 1]);
                    out.flush();
                }
            } catch (IOException gone) {
                closed.countDown();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        });
        endless.start();
        try {
            RuntimeBrokerException failure = awaitFailure(transport,
                    endless.getAddress().getPort(), null);

            assertEquals(413, failure.getStatusCode());
            assertEquals("managed_runtime_attestation_too_large",
                    failure.getCode());
            assertTrue(closed.await(2, TimeUnit.SECONDS));
        } finally {
            release.countDown();
            endless.stop(0);
        }
    }

    @Test
    void doesNotFollowRedirects() throws Exception {
        reply.set(json(200, JSON.writeValueAsBytes(successBody())));
        String target = "http://127.0.0.1:" + server.getAddress().getPort()
                + HttpRuntimeTransport.PATH;
        HttpServer moved = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        moved.createContext("/", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Location", target);
            exchange.sendResponseHeaders(307, -1);
            exchange.close();
        });
        moved.start();
        try {
            RuntimeBrokerException failure = awaitFailure(transport,
                    moved.getAddress().getPort(), null);

            assertEquals(502, failure.getStatusCode());
            assertEquals("managed_runtime_incompatible", failure.getCode());
            assertFalse(failure.isRetryable());
            assertNull(captured.get());
        } finally {
            moved.stop(0);
        }
    }

    private CompletionStage<RuntimeAttestation> attest() {
        return attest(transport, server.getAddress().getPort());
    }

    private CompletionStage<RuntimeAttestation> attest(
            HttpRuntimeTransport client, int port) {
        JsonNode identity = suite.required("identity");
        return attest(client, port, identity.required("leaseId").textValue(),
                identity.required("epoch").longValue(),
                identity.required("token").textValue());
    }

    private CompletionStage<RuntimeAttestation> attest(
            HttpRuntimeTransport client, int port, String seedLeaseId,
            long seedEpoch, String seedToken) {
        JsonNode identity = suite.required("identity");
        RuntimeProvisionSeed seed = new RuntimeProvisionSeed(
                identity.required("provisionRequestId").textValue(),
                identity.required("runtimeInstanceId").textValue(),
                identity.required("runtimeIncarnation").textValue(),
                seedLeaseId, seedEpoch, seedToken);
        return client.attest(lease(port),
                new RuntimeProvisionRequest(scope(), "session-1"), seed);
    }

    private RuntimeScope scope() {
        JsonNode identity = suite.required("identity");
        return new RuntimeScope(
                identity.required("tenantId").textValue(),
                identity.required("workspaceId").textValue(),
                identity.required("workspaceGeneration").textValue(),
                identity.required("workspaceCwd").textValue(),
                identity.required("capabilityDigest").textValue(),
                identity.required("isolationClass").textValue());
    }

    private RuntimeLease lease(int port) {
        JsonNode identity = suite.required("identity");
        return new RuntimeLease(
                identity.required("runtimeInstanceId").textValue(),
                URI.create("http://127.0.0.1:" + port + "/"),
                identity.required("token").textValue(),
                identity.required("leaseId").textValue(),
                identity.required("epoch").longValue());
    }

    private RuntimeBrokerException awaitFailure() {
        return awaitFailure(null);
    }

    private RuntimeBrokerException awaitFailure(String label) {
        return awaitFailure(transport, server.getAddress().getPort(), label);
    }

    private RuntimeBrokerException awaitFailure(HttpRuntimeTransport client,
            int port, String label) {
        ExecutionException thrown = assertThrows(ExecutionException.class,
                () -> attest(client, port).toCompletableFuture().get(2,
                        TimeUnit.SECONDS), label);
        Throwable cause = thrown.getCause();
        if (cause instanceof CompletionException completion
                && completion.getCause() != null) {
            cause = completion.getCause();
        }
        assertTrue(cause instanceof RuntimeBrokerException, label);
        return (RuntimeBrokerException) cause;
    }

    private ObjectNode successBody() {
        return (ObjectNode) find("success").required("expected")
                .required("body").deepCopy();
    }

    private JsonNode find(String id) {
        for (JsonNode fixture : suite.required("cases")) {
            if (id.equals(fixture.required("id").textValue())) {
                return fixture;
            }
        }
        throw new AssertionError("missing fixture: " + id);
    }

    private static byte[] errorBody(JsonNode expected) throws IOException {
        ObjectNode body = JSON.createObjectNode();
        if (expected.has("code")) {
            body.put("code", expected.required("code").textValue());
        }
        return JSON.writeValueAsBytes(body);
    }

    private static Reply json(int status, byte[] body) {
        return new Reply(status, body, "no-store", "application/json");
    }

    private static void respond(HttpExchange exchange,
            List<CapturedRequest> requests) throws IOException {
        Map<String, Object> body = JsonCodec.parseObject(
                exchange.getRequestBody().readAllBytes(), "request");
        String path = exchange.getRequestURI().getPath();
        requests.add(new CapturedRequest(path,
                exchange.getRequestHeaders().getFirst("Authorization"),
                exchange.getRequestHeaders().getFirst(
                        "X-Qwen-Managed-Lease-Id"),
                exchange.getRequestHeaders().getFirst(
                        "X-Qwen-Managed-Lease-Epoch"), body));
        Map<String, Object> response = new LinkedHashMap<>();
        if (path.endsWith("/attest")) {
            response.put("protocolVersion", 2);
            response.put("runtimeInstanceId", "runtime-1");
            response.put("runtimeIncarnation", "incarnation-1");
            response.put("leaseId", "lease-1");
            response.put("epoch", 7);
            response.put("tenantId", body.get("tenantId"));
            response.put("workspaceId", body.get("workspaceId"));
            response.put("workspaceGeneration",
                    body.get("workspaceGeneration"));
            response.put("workspaceCwd", body.get("workspaceCwd"));
            response.put("capabilityDigest",
                    body.get("capabilityDigest"));
            response.put("isolationClass", body.get("isolationClass"));
            response.put("provisionRequestId",
                    body.get("provisionRequestId"));
        } else if (path.endsWith("/prepare")) {
            response.put("protocolVersion", 1);
            response.put("ready", true);
        } else if (path.endsWith("/release")) {
            response.put("protocolVersion", 2);
            response.put("released", true);
        } else {
            response.put("protocolVersion", 2);
            if (path.endsWith("/execute")) {
                response.put("result", executionResult("success"));
            } else if (path.endsWith("/status")) {
                response.put("result", executingStatus());
            } else if (path.endsWith("/cancel")) {
                response.put("result", cancelledStatus());
            } else {
                response.put("result", operation("manifest"));
            }
        }
        byte[] bytes = JsonCodec.encode(response);
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static Map<String, Object> operation(String kind) {
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("kind", kind);
        return operation;
    }

    private static Map<String, Object> reference() {
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("sessionId", "runtime-session");
        reference.put("promptId", "turn-1");
        reference.put("callId", "tool-1");
        reference.put("capabilityDigest", "capability-digest");
        reference.put("policyRevision", "policy-1");
        reference.put("invocationId", "invocation-1");
        reference.put("argsDigest", "args-1");
        return reference;
    }

    private static Map<String, Object> executionResult(String state) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("executionStatus", state);
        return result;
    }

    private static Map<String, Object> cancelledStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", "settled");
        status.put("cancelRequested", true);
        status.put("lastSeq", 0);
        status.put("firstAvailableSeq", 1);
        status.put("progressGap", false);
        status.put("progress", List.of());
        status.put("result", executionResult("cancelled"));
        return status;
    }

    private static Map<String, Object> executingStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", "executing");
        status.put("cancelRequested", false);
        status.put("lastSeq", 3);
        status.put("firstAvailableSeq", 1);
        status.put("progressGap", false);
        status.put("progress", List.of());
        return status;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        return (Map<String, Object>) value;
    }

    private record Reply(int status, byte[] body, String cacheControl,
            String contentType) {
    }

    private static final class CapturedRequest {
        private final String path;
        private final String authorization;
        private final String leaseId;
        private final String leaseEpoch;
        private final Map<String, Object> body;

        CapturedRequest(String path, String authorization, String leaseId,
                String leaseEpoch, Map<String, Object> body) {
            this.path = path;
            this.authorization = authorization;
            this.leaseId = leaseId;
            this.leaseEpoch = leaseEpoch;
            this.body = body;
        }
    }
}
