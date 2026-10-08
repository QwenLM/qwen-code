package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class HostedHarnessClientTest {
    private static final String BOOT_ID =
            "11111111-1111-4111-8111-111111111111";
    private static final String OTHER_BOOT_ID =
            "22222222-2222-4222-8222-222222222222";
    private static final String SESSION_ID =
            "33333333-3333-4333-8333-333333333333";
    private static final String PROMPT_ID =
            "44444444-4444-4444-8444-444444444444";
    private static final String SECOND_PROMPT_ID =
            "55555555-5555-4555-8555-555555555555";
    private static final String CLIENT_ID = "client-1";
    private static final String DIGEST = "sha256:"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String EVENT_EPOCH = "epoch-1";

    private HttpServer server;
    private ExecutorService serverExecutor;
    private URI baseUri;
    private AtomicReference<String> capabilitiesBody;

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverExecutor = Executors.newCachedThreadPool();
        server.setExecutor(serverExecutor);
        capabilitiesBody =
                new AtomicReference<>(capabilitiesJson(DIGEST, BOOT_ID));
        server.createContext("/capabilities", exchange -> sendJson(exchange,
                200, capabilitiesBody.get(), false));
        server.start();
        baseUri = URI.create("http://127.0.0.1:"
                + server.getAddress().getPort());
    }

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop(0);
        }
        if (serverExecutor != null) {
            serverExecutor.shutdownNow();
        }
    }

    @Test
    void negotiatesAndFencesSessionCreation() {
        AtomicReference<String> authorization = new AtomicReference<>();
        AtomicReference<String> protocol = new AtomicReference<>();
        AtomicReference<String> bootId = new AtomicReference<>();
        AtomicReference<String> clientId = new AtomicReference<>();
        AtomicReference<String> body = new AtomicReference<>();
        server.createContext("/session", exchange -> {
            authorization.set(exchange.getRequestHeaders().getFirst(
                    "Authorization"));
            protocol.set(exchange.getRequestHeaders().getFirst(
                    HostedHarnessClient.PROTOCOL_HEADER));
            bootId.set(exchange.getRequestHeaders().getFirst(
                    HostedHarnessClient.BOOT_ID_HEADER));
            clientId.set(exchange.getRequestHeaders().getFirst(
                    HostedHarnessClient.CLIENT_ID_HEADER));
            body.set(readBody(exchange));
            sendSessionJson(exchange, 200, sessionJson());
        });

        try (HostedHarnessClient client = newClient()) {
            HostedHarnessCapabilities capabilities = client.capabilities();
            assertEquals(1, capabilities.getCurrentProtocolVersion());
            assertEquals(List.of(1),
                    capabilities.getSupportedProtocolVersions());
            assertEquals(BOOT_ID, capabilities.getBootId());
            assertEquals(DIGEST, capabilities.getCapabilityDigest());

            HarnessSessionRef session = client.createSession(
                    CreateHarnessSession.builder()
                            .harnessSessionId(SESSION_ID)
                            .approvalMode(DaemonApprovalMode.DEFAULT)
                            .toolProfile("hosted-workspace-files/1")
                            .managedSessionStore(
                                    ManagedSessionStoreConnection.builder()
                                            .baseUri(URI.create(
                                                    "https://store.example/"))
                                            .tenantId("tenant-a")
                                            .workspaceId("workspace-a")
                                            .writerId(BOOT_ID)
                                            .writerToken("qwt1_"
                                                    + "a".repeat(43))
                                            .leaseDuration(
                                                    Duration.ofSeconds(45))
                                            .build())
                            .build());
            assertEquals(SESSION_ID, session.getHarnessSessionId());
            assertEquals(CLIENT_ID, session.getHarnessClientId());
            assertEquals(BOOT_ID, session.getHarnessBootId());
            assertEquals("/control", session.getHarnessControlCwd());
        }

        assertEquals("Bearer harness-token", authorization.get());
        assertEquals("1", protocol.get());
        assertEquals(BOOT_ID, bootId.get());
        assertNull(clientId.get());
        assertTrue(body.get().contains("\"sessionId\":\"" + SESSION_ID
                + "\""));
        assertTrue(body.get().contains("\"sessionScope\":\"thread\""));
        assertTrue(body.get().contains("\"toolProfile\":\"hosted-workspace-files/1\""));
        assertTrue(body.get().contains("\"managedSessionStore\":{"
                + "\"baseUrl\":\"https://store.example\","));
        assertTrue(body.get().contains("\"tenantId\":\"tenant-a\""));
        assertTrue(body.get().contains(
                "\"workspaceId\":\"workspace-a\""));
        assertTrue(body.get().contains("\"writerId\":\"" + BOOT_ID
                + "\""));
        assertTrue(body.get().contains("\"writerToken\":\"qwt1_"
                + "a".repeat(43) + "\""));
        assertTrue(body.get().contains("\"leaseDurationMs\":45000"));
        assertFalse(body.get().contains("cwd"));
        assertThrows(IllegalArgumentException.class,
                () -> ManagedSessionStoreConnection.builder()
                        .baseUri(URI.create("https://store.example/"))
                        .tenantId("tenant-a")
                        .workspaceId("workspace-a")
                        .writerId(BOOT_ID)
                        .writerToken("short")
                        .build());
    }

    @Test
    void connectionOmitsUnsetOptionalCredentials() {
        Map<String, Object> json = ManagedSessionStoreConnection.builder()
                .baseUri(URI.create("https://store.example"))
                .tenantId("tenant-a")
                .workspaceId("workspace-a")
                .writerId(BOOT_ID)
                .build()
                .toJson();
        assertFalse(json.containsKey("writerToken"));
        assertFalse(json.containsKey("allowInsecureHttp"));
    }

    @Test
    void writerTokenLengthBoundsMatchTheSharedFixture() throws Exception {
        var limits = com.alibaba.fastjson2.JSON
                .parseObject(java.nio.file.Files.readString(locateFixture()))
                .getJSONObject("limits");
        int minimum = limits.getIntValue("minimumWriterTokenLength");
        int maximum = limits.getIntValue("maximumWriterTokenLength");
        assertTokenRejected("a".repeat(minimum - 1));
        assertTokenAccepted("a".repeat(minimum));
        assertTokenAccepted("a".repeat(maximum));
        assertTokenRejected("a".repeat(maximum + 1));
    }

    private static void assertTokenAccepted(String token) {
        ManagedSessionStoreConnection.builder()
                .baseUri(URI.create("https://store.example"))
                .tenantId("tenant-a")
                .workspaceId("workspace-a")
                .writerId(BOOT_ID)
                .writerToken(token)
                .build();
    }

    private static void assertTokenRejected(String token) {
        assertThrows(IllegalArgumentException.class,
                () -> ManagedSessionStoreConnection.builder()
                        .baseUri(URI.create("https://store.example"))
                        .tenantId("tenant-a")
                        .workspaceId("workspace-a")
                        .writerId(BOOT_ID)
                        .writerToken(token)
                        .build());
    }

    private static java.nio.file.Path locateFixture() {
        java.nio.file.Path current = java.nio.file.Path
                .of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            java.nio.file.Path candidate = current.resolve(java.nio.file.Path
                    .of("packages", "core", "src", "managed-runtime",
                            "contracts",
                            "managed-session-store-v1.fixtures.json"));
            if (java.nio.file.Files.isRegularFile(candidate)) {
                return candidate;
            }
            current = current.getParent();
        }
        throw new AssertionError(
                "cannot locate shared Managed Session store fixture");
    }

    @Test
    void rejectsCapabilityMismatchBeforeAnySessionMutation() {
        AtomicInteger sessions = new AtomicInteger();
        server.createContext("/session", exchange -> {
            sessions.incrementAndGet();
            sendSessionJson(exchange, 500, "{}");
        });

        HostedHarnessCapabilityMismatchException failure = assertThrows(
                HostedHarnessCapabilityMismatchException.class,
                () -> HostedHarnessClient.builder()
                        .baseUri(baseUri)
                        .bearerToken("harness-token")
                        .capabilityDigest("sha256:"
                                + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
                        .build());

        assertEquals("managed_capability_mismatch", failure.getCode());
        assertEquals(0, sessions.get());
    }

    @Test
    void submitsCallerPromptAndClearsTheTurnOnTerminalEvent() {
        createSessionRoute();
        AtomicReference<String> promptBody = new AtomicReference<>();
        AtomicReference<String> promptClient = new AtomicReference<>();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    promptBody.set(readBody(exchange));
                    promptClient.set(exchange.getRequestHeaders().getFirst(
                            HostedHarnessClient.CLIENT_ID_HEADER));
                    String responsePrompt = promptCalls.get() == 1
                            ? PROMPT_ID : SECOND_PROMPT_ID;
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + responsePrompt
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        AtomicReference<String> lastEventId = new AtomicReference<>();
        AtomicReference<String> eventEpoch = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    lastEventId.set(exchange.getRequestHeaders().getFirst(
                            "Last-Event-ID"));
                    eventEpoch.set(exchange.getRequestHeaders().getFirst(
                            HostedHarnessClient.EVENT_EPOCH_HEADER));
                    sendSse(exchange, terminalEvent(1, PROMPT_ID),
                            EVENT_EPOCH, BOOT_ID);
                });

        Map<String, Object> block = Map.of(
                "type", "text", "text", "hello");
        String payloadDigest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(payloadDigest)
                            .build());
            assertEquals(PROMPT_ID, receipt.getPromptId());
            assertEquals(EVENT_EPOCH, receipt.getEventEpoch());
            assertEquals(CLIENT_ID, promptClient.get());
            assertTrue(promptBody.get().contains(
                    "\"payloadDigest\":\"" + payloadDigest + "\""));

            assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(payloadDigest)
                            .build()));

            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .lastEventId(receipt.getLastEventId())
                            .eventEpoch(receipt.getEventEpoch())
                            .build())) {
                assertEquals(EVENT_EPOCH, stream.getEventEpoch());
                assertEquals("turn_complete", stream.next().getType());
                assertNull(stream.next());
            }

            PromptReceipt second = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(payloadDigest)
                            .build());
            assertEquals(SECOND_PROMPT_ID, second.getPromptId());
        }

        assertEquals("0", lastEventId.get());
        assertEquals(EVENT_EPOCH, eventEpoch.get());
        assertEquals(2, promptCalls.get());
    }

    @Test
    void permitsAnOutcomeUnknownPromptRetryOnlyWithTheSameIdentity() {
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendSessionJson(exchange, 503,
                                "{\"code\":\"temporarily_unavailable\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn attached = requestForSession(block, session);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(attached));
            assertEquals(PROMPT_ID,
                    client.submitTurn(attached).getPromptId());
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void coversLoadStatusTranscriptHeartbeatAndLifecycleMutations() {
        AtomicReference<String> loadBody = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    loadBody.set(readBody(exchange));
                    sendSessionJson(exchange, 200,
                            sessionJsonWithRuntimeRecovery());
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        server.createContext("/session/" + SESSION_ID + "/transcript",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"v\":1,\"sessionId\":\"" + SESSION_ID
                                + "\",\"events\":[{\"type\":\"user\"}],"
                                + "\"nextCursor\":\"next\","
                                + "\"hasMore\":true}"));
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"clientId\":\"" + CLIENT_ID
                                + "\",\"lastSeenAt\":123}"));
        AtomicInteger cancelled = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/cancel",
                exchange -> {
                    cancelled.incrementAndGet();
                    sendSessionNoContent(exchange);
                });
        AtomicInteger detached = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    detached.incrementAndGet();
                    sendSessionNoContent(exchange);
                });
        AtomicInteger deleted = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID, exchange -> {
            deleted.incrementAndGet();
            sendSessionNoContent(exchange);
        });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.loadSession(
                    new LoadHarnessSession(SESSION_ID,
                            ManagedSessionStoreConnection.builder()
                                    .baseUri(URI.create(
                                            "https://store.example/"))
                                    .tenantId("tenant-a")
                                    .workspaceId("workspace-a")
                                    .writerId(BOOT_ID)
                                    .leaseDuration(Duration.ofSeconds(45))
                                            .build(), true, "hosted-workspace-files/1"));
            HarnessRuntimeRecovery recovery = session.getRuntimeRecovery();
            assertNotNull(recovery);
            assertEquals("await_runtime", recovery.getPhase());
            assertEquals("checkpoint-1", recovery.getCheckpointId());
            assertEquals("activation-1", recovery.getActivationId());
            assertTrue(recovery.hasUnknownOutcome());
            assertEquals("execution-1", recovery.getExecutions().get(0)
                    .getExecutionCallId());
            assertEquals("read_file", recovery.getExecutions().get(0)
                    .getToolName());
            assertFalse(client.getStatus(session).hasActivePrompt());
            HarnessTranscriptPage transcript = client.getTranscript(
                    GetHarnessTranscript.builder()
                            .session(session)
                            .limit(10)
                            .direction("backward")
                            .build());
            assertEquals(1, transcript.getEvents().size());
            assertEquals("next", transcript.getNextCursor());
            assertTrue(transcript.hasMore());
            assertEquals(123, client.heartbeat(session).getLastSeenAt());
            client.cancelTurn(session);
            client.detachSession(session);
            client.closeSession(session);
        }

        assertEquals(1, cancelled.get());
        assertEquals(1, detached.get());
        assertEquals(1, deleted.get());
        assertTrue(loadBody.get().contains("\"managedSessionStore\":{"));
        assertTrue(loadBody.get().contains("\"toolProfile\":\"hosted-workspace-files/1\""));
        assertTrue(loadBody.get().contains(
                "\"baseUrl\":\"https://store.example\""));
        assertTrue(loadBody.get().contains("\"writerId\":\"" + BOOT_ID
                + "\""));
        assertTrue(loadBody.get().contains(
                "\"passiveManagedRuntimeRecovery\":true"));
    }

    // The cancellation flag rides the wire separately: a plain passive
    // re-attach omits it, and only an explicit cancellation takeover adds
    // the field — anything else would let the daemon mint a canned
    // CANCELLED record for a wait whose owner could still exist (Arm B).
    @Test
    void carriesTheCancellationTakeoverFlagOnlyOnTheCancellationLoad() {
        AtomicReference<String> loadBody = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    loadBody.set(new String(exchange.getRequestBody()
                            .readAllBytes(), StandardCharsets.UTF_8));
                    sendSessionJson(exchange, 200, sessionJson());
                });
        try (HostedHarnessClient client = newClient()) {
            client.loadSession(new LoadHarnessSession(SESSION_ID, null,
                    true));
        }
        assertFalse(loadBody.get().contains("cancellationTakeover"));
        try (HostedHarnessClient client = newClient()) {
            client.loadSession(new LoadHarnessSession(SESSION_ID, null,
                    true, null, false, true));
        }
        assertTrue(loadBody.get().contains(
                "\"cancellationTakeover\":true"));
    }

    @Test
    void parsesAResultsReadyRuntimeRecovery() {
        AtomicReference<String> continuationBody = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithResultsReadyRuntimeRecovery()));
        server.createContext("/session/" + SESSION_ID
                        + "/managed-runtime/continue",
                exchange -> {
                    continuationBody.set(readBody(exchange));
                    sendSessionJson(exchange, 200,
                            "{\"accepted\":true,"
                                    + "\"interruption\":\"interrupted_turn\","
                                    + "\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\"" + EVENT_EPOCH
                                    + "\"}");
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            HarnessRuntimeRecovery recovery = session.getRuntimeRecovery();

            assertNotNull(recovery);
            assertEquals("results_ready", recovery.getPhase());
            assertFalse(recovery.hasUnknownOutcome());
            assertTrue(recovery.isContinuationReady());
            assertEquals(2, recovery.getExecutions().size());
            assertEquals("execution-1", recovery.getExecutions().get(0)
                    .getExecutionCallId());
            assertEquals("execution-2", recovery.getExecutions().get(1)
                    .getExecutionCallId());
            assertEquals("settled", recovery.getExecutions().get(0)
                    .getStatus().get("state"));
            assertEquals("settled", recovery.getExecutions().get(1)
                    .getStatus().get("state"));
            assertEquals(0L, session.getHarnessLastEventId());
            assertEquals(EVENT_EPOCH, session.getHarnessEventEpoch());
            PromptReceipt receipt = client.continueManagedRuntime(session,
                    PROMPT_ID, recovery.getCheckpointId(),
                    recovery.getActivationId());
            assertEquals(PROMPT_ID, receipt.getPromptId());
            assertEquals(EVENT_EPOCH, receipt.getEventEpoch());
            assertTrue(continuationBody.get().contains(
                    "\"checkpointId\":\"checkpoint-2\""));
        }
    }

    @Test
    void cancelsRecoveredRuntimeWithExactWireRequest() {
        AtomicReference<String> method = new AtomicReference<>();
        AtomicReference<String> body = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID
                        + "/managed-runtime/cancel",
                exchange -> {
                    method.set(exchange.getRequestMethod());
                    body.set(readBody(exchange));
                    sendSessionJson(exchange, 200,
                            "{\"accepted\":true,\"promptId\":\""
                                    + PROMPT_ID + "\",\"lastEventId\":3,"
                                    + "\"eventEpoch\":\"" + EVENT_EPOCH
                                    + "\"}");
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = new HarnessSessionRef(SESSION_ID,
                    CLIENT_ID, BOOT_ID, "/workspace", null, null, null);
            PromptReceipt receipt = client.cancelManagedRuntime(
                    new CancelManagedRuntime(session, PROMPT_ID,
                            "checkpoint-2", "activation-2"));

            assertEquals("POST", method.get());
            assertEquals("{\"promptId\":\"" + PROMPT_ID
                    + "\",\"checkpointId\":\"checkpoint-2\","
                    + "\"activationId\":\"activation-2\"}", body.get());
            assertEquals(PROMPT_ID, receipt.getPromptId());
            assertEquals(3L, receipt.getLastEventId());
            assertEquals(EVENT_EPOCH, receipt.getEventEpoch());
        }
    }

    @Test
    void requiresEveryRuntimeExecutionToBeKnownAndSettled() {
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithResultsReadyRuntimeRecovery()
                                .replace("\"outcome\":\"known\","
                                                + "\"status\":{\"state\":"
                                                + "\"settled\"}}]",
                                        "\"outcome\":\"known\","
                                                + "\"status\":{\"state\":"
                                                + "\"executing\"}}]")));

        try (HostedHarnessClient client = newClient()) {
            HarnessRuntimeRecovery recovery = client.loadSession(
                    new LoadHarnessSession(SESSION_ID)).getRuntimeRecovery();

            assertNotNull(recovery);
            assertFalse(recovery.hasUnknownOutcome());
            assertFalse(recovery.isContinuationReady());
        }
    }

    @Test
    void requiresAtLeastOneRuntimeExecutionForContinuation() {
        HarnessRuntimeRecovery recovery = new HarnessRuntimeRecovery(
                "results_ready", "checkpoint-1", "activation-1", List.of());

        assertFalse(recovery.isContinuationReady());
    }

    @Test
    void aggregatesUnknownOutcomeAcrossMultipleCancellationExecutions() {
        HarnessRuntimeRecovery recovery = new HarnessRuntimeRecovery(
                "await_runtime", "checkpoint-1", "activation-1", List.of(
                        new HarnessRuntimeExecutionRecovery("call-1", "tool",
                                "execution-1", "runtime-1", null, "known",
                                Map.of("state", "executing")),
                        new HarnessRuntimeExecutionRecovery("call-2", "tool",
                                "execution-2", "runtime-1", null, "unknown",
                                null)));

        assertTrue(recovery.hasUnknownOutcome());
        assertFalse(recovery.isCancellationReady());
    }

    @Test
    void rejectsContinuationWhenAnyRuntimeOutcomeIsUnknown() {
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithResultsReadyRuntimeRecovery()
                                .replace("\"outcome\":\"known\","
                                                + "\"status\":{\"state\":"
                                                + "\"settled\"}}]",
                                        "\"outcome\":\"unknown\"}]")));

        try (HostedHarnessClient client = newClient()) {
            HarnessRuntimeRecovery recovery = client.loadSession(
                    new LoadHarnessSession(SESSION_ID)).getRuntimeRecovery();

            assertNotNull(recovery);
            assertTrue(recovery.hasUnknownOutcome());
            assertFalse(recovery.isContinuationReady());
        }
    }

    @Test
    void rejectsRuntimeRecoveryWithoutAnEventWatermark() {
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithResultsReadyRuntimeRecovery()
                                .replace(",\"lastEventId\":0,\"eventEpoch\":\""
                                        + EVENT_EPOCH + "\"", "")));

        try (HostedHarnessClient client = newClient()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> client.loadSession(
                            new LoadHarnessSession(SESSION_ID)));
            assertTrue(failure.getCause()
                    instanceof DaemonProtocolException);
        }
    }

    @Test
    void rejectsAResponseFromAnotherHarnessGeneration() {
        server.createContext("/session", exchange -> sendJson(exchange, 200,
                sessionJson(), true, OTHER_BOOT_ID));

        try (HostedHarnessClient client = newClient()) {
            HostedHarnessGenerationException failure = assertThrows(
                    HostedHarnessGenerationException.class,
                    () -> createSession(client));
            assertEquals(BOOT_ID, failure.getExpectedBootId());
            assertEquals(OTHER_BOOT_ID, failure.getActualBootId());
        }
    }

    @Test
    void rejectsSseEpochChangesAndSequenceGaps() {
        createSessionRoute();
        AtomicInteger mode = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    if (mode.get() == 0) {
                        sendSse(exchange, "", "different-epoch", BOOT_ID);
                    } else {
                        sendSse(exchange, terminalEvent(2, PROMPT_ID),
                                EVENT_EPOCH, BOOT_ID);
                    }
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(DaemonProtocolException.class,
                    () -> client.streamEvents(StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build()));

            mode.set(1);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                assertThrows(DaemonProtocolException.class, stream::next);
            }
        }
    }

    @Test
    void keepsAtMostOneAutomaticHeartbeatInFlightPerAttachment()
            throws Exception {
        createSessionRoute();
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maximumActive = new AtomicInteger();
        AtomicInteger calls = new AtomicInteger();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    int now = active.incrementAndGet();
                    maximumActive.accumulateAndGet(now, Math::max);
                    calls.incrementAndGet();
                    entered.countDown();
                    try {
                        release.await(2, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } finally {
                        active.decrementAndGet();
                    }
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            createSession(client);
            assertTrue(entered.await(1, TimeUnit.SECONDS));
            Thread.sleep(80);
            assertEquals(1, calls.get());
            assertEquals(1, maximumActive.get());
        } finally {
            release.countDown();
            client.close();
        }
    }

    @Test
    void localCloseDoesNotDestroyRemoteSessions() {
        createSessionRoute();
        AtomicInteger deleted = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID, exchange -> {
            deleted.incrementAndGet();
            sendSessionNoContent(exchange);
        });

        HostedHarnessClient client = newClient();
        createSession(client);
        client.close();

        assertEquals(0, deleted.get());
    }

    @Test
    void commitsSessionTitleThroughThePrivateHarnessRoute() {
        createSessionRoute();
        AtomicReference<String> titleBody = new AtomicReference<>();
        AtomicReference<String> clientId = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/title",
                exchange -> {
                    titleBody.set(readBody(exchange));
                    clientId.set(exchange.getRequestHeaders().getFirst(
                            HostedHarnessClient.CLIENT_ID_HEADER));
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"displayName\":\"renamed\","
                                    + "\"persisted\":true}");
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            client.updateSessionTitle(session, "renamed");
        }

        assertEquals(CLIENT_ID, clientId.get());
        assertTrue(titleBody.get().contains("\"title\":\"renamed\""));
    }

    @Test
    void closeByIdTreatsAnAbsentLiveHarnessSessionAsClosed() {
        AtomicInteger closes = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID, exchange -> {
            closes.incrementAndGet();
            sendControlPlaneSessionJson(exchange, 404,
                    "{\"code\":\"session_not_found\"}");
        });

        try (HostedHarnessClient client = newClient()) {
            client.closeSession(SESSION_ID);
        }

        assertEquals(1, closes.get());
    }

    @Test
    void actionResolutionCarriesOriginalRevisionsAndClientIdentity() {
        String action = "tool_approval_" + "a".repeat(32);
        AtomicReference<String> payload = new AtomicReference<>();
        server.createContext("/session", exchange -> sendSessionJson(exchange, 200,
                sessionJson().replace("\"workspaceCwd\"", "\"approvalMode\":\"default\",\"workspaceCwd\"")));
        server.createContext("/session/" + SESSION_ID + "/actions/" + action + "/resolve", exchange -> {
            assertEquals(CLIENT_ID, exchange.getRequestHeaders().getFirst(HostedHarnessClient.CLIENT_ID_HEADER));
            assertEquals("Bearer harness-token", exchange.getRequestHeaders().getFirst("Authorization"));
            payload.set(readBody(exchange));
            sendSessionJson(exchange, 200, "{\"requestId\":\"" + action + "\",\"state\":\"decided\",\"optionId\":\"allow\"}");
        });
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.createSession(CreateHarnessSession.builder()
                    .harnessSessionId(SESSION_ID).approvalMode(DaemonApprovalMode.DEFAULT)
                    .approvalTimeoutMs(2000).build());
            assertEquals("default", session.getApprovalMode());
            client.resolveAction(session, action, "allow", 1, "hosted-tool-approval/1");
            assertEquals(Map.of("optionId", "allow", "inputRevision", 1, "policyRevision", "hosted-tool-approval/1"),
                    JsonSupport.parseObject(payload.get(), "Action response"));
        }
    }

    // Issue #13320: a load refused fail-closed with a machine-readable code
    // on the wire (e.g. a mixed-version takeover where the journal is newer
    // than this reader) must surface the code to the caller; a failure
    // without a recognizable code stays outcome-unknown.
    @Test
    void namedLoadRefusalSurfacesItsMachineReadableCode() {
        AtomicInteger loadCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    loadCalls.incrementAndGet();
                    // error and code deliberately differ, so the assertion
                    // proves which field is read.
                    sendJson(exchange, 503, "{\"error\":\"session open"
                            + " failed\",\"code\":\"managed_session_open_"
                            + "failed\"}", true);
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRefusedException failure = assertThrows(
                    HarnessSessionRefusedException.class,
                    () -> client.loadSession(new LoadHarnessSession(
                            SESSION_ID)));
            assertEquals(1, loadCalls.get(), "a named refusal must not be"
                    + " retried by the SDK");
            assertEquals(503, failure.getStatusCode());
            assertEquals("managed_session_open_failed", failure.getCode());
            assertTrue(failure.getMessage()
                    .contains("managed_session_open_failed"));
            assertTrue(failure.getCause()
                    instanceof MutationOutcomeUnknownException);
        }
    }

    @Test
    void codelessLoadFailureStaysOutcomeUnknown() {
        // An intermediary 503 carries no refusal envelope at all.
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendJson(exchange, 503, "Service Unavailable",
                        true));

        try (HostedHarnessClient client = newClient()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> client.loadSession(new LoadHarnessSession(
                            SESSION_ID)));
            assertTrue(failure.getCause() instanceof DaemonHttpException);
        }
    }

    @Test
    void loadFailureWithoutARefusalCodeFieldStaysOutcomeUnknown() {
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendJson(exchange, 503,
                        "{\"error\":\"managed_session_open_failed\"}", true));

        try (HostedHarnessClient client = newClient()) {
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.loadSession(new LoadHarnessSession(
                            SESSION_ID)));
        }
    }

    @Test
    void oversizedLoadRefusalCodeStaysOutcomeUnknown() {
        // The refusal code flows into the turn's error_code column, a
        // VARCHAR(128): anything longer is not a named refusal.
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendJson(exchange, 503, "{\"error\":\"x\","
                        + "\"code\":\"" + "c".repeat(129) + "\"}", true));

        try (HostedHarnessClient client = newClient()) {
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.loadSession(new LoadHarnessSession(
                            SESSION_ID)));
        }
    }

    @Test
    void loadRefusalCodeOutsideTheVocabularyStaysOutcomeUnknown() {
        // A code carrying control characters could forge log lines where the
        // refusal is recorded; only the snake_case vocabulary is named.
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendJson(exchange, 503, "{\"error\":\"x\","
                        + "\"code\":\"managed_session_open_failed\\nforged\""
                        + "}", true));

        try (HostedHarnessClient client = newClient()) {
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.loadSession(new LoadHarnessSession(
                            SESSION_ID)));
        }
    }

    @Test
    void loadTransportFailureStaysOutcomeUnknown() {
        // The connection drops without an HTTP status: nothing to classify.
        server.createContext("/session/" + SESSION_ID + "/load",
                HttpExchange::close);

        try (HostedHarnessClient client = newClient()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> client.loadSession(new LoadHarnessSession(
                            SESSION_ID)));
            assertFalse(failure.getCause() instanceof DaemonHttpException);
        }
    }

    private HostedHarnessClient newClient() {
        return HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .build();
    }

    // The journal-contract marker is part of negotiation: a build too old to
    // open message.delta journals is refused once here, not per Session.
    @Test
    void refusesAHarnessWithoutTheJournalContractToken() {
        capabilitiesBody.set(
                capabilitiesJsonWithoutJournalToken(DIGEST, BOOT_ID));
        DaemonProtocolException error = assertThrows(
                DaemonProtocolException.class, this::newClient);
        assertTrue(error.getMessage()
                .contains("managed_session_journal_delta_v1"));
    }

    // The load timeout is a distinct builder knob, validated like the
    // other timeouts.
    @Test
    void loadTimeoutMustBePositive() {
        assertThrows(IllegalArgumentException.class,
                () -> HostedHarnessClient.builder()
                        .loadTimeout(Duration.ZERO));
    }

    // The two knobs discriminate at the call site: a recovery-flagged load
    // pays loadTimeout while a plain attach load meets requestTimeout
    // (which also guards the connector's ConcurrentHashMap bin locks).
    @Test
    void recoveryLoadUsesLoadTimeoutPlainLoadUsesRequestTimeout()
            throws Exception {
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    try {
                        Thread.sleep(2_500);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                    }
                    sendSessionJson(exchange, 200, sessionJson());
                });
        try (HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                // requestTimeout also caps the /capabilities negotiation
                // inside build(); give it headroom past the contended-lane
                // round trip while keeping requestTimeout < sleep <
                // loadTimeout so the discrimination itself is unchanged.
                .requestTimeout(Duration.ofMillis(1_000))
                .loadTimeout(Duration.ofSeconds(10))
                .build()) {
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.loadSession(
                            new LoadHarnessSession(SESSION_ID, null,
                                    false)));
            assertNotNull(client.loadSession(
                    new LoadHarnessSession(SESSION_ID, null, true)));
            // The drive disjunct of the same predicate: an active takeover
            // drive (passive=false, drive=true) also pays loadTimeout —
            // the connector's headline recovery path.
            assertNotNull(client.loadSession(
                    new LoadHarnessSession(SESSION_ID, null, false, null,
                            true)));
        }
    }

    // The serve delegating app answers with a bare 404 while its runtime is
    // still starting (before the contract middleware exists); that window is
    // transient, never a protocol defect (G3 Harness-restart race).
    @Test
    void preContract404IsTransientNotAProtocolDefect() {
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    exchange.getResponseHeaders().set("Content-Type",
                            "text/plain");
                    exchange.sendResponseHeaders(404, -1);
                    exchange.close();
                });
        Map<String, Object> block = Map.of("type", "text", "text", "hi");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            DaemonTransportException error = assertThrows(
                    DaemonTransportException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertTrue(error.getMessage().contains("pre-contract"));
        }
    }

    private void createSessionRoute() {
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
    }

    private static HarnessSessionRef createSession(
            HostedHarnessClient client) {
        return client.createSession(CreateHarnessSession.builder()
                .harnessSessionId(SESSION_ID)
                .build());
    }

    private static SubmitHarnessTurn requestForSession(
            Map<String, Object> block, HarnessSessionRef session) {
        return SubmitHarnessTurn.builder()
                .session(session)
                .promptId(PROMPT_ID)
                .addContent(block)
                .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                        List.of(block)))
                .build();
    }

    private static String capabilitiesJson(String digest, String bootId) {
        return "{\"v\":1,\"mode\":\"http-bridge\","
                + "\"features\":[\"hosted_harness_private_v1\","
                + "\"managed_session_journal_delta_v1\"],"
                + "\"transports\":[\"rest\"],\"hostedHarness\":{"
                + "\"protocolVersions\":{\"current\":1,"
                + "\"supported\":[1]},\"bootId\":\"" + bootId
                + "\",\"capabilityDigest\":\"" + digest + "\"}}";
    }

    private static String capabilitiesJsonWithoutJournalToken(String digest,
            String bootId) {
        return "{\"v\":1,\"mode\":\"http-bridge\","
                + "\"features\":[\"hosted_harness_private_v1\"],"
                + "\"transports\":[\"rest\"],\"hostedHarness\":{"
                + "\"protocolVersions\":{\"current\":1,"
                + "\"supported\":[1]},\"bootId\":\"" + bootId
                + "\",\"capabilityDigest\":\"" + digest + "\"}}";
    }

    private static String sessionJson() {
        return "{\"sessionId\":\"" + SESSION_ID
                + "\",\"workspaceCwd\":\"/control\","
                + "\"attached\":true,\"clientId\":\""
                + CLIENT_ID + "\"}";
    }

    private static String sessionJsonWithRuntimeRecovery() {
        return "{\"sessionId\":\"" + SESSION_ID
                + "\",\"workspaceCwd\":\"/control\","
                + "\"attached\":true,\"clientId\":\"" + CLIENT_ID
                + "\",\"lastEventId\":0,\"eventEpoch\":\""
                + EVENT_EPOCH
                + "\",\"_meta\":{\"qwen.daemon.managedRuntimeRecovery\":{"
                + "\"phase\":\"await_runtime\","
                + "\"checkpointId\":\"checkpoint-1\","
                + "\"activationId\":\"activation-1\",\"executions\":[{"
                + "\"functionCallId\":\"function-1\","
                + "\"toolName\":\"read_file\","
                + "\"executionCallId\":\"execution-1\","
                + "\"runtimeSessionId\":\"runtime-1\","
                + "\"progressCursor\":null,\"outcome\":\"unknown\"}]}}}";
    }

    private static String sessionJsonWithResultsReadyRuntimeRecovery() {
        return "{\"sessionId\":\"" + SESSION_ID
                + "\",\"workspaceCwd\":\"/control\","
                + "\"attached\":true,\"clientId\":\"" + CLIENT_ID
                + "\",\"lastEventId\":0,\"eventEpoch\":\""
                + EVENT_EPOCH
                + "\",\"_meta\":{\"qwen.daemon.managedRuntimeRecovery\":{"
                + "\"phase\":\"results_ready\","
                + "\"checkpointId\":\"checkpoint-2\","
                + "\"activationId\":\"activation-2\",\"executions\":[{"
                + "\"functionCallId\":\"function-1\","
                + "\"toolName\":\"read_file\","
                + "\"executionCallId\":\"execution-1\","
                + "\"runtimeSessionId\":\"runtime-1\","
                + "\"progressCursor\":null,\"outcome\":\"known\","
                + "\"status\":{\"state\":\"settled\"}},{"
                + "\"functionCallId\":\"function-2\","
                + "\"toolName\":\"write_file\","
                + "\"executionCallId\":\"execution-2\","
                + "\"runtimeSessionId\":\"runtime-2\","
                + "\"progressCursor\":\"cursor-2\","
                + "\"outcome\":\"known\","
                + "\"status\":{\"state\":\"settled\"}}]}}}";
    }

    private static String terminalEvent(long id, String promptId) {
        return "id: " + id + "\n"
                + "event: turn_complete\n"
                + "data: {\"v\":1,\"id\":" + id
                + ",\"type\":\"turn_complete\",\"promptId\":\""
                + promptId + "\",\"data\":{\"sessionId\":\""
                + SESSION_ID + "\",\"promptId\":\"" + promptId
                + "\"}}\n\n";
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        return new String(exchange.getRequestBody().readAllBytes(),
                StandardCharsets.UTF_8);
    }

    private static void sendSessionJson(HttpExchange exchange, int status,
            String body) throws IOException {
        sendJson(exchange, status, body, true);
    }

    private static void sendControlPlaneSessionJson(HttpExchange exchange,
            int status, String body) throws IOException {
        sendJson(exchange, status, body, true, BOOT_ID, false);
    }

    private static void sendJson(HttpExchange exchange, int status,
            String body, boolean includeBootId) throws IOException {
        sendJson(exchange, status, body, includeBootId, BOOT_ID);
    }

    private static void sendJson(HttpExchange exchange, int status,
            String body, boolean includeBootId, String bootId)
            throws IOException {
        sendJson(exchange, status, body, includeBootId, bootId, true);
    }

    private static void sendJson(HttpExchange exchange, int status,
            String body, boolean includeBootId, String bootId,
            boolean requireClientId) throws IOException {
        if (includeBootId) {
            assertPrivateHeaders(exchange, requireClientId);
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type",
                "application/json");
        if (includeBootId) {
            exchange.getResponseHeaders().set(
                    HostedHarnessClient.BOOT_ID_HEADER, bootId);
        }
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    /**
     * Sends a body-less response and ends the connection with it. On Java 11
     * the JDK's own HTTP server drops the connection after a response without
     * a body, while the Java 11 HttpClient keeps it pooled; the next request
     * over it fails with "HTTP/1.1 header parser received no bytes". This is
     * the same fixture fix as DaemonSessionClientTest#sendNoContent.
     */
    private static void sendSessionNoContent(HttpExchange exchange)
            throws IOException {
        assertPrivateHeaders(exchange);
        exchange.getResponseHeaders().set(
                HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
        exchange.getResponseHeaders().set("Connection", "close");
        exchange.sendResponseHeaders(204, -1);
        exchange.close();
    }

    private static void sendSse(HttpExchange exchange, String body,
            String eventEpoch, String bootId) throws IOException {
        assertPrivateHeaders(exchange);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type",
                "text/event-stream");
        exchange.getResponseHeaders().set("Content-Encoding", "identity");
        exchange.getResponseHeaders().set(
                HostedHarnessClient.EVENT_EPOCH_HEADER, eventEpoch);
        exchange.getResponseHeaders().set(
                HostedHarnessClient.BOOT_ID_HEADER, bootId);
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static void assertPrivateHeaders(HttpExchange exchange) {
        assertPrivateHeaders(exchange, true);
    }

    private static void assertPrivateHeaders(HttpExchange exchange,
            boolean requireClientId) {
        assertEquals("Bearer harness-token",
                exchange.getRequestHeaders().getFirst("Authorization"));
        assertEquals("1", exchange.getRequestHeaders().getFirst(
                HostedHarnessClient.PROTOCOL_HEADER));
        assertEquals(BOOT_ID, exchange.getRequestHeaders().getFirst(
                HostedHarnessClient.BOOT_ID_HEADER));
        String path = exchange.getRequestURI().getPath();
        if (requireClientId && !"/session".equals(path)
                && !path.endsWith("/load")) {
            assertEquals(CLIENT_ID, exchange.getRequestHeaders().getFirst(
                    HostedHarnessClient.CLIENT_ID_HEADER));
        } else if (!requireClientId) {
            assertNull(exchange.getRequestHeaders().getFirst(
                    HostedHarnessClient.CLIENT_ID_HEADER));
        }
    }
}
