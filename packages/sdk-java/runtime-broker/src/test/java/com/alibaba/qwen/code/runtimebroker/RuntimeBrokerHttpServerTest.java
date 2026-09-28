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
    void v3ReservationKeepsCanonicalInputAndExactPayloadDigestsSeparate() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf hi\"}}";
            String exact = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            String canonical = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest("{\"command\":\"printf hi\"}".getBytes(StandardCharsets.UTF_8)));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "turn",
                    "callId", "call", "argsDigest", canonical);
            HttpResponse<String> reserved = fixture.post("/executions:prepare", Map.ofEntries(
                    Map.entry("protocolVersion", 1), Map.entry("requestId", "prepare-v3"),
                    Map.entry("idempotencyKey", "v3-key"), Map.entry("harnessSessionId", "harness"),
                    Map.entry("runtimeSessionId", "runtime"), Map.entry("turnId", "turn"),
                    Map.entry("toolCallId", "call"), Map.entry("requestDigest", exact),
                    Map.entry("toolProtocol", "v3"), Map.entry("publicationId", "pub-1"),
                    Map.entry("reference", reference)));
            assertEquals(200, reserved.statusCode(), reserved.body());
            String id = JSON.parseObject(reserved.body()).getString("executionCallId");
            ToolExecutionRecord record = fixture.service.getExecution("harness", "runtime", id)
                    .toCompletableFuture().join();
            assertEquals(exact, record.getRequestDigest());
            assertEquals(canonical, record.getReference().get("argsDigest"));
            assertEquals("deferred_v3", record.getReference().get("dispatchMode"));
            assertEquals(0, fixture.transport.executions.get());
            assertEquals(503, fixture.post("/executions/" + id + ":start", Map.of(
                    "protocolVersion", 1, "requestId", "start-v3", "harnessSessionId", "harness",
                    "runtimeSessionId", "runtime", "payloadJson", payload)).statusCode());
            assertEquals(0, fixture.transport.executions.get());
            HttpResponse<String> cancelled = fixture.post("/executions/" + id + ":cancel", Map.of(
                    "protocolVersion", 1, "requestId", "cancel-v3", "harnessSessionId", "harness",
                    "runtimeSessionId", "runtime"));
            assertEquals(200, cancelled.statusCode(), cancelled.body());
            var result = JSON.parseObject(cancelled.body()).getJSONObject("status").getJSONObject("result");
            assertEquals("not_started", result.getString("executionStatus"));
            assertTrue(result.getJSONArray("responseParts").isEmpty());
            assertTrue(result.containsKey("capture") && result.get("capture") == null);
        }
    }

    @Test
    void v3InstallsOneGrantAndReconcilesTheOriginalFinishedResult() throws Exception {
        try (Fixture fixture = new Fixture(true)) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf hi\"}}";
            String exact = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            String canonical = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest("{\"command\":\"printf hi\"}".getBytes(StandardCharsets.UTF_8)));
            HttpResponse<String> reserved = fixture.post("/executions:prepare", Map.ofEntries(
                    Map.entry("protocolVersion", 1), Map.entry("requestId", "prepare-v3"),
                    Map.entry("idempotencyKey", "v3-key"), Map.entry("harnessSessionId", "harness"),
                    Map.entry("runtimeSessionId", "runtime"), Map.entry("turnId", "turn"),
                    Map.entry("toolCallId", "call"), Map.entry("requestDigest", exact),
                    Map.entry("toolProtocol", "v3"), Map.entry("publicationId", "pub-1"),
                    Map.entry("reference", Map.of("sessionId", "runtime", "promptId", "turn",
                            "callId", "call", "argsDigest", canonical))));
            assertEquals(200, reserved.statusCode(), reserved.body());
            String id = JSON.parseObject(reserved.body()).getString("executionCallId");
            Map<String, Object> start = Map.of("protocolVersion", 1, "requestId", "start-v3",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime",
                    "payloadJson", payload, "publicationId", "pub-1", "publicationToken", "token");
            assertEquals(200, fixture.post("/executions/" + id + ":start", start).statusCode());
            for (int attempt = 0; attempt < 50 && !fixture.service.getExecution("harness", "runtime", id)
                    .toCompletableFuture().join().isSettled(); attempt++) {
                Thread.sleep(20);
            }
            assertTrue(fixture.service.getExecution("harness", "runtime", id)
                    .toCompletableFuture().join().isSettled());
            assertEquals(1, fixture.transport.installs.get());
            assertEquals(1, fixture.transport.v3Executions.get());
            assertEquals(200, fixture.post("/executions/" + id + ":start", start).statusCode());
            assertEquals(1, fixture.transport.v3Executions.get());
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
            this(false);
        }

        private Fixture(boolean v3) throws Exception {
            RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                    "generation", "/workspace", "capability", "workspace");
            RuntimePublicationVerifier verifier = v3 ? new RuntimePublicationVerifier() {
                @Override
                public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                        String publicationId, String token) {
                    assertEquals("pub-1", publicationId);
                    assertEquals("token", token);
                    return new RuntimePublicationGrant(publicationId, token,
                            "https://publication.example/", Map.of("sessionKey",
                                    Map.of("tenantId", "tenant", "sessionId", "harness"),
                                    "turnId", "turn", "executionCallId", execution.getExecutionCallId(),
                                    "bindingGeneration", "1"));
                }

                @Override
                public Map<String, Object> finished(ToolExecutionRecord execution) {
                    return transport.v3Executions.get() == 0 ? null
                            : Map.of("executionStatus", "success", "responseParts", java.util.List.of());
                }
            } : null;
            service = new RuntimeBrokerService(
                    id -> CompletableFuture.completedFuture(scope),
                    new StaticRuntimeProvisioner(new RuntimeLease("instance",
                            URI.create("http://127.0.0.1:1234"), "token", "lease", 1)),
                    transport, new InMemoryRuntimeBindingRepository(),
                    new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(Clock.systemUTC()),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1), verifier);
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
        private final AtomicInteger installs = new AtomicInteger();
        private final AtomicInteger v3Executions = new AtomicInteger();
        private boolean fail = true;
        private Map<String, Object> lastReference;

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> operation) {
            return CompletableFuture.completedFuture(Map.of());
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
        public CompletionStage<Void> installPublication(RuntimeLease lease,
                RuntimeSession session, RuntimePublicationGrant grant) {
            installs.incrementAndGet();
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                Map<String, Object> payload, Map<String, Object> capture) {
            v3Executions.incrementAndGet();
            return CompletableFuture.completedFuture(Map.of("state", "executing"));
        }

        @Override
        public CompletionStage<Map<String, Object>> statusV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference, long afterSequence) {
            return CompletableFuture.completedFuture(Map.of("state", "executing"));
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
