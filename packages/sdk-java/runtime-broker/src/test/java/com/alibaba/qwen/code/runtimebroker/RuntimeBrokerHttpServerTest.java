package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.fastjson2.JSON;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class RuntimeBrokerHttpServerTest {
    @Test
    void unsupportedOperationsNeverDispatchOrClaimResolution() throws Exception {
        try (Fixture fixture = new Fixture()) {
            HttpResponse<String> acquired = fixture.post("/tool-sessions:acquire", Map.of(
                    "protocolVersion", 1, "requestId", "acquire",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime",
                    "turnKind", "bootstrap"));
            assertEquals(200, acquired.statusCode());
            var body = JSON.parseObject(acquired.body());
            assertEquals("generation", body.getJSONObject("scope").getString("workspaceGeneration"));
            assertEquals("1", body.getJSONObject("runtime").getString("generation"));
            assertTrue(!body.getJSONObject("runtime").getString("bindingId").isEmpty());
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
            assertEquals(1, fixture.transport.controls.get());
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
    void resultBearingControlsCarryTheTransportResult() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String runtime = "550e8400-e29b-41d4-a716-446655440302";
            fixture.service.acquire("harness", runtime, "bootstrap").toCompletableFuture().join();
            HttpResponse<String> control = fixture.post("/tool-sessions/" + runtime + "/control", Map.of(
                    "protocolVersion", 1, "requestId", "manifest", "harnessSessionId", "harness",
                    "operation", Map.of("kind", "manifest")));
            assertEquals(200, control.statusCode(), control.body());
            assertEquals(FailingTransport.MANIFEST, JSON.parseObject(control.body()).getJSONObject("result"));
            assertEquals(1, fixture.transport.controls.get());
        }
    }

    @Test
    void v2UnknownExecutionReconcilesOnlyWhenExplicitlyRequested() throws Exception {
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
            assertEquals(0, fixture.transport.statusRequests.get());
            assertEquals(1, fixture.transport.executions.get());
            fixture.transport.runtimeStatus = Map.of("state", "settled", "result",
                    Map.of("executionStatus", "success", "responseParts", java.util.List.of()));
            HttpResponse<String> passive = fixture.client.send(request, HttpResponse.BodyHandlers.ofString());
            assertEquals(409, passive.statusCode(), passive.body());
            assertEquals(0, fixture.transport.statusRequests.get());
            HttpRequest disabled = HttpRequest.newBuilder(fixture.uri(path + "&reconcile=false"))
                    .header("Authorization", "Bearer secret").GET().build();
            assertEquals(409, fixture.client.send(disabled, HttpResponse.BodyHandlers.ofString()).statusCode());
            HttpRequest invalid = HttpRequest.newBuilder(fixture.uri(path + "&reconcile=invalid"))
                    .header("Authorization", "Bearer secret").GET().build();
            assertEquals(400, fixture.client.send(invalid, HttpResponse.BodyHandlers.ofString()).statusCode());
            HttpRequest foreign = HttpRequest.newBuilder(fixture.uri(
                    path.replace("harnessSessionId=harness", "harnessSessionId=other") + "&reconcile=true"))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> denied = fixture.client.send(foreign, HttpResponse.BodyHandlers.ofString());
            assertEquals(409, denied.statusCode(), denied.body());
            assertTrue(denied.body().contains("runtime_execution_conflict"));
            assertEquals(0, fixture.transport.statusRequests.get());
            HttpRequest reconcile = HttpRequest.newBuilder(fixture.uri(path + "&reconcile=true"))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> late = fixture.client.send(reconcile, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, late.statusCode(), late.body());
            assertEquals("settled", JSON.parseObject(late.body()).getJSONObject("status").getString("state"));
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    fixture.service.getExecution("harness", "runtime", created.getExecutionCallId())
                            .toCompletableFuture().join().getState());
            assertEquals(1, fixture.transport.executions.get());
            assertEquals(1, fixture.transport.statusRequests.get());
        }
    }

    @Test
    void v2PassiveStatusDoesNotContactAnUnavailableWorker() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            ToolExecutionRecord created = fixture.service.createExecution("harness", "runtime", "key", reference())
                    .toCompletableFuture().join();
            fixture.transport.statusUnavailable = true;
            String path = "/executions/" + created.getExecutionCallId()
                    + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime";
            HttpRequest passive = HttpRequest.newBuilder(fixture.uri(path))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> response = fixture.client.send(passive, HttpResponse.BodyHandlers.ofString());
            assertEquals(409, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_broker_execution_unknown"));
            assertEquals(0, fixture.transport.statusRequests.get());
            HttpRequest reconcile = HttpRequest.newBuilder(fixture.uri(path + "&reconcile=true"))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> unavailable = fixture.client.send(reconcile, HttpResponse.BodyHandlers.ofString());
            assertEquals(503, unavailable.statusCode(), unavailable.body());
            assertTrue(unavailable.body().contains("managed_runtime_unavailable"));
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.service.getExecution("harness", "runtime", created.getExecutionCallId())
                            .toCompletableFuture().join().getState());
            assertEquals(1, fixture.transport.statusRequests.get());
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void refusesAProtocolVersionThatIsNotExactlyOne() throws Exception {
        try (Fixture fixture = new Fixture()) {
            // Each literal would read as version 1.
            for (String version : List.of("1.0000000000000001",
                    "0.10000000000000001E+1", "1.0000000000000001D", "65537S")) {
                HttpResponse<String> response = fixture.post(
                        "/tool-sessions:acquire", acquire(version));
                assertEquals(409, response.statusCode(), version);
                assertTrue(response.body().contains(
                        "runtime_broker_protocol_conflict"), version);
            }
            assertEquals(200, fixture.post("/tool-sessions:acquire",
                    acquire("1.0")).statusCode());
        }
    }

    private static String acquire(String protocolVersion) {
        return "{\"protocolVersion\":" + protocolVersion
                + ",\"requestId\":\"acquire\",\"harnessSessionId\":\"harness\","
                + "\"runtimeSessionId\":\"runtime\",\"turnKind\":\"bootstrap\"}";
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
    void v3ReservationRejectsMixedLocalAndRemotePublicationModes() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "turn",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64),
                    "runtimeProtocol", 3, "inputDigest", "b".repeat(64));
            HttpResponse<String> response = fixture.post("/executions:prepare", Map.ofEntries(
                    Map.entry("protocolVersion", 1), Map.entry("requestId", "mixed-v3"),
                    Map.entry("idempotencyKey", "mixed-v3"), Map.entry("harnessSessionId", "harness"),
                    Map.entry("runtimeSessionId", "runtime"), Map.entry("turnId", "turn"),
                    Map.entry("toolCallId", "call"), Map.entry("requestDigest", "sha256:" + "a".repeat(64)),
                    Map.entry("toolProtocol", "v3"), Map.entry("publicationId", "pub-1"),
                    Map.entry("reference", reference)));
            assertEquals(400, response.statusCode(), response.body());
            assertEquals(0, fixture.transport.executions.get());
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
            Map<String, Object> changedGrant = new java.util.HashMap<>(start);
            changedGrant.put("publicationToken", "other-token");
            assertEquals(409, fixture.post("/executions/" + id + ":start", changedGrant).statusCode());
        }
    }

    @Test
    void nonRetryableV3DispatchOrStatusStopsWithoutRepeatedPolling() throws Exception {
        for (boolean dispatchUnsupported : new boolean[] {true, false}) {
            try (Fixture fixture = new Fixture(true)) {
                fixture.transport.v3Unsupported = dispatchUnsupported;
                fixture.transport.v3StatusUnsupported = !dispatchUnsupported;
                fixture.transport.v3RefusalStatus = 409;
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
                HttpResponse<String> start = fixture.post("/executions/" + id + ":start", Map.of(
                        "protocolVersion", 1, "requestId", "start-v3", "harnessSessionId", "harness",
                        "runtimeSessionId", "runtime", "payloadJson", payload,
                        "publicationId", "pub-1", "publicationToken", "token"));
                assertEquals(409, start.statusCode(), start.body());
                assertTrue(start.body().contains("runtime_broker_execution_unknown"), start.body());
                ToolExecutionRecord execution = fixture.service.getExecution("harness", "runtime", id)
                        .toCompletableFuture().join();
                for (int attempt = 0; attempt < 50 && execution.getState() != ToolExecutionRecord.State.UNKNOWN;
                        attempt++) {
                    Thread.sleep(20);
                    execution = fixture.service.getExecution("harness", "runtime", id)
                            .toCompletableFuture().join();
                }
                assertEquals(ToolExecutionRecord.State.UNKNOWN, execution.getState());
                assertEquals(dispatchUnsupported ? 0 : 1, fixture.transport.v3StatusCalls.get());
            }
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
    void providerStartTheWorkerNeverBeganStaysUnknownForTheCaller() throws Exception {
        // Provider references carry a UUID Runtime Session id.
        String runtime = "550e8400-e29b-41d4-a716-446655440303";
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", runtime, "bootstrap").toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", runtime, "promptId", "turn",
                    "callId", "worker-call", "capabilityDigest", "a".repeat(64),
                    "policyRevision", "policy", "invocationId", "invocation", "argsDigest", "b".repeat(64));
            String id = fixture.service.prepareExecution("harness", runtime, "provider", reference)
                    .toCompletableFuture().join().getExecutionCallId();
            Map<String, Object> start = Map.of("protocolVersion", 1, "requestId", "start",
                    "harnessSessionId", "harness", "runtimeSessionId", runtime);
            // The worker refused the execute: it still holds the call as prepared.
            fixture.transport.runtimeStatus = Map.of("state", "prepared");
            for (int attempt = 0; attempt < 2; attempt++) {
                HttpResponse<String> started = fixture.post("/executions/" + id + ":start", start);
                assertEquals(409, started.statusCode(), started.body());
                assertEquals("runtime_broker_execution_unknown",
                        JSON.parseObject(started.body()).getString("code"));
            }
            // The cancel route shares the envelope: the call never started,
            // but the physical cancellation still reaches the worker.
            HttpResponse<String> cancelled = fixture.post("/executions/" + id + ":cancel", Map.of(
                    "protocolVersion", 1, "requestId", "cancel", "harnessSessionId", "harness",
                    "runtimeSessionId", runtime));
            assertEquals(409, cancelled.statusCode(), cancelled.body());
            assertEquals("runtime_broker_execution_unknown",
                    JSON.parseObject(cancelled.body()).getString("code"));
            assertEquals(1, fixture.transport.cancellations.get());
            HttpRequest read = HttpRequest.newBuilder(fixture.uri("/executions/" + id
                    + "?requestId=read&harnessSessionId=harness&runtimeSessionId=" + runtime))
                    .header("Authorization", "Bearer secret").GET().build();
            assertEquals(409, fixture.client.send(read, HttpResponse.BodyHandlers.ofString()).statusCode());
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void providerObservesTheOriginalExecutionAfterResponseLoss() throws Exception {
        // Provider references carry a UUID Runtime Session id.
        String runtime = "550e8400-e29b-41d4-a716-446655440302";
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", runtime, "bootstrap").toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", runtime, "promptId", "turn",
                    "callId", "worker-call", "capabilityDigest", "a".repeat(64),
                    "policyRevision", "policy", "invocationId", "invocation", "argsDigest", "b".repeat(64));
            String id = fixture.service.prepareExecution("harness", runtime, "provider", reference)
                    .toCompletableFuture().join().getExecutionCallId();
            Map<String, Object> start = Map.of("protocolVersion", 1, "requestId", "start",
                    "harnessSessionId", "harness", "runtimeSessionId", runtime);
            // The worker ran the call, but its execute answer is lost.
            fixture.transport.runtimeStatus = Map.of("state", "executing");
            HttpResponse<String> started = fixture.post("/executions/" + id + ":start", start);
            assertEquals(200, started.statusCode(), started.body());
            assertEquals("executing", JSON.parseObject(started.body()).getJSONObject("status").getString("state"));
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.service.getExecution("harness", runtime, id).toCompletableFuture().join().getState());
            HttpResponse<String> repeated = fixture.post("/executions/" + id + ":start", start);
            assertEquals(200, repeated.statusCode(), repeated.body());
            assertEquals("executing", JSON.parseObject(repeated.body()).getJSONObject("status").getString("state"));
            // Its retained result settles the execution without a second dispatch.
            fixture.transport.runtimeStatus = Map.of("state", "settled",
                    "result", Map.of("executionStatus", "success"));
            awaitObservationCooldown();
            HttpRequest read = HttpRequest.newBuilder(fixture.uri("/executions/" + id
                    + "?requestId=read&harnessSessionId=harness&runtimeSessionId=" + runtime))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> settled = fixture.client.send(read, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, settled.statusCode(), settled.body());
            assertEquals("settled", JSON.parseObject(settled.body()).getJSONObject("status").getString("state"));
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    fixture.service.getExecution("harness", runtime, id).toCompletableFuture().join().getState());
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void startResponsesNeverServeTheCooldownCache() throws Exception {
        String runtime = "550e8400-e29b-41d4-a716-446655440305";
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", runtime, "bootstrap")
                    .toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", runtime,
                    "promptId", "turn", "callId", "worker-call",
                    "capabilityDigest", "a".repeat(64), "policyRevision",
                    "policy", "invocationId", "invocation", "argsDigest",
                    "b".repeat(64));
            String id = fixture.service.prepareExecution("harness", runtime,
                    "provider", reference).toCompletableFuture().join()
                    .getExecutionCallId();
            Map<String, Object> start = Map.of("protocolVersion", 1,
                    "requestId", "start", "harnessSessionId", "harness",
                    "runtimeSessionId", runtime);
            // The worker ran the call, but its execute answer is lost.
            fixture.transport.runtimeStatus = Map.of("state", "executing");
            assertEquals(200, fixture.post("/executions/" + id + ":start",
                    start).statusCode());
            // A cooled GET stamps the "executing" answer.
            HttpRequest read = HttpRequest.newBuilder(fixture.uri(
                    "/executions/" + id
                            + "?requestId=read&harnessSessionId=harness&runtimeSessionId="
                            + runtime))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> executing = fixture.client.send(read,
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(200, executing.statusCode(), executing.body());
            assertEquals("executing", JSON.parseObject(executing.body())
                    .getJSONObject("status").getString("state"));
            // The worker finishes inside the cooldown window; a :start
            // retry must answer from the Runtime, not the cache.
            fixture.transport.runtimeStatus = Map.of("state", "settled",
                    "result", Map.of("executionStatus", "success"));
            HttpResponse<String> retried = fixture.post("/executions/" + id
                    + ":start", start);
            assertEquals(200, retried.statusCode(), retried.body());
            assertEquals("settled", JSON.parseObject(retried.body())
                    .getJSONObject("status").getString("state"),
                    "a mutation response must not serve the cooldown cache");
        }
    }

    @Test
    void providerCancelsTheOriginalExecutionAfterResponseLoss() throws Exception {
        // Provider references carry a UUID Runtime Session id.
        String runtime = "550e8400-e29b-41d4-a716-446655440303";
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", runtime, "bootstrap").toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", runtime, "promptId", "turn",
                    "callId", "worker-call", "capabilityDigest", "a".repeat(64),
                    "policyRevision", "policy", "invocationId", "invocation", "argsDigest", "b".repeat(64));
            String id = fixture.service.prepareExecution("harness", runtime, "provider", reference)
                    .toCompletableFuture().join().getExecutionCallId();
            // The worker started the call, but its execute answer is lost.
            fixture.service.startExecution("harness", runtime, id).toCompletableFuture().join();
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.service.getExecution("harness", runtime, id).toCompletableFuture().join().getState());
            fixture.transport.runtimeStatus = Map.of("state", "cancel_requested");
            HttpResponse<String> cancelling = fixture.post("/executions/" + id + ":cancel", Map.of(
                    "protocolVersion", 1, "requestId", "cancel", "harnessSessionId", "harness",
                    "runtimeSessionId", runtime));
            assertEquals(200, cancelling.statusCode(), cancelling.body());
            assertEquals("cancel_requested",
                    JSON.parseObject(cancelling.body()).getJSONObject("status").getString("state"));
            // The cancellation reached the worker still running the call.
            assertEquals(1, fixture.transport.cancellations.get());
            fixture.transport.runtimeStatus = Map.of("state", "settled",
                    "result", Map.of("executionStatus", "cancelled"));
            awaitObservationCooldown();
            HttpRequest read = HttpRequest.newBuilder(fixture.uri("/executions/" + id
                    + "?requestId=read&harnessSessionId=harness&runtimeSessionId=" + runtime))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> settled = fixture.client.send(read, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, settled.statusCode(), settled.body());
            assertEquals("settled", JSON.parseObject(settled.body()).getJSONObject("status").getString("state"));
            assertEquals("cancelled", fixture.service.getExecution("harness", runtime, id)
                    .toCompletableFuture().join().getExecutionStatus());
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void v3UsesSavedSelectionAndObservesTheOriginalExecutionAfterResponseLoss() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            HttpResponse<String> registered = fixture.post("/tool-sessions/runtime:publisher", Map.of(
                    "protocolVersion", 1, "requestId", "register", "harnessSessionId", "harness",
                    "runtimeSessionId", "runtime", "publisher", Map.of("url", "http://127.0.0.1:1234/internal/hosted-shell-publisher/v1",
                            "token", "a".repeat(43))));
            assertEquals(200, registered.statusCode(), registered.body());
            assertEquals("1", JSON.parseObject(registered.body()).getString("bindingGeneration"));
            String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf hello\"}}";
            String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "turn", "callId", "worker-call",
                    "argsDigest", digest, "runtimeProtocol", 3, "inputDigest", "b".repeat(64));
            ToolExecutionRecord reserved = fixture.service.prepareExecution("harness", "runtime", "v3", reference)
                    .toCompletableFuture().join();
            assertThrows(RuntimeBrokerException.class,
                    () -> fixture.service.createExecution("harness", "runtime", "bypass", reference));
            String id = reserved.getExecutionCallId();
            fixture.service.startExecution("harness", "runtime", id, payload).toCompletableFuture().join();
            assertEquals(id, fixture.transport.lastReference.get("executionCallId"));
            ToolExecutionRecord unknown = fixture.service.getExecution("harness", "runtime", id).toCompletableFuture().join();
            assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
            assertTrue(!unknown.getReference().containsKey("executionCallId"));
            String route = "/executions/" + id + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime";
            HttpRequest request = HttpRequest.newBuilder(fixture.uri(route)).header("Authorization", "Bearer secret").GET().build();
            assertEquals(409, fixture.client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode());
            fixture.transport.runtimeStatus = Map.of("state", "prepared");
            awaitObservationCooldown();
            HttpResponse<String> prepared = fixture.client.send(request, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, prepared.statusCode(), prepared.body());
            assertEquals("prepared", JSON.parseObject(prepared.body()).getJSONObject("status").getString("state"));
            assertEquals(Set.of("state", "cancelRequested", "lastSeq", "firstAvailableSeq", "progressGap", "progress"),
                    JSON.parseObject(prepared.body()).getJSONObject("status").keySet());
            HttpResponse<String> repeatedStart = fixture.post("/executions/" + id + ":start", Map.of(
                    "protocolVersion", 1, "requestId", "repeat", "harnessSessionId", "harness",
                    "runtimeSessionId", "runtime", "payloadJson", payload));
            assertEquals(200, repeatedStart.statusCode(), repeatedStart.body());
            assertEquals("prepared", JSON.parseObject(repeatedStart.body()).getJSONObject("status").getString("state"));
            assertEquals(1, fixture.transport.executions.get());
            fixture.transport.runtimeStatus = Map.of("state", "executing");
            awaitObservationCooldown();
            HttpResponse<String> running = fixture.client.send(request, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, running.statusCode(), running.body());
            assertEquals("executing", JSON.parseObject(running.body()).getJSONObject("status").getString("state"));
            assertEquals(Set.of("state", "cancelRequested", "lastSeq", "firstAvailableSeq", "progressGap", "progress"),
                    JSON.parseObject(running.body()).getJSONObject("status").keySet());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.service.getExecution("harness", "runtime", id).toCompletableFuture().join().getState());
            fixture.transport.runtimeStatus = Map.of("state", "cancel_requested");
            // A mutation's response never serves the cooldown cache, so no
            // wait is needed before this cancel.
            HttpResponse<String> cancelling = fixture.post("/executions/" + id + ":cancel", Map.of(
                    "protocolVersion", 1, "requestId", "cancel", "harnessSessionId", "harness", "runtimeSessionId", "runtime"));
            assertEquals(200, cancelling.statusCode(), cancelling.body());
            assertEquals("cancel_requested", JSON.parseObject(cancelling.body()).getJSONObject("status").getString("state"));
            assertEquals(Set.of("state", "cancelRequested", "lastSeq", "firstAvailableSeq", "progressGap", "progress"),
                    JSON.parseObject(cancelling.body()).getJSONObject("status").keySet());
            assertTrue(JSON.parseObject(cancelling.body()).getJSONObject("status").getBooleanValue("cancelRequested"));
            assertEquals(1, fixture.transport.cancellations.get());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.service.getExecution("harness", "runtime", id).toCompletableFuture().join().getState());
            fixture.transport.runtimeStatus = Map.of("state", "settled", "result", Map.of("executionStatus", "cancelled"));
            awaitObservationCooldown();
            HttpResponse<String> settled = fixture.client.send(request, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, settled.statusCode(), settled.body());
            assertEquals("settled", JSON.parseObject(settled.body()).getJSONObject("status").getString("state"));
            HttpResponse<String> acknowledged = fixture.post("/executions/" + id + ":acknowledge", Map.of(
                    "protocolVersion", 1, "requestId", "ack", "harnessSessionId", "harness", "runtimeSessionId", "runtime",
                    "receipt", Map.of("executionCallId", id)));
            assertEquals(200, acknowledged.statusCode(), acknowledged.body());
            assertTrue(JSON.parseObject(acknowledged.body()).getBooleanValue("acknowledged"));
            assertEquals(1, fixture.transport.executions.get());
        }
    }

    @Test
    void v3PreparedCancellationNeverStartsAndCarriesNoCapture() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            ToolExecutionRecord record = fixture.service.prepareExecution("harness", "runtime", "v3-cancel",
                    Map.of("sessionId", "runtime", "promptId", "turn", "callId", "worker-call",
                            "argsDigest", "sha256:" + "a".repeat(64), "runtimeProtocol", 3, "inputDigest", "b".repeat(64)))
                    .toCompletableFuture().join();
            HttpResponse<String> cancelled = fixture.post("/executions/" + record.getExecutionCallId() + ":cancel", Map.of(
                    "protocolVersion", 1, "requestId", "cancel", "harnessSessionId", "harness", "runtimeSessionId", "runtime"));
            assertEquals(200, cancelled.statusCode(), cancelled.body());
            var result = JSON.parseObject(cancelled.body()).getJSONObject("status").getJSONObject("result");
            assertEquals("not_started", result.get("executionStatus"));
            assertTrue(result.containsKey("capture"), cancelled.body());
            assertEquals(null, result.get("capture"));
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

    @Test
    void rejectsExtraReserveFieldsBeforeWritingAReservation() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String digest = "sha256:" + "a".repeat(64);
            HttpResponse<String> response = fixture.post("/executions:prepare", Map.of(
                    "protocolVersion", 1, "requestId", "prepare", "idempotencyKey", "key",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime", "turnId", "turn",
                    "toolCallId", "call", "requestDigest", digest,
                    "reference", Map.of("sessionId", "runtime", "promptId", "turn",
                            "callId", "call", "argsDigest", digest), "extra", true));
            assertEquals(400, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_broker_invalid_request"), response.body());
            assertNull(fixture.executions.findByIdempotencyKey("key"));
            assertFalse(fixture.executions.hasActiveByRuntimeSession("runtime"));
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void rejectsPayloadBearingReserveReferencesBeforeWritingAReservation() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String digest = "sha256:" + "a".repeat(64);
            // The extra field rides inside the reference, so the request passes the
            // envelope shape and envelope/reference equality checks and is refused by
            // the service's own reference-shape check.
            Map<String, Object> reference = new HashMap<>(Map.of("sessionId", "runtime",
                    "promptId", "turn", "callId", "call", "argsDigest", digest));
            reference.put("input", Map.of());
            HttpResponse<String> response = fixture.post("/executions:prepare", Map.of(
                    "protocolVersion", 1, "requestId", "prepare", "idempotencyKey", "key",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime", "turnId", "turn",
                    "toolCallId", "call", "requestDigest", digest, "reference", reference));
            assertEquals(400, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_reference_invalid"), response.body());
            assertNull(fixture.executions.findByIdempotencyKey("key"));
            assertFalse(fixture.executions.hasActiveByRuntimeSession("runtime"));
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void rejectsANonStringStartPayloadBeforeTouchingTheReservation() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.transport.fail = false;
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"write_file\",\"input\":{}}";
            String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            ToolExecutionRecord reserved = fixture.service.prepareExecution("harness", "runtime", "key",
                    Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", digest))
                    .toCompletableFuture().join();
            Map<String, Object> body = new HashMap<>(Map.of("protocolVersion", 1, "requestId", "start",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime"));
            body.put("payloadJson", 123);
            HttpResponse<String> response = fixture.post(
                    "/executions/" + reserved.getExecutionCallId() + ":start", body);
            assertEquals(400, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_payload_invalid"), response.body());
            assertSame(reserved, fixture.executions.findByExecutionCallId(reserved.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.PREPARED, reserved.getState());
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void rejectsExtraStartFieldsBeforeChangingTheReservationOrDispatching() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.transport.fail = false;
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"write_file\",\"input\":{}}";
            String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            ToolExecutionRecord reserved = fixture.service.prepareExecution("harness", "runtime", "key",
                    Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", digest))
                    .toCompletableFuture().join();
            HttpResponse<String> response = fixture.post("/executions/" + reserved.getExecutionCallId() + ":start",
                    Map.of("protocolVersion", 1, "requestId", "start", "harnessSessionId", "harness",
                            "runtimeSessionId", "runtime", "payloadJson", payload, "extra", true));
            assertEquals(400, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_broker_invalid_request"), response.body());
            assertSame(reserved, fixture.executions.findByExecutionCallId(reserved.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.PREPARED, reserved.getState());
            assertEquals(0, reserved.getDispatchGeneration());
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void rejectsUnknownControlFieldsBeforeCallingTheTransport() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            HttpResponse<String> response = fixture.post("/tool-sessions/runtime/control", Map.of(
                    "protocolVersion", 1, "requestId", "control", "harnessSessionId", "harness",
                    "operation", Map.of("kind", "manifest", "extra", true)));
            assertEquals(400, response.statusCode(), response.body());
            assertTrue(response.body().contains("runtime_control_operation_invalid"), response.body());
            assertFalse(fixture.executions.hasActiveByRuntimeSession("runtime"));
            assertEquals(0, fixture.transport.controls.get());
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void rejectsForeignHistoryOwnersBeforeCallingTheTransport() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String harness = "550e8400-e29b-41d4-a716-446655440301";
            String runtime = "550e8400-e29b-41d4-a716-446655440302";
            fixture.service.acquire(harness, runtime, "bootstrap").toCompletableFuture().join();
            for (String owner : new String[] {"ownerSessionId", "ownerRuntimeSessionId"}) {
                Map<String, Object> binding = new java.util.LinkedHashMap<>(Map.of(
                        "ownerSessionId", harness, "ownerRuntimeSessionId", runtime,
                        "executionCwd", "/workspace", "snapshots", java.util.List.of()));
                binding.put(owner, "550e8400-e29b-41d4-a716-446655440303");
                HttpResponse<String> response = fixture.post("/tool-sessions/" + runtime + "/control", Map.of(
                        "protocolVersion", 1, "requestId", "control", "harnessSessionId", harness,
                        "operation", Map.of("kind", "bind-history", "binding", binding)));
                assertEquals(400, response.statusCode(), response.body());
                assertTrue(response.body().contains("runtime_control_operation_invalid"), response.body());
                assertFalse(fixture.executions.hasActiveByRuntimeSession(runtime));
                assertEquals(0, fixture.transport.controls.get());
                assertEquals(0, fixture.transport.executions.get());
            }
        }
    }

    private static Map<String, Object> reference() {
        return Map.of("sessionId", "runtime", "promptId", "turn",
                "callId", "call", "argsDigest", "digest");
    }

    // The HTTP face's automatic observation reuses the freshest answer for
    // a short cooldown; a changed Runtime answer is observed once it lapses.
    private static void awaitObservationCooldown() throws InterruptedException {
        Thread.sleep(RuntimeBrokerService.UNKNOWN_LOOKUP_COOLDOWN.toMillis()
                + 100);
    }

    private static final class Fixture implements AutoCloseable {
        private final FailingTransport transport = new FailingTransport();
        private final HttpClient client = HttpClient.newHttpClient();
        private final InMemoryToolExecutionRepository executions = new InMemoryToolExecutionRepository(Clock.systemUTC());
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
                    if (!"token".equals(token)) {
                        throw new RuntimeBrokerException(409, "runtime_execution_conflict",
                                "Original publication token changed", false);
                    }
                    return new RuntimePublicationGrant(publicationId, token,
                            "https://publication.example/", Map.of("sessionKey",
                                    Map.of("tenantId", "tenant", "sessionId", "harness"),
                                    "turnId", "turn", "executionCallId", execution.getExecutionCallId(),
                                    "bindingGeneration", "1"));
                }

                @Override
                public Map<String, Object> finished(ToolExecutionRecord execution) {
                    return transport.v3Executions.get() == 0 || transport.v3StatusUnsupported ? null
                            : Map.of("executionStatus", "success", "responseParts", java.util.List.of());
                }
            } : null;
            service = new RuntimeBrokerService(
                    id -> CompletableFuture.completedFuture(scope),
                    new StaticRuntimeProvisioner(new RuntimeLease("instance",
                            URI.create("http://127.0.0.1:1234"), "token", "lease", 1)),
                    transport, new InMemoryRuntimeBindingRepository(),
                    new InMemoryRuntimeSessionRepository(),
                    executions,
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1), verifier);
            server = new RuntimeBrokerHttpServer(new InetSocketAddress("127.0.0.1", 0),
                    "secret", service);
            server.start();
        }

        private URI uri(String path) {
            return server.getBaseUri().resolve(RuntimeBrokerHttpServer.ROUTE_PREFIX + path);
        }

        private HttpResponse<String> post(String path, Map<String, Object> body) throws Exception {
            return post(path, JSON.toJSONString(body));
        }

        private HttpResponse<String> post(String path, String body) throws Exception {
            return client.send(HttpRequest.newBuilder(uri(path))
                    .header("Authorization", "Bearer secret")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build(), HttpResponse.BodyHandlers.ofString());
        }

        @Override
        public void close() {
            server.close();
            client.close();
        }
    }

    private static final class FailingTransport implements RuntimeTransport {
        private static final Map<String, Object> MANIFEST = Map.of(
                "tools", java.util.List.of(Map.of("name", "read_file")),
                "capabilityDigest", "a".repeat(64), "policyRevision", "policy");
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger installs = new AtomicInteger();
        private final AtomicInteger v3Executions = new AtomicInteger();
        private final AtomicInteger v3StatusCalls = new AtomicInteger();
        private final AtomicInteger controls = new AtomicInteger();
        private final AtomicInteger cancellations = new AtomicInteger();
        private final AtomicInteger statusRequests = new AtomicInteger();
        private boolean statusUnavailable;
        private boolean fail = true;
        private boolean v3Unsupported;
        private boolean v3StatusUnsupported;
        private int v3RefusalStatus = 501;
        private Map<String, Object> lastReference;
        private Map<String, Object> runtimeStatus = Map.of("state", "unknown");

        @Override
        public CompletionStage<Void> installPublisher(RuntimeLease lease, RuntimeSession session, Map<String, Object> publisher) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> acknowledge(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, Map<String, Object> receipt) {
            return CompletableFuture.completedFuture(runtimeStatus);
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, long afterSequence) {
            statusRequests.incrementAndGet();
            if (statusUnavailable) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(503,
                        "managed_runtime_unavailable", "Runtime is unavailable", true));
            }
            return CompletableFuture.completedFuture(runtimeStatus);
        }

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> operation) {
            controls.incrementAndGet();
            return CompletableFuture.completedFuture(
                    "manifest".equals(operation.get("kind")) ? MANIFEST : null);
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
            if (v3Unsupported) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(v3RefusalStatus,
                        v3RefusalStatus == 501 ? "runtime_tool_v3_unsupported" : "runtime_execution_conflict",
                        "Tool v3 is unavailable", false));
            }
            v3Executions.incrementAndGet();
            return CompletableFuture.completedFuture(Map.of("state", "executing"));
        }

        @Override
        public CompletionStage<Map<String, Object>> statusV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference, long afterSequence) {
            v3StatusCalls.incrementAndGet();
            if (v3StatusUnsupported) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(v3RefusalStatus,
                        v3RefusalStatus == 501 ? "runtime_tool_v3_unsupported" : "runtime_execution_conflict",
                        "Tool v3 status is unavailable", false));
            }
            return CompletableFuture.completedFuture(Map.of("state", "executing"));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancellations.incrementAndGet();
            return CompletableFuture.completedFuture(runtimeStatus);
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }
}
