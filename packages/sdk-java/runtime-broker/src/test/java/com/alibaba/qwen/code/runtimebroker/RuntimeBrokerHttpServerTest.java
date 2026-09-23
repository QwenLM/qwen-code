package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class RuntimeBrokerHttpServerTest {
    private static final String TOKEN = "broker-token";
    private static final String HARNESS_SESSION = "harness-session";
    private static final String RUNTIME_SESSION = "runtime-session";

    @Test
    void servesTheHostedHarnessContractAndWaitsOnlyAtAcquire()
            throws Exception {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                "generation-1", "/workspace", "capability-digest",
                "workspace");
        CompletableFuture<RuntimeLease> delayed = new CompletableFuture<>();
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(scope),
                ignored -> delayed, transport);
        try (RuntimeBrokerHttpServer server = new RuntimeBrokerHttpServer(
                new InetSocketAddress("127.0.0.1", 0), TOKEN, service)) {
            server.start();
            HttpClient client = HttpClient.newHttpClient();

            HttpResponse<byte[]> unauthorized = client.send(request(
                    server.getBaseUri(), "tool-sessions:acquire",
                    acquireBody(), "wrong-token"),
                    HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(401, unauthorized.statusCode());
            Map<String, Object> unauthorizedBody = JsonCodec.parseObject(
                    unauthorized.body(), "unauthorized response");
            assertEquals("runtime_broker_unauthorized",
                    unauthorizedBody.get("code"));
            assertEquals(false, unauthorizedBody.get("retryable"));

            CompletableFuture<HttpResponse<byte[]>> acquisition = client
                    .sendAsync(request(server.getBaseUri(),
                            "tool-sessions:acquire", acquireBody(), TOKEN),
                            HttpResponse.BodyHandlers.ofByteArray());
            Thread.sleep(30);
            assertFalse(acquisition.isDone());
            delayed.complete(new RuntimeLease("runtime-1",
                    URI.create("http://127.0.0.1:4190"), "runtime-token",
                    "lease-1", 1));
            assertEquals(200, acquisition.get(1, TimeUnit.SECONDS)
                    .statusCode());
            assertEquals(1, transport.acquisitions.get());

            Map<String, Object> control = envelope();
            control.put("operation", operation("manifest"));
            Map<String, Object> controlResponse = send(client,
                    request(server.getBaseUri(),
                            "tool-sessions/" + RUNTIME_SESSION + "/control",
                            control, TOKEN));
            assertEquals("manifest", object(controlResponse, "result")
                    .get("kind"));

            Map<String, Object> execution = envelope();
            execution.put("idempotencyKey", "execution-key");
            execution.put("turnId", "turn-1");
            execution.put("toolCallId", "tool-1");
            execution.put("requestDigest", "args-1");
            execution.put("reference", reference());
            Map<String, Object> created = send(client, request(
                    server.getBaseUri(), "executions:prepare", execution,
                    TOKEN));
            String executionCallId = (String) created.get("executionCallId");
            assertEquals("prepared", object(created, "status").get("state"));
            assertEquals(0, transport.executions.get());

            Map<String, Object> started = send(client, request(
                    server.getBaseUri(), "executions/"
                            + encode(executionCallId) + ":start", envelope(),
                    TOKEN));
            assertEquals("executing", object(started, "status").get("state"));
            assertEquals(1, transport.executions.get());

            transport.execution.complete(executionResult("success"));
            String query = "executions/" + encode(executionCallId)
                    + "?requestId=status-1&harnessSessionId="
                    + encode(HARNESS_SESSION) + "&runtimeSessionId="
                    + encode(RUNTIME_SESSION) + "&afterSeq=0";
            Map<String, Object> status = send(client, HttpRequest.newBuilder(
                    server.getBaseUri().resolve(
                            RuntimeBrokerHttpServer.ROUTE_PREFIX.substring(1)
                                    + "/" + query))
                    .header("Authorization", "Bearer " + TOKEN)
                    .GET().build());
            assertEquals("settled", object(status, "status").get("state"));
            assertEquals("success", object(object(status, "status"),
                    "result").get("executionStatus"));

            Map<String, Object> released = send(client, request(
                    server.getBaseUri(), "tool-sessions/" + RUNTIME_SESSION
                            + ":release", envelope(), TOKEN));
            assertTrue(Boolean.TRUE.equals(released.get("released")));
            assertEquals(1, transport.releases.get());
        }
    }

    @Test
    void resolvesUnknownExecutionsOverHttp() throws Exception {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                "generation-1", "/workspace", "capability-digest",
                "workspace");
        RuntimeLease lease = new RuntimeLease("runtime-1",
                URI.create("http://127.0.0.1:4190"), "runtime-token",
                "lease-1", 1);
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(scope),
                request -> CompletableFuture.completedFuture(lease),
                transport, bindings,
                new InMemoryRuntimeSessionRepository(), executions,
                "broker-a");
        try (RuntimeBrokerHttpServer server = new RuntimeBrokerHttpServer(
                new InetSocketAddress("127.0.0.1", 0), TOKEN, service)) {
            server.start();
            HttpClient client = HttpClient.newHttpClient();

            send(client, request(server.getBaseUri(),
                    "tool-sessions:acquire", acquireBody(), TOKEN));
            Map<String, Object> execution = envelope();
            execution.put("idempotencyKey", "execution-key");
            execution.put("turnId", "turn-1");
            execution.put("toolCallId", "tool-1");
            execution.put("requestDigest", "args-1");
            execution.put("reference", reference());
            Map<String, Object> created = send(client, request(
                    server.getBaseUri(), "executions", execution, TOKEN));
            String executionCallId = (String) created.get("executionCallId");
            assertEquals("executing", object(created, "status").get("state"));
            assertEquals(1, transport.executions.get());

            // A prepared execution is not unknown and cannot be resolved.
            Map<String, Object> prepared = envelope();
            prepared.put("idempotencyKey", "prepared-key");
            prepared.put("turnId", "turn-1");
            prepared.put("toolCallId", "tool-2");
            prepared.put("requestDigest", "args-2");
            prepared.put("reference", reference("tool-2", "args-2"));
            Map<String, Object> preparedCreated = send(client, request(
                    server.getBaseUri(), "executions:prepare", prepared,
                    TOKEN));
            String preparedCallId = (String) preparedCreated
                    .get("executionCallId");
            HttpResponse<byte[]> notUnknown = client.send(request(
                    server.getBaseUri(), "executions/" + encode(preparedCallId)
                            + ":resolve", resolveBody("accepted_unknown"),
                    TOKEN), HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(409, notUnknown.statusCode());
            assertEquals("runtime_broker_execution_not_unknown", JsonCodec
                    .parseObject(notUnknown.body(), "error").get("code"));

            // An unsupported resolution is rejected before touching state.
            HttpResponse<byte[]> invalid = client.send(request(
                    server.getBaseUri(), "executions/"
                            + encode(executionCallId) + ":resolve",
                    resolveBody("rerun"), TOKEN),
                    HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(400, invalid.statusCode());
            assertEquals("runtime_broker_invalid_request", JsonCodec
                    .parseObject(invalid.body(), "error").get("code"));

            RuntimeBindingRecord binding = bindings.findActive(
                    new RuntimeProvisionRequest(scope, null));
            bindings.compareAndSet(binding, binding.withState(
                    RuntimeBindingRecord.State.FAILED, binding.getLease(),
                    Instant.now()));

            HttpResponse<byte[]> unknown = client.send(HttpRequest
                    .newBuilder(server.getBaseUri().resolve(
                            RuntimeBrokerHttpServer.ROUTE_PREFIX.substring(1)
                                    + "/executions/" + encode(executionCallId)
                                    + "?requestId=status-1&harnessSessionId="
                                    + encode(HARNESS_SESSION)
                                    + "&runtimeSessionId="
                                    + encode(RUNTIME_SESSION)))
                    .header("Authorization", "Bearer " + TOKEN).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(503, unknown.statusCode());
            assertEquals("runtime_broker_execution_unknown", JsonCodec
                    .parseObject(unknown.body(), "error").get("code"));

            Map<String, Object> resolved = send(client, request(
                    server.getBaseUri(), "executions/"
                            + encode(executionCallId) + ":resolve",
                    resolveBody("confirmed_not_executed"), TOKEN));
            assertEquals("settled", object(resolved, "status").get("state"));
            assertEquals("not_started", object(object(resolved, "status"),
                    "result").get("executionStatus"));
            assertEquals("confirmed_not_executed",
                    object(object(resolved, "status"), "result")
                            .get("resolution"));

            // Resolution is durable and idempotent: the execution is settled
            // and was never re-dispatched.
            Map<String, Object> reread = send(client, request(
                    server.getBaseUri(), "executions/"
                            + encode(executionCallId) + ":resolve",
                    resolveBody("confirmed_not_executed"), TOKEN));
            assertEquals(resolved, reread);
            assertEquals(1, transport.executions.get());

            HttpResponse<byte[]> conflict = client.send(request(
                    server.getBaseUri(), "executions/"
                            + encode(executionCallId) + ":resolve",
                    resolveBody("accepted_unknown"), TOKEN),
                    HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(409, conflict.statusCode());
            assertEquals("runtime_broker_resolution_conflict", JsonCodec
                    .parseObject(conflict.body(), "error").get("code"));
        }
    }

    private static Map<String, Object> resolveBody(String resolution) {
        Map<String, Object> body = envelope();
        body.put("resolution", resolution);
        return body;
    }

    private static Map<String, Object> send(HttpClient client,
            HttpRequest request) throws Exception {
        HttpResponse<byte[]> response = client.send(request,
                HttpResponse.BodyHandlers.ofByteArray());
        assertEquals(200, response.statusCode(),
                new String(response.body(), StandardCharsets.UTF_8));
        return JsonCodec.parseObject(response.body(), "response");
    }

    private static HttpRequest request(URI baseUri, String path,
            Map<String, Object> body, String token) {
        URI target = baseUri.resolve(
                RuntimeBrokerHttpServer.ROUTE_PREFIX.substring(1)
                        + "/" + path);
        return HttpRequest.newBuilder(target)
                .timeout(Duration.ofSeconds(2))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(
                        JsonCodec.encode(body)))
                .build();
    }

    private static Map<String, Object> acquireBody() {
        Map<String, Object> body = envelope();
        body.put("turnKind", "bootstrap");
        return body;
    }

    private static Map<String, Object> envelope() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 1);
        body.put("requestId", "request-1");
        body.put("harnessSessionId", HARNESS_SESSION);
        body.put("runtimeSessionId", RUNTIME_SESSION);
        return body;
    }

    private static Map<String, Object> operation(String kind) {
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("kind", kind);
        return operation;
    }

    private static Map<String, Object> reference() {
        return reference("tool-1", "args-1");
    }

    private static Map<String, Object> reference(String callId,
            String argsDigest) {
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("sessionId", RUNTIME_SESSION);
        reference.put("promptId", "turn-1");
        reference.put("callId", callId);
        reference.put("capabilityDigest", "capability-digest");
        reference.put("policyRevision", "policy-1");
        reference.put("invocationId", "invocation-1");
        reference.put("argsDigest", argsDigest);
        return reference;
    }

    private static Map<String, Object> executionResult(String state) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("executionStatus", state);
        return result;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Map<String, Object> parent,
            String field) {
        return (Map<String, Object>) parent.get(field);
    }

    private static final class FakeTransport implements RuntimeTransport {
        private final AtomicInteger acquisitions = new AtomicInteger();
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();
        private final CompletableFuture<Map<String, Object>> execution =
                new CompletableFuture<>();

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            acquisitions.incrementAndGet();
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            return execution;
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            Map<String, Object> status = new LinkedHashMap<>();
            status.put("state", executions.get() == 0
                    ? "prepared" : "executing");
            status.put("cancelRequested", false);
            status.put("lastSeq", 0);
            status.put("firstAvailableSeq", 1);
            status.put("progressGap", false);
            status.put("progress", List.of());
            return CompletableFuture.completedFuture(status);
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            throw new AssertionError("cancel was not expected");
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            releases.incrementAndGet();
            return CompletableFuture.completedFuture(true);
        }
    }
}
