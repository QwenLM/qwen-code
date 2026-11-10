package com.alibaba.qwen.code.runtimebroker.adapter;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeToolMeasurements;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HttpRuntimeToolV4TransportTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final AtomicReference<Map<String, Object>> response = new AtomicReference<>();
    private final AtomicReference<JsonNode> captured = new AtomicReference<>();
    private final AtomicReference<String> path = new AtomicReference<>();
    private final AtomicReference<String> authorization = new AtomicReference<>();
    private final AtomicReference<String> leaseHeader = new AtomicReference<>();
    private final AtomicInteger requests = new AtomicInteger();
    private final HttpRuntimeTransport transport = new HttpRuntimeTransport();
    private HttpServer server;
    private RuntimeLease lease;

    @BeforeEach
    void startServer() throws Exception {
        response.set(Map.of("protocolVersion", 4, "executionProtocol", 2, "state", "unknown"));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(
                "/",
                exchange -> {
                    requests.incrementAndGet();
                    captured.set(JSON.readTree(exchange.getRequestBody()));
                    path.set(exchange.getRequestURI().getRawPath());
                    authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                    leaseHeader.set(
                            exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Id"));
                    byte[] bytes = JsonCodec.encode(response.get());
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.getResponseHeaders().set("Cache-Control", "no-store");
                    exchange.sendResponseHeaders(200, bytes.length);
                    exchange.getResponseBody().write(bytes);
                    exchange.close();
                });
        server.start();
        lease =
                new RuntimeLease(
                        "measured-runtime",
                        URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                        "measured-token",
                        "measured-lease",
                        2);
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private static RuntimeSession session(String capability) {
        return new RuntimeSession(
                "harness-01",
                "runtime-session-01",
                "bootstrap",
                new RuntimeScope(
                        "tenant-a",
                        "workspace-a",
                        "7",
                        "/runtime/workspace",
                        capability,
                        "session"));
    }

    private static RuntimeSession measuredSession() {
        return session(WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST);
    }

    private static Map<String, Object> reference(int executionProtocol) {
        Map<String, Object> value =
                new LinkedHashMap<>(
                        Map.of(
                                "sessionId",
                                "runtime-session-01",
                                "promptId",
                                "prompt-01",
                                "callId",
                                "call-01",
                                "argsDigest",
                                "a".repeat(64),
                                "resultProtocol",
                                4,
                                "toolName",
                                executionProtocol == 3 ? "run_shell_command" : "read_file",
                                "input",
                                executionProtocol == 3
                                        ? Map.of("command", "printf fixture")
                                        : Map.of("file_path", "fixture.txt")));
        if (executionProtocol == 3) {
            value.put("runtimeProtocol", 3);
        }
        return value;
    }

    private static Map<String, Object> measurements() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("protocol", "managed-tool-measurements/1");
        value.put("executionDurationMs", 7);
        value.put("executionOutcome", "success");
        value.put("file", null);
        return value;
    }

    private static Map<String, Object> measuredReply(
            int protocol, Map<String, Object> result, Map<String, Object> measurements) {
        Map<String, Object> signed = new LinkedHashMap<>();
        signed.put("executionProtocol", protocol);
        signed.put("result", result);
        signed.put("measurements", measurements);
        Map<String, Object> value = new LinkedHashMap<>(signed);
        value.put("protocolVersion", 4);
        value.put("state", "settled");
        value.put("lastSequence", 2);
        value.put(
                "resultDigest",
                DigestUtils.sha256Hex(
                        CsiNativeActivationProof.canonical(JSON.valueToTree(signed))));
        return value;
    }

    private static Map<String, Object> baseResult() {
        return Map.of(
                "executionStatus",
                "success",
                "responseParts",
                List.of(Map.of("type", "text", "text", "fixture")));
    }

    private void assertWire(String operation, int protocol) {
        assertEquals("/internal/managed-runtime/v4/" + operation, path.get());
        assertEquals(4, captured.get().path("protocolVersion").asInt());
        assertEquals(protocol, captured.get().path("executionProtocol").asInt());
        assertEquals(4, captured.get().path("reference").size());
        assertFalse(captured.get().path("reference").has("resultProtocol"));
        assertFalse(captured.get().path("reference").has("runtimeProtocol"));
        assertEquals("Bearer measured-token", authorization.get());
        assertEquals("measured-lease", leaseHeader.get());
    }

    @Test
    void carriesTheSameMeasuredResultThroughExecuteStatusCancelAndDigestAcknowledgement()
            throws Exception {
        var wire = measuredReply(2, baseResult(), measurements());
        response.set(wire);
        var session = measuredSession();
        var reference = reference(2);
        var execute =
                transport
                        .executeV4(lease, session, reference, Map.of(), null)
                        .toCompletableFuture()
                        .get(2, TimeUnit.SECONDS);
        assertWire("execute", 2);
        assertEquals("read_file", captured.get().path("toolName").asText());
        assertEquals("fixture.txt", captured.get().path("input").path("file_path").asText());
        assertEquals("settled", execute.get("state"));
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) execute.get("result");
        assertEquals(baseResult(), RuntimeToolMeasurements.base(result));
        assertEquals(
                wire.get("resultDigest"),
                RuntimeToolMeasurements.metadata(result).get("resultDigest"));
        assertEquals(measurements(), RuntimeToolMeasurements.metadata(result).get("measurements"));
        assertEquals(
                execute,
                transport
                        .statusV4(lease, session, reference, 0)
                        .toCompletableFuture()
                        .get(2, TimeUnit.SECONDS));
        assertWire("status", 2);
        assertEquals(0, captured.get().path("afterSequence").asInt());
        assertEquals(
                execute,
                transport
                        .cancelV4(lease, session, reference)
                        .toCompletableFuture()
                        .get(2, TimeUnit.SECONDS));
        assertWire("cancel", 2);
        response.set(Map.of("protocolVersion", 4, "executionProtocol", 2, "state", "acknowledged"));
        transport
                .acknowledgeV4(lease, session, reference, result, null)
                .toCompletableFuture()
                .get(2, TimeUnit.SECONDS);
        assertWire("acknowledge", 2);
        assertEquals(wire.get("resultDigest"), captured.get().path("resultDigest").asText());
        assertFalse(captured.get().has("input"));
        assertFalse(captured.get().has("receipt"));
        assertEquals(4, requests.get());
    }

    @Test
    void preservesTheSharedCaptureEnvelopeAndForwardsItsExactReceiptWithTheOuterDigest()
            throws Exception {
        JsonNode suite =
                JSON.readTree(
                        VerificationFixtures.moduleRoot()
                                .resolve(
                                        "../core/src/managed-runtime/contracts/managed-tool-result-v1.fixtures.json")
                                .toFile());
        JsonNode envelope = suite.path("envelopeCases").get(0).path("result");
        Map<String, Object> base =
                JsonCodec.parseObject(JSON.writeValueAsBytes(envelope), "capture fixture");
        var wire = measuredReply(3, base, measurements());
        response.set(wire);
        Map<String, Object> capture =
                Map.of(
                        "tenantId",
                        "tenant-a",
                        "sessionId",
                        "harness-01",
                        "turnId",
                        "turn-01",
                        "executionCallId",
                        "execution-01",
                        "bindingGeneration",
                        "1",
                        "capturePolicy",
                        "complete_required");
        var reference = reference(3);
        var execute =
                transport
                        .executeV4(lease, measuredSession(), reference, Map.of(), capture)
                        .toCompletableFuture()
                        .get(2, TimeUnit.SECONDS);
        assertWire("execute", 3);
        assertEquals(JSON.valueToTree(capture), captured.get().path("capture"));
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) execute.get("result");
        assertEquals(envelope, JSON.valueToTree(RuntimeToolMeasurements.base(result)));
        var manifest =
                JsonCodec.parseObject(
                        JSON.writeValueAsBytes(envelope.path("capture").path("manifest")),
                        "manifest");
        var receipt =
                Map.<String, Object>of(
                        "executionCallId",
                        "execution-01",
                        "manifest",
                        manifest,
                        "deliveryStatus",
                        "committed",
                        "historyRevision",
                        7);
        response.set(Map.of("protocolVersion", 4, "executionProtocol", 3, "state", "acknowledged"));
        transport
                .acknowledgeV4(lease, measuredSession(), reference, result, receipt)
                .toCompletableFuture()
                .get(2, TimeUnit.SECONDS);
        assertWire("acknowledge", 3);
        assertEquals(wire.get("resultDigest"), captured.get().path("resultDigest").asText());
        assertEquals(JSON.valueToTree(receipt), captured.get().path("receipt"));
    }

    @Test
    void rejectsCorruptDigestsUnknownFieldsAndProtocolDowngradesWithoutLegacyDispatch()
            throws Exception {
        var wrongDigest = measuredReply(2, baseResult(), measurements());
        wrongDigest.put("resultDigest", "0".repeat(64));
        var unknownField = measuredReply(2, baseResult(), measurements());
        unknownField.put("untrustedPath", "/private/file");
        var privateMeasurement = measurements();
        privateMeasurement.put("filePath", "/private/file");
        var wrongMeasurement = measuredReply(2, baseResult(), privateMeasurement);
        var downgrade =
                Map.<String, Object>of(
                        "protocolVersion", 2, "state", "settled", "result", baseResult());
        for (Map<String, Object> invalid :
                List.of(wrongDigest, unknownField, wrongMeasurement, downgrade)) {
            int before = requests.get();
            response.set(invalid);
            assertThrows(
                    ExecutionException.class,
                    () ->
                            transport
                                    .executeV4(
                                            lease, measuredSession(), reference(2), Map.of(), null)
                                    .toCompletableFuture()
                                    .get(2, TimeUnit.SECONDS));
            assertEquals(before + 1, requests.get());
            assertEquals("/internal/managed-runtime/v4/execute", path.get());
        }
    }

    @Test
    void refusesLegacyProfilesUnreservedProtocolsAndNegativeCursorsBeforeSending() {
        var failure =
                assertThrows(
                        RuntimeBrokerException.class,
                        () ->
                                transport.executeV4(
                                        lease,
                                        session(WorkspaceExecutionProfile.CAPABILITY_DIGEST),
                                        reference(2),
                                        Map.of(),
                                        null));
        assertEquals("runtime_tool_v4_unsupported", failure.getCode());
        var unreserved = reference(2);
        unreserved.remove("resultProtocol");
        assertThrows(
                IllegalArgumentException.class,
                () -> transport.executeV4(lease, measuredSession(), unreserved, Map.of(), null));
        assertThrows(
                IllegalArgumentException.class,
                () -> transport.statusV4(lease, measuredSession(), reference(2), -1));
        assertEquals(0, requests.get());
        assertNull(captured.get());
    }

    @Test
    void keepsMissingMeasurementsExplicitAndRejectsPayloadInAcknowledgedResponses()
            throws Exception {
        var wire = measuredReply(2, baseResult(), null);
        response.set(wire);
        var execute =
                transport
                        .executeV4(lease, measuredSession(), reference(2), Map.of(), null)
                        .toCompletableFuture()
                        .get(2, TimeUnit.SECONDS);
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) execute.get("result");
        assertTrue(RuntimeToolMeasurements.metadata(result).containsKey("measurements"));
        assertNull(RuntimeToolMeasurements.metadata(result).get("measurements"));
        response.set(
                Map.of(
                        "protocolVersion",
                        4,
                        "executionProtocol",
                        2,
                        "state",
                        "acknowledged",
                        "result",
                        baseResult()));
        assertThrows(
                ExecutionException.class,
                () ->
                        transport
                                .acknowledgeV4(lease, measuredSession(), reference(2), result, null)
                                .toCompletableFuture()
                                .get(2, TimeUnit.SECONDS));
    }
}
