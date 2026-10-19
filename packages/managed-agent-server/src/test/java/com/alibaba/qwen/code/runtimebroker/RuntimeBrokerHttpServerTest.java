package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.qwen.code.runtimebroker.managedschema.JdbcRuntimeBrokerSchema;
import com.alibaba.qwen.code.runtimebroker.provisioning.StaticRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.security.ProtectedSecret;
import com.alibaba.qwen.code.runtimebroker.transport.RuntimeBrokerHttpServer;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RuntimeBrokerHttpServerTest {
    @Test
    void privateRecoveryReadRejectsIncompleteOrNonIntegralInstalledOwner() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Map<String, Object> body = new HashMap<>(Map.of("protocolVersion", 1, "requestId", "read",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime", "promptId", "prompt", "batchId", "batch"));
            Map<String, Object> owner = Map.of("writerId", "writer", "writerGeneration", 2, "activationId", "activation", "activationEpoch", 3);
            for (String field : owner.keySet()) {
                var missing = new HashMap<>(owner);
                missing.remove(field);
                body.put("recoveryOwner", missing);
                assertEquals(400, fixture.post("/executions:read-batch", body).statusCode());
            }
            for (Object invalid : List.of(0, -1, 1.5, "2", 9007199254740992L)) {
                for (String field : List.of("writerGeneration", "activationEpoch")) {
                    var changed = new HashMap<>(owner);
                    changed.put(field, invalid);
                    body.put("recoveryOwner", changed);
                    assertEquals(400, fixture.post("/executions:read-batch", body).statusCode());
                }
            }
            body.put("recoveryOwner", "owner");
            assertEquals(400, fixture.post("/executions:read-batch", body).statusCode());
            assertEquals(0, fixture.transport.executions.get());
            assertFalse(fixture.executions.hasActiveByRuntimeSession("runtime"));
        }
    }

    @Test
    void warmAndAcquireExposeTheOriginalScopeIsolationClass() throws Exception {
        for (String capability : List.of("capability", ResidentWorkspaceProfile.CAPABILITY_DIGEST)) {
            var scope = new RuntimeScope("tenant", "workspace", "generation", "/workspace", capability,
                    ResidentWorkspaceProfile.CAPABILITY_DIGEST.equals(capability) ? "workspace" : "session");
            try (Fixture fixture = new Fixture(false, null, scope)) {
                HttpResponse<String> warmed = fixture.post("/runtimes:warm", Map.of(
                        "protocolVersion", 1, "requestId", "warm", "harnessSessionId", "harness"));
                HttpResponse<String> acquired = fixture.post("/tool-sessions:acquire", Map.of(
                        "protocolVersion", 1, "requestId", "acquire", "harnessSessionId", "harness",
                        "runtimeSessionId", "runtime", "turnKind", "bootstrap"));
                for (var response : List.of(warmed, acquired)) {
                    assertEquals(200, response.statusCode(), response.body());
                    var actual = JSON.parseObject(response.body()).getJSONObject("scope");
                    assertEquals(scope.getTenantId(), actual.getString("tenantId"));
                    assertEquals(scope.getWorkspaceId(), actual.getString("workspaceId"));
                    assertEquals(scope.getWorkspaceGeneration(), actual.getString("workspaceGeneration"));
                    assertEquals(capability, actual.getString("capabilityDigest"));
                    assertEquals(scope.getIsolationClass(), actual.getString("isolationClass"), response.body());
                }
            }
        }
    }

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
    void activeHoldsListsTheHarnessLiveHoldRuntimes() throws Exception {
        // #13930 R1-2: the reloaded Harness restores the close's drain
        // obligation through this read-only route.
        try (Fixture fixture = new Fixture()) {
            RuntimeSessionRecord sessionA = fixture.service
                    .acquire("harness", "runtime-a", "bootstrap")
                    .toCompletableFuture().join();
            RuntimeSessionRecord sessionB = fixture.service
                    .acquire("harness", "runtime-b", "bootstrap")
                    .toCompletableFuture().join();
            admitHold(fixture, sessionA, "call-a", "background_v3_process");
            admitHold(fixture, sessionB, "call-b", "background_v3_monitor");
            fixture.executions.settlePrepared(
                    admitHold(fixture, sessionA, "call-exited",
                            "background_v3_process"),
                    Map.of("state", "exited", "executionStatus", "success"),
                    java.time.Instant.now());

            HttpResponse<String> response = fixture.post(
                    "/tool-sessions:active-holds", Map.of("protocolVersion", 1,
                            "requestId", "holds", "harnessSessionId", "harness"));
            assertEquals(200, response.statusCode(), response.body());
            var body = JSON.parseObject(response.body());
            assertEquals(1, body.getIntValue("protocolVersion"));
            assertEquals("harness", body.getString("harnessSessionId"));
            assertEquals(Set.of("runtime-a", "runtime-b"),
                    Set.copyOf(body.getJSONArray("heldRuntimeSessionIds")
                            .toJavaList(String.class)));
            assertEquals(400, fixture.post("/tool-sessions:active-holds",
                    Map.of("protocolVersion", 1, "requestId", "bad"))
                    .statusCode());
        }
    }

    @Test
    void activeHoldsMapsScopeResolutionFailures() throws Exception {
        // #13986 R1-8: every sibling resolver call answers the module's
        // mapped code; an unmapped throw here would escape as the generic
        // 500 runtime_broker_internal_error instead.
        try (Fixture fixture = new Fixture(false,
                id -> {
                    throw new IllegalStateException("scope directory gone");
                })) {
            HttpResponse<String> response = fixture.post(
                    "/tool-sessions:active-holds", Map.of("protocolVersion", 1,
                            "requestId", "holds", "harnessSessionId", "harness"));
            assertEquals(503, response.statusCode(), response.body());
            assertTrue(
                    response.body().contains("runtime_hold_inventory_scope_failed"),
                    response.body());
        }
    }

    @Test
    void releaseDecodesTheDrainFlagFromTheWire() throws Exception {
        // #13930 R1-19: the close's drain and the routine release differ
        // only by this body flag; a stringified or renamed key must not
        // degrade a drain into the routine arm that answers held.
        try (Fixture fixture = new Fixture()) {
            RuntimeSessionRecord session = fixture.service
                    .acquire("harness", "runtime-drain", "bootstrap")
                    .toCompletableFuture().join();
            String digest = "sha256:" + "a".repeat(64);
            ToolExecutionRecord invocation = fixture.executions.findOrCreate(
                    ToolExecutionRecord.prepared(
                            "call-drain", "call-drain-key",
                            session.getBindingId(),
                            session.getRuntimeGeneration(), "harness",
                            "runtime-drain", "prompt", "call-drain", digest,
                            Map.of("sessionId", "runtime-drain", "promptId",
                                    "prompt", "callId", "call-drain",
                                    "argsDigest", digest)));
            fixture.executions.settlePrepared(invocation,
                    Map.of("state", "exited", "executionStatus", "success"),
                    Instant.now());
            Map<String, Object> processReference = new java.util.LinkedHashMap<>();
            processReference.put("dispatchMode", "background_v3_process");
            processReference.put("processOf", "call-drain");
            processReference.put("sessionId", "runtime-drain");
            processReference.put("promptId", "prompt");
            processReference.put("callId", "call-drain");
            processReference.put("argsDigest", digest);
            fixture.executions.findOrCreate(ToolExecutionRecord.prepared(
                    "call-drain:process", "call-drain:process",
                    session.getBindingId(), session.getRuntimeGeneration(),
                    "harness", "runtime-drain", "prompt", "call-drain",
                    digest, processReference));

            fixture.transport.controlResults.put("shell-status",
                    CompletableFuture.completedFuture(
                            Map.of("operationId", "call-drain",
                                    "state", "running")));
            fixture.transport.controlResults.put("shell-terminate",
                    CompletableFuture.completedFuture(
                            Map.of("operationId", "call-drain",
                                    "state", "exited",
                                    "evidence", Map.of("exitCode", 0))));
            HttpResponse<String> routine = fixture.post(
                    "/tool-sessions/runtime-drain:release", Map.of(
                            "protocolVersion", 1, "requestId", "routine",
                            "harnessSessionId", "harness"));
            assertEquals(409, routine.statusCode(), routine.body());
            assertTrue(routine.body().contains("runtime_session_held"),
                    routine.body());

            HttpResponse<String> drained = fixture.post(
                    "/tool-sessions/runtime-drain:release", Map.of(
                            "protocolVersion", 1, "requestId", "drained",
                            "harnessSessionId", "harness", "drain", true));
            assertEquals(200, drained.statusCode(), drained.body());
            assertTrue(drained.body().contains("\"released\":true"),
                    drained.body());
        }
    }

    private static ToolExecutionRecord admitHold(Fixture fixture,
            RuntimeSessionRecord session, String callId, String dispatchMode) {
        return fixture.executions.findOrCreate(ToolExecutionRecord.prepared(
                callId + ":process", callId + ":process", session.getBindingId(),
                session.getRuntimeGeneration(),
                session.getSession().getHarnessSessionId(),
                session.getRuntimeSessionId(), "turn", callId, "digest",
                Map.of("dispatchMode", dispatchMode, "sessionId",
                        session.getRuntimeSessionId(), "promptId", "turn",
                        "callId", callId, "argsDigest", "digest")));
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

    @Test
    @SuppressWarnings("unchecked")
    void answersAStoreFailureAsRetryableServiceUnavailable() throws Exception {
        InMemoryToolExecutionRepository inner = new InMemoryToolExecutionRepository(Clock.systemUTC());
        AtomicBoolean failing = new AtomicBoolean(true);
        AtomicReference<String> failingMethod = new AtomicReference<>("findByIdempotencyKey");
        AtomicReference<Throwable> outage = new AtomicReference<>(
                JdbcRepositorySupport.failure(new java.sql.SQLException("simulated outage")));
        List<String> intercepted = java.util.Collections.synchronizedList(
                new java.util.ArrayList<>());
        ToolExecutionRepository gate = (ToolExecutionRepository) Proxy.newProxyInstance(
                RuntimeBrokerHttpServerTest.class.getClassLoader(),
                new Class<?>[] { ToolExecutionRepository.class },
                (proxy, method, args) -> {
                    if (failing.get() && failingMethod.get().equals(method.getName())) {
                        intercepted.add(method.getName());
                        throw outage.get();
                    }
                    try {
                        return method.invoke(inner, args);
                    } catch (java.lang.reflect.InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
        String digest = "sha256:" + "b".repeat(64);
        Map<String, Object> body = Map.of(
                "protocolVersion", 1, "requestId", "prepare", "idempotencyKey", "key",
                "harnessSessionId", "harness", "runtimeSessionId", "runtime", "turnId", "turn",
                "toolCallId", "call", "requestDigest", digest,
                "reference", Map.of("sessionId", "runtime", "promptId", "turn",
                        "callId", "call", "argsDigest", digest));
        try (Fixture fixture = new Fixture(gate)) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            HttpResponse<String> response = fixture.post("/executions:prepare", body);
            assertEquals(503, response.statusCode(), response.body());
            var errorBody = JSON.parseObject(response.body());
            assertEquals("runtime_broker_store_unavailable", errorBody.getString("code"));
            assertTrue(errorBody.getBooleanValue("retryable"));
            // The outage wrote nothing: no reservation survives a failed prepare.
            assertNull(inner.findByIdempotencyKey("key"));
            // The retry is safe: the same idempotency key lands once the store answers again.
            failing.set(false);
            Map<String, Object> retryBody = new HashMap<>(body);
            retryBody.put("requestId", "retry");
            HttpResponse<String> retried = fixture.post("/executions:prepare", retryBody);
            assertEquals(200, retried.statusCode(), retried.body());
            String executionCallId = JSON.parseObject(retried.body()).getString("executionCallId");
            ToolExecutionRecord landed = inner.findByIdempotencyKey("key");
            assertEquals(executionCallId, landed.getExecutionCallId());
            // Every route that reads the execution store maps the same outage
            // class the same way: read, start (both variants), cancel, and
            // acknowledge.
            failingMethod.set("findByExecutionCallId");
            failing.set(true);
            HttpRequest read = HttpRequest.newBuilder(fixture.uri("/executions/" + executionCallId
                            + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime"))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> readResponse = fixture.client.send(read, HttpResponse.BodyHandlers.ofString());
            assertEquals(503, readResponse.statusCode(), readResponse.body());
            var readError = JSON.parseObject(readResponse.body());
            assertEquals("runtime_broker_store_unavailable", readError.getString("code"));
            assertTrue(readError.getBooleanValue("retryable"));
            for (Map<String, Object> startBody : List.<Map<String, Object>>of(
                    Map.of("protocolVersion", 1, "requestId", "start",
                            "harnessSessionId", "harness", "runtimeSessionId", "runtime"),
                    Map.of("protocolVersion", 1, "requestId", "start-payload",
                            "harnessSessionId", "harness", "runtimeSessionId", "runtime",
                            "payloadJson", "{\"toolName\":\"write_file\",\"input\":{}}"))) {
                HttpResponse<String> started = fixture.post(
                        "/executions/" + executionCallId + ":start", startBody);
                assertEquals(503, started.statusCode(), started.body());
                var startError = JSON.parseObject(started.body());
                assertEquals("runtime_broker_store_unavailable", startError.getString("code"));
                assertTrue(startError.getBooleanValue("retryable"));
            }
            HttpResponse<String> cancelled = fixture.post(
                    "/executions/" + executionCallId + ":cancel", Map.of(
                            "protocolVersion", 1, "requestId", "cancel",
                            "harnessSessionId", "harness", "runtimeSessionId", "runtime"));
            assertEquals(503, cancelled.statusCode(), cancelled.body());
            var cancelError = JSON.parseObject(cancelled.body());
            assertEquals("runtime_broker_store_unavailable", cancelError.getString("code"));
            assertTrue(cancelError.getBooleanValue("retryable"));
            HttpResponse<String> acknowledged = fixture.post(
                    "/executions/" + executionCallId + ":acknowledge", Map.of(
                            "protocolVersion", 1, "requestId", "acknowledge",
                            "harnessSessionId", "harness", "runtimeSessionId", "runtime",
                            "receipt", Map.of("executionCallId", executionCallId)));
            assertEquals(503, acknowledged.statusCode(), acknowledged.body());
            var acknowledgeError = JSON.parseObject(acknowledged.body());
            assertEquals("runtime_broker_store_unavailable", acknowledgeError.getString("code"));
            assertTrue(acknowledgeError.getBooleanValue("retryable"));
            // A failed write maps the same way and leaves nothing behind:
            // neither the reservation a fresh prepare would create nor a
            // cancel request on the landed execution.
            failingMethod.set("findOrCreate");
            Map<String, Object> writeBody = new HashMap<>(body);
            writeBody.put("requestId", "write");
            writeBody.put("idempotencyKey", "write-key");
            HttpResponse<String> unwritten = fixture.post("/executions:prepare", writeBody);
            assertEquals(503, unwritten.statusCode(), unwritten.body());
            var writeError = JSON.parseObject(unwritten.body());
            assertEquals("runtime_broker_store_unavailable", writeError.getString("code"));
            assertTrue(writeError.getBooleanValue("retryable"));
            assertNull(inner.findByIdempotencyKey("write-key"));
            failingMethod.set("requestCancel");
            HttpResponse<String> uncancelled = fixture.post(
                    "/executions/" + executionCallId + ":cancel", Map.of(
                            "protocolVersion", 1, "requestId", "cancel-write",
                            "harnessSessionId", "harness", "runtimeSessionId", "runtime"));
            assertEquals(503, uncancelled.statusCode(), uncancelled.body());
            var cancelWriteError = JSON.parseObject(uncancelled.body());
            assertEquals("runtime_broker_store_unavailable", cancelWriteError.getString("code"));
            assertTrue(cancelWriteError.getBooleanValue("retryable"));
            assertSame(landed, inner.findByExecutionCallId(executionCallId));
            // A permanent invariant violation is not a store outage: it keeps
            // the non-retryable 500 the HTTP layer gives any other failure.
            outage.set(assertThrows(IllegalStateException.class,
                    () -> new AesGcmSecretProtector("ring-closed-2026", new byte[32])
                            .unprotect("context", new ProtectedSecret("legacy", "unused"))));
            failingMethod.set("findByIdempotencyKey");
            Map<String, Object> invariantBody = new HashMap<>(body);
            invariantBody.put("requestId", "invariant");
            invariantBody.put("idempotencyKey", "invariant-key");
            HttpResponse<String> invariant = fixture.post("/executions:prepare", invariantBody);
            assertEquals(500, invariant.statusCode(), invariant.body());
            var invariantError = JSON.parseObject(invariant.body());
            assertEquals("runtime_broker_internal_error", invariantError.getString("code"));
            assertFalse(invariantError.getBooleanValue("retryable"));
            assertFalse(invariant.body().contains("ring-closed-2026"));
            // Nothing landed or changed while the store was failing, and the
            // gate intercepted only the intended call on each route.
            assertSame(landed, inner.findByExecutionCallId(executionCallId));
            assertEquals(List.of("findByIdempotencyKey", "findByExecutionCallId",
                    "findByExecutionCallId", "findByExecutionCallId", "findByExecutionCallId",
                    "findByExecutionCallId", "findOrCreate", "requestCancel", "findByIdempotencyKey"),
                    intercepted);
            fixture.service.close();
            HttpResponse<String> closed = fixture.post("/runtimes:warm", Map.of(
                    "protocolVersion", 1, "requestId", "closed", "harnessSessionId", "harness"));
            assertEquals(503, closed.statusCode(), closed.body());
            assertEquals("runtime_broker_closed", JSON.parseObject(closed.body()).getString("code"));
        }

        // The private CSI routes reach the same store through the JDBC binding
        // repository's own transaction; the same outage maps the same way.
        String csiSession = "550e8400-e29b-41d4-a716-4466554400ff";
        var csiRequest = CsiFilesRetirementProfile.request(
                new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                        "tenant", "workspace", 1, "storage", ".",
                        CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1),
                "/workspace", csiSession);
        var csiSource = new org.h2.jdbcx.JdbcDataSource();
        csiSource.setURL("jdbc:h2:mem:csi-outage-" + java.util.UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(csiSource);
        try (var connection = csiSource.getConnection();
                var statement = connection.prepareStatement(
                        "INSERT INTO ma_session (tenant_id, session_id, agent_id, tool_profile,"
                                + " runtime_request_key, workspace_id, workspace_generation,"
                                + " workspace_storage_id, cwd_relative, context_config_ref,"
                                + " context_revision, workspace_config_ref, workspace_policy_ref,"
                                + " gmt_create, gmt_modified) VALUES ('tenant', ?, 'qwen-code', ?, ?,"
                                + " 'workspace', 1, 'storage', '.', ?, 1, ?, ?, 0, 0)")) {
            JdbcRepositorySupport.setIdentity(statement, 1, csiSession);
            statement.setString(2, CsiFilesRetirementProfile.PROFILE);
            statement.setString(3, csiRequest.requestKey());
            JdbcRepositorySupport.setIdentity(statement, 4,
                    CsiFilesRetirementProfile.CONTEXT_CONFIG_REF);
            JdbcRepositorySupport.setIdentity(statement, 5,
                    CsiFilesRetirementProfile.CONFIG_REF);
            JdbcRepositorySupport.setIdentity(statement, 6,
                    CsiFilesRetirementProfile.POLICY_REF);
            statement.executeUpdate();
        }
        AtomicBoolean csiFailing = new AtomicBoolean();
        var failingSource = (javax.sql.DataSource) Proxy.newProxyInstance(
                RuntimeBrokerHttpServerTest.class.getClassLoader(),
                new Class<?>[] { javax.sql.DataSource.class },
                (proxy, method, arguments) -> {
                    if (csiFailing.get() && method.getName().equals("getConnection")) {
                        throw new java.sql.SQLException("simulated outage");
                    }
                    try {
                        return method.invoke(csiSource, arguments);
                    } catch (java.lang.reflect.InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
        var csiBindings = new JdbcRuntimeBindingRepository(failingSource,
                new AesGcmSecretProtector("test", new byte[32]));
        var csiSessions = new JdbcRuntimeSessionRepository(failingSource);
        var csiExecutions = new JdbcToolExecutionRepository(failingSource);
        var csiCreated = csiBindings.findOrCreate(csiRequest);
        var csiClaimed = csiBindings.claimOperation(csiCreated.getBindingId(), "setup",
                Duration.ofMinutes(1));
        var csiSeed = csiClaimed.getProvisionSeed();
        var csiLease = new RuntimeLease(csiSeed.getProvisionalRuntimeId(),
                URI.create("http://127.0.0.1:1234"), csiSeed.getToken(),
                csiSeed.getLeaseId(), csiSeed.getEpoch());
        var csiBinding = csiBindings.compareAndSet(csiClaimed, csiClaimed.withAttestation(
                csiLease, new RuntimeResourceHandle(csiRequest.getProvisionerKind(), 1,
                        Map.of("resource", "original")),
                java.time.Instant.now(), java.time.Instant.now()));
        var csiRuntime = new RuntimeSession(csiSession, csiSession, "bootstrap",
                csiRequest.getScope());
        var csiSaved = csiSessions.findOrCreate(new RuntimeSessionRecord(csiRuntime,
                csiBinding.getBindingId(), csiBinding.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, java.time.Instant.now()));
        csiSessions.compareAndSet(csiSaved, csiSaved.withState(
                RuntimeSessionRecord.State.READY, java.time.Instant.now()));
        csiFailing.set(true);
        try (var csiService = new RuntimeBrokerService(
                id -> CompletableFuture.completedFuture(csiRequest.getScope()),
                new StaticRuntimeProvisioner(csiLease), new FailingTransport(), csiBindings,
                csiSessions, csiExecutions, "broker", Duration.ofMinutes(1),
                Duration.ofMinutes(1));
                var csiClient = HttpClient.newHttpClient()) {
            var contextClass = Class.forName(
                    RuntimeBrokerService.class.getName() + "$SessionContext");
            var contextConstructor = contextClass.getDeclaredConstructor(
                    RuntimeSession.class, RuntimeBindingRecord.class, RuntimeLease.class);
            contextConstructor.setAccessible(true);
            var installed = RuntimeBrokerService.class.getDeclaredField("sessions");
            installed.setAccessible(true);
            ((Map<String, CompletableFuture<?>>) installed.get(csiService)).put(csiSession,
                    CompletableFuture.completedFuture(contextConstructor.newInstance(
                            csiRuntime, csiBinding, csiLease)));
            var csiServer = new RuntimeBrokerHttpServer(
                    new InetSocketAddress("127.0.0.1", 0), "secret", csiService);
            csiServer.start();
            try {
                String csiDigest = "sha256:" + "c".repeat(64);
                Map<String, Object> csiPrepare = new java.util.LinkedHashMap<>(Map.of(
                        "protocolVersion", 1, "requestId", "csi-prepare",
                        "idempotencyKey", "csi-key", "harnessSessionId", csiSession,
                        "runtimeSessionId", csiSession, "turnId", "turn", "toolCallId",
                        "call", "requestDigest", csiDigest,
                        "reference", Map.of("sessionId", csiSession, "promptId", "turn",
                                "callId", "call", "argsDigest", csiDigest)));
                csiPrepare.put("inputBytesBase64", java.util.Base64.getEncoder()
                        .encodeToString("{\"payloadJson\":\"{}\"}"
                                .getBytes(StandardCharsets.UTF_8)));
                csiPrepare.put("toolDefinitionBytesBase64", java.util.Base64.getEncoder()
                        .encodeToString("{\"name\":\"read_file\"}"
                                .getBytes(StandardCharsets.UTF_8)));
                HttpResponse<String> csiPrepared = csiClient.send(HttpRequest.newBuilder(
                        csiServer.getBaseUri().resolve(RuntimeBrokerHttpServer.ROUTE_PREFIX
                                + "/executions:prepare"))
                        .header("Authorization", "Bearer secret")
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(JSON.toJSONString(csiPrepare)))
                        .build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(503, csiPrepared.statusCode(), csiPrepared.body());
                var csiPrepareError = JSON.parseObject(csiPrepared.body());
                assertEquals("runtime_broker_store_unavailable",
                        csiPrepareError.getString("code"));
                assertTrue(csiPrepareError.getBooleanValue("retryable"));
                HttpResponse<String> csiBatch = csiClient.send(HttpRequest.newBuilder(
                        csiServer.getBaseUri().resolve(RuntimeBrokerHttpServer.ROUTE_PREFIX
                                + "/executions:read-batch"))
                        .header("Authorization", "Bearer secret")
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(JSON.toJSONString(Map.of(
                                "protocolVersion", 1, "requestId", "csi-read",
                                "harnessSessionId", csiSession,
                                "runtimeSessionId", csiSession,
                                "promptId", "turn", "batchId", "batch"))))
                        .build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(503, csiBatch.statusCode(), csiBatch.body());
                var csiBatchError = JSON.parseObject(csiBatch.body());
                assertEquals("runtime_broker_store_unavailable",
                        csiBatchError.getString("code"));
                assertTrue(csiBatchError.getBooleanValue("retryable"));
            } finally {
                csiServer.close();
            }
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void answersAPrivateCsiStoreFailureAsRetryableServiceUnavailable() throws Exception {
        String session = "550e8400-e29b-41d4-a716-446655440313";
        RuntimeProvisionRequest request = CsiFilesRetirementProfile.request(
                new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                        "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1),
                "/workspace", session);
        InMemoryRuntimeBindingRepository registry = new InMemoryRuntimeBindingRepository();
        RuntimeBindingRecord binding = registry.claimOperation(registry.findOrCreate(request).getBindingId(),
                "setup", Duration.ofMinutes(1));
        var seed = binding.getProvisionSeed();
        RuntimeLease lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        binding = registry.compareAndSet(binding, binding.withAttestation(lease,
                new RuntimeResourceHandle(request.getProvisionerKind(), 1, Map.of("fixture", true)),
                Instant.now(), Instant.now()));
        RuntimeSession runtime = new RuntimeSession(session, session, "bootstrap", request.getScope());
        InMemoryRuntimeSessionRepository sessions = new InMemoryRuntimeSessionRepository();
        RuntimeSessionRecord saved = sessions.findOrCreate(new RuntimeSessionRecord(runtime, binding.getBindingId(),
                binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        saved = sessions.compareAndSet(saved, saved.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        // The private CSI routes need the JDBC binding store, and every route
        // that checks the ready Session (the publisher install too) reads it
        // first. Its database is unreachable, so every connection attempt
        // fails with a real SQLException that JdbcRepositorySupport reports
        // as a store failure.
        AtomicInteger connections = new AtomicInteger();
        AtomicReference<Exception> outage = new AtomicReference<>();
        javax.sql.DataSource unreachable = (javax.sql.DataSource) Proxy.newProxyInstance(
                RuntimeBrokerHttpServerTest.class.getClassLoader(),
                new Class<?>[] { javax.sql.DataSource.class },
                (proxy, method, args) -> switch (method.getName()) {
                    case "getConnection" -> {
                        connections.incrementAndGet();
                        throw outage.get();
                    }
                    case "hashCode" -> System.identityHashCode(proxy);
                    case "equals" -> proxy == args[0];
                    case "toString" -> "unreachable";
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        FailingTransport transport = new FailingTransport();
        RuntimeBrokerService service = new RuntimeBrokerService(
                id -> CompletableFuture.completedFuture(request.getScope()),
                new StaticRuntimeProvisioner(lease), transport,
                new JdbcRuntimeBindingRepository(unreachable, new AesGcmSecretProtector("test", new byte[32])),
                sessions, new InMemoryToolExecutionRepository(Clock.systemUTC()),
                "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
        // Install the ready Runtime Session the way a completed acquire leaves it.
        var contextClass = Class.forName(RuntimeBrokerService.class.getName() + "$SessionContext");
        var constructor = contextClass.getDeclaredConstructor(RuntimeSession.class, RuntimeBindingRecord.class,
                RuntimeLease.class);
        constructor.setAccessible(true);
        var field = RuntimeBrokerService.class.getDeclaredField("sessions");
        field.setAccessible(true);
        ((Map<String, CompletableFuture<?>>) field.get(service)).put(session,
                CompletableFuture.completedFuture(constructor.newInstance(runtime, binding, lease)));
        try (RuntimeBrokerHttpServer server = new RuntimeBrokerHttpServer(
                new InetSocketAddress("127.0.0.1", 0), "secret", service);
                HttpClient client = HttpClient.newHttpClient()) {
            server.start();
            String digest = "sha256:" + "b".repeat(64);
            Map<String, Object> prepare = new HashMap<>(Map.of(
                    "protocolVersion", 1, "requestId", "prepare", "idempotencyKey", "key",
                    "harnessSessionId", session, "runtimeSessionId", session, "turnId", "turn",
                    "toolCallId", "call", "requestDigest", digest,
                    "reference", Map.of("sessionId", session, "promptId", "turn",
                            "callId", "call", "argsDigest", digest)));
            prepare.put("inputBytesBase64", java.util.Base64.getEncoder().encodeToString(
                    "{}".getBytes(StandardCharsets.UTF_8)));
            prepare.put("toolDefinitionBytesBase64", java.util.Base64.getEncoder().encodeToString(
                    "{\"name\":\"write_file\"}".getBytes(StandardCharsets.UTF_8)));
            Map<String, Object> readBatch = Map.of("protocolVersion", 1, "requestId", "read-batch",
                    "harnessSessionId", session, "runtimeSessionId", session,
                    "promptId", "turn", "batchId", "batch");
            Map<String, Object> publisher = Map.of("protocolVersion", 1, "requestId", "publisher",
                    "harnessSessionId", session, "runtimeSessionId", session,
                    "publisher", Map.of("url", "http://127.0.0.1:1234/internal/hosted-shell-publisher/v1",
                            "token", "a".repeat(43)));
            int attempts = 0;
            // A permanent invariant violation is not a store outage: it keeps
            // the non-retryable 500 on these routes too.
            for (Exception failure : List.<Exception>of(new java.sql.SQLException("simulated outage"),
                    new IllegalStateException("Runtime binding identifier collision"))) {
                outage.set(failure);
                boolean storeOutage = failure instanceof java.sql.SQLException;
                for (Map.Entry<String, Map<String, Object>> route : List.of(
                        Map.entry("/executions:prepare", prepare),
                        Map.entry("/executions:read-batch", readBatch),
                        Map.entry("/tool-sessions/" + session + ":publisher", publisher))) {
                    HttpResponse<String> response = client.send(HttpRequest.newBuilder(server.getBaseUri()
                                    .resolve(RuntimeBrokerHttpServer.ROUTE_PREFIX + route.getKey()))
                            .header("Authorization", "Bearer secret")
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(JSON.toJSONString(route.getValue())))
                            .build(), HttpResponse.BodyHandlers.ofString());
                    assertEquals(storeOutage ? 503 : 500, response.statusCode(), route.getKey() + " " + response.body());
                    var error = JSON.parseObject(response.body());
                    assertEquals(storeOutage ? "runtime_broker_store_unavailable" : "runtime_broker_internal_error",
                            error.getString("code"), route.getKey());
                    assertEquals(storeOutage, error.getBooleanValue("retryable"), route.getKey());
                    // The failure came from the store, not an earlier refusal.
                    assertEquals(++attempts, connections.get(), route.getKey());
                }
            }
            assertSame(saved, sessions.findById(request.getScope(), session));
            assertEquals(0, transport.executions.get());
        }
    }

    @Test
    void startWithAnUnencodablePayloadKeepsItsClientInputMapping() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"write_file\",\"input\":{\"x\":1e309}}";
            String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            HttpResponse<String> reserved = fixture.post("/executions:prepare", Map.of(
                    "protocolVersion", 1, "requestId", "prepare", "idempotencyKey", "key",
                    "harnessSessionId", "harness", "runtimeSessionId", "runtime", "turnId", "turn",
                    "toolCallId", "call", "requestDigest", digest,
                    "reference", Map.of("sessionId", "runtime", "promptId", "turn",
                            "callId", "call", "argsDigest", digest)));
            assertEquals(200, reserved.statusCode(), reserved.body());
            String executionCallId = JSON.parseObject(reserved.body()).getString("executionCallId");
            HttpResponse<String> started = fixture.post("/executions/" + executionCallId + ":start", Map.of(
                    "protocolVersion", 1, "requestId", "start", "harnessSessionId", "harness",
                    "runtimeSessionId", "runtime", "payloadJson", payload));
            assertEquals(400, started.statusCode(), started.body());
            var error = JSON.parseObject(started.body());
            assertEquals("runtime_broker_invalid_request", error.getString("code"));
            assertFalse(error.getBooleanValue("retryable"));
        }
    }

    @Test
    void settledExecutionServesTheFullWireEnvelope() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"write_file\",\"input\":{}}";
            String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
            ToolExecutionRecord record = fixture.service.prepareExecution("harness", "runtime", "key",
                    Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", digest))
                    .toCompletableFuture().join();
            fixture.service.cancelExecution("harness", "runtime", record.getExecutionCallId()).toCompletableFuture().join();
            fixture.service.startExecution("harness", "runtime", record.getExecutionCallId(), payload)
                    .toCompletableFuture().join();
            HttpRequest read = HttpRequest.newBuilder(fixture.uri("/executions/" + record.getExecutionCallId()
                            + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime"))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> settled = fixture.client.send(read, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, settled.statusCode(), settled.body());
            var body = JSON.parseObject(settled.body());
            assertEquals(Set.of("protocolVersion", "harnessSessionId", "runtimeSessionId",
                    "executionCallId", "status", "runtimeBindingId", "bindingGeneration"), body.keySet());
            assertEquals(1, body.getIntValue("protocolVersion"));
            assertEquals("harness", body.getString("harnessSessionId"));
            assertEquals("runtime", body.getString("runtimeSessionId"));
            assertEquals(record.getExecutionCallId(), body.getString("executionCallId"));
            var status = body.getJSONObject("status");
            assertEquals(Set.of("state", "cancelRequested", "lastSeq", "firstAvailableSeq", "progressGap",
                    "progress", "result"), status.keySet());
            assertEquals("settled", status.getString("state"));
            assertEquals("cancelled", status.getJSONObject("result").getString("executionStatus"));
            assertTrue(status.getBooleanValue("cancelRequested"));
            assertEquals(0, status.getLongValue("lastSeq"));
            assertEquals(0, status.getLongValue("firstAvailableSeq"));
            assertFalse(status.getBooleanValue("progressGap"));
            assertEquals(List.of(), status.getJSONArray("progress"));
            assertEquals(0, fixture.transport.executions.get());
        }
    }

    @Test
    void settlesWithProgressSequenceGreaterThanZeroAndPinsTheGapArms() throws Exception {
        try (Fixture fixture = new Fixture()) {
            ToolExecutionRecord prepared = prepareAndAcquire(fixture);
            // Settle at sequence 7 the way runtimes carrying progress do —
            // the production settle paths keep the recorded sequence, so the
            // repository is the honest driver for a non-degenerate record.
            ToolExecutionRecord claimed = fixture.executions.claimDispatch(
                    prepared.getExecutionCallId(), "broker", Duration.ofSeconds(30));
            ToolExecutionRecord settled = fixture.executions.compareAndSet(claimed,
                    claimed.withResult(Map.of("executionStatus", "success"), 7, java.time.Instant.now()),
                    "broker", claimed.getDispatchGeneration());
            org.junit.jupiter.api.Assertions.assertNotNull(settled);
            HttpRequest read = HttpRequest.newBuilder(fixture.uri("/executions/" + prepared.getExecutionCallId()
                            + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime"))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> response = fixture.client.send(read, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, response.statusCode(), response.body());
            var status = JSON.parseObject(response.body()).getJSONObject("status");
            assertEquals("settled", status.getString("state"));
            assertEquals(7, status.getLongValue("lastSeq"));
            assertEquals(7, status.getLongValue("firstAvailableSeq"));
            assertTrue(status.getBooleanValue("progressGap"));
            assertEquals(List.of(), status.getJSONArray("progress"));
            assertEquals("success", status.getJSONObject("result").getString("executionStatus"));
        }
    }

    @Test
    void acceptsAValidProgressCursorAndServesTheFullStatus() throws Exception {
        try (Fixture fixture = new Fixture()) {
            ToolExecutionRecord prepared = prepareAndAcquire(fixture);
            ToolExecutionRecord claimed = fixture.executions.claimDispatch(
                    prepared.getExecutionCallId(), "broker", Duration.ofSeconds(30));
            ToolExecutionRecord settled = fixture.executions.compareAndSet(claimed,
                    claimed.withResult(Map.of("executionStatus", "success"), 1, java.time.Instant.now()),
                    "broker", claimed.getDispatchGeneration());
            org.junit.jupiter.api.Assertions.assertNotNull(settled);
            for (String cursor : new String[] {"0", "5"}) {
                HttpRequest request = HttpRequest.newBuilder(fixture.uri("/executions/" + prepared.getExecutionCallId()
                                + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime&afterSeq=" + cursor))
                        .header("Authorization", "Bearer secret").GET().build();
                HttpResponse<String> response = fixture.client.send(request, HttpResponse.BodyHandlers.ofString());
                assertEquals(200, response.statusCode(), response.body());
                var status = JSON.parseObject(response.body()).getJSONObject("status");
                // The cursor is validated then ignored: the full settled
                // status always comes back.
                assertEquals(Set.of("state", "cancelRequested", "lastSeq", "firstAvailableSeq", "progressGap",
                        "progress", "result"), status.keySet());
                assertEquals(1, status.getLongValue("lastSeq"));
                assertEquals(1, status.getLongValue("firstAvailableSeq"));
                assertTrue(status.getBooleanValue("progressGap"));
                assertEquals(List.of(), status.getJSONArray("progress"));
                assertEquals("success",
                        status.getJSONObject("result").getString("executionStatus"));
            }
        }
    }

    private static ToolExecutionRecord prepareAndAcquire(Fixture fixture) throws Exception {
        String digest = "sha256:" + "b".repeat(64);
        fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
        return fixture.service.prepareExecution("harness", "runtime", "key",
                Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", digest))
                .toCompletableFuture().join();
    }

    @Test
    void rejectsInvalidAfterSeqAndDuplicateQueryFields() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            for (String query : new String[] {"afterSeq=abc", "afterSeq=-1"}) {
                HttpRequest request = HttpRequest.newBuilder(fixture.uri("/executions/call"
                                + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime&" + query))
                        .header("Authorization", "Bearer secret").GET().build();
                HttpResponse<String> response = fixture.client.send(request, HttpResponse.BodyHandlers.ofString());
                assertEquals(400, response.statusCode(), response.body());
                assertTrue(response.body().contains("runtime_broker_invalid_request"), response.body());
                assertTrue(response.body().contains("afterSeq must be a non-negative integer"),
                        response.body());
            }
            HttpRequest duplicate = HttpRequest.newBuilder(fixture.uri("/executions/call"
                            + "?requestId=read&harnessSessionId=harness&runtimeSessionId=runtime&afterSeq=1&afterSeq=2"))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> duplicated = fixture.client.send(duplicate, HttpResponse.BodyHandlers.ofString());
            assertEquals(400, duplicated.statusCode(), duplicated.body());
            assertTrue(duplicated.body().contains("runtime_broker_invalid_request"), duplicated.body());
            assertTrue(duplicated.body().contains("duplicate fields"), duplicated.body());
        }
    }

    @Test
    void rejectsOversizedContentLengthBeforeReadingTheBody() throws Exception {
        try (Fixture fixture = new Fixture()) {
            URI baseUri = fixture.uri("/tool-sessions:acquire");
            try (java.net.Socket socket = new java.net.Socket(
                    baseUri.getHost(), baseUri.getPort())) {
                // Headers only — the body is never sent. The server must
                // reject from Content-Length alone; streaming the 9 MiB body
                // would race the close and abort the socket on Windows.
                byte[] headers = ("POST " + baseUri.getRawPath()
                        + " HTTP/1.1\r\nHost: " + baseUri.getHost() + ":"
                        + baseUri.getPort()
                        + "\r\nAuthorization: Bearer secret"
                        + "\r\nContent-Type: application/json"
                        + "\r\nContent-Length: " + (9 * 1024 * 1024)
                        + "\r\nConnection: close\r\n\r\n")
                        .getBytes(StandardCharsets.UTF_8);
                socket.getOutputStream().write(headers);
                socket.getOutputStream().flush();
                // EOF the write side: the server drains unread request bytes
                // before closing, so it must not wait for the 9 MiB body.
                socket.shutdownOutput();
                socket.setSoTimeout(30_000);
                String response = new String(
                        socket.getInputStream().readAllBytes(),
                        StandardCharsets.UTF_8);
                assertTrue(response.startsWith("HTTP/1.1 413"), response);
                assertTrue(response.contains("runtime_broker_request_too_large"),
                        response);
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
        private final ToolExecutionRepository executions;
        private final RuntimeBrokerService service;
        private final RuntimeBrokerHttpServer server;

        private Fixture() throws Exception {
            this(false);
        }

        private Fixture(boolean v3) throws Exception {
            this(v3, null);
        }

        private Fixture(ToolExecutionRepository executions) throws Exception {
            this(false, null, defaultScope(), executions);
        }

        private Fixture(boolean v3, HarnessSessionResolver resolverOverride)
                throws Exception {
            this(v3, resolverOverride, defaultScope());
        }

        private Fixture(boolean v3, HarnessSessionResolver resolverOverride,
                RuntimeScope scope) throws Exception {
            this(v3, resolverOverride, scope,
                    new InMemoryToolExecutionRepository(Clock.systemUTC()));
        }

        private Fixture(boolean v3, HarnessSessionResolver resolverOverride,
                RuntimeScope scope, ToolExecutionRepository executions)
                throws Exception {
            this.executions = executions;
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
                    resolverOverride != null
                            ? resolverOverride
                            : id -> CompletableFuture.completedFuture(scope),
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

        private static RuntimeScope defaultScope() {
            return new RuntimeScope("tenant", "workspace", "generation",
                    "/workspace", "capability", "workspace");
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
        private final Map<String, CompletionStage<Object>> controlResults =
                new HashMap<>();

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
            CompletionStage<Object> result = controlResults.get(operation.get("kind"));
            if (result != null) {
                return result;
            }
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
