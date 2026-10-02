package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import java.util.function.Supplier;
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
    private final List<Headers> headers = new CopyOnWriteArrayList<>();
    private HttpServer server;
    private RuntimeLease lease;
    private volatile int status = 200;
    private volatile String contentType = "application/json";
    private volatile String cacheControl = "no-store";
    private volatile String contentEncoding;
    private volatile Object result = Map.of();
    private volatile Object acquireAnswer = true;
    private volatile UnaryOperator<Map<String, Object>> response = body -> body;
    private volatile byte[] rawBody;
    /** A result spelled out as JSON text, for number forms a map cannot carry. */
    private volatile String rawResult;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(ProviderRuntimeProtocol.PATH, exchange -> {
            // Headers are asserted on the test thread; a failure here only drops the exchange.
            Map<String, Object> request = JsonCodec.parseObject(
                    exchange.getRequestBody().readAllBytes(), "request");
            requests.add(request);
            headers.add(exchange.getRequestHeaders());
            Map<String, Object> operation = ProviderRuntimeProtocol.object(request.get("operation"));
            Object value = "acquire".equals(operation.get("kind")) ? acquireAnswer : result;
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("protocolVersion", 1);
            answer.put("providerProtocol", ProviderRuntimeProtocol.NAME);
            answer.put("session", request.get("session"));
            answer.put("result", value);
            byte[] encoded = rawBody != null ? rawBody : JsonCodec.encode(response.apply(answer));
            if (rawResult != null && !"acquire".equals(operation.get("kind"))) {
                encoded = ("{\"protocolVersion\":1,\"providerProtocol\":\"" + ProviderRuntimeProtocol.NAME
                        + "\",\"session\":" + new String(JsonCodec.encode(request.get("session")),
                                StandardCharsets.UTF_8)
                        + ",\"result\":" + rawResult + "}").getBytes(StandardCharsets.UTF_8);
            }
            exchange.getResponseHeaders().set("Content-Type", contentType);
            exchange.getResponseHeaders().set("Cache-Control", cacheControl);
            if (contentEncoding != null) {
                exchange.getResponseHeaders().set("Content-Encoding", contentEncoding);
            }
            exchange.sendResponseHeaders(status, encoded.length);
            exchange.getResponseBody().write(encoded);
            exchange.close();
        });
        server.start();
        lease = new RuntimeLease("instance", URI.create("http://127.0.0.1:"
                + server.getAddress().getPort()), "secret", "lease", 3);
    }

    @Test
    void rawFileHistoryDoesNotAcquireAProviderSession() {
        result = Map.of("ownerSessionId", HARNESS, "snapshots", List.of(), "files", Map.of());
        Map<String, Object> bind = new LinkedHashMap<>();
        bind.put("kind", "raw-file-history");
        bind.put("action", "bind");
        bind.put("state", null);
        assertEquals(result, transport.control(lease, session, bind).toCompletableFuture().join());
        assertEquals(1, requests.size());
        assertEquals(bind, requests.getFirst().get("operation"));
        Map<String, Object> prepare = Map.of("kind", "raw-file-history", "action", "prepare",
                "promptId", "original-prompt", "paths", List.of("a"));
        assertEquals(result, transport.control(lease, session, prepare).toCompletableFuture().join());
        assertEquals(prepare, requests.getLast().get("operation"));
        assertThrows(RuntimeBrokerException.class, () -> transport.control(lease, session,
                Map.of("kind", "raw-file-history", "action", "prepare", "promptId", "", "paths", List.of("a"))));
        assertThrows(RuntimeBrokerException.class, () -> transport.control(lease, session,
                Map.of("kind", "raw-file-history", "action", "bind", "state", Map.of("ownerSessionId", "other"))));
        assertEquals(2, requests.size());
    }

    @AfterEach
    void stop() {
        server.stop(0);
        // Every request any test sent carried the Broker's credentials.
        for (Headers sent : headers) {
            assertEquals("Bearer secret", sent.getFirst("Authorization"), "Authorization");
            assertEquals("lease", sent.getFirst("X-Qwen-Managed-Lease-Id"), "X-Qwen-Managed-Lease-Id");
            assertEquals("3", sent.getFirst("X-Qwen-Managed-Lease-Epoch"), "X-Qwen-Managed-Lease-Epoch");
        }
    }

    @Test
    void preservesRecognizedProviderErrorReasonsAndStatusWithoutTreatingRefusalAsNotStarted() {
        for (Map.Entry<String, Integer> failure : Map.of(
                "managed_runtime_tool_invalid", 400,
                "managed_runtime_provider_invalid", 400,
                "managed_runtime_identity_conflict", 409,
                "managed_context_unavailable", 409,
                "managed_context_conflict", 409,
                "managed_runtime_provider_operation_failed", 409,
                "managed_runtime_provider_incompatible", 409,
                "managed_runtime_provider_too_large", 413,
                "managed_runtime_provider_unsupported", 501).entrySet()) {
            status = failure.getValue();
            response = body -> Map.of("code", failure.getKey(), "error", "Specific provider reason.");
            CompletionException exception = assertThrows(CompletionException.class,
                    () -> transport.execute(lease, session, reference()).toCompletableFuture().join());
            RuntimeBrokerException error = (RuntimeBrokerException) exception.getCause();
            assertEquals(status, error.getStatusCode());
            assertEquals(failure.getKey(), error.getCode());
            assertEquals("Specific provider reason.", error.getMessage());
            assertEquals(false, error.isRetryable());
        }
    }

    @Test
    void doesNotForwardUnrecognizedOrUntrustedErrorBodies() {
        status = 409;
        for (Map<String, Object> invalid : List.<Map<String, Object>>of(
                Map.of("code", "unknown_code", "error", "private reason"),
                Map.of("code", "managed_runtime_tool_invalid", "error", "wrong status"),
                Map.of("code", "managed_runtime_identity_conflict", "error", "private reason", "extra", true),
                Map.of("code", "managed_runtime_identity_conflict", "error", ""),
                Map.of("code", "managed_runtime_identity_conflict", "error", "x".repeat(4097)),
                Map.of("code", "managed_runtime_identity_conflict", "error", "invalid\0reason"),
                Map.of("code", "managed_runtime_identity_conflict", "error", 123))) {
            response = body -> invalid;
            assertGenericProviderError();
        }
        response = body -> Map.of("code", "managed_runtime_identity_conflict", "error", "private reason");
        contentType = "text/html";
        assertGenericProviderError();
        contentType = "application/json";
        cacheControl = "public";
        assertGenericProviderError();
        cacheControl = "no-store";
        contentEncoding = "gzip";
        assertGenericProviderError();
    }

    private void assertGenericProviderError() {
        CompletionException failure = assertThrows(CompletionException.class,
                () -> transport.release(lease, session).toCompletableFuture().join());
        RuntimeBrokerException error = (RuntimeBrokerException) failure.getCause();
        assertEquals(409, error.getStatusCode());
        assertEquals("managed_runtime_identity_conflict", error.getCode());
        assertEquals("Managed Runtime control request failed (HTTP 409).", error.getMessage());
    }

    @Test
    void emitsTheSharedPublicControlFixturesWithoutChangingTheirIdentity() throws Exception {
        JsonNode corpus = new ObjectMapper().readTree(ManagedRuntimeAttestationConformanceTest
                .contractDirectory().resolve("managed-runtime-provider-v1.fixtures.json").toFile());
        assertEquals(ProviderRuntimeProtocol.NAME, corpus.required("protocol").asText());
        JsonNode cases = corpus.required("cases");
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
    void refusesTransportOnlyOperationsOnThePublicControlShape() throws Exception {
        JsonNode cases = new ObjectMapper().readTree(ManagedRuntimeAttestationConformanceTest
                .contractDirectory().resolve("managed-runtime-provider-v1.fixtures.json").toFile())
                .required("cases");
        Set<String> publicKinds = Set.of("manifest", "history", "begin-turn", "prepare",
                "confirmation", "preflight", "confirm", "bind-history", "checkpoint");
        Set<String> refused = new java.util.HashSet<>();
        for (JsonNode fixture : cases) {
            if (!fixture.required("valid").asBoolean()) {
                continue;
            }
            Map<String, Object> request = JsonCodec.parseObject(fixture.required("request")
                    .toString().getBytes(StandardCharsets.UTF_8), "fixture");
            Map<String, Object> operation = ProviderRuntimeProtocol.object(request.get("operation"));
            String kind = String.valueOf(operation.get("kind"));
            if (!publicKinds.contains(kind)) {
                RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                        () -> ProviderRuntimeProtocol.control(operation, HARNESS, SESSION), kind);
                assertEquals("runtime_control_operation_invalid", error.getCode(), kind);
                refused.add(kind);
            }
        }
        assertEquals(Set.of("acquire", "release", "execute", "status", "cancel"), refused);
    }

    @Test
    void pinsTheRoutePathAndThePerKindSizeTiers() {
        assertEquals("/internal/managed-runtime/provider/v1/control", ProviderRuntimeProtocol.PATH);
        for (String kind : Set.of("bind-history", "checkpoint", "history")) {
            assertEquals(8 * 1024 * 1024, ProviderRuntimeProtocol.limit(kind), kind);
        }
        for (String kind : Set.of("acquire", "release", "manifest", "begin-turn", "prepare",
                "confirmation", "confirm", "preflight", "execute", "status", "cancel")) {
            assertEquals(1024 * 1024, ProviderRuntimeProtocol.limit(kind), kind);
        }
    }

    @Test
    void refusesVoidViolationsMissingResultsAndForeignModificationSources() {
        Map<String, Object> reference = reference();
        // A void control must answer with a null result.
        result = Map.of();
        assertThrows(CompletionException.class, () -> transport.control(lease, session,
                Map.of("kind", "confirm", "reference", reference, "outcome", "proceed_once"))
                .toCompletableFuture().join());
        // A result-bearing control must answer with an object.
        result = null;
        assertThrows(CompletionException.class, () -> transport.control(lease, session,
                Map.of("kind", "manifest")).toCompletableFuture().join());
        // A content modification cannot cite another Session's invocation.
        Map<String, Object> identity = new LinkedHashMap<>(reference);
        identity.remove("invocationId");
        identity.remove("argsDigest");
        Map<String, Object> foreign = new LinkedHashMap<>(reference);
        foreign.put("sessionId", HARNESS);
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ProviderRuntimeProtocol.control(Map.of("kind", "prepare", "identity", identity,
                        "toolName", "edit", "input", Map.of(), "modification",
                        Map.of("source", foreign, "newContent", "next")), HARNESS, SESSION));
        assertEquals("runtime_control_operation_invalid", error.getCode());
        // A confirm outcome outside the accepted set and a non-boolean modality
        // are refused before anything is sent.
        assertThrows(RuntimeBrokerException.class,
                () -> ProviderRuntimeProtocol.control(Map.of("kind", "confirm", "reference",
                        reference, "outcome", "restore_previous"), HARNESS, SESSION));
        assertThrows(RuntimeBrokerException.class,
                () -> ProviderRuntimeProtocol.control(Map.of("kind", "prepare", "identity",
                        identity, "toolName", "read_file", "input", Map.of(), "mediaContext",
                        Map.of("inputModalities", Map.of("image", "yes"))), HARNESS, SESSION));
    }

    @Test
    void refusesAControlWhenTheAcquirePreludeIsNotConfirmed() {
        acquireAnswer = false;
        assertThrows(CompletionException.class, () -> transport.control(lease, session,
                Map.of("kind", "manifest")).toCompletableFuture().join());
        assertEquals(1, requests.size());
        assertEquals(Map.of("kind", "acquire"), requests.getFirst().get("operation"));
    }

    @Test
    void answersOversizedControlsWithADefinitive413() {
        Map<String, Object> identity = new LinkedHashMap<>(reference());
        identity.remove("invocationId");
        identity.remove("argsDigest");
        CompletionException failure = assertThrows(CompletionException.class,
                () -> transport.control(lease, session, Map.of("kind", "prepare",
                        "identity", identity, "toolName", "write_file",
                        "input", Map.of("content", "x".repeat(2 * 1024 * 1024))))
                        .toCompletableFuture().join());
        RuntimeBrokerException error = (RuntimeBrokerException) failure.getCause();
        assertEquals(413, error.getStatusCode());
        assertEquals("runtime_control_operation_too_large", error.getCode());
        assertEquals(false, error.isRetryable());
        // Only the acquire prelude went out; the oversized operation never did.
        assertEquals(1, requests.size());
        assertEquals(Map.of("kind", "acquire"), requests.getFirst().get("operation"));
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
        assertEquals(4, headers.size());
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
        // Every status but the unknown one carries a valid cursor set apart
        // from the single field under test.
        for (Object invalid : List.of(
                Map.of("state", "settled", "cancelRequested", false, "lastSeq", 1,
                        "firstAvailableSeq", 0, "progressGap", false, "progress", List.of()),
                Map.of("state", "unknown", "result", Map.of()),
                Map.of("state", "executing", "cancelRequested", false, "lastSeq", -1,
                        "firstAvailableSeq", 0, "progressGap", false, "progress", List.of()),
                Map.of("state", "executing", "cancelRequested", false,
                        "lastSeq", new BigDecimal("1.0000000000000000000001"),
                        "firstAvailableSeq", 0, "progressGap", false, "progress", List.of()),
                Map.of("state", "executing", "cancelRequested", "no", "lastSeq", 1,
                        "firstAvailableSeq", 0, "progressGap", false, "progress", List.of()),
                Map.of("state", "executing", "cancelRequested", false, "lastSeq", 1,
                        "firstAvailableSeq", 0, "progressGap", "no", "progress", List.of()),
                Map.of("state", "executing", "cancelRequested", false, "lastSeq", 1,
                        "firstAvailableSeq", 0, "progressGap", false, "progress", "none"),
                Map.of("state", "executing", "cancelRequested", false, "lastSeq", 1,
                        "firstAvailableSeq", -1, "progressGap", false, "progress", List.of()))) {
            result = invalid;
            assertAttestationInvalid(() -> transport.status(lease, session, reference(), 0), invalid);
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
    void refusesMalformedProviderResultsWhetherExecutedOrObserved() {
        for (Map<String, Object> invalid : List.<Map<String, Object>>of(
                Map.of("executionStatus", "success"),
                Map.of("result", Map.of()),
                Map.of("executionStatus", "banana"),
                Map.of("executionStatus", "success", "result", Map.of(), "extra", 1))) {
            result = invalid;
            assertAttestationInvalid(() -> transport.execute(lease, session, reference()), invalid);
            result = Map.of("state", "settled", "result", invalid, "cancelRequested", false,
                    "lastSeq", 1, "firstAvailableSeq", 0, "progressGap", false, "progress", List.of());
            assertAttestationInvalid(() -> transport.status(lease, session, reference(), 0), invalid);
        }
    }

    @Test
    void refusesAProviderAnswerThatIsNotAJsonObjectAsAPermanentFailure() {
        // A gateway page and an array fail to parse; a JSON null parses to nothing.
        for (String body : List.of("<html>Bad Gateway</html>", "[]", "null")) {
            rawBody = body.getBytes(StandardCharsets.UTF_8);
            assertAttestationInvalid(() -> transport.execute(lease, session, reference()), body);
        }
    }

    @Test
    void refusesProviderStatusCursorsThatAreNotSafeExactIntegers() {
        // The first three coerce to Short 4, Byte 4 and Double 1.0;
        // the fourth exceeds JavaScript's safe integer ceiling.
        for (String cursor : List.of("65540S", "260B", "1.0000000000000001D", "9007199254740992")) {
            rawResult = "{\"state\":\"executing\",\"cancelRequested\":false,\"lastSeq\":" + cursor
                    + ",\"firstAvailableSeq\":0,\"progressGap\":false,\"progress\":[]}";
            assertAttestationInvalid(() -> transport.status(lease, session, reference(), 0), cursor);
        }
        rawResult = "{\"state\":\"executing\",\"cancelRequested\":false,\"lastSeq\":9007199254740991"
                + ",\"firstAvailableSeq\":9007199254740992,\"progressGap\":false,\"progress\":[]}";
        assertAttestationInvalid(() -> transport.status(lease, session, reference(), 0), "firstAvailableSeq");
        rawResult = "{\"state\":\"executing\",\"cancelRequested\":false,\"lastSeq\":9007199254740991"
                + ",\"firstAvailableSeq\":9007199254740991,\"progressGap\":false,\"progress\":[]}";
        assertEquals("executing", assertDoesNotThrow(() -> transport.status(lease, session, reference(), 0)
                .toCompletableFuture().join()).get("state"));
        rawResult = "{\"state\":\"executing\",\"cancelRequested\":false,\"lastSeq\":4"
                + ",\"firstAvailableSeq\":0,\"progressGap\":false,\"progress\":[]}";
        assertEquals("executing", transport.status(lease, session, reference(), 0)
                .toCompletableFuture().join().get("state"));
    }

    @Test
    void acceptsUppercaseSessionUuidInProviderControlIdentity() {
        String uppercase = SESSION.toUpperCase(Locale.ROOT);
        Map<String, Object> reference = new LinkedHashMap<>(reference());
        reference.put("sessionId", uppercase);
        assertDoesNotThrow(() -> ProviderRuntimeProtocol.control(
                Map.of("kind", "preflight", "reference", reference), HARNESS, uppercase));
    }

    @Test
    void refusesAnUnpairedSurrogateAnywhereInAControl() {
        // The JSON writer would send one as '?', which a shell reads as a wildcard.
        Map<String, Object> identity = new LinkedHashMap<>(reference());
        identity.remove("invocationId");
        identity.remove("argsDigest");
        List<Function<String, Map<String, Object>>> operations = List.of(
                text -> Map.of("kind", "prepare", "identity", identity, "toolName",
                        "run_shell_command", "input", Map.of("command", "rm /tmp/a" + text + "b")),
                text -> Map.of("kind", "prepare", "identity", identity, "toolName",
                        "run_shell_command", "input", Map.of("command", "ls", "k" + text, "v")),
                text -> Map.of("kind", "prepare", "identity", identity, "toolName", "edit",
                        "input", Map.of(), "modification",
                        Map.of("source", reference(), "newContent", "next" + text)),
                text -> Map.of("kind", "confirm", "reference", reference(), "outcome",
                        "proceed_once", "payload", Map.of("updatedInput",
                                Map.of("command", "ls " + text))),
                text -> Map.of("kind", "bind-history", "binding", Map.of("ownerSessionId",
                        HARNESS, "ownerRuntimeSessionId", SESSION, "executionCwd",
                        "/work/" + text, "snapshots", List.of())));
        for (Function<String, Map<String, Object>> operation : operations) {
            // Well-formed, the same operation passes.
            ProviderRuntimeProtocol.control(operation.apply("x"), HARNESS, SESSION);
            for (String surrogate : List.of("\uD800", "\uDC00")) {
                RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                        () -> transport.control(lease, session, operation.apply(surrogate)));
                assertEquals("runtime_control_operation_invalid", error.getCode());
            }
        }
        assertTrue(requests.isEmpty());
    }

    private static void assertAttestationInvalid(Supplier<CompletionStage<?>> call, Object label) {
        CompletionException failure = assertThrows(CompletionException.class,
                () -> call.get().toCompletableFuture().join(), String.valueOf(label));
        RuntimeBrokerException error = assertInstanceOf(RuntimeBrokerException.class,
                failure.getCause(), String.valueOf(label));
        assertEquals(400, error.getStatusCode(), String.valueOf(label));
        assertEquals("managed_runtime_attestation_invalid", error.getCode(), String.valueOf(label));
        assertFalse(error.isRetryable(), String.valueOf(label));
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
