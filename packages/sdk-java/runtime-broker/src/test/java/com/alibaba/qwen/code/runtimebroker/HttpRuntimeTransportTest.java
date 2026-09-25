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
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
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
    private JsonNode toolSuite;
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
        toolSuite = JSON.readTree(ManagedRuntimeAttestationConformanceTest
                .contractDirectory()
                .resolve("managed-runtime-tool-v2.fixtures.json")
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
    void sendsTheExecuteRequestForTheSharedFixture() throws Exception {
        JsonNode executeSuite = toolSuite("execute");
        JsonNode success = findIn(executeSuite, "success");
        reply.set(json(200, JSON.writeValueAsBytes(
                success.required("expected").required("body"))));

        Map<String, Object> result = transport
                .execute(toolLease(server.getAddress().getPort()),
                        toolSession(), toolReference())
                .toCompletableFuture().get(2, TimeUnit.SECONDS);

        assertEquals(HttpRuntimeTransport.EXECUTE_PATH,
                capturedPath.get());
        assertEquals("Bearer fixture-token", capturedAuthorization.get());
        assertEquals("no-store", capturedCacheControl.get());
        JsonNode sent = JSON.readTree(captured.get());
        assertEquals(executeSuite.required("canonicalRequest")
                .required("body"), sent);
        assertEquals("success",
                JSON.valueToTree(result).required("executionStatus")
                        .textValue());
    }

    @Test
    void statusAnswersUnknownFromTheSharedFixture() throws Exception {
        JsonNode statusSuite = toolSuite("status");
        JsonNode unknown = findIn(statusSuite, "unknown-is-ok");
        reply.set(json(200, JSON.writeValueAsBytes(
                unknown.required("expected").required("body"))));

        Map<String, Object> answer = transport
                .status(toolLease(server.getAddress().getPort()),
                        toolSession(), toolReference(), 0)
                .toCompletableFuture().get(2, TimeUnit.SECONDS);

        assertEquals(HttpRuntimeTransport.STATUS_PATH, capturedPath.get());
        JsonNode sent = JSON.readTree(captured.get());
        assertEquals(statusSuite.required("canonicalRequest")
                .required("body"), sent);
        assertEquals("unknown", answer.get("state"));
        assertNull(answer.get("result"));
    }

    @Test
    void cancelSettlesAPreparedExecutionFromTheSharedFixture()
            throws Exception {
        JsonNode cancelSuite = toolSuite("cancel");
        JsonNode settled = findIn(cancelSuite, "prepared-settles-cancelled");
        reply.set(json(200, JSON.writeValueAsBytes(
                settled.required("expected").required("body"))));

        Map<String, Object> answer = transport
                .cancel(toolLease(server.getAddress().getPort()),
                        toolSession(), toolReference())
                .toCompletableFuture().get(2, TimeUnit.SECONDS);

        assertEquals(HttpRuntimeTransport.CANCEL_PATH, capturedPath.get());
        assertEquals("settled", answer.get("state"));
        @SuppressWarnings("unchecked")
        Map<String, Object> result =
                (Map<String, Object>) answer.get("result");
        assertEquals("cancelled", result.get("executionStatus"));
    }

    @Test
    void executeRejectsAnUnsettledResponse() throws IOException {
        ObjectNode body = JSON.createObjectNode();
        body.put("protocolVersion", 2);
        body.put("state", "executing");
        reply.set(json(200, JSON.writeValueAsBytes(body)));

        RuntimeBrokerException failure = awaitToolFailure("execute");

        assertEquals(400, failure.getStatusCode());
        assertEquals("managed_runtime_attestation_invalid",
                failure.getCode());
    }

    @Test
    void rejectsASettledResponseWithoutAResult() throws IOException {
        ObjectNode body = JSON.createObjectNode();
        body.put("protocolVersion", 2);
        body.put("state", "settled");
        reply.set(json(200, JSON.writeValueAsBytes(body)));

        RuntimeBrokerException failure = awaitToolFailure("status");

        assertEquals(400, failure.getStatusCode());
        assertEquals("managed_runtime_attestation_invalid",
                failure.getCode());
    }

    @Test
    void rejectsAnUnknownResponseThatCarriesAResult() throws IOException {
        ObjectNode result = JSON.createObjectNode();
        result.put("executionStatus", "success");
        result.putArray("responseParts");
        ObjectNode body = JSON.createObjectNode();
        body.put("protocolVersion", 2);
        body.put("state", "unknown");
        body.set("result", result);
        reply.set(json(200, JSON.writeValueAsBytes(body)));

        RuntimeBrokerException failure = awaitToolFailure("status");

        assertEquals(400, failure.getStatusCode());
        assertEquals("managed_runtime_attestation_invalid",
                failure.getCode());
    }

    @Test
    void rejectsAnUnknownToolState() throws IOException {
        ObjectNode body = JSON.createObjectNode();
        body.put("protocolVersion", 2);
        body.put("state", "running");
        reply.set(json(200, JSON.writeValueAsBytes(body)));

        RuntimeBrokerException failure = awaitToolFailure("cancel");

        assertEquals(400, failure.getStatusCode());
        assertEquals("managed_runtime_attestation_invalid",
                failure.getCode());
    }

    @Test
    void rejectsOversizedToolInputBeforeSending() {
        Map<String, Object> reference = toolReference();
        reference.put("input", Map.of("content",
                "x".repeat(HttpRuntimeTransport.TOOL_REQUEST_LIMIT_BYTES)));

        assertThrows(IllegalArgumentException.class,
                () -> transport.execute(
                        toolLease(server.getAddress().getPort()),
                        toolSession(), reference));
        assertNull(captured.get());
    }

    @Test
    void classifiesToolRouteFailures() {
        for (int status : new int[] {401, 409, 404, 413, 503}) {
            reply.set(json(status, "{}".getBytes(StandardCharsets.UTF_8)));

            RuntimeBrokerException failure = awaitToolFailure("status");

            assertEquals(status, failure.getStatusCode());
            assertEquals(fixtureClassification(status),
                    HttpRuntimeTransport.classificationFor(status));
            assertEquals(status == 503, failure.isRetryable());
        }
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
        reply.set(json(200, JSON.writeValueAsBytes(
                findIn(toolSuite("execute"), "success").required("expected")
                        .required("body"))));

        transport.execute(lease(server.getAddress().getPort()),
                toolSession(), toolReference())
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
    void rejectsAReferenceWithUndeclaredKeys() {
        Map<String, Object> reference = toolReference();
        reference.put("tenantId", "tenant-b");
        RuntimeLease lease = toolLease(server.getAddress().getPort());

        assertThrows(IllegalArgumentException.class,
                () -> transport.execute(lease, toolSession(), reference));
        assertThrows(IllegalArgumentException.class,
                () -> transport.status(lease, toolSession(), reference, 0));
        assertThrows(IllegalArgumentException.class,
                () -> transport.cancel(lease, toolSession(), reference));
        assertNull(captured.get());
    }

    @Test
    void rejectsAToolResponseWithoutNoStoreJson() throws IOException {
        byte[] body = JSON.writeValueAsBytes(findIn(toolSuite("status"),
                "unknown-is-ok").required("expected").required("body"));
        for (Reply invalid : List.of(
                new Reply(200, body, "", "application/json"),
                new Reply(200, body, "max-age=60", "application/json"),
                new Reply(200, body, "no-store", ""),
                new Reply(200, body, "no-store", "text/html"),
                new Reply(200, body, "no-store",
                        "application/json; charset=utf-16"))) {
            reply.set(invalid);
            for (String operation : List.of("status", "cancel")) {
                assertEquals(400, awaitToolFailure(operation).getStatusCode());
            }
        }
    }

    @Test
    void rejectsAResultOutsideTheClosedShape() throws IOException {
        for (String result : new String[] {
                "{\"executionStatus\":\"success\",\"responseParts\":[],"
                        + "\"debug\":1}",
                "{\"executionStatus\":\"error\",\"responseParts\":[],"
                        + "\"error\":{\"message\":\"\"}}",
                "{\"executionStatus\":\"error\",\"responseParts\":[],"
                        + "\"error\":{\"message\":\"x\",\"stack\":\"y\"}}"}) {
            reply.set(json(200, ("{\"protocolVersion\":2,\"state\":"
                    + "\"settled\",\"result\":" + result + "}")
                    .getBytes(StandardCharsets.UTF_8)));

            assertEquals(400, awaitToolFailure("execute").getStatusCode());
        }
    }

    @Test
    void rejectsMalformedToolResponses() {
        String result = "{\"executionStatus\":\"success\","
                + "\"responseParts\":[]}";
        for (String body : new String[] {
                "{\"protocolVersion\":2,\"state\":\"unknown\",\"x\":1}",
                "{\"protocolVersion\":1,\"state\":\"unknown\"}",
                "{\"protocolVersion\":2,\"state\":\"unknown\","
                        + "\"lastSequence\":-1}",
                "{\"protocolVersion\":2,\"state\":\"unknown\","
                        + "\"lastSequence\":1.5}",
                "{\"protocolVersion\":2,\"state\":\"settled\",\"result\":"
                        + result.replace("success", "done") + "}",
                "{\"protocolVersion\":2,\"state\":\"settled\",\"result\":"
                        + result.replace("[]", "\"x\"") + "}",
                "{\"protocolVersion\":2,\"state\":\"settled\",\"result\":"
                        + "{\"executionStatus\":\"error\",\"responseParts\":[],"
                        + "\"error\":{\"message\":5}}}",
                "{\"protocolVersion\":2,\"state\":\"settled\",\"result\":"
                        + "{\"executionStatus\":\"error\",\"responseParts\":[],"
                        + "\"error\":{\"message\":\"x\",\"type\":5}}}"}) {
            reply.set(json(200, body.getBytes(StandardCharsets.UTF_8)));

            assertEquals(400, awaitToolFailure("status").getStatusCode(),
                    body);
        }
    }

    @Test
    void acceptsAToolResponseAboveTheAttestationBound() throws Exception {
        String text = "x".repeat(64 * 1024);
        reply.set(json(200, ("{\"protocolVersion\":2,\"state\":\"settled\","
                + "\"result\":{\"executionStatus\":\"success\","
                + "\"responseParts\":[{\"text\":\"" + text + "\"}]}}")
                .getBytes(StandardCharsets.UTF_8)));

        Map<String, Object> answer = transport
                .status(toolLease(server.getAddress().getPort()),
                        toolSession(), toolReference(), 0)
                .toCompletableFuture().get(2, TimeUnit.SECONDS);

        assertEquals("settled", answer.get("state"));
    }

    @Test
    void rejectsAnEmptyIdentityOrANonObjectInput() {
        Map<String, Object> empty = toolReference();
        empty.put("callId", "");
        Map<String, Object> listInput = toolReference();
        listInput.put("input", List.of("a"));
        for (Map<String, Object> reference : List.of(empty,
                listInput)) {
            assertThrows(IllegalArgumentException.class,
                    () -> transport.execute(
                            toolLease(server.getAddress().getPort()),
                            toolSession(), reference));
        }
        assertNull(captured.get());
    }

    @Test
    void acceptsLastSequenceOnlyOnStatus() throws Exception {
        ObjectNode body = (ObjectNode) findIn(toolSuite("execute"), "success")
                .required("expected").required("body").deepCopy();
        body.put("lastSequence", 0);
        reply.set(json(200, JSON.writeValueAsBytes(body)));

        assertEquals(400, awaitToolFailure("execute").getStatusCode());
        assertEquals(400, awaitToolFailure("cancel").getStatusCode());
        Map<String, Object> status = transport.status(
                toolLease(server.getAddress().getPort()), toolSession(),
                toolReference(), 0).toCompletableFuture()
                .get(2, TimeUnit.SECONDS);
        assertEquals(0, ((Number) status.get("lastSequence")).longValue());
    }

    @Test
    void validatesSequenceNumbersWithoutRoundingOrLongTruncation()
            throws Exception {
        for (String invalid : List.of("1.000000000000000001", "-1e-999")) {
            reply.set(json(200, ("{\"protocolVersion\":2,\"state\":\"unknown\","
                    + "\"lastSequence\":" + invalid + "}")
                    .getBytes(StandardCharsets.UTF_8)));
            assertEquals(400, awaitToolFailure("status").getStatusCode(),
                    invalid);
        }
        for (String valid : List.of("0", "1.0", "9007199254740993",
                "9223372036854775808", "18446744073709551616")) {
            reply.set(json(200, ("{\"protocolVersion\":2,\"state\":\"unknown\","
                    + "\"lastSequence\":" + valid + "}")
                    .getBytes(StandardCharsets.UTF_8)));
            Map<String, Object> answer = transport.status(
                    toolLease(server.getAddress().getPort()), toolSession(),
                    toolReference(), 0).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            assertEquals(0, new BigDecimal(valid).compareTo(new BigDecimal(
                    answer.get("lastSequence").toString())), valid);
        }
        reply.set(json(200, ("{\"protocolVersion\":2.000000000000000001,"
                + "\"state\":\"unknown\"}").getBytes(StandardCharsets.UTF_8)));
        assertEquals(400, awaitToolFailure("status").getStatusCode());
    }

    @Test
    void rejectsExplicitNullAndEmptyOptionalResponseFields() throws Exception {
        ObjectNode settled = (ObjectNode) findIn(toolSuite("execute"), "success")
                .required("expected").required("body").deepCopy();
        ObjectNode nullResult = JSON.createObjectNode();
        nullResult.put("protocolVersion", 2);
        nullResult.put("state", "unknown");
        nullResult.putNull("result");
        ObjectNode nullSequence = settled.deepCopy();
        nullSequence.putNull("lastSequence");
        ObjectNode nullError = settled.deepCopy();
        ((ObjectNode) nullError.required("result")).putNull("error");
        ObjectNode nullType = settled.deepCopy();
        ObjectNode error = ((ObjectNode) nullType.required("result"))
                .putObject("error");
        error.put("message", "failure");
        error.putNull("type");
        ObjectNode emptyType = nullType.deepCopy();
        ((ObjectNode) emptyType.required("result").required("error"))
                .put("type", "");
        for (JsonNode invalid : List.of(nullResult, nullSequence, nullError,
                nullType, emptyType)) {
            reply.set(json(200, JSON.writeValueAsBytes(invalid)));
            assertEquals(400, awaitToolFailure("status").getStatusCode(),
                    invalid.toString());
        }
    }

    @Test
    void enforcesTheSmallerLookupAndCancelRequestLimit() throws Exception {
        Map<String, Object> reference = toolReference();
        reference.put("callId", "x".repeat(16 * 1024));
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        assertEquals(16 * 1024, toolRoute("status")
                .required("requestBodyLimitBytes").intValue());
        assertEquals(16 * 1024, toolRoute("cancel")
                .required("requestBodyLimitBytes").intValue());

        assertThrows(IllegalArgumentException.class,
                () -> transport.status(lease, toolSession(), reference, 0));
        assertThrows(IllegalArgumentException.class,
                () -> transport.cancel(lease, toolSession(), reference));
        assertNull(captured.get());

        reply.set(json(200, JSON.writeValueAsBytes(findIn(toolSuite("execute"),
                "success").required("expected").required("body"))));
        transport.execute(lease, toolSession(), reference)
                .toCompletableFuture().get(2, TimeUnit.SECONDS);
        assertTrue(captured.get().length > 16 * 1024);
    }

    @Test
    void boundsToolResponsesAtOneMiB() throws Exception {
        byte[] valid = JSON.writeValueAsBytes(findIn(toolSuite("execute"),
                "success").required("expected").required("body"));
        int limit = 1024 * 1024;
        byte[] padded = new byte[limit];
        Arrays.fill(padded, (byte) ' ');
        System.arraycopy(valid, 0, padded, 0, valid.length);
        reply.set(json(200, padded));
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> reference = toolReference();

        transport.execute(lease, session, reference)
                .toCompletableFuture().get(5, TimeUnit.SECONDS);
        transport.status(lease, session, reference, 0)
                .toCompletableFuture().get(5, TimeUnit.SECONDS);
        transport.cancel(lease, session, reference)
                .toCompletableFuture().get(5, TimeUnit.SECONDS);

        reply.set(json(200, Arrays.copyOf(padded, limit + 1)));
        for (String operation : List.of("execute", "status", "cancel")) {
            assertEquals(limit, toolRoute(operation)
                    .required("responseBodyLimitBytes").intValue());
            RuntimeBrokerException failure = awaitToolFailure(operation);
            assertEquals(413, failure.getStatusCode());
            assertEquals("managed_runtime_attestation_too_large",
                    failure.getCode());
            assertEquals("Managed Runtime " + operation
                    + " response exceeds 1 MiB.", failure.getMessage());
            assertFalse(failure.isRetryable());
        }
    }

    @Test
    void retainsTheSharedToolErrorCodes() throws Exception {
        for (String operation : List.of("execute", "status", "cancel")) {
            for (JsonNode fixture : toolSuite(operation).required("cases")) {
                JsonNode expected = fixture.required("expected");
                int status = expected.required("status").intValue();
                if (status == 200) {
                    continue;
                }
                reply.set(json(status, errorBody(expected)));

                RuntimeBrokerException failure = awaitToolFailure(operation);
                assertEquals(status, failure.getStatusCode());
                assertEquals(expected.path("code").asText(
                        "managed_runtime_incompatible"), failure.getCode());
                assertTrue(failure.getMessage().contains(operation));
                assertFalse(failure.getMessage().contains("attestation"));
            }
        }
    }

    @Test
    void statusRejectsANegativeSequence() {
        assertThrows(IllegalArgumentException.class,
                () -> transport.status(
                        toolLease(server.getAddress().getPort()),
                        toolSession(), toolReference(), -1));
        assertNull(captured.get());
    }

    private static String fixtureClassification(int status) {
        return switch (status) {
            case 401, 403 -> "credentials";
            case 400, 413 -> "protocol";
            case 409 -> "identity";
            default -> "incompatible";
        };
    }

    private JsonNode toolRoute(String route) {
        for (JsonNode candidate : toolSuite.required("routes")) {
            if (route.equals(candidate.required("key").textValue())) {
                return candidate;
            }
        }
        throw new AssertionError("missing tool route: " + route);
    }

    private JsonNode toolSuite(String route) {
        for (JsonNode candidate : toolSuite.required("suites")) {
            if (route.equals(candidate.required("route").textValue())) {
                return candidate;
            }
        }
        throw new AssertionError("missing tool suite: " + route);
    }

    private static JsonNode findIn(JsonNode suite, String id) {
        for (JsonNode fixture : suite.required("cases")) {
            if (id.equals(fixture.required("id").textValue())) {
                return fixture;
            }
        }
        throw new AssertionError("missing fixture: " + id);
    }

    private RuntimeBrokerException awaitToolFailure(String operation) {
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> reference = toolReference();
        ExecutionException thrown = assertThrows(ExecutionException.class,
                () -> {
                    switch (operation) {
                        case "execute" -> transport.execute(lease, session,
                                reference).toCompletableFuture().get(2,
                                        TimeUnit.SECONDS);
                        case "status" -> transport.status(lease, session,
                                reference, 0).toCompletableFuture().get(2,
                                        TimeUnit.SECONDS);
                        case "cancel" -> transport.cancel(lease, session,
                                reference).toCompletableFuture().get(2,
                                        TimeUnit.SECONDS);
                        default -> throw new AssertionError(
                                "unknown operation");
                    }
                });
        Throwable cause = thrown.getCause();
        if (cause instanceof CompletionException completion
                && completion.getCause() != null) {
            cause = completion.getCause();
        }
        assertTrue(cause instanceof RuntimeBrokerException);
        return (RuntimeBrokerException) cause;
    }

    private RuntimeLease toolLease(int port) {
        JsonNode identity = toolSuite.required("identity");
        return new RuntimeLease("runtime-01",
                URI.create("http://127.0.0.1:" + port + "/"),
                identity.required("token").textValue(),
                identity.required("leaseId").textValue(),
                identity.required("epoch").longValue());
    }

    private static RuntimeSession toolSession() {
        return new RuntimeSession("harness-01", "runtime-session-01",
                "bootstrap", new RuntimeScope("tenant-a", "workspace-a",
                        "7", "/runtime/workspace",
                        "sha256:" + "a".repeat(64), "session"));
    }

    private static Map<String, Object> toolReference() {
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("sessionId", "runtime-session-01");
        reference.put("promptId", "prompt-01");
        reference.put("callId", "call-01");
        reference.put("argsDigest", "sha256:0123456789abcdef0123456789abcdef"
                + "0123456789abcdef0123456789abcdef");
        reference.put("toolName", "read_file");
        reference.put("input", Map.of("path", "/workspace/README.md"));
        return reference;
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

    private record Reply(int status, byte[] body, String cacheControl,
            String contentType) {
    }
}
