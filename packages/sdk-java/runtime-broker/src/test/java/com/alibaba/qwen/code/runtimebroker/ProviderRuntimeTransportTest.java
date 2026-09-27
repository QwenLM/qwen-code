package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProviderRuntimeTransportTest {
    private static final String HARNESS = "550e8400-e29b-41d4-a716-446655440301";
    private static final String SESSION = "550e8400-e29b-41d4-a716-446655440302";
    private final HttpRuntimeTransport transport = new HttpRuntimeTransport();
    private final RuntimeSession session = new RuntimeSession(HARNESS, SESSION, "bootstrap",
            new RuntimeScope("tenant", "workspace", "1", "/workspace", "capability", "workspace"));
    private final List<Map<String, Object>> requests = new CopyOnWriteArrayList<>();
    private HttpServer server;
    private RuntimeLease lease;
    private volatile Object result = Map.of();
    private volatile UnaryOperator<Map<String, Object>> response = body -> body;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(ProviderRuntimeProtocol.PATH, exchange -> {
            assertEquals("Bearer secret", exchange.getRequestHeaders().getFirst("Authorization"));
            assertEquals("lease", exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Id"));
            assertEquals("3", exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Epoch"));
            Map<String, Object> request = JsonCodec.parseObject(
                    exchange.getRequestBody().readAllBytes(), "request");
            requests.add(request);
            Map<String, Object> operation = ProviderRuntimeProtocol.object(request.get("operation"));
            Object value = "acquire".equals(operation.get("kind")) ? true : result;
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("protocolVersion", 1);
            answer.put("providerProtocol", ProviderRuntimeProtocol.NAME);
            answer.put("session", request.get("session"));
            answer.put("result", value);
            byte[] encoded = JsonCodec.encode(response.apply(answer));
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(200, encoded.length);
            exchange.getResponseBody().write(encoded);
            exchange.close();
        });
        server.start();
        lease = new RuntimeLease("instance", URI.create("http://127.0.0.1:"
                + server.getAddress().getPort()), "secret", "lease", 3);
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void emitsTheSharedPublicControlFixturesWithoutChangingTheirIdentity() throws Exception {
        JsonNode cases = new ObjectMapper().readTree(ManagedRuntimeAttestationConformanceTest
                .contractDirectory().resolve("managed-runtime-provider-v1.fixtures.json").toFile())
                .required("cases");
        Set<String> publicKinds = Set.of("manifest", "history", "begin-turn", "prepare",
                "confirmation", "preflight", "confirm", "bind-history", "checkpoint");
        List<String> exercised = new ArrayList<>();
        for (JsonNode fixture : cases) {
            String kind = fixture.required("request").required("operation").required("kind").asText();
            if (!fixture.required("valid").asBoolean() || !publicKinds.contains(kind)) {
                continue;
            }
            Map<String, Object> expected = JsonCodec.parseObject(fixture.required("request")
                    .toString().getBytes(StandardCharsets.UTF_8), "fixture");
            result = Set.of("begin-turn", "confirm").contains(kind) ? null : Map.of();
            requests.clear();
            Object answer = transport.control(lease, session,
                    ProviderRuntimeProtocol.object(expected.get("operation"))).toCompletableFuture().join();
            assertEquals(result, answer, kind);
            assertEquals(expected, requests.getLast(), kind);
            assertEquals("history".equals(kind) ? 1 : 2, requests.size(), kind);
            if (!"history".equals(kind)) {
                assertEquals(Map.of("kind", "acquire"), requests.getFirst().get("operation"));
            }
            exercised.add(kind);
        }
        assertEquals(publicKinds, Set.copyOf(exercised));
    }

    @Test
    void preparedReferencesExecuteAndObserveOnlyTheProviderProtocol() {
        Map<String, Object> reference = reference();
        result = Map.of("executionStatus", "success", "result", Map.of("llmContent", "done"));
        assertEquals(result, transport.execute(lease, session, reference).toCompletableFuture().join());
        assertEquals(Map.of("kind", "execute", "reference", reference), requests.getLast().get("operation"));
        Object terminal = result;
        result = Map.of("state", "settled", "result", terminal, "cancelRequested", false,
                "lastSeq", 2, "firstAvailableSeq", 1, "progressGap", false, "progress", List.of());
        assertEquals(Map.of("state", "settled", "result", terminal),
                transport.status(lease, session, reference, 1).toCompletableFuture().join());
        assertEquals(Map.of("kind", "status", "reference", reference, "afterSequence", 1),
                requests.getLast().get("operation"));
        result = Map.of("state", "unknown");
        assertEquals(result, transport.cancel(lease, session, reference).toCompletableFuture().join());
        result = true;
        assertTrue(transport.release(lease, session).toCompletableFuture().join());
        assertEquals(4, requests.size());
    }

    @Test
    void refusesResponseIdentityDriftExtraFieldsAndMissingVoidResult() {
        result = true;
        for (String field : List.of("protocolVersion", "providerProtocol", "session", "result", "extra")) {
            response = body -> {
                if (field.equals("extra")) {
                    body.put(field, true);
                } else {
                    body.remove(field);
                }
                return body;
            };
            assertThrows(CompletionException.class,
                    () -> transport.release(lease, session).toCompletableFuture().join(), field);
        }
        response = body -> {
            body.put("session", Map.of("harnessSessionId", HARNESS, "runtimeSessionId", SESSION,
                    "turnKind", "continuation"));
            return body;
        };
        assertThrows(CompletionException.class,
                () -> transport.release(lease, session).toCompletableFuture().join());
    }

    @Test
    void rejectsMalformedStatusAndForeignOrPayloadBearingReferences() {
        for (Object invalid : List.of(Map.of("state", "settled"),
                Map.of("state", "unknown", "result", Map.of()),
                Map.of("state", "executing", "cancelRequested", false, "lastSeq", -1,
                        "firstAvailableSeq", 0, "progressGap", false, "progress", List.of()),
                Map.of("state", "executing", "cancelRequested", false,
                        "lastSeq", new BigDecimal("1.0000000000000000000001"),
                        "firstAvailableSeq", 0, "progressGap", false, "progress", List.of()))) {
            result = invalid;
            assertThrows(CompletionException.class,
                    () -> transport.status(lease, session, reference(), 0).toCompletableFuture().join());
        }
        requests.clear();
        Map<String, Object> invalid = new LinkedHashMap<>(reference());
        invalid.put("sessionId", "550e8400-e29b-41d4-a716-446655440399");
        assertThrows(RuntimeBrokerException.class, () -> transport.execute(lease, session, invalid));
        invalid.put("sessionId", SESSION);
        invalid.put("input", Map.of());
        assertThrows(IllegalArgumentException.class, () -> transport.execute(lease, session, invalid));
        assertTrue(requests.isEmpty());
    }

    @Test
    void rejectsTheSharedMalformedReferencesBeforeTheyCanBeReserved() throws Exception {
        JsonNode cases = new ObjectMapper().readTree(ManagedRuntimeAttestationConformanceTest
                .contractDirectory().resolve("managed-runtime-provider-v1.fixtures.json").toFile())
                .required("cases");
        int rejected = 0;
        for (JsonNode fixture : cases) {
            JsonNode reference = fixture.required("request").required("operation").path("reference");
            if (fixture.required("valid").asBoolean() || reference.isMissingNode()) {
                continue;
            }
            Map<String, Object> malformed = JsonCodec.parseObject(
                    reference.toString().getBytes(StandardCharsets.UTF_8), "reference");
            assertThrows(RuntimeBrokerException.class,
                    () -> ProviderRuntimeProtocol.reference(malformed, SESSION), fixture.required("name").asText());
            rejected++;
        }
        assertEquals(3, rejected);
    }

    @Test
    void doesNotSendAnOversizedControlOrAcceptFalseRelease() {
        Map<String, Object> identity = new LinkedHashMap<>(reference());
        identity.remove("invocationId");
        identity.remove("argsDigest");
        assertThrows(CompletionException.class, () -> transport.control(lease, session, Map.of(
                "kind", "prepare", "identity", identity, "toolName", "write_file",
                "input", Map.of("content", "x".repeat(1024 * 1024)))).toCompletableFuture().join());
        assertEquals(1, requests.size());
        assertEquals(Map.of("kind", "acquire"), requests.getFirst().get("operation"));
        result = false;
        assertThrows(CompletionException.class, () -> transport.release(lease, session).toCompletableFuture().join());
    }

    private static Map<String, Object> reference() {
        return Map.of("sessionId", SESSION, "promptId", "turn-1", "callId", "call-1",
                "capabilityDigest", "a".repeat(64), "policyRevision", "policy-1",
                "invocationId", "invocation-1", "argsDigest", "b".repeat(64));
    }
}
