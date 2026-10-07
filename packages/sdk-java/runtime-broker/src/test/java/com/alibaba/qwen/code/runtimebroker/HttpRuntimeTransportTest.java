package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
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
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;

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
    void admitsOnlyTheExactV3AttestationAndInstallationReceipt() throws Exception {
        RuntimeProvisionRequest request = ManagedContextProtocolTest.request();
        RuntimeProvisionSeed seed = ManagedContextProtocolTest.seed();
        RuntimeLease lease = contextLease(seed);
        Map<String, Object> boot = ManagedContextProtocol.boot(request, seed);
        Map<String, Object> proof = ManagedContextProtocol.attestationResponse(boot);
        reply.set(json(200, JsonCodec.encode(proof)));
        assertEquals(request.getStorageId(), transport.attest(lease, request, seed)
                .toCompletableFuture().get(2, TimeUnit.SECONDS).getStorageId());
        assertEquals(ManagedContextProtocol.ATTEST_PATH, capturedPath.get());
        assertEquals(JSON.valueToTree(ManagedContextProtocol.attestationRequest(boot)),
                JSON.readTree(captured.get()));
        for (String field : proof.keySet()) {
            Map<String, Object> wrong = new LinkedHashMap<>(proof);
            wrong.remove(field);
            reply.set(json(200, JsonCodec.encode(wrong)));
            assertThrows(ExecutionException.class, () -> transport.attest(lease, request, seed)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS), field);
        }
        var binding = ManagedContextProtocolTest.binding();
        RuntimeBindingRecord runtime = ready(request, seed, lease);
        RuntimeSessionRecord session = on(runtime, session("会话-𝄞", request));
        Map<String, Object> receipt = ManagedContextProtocol.receipt(seed, "op-1", "会话-𝄞", binding);
        reply.set(json(200, JsonCodec.encode(receipt)));
        assertTrue(BrokerValues.sameJsonMap(receipt, transport.installContext(runtime, session,
                "op-1", binding).toCompletableFuture().get(2, TimeUnit.SECONDS)));
        assertEquals(ManagedContextProtocol.CONTEXT_PATH, capturedPath.get());
        assertEquals("会话-𝄞", JSON.readTree(captured.get()).required("sessionId").asText());
        for (String field : receipt.keySet()) {
            Map<String, Object> wrong = new LinkedHashMap<>(receipt);
            wrong.put(field, receipt.get(field) instanceof Number
                    ? new BigDecimal("4.0000000000000000001") : "wrong");
            reply.set(json(200, JsonCodec.encode(wrong)));
            assertThrows(ExecutionException.class, () -> transport.installContext(runtime, session,
                    "op-1", binding).toCompletableFuture().get(2, TimeUnit.SECONDS), field);
        }
        Map<String, Object> extra = new LinkedHashMap<>(receipt);
        extra.put("unexpected", true);
        reply.set(json(200, JsonCodec.encode(extra)));
        assertThrows(ExecutionException.class, () -> transport.installContext(runtime, session,
                "op-1", binding).toCompletableFuture().get(2, TimeUnit.SECONDS));
    }

    @Test
    void contextClientBoundsBodiesRejectsOldPeersAndPreservesSessionRefusals() throws Exception {
        RuntimeProvisionRequest request = ManagedContextProtocolTest.request();
        RuntimeProvisionSeed seed = ManagedContextProtocolTest.seed();
        RuntimeLease lease = contextLease(seed);
        RuntimeBindingRecord runtime = ready(request, seed, lease);
        RuntimeSessionRecord session = on(runtime, session("session", request));
        for (String code : List.of("managed_context_unavailable", "managed_context_conflict")) {
            reply.set(json(409, JsonCodec.encode(Map.of("code", code, "error", "private detail"))));
            ExecutionException error = assertThrows(ExecutionException.class, () -> transport
                    .installContext(runtime, session, "op", ManagedContextProtocolTest.binding())
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            RuntimeBrokerException failure = (RuntimeBrokerException) error.getCause();
            assertEquals(code, failure.getCode());
            assertFalse(failure.isRetryable());
            assertFalse(failure.getMessage().contains("private detail"));
        }
        for (int status : List.of(404, 405)) {
            reply.set(json(status, "{}".getBytes(StandardCharsets.UTF_8)));
            ExecutionException error = assertThrows(ExecutionException.class, () -> transport
                    .attest(lease, request, seed).toCompletableFuture().get(2, TimeUnit.SECONDS));
            assertEquals("managed_runtime_incompatible", ((RuntimeBrokerException) error.getCause()).getCode());
            assertEquals(ManagedContextProtocol.ATTEST_PATH, capturedPath.get());
        }
        reply.set(json(200, new byte[HttpRuntimeTransport.BODY_LIMIT_BYTES + 1]));
        ExecutionException error = assertThrows(ExecutionException.class, () -> transport.installContext(
                runtime, session, "op", ManagedContextProtocolTest.binding())
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        assertEquals(413, ((RuntimeBrokerException) error.getCause()).getStatusCode());
        assertThrows(IllegalArgumentException.class, () -> ManagedContextProtocol.installation(
                request, "op", "bad\ud800", ManagedContextProtocolTest.binding()));
    }

    @Test
    void installsOnlyOnTheReadyRuntimeOfTheSessionsPlacement() throws Exception {
        RuntimeProvisionRequest request = ManagedContextProtocolTest.request();
        RuntimeProvisionSeed seed = ManagedContextProtocolTest.seed();
        RuntimeLease lease = contextLease(seed);
        RuntimeScope other = new RuntimeScope("tenant-a", "workspace-b", "7",
                "/runtime/workspaces/workspace-b", request.getScope().getCapabilityDigest(),
                "workspace");
        RuntimeScope isolated = new RuntimeScope("tenant-a", "workspace-a", "7",
                request.getScope().getCanonicalCwd(), request.getScope().getCapabilityDigest(),
                "session");
        RuntimeProvisionRequest harnessB = new RuntimeProvisionRequest(isolated, "harness-b",
                request.getProvisionerKind(), request.getStorageId());
        RuntimeBindingRecord runtime = ready(request, seed, lease);
        RuntimeSession session = session("session", request);
        var binding = ManagedContextProtocolTest.binding();
        RuntimeScope otherRoot = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspaces/other-root", request.getScope().getCapabilityDigest(),
                "workspace");
        RuntimeBindingRecord otherRootRuntime = ready(new RuntimeProvisionRequest(otherRoot, null,
                request.getProvisionerKind(), request.getStorageId()), seed, lease);
        RuntimeBindingRecord otherRuntime = ready(new RuntimeProvisionRequest(other, null,
                request.getProvisionerKind(), request.getStorageId()), seed, lease);
        RuntimeBindingRecord harnessBRuntime = ready(harnessB, seed, lease);
        RuntimeSession isolatedSession = new RuntimeSession("harness", "session", "bootstrap",
                isolated);
        List<Runnable> refused = List.of(
                // Another binding of the same placement, as when two storages
                // serve one scope, and this binding at a later generation.
                () -> transport.installContext(runtime, new RuntimeSessionRecord(session,
                        "binding-2", runtime.getGeneration(), RuntimeSessionRecord.State.READY, 0,
                        Instant.now()), "op", binding),
                () -> transport.installContext(runtime, new RuntimeSessionRecord(session,
                        runtime.getBindingId(), runtime.getGeneration() + 1,
                        RuntimeSessionRecord.State.READY, 0, Instant.now()), "op", binding),
                // The same Workspace and storage mounted at another root, which
                // only the placement check can tell apart.
                () -> transport.installContext(otherRootRuntime, on(otherRootRuntime, session),
                        "op", binding),
                // The Runtime of another Workspace.
                () -> transport.installContext(otherRuntime, on(otherRuntime, session), "op",
                        binding),
                // Under session isolation, the Runtime of another Harness Session.
                () -> transport.installContext(harnessBRuntime,
                        on(harnessBRuntime, isolatedSession), "op", binding),
                // A binding that keeps its lease but no longer serves.
                () -> transport.installContext(runtime.withState(
                        RuntimeBindingRecord.State.RECOVERY_BLOCKED, lease, Instant.now()),
                        on(runtime, session), "op", binding),
                () -> transport.installContext(runtime.withState(
                        RuntimeBindingRecord.State.LOST, lease, Instant.now()),
                        on(runtime, session), "op", binding),
                // A READY binding asked to drain admits no new Session.
                () -> transport.installContext(runtime.withDrainRequested(true,
                        Instant.now()), on(runtime, session), "op", binding));
        captured.set(null);
        for (Runnable call : refused) {
            assertEquals("session must belong to a READY Runtime binding",
                    assertThrows(IllegalArgumentException.class, call::run).getMessage());
        }
        // A Session on its way out of the binding it names.
        for (RuntimeSessionRecord.State state : List.of(RuntimeSessionRecord.State.RELEASING,
                RuntimeSessionRecord.State.RELEASED, RuntimeSessionRecord.State.FAILED)) {
            assertEquals("session must be acquiring or ready",
                    assertThrows(IllegalArgumentException.class, () -> transport.installContext(
                            runtime, on(runtime, session).withState(state, Instant.now()),
                            "op", binding)).getMessage(), state.name());
        }
        assertNull(captured.get());
        // Acquisition installs while the Session is still ACQUIRING.
        Map<String, Object> acquiring = ManagedContextProtocol.receipt(seed, "op", "session",
                binding);
        reply.set(json(200, JsonCodec.encode(acquiring)));
        assertTrue(BrokerValues.sameJsonMap(acquiring, transport.installContext(runtime,
                on(runtime, session).withState(RuntimeSessionRecord.State.ACQUIRING,
                        Instant.now()), "op", binding)
                .toCompletableFuture().get(2, TimeUnit.SECONDS)));
        assertEquals(ManagedContextProtocol.CONTEXT_PATH, capturedPath.get());
        captured.set(null);
        // Under session isolation, the Runtime of the Session's own Harness
        // Session installs.
        RuntimeBindingRecord harnessARuntime = ready(new RuntimeProvisionRequest(isolated,
                "harness", request.getProvisionerKind(), request.getStorageId()), seed, lease);
        Map<String, Object> receipt = ManagedContextProtocol.receipt(seed, "op", "session", binding);
        reply.set(json(200, JsonCodec.encode(receipt)));
        assertTrue(BrokerValues.sameJsonMap(receipt, transport.installContext(harnessARuntime,
                on(harnessARuntime, isolatedSession), "op", binding)
                .toCompletableFuture().get(2, TimeUnit.SECONDS)));
        assertEquals(ManagedContextProtocol.CONTEXT_PATH, capturedPath.get());
    }

    @Test
    void refusesReferenceIdsThatTheWriterWouldChange() {
        RuntimeScope scope = ManagedContextProtocolTest.request().getScope();
        RuntimeLease lease = contextLease(ManagedContextProtocolTest.seed());
        RuntimeSession session = session("session", ManagedContextProtocolTest.request());
        captured.set(null);
        // A lone high and a lone low surrogate: the writer sends each as '?'.
        for (String surrogate : List.of("\ud800", "\udc00")) {
            for (String field : List.of("sessionId", "promptId", "callId", "argsDigest")) {
                Map<String, Object> reference = new LinkedHashMap<>(Map.of("sessionId",
                        "session", "promptId", "prompt", "callId", "call", "argsDigest",
                        "digest", "toolName", "read_file", "input", Map.of()));
                reference.put(field, "p" + surrogate);
                assertThrows(IllegalArgumentException.class,
                        () -> transport.execute(lease, session, reference), field);
                assertThrows(IllegalArgumentException.class,
                        () -> transport.status(lease, session, reference, 0), field);
                assertThrows(IllegalArgumentException.class,
                        () -> transport.cancel(lease, session, reference), field);
            }
            // The Worker would run the rewritten tool name or input.
            List<Map<String, Object>> calls = List.of(
                    Map.of("toolName", "read" + surrogate),
                    Map.of("input", Map.of("command", "rm file" + surrogate)),
                    Map.of("input", Map.of("path" + surrogate, "a")),
                    Map.of("input", Map.of("nested", List.of(Map.of("args",
                            List.of("x", "y" + surrogate))))),
                    // Not JSON, though the writer would serialize it.
                    Map.of("input", Map.of("command", new String[] {"rm file" + surrogate})));
            for (Map<String, Object> call : calls) {
                Map<String, Object> reference = new LinkedHashMap<>(Map.of("sessionId",
                        "session", "promptId", "prompt", "callId", "call", "argsDigest",
                        "digest", "toolName", "read_file", "input", Map.of()));
                reference.putAll(call);
                assertThrows(IllegalArgumentException.class,
                        () -> transport.execute(lease, session, reference), call.toString());
                assertThrows(IllegalArgumentException.class,
                        () -> transport.executeV3(lease, session, reference, Map.of(
                                "tenantId", "tenant", "sessionId", "harness", "turnId", "prompt",
                                "executionCallId", "execution", "bindingGeneration", "1",
                                "capturePolicy", "complete_required")), call.toString());
            }
        }
        assertNull(captured.get());
        for (String surrogate : List.of("\ud800", "\udc00")) {
            assertThrows(IllegalArgumentException.class,
                    () -> new RuntimeSession("harness", "s" + surrogate, "bootstrap", scope));
        }
    }

    @Test
    void validatesEveryActivationReceiptFieldAndRefusesOlderWorkers() throws Exception {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope, "harness", "local-process", "storage");
        RuntimeProvisionSeed seed = ManagedContextProtocolTest.seed();
        RuntimeBindingRecord runtime = ready(request, seed, contextLease(seed));
        RuntimeSessionRecord session = on(runtime, session("session", request));
        var binding = new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                "tenant", "workspace", 1, "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        for (boolean active : new boolean[] {true, false}) {
            Map<String, Object> receipt = new LinkedHashMap<>();
            receipt.put("protocolVersion", 1);
            receipt.put("operation", active ? "activate" : "release");
            receipt.put("sessionId", "session");
            receipt.put("contextDigest", binding.getContextDigest());
            receipt.put("contextConfigRef", binding.getContextConfigRef());
            receipt.put("profile", WorkspaceExecutionProfile.PROFILE);
            receipt.put("runtimeInstanceId", seed.getProvisionalRuntimeId());
            receipt.put("runtimeIncarnation", seed.getGatewayIncarnation());
            receipt.put("epoch", seed.getEpoch());
            receipt.put("active", active);
            reply.set(json(200, JsonCodec.encode(receipt)));
            transport.activateWorkspace(runtime, session, binding, active).toCompletableFuture().get(2, TimeUnit.SECONDS);
            assertEquals("/internal/managed-runtime/v3/activation", capturedPath.get());
            assertEquals(active ? "activate" : "release", JSON.readTree(captured.get()).get("operation").asText());
            for (String field : receipt.keySet()) {
                Map<String, Object> invalid = new LinkedHashMap<>(receipt);
                invalid.put(field, "foreign");
                reply.set(json(200, JsonCodec.encode(invalid)));
                assertThrows(ExecutionException.class, () -> transport.activateWorkspace(runtime, session, binding, active)
                        .toCompletableFuture().get(2, TimeUnit.SECONDS), field);
            }
            receipt.put("extra", true);
            reply.set(json(200, JsonCodec.encode(receipt)));
            assertThrows(ExecutionException.class, () -> transport.activateWorkspace(runtime, session, binding, active)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
        }
        reply.set(json(404, "{}".getBytes(StandardCharsets.UTF_8)));
        assertThrows(ExecutionException.class, () -> transport.activateWorkspace(runtime, session, binding, true)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        for (RuntimeSessionRecord foreign : List.of(
                new RuntimeSessionRecord(session.getSession(), "foreign", runtime.getGeneration(),
                        RuntimeSessionRecord.State.READY, 0, Instant.now()),
                new RuntimeSessionRecord(session.getSession(), runtime.getBindingId(), runtime.getGeneration() + 1,
                        RuntimeSessionRecord.State.READY, 0, Instant.now()))) {
            assertThrows(IllegalArgumentException.class,
                    () -> transport.activateWorkspace(runtime, foreign, binding, true));
        }
    }

    /** A READY durable binding whose Runtime holds this lease. */
    private static RuntimeBindingRecord ready(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeLease lease) {
        Instant now = Instant.now();
        return new RuntimeBindingRecord("binding-1", request, seed, 1,
                RuntimeBindingRecord.State.READY, lease,
                new RuntimeResourceHandle("local-process", 1, Map.of("provider", "local-process")),
                1, false, null, null, 0, 0, now, now, now);
    }

    private static RuntimeSession session(String id, RuntimeProvisionRequest request) {
        return new RuntimeSession("harness", id, "bootstrap", request.getScope());
    }

    /** The Session as acquired on this binding at its generation. */
    private static RuntimeSessionRecord on(RuntimeBindingRecord runtime, RuntimeSession session) {
        return new RuntimeSessionRecord(session, runtime.getBindingId(), runtime.getGeneration(),
                RuntimeSessionRecord.State.READY, 0, Instant.now());
    }

    private RuntimeLease contextLease(RuntimeProvisionSeed seed) {
        return new RuntimeLease(seed.getProvisionalRuntimeId(),
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
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
    void installsOnlyCanonicalLoopbackPublishersWithAnExactReceipt() throws Exception {
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> publisher = Map.of("url", "http://127.0.0.1:1234/internal/hosted-shell-publisher/v1",
                "token", "a".repeat(43));
        Map<String, Object> receipt = Map.of("protocolVersion", 3, "toolResult", "managed-tool-result/1",
                "sessionId", session.getRuntimeSessionId(), "installed", true);
        reply.set(json(200, JsonCodec.encode(receipt)));
        transport.installPublisherV3(lease, session, publisher).toCompletableFuture().get(2, TimeUnit.SECONDS);
        assertEquals("/internal/managed-runtime/v3/publisher", capturedPath.get());
        assertEquals(JSON.valueToTree(publisher), JSON.readTree(captured.get()).required("publisher"));
        for (String url : List.of("http://localhost:1234/internal/hosted-shell-publisher/v1",
                "http://127.0.0.1:65536/internal/hosted-shell-publisher/v1",
                "http://127.0.0.1:1234/internal/hosted-shell-publisher/v1?redirect=evil")) {
            assertThrows(IllegalArgumentException.class, () -> transport.installPublisherV3(lease, session,
                    Map.of("url", url, "token", "a".repeat(43))));
        }
        Map<String, Object> foreign = new LinkedHashMap<>(receipt);
        foreign.put("sessionId", "another-session");
        reply.set(json(200, JsonCodec.encode(foreign)));
        assertThrows(ExecutionException.class,
                () -> transport.installPublisherV3(lease, session, publisher).toCompletableFuture().get(2, TimeUnit.SECONDS));
    }

    @Test
    void usesExplicitToolV3RoutesAndRejectsAV2Answer() throws Exception {
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> reference = toolReference();
        reference.put("toolName", "run_shell_command");
        reference.put("input", Map.of("command", "printf hello"));
        Map<String, Object> capture = new LinkedHashMap<>();
        capture.put("tenantId", "tenant-a");
        capture.put("sessionId", "managed-session-a");
        capture.put("turnId", "prompt-01");
        capture.put("executionCallId", "execution-a");
        capture.put("bindingGeneration", "1");
        capture.put("capturePolicy", "complete_required");
        Map<String, Object> capturedResult = new LinkedHashMap<>();
        capturedResult.put("captureStatus", "unavailable");
        capturedResult.put("captureReason", "storage_failed");
        capturedResult.put("manifest", null);
        capturedResult.put("previewTruncated", false);
        capturedResult.put("deliveryStatus", "blocked");
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("executionStatus", "success");
        envelope.put("responseParts", List.of("hello"));
        envelope.put("capture", capturedResult);
        Map<String, Object> settled = Map.of(
                "protocolVersion", 3,
                "toolResult", "managed-tool-result/1",
                "state", "settled",
                "result", envelope);
        reply.set(json(200, JSON.writeValueAsBytes(settled)));

        assertEquals("settled", transport.executeV3(lease, session, reference,
                capture).toCompletableFuture().get(2, TimeUnit.SECONDS).get("state"));
        assertEquals(HttpRuntimeTransport.V3_EXECUTE_PATH, capturedPath.get());
        assertEquals("managed-tool-result/1", JSON.readTree(captured.get())
                .required("toolResult").asText());
        assertEquals("managed-session-a", JSON.readTree(captured.get())
                .required("capture").required("sessionId").asText());

        assertEquals("settled", transport.statusV3(lease, session, reference, 0)
                .toCompletableFuture().get(2, TimeUnit.SECONDS).get("state"));
        assertEquals(HttpRuntimeTransport.V3_STATUS_PATH, capturedPath.get());
        assertEquals("settled", transport.cancelV3(lease, session, reference)
                .toCompletableFuture().get(2, TimeUnit.SECONDS).get("state"));
        assertEquals(HttpRuntimeTransport.V3_CANCEL_PATH, capturedPath.get());
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("executionCallId", "execution-a");
        receipt.put("manifest", null);
        receipt.put("deliveryStatus", "blocked");
        receipt.put("historyRevision", null);
        assertEquals("settled", transport.acknowledgeV3(lease, session,
                reference, receipt).toCompletableFuture()
                .get(2, TimeUnit.SECONDS).get("state"));
        assertEquals(HttpRuntimeTransport.V3_ACKNOWLEDGE_PATH,
                capturedPath.get());
        assertEquals("blocked", JSON.readTree(captured.get())
                .required("receipt").required("deliveryStatus").asText());

        reply.set(json(200, JsonCodec.encode(Map.of(
                "protocolVersion", 2,
                "state", "unknown"))));
        assertThrows(ExecutionException.class, () -> transport.statusV3(
                lease, session, reference, 0).toCompletableFuture()
                .get(2, TimeUnit.SECONDS));

        reply.set(json(501, JsonCodec.encode(Map.of("code", "unsupported"))));
        for (CompletionStage<Map<String, Object>> call : List.of(
                transport.executeV3(lease, session, reference,
                        Map.of("toolName", "run_shell_command", "input", Map.of("command", "printf hello")),
                        capture),
                transport.statusV3(lease, session, reference, 0))) {
            CompletionException thrown = assertThrows(CompletionException.class,
                    () -> call.toCompletableFuture().join());
            RuntimeBrokerException failure = assertInstanceOf(RuntimeBrokerException.class, thrown.getCause());
            assertEquals(501, failure.getStatusCode());
            assertEquals("runtime_tool_v3_unsupported", failure.getCode());
        }
    }

    @Test
    void exchangesToolV3WithTheRealTypeScriptHandler() throws Exception {
        Path repository = Path.of("").toAbsolutePath()
                .resolve("../../..").normalize();
        Path handler = repository.resolve("packages/cli/dist/src/serve/managed-runtime-tool-v3-routes.js");
        Assumptions.assumeTrue(Files.isRegularFile(handler),
                "Build the TypeScript workspace before the interop test.");
        Path serverScript = Path.of("src/test/resources/tool-v3-interop-server.mjs")
                .toAbsolutePath();
        Process worker = new ProcessBuilder("node", serverScript.toString())
                .directory(repository.toFile())
                .start();
        try {
            BufferedReader output = new BufferedReader(new InputStreamReader(
                    worker.getInputStream(), StandardCharsets.UTF_8));
            String ready = CompletableFuture.supplyAsync(() -> {
                try {
                    return output.readLine();
                } catch (IOException error) {
                    throw new CompletionException(error);
                }
            }).get(20, TimeUnit.SECONDS);
            assertTrue(ready != null && ready.startsWith("READY:"), ready);
            int port = Integer.parseInt(ready.substring("READY:".length()));
            RuntimeLease lease = toolLease(port);
            Map<String, Object> reference = toolReference();
            reference.put("toolName", "run_shell_command");
            reference.put("input", Map.of("command", "printf hello"));
            reference.put("argsDigest",
                    "424b16b9aa8d9f0648c8b2e91ecd9fb09faba205685214a7ccb01702b3dd0ce8");
            Map<String, Object> capture = Map.of(
                    "tenantId", "tenant-a",
                    "sessionId", "managed-session-a",
                    "turnId", "turn-1",
                    "executionCallId", "execution-a",
                    "bindingGeneration", "1",
                    "capturePolicy", "complete_required");
            Map<String, Object> answer = transport.executeV3(
                    lease, toolSession(), reference, capture)
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            assertEquals("settled", answer.get("state"));
            @SuppressWarnings("unchecked")
            Map<String, Object> result = (Map<String, Object>) answer.get("result");
            @SuppressWarnings("unchecked")
            Map<String, Object> raw = (Map<String, Object>) result.get("capture");
            assertEquals("complete", raw.get("captureStatus"));
            assertEquals("committed", raw.get("deliveryStatus"));
            assertEquals("settled", transport.statusV3(lease, toolSession(),
                    reference, 0).toCompletableFuture()
                    .get(10, TimeUnit.SECONDS).get("state"));
            Map<String, Object> receipt = new LinkedHashMap<>();
            receipt.put("executionCallId", "execution-a");
            receipt.put("manifest", raw.get("manifest"));
            receipt.put("deliveryStatus", "committed");
            receipt.put("historyRevision", 7);
            assertEquals("settled", transport.acknowledgeV3(lease,
                    toolSession(), reference, receipt)
                    .toCompletableFuture().get(10, TimeUnit.SECONDS)
                    .get("state"));
            receipt.put("historyRevision", 8);
            assertThrows(ExecutionException.class, () -> transport.acknowledgeV3(
                    lease, toolSession(), reference, receipt)
                    .toCompletableFuture().get(10, TimeUnit.SECONDS));
        } finally {
            worker.destroy();
            if (!worker.waitFor(5, TimeUnit.SECONDS)) {
                worker.destroyForcibly();
            }
        }
    }

    @Test
    void preservesNullValuesInToolInput() throws Exception {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("optional", null);
        input.put("nested", java.util.Collections.singletonMap("value", null));
        input.put("items", Arrays.asList(null,
                java.util.Collections.singletonMap("value", null)));
        Map<String, Object> reference = toolReference();
        reference.put("input", input);
        reply.set(json(200, JSON.writeValueAsBytes(findIn(toolSuite("execute"),
                "success").required("expected").required("body"))));

        transport.execute(toolLease(server.getAddress().getPort()),
                toolSession(), reference).toCompletableFuture()
                .get(2, TimeUnit.SECONDS);

        assertEquals(JSON.valueToTree(input), JSON.readTree(captured.get())
                .required("input"));
    }

    @Test
    void sendsWellFormedUnicodeToolNamesAndInputUnchanged() throws Exception {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("路径-𝄞", List.of("é", "𝄞", Map.of("键", "値-😀")));
        Map<String, Object> reference = toolReference();
        reference.put("toolName", "读取-𝄞");
        reference.put("input", input);
        reply.set(json(200, JSON.writeValueAsBytes(findIn(toolSuite("execute"),
                "success").required("expected").required("body"))));

        transport.execute(toolLease(server.getAddress().getPort()),
                toolSession(), reference).toCompletableFuture()
                .get(2, TimeUnit.SECONDS);

        assertEquals("读取-𝄞", JSON.readTree(captured.get()).required("toolName").asText());
        assertEquals(JSON.valueToTree(input), JSON.readTree(captured.get())
                .required("input"));
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
        assertEquals(Set.of("state"), answer.keySet());
        assertNull(answer.get("result"));
    }

    @Test
    void oversizedMcpRequestHasDefinitiveClassification() {
        RuntimeSession session = toolSession();
        Map<String, Object> operation = new LinkedHashMap<>(mcpOperation(session, "mcp-invoke"));
        operation.put("request", Map.of("kind", "prompt_get", "name", "large",
                "arguments", Map.of("value", "x".repeat(HttpRuntimeTransport.TOOL_REQUEST_LIMIT_BYTES + 1))));
        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> transport.control(toolLease(server.getAddress().getPort()), session, operation));
        assertNull(captured.get(), "oversized request must never reach the Runtime");
        RuntimeBrokerException classified = assertInstanceOf(RuntimeBrokerException.class, failure);
        assertEquals(413, classified.getStatusCode());
        assertEquals("runtime_control_operation_too_large", classified.getCode());
        assertFalse(classified.isRetryable());
    }

    @Test
    void oversizedMcpRequestKeepsClassificationThroughBrokerService() {
        RuntimeSession session = toolSession();
        RuntimeScope scope = session.getScope();
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        var clock = java.time.Clock.systemUTC();
        var bindings = new InMemoryRuntimeBindingRepository(clock, () -> "size-probe-binding");
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository(clock);
        RuntimeProvisioner provisioner = request -> CompletableFuture.completedFuture(lease);
        try (var service = new RuntimeBrokerService(harness -> CompletableFuture.completedFuture(scope),
                provisioner, transport, bindings, sessions, executions, "size-probe",
                Duration.ofMinutes(1), Duration.ofMinutes(1), clock, () -> "size-probe-execution")) {
            service.acquire(session.getHarnessSessionId(), session.getRuntimeSessionId(), "bootstrap").toCompletableFuture().join();
            Map<String, Object> operation = new LinkedHashMap<>(mcpOperation(session, "mcp-invoke"));
            operation.put("request", Map.of("kind", "prompt_get", "name", "large",
                    "arguments", Map.of("value", "x".repeat(HttpRuntimeTransport.TOOL_REQUEST_LIMIT_BYTES + 1))));
            CompletionException failure = assertThrows(CompletionException.class, () -> service.control(
                    session.getHarnessSessionId(), session.getRuntimeSessionId(), operation).toCompletableFuture().join());
            RuntimeBrokerException classified = assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
            assertNull(captured.get(), "oversized request must never reach the Runtime");
            assertEquals(413, classified.getStatusCode());
            assertEquals("runtime_control_operation_too_large", classified.getCode());
            assertFalse(classified.isRetryable());
        }
    }

    @Test
    void forwardsMcpDataWithoutInventingAToolResult() throws Exception {
        RuntimeSession session = toolSession();
        Map<String, Object> operation = mcpOperation(session, "mcp-invoke");
        Map<String, Object> data = Map.of("contents", List.of(Map.of("uri", "test:blob",
                "blob", "AAE=", "mimeType", "application/octet-stream")));
        Map<String, Object> view = Map.of("operationId", "mcp-operation", "state", "settled", "response", data);
        reply.set(json(200, JsonCodec.encode(Map.of("protocolVersion", 1,
                "runtimeSessionId", session.getRuntimeSessionId(), "operation", view))));
        assertEquals(view, transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        assertEquals(ManagedMcpProtocol.PATH, capturedPath.get());
        assertEquals(JSON.valueToTree(Map.of("protocolVersion", 1,
                "runtimeSessionId", session.getRuntimeSessionId(), "operation", operation)), JSON.readTree(captured.get()));
        assertEquals("Bearer " + toolSuite.required("identity").required("token").textValue(), capturedAuthorization.get());
        assertEquals("no-store", capturedCacheControl.get());
    }

    @Test
    void mcpRecoveryKeepsTheOriginalOperationIdentityAndRejectsMalformedReceipts() throws Exception {
        RuntimeSession session = toolSession();
        Map<String, Object> operation = mcpOperation(session, "mcp-status");
        Map<String, Object> view = Map.of("operationId", "original-operation", "state", "outcome_unknown");
        Map<String, Object> envelope = Map.of("protocolVersion", 1,
                "runtimeSessionId", session.getRuntimeSessionId(), "operation", view);
        reply.set(json(200, JsonCodec.encode(envelope)));
        assertEquals(view, transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        for (Map<String, Object> invalid : List.<Map<String, Object>>of(
                Map.of("operationId", "mcp-operation", "state", "settled"),
                Map.of("operationId", "original-operation", "state", "unknown"),
                Map.of("operationId", "original-operation", "state", "outcome_unknown", "response", Map.of()),
                Map.of("operationId", "original-operation", "state", "settled", "toolResult", Map.of()),
                Map.of("operationId", "original-operation", "state", "settled", "error", Map.of("code", "failed", "message", "secret")))) {
            reply.set(json(200, JsonCodec.encode(Map.of("protocolVersion", 1,
                    "runtimeSessionId", session.getRuntimeSessionId(), "operation", invalid))));
            assertThrows(ExecutionException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
        }
        reply.set(json(200, JsonCodec.encode(Map.of("protocolVersion", 1,
                "runtimeSessionId", "different-session", "operation", view))));
        assertThrows(ExecutionException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        reply.set(json(200, new byte[HttpRuntimeTransport.TOOL_RESULT_LIMIT_BYTES + 1]));
        assertThrows(ExecutionException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
    }

    @Test
    void forwardsHookReceiptsThroughTheBoundedPrivateRoute() throws Exception {
        RuntimeSession session = toolSession();
        Map<String, Object> operation = hookOperation(session, "hook-execute");
        Map<String, Object> data = Map.of("contents", List.of(Map.of("uri", "test:blob",
                "blob", "AAE=", "mimeType", "application/octet-stream")));
        Map<String, Object> view = Map.of("operationId", "hook-operation", "state", "settled", "result", data);
        reply.set(json(200, JsonCodec.encode(Map.of("protocolVersion", 1,
                "runtimeSessionId", session.getRuntimeSessionId(), "operation", view))));
        assertEquals(view, transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        assertEquals(ManagedHookProtocol.PATH, capturedPath.get());
        assertEquals(JSON.valueToTree(Map.of("protocolVersion", 1,
                "runtimeSessionId", session.getRuntimeSessionId(), "operation", operation)), JSON.readTree(captured.get()));
        assertEquals("Bearer " + toolSuite.required("identity").required("token").textValue(), capturedAuthorization.get());
        assertEquals("no-store", capturedCacheControl.get());
    }

    @Test
    void forwardsCompleteHookContextBeyondTheToolRequestLimit() throws Exception {
        RuntimeSession session = toolSession();
        Map<String, Object> operation = new LinkedHashMap<>(hookOperation(session, "hook-execute"));
        operation.put("input", Map.of("messages", List.of(Map.of("text", "x".repeat(300 * 1024)))));
        Map<String, Object> view = Map.of("operationId", "hook-operation", "state", "running");
        reply.set(json(200, JsonCodec.encode(Map.of("protocolVersion", 1,
                "runtimeSessionId", session.getRuntimeSessionId(), "operation", view))));
        assertEquals(view, transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        assertEquals(JSON.valueToTree(operation), JSON.readTree(captured.get()).get("operation"));
        operation.put("input", Map.of("messages", List.of(Map.of("text", "x".repeat(8 * 1024 * 1024)))));
        assertThrows(RuntimeBrokerException.class,
                () -> transport.control(toolLease(server.getAddress().getPort()), session, operation));
    }

    @Test
    void hookRecoveryKeepsTheOriginalOperationIdentityAndRejectsMalformedReceipts() throws Exception {
        RuntimeSession session = toolSession();
        Map<String, Object> operation = hookOperation(session, "hook-status");
        Map<String, Object> view = Map.of("operationId", "original-operation", "state", "outcome_unknown");
        Map<String, Object> envelope = Map.of("protocolVersion", 1,
                "runtimeSessionId", session.getRuntimeSessionId(), "operation", view);
        reply.set(json(200, JsonCodec.encode(envelope)));
        assertEquals(view, transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        for (Map<String, Object> invalid : List.<Map<String, Object>>of(
                Map.of("operationId", "hook-operation", "state", "settled"),
                Map.of("operationId", "original-operation", "state", "unknown"),
                Map.of("operationId", "original-operation", "state", "outcome_unknown", "result", Map.of()),
                Map.of("operationId", "original-operation", "state", "settled", "toolResult", Map.of()),
                Map.of("operationId", "original-operation", "state", "settled", "error", Map.of("code", "failed", "message", "secret")))) {
            reply.set(json(200, JsonCodec.encode(Map.of("protocolVersion", 1,
                    "runtimeSessionId", session.getRuntimeSessionId(), "operation", invalid))));
            assertThrows(ExecutionException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
        }
        reply.set(json(200, JsonCodec.encode(Map.of("protocolVersion", 1,
                "runtimeSessionId", "different-session", "operation", view))));
        assertThrows(ExecutionException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
        reply.set(json(200, new byte[HttpRuntimeTransport.TOOL_RESULT_LIMIT_BYTES + 1]));
        assertThrows(ExecutionException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation)
                .toCompletableFuture().get(2, TimeUnit.SECONDS));
    }

    private static Map<String, Object> hookOperation(RuntimeSession session, String kind) {
        return Map.of("kind", kind, "operationId", "hook-operation",
                "targetOperationId", "original-operation",
                "sessionKey", Map.of("tenantId", session.getScope().getTenantId(),
                        "workspaceId", session.getScope().getWorkspaceId(), "sessionId", session.getHarnessSessionId()));
    }

    @Test
    void rejectsForeignHookSessionsBeforeSending() {
        RuntimeSession session = toolSession();
        for (String field : List.of("tenantId", "workspaceId", "sessionId")) {
            Map<String, Object> operation = new LinkedHashMap<>(hookOperation(session, "hook-status"));
            Map<String, Object> key = new LinkedHashMap<>(Map.of("tenantId", session.getScope().getTenantId(),
                    "workspaceId", session.getScope().getWorkspaceId(), "sessionId", session.getHarnessSessionId()));
            key.put(field, "foreign");
            operation.put("sessionKey", key);
            assertThrows(RuntimeBrokerException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation));
        }
        assertNull(captured.get());
    }

    @Test
    void rejectsForeignMcpSessionsAndToolCallsBeforeSending() {
        RuntimeSession session = toolSession();
        for (String field : List.of("tenantId", "workspaceId", "sessionId")) {
            Map<String, Object> operation = new LinkedHashMap<>(mcpOperation(session, "mcp-status"));
            Map<String, Object> key = new LinkedHashMap<>(Map.of("tenantId", session.getScope().getTenantId(),
                    "workspaceId", session.getScope().getWorkspaceId(), "sessionId", session.getHarnessSessionId()));
            key.put(field, "foreign");
            operation.put("sessionKey", key);
            assertThrows(RuntimeBrokerException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, operation));
        }
        Map<String, Object> tool = new LinkedHashMap<>(mcpOperation(session, "mcp-invoke"));
        tool.put("request", Map.of("kind", "tool_call", "name", "effect", "arguments", Map.of()));
        assertThrows(RuntimeBrokerException.class, () -> transport.control(toolLease(server.getAddress().getPort()), session, tool));
        assertNull(captured.get());
    }

    private static Map<String, Object> mcpOperation(RuntimeSession session, String kind) {
        Map<String, Object> operation = new LinkedHashMap<>(Map.of("kind", kind,
                "sessionKey", Map.of("tenantId", session.getScope().getTenantId(),
                        "workspaceId", session.getScope().getWorkspaceId(), "sessionId", session.getHarnessSessionId()),
                "operationId", "mcp-operation"));
        if ("mcp-invoke".equals(kind)) {
            operation.put("request", Map.of("kind", "resource_read", "uri", "test:blob"));
        } else {
            operation.put("targetOperationId", "original-operation");
        }
        return operation;
    }

    @Test
    void rawSessionAcquisitionIsBrokerLocal() {
        assertTrue(transport instanceof RuntimeTransport);
        transport.acquire(toolLease(server.getAddress().getPort()), toolSession())
                .toCompletableFuture().join();
        assertNull(captured.get());
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
        replies.put("separators", new Reply(200, valid, "no-store", ";;"));
        replies.put("charset", new Reply(200, valid, "no-store",
                "application/json; charset=utf-16"));
        replies.put("field", json(200, JSON.writeValueAsBytes(unknownField)));
        replies.put("version",
                json(200, JSON.writeValueAsBytes(newerProtocol)));
        replies.put("fractional version",
                json(200, JSON.writeValueAsBytes(fractionalProtocol)));
        replies.put("rounded version",
                json(200, JSON.writeValueAsBytes(roundedProtocol)));
        replies.put("rounded-up version", json(200,
                successBodyWith("protocolVersion", "2.0000000000000001")));
        replies.put("exponent rounded-up version", json(200,
                successBodyWith("protocolVersion", "0.20000000000000001E+1")));
        replies.put("long-mantissa version", json(200,
                successBodyWith("protocolVersion", "0.020000000000000000000E1")));
        replies.put("suffixed version", json(200,
                successBodyWith("protocolVersion", "2.0000000000000001D")));
        replies.put("wrapped version", json(200,
                successBodyWith("protocolVersion", "258B")));
        replies.put("epoch",
                json(200, JSON.writeValueAsBytes(fractionalEpoch)));
        replies.put("rounded-up epoch", json(200,
                successBodyWith("epoch", "4.0000000000000001")));
        replies.put("exponent rounded-up epoch", json(200,
                successBodyWith("epoch", "40000000000000001E-16")));
        replies.put("overflowing epoch", json(200,
                successBodyWith("epoch", "1e400")));
        replies.put("suffixed epoch", json(200,
                successBodyWith("epoch", "4.0000001F")));
        replies.put("wrapped epoch", json(200,
                successBodyWith("epoch", "65540S")));
        replies.put("unsupported epoch", json(200,
                successBodyWith("epoch", "Set[4]")));
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
    void acceptsIntegralSpellingsOfTheAttestationNumbers() throws Exception {
        long epoch = successBody().required("epoch").longValue();
        String[][] spellings = {
            {"protocolVersion", "2.0"},
            {"protocolVersion", "2E+0"},
            {"epoch", "4.0"},
            {"epoch", "4.00000000000000000000"},
        };
        for (String[] spelling : spellings) {
            reply.set(json(200, successBodyWith(spelling[0], spelling[1])));

            RuntimeAttestation proof = attest().toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            assertEquals(epoch, proof.getEpoch(), spelling[1]);
        }
    }

    @Test
    void acceptsAnEpochBeyondTheIntRange() throws Exception {
        long epoch = 4_294_967_296L;
        JsonNode identity = suite.required("identity");
        RuntimeProvisionSeed seed = new RuntimeProvisionSeed(
                identity.required("provisionRequestId").textValue(),
                identity.required("runtimeInstanceId").textValue(),
                identity.required("runtimeIncarnation").textValue(),
                identity.required("leaseId").textValue(), epoch,
                identity.required("token").textValue());
        reply.set(json(200, successBodyWith("epoch", Long.toString(epoch))));

        RuntimeAttestation proof = transport.attest(
                lease(server.getAddress().getPort(), epoch),
                new RuntimeProvisionRequest(scope(), "session-1"), seed)
                .toCompletableFuture().get(2, TimeUnit.SECONDS);

        assertEquals(epoch, proof.getEpoch());
    }

    @Test
    void keepsTheParseFailureAsTheCauseOfAnInvalidAttestation()
            throws IOException {
        reply.set(json(200, successBodyWith("epoch", "Set[4]")));

        RuntimeBrokerException failure = awaitFailure();

        assertEquals("managed_runtime_attestation_invalid", failure.getCode());
        assertInstanceOf(IllegalArgumentException.class, failure.getCause());
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
        byte[] body = JSON.writeValueAsBytes(findIn(toolSuite("execute"),
                "success").required("expected").required("body"));
        for (Reply invalid : List.of(
                new Reply(200, body, "", "application/json"),
                new Reply(200, body, "max-age=60", "application/json"),
                new Reply(200, body, "no-store", ""),
                new Reply(200, body, "no-store", ";"),
                new Reply(200, body, "no-store", ";;"),
                new Reply(200, body, "no-store", "; ;"),
                new Reply(200, body, "no-store", "text/html"),
                new Reply(200, body, "no-store",
                        "application/json; charset=utf-16"))) {
            reply.set(invalid);
            for (String operation : List.of("execute", "status", "cancel")) {
                RuntimeBrokerException failure = awaitToolFailure(operation);
                assertEquals(400, failure.getStatusCode());
                assertEquals("managed_runtime_attestation_invalid",
                        failure.getCode());
                assertFalse(failure.isRetryable());
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
        assertFalse(status.containsKey("lastSequence"));
        assertFalse(status.containsKey("protocolVersion"));
        assertEquals("settled", status.get("state"));
        assertTrue(status.containsKey("result"));
    }

    @Test
    void validatesSequenceNumbersWithoutRoundingOrLongTruncation()
            throws Exception {
        for (String invalid : List.of("1.000000000000000001", "-1e-999",
                "65540S", "1.0000000000000001D")) {
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
            assertEquals(Set.of("state"), answer.keySet(), valid);
            assertEquals("unknown", answer.get("state"), valid);
        }
        reply.set(json(200, ("{\"protocolVersion\":2.000000000000000001,"
                + "\"state\":\"unknown\"}").getBytes(StandardCharsets.UTF_8)));
        assertEquals(400, awaitToolFailure("status").getStatusCode());
    }

    @Test
    void rejectsALossyV3StatusSequence() throws Exception {
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> reference = toolReference();
        for (String invalid : List.of("65540S", "1.0000000000000001D")) {
            reply.set(json(200, ("{\"protocolVersion\":3,\"toolResult\":"
                    + "\"managed-tool-result/1\",\"state\":\"unknown\","
                    + "\"lastSequence\":" + invalid + "}")
                    .getBytes(StandardCharsets.UTF_8)));
            assertThrows(ExecutionException.class, () -> transport.statusV3(
                    lease, session, reference, 0).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS), invalid);
        }
        // An exact cursor of any magnitude stays valid.
        reply.set(json(200, ("{\"protocolVersion\":3,\"toolResult\":"
                + "\"managed-tool-result/1\",\"state\":\"unknown\","
                + "\"lastSequence\":18446744073709551616}")
                .getBytes(StandardCharsets.UTF_8)));
        assertEquals("unknown", transport.statusV3(lease, session, reference,
                0).toCompletableFuture().get(2, TimeUnit.SECONDS)
                .get("state"));
    }

    @Test
    void validatesTheV3ManifestByteLengthExactly() throws Exception {
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> reference = toolReference();
        for (String invalid : List.of("65540S", "1.0000000000000001D", "0",
                "65537", "1.5")) {
            reply.set(json(200, v3SettledWithManifestLength(invalid)));
            assertThrows(ExecutionException.class, () -> transport.statusV3(
                    lease, session, reference, 0).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS), invalid);
        }
        for (String valid : List.of("1", "4.0", "65536")) {
            reply.set(json(200, v3SettledWithManifestLength(valid)));
            assertEquals("settled", transport.statusV3(lease, session,
                    reference, 0).toCompletableFuture().get(2, TimeUnit.SECONDS)
                    .get("state"), valid);
        }
    }

    private static byte[] v3SettledWithManifestLength(String byteLength) {
        return ("{\"protocolVersion\":3,\"toolResult\":"
                + "\"managed-tool-result/1\",\"state\":\"settled\",\"result\":"
                + "{\"executionStatus\":\"success\",\"responseParts\":[],"
                + "\"capture\":{\"captureStatus\":\"complete\","
                + "\"captureReason\":null,\"previewTruncated\":false,"
                + "\"deliveryStatus\":\"committed\",\"manifest\":{"
                + "\"resourceId\":\"res-1\","
                + "\"kind\":\"managed-tool-result-manifest\","
                + "\"schemaVersion\":1,\"byteLength\":" + byteLength + ","
                + "\"digest\":\"" + "a".repeat(64) + "\"}}}}")
                .getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void answersTheDetachedCaptureFamilyOfAV3Settle() throws Exception {
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> reference = toolReference();
        // The background start settles its delivery blocked: the handle
        // reaches the model through the session history, not the store.
        Map<String, Object> capturedResult = new LinkedHashMap<>();
        capturedResult.put("captureStatus", "detached");
        capturedResult.put("captureReason", null);
        capturedResult.put("manifest", null);
        capturedResult.put("previewTruncated", false);
        capturedResult.put("deliveryStatus", "blocked");
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("executionStatus", "success");
        envelope.put("responseParts", List.of());
        envelope.put("capture", capturedResult);
        reply.set(json(200, JsonCodec.encode(Map.of(
                "protocolVersion", 3,
                "toolResult", "managed-tool-result/1",
                "state", "settled",
                "result", envelope))));
        Map<String, Object> body = transport.statusV3(lease, session,
                reference, 0).toCompletableFuture().get(2, TimeUnit.SECONDS);
        assertEquals("settled", body.get("state"));
        @SuppressWarnings("unchecked")
        Map<String, Object> result =
                (Map<String, Object>) body.get("result");
        @SuppressWarnings("unchecked")
        Map<String, Object> capture =
                (Map<String, Object>) result.get("capture");
        assertEquals("detached", capture.get("captureStatus"));
        assertNull(capture.get("manifest"));
        assertEquals("blocked", capture.get("deliveryStatus"));
    }

    @Test
    void refusesADetachedCaptureStillNamingAManifestOrAReason() throws Exception {
        RuntimeLease lease = toolLease(server.getAddress().getPort());
        RuntimeSession session = toolSession();
        Map<String, Object> reference = toolReference();
        for (String broken : List.of(
                "{\"captureStatus\":\"detached\",\"captureReason\":null,"
                        + "\"previewTruncated\":false,\"deliveryStatus\":\"blocked\","
                        + "\"manifest\":{\"resourceId\":\"res-1\","
                        + "\"kind\":\"managed-tool-result-manifest\",\"schemaVersion\":1,"
                        + "\"byteLength\":4,\"digest\":\"" + "a".repeat(64) + "\"}}",
                "{\"captureStatus\":\"detached\",\"captureReason\":\"storage_failed\","
                        + "\"previewTruncated\":false,\"deliveryStatus\":\"blocked\","
                        + "\"manifest\":null}")) {
            reply.set(json(200, ("{\"protocolVersion\":3,\"toolResult\":"
                    + "\"managed-tool-result/1\",\"state\":\"settled\",\"result\":"
                    + "{\"executionStatus\":\"success\",\"responseParts\":[],"
                    + "\"capture\":" + broken + "}}")
                    .getBytes(StandardCharsets.UTF_8)));
            assertThrows(ExecutionException.class, () -> transport.statusV3(
                    lease, session, reference, 0).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS), broken);
        }
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
                                reference).toCompletableFuture().get(5,
                                        TimeUnit.SECONDS);
                        case "status" -> transport.status(lease, session,
                                reference, 0).toCompletableFuture().get(5,
                                        TimeUnit.SECONDS);
                        case "cancel" -> transport.cancel(lease, session,
                                reference).toCompletableFuture().get(5,
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
    void growsTheResponseBufferWithTheBodyInsteadOfReservingTheCap() {
        // A checkpoint answer is a few hundred bytes under an 8 MiB cap.
        byte[] answer = pattern(183);
        AtomicBoolean cancelled = new AtomicBoolean();
        HttpRuntimeTransport.BoundedBodySubscriber subscriber = deliver(
                ProviderRuntimeProtocol.limit("checkpoint"), answer,
                answer.length, cancelled);

        assertTrue(subscriber.capacity() <= 64 * 1024,
                "capacity " + subscriber.capacity());
        HttpRuntimeTransport.BoundedBody body = subscriber.getBody()
                .toCompletableFuture().join();
        assertArrayEquals(answer, body.bytes());
        assertFalse(body.overflow());
        assertFalse(cancelled.get());
    }

    @Test
    void keepsExactlyTheCapOfAnOversizedBodyAndCancelsTheRest() {
        // The delivery that crosses the cap fits only in part: without
        // growth, after doubling, and in one delivery past double.
        assertTruncatedAtTheCap(0, 5, 5);
        assertTruncatedAtTheCap(10, 12, 6);
        assertTruncatedAtTheCap(20_000, 3 * 8192, 8192);
        assertTruncatedAtTheCap(100_000, 100_001, 100_001);
    }

    private static void assertTruncatedAtTheCap(int limit, int length,
            int chunk) {
        byte[] sent = pattern(length);
        AtomicBoolean cancelled = new AtomicBoolean();
        HttpRuntimeTransport.BoundedBodySubscriber subscriber = deliver(limit,
                sent, chunk, cancelled);

        HttpRuntimeTransport.BoundedBody body = subscriber.getBody()
                .toCompletableFuture().join();
        assertArrayEquals(Arrays.copyOf(sent, limit), body.bytes());
        assertTrue(body.overflow());
        assertTrue(cancelled.get());
        assertEquals(limit, subscriber.capacity());
    }

    private static HttpRuntimeTransport.BoundedBodySubscriber deliver(
            int limit, byte[] body, int chunk, AtomicBoolean cancelled) {
        HttpRuntimeTransport.BoundedBodySubscriber subscriber =
                new HttpRuntimeTransport.BoundedBodySubscriber(limit);
        subscriber.onSubscribe(new Flow.Subscription() {
            @Override
            public void request(long count) {
            }

            @Override
            public void cancel() {
                cancelled.set(true);
            }
        });
        for (int offset = 0; offset < body.length; offset += chunk) {
            subscriber.onNext(List.of(ByteBuffer.wrap(body, offset,
                    Math.min(chunk, body.length - offset))));
        }
        subscriber.onComplete();
        return subscriber;
    }

    private static byte[] pattern(int length) {
        // Period 251 divides no chunk size here, so a misplaced chunk shows.
        byte[] bytes = new byte[length];
        for (int index = 0; index < length; index++) {
            bytes[index] = (byte) (index % 251);
        }
        return bytes;
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
        return lease(port, suite.required("identity").required("epoch")
                .longValue());
    }

    private RuntimeLease lease(int port, long epoch) {
        JsonNode identity = suite.required("identity");
        return new RuntimeLease(
                identity.required("runtimeInstanceId").textValue(),
                URI.create("http://127.0.0.1:" + port + "/"),
                identity.required("token").textValue(),
                identity.required("leaseId").textValue(), epoch);
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

    private byte[] successBodyWith(String field, String number)
            throws IOException {
        ObjectNode body = successBody();
        body.required(field);
        // Jackson would normalize the spelling, so splice the literal in.
        body.put(field, "@");
        return JSON.writeValueAsString(body).replace("\"@\"", number)
                .getBytes(StandardCharsets.UTF_8);
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
