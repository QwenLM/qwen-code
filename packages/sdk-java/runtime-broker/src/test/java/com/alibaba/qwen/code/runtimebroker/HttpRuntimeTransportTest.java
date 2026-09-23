package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
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

    @BeforeEach
    void setUp() throws IOException {
        suite = JSON.readTree(ManagedRuntimeAttestationConformanceTest
                .contractDirectory()
                .resolve("managed-runtime-attestation-v2.fixtures.json")
                .toFile());
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            captured.set(exchange.getRequestBody().readAllBytes());
            capturedAuthorization.set(exchange.getRequestHeaders()
                    .getFirst("Authorization"));
            capturedCacheControl.set(exchange.getRequestHeaders()
                    .getFirst("Cache-Control"));
            capturedPath.set(exchange.getRequestURI().getRawPath());
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

    private java.util.concurrent.CompletionStage<RuntimeAttestation> attest() {
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
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()
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
        return transport.attest(lease,
                new RuntimeProvisionRequest(scope, "session-1"), seed);
    }

    private RuntimeBrokerException awaitFailure() {
        ExecutionException thrown = assertThrows(ExecutionException.class,
                () -> attest().toCompletableFuture().get(2,
                        TimeUnit.SECONDS));
        Throwable cause = thrown.getCause();
        if (cause instanceof CompletionException completion
                && completion.getCause() != null) {
            cause = completion.getCause();
        }
        assertTrue(cause instanceof RuntimeBrokerException);
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

    private record Reply(int status, byte[] body, String cacheControl,
            String contentType) {
    }
}
