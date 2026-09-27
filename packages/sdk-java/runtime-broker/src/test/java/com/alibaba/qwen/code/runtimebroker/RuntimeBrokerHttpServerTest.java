package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.fastjson2.JSON;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class RuntimeBrokerHttpServerTest {
    @Test
    void unsupportedOperationsNeverDispatchOrClaimResolution() throws Exception {
        try (Fixture fixture = new Fixture()) {
            assertEquals(200, fixture.post("/tool-sessions:acquire", Map.of(
                    "protocolVersion", 1, "requestId", "acquire",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime",
                    "turnKind", "bootstrap")).statusCode());
            for (String path : new String[] {"/executions/call:resolve"}) {
                HttpResponse<String> response = fixture.post(path, Map.of(
                        "protocolVersion", 1, "requestId", "request",
                        "idempotencyKey", "key", "harnessSessionId", "harness",
                        "runtimeSessionId", "runtime", "turnId", "turn",
                        "toolCallId", "call", "requestDigest", "digest",
                        "reference", reference(), "resolution", "accepted_unknown"));
                assertEquals(501, response.statusCode(), response.body());
                assertTrue(response.body().contains("runtime_broker_operation_unsupported"));
            }
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void providerPreparationIsDurableAndVoidControlsKeepTheirNullResult() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String runtime = "550e8400-e29b-41d4-a716-446655440302";
            fixture.service.acquire("harness", runtime, "bootstrap").toCompletableFuture().join();
            Map<String, Object> identity = Map.of("sessionId", runtime, "promptId", "turn",
                    "callId", "call", "capabilityDigest", "a".repeat(64), "policyRevision", "policy");
            Map<String, Object> reference = new java.util.LinkedHashMap<>(identity);
            reference.put("invocationId", "invocation");
            reference.put("argsDigest", "b".repeat(64));
            HttpResponse<String> control = fixture.post("/tool-sessions/" + runtime + "/control", Map.of(
                    "protocolVersion", 1, "requestId", "begin", "harnessSessionId", "harness",
                    "operation", Map.of("kind", "begin-turn", "identity", identity)));
            assertEquals(200, control.statusCode(), control.body());
            assertTrue(control.body().contains("\"result\":null"), control.body());
            Map<String, Object> body = Map.of("protocolVersion", 1, "requestId", "prepare",
                    "idempotencyKey", "key", "harnessSessionId", "harness", "runtimeSessionId", runtime,
                    "turnId", "turn", "toolCallId", "call", "requestDigest", "b".repeat(64),
                    "reference", reference);
            HttpResponse<String> prepared = fixture.post("/executions:prepare", body);
            assertEquals(200, prepared.statusCode(), prepared.body());
            String executionId = JSON.parseObject(prepared.body()).getString("executionCallId");
            assertTrue(prepared.body().contains("\"state\":\"prepared\""));
            assertEquals(0, fixture.transport.executions.get());
            assertEquals(400, fixture.post("/executions", body).statusCode());
            HttpResponse<String> mixed = fixture.post("/executions/" + executionId + ":start", Map.of(
                    "protocolVersion", 1, "requestId", "mixed", "harnessSessionId", "harness",
                    "runtimeSessionId", runtime, "payloadJson", "{\"toolName\":\"write_file\",\"input\":{}}"));
            assertEquals(409, mixed.statusCode(), mixed.body());
            assertTrue(mixed.body().contains("runtime_execution_conflict"));
            assertEquals(0, fixture.transport.executions.get());
            HttpResponse<String> started = fixture.post("/executions/" + executionId + ":start", Map.of(
                    "protocolVersion", 1, "requestId", "start", "harnessSessionId", "harness",
                    "runtimeSessionId", runtime));
            assertEquals(409, started.statusCode(), started.body());
            assertTrue(started.body().contains("runtime_broker_execution_unknown"));
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void unknownExecutionDoesNotBecomeKnownExecuting() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap")
                    .toCompletableFuture().join();
            ToolExecutionRecord created = fixture.service.createExecution(
                    "harness", "runtime", "key", reference())
                    .toCompletableFuture().join();
            String path = "/executions/" + created.getExecutionCallId()
                    + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime";
            HttpRequest request = HttpRequest.newBuilder(fixture.uri(path))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> response = fixture.client.send(request,
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(409, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_broker_execution_unknown"));
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void authenticatesBeforeProcessingUnsupportedOperations() throws Exception {
        try (Fixture fixture = new Fixture()) {
            HttpRequest request = HttpRequest.newBuilder(fixture.uri("/executions:prepare"))
                    .POST(HttpRequest.BodyPublishers.ofString("{}"))
                    .build();
            assertEquals(401, fixture.client.send(request,
                    HttpResponse.BodyHandlers.ofString()).statusCode());
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void prepareHasNoEffectAndStartUsesOriginalBytesExactlyOnce() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.transport.fail = false;
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"write_file\",\"input\":{\"content\":\"你好\",\"number\":1.0}}";
            String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "turn",
                    "callId", "call", "argsDigest", digest);
            HttpResponse<String> reserved = fixture.post("/executions:prepare", Map.of(
                    "protocolVersion", 1, "requestId", "prepare", "idempotencyKey", "key",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime", "turnId", "turn",
                    "toolCallId", "call", "requestDigest", digest, "reference", reference));
            assertEquals(200, reserved.statusCode(), reserved.body());
            String id = JSON.parseObject(reserved.body()).getString("executionCallId");
            assertEquals(0, fixture.transport.executions.get());
            assertTrue(reserved.body().contains("prepared"));
            ToolExecutionRecord record = fixture.service.getExecution("harness", "runtime", id)
                    .toCompletableFuture().join();
            assertEquals(5, record.getReference().size());
            assertTrue(!record.getReference().containsKey("input"));
            // The immediate API cannot bypass the durable reservation.
            assertEquals(409, fixture.post("/executions", Map.of(
                    "protocolVersion", 1, "requestId", "bypass", "idempotencyKey", "key",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime", "turnId", "turn",
                    "toolCallId", "call", "requestDigest", digest, "reference", reference)).statusCode());
            assertEquals(0, fixture.transport.executions.get());
            HttpResponse<String> noPayload = fixture.post("/executions/" + id + ":start", Map.of(
                    "protocolVersion", 1, "requestId", "mixed", "harnessSessionId", "harness",
                    "runtimeSessionId", "runtime"));
            assertEquals(400, noPayload.statusCode(), noPayload.body());
            assertTrue(noPayload.body().contains("runtime_payload_invalid"));
            assertEquals(0, fixture.transport.executions.get());
            Map<String, Object> start = Map.of("protocolVersion", 1, "requestId", "start",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime", "payloadJson", payload);
            for (int attempt = 0; attempt < 2; attempt++) {
                HttpResponse<String> response = fixture.post("/executions/" + id + ":start", start);
                assertEquals(200, response.statusCode(), response.body());
                assertTrue(response.body().contains("settled"));
            }
            assertEquals(1, fixture.transport.executions.get());
            assertEquals("write_file", fixture.transport.lastReference.get("toolName"));
            assertEquals(409, fixture.post("/executions/" + id + ":start", Map.of(
                    "protocolVersion", 1, "requestId", "changed", "harnessSessionId", "harness",
                    "runtimeSessionId", "runtime", "payloadJson", payload + " ")).statusCode());
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void immediateExecutionRejectsDeferredReferencesBeforeDispatch() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.transport.fail = false;
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            Map<String, Object> deferred = new java.util.HashMap<>(reference());
            deferred.put("dispatchMode", "deferred");
            HttpResponse<String> response = fixture.post("/executions", Map.of(
                    "protocolVersion", 1, "requestId", "bypass", "idempotencyKey", "fresh-key",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime",
                    "turnId", "turn", "toolCallId", "call", "requestDigest", "digest", "reference", deferred));
            assertEquals(400, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_reference_invalid"), response.body());
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void cancelPreparedWorkNeverInvokesTransport() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"write_file\",\"input\":{}}";
            String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            ToolExecutionRecord record = fixture.service.prepareExecution("harness", "runtime", "key",
                    Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", digest))
                    .toCompletableFuture().join();
            fixture.service.cancelExecution("harness", "runtime", record.getExecutionCallId()).toCompletableFuture().join();
            assertTrue(fixture.service.startExecution("harness", "runtime", record.getExecutionCallId(), payload)
                    .toCompletableFuture().join().isSettled());
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    private static Map<String, Object> reference() {
        return Map.of("sessionId", "runtime", "promptId", "turn",
                "callId", "call", "argsDigest", "digest");
    }

    private static final class Fixture implements AutoCloseable {
        private final FailingTransport transport = new FailingTransport();
        private final HttpClient client = HttpClient.newHttpClient();
        private final RuntimeBrokerService service;
        private final RuntimeBrokerHttpServer server;

        private Fixture() throws Exception {
            RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                    "generation", "/workspace", "capability", "workspace");
            service = new RuntimeBrokerService(
                    id -> CompletableFuture.completedFuture(scope),
                    new StaticRuntimeProvisioner(new RuntimeLease("instance",
                            URI.create("http://127.0.0.1:1234"), "token", "lease", 1)),
                    transport, new InMemoryRuntimeBindingRepository(),
                    new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(Clock.systemUTC()),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            server = new RuntimeBrokerHttpServer(new InetSocketAddress("127.0.0.1", 0),
                    "secret", service);
            server.start();
        }

        private URI uri(String path) {
            return server.getBaseUri().resolve(RuntimeBrokerHttpServer.ROUTE_PREFIX + path);
        }

        private HttpResponse<String> post(String path, Map<String, Object> body) throws Exception {
            return client.send(HttpRequest.newBuilder(uri(path))
                    .header("Authorization", "Bearer secret")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(JSON.toJSONString(body)))
                    .build(), HttpResponse.BodyHandlers.ofString());
        }

        @Override
        public void close() {
            server.close();
            client.close();
        }
    }

    private static final class FailingTransport implements RuntimeTransport {
        private final AtomicInteger executions = new AtomicInteger();
        private boolean fail = true;
        private Map<String, Object> lastReference;

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> operation) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            lastReference = reference;
            if (!fail) return CompletableFuture.completedFuture(Map.of("executionStatus", "success", "responseParts", java.util.List.of()));
            return CompletableFuture.failedFuture(new IllegalStateException("connection lost"));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of("state", "unknown"));
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }
}
