package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
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

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverExecutor = Executors.newCachedThreadPool();
        server.setExecutor(serverExecutor);
        server.createContext("/capabilities", exchange -> sendJson(exchange,
                200, capabilitiesJson(DIGEST, BOOT_ID), false));
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

    @Test
    void rejectsAKnownOutcomeWithoutStatus() {
        // F1: a "known" outcome without its status must fail at the
        // constructor instead of NPE-ing later in isContinuationReady().
        assertThrows(NullPointerException.class,
                () -> new HarnessRuntimeExecutionRecovery("call-1", "tool",
                        "execution-1", "runtime-1", null, "known", null));
    }

    @Test
    void computesAProcessIndependentPayloadDigest() {
        // R1-6: the digest is the wire dedup key, so equal content must
        // hash identically no matter the map implementation or insertion
        // order; the constant pins the sorted-key canonical form.
        Map<String, Object> insertionOrdered = new LinkedHashMap<>();
        insertionOrdered.put("type", "text");
        insertionOrdered.put("text", "hello");
        Map<String, Object> reverseOrdered = new LinkedHashMap<>();
        reverseOrdered.put("text", "hello");
        reverseOrdered.put("type", "text");

        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(Map.of("type", "text", "text", "hello")));
        assertEquals("sha256:"
                + "57e90e6cb7aff1276e78399ad62cee581909f0d4944c24801d529c141c23a241",
                digest);
        assertEquals(digest, SubmitHarnessTurn.computePayloadDigest(
                List.of(insertionOrdered)));
        assertEquals(digest, SubmitHarnessTurn.computePayloadDigest(
                List.of(reverseOrdered)));

        // The hosted route re-derives the digest from the received `prompt`
        // member's bytes, so the wire form and the hashed form must be one
        // value. addText is the deterministic arm: its block arrives type-
        // first, while the canonical wire form (and the digest) is text-
        // first — the two assertions are only simultaneously satisfiable
        // when toJson() emits exactly what was hashed.
        SubmitHarnessTurn turn = SubmitHarnessTurn.builder()
                .session(new HarnessSessionRef(SESSION_ID, CLIENT_ID,
                        BOOT_ID, "/workspace", null, null, null))
                .promptId(PROMPT_ID)
                .addText("hello")
                .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                        List.of(Map.of("text", "hello", "type", "text"))))
                .build();
        assertEquals("[{\"text\":\"hello\",\"type\":\"text\"}]",
                JsonSupport.encode(turn.toJson().get("prompt")));
        assertEquals(digest, turn.getPayloadDigest());
    }

    @Test
    void aRejectedAdmissionDoesNotWedgeTheSession() {
        // R1-2: a 409 rejects this promptId definitively, so no terminal
        // event can ever clear a marker keyed by it; it must be dropped
        // and surfaced as PromptAlreadyActiveException.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendSessionJson(exchange, 409,
                                "{\"code\":\"hosted_turn_active\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "conflict");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            PromptAlreadyActiveException conflict = assertThrows(
                    PromptAlreadyActiveException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            // The wire refusal carries its status and machine-readable
            // code through to the caller.
            assertEquals(409, conflict.getStatusCode());
            assertEquals("hosted_turn_active", conflict.getCode());
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void aSessionClosingConflictCarriesItsRefusalCode() {
        // The 409 vocabulary is wider than a turn conflict: a refusal
        // emitted because the session is closing must surface its own
        // code, not the conflict's.
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> sendSessionJson(exchange, 409,
                        "{\"code\":\"hosted_session_closing\"}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "closing");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            PromptAlreadyActiveException refusal = assertThrows(
                    PromptAlreadyActiveException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(409, refusal.getStatusCode());
            assertEquals("hosted_session_closing", refusal.getCode());
        }
    }

    @Test
    void aRecoveryRequiredRefusalKeepsTheOwnedMarker() {
        // R4-1: hosted_prompt_recovery_required is answered from the
        // route's hasAcceptedInput gate, so it fires precisely because
        // this promptId already sits in the durable input log and the
        // daemon still owes it a terminal event. Releasing the marker
        // here would let a second prompt identity be admitted into a
        // session with two unsettled inputs, which fails every recovery
        // entrance closed permanently; the marker must stay until a
        // terminal event or a status read clears it.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 409,
                            "{\"code\":\"hosted_prompt_recovery_required\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "recovery-required");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            PromptAlreadyActiveException refusal = assertThrows(
                    PromptAlreadyActiveException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(409, refusal.getStatusCode());
            assertEquals("hosted_prompt_recovery_required",
                    refusal.getCode());
            // The retained marker still owns the session: a different
            // identity is vetoed locally and never reaches the wire.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
        }

        assertEquals(1, promptCalls.get());
    }

    @Test
    void anUnfencedDefinitiveRefusalKeepsTheRetainedEntry() {
        // F2: an outcome-unknown first attempt retains the slot so the
        // same identity can retry. A definitive refusal produced before
        // the route's promptId lookup says nothing about that earlier
        // submission, so the retained entry stays; only a terminal event
        // or a status read may clear it. The fixture must use a status the
        // fence check actually rejects: 401/403 are exempt from the
        // boot-id requirement, so the boot-headerless refusal here is a
        // 413 from an intermediary's body-size page.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendSessionJson(exchange, 503,
                                "{\"code\":\"temporarily_unavailable\"}");
                        return;
                    }
                    sendJson(exchange, 413,
                            "{\"error\":\"payload_too_large\"}", false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry-definitive");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn attached = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(attached));
            DaemonHttpException refusal = assertThrows(
                    DaemonHttpException.class,
                    () -> client.submitTurn(attached));
            assertEquals(413, refusal.getStatusCode());
            // The retained entry still owns the session: a different
            // identity is vetoed locally.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void aFencedDefinitiveRefusalReleasesTheOwnedEntry() {
        // The fenced half of the definitive-refusal arm: a non-409 4xx
        // that passed the fencing middleware (here: a 400 from the
        // route's own body validation) proves this submission was not
        // admitted, so the marker this call owns is released and a
        // different identity still reaches the wire. The unfenced twin
        // covers a refusal produced before the middleware.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendSessionJson(exchange, 400,
                                "{\"code\":\"bad_request\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "fenced-definitive");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            DaemonHttpException refusal = assertThrows(
                    DaemonHttpException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(400, refusal.getStatusCode());
            // The released marker must not veto a different identity.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void aStaleStatusReadClearsOnlyItsOwnPromptSnapshot() throws Exception {
        // R1-4: hasActivePrompt:false describes the moment the server
        // evaluated it; it must not delete a different prompt identity
        // registered while the status request was in flight.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    String promptId = promptCalls.incrementAndGet() == 1
                            ? PROMPT_ID : SECOND_PROMPT_ID;
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + promptId
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> sendSse(exchange, terminalEvent(1, PROMPT_ID),
                        EVENT_EPOCH, BOOT_ID));
        CountDownLatch statusEntered = new CountDownLatch(1);
        CountDownLatch statusRelease = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> {
                    statusEntered.countDown();
                    try {
                        statusRelease.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"hasActivePrompt\":false}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "race");

        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            PromptReceipt first = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            ExecutorService callers = Executors.newSingleThreadExecutor();
            try {
                Future<?> statusCall = callers.submit(() -> {
                    client.getStatus(session);
                    return null;
                });
                assertTrue(statusEntered.await(5, TimeUnit.SECONDS));
                // Inside the status round trip: P1's terminal event clears
                // its entry and P2 registers.
                try (HarnessEventStream stream = client.streamEvents(
                        StreamHarnessEvents.builder()
                                .session(session)
                                .lastEventId(first.getLastEventId())
                                .eventEpoch(first.getEventEpoch())
                                .build())) {
                    assertEquals("turn_complete", stream.next().getType());
                }
                assertNotNull(client.submitTurn(
                        SubmitHarnessTurn.builder()
                                .session(session)
                                .promptId(SECOND_PROMPT_ID)
                                .addContent(block)
                                .payloadDigest(
                                        SubmitHarnessTurn
                                                .computePayloadDigest(
                                                        List.of(block)))
                                .build()));
                statusRelease.countDown();
                statusCall.get(5, TimeUnit.SECONDS);
            } finally {
                callers.shutdownNow();
            }
            // The stale snapshot may only clear P1's entry: P2 is still the
            // registered identity, so a third one is vetoed client-side.
            assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(
                                    "66666666-6666-4666-8666-666666666666")
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(2, promptCalls.get());
        } finally {
            statusRelease.countDown();
            client.close();
        }
    }

    @Test
    void aStatusReadRacingAnInFlightSubmissionKeepsItsMarker()
            throws Exception {
        // The status answer describes the moment the server evaluated it:
        // served while a prompt POST is still in flight, it predates the
        // admission and must not clear that submission's marker. Nothing
        // would restore a cleared marker, so the local one-turn veto would
        // be gone for the rest of the turn.
        createSessionRoute();
        CountDownLatch sawPrompt = new CountDownLatch(1);
        CountDownLatch answerPrompt = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    String promptId = promptCalls.incrementAndGet() == 1
                            ? PROMPT_ID : SECOND_PROMPT_ID;
                    sawPrompt.countDown();
                    try {
                        answerPrompt.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + promptId
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "status-race");
        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            ExecutorService callers = Executors.newSingleThreadExecutor();
            try {
                Future<?> submission = callers.submit(() -> {
                    client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build());
                    return null;
                });
                assertTrue(sawPrompt.await(5, TimeUnit.SECONDS));
                // The POST is parked server-side; the status answer
                // (hasActivePrompt:false) evaluates before the admission.
                client.getStatus(session);
                answerPrompt.countDown();
                submission.get(10, TimeUnit.SECONDS);
                // The in-flight submission was admitted after the status
                // answer: its marker must have survived, so a different
                // identity is vetoed locally and never reaches the wire.
                DaemonException veto = assertThrows(DaemonException.class,
                        () -> client.submitTurn(SubmitHarnessTurn.builder()
                                .session(session)
                                .promptId(SECOND_PROMPT_ID)
                                .addContent(block)
                                .payloadDigest(digest)
                                .build()));
                assertEquals(
                        "Hosted Harness session already has a running turn",
                        veto.getMessage());
                assertEquals(1, promptCalls.get());
            } finally {
                callers.shutdownNow();
            }
        } finally {
            answerPrompt.countDown();
            client.close();
        }
    }

    @Test
    void aSettledStatusReadClearsTheRegisteredMarker() {
        // R4-7: the positive control for the observedSettled gate. A status
        // answer evaluated after the owning submission settled describes a
        // server that holds no active prompt, so it may clear the marker —
        // the only recovery path for a retained outcome-unknown entry. The
        // settled submission fully returns before the status read starts,
        // so the read snapshots the same ActivePrompt instance the map
        // holds (ActivePrompt has no equals/hashCode; remove(key, value)
        // matches only the identical instance).
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    String promptId = promptCalls.incrementAndGet() == 1
                            ? PROMPT_ID : SECOND_PROMPT_ID;
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + promptId
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "status-clears");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            assertFalse(client.getStatus(session).hasActivePrompt());
            // The cleared marker must not veto a different identity: the
            // second submission is admitted and reaches the wire.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void anActiveStatusReadKeepsTheSettledMarker() {
        // The !active conjunct of the status-read gate: a settled marker
        // must survive a status answer reporting a turn still running.
        // Clearing it would forget which prompt the running turn belongs
        // to, fail the local one-turn veto open, and hand the route a
        // spurious hosted_turn_active conflict against a healthy session.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":true}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "status-keeps");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            // The submission settles (202 through the success path) before
            // the status read starts, so observedSettled alone would let
            // the clear through if !active were dropped.
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            assertTrue(client.getStatus(session).hasActivePrompt());
            // The marker survives: a different identity is still vetoed
            // locally and never reaches the wire.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
        }

        assertEquals(1, promptCalls.get());
    }

    @Test
    void aSameIdentityRetrySettlesTheRegisteredMarker() throws Exception {
        // While the owning submission is still in flight, a same-identity
        // retry's concluded send must settle the REGISTERED marker — the
        // entry the map holds — not the retry's own orphan candidate, or
        // no later status read can ever clear it.
        createSessionRoute();
        CountDownLatch sawFirst = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    String promptId = call == 3 ? SECOND_PROMPT_ID
                            : PROMPT_ID;
                    if (call == 1) {
                        sawFirst.countDown();
                        try {
                            releaseFirst.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + promptId
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry-settles");

        HostedHarnessClient client = newClient();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            Future<Throwable> inFlight = caller.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(sawFirst.await(5, TimeUnit.SECONDS));
            // Same promptId and digest: the retry registers nothing and
            // its 202 settles the first call's entry.
            assertNotNull(client.submitTurn(first));
            // The owning submission is still parked, so the status read
            // can clear the marker only if the retry settled the instance
            // the map holds.
            assertFalse(client.getStatus(session).hasActivePrompt());
            releaseFirst.countDown();
            assertNull(inFlight.get(5, TimeUnit.SECONDS));
            // The cleared marker must not veto a different identity.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
        } finally {
            releaseFirst.countDown();
            caller.shutdownNow();
            client.close();
        }

        assertEquals(3, promptCalls.get());
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
    void aBootHeaderlessSessionCreationIsOutcomeUnknown() {
        // R1-5: a response that never passed the fencing middleware (for
        // example a gateway 502 page) cannot prove the POST did not run.
        AtomicInteger sessions = new AtomicInteger();
        server.createContext("/session", exchange -> {
            if (sessions.incrementAndGet() == 1) {
                sendJson(exchange, 502, "bad gateway", false);
                return;
            }
            sendSessionJson(exchange, 200, sessionJson());
        });

        try (HostedHarnessClient client = newClient()) {
            assertThrows(SessionCreationOutcomeUnknownException.class,
                    () -> createSession(client));
            assertNotNull(createSession(client));
        }

        assertEquals(2, sessions.get());
    }

    @Test
    void aBootHeaderlessPromptResponseIsAdmissionUnknown() {
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendJson(exchange, 502, "bad gateway", false);
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "gateway");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn attached = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(attached));
            assertEquals(PROMPT_ID,
                    client.submitTurn(attached).getPromptId());
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void aBootHeaderlessMutationResponseIsOutcomeUnknown() {
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> sendJson(exchange, 502, "bad gateway", false));

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.detachSession(session));
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
    void closeByRefTreatsAnAbsentHarnessSessionAsClosed() throws Exception {
        // R1-3: a definitive 404 means the session is already gone, so the
        // local attachment and its heartbeat timer must be torn down.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger deletes = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID,
                exchange -> {
                    deletes.incrementAndGet();
                    sendSessionJson(exchange, 404,
                            "{\"code\":\"session_not_found\"}");
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            client.closeSession(session);
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
        } finally {
            client.close();
        }
        assertEquals(1, deletes.get());
    }

    @Test
    void aBootHeaderlessCloseKeepsTheAttachment() throws Exception {
        // A gateway-shaped 502 on the private DELETE channel is
        // outcome-unknown: the attachment and its heartbeat survive
        // (definitive answers are the only ones that retire it).
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendJson(exchange, 502, "bad gateway", false));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.closeSession(session));
            Thread.sleep(60);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertTrue(heartbeats.get() > first,
                    "heartbeat must keep beating after an unknown answer");
        } finally {
            client.close();
        }
    }

    @Test
    void detachingAnAbsentSessionStopsTheHeartbeat() throws Exception {
        // R1-46: same definitive-404 tolerance as closeSession(ref).
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger detaches = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    detaches.incrementAndGet();
                    sendSessionJson(exchange, 404,
                            "{\"code\":\"session_not_found\"}");
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            client.detachSession(session);
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
        } finally {
            client.close();
        }
        assertEquals(1, detaches.get());
    }

    @Test
    void snapshotDeliversTheIdlessFrameThenLiveEvents() {
        // R1-47: the daemon answers ?snapshot=1 with an id-less synthetic
        // session_snapshot frame; the shared parser must accept it.
        createSessionRoute();
        AtomicReference<String> query = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    query.set(exchange.getRequestURI().getQuery());
                    sendSse(exchange,
                            "event: session_snapshot\n"
                                    + "data: {\"v\":1,"
                                    + "\"type\":\"session_snapshot\","
                                    + "\"data\":{\"sessionId\":\""
                                    + SESSION_ID + "\"}}\n\n"
                                    + terminalEvent(1, PROMPT_ID),
                            EVENT_EPOCH, BOOT_ID);
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .snapshot(true)
                            .build())) {
                assertEquals("session_snapshot", stream.next().getType());
                assertEquals("turn_complete", stream.next().getType());
                assertNull(stream.next());
            }
        }

        assertEquals("snapshot=1", query.get());
    }

    @Test
    void streamEventsFencesAndResumesFromTheRefsWatermark() {
        // R1-44: a caller that omits the resume pair still gets the epoch
        // fence and the Last-Event-ID cursor from the session ref.
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithResultsReadyRuntimeRecovery()
                                .replace("\"lastEventId\":0",
                                        "\"lastEventId\":7")));
        AtomicReference<String> lastEventId = new AtomicReference<>();
        AtomicReference<String> epochHeader = new AtomicReference<>();
        AtomicInteger mode = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    lastEventId.set(exchange.getRequestHeaders().getFirst(
                            "Last-Event-ID"));
                    epochHeader.set(exchange.getRequestHeaders().getFirst(
                            HostedHarnessClient.EVENT_EPOCH_HEADER));
                    if (mode.get() == 0) {
                        sendSse(exchange, "", "different-epoch", BOOT_ID);
                        return;
                    }
                    sendSse(exchange, terminalEvent(8, PROMPT_ID),
                            EVENT_EPOCH, BOOT_ID);
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            assertThrows(DaemonProtocolException.class,
                    () -> client.streamEvents(StreamHarnessEvents.builder()
                            .session(session)
                            .build()));
            mode.set(1);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .build())) {
                assertEquals("turn_complete", stream.next().getType());
                assertNull(stream.next());
            }
        }

        assertEquals("7", lastEventId.get());
        assertEquals(EVENT_EPOCH, epochHeader.get());
    }

    @Test
    void anExplicitResumePairWinsOverTheRefsWatermark() {
        // The fallback half is only half the contract: an explicitly
        // supplied cursor/epoch must beat the ref's watermark, or the
        // coordinator's advancing per-turn cursor is silently discarded.
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithResultsReadyRuntimeRecovery()
                                .replace("\"lastEventId\":0",
                                        "\"lastEventId\":7")));
        AtomicReference<String> lastEventId = new AtomicReference<>();
        AtomicReference<String> epochHeader = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    lastEventId.set(exchange.getRequestHeaders().getFirst(
                            "Last-Event-ID"));
                    epochHeader.set(exchange.getRequestHeaders().getFirst(
                            HostedHarnessClient.EVENT_EPOCH_HEADER));
                    sendSse(exchange, terminalEvent(5, PROMPT_ID),
                            "override-epoch", BOOT_ID);
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .lastEventId(4)
                            .eventEpoch("override-epoch")
                            .build())) {
                assertEquals("turn_complete", stream.next().getType());
                assertNull(stream.next());
            }
        }

        assertEquals("4", lastEventId.get());
        assertEquals("override-epoch", epochHeader.get());
    }

    @Test
    void anExplicitZeroCursorReplaysFromTheBeginning() {
        // An explicit 0 cursor is a deliberate replay from the beginning
        // (HarnessCoordinator passes exactly 0 for a turn row without a
        // recorded watermark), so it must not be replaced by the ref's
        // watermark.
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithResultsReadyRuntimeRecovery()
                                .replace("\"lastEventId\":0",
                                        "\"lastEventId\":7")));
        AtomicReference<String> lastEventId = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    lastEventId.set(exchange.getRequestHeaders().getFirst(
                            "Last-Event-ID"));
                    sendSse(exchange, terminalEvent(1, PROMPT_ID),
                            EVENT_EPOCH, BOOT_ID);
                });

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .lastEventId(0)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                assertEquals("turn_complete", stream.next().getType());
                assertNull(stream.next());
            }
        }

        assertEquals("0", lastEventId.get());
    }

    @Test
    void aDefinitiveBootHeaderlessDeleteKeepsItsStatus() {
        // The private closeSession channel has its own wrap site; a
        // definitive unfenced refusal keeps its status there too.
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendJson(exchange, 413,
                        "Request body too large", false));

        try (HostedHarnessClient client = newClient()) {
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.closeSession(SESSION_ID));
            assertEquals(413, failure.getStatusCode());
        }
    }

    @Test
    void closeReleasesAConsumerBlockedInNext() throws Exception {
        // R1-1: close() must not park behind a next() that is blocked in
        // the socket read; aborting works out of band and the consumer
        // fails with DaemonTransportException.
        createSessionRoute();
        CountDownLatch headersSent = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().flush();
                    headersSent.countDown();
                    try {
                        release.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.close();
                });

        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build());
            ExecutorService consumer = Executors.newSingleThreadExecutor();
            try {
                Future<Throwable> blocked = consumer.submit(() -> {
                    try {
                        stream.next();
                        return null;
                    } catch (Throwable failure) {
                        return failure;
                    }
                });
                assertTrue(headersSent.await(5, TimeUnit.SECONDS));
                Thread.sleep(150);
                assertTimeoutPreemptively(Duration.ofSeconds(5),
                        client::close);
                assertTrue(blocked.get(5, TimeUnit.SECONDS)
                        instanceof DaemonTransportException);
            } finally {
                consumer.shutdownNow();
            }
        } finally {
            release.countDown();
            client.close();
        }
    }

    @Test
    void anIdlePeerFailsTheStreamWithinTheIdleBudget() throws Exception {
        // R1-43: a peer that stops writing without closing must not park
        // the consumer forever; the idle watchdog closes the stream and
        // next() reports the idle timeout.
        createSessionRoute();
        CountDownLatch headersSent = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    headersSent.countDown();
                    try {
                        release.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.close();
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .sseIdleTimeout(Duration.ofMillis(500))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                assertTrue(headersSent.await(5, TimeUnit.SECONDS));
                DaemonEvent first = assertTimeoutPreemptively(
                        Duration.ofSeconds(5), stream::next);
                assertEquals("turn_complete", first.getType());
                DaemonTransportException failure = assertThrows(
                        DaemonTransportException.class,
                        () -> assertTimeoutPreemptively(
                                Duration.ofSeconds(10), stream::next));
                assertTrue(failure.getMessage().contains("idle timeout"),
                        failure.getMessage());
                // A caller arriving after the out-of-band abort gets the
                // same DaemonException-family signal from the closed
                // guard, not the caller-initiated IllegalStateException.
                DaemonTransportException late = assertThrows(
                        DaemonTransportException.class, stream::next);
                assertTrue(late.getMessage().contains("idle timeout"),
                        late.getMessage());
            }
        } finally {
            release.countDown();
            client.close();
        }
    }

    @Test
    void closeSessionByIdFailsFastAfterClientClose() {
        // closeSession(String) now has the same ensureOpen() guard as every
        // other public entry, so the closed-client path is JVM-independent:
        // IllegalStateException on every release floor, and no DELETE ever
        // reaches the wire. The terminated-executor saturated classification
        // is pinned separately by aTerminatedHttpExecutorReleasesTheOwnedMarker.
        AtomicInteger deletes = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID, exchange -> {
            deletes.incrementAndGet();
            sendSessionNoContent(exchange);
        });

        HostedHarnessClient client = newClient();
        client.close();
        IllegalStateException failure = assertThrows(
                IllegalStateException.class,
                () -> client.closeSession(SESSION_ID));
        assertEquals("HostedHarnessClient is closed",
                failure.getMessage());
        assertEquals(0, deletes.get());
    }

    @Test
    void aConsumerStallBetweenReadsKeepsAHealthyStream() throws Exception {
        // The idle budget measures peer silence while a consumer is parked
        // in next(); time between calls (a blocking queue handoff, a slow
        // event handler) is not charged, so a healthy peer survives a
        // consumer stall of several budgets. The keepalives stop before
        // the stall and the peer answers a beat after it, so the socket is
        // empty when the consumer parks again: the answer delay sits
        // between one watchdog tick and the budget, a window only the
        // entry stamp in next() survives.
        createSessionRoute();
        CountDownLatch stopKeepalives = new CountDownLatch(1);
        CountDownLatch stallOver = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    try {
                        while (!stopKeepalives.await(120,
                                TimeUnit.MILLISECONDS)) {
                            try {
                                exchange.getResponseBody().write(
                                        ": keepalive\n\n".getBytes(
                                                StandardCharsets.UTF_8));
                                exchange.getResponseBody().flush();
                            } catch (IOException writeFailed) {
                                // The client went away mid-stream.
                                return;
                            }
                        }
                        stallOver.await(15, TimeUnit.SECONDS);
                        // Strictly between one watchdog tick (200 ms) and
                        // the idle budget (400 ms): with the entry stamp
                        // the first tick after the consumer parks again
                        // measures ~250 ms and the stream survives;
                        // without it the tick measures the whole stall and
                        // aborts the stream.
                        Thread.sleep(250);
                        exchange.getResponseBody().write(terminalEvent(2,
                                PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                        exchange.getResponseBody().flush();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.close();
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .sseIdleTimeout(Duration.ofMillis(400))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                assertEquals("turn_complete", stream.next().getType());
                // Stop the keepalives before the stall so the socket is
                // empty when the consumer parks again; three idle budgets
                // pass between pulls, none of it charged.
                stopKeepalives.countDown();
                Thread.sleep(1200);
                stallOver.countDown();
                DaemonEvent second = assertTimeoutPreemptively(
                        Duration.ofSeconds(10), stream::next);
                assertEquals("turn_complete", second.getType());
                assertEquals(Long.valueOf(2), second.getId());
                assertNull(stream.next());
            }
        } finally {
            stopKeepalives.countDown();
            stallOver.countDown();
            client.close();
        }
    }

    @Test
    void aKeepaliveOnlyPeerStaysUsablePastTheIdleBudget() throws Exception {
        // A peer that stays alive through keepalive comments must not trip
        // the watchdog: the hosted events route emits these during
        // legitimately silent phases (long tool calls, approval waits).
        createSessionRoute();
        CountDownLatch stopKeepalives = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().flush();
                    try {
                        // The handler thread must own the keepalive loop:
                        // returning from the handler closes the exchange.
                        // 120ms cadence against the 500ms budget below keeps
                        // >4x margin against scheduler jitter.
                        while (!stopKeepalives.await(120,
                                TimeUnit.MILLISECONDS)) {
                            exchange.getResponseBody().write(
                                    ": keepalive\n\n".getBytes(
                                            StandardCharsets.UTF_8));
                            exchange.getResponseBody().flush();
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    exchange.close();
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .sseIdleTimeout(Duration.ofMillis(500))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                // Positive control for the disable case below: the
                // watchdog must be sitting in the live pool's delay queue
                // (read before any shutdown, where shutdownNow would
                // already have removed it).
                assertTrue(client.scheduler().getQueue().size() > 0);
                // Consumer parked in read for three idle budgets while the
                // peer proves liveness only with keepalive comments: the
                // refills stamp the budget, so the stream must survive.
                ExecutorService consumer = Executors.newSingleThreadExecutor();
                try {
                    Future<DaemonEvent> event = consumer.submit(
                            () -> assertTimeoutPreemptively(
                                    Duration.ofSeconds(8), stream::next));
                    Thread.sleep(1300);
                    stopKeepalives.countDown();
                    assertEquals("turn_complete",
                            event.get(10, TimeUnit.SECONDS).getType());
                } finally {
                    consumer.shutdownNow();
                }
                assertNull(stream.next());
            }
        } finally {
            stopKeepalives.countDown();
            client.close();
        }
    }

    @Test
    void aZeroIdleTimeoutDisablesTheWatchdog() throws Exception {
        // Builder.sseIdleTimeout(Duration.ZERO) hands the deadline to the
        // caller: a consumer parked in next() against a silent peer must
        // keep waiting instead of aborting at the first watchdog tick.
        createSessionRoute();
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().flush();
                    try {
                        release.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    exchange.close();
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .sseIdleTimeout(Duration.ZERO)
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                // The disable sentinel must leave nothing scheduled on the
                // client's scheduler; a refactor normalizing ZERO to the
                // 45-second default would park its watchdog in this queue.
                assertEquals(0, client.scheduler().getQueue().size());
                ExecutorService consumer =
                        Executors.newSingleThreadExecutor();
                try {
                    // Parked against a peer silent for several would-be
                    // watchdog intervals: with the watchdog disabled the
                    // event written afterwards still arrives.
                    Future<DaemonEvent> parked = consumer.submit(
                            stream::next);
                    Thread.sleep(500);
                    release.countDown();
                    DaemonEvent event = parked.get(10, TimeUnit.SECONDS);
                    assertEquals("turn_complete", event.getType());
                } finally {
                    consumer.shutdownNow();
                }
                assertNull(stream.next());
            }
        } finally {
            release.countDown();
            client.close();
        }
    }

    @Test
    void aWatchdogSchedulingFailureUnregistersTheStream()
            throws Exception {
        // client.close() racing a stream open has already shut the
        // scheduler down: arming the watchdog must surface the local
        // rejection as a DaemonTransportException (the mapping send()
        // uses), and must not strand the just-registered stream in the
        // client's set.
        createSessionRoute();
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().flush();
                    try {
                        release.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.close();
                });

        HostedHarnessClient client = newClient();
        HarnessEventStream stream = null;
        try {
            HarnessSessionRef session = createSession(client);
            stream = client.streamEvents(StreamHarnessEvents.builder()
                    .session(session)
                    .eventEpoch(EVENT_EPOCH)
                    .build());
            assertEquals(1, client.registeredStreamCount());
            client.scheduler().shutdownNow();
            DaemonTransportException failure = assertThrows(
                    DaemonTransportException.class,
                    stream::startIdleWatchdog);
            assertTrue(failure.getCause()
                    instanceof RejectedExecutionException);
            assertEquals(0, client.registeredStreamCount());
        } finally {
            release.countDown();
            if (stream != null) {
                stream.closeQuietly();
            }
            client.close();
        }
    }

    @Test
    void aFailedStreamCloseStillUnregistersTheStream() {
        // R4-5: close() rethrows a failed input.close() (a socket reset
        // while the daemon dies mid-turn) as DaemonTransportException; the
        // registration must still be dropped from the finally, or the
        // stranded entry keeps its growable frame buffer for the client's
        // lifetime and is re-closed from the client.close() snapshot on
        // every shutdown.
        createSessionRoute();
        InputStream failingOnClose = new InputStream() {
            @Override
            public int read() {
                return -1;
            }

            @Override
            public void close() throws IOException {
                throw new IOException("reset by peer");
            }
        };

        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            HarnessEventStream stream = new HarnessEventStream(client,
                    session, failingOnClose, 1024, 0, EVENT_EPOCH);
            client.registerStream(stream);
            assertEquals(1, client.registeredStreamCount());
            DaemonTransportException failure = assertThrows(
                    DaemonTransportException.class, stream::close);
            assertTrue(failure.getCause() instanceof IOException);
            assertEquals(0, client.registeredStreamCount());
        } finally {
            client.close();
        }
    }

    @Test
    void aQueuedReaderSeesTheClosedSignal() throws Exception {
        // A caller already queued on cursorLock when the stream closes must
        // get the closed-stream signal, not a transport error from reading
        // a torn-down stream.
        createSessionRoute();
        CountDownLatch headersSent = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().flush();
                    headersSent.countDown();
                    try {
                        release.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.close();
                });

        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build());
            ExecutorService readers = Executors.newFixedThreadPool(2);
            try {
                Future<Throwable> first = readers.submit(
                        () -> captureNext(stream));
                assertTrue(headersSent.await(5, TimeUnit.SECONDS));
                Thread.sleep(150);
                Future<Throwable> second = readers.submit(
                        () -> captureNext(stream));
                Thread.sleep(150);
                stream.close();
                assertTrue(first.get(5, TimeUnit.SECONDS)
                        instanceof DaemonTransportException);
                assertTrue(second.get(5, TimeUnit.SECONDS)
                        instanceof IllegalStateException);
            } finally {
                readers.shutdownNow();
            }
        } finally {
            release.countDown();
            client.close();
        }
    }

    @Test
    void aMidFlightRejectionKeepsAdmissionUnknown() throws Exception {
        // A rejection surfacing while delivering a response the server
        // already accepted cannot prove non-dispatch: it must stay
        // outcome-unknown and keep the active-prompt marker. JDK 11 parks
        // such sends instead of surfacing the rejection (probed on
        // 11/17/21), so the deterministic arm runs on 17+ only.
        Assumptions.assumeTrue(Runtime.version().feature() >= 17);
        createSessionRoute();
        CountDownLatch sawPrompt = new CountDownLatch(1);
        CountDownLatch answerPrompt = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sawPrompt.countDown();
                    try {
                        answerPrompt.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(2),
                runnable -> {
                    Thread thread = new Thread(runnable, "http-r1-5");
                    thread.setDaemon(true);
                    return thread;
                });
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .httpExecutorOverride(executor)
                .build();
        CountDownLatch parkerRelease = new CountDownLatch(1);
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "mid-flight");
            String digest = SubmitHarnessTurn.computePayloadDigest(
                    List.of(block));
            ExecutorService caller = Executors.newSingleThreadExecutor();
            try {
                Future<Throwable> submission = caller.submit(() -> {
                    try {
                        client.submitTurn(SubmitHarnessTurn.builder()
                                .session(session)
                                .promptId(PROMPT_ID)
                                .addContent(block)
                                .payloadDigest(digest)
                                .build());
                        return null;
                    } catch (Throwable failure) {
                        return failure;
                    }
                });
                assertTrue(sawPrompt.await(5, TimeUnit.SECONDS));
                // Park the only worker and fill its queue, so the response
                // delivery task is rejected after the server answered.
                CountDownLatch parkerEntered = new CountDownLatch(1);
                executor.execute(() -> {
                    parkerEntered.countDown();
                    try {
                        assertTrue(parkerRelease.await(15,
                                TimeUnit.SECONDS));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
                assertTrue(parkerEntered.await(5, TimeUnit.SECONDS));
                executor.execute(() -> {
                });
                executor.execute(() -> {
                });
                answerPrompt.countDown();
                Throwable outcome = submission.get(10, TimeUnit.SECONDS);
                assertTrue(outcome
                        instanceof PromptAdmissionUnknownException,
                        "expected admission unknown, got " + outcome);
                // Retained marker: a different identity is vetoed
                // locally by the marker itself, not by a second rejection
                // from the still-saturated executor.
                DaemonException veto = assertThrows(DaemonException.class,
                        () -> client.submitTurn(SubmitHarnessTurn.builder()
                                .session(session)
                                .promptId(SECOND_PROMPT_ID)
                                .addContent(block)
                                .payloadDigest(digest)
                                .build()));
                assertEquals(
                        "Hosted Harness session already has a running turn",
                        veto.getMessage());
                assertEquals(1, promptCalls.get());
            } finally {
                parkerRelease.countDown();
                caller.shutdownNow();
            }
        } finally {
            answerPrompt.countDown();
            client.close();
        }
    }

    @Test
    void aMidFlightExecutorShutdownKeepsAdmissionUnknown() throws Exception {
        // close() racing an in-flight send terminates the executor while
        // the request is already on the wire; the wrapped rejection must
        // keep its outcome-unknown classification (and the marker) instead
        // of certifying non-dispatch. Same JDK caveat as the queue-full
        // mid-flight case: 11 parks such sends, so this runs on 17+.
        Assumptions.assumeTrue(Runtime.version().feature() >= 17);
        createSessionRoute();
        CountDownLatch sawPrompt = new CountDownLatch(1);
        CountDownLatch answerPrompt = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sawPrompt.countDown();
                    try {
                        answerPrompt.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(2),
                runnable -> {
                    Thread thread = new Thread(runnable,
                            "http-mid-flight-close");
                    thread.setDaemon(true);
                    return thread;
                });
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .httpExecutorOverride(executor)
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "mid-flight-close");
            String digest = SubmitHarnessTurn.computePayloadDigest(
                    List.of(block));
            ExecutorService caller = Executors.newSingleThreadExecutor();
            try {
                Future<Throwable> submission = caller.submit(() -> {
                    try {
                        client.submitTurn(SubmitHarnessTurn.builder()
                                .session(session)
                                .promptId(PROMPT_ID)
                                .addContent(block)
                                .payloadDigest(digest)
                                .build());
                        return null;
                    } catch (Throwable failure) {
                        return failure;
                    }
                });
                assertTrue(sawPrompt.await(5, TimeUnit.SECONDS));
                // The server has the request; terminating the executor now
                // only kills the response delivery task.
                executor.shutdownNow();
                answerPrompt.countDown();
                Throwable outcome = submission.get(10, TimeUnit.SECONDS);
                assertTrue(outcome
                        instanceof PromptAdmissionUnknownException,
                        "expected admission unknown, got " + outcome);
                // Retained marker: a different identity is vetoed locally.
                DaemonException veto = assertThrows(DaemonException.class,
                        () -> client.submitTurn(SubmitHarnessTurn.builder()
                                .session(session)
                                .promptId(SECOND_PROMPT_ID)
                                .addContent(block)
                                .payloadDigest(digest)
                                .build()));
                assertEquals(
                        "Hosted Harness session already has a running turn",
                        veto.getMessage());
                assertEquals(1, promptCalls.get());
            } finally {
                caller.shutdownNow();
            }
        } finally {
            answerPrompt.countDown();
            client.close();
        }
    }

    @Test
    void aTerminatedHttpExecutorReleasesTheOwnedMarker() {
        // A dispatch rejection against an already-terminated executor
        // proves the request never left the JVM: the failure is a
        // known-outcome DaemonTransportException and the marker this call
        // owned is released, so a different identity fails at dispatch too
        // rather than at the local one-turn veto. JDK 11 parks such sends
        // instead of surfacing the rejection (probed on 11/17/21), so the
        // deterministic arm runs on 17+ only.
        Assumptions.assumeTrue(Runtime.version().feature() >= 17);
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(2),
                runnable -> {
                    Thread thread = new Thread(runnable,
                            "http-terminated-before-send");
                    thread.setDaemon(true);
                    return thread;
                });
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .httpExecutorOverride(executor)
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            executor.shutdownNow();
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "terminated-executor");
            String digest = SubmitHarnessTurn.computePayloadDigest(
                    List.of(block));
            DaemonTransportException failure = assertThrows(
                    DaemonTransportException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build()));
            assertTrue(failure.getMessage().contains("saturated"),
                    failure.getMessage());
            assertEquals(0, promptCalls.get());
            // The released marker must not veto a different identity: the
            // second submission reaches dispatch and fails on the
            // terminated executor, it is not vetoed locally.
            DaemonTransportException second = assertThrows(
                    DaemonTransportException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build()));
            assertTrue(second.getMessage().contains("saturated"),
                    second.getMessage());
            assertEquals(0, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void anAdmissionUnknownMarkerRecoversThroughAStatusRead()
            throws Exception {
        // The IOException arm settles the retained marker, so a status
        // read answering hasActivePrompt:false clears it and a different
        // identity reaches the wire. The transport failure here is a
        // dropped connection — not an executor rejection, which kills the
        // client's selector manager and would make every later call fail
        // for an unrelated reason.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        // Drop the connection without a response: the send
                        // fails with an IOException after the request left
                        // the JVM, so the outcome is unknown.
                        exchange.close();
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "unknown-then-recovered");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            // Retained marker: a different identity is vetoed locally.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(1, promptCalls.get());
            // The status-read recovery: settled marker, no active prompt
            // server-side, so the read clears it.
            assertFalse(client.getStatus(session).hasActivePrompt());
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
            assertEquals(2, promptCalls.get());
        }
    }

    @Test
    void anUncheckedSendEscapeLeavesTheMarkerRecoverable() throws Exception {
        // An unchecked throwable escaping the send before dispatch (here:
        // the executor state probe inside send() raises a
        // SecurityException on the calling thread, before anything is
        // dispatched) proves the submission never reached the server, so
        // the marker this call owned is released — the same rule the
        // DaemonTransportException arm states for a locally rejected
        // send.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        AtomicBoolean failNextSend = new AtomicBoolean();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(0,
                Integer.MAX_VALUE, 60L, TimeUnit.SECONDS,
                new SynchronousQueue<>()) {
            @Override
            public boolean isShutdown() {
                if (failNextSend.getAndSet(false)) {
                    throw new SecurityException("synthetic send failure");
                }
                return super.isShutdown();
            }
        };
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .httpExecutorOverride(executor)
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "unchecked-escape");
            failNextSend.set(true);
            assertThrows(SecurityException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            // The dispatch failed before anything left the JVM.
            assertEquals(0, promptCalls.get());
            // The released marker must not veto a different identity: the
            // next submission reaches the wire with no status read.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
            assertFalse(client.getStatus(session).hasActivePrompt());
        } finally {
            client.close();
            executor.shutdownNow();
        }

        assertEquals(1, promptCalls.get());
    }

    @Test
    void aDefinitiveBootHeaderless4xxKeepsItsStatus() {
        // An unfenced definitive refusal (server-side 4xx emitted before
        // the fencing middleware) is not outcome-unknown: it is the
        // server's own answer and must carry its status. The refusal also
        // proves this submission was never admitted, so the marker this
        // call owned is released and a different identity still reaches
        // the wire.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendJson(exchange, 413,
                                "Request body too large", false);
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "big");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            assertEquals(413, failure.getStatusCode());
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void aRefusedDetachStillTearsDownTheHeartbeat() throws Exception {
        // Any definitive detach answer (here: 403 after an auth
        // revocation) must still retire the local attachment; the
        // ambiguous statuses are the only ones that keep it.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> sendSessionJson(exchange, 403,
                        "{\"code\":\"forbidden\"}"));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.detachSession(session));
            assertEquals(403, failure.getStatusCode());
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aRefusedCloseStillTearsDownTheHeartbeat() throws Exception {
        // Mirror of the detach teardown rule on the close path: a
        // definitive refusal (DELETE 403) still retires the attachment
        // and the ledger.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendSessionJson(exchange, 403,
                        "{\"code\":\"forbidden\"}"));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "refused-close");
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.closeSession(session));
            assertEquals(403, failure.getStatusCode());
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            // The ledger retired with the attachment: a different identity
            // is not vetoed locally and reaches the wire.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
            assertEquals(2, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aRefusedCloseByIdStillTearsDownTheHeartbeat() throws Exception {
        // Same teardown rule for the by-id overload.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendControlPlaneSessionJson(exchange, 403,
                        "{\"code\":\"forbidden\"}"));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "refused-close-by-id");
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.closeSession(session.getHarnessSessionId()));
            assertEquals(403, failure.getStatusCode());
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            // The ledger retired with the attachment here too.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
            assertEquals(2, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aDefinitiveUnfencedDetachRetiresTheAttachment() throws Exception {
        // An unfenced definitive answer (an intermediary's 413 page) is
        // raised by sendMutation itself, so detach's definitive arm can
        // only retire the attachment when the send sits inside its try.
        // The close path retires on this shape; the two must agree.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> sendJson(exchange, 413,
                        "Request body too large", false));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.detachSession(session));
            assertEquals(413, failure.getStatusCode());
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aDefinitiveUnfencedCloseRetiresTheAttachment() throws Exception {
        // The close half of the unfenced-definitive rule: the private
        // closeSession raises the DaemonHttpException inside its callers'
        // try, so the attachment retires exactly like detach's.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendJson(exchange, 413,
                        "Request body too large", false));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.closeSession(session));
            assertEquals(413, failure.getStatusCode());
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aTurnActiveCloseKeepsTheLedger() throws Exception {
        // A close refused 409 hosted_turn_active proves the turn is still
        // running server-side: the attachment (the client's own record)
        // is retired, but the admission ledger must survive — forgetting
        // it would fail the local one-turn veto open against the live
        // turn, and the next different-identity submission would spend a
        // round trip to be refused server-side.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendSessionJson(exchange, 409,
                        "{\"code\":\"hosted_turn_active\"}"));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "turn-active-close");
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.closeSession(session));
            assertEquals(409, failure.getStatusCode());
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            // The ledger survived: a different identity is still vetoed
            // locally and never reaches the wire.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(1, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aTurnActiveCloseByIdKeepsTheLedger() throws Exception {
        // The by-id twin: the refusal code must reach
        // discardLocalSessionState, or the production-facing overload
        // drops the ledger on a hosted_turn_active refusal.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendControlPlaneSessionJson(exchange, 409,
                        "{\"code\":\"hosted_turn_active\"}"));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "turn-active-close-by-id");
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.closeSession(session.getHarnessSessionId()));
            assertEquals(409, failure.getStatusCode());
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(1, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aGenerationChangeCloseRetiresLocalState() throws Exception {
        // A DELETE fenced with a NEW boot id proves the daemon process
        // restarted: every local record for that peer is dead, so the
        // close retires the attachment AND the admission ledger even
        // though the answer escaped as HostedHarnessGenerationException
        // rather than DaemonHttpException.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        AtomicBoolean restarted = new AtomicBoolean();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}",
                            true,
                            restarted.get() ? OTHER_BOOT_ID : BOOT_ID);
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendJson(exchange, 404,
                        "{\"code\":\"session_not_found\"}", true,
                        OTHER_BOOT_ID));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "generation-close");
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            restarted.set(true);
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.closeSession(session));
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            // The ledger retired with the attachment: a different identity
            // is not vetoed locally and reaches the wire, where the
            // restarted generation refuses it.
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(2, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void anUnexpectedDetachAnswerKeepsTheAttachment() throws Exception {
        // An unexpected-success detach is outcome-unknown: the attachment
        // and its heartbeat must survive — it is the client's only
        // liveness probe for this ref and its record that the ref is
        // still attached, while the server may still be deciding.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"detached\":true}"));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.detachSession(session));
            Thread.sleep(60);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertTrue(heartbeats.get() > first,
                    "heartbeat must keep beating after an unknown answer");
        } finally {
            client.close();
        }
    }

    @Test
    void anUnexpectedCloseAnswerKeepsTheAttachment() throws Exception {
        // Same outcome-unknown survival on the close path.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendSessionJson(exchange, 200,
                        "{\"closed\":true}"));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.closeSession(session));
            Thread.sleep(60);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertTrue(heartbeats.get() > first,
                    "heartbeat must keep beating after an unknown answer");
        } finally {
            client.close();
        }
    }

    @Test
    void aGenerationChangePromptRetiresTheLedger() {
        // The prompt-path twin of aGenerationChangeCloseRetiresLocalState:
        // a fenced answer from a new boot id on the prompt channel proves
        // the daemon process restarted, so the admission ledger entry
        // retires with the rest of the peer's local state instead of
        // vetoing every later identity for the client's lifetime.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        sendSessionJson(exchange, 202,
                                "{\"promptId\":\"" + PROMPT_ID
                                        + "\",\"lastEventId\":0,"
                                        + "\"eventEpoch\":\""
                                        + EVENT_EPOCH + "\"}");
                        return;
                    }
                    sendJson(exchange, 404,
                            "{\"code\":\"session_not_found\"}", true,
                            OTHER_BOOT_ID);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "generation-prompt");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertNotNull(client.submitTurn(first));
            // The same-identity retry reaches the restarted peer's fence.
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.submitTurn(first));
            // The ledger retired with it: a different identity is not
            // vetoed locally and reaches the wire, where the restarted
            // generation refuses it.
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(3, promptCalls.get());
        }
    }

    @Test
    void aHeartbeatObservedRestartRetiresLocalState() throws Exception {
        // The scheduled heartbeat is the one periodic call that observes a
        // daemon restart: when its fence proves a generation change, every
        // local record for that peer is dead, so the heartbeat retires the
        // attachment AND the admission ledger instead of letting the
        // ledger's veto wedge the session for the client's lifetime.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        AtomicInteger fencedHeartbeats = new AtomicInteger();
        AtomicBoolean restarted = new AtomicBoolean();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    if (restarted.get()) {
                        fencedHeartbeats.incrementAndGet();
                        sendJson(exchange, 200, "{}", true, OTHER_BOOT_ID);
                        return;
                    }
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\"" + EVENT_EPOCH
                                    + "\"}", true,
                            restarted.get() ? OTHER_BOOT_ID : BOOT_ID);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "generation-heartbeat");

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            restarted.set(true);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (fencedHeartbeats.get() == 0
                    && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            assertTrue(fencedHeartbeats.get() > 0,
                    "fenced heartbeat never fired");
            // The retirement settles: the heartbeat stops with the
            // attachment.
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            // The ledger retired too: a different identity reaches the
            // wire instead of being vetoed locally.
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(2, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aGenerationChangeDetachRetiresLocalState() throws Exception {
        // The detach twin of aGenerationChangeCloseRetiresLocalState: a
        // fenced answer from a new boot id on /detach proves the daemon
        // restarted, so detach retires the attachment AND the admission
        // ledger — every local record for that peer is dead.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\"" + EVENT_EPOCH
                                    + "\"}", true,
                            call == 1 ? BOOT_ID : OTHER_BOOT_ID);
                });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> sendJson(exchange, 404,
                        "{\"code\":\"session_not_found\"}", true,
                        OTHER_BOOT_ID));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "generation-detach");
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.detachSession(session));
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            // The ledger retired with the attachment: a different identity
            // is not vetoed locally and reaches the wire, where the
            // restarted generation refuses it.
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(2, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aGenerationChangeCloseByIdRetiresLocalState() throws Exception {
        // The by-id twin of aGenerationChangeCloseRetiresLocalState: a
        // fenced 404 from a new boot id on the DELETE retires the
        // attachment AND the ledger through discardLocalSessionState even
        // though the answer escapes as HostedHarnessGenerationException —
        // provesLiveTurn requires a DaemonHttpException, so the generation
        // branch never keeps the ledger. The by-id overload sends no
        // client-id header, so the fixture uses the control-plane shape.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\"" + EVENT_EPOCH
                                    + "\"}", true,
                            call == 1 ? BOOT_ID : OTHER_BOOT_ID);
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendJson(exchange, 404,
                        "{\"code\":\"session_not_found\"}", true,
                        OTHER_BOOT_ID, false));

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "generation-close-by-id");
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            awaitHeartbeat(heartbeats);
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.closeSession(
                            session.getHarnessSessionId()));
            Thread.sleep(100);
            int first = heartbeats.get();
            Thread.sleep(60);
            assertEquals(first, heartbeats.get());
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals(2, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aRacingStatusReadCannotClearAReAdmittedMarker() throws Exception {
        // A status read snapshots the registered entry before sending; a
        // same-identity retry admitted while that answer is in flight must
        // publish a fresh entry, or the stale snapshot's two-arg remove
        // clears the marker that is live now.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        // Outcome-unknown: the marker stays, settled,
                        // without anything admitted server-side.
                        sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        CountDownLatch statusSeen = new CountDownLatch(1);
        CountDownLatch releaseStatus = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> {
                    statusSeen.countDown();
                    try {
                        releaseStatus.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"hasActivePrompt\":false}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "readmission-race");

        HostedHarnessClient client = newClient();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            // The status read snapshots the settled marker, then parks
            // server-side.
            Future<Throwable> statusRead = caller.submit(() -> {
                try {
                    client.getStatus(session);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(statusSeen.await(5, TimeUnit.SECONDS));
            // The same-identity retry is admitted while the status answer
            // is in flight.
            assertNotNull(client.submitTurn(first));
            releaseStatus.countDown();
            assertNull(statusRead.get(5, TimeUnit.SECONDS));
            // The stale snapshot must not clear the live marker: a
            // different identity is still vetoed locally.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(2, promptCalls.get());
        } finally {
            releaseStatus.countDown();
            caller.shutdownNow();
            client.close();
        }
    }

    @Test
    void aDroppedRetrySendKeepsTheMarkerUnsettled() throws Exception {
        // The retry-failure twin of aSameIdentityRetrySettlesTheRegistered-
        // Marker: only the OWNING call's concluded send may settle the
        // marker, and every attempt re-arms it. A same-identity retry
        // whose send is dropped must leave the owner's marker unsettled,
        // so a following status read cannot clear it.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        // Outcome-unknown: retained, settled, nothing
                        // admitted server-side.
                        sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                        return;
                    }
                    // The retry's send is dropped before any answer.
                    exchange.close();
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry-dropped");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            // Same promptId and digest: the retry registers nothing, and
            // its dropped send must not settle the earlier entry.
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            // The status read answers no active prompt but must not clear
            // the unsettled marker...
            assertFalse(client.getStatus(session).hasActivePrompt());
            // ...so a different identity stays vetoed locally.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(2, promptCalls.get());
        }
    }

    @Test
    void aRefusedRetryDoesNotSettleTheMarker() {
        // The answered-refusal half of the per-attempt latch: a
        // same-identity retry whose concluded send is refused (here an
        // unfenced 401) must not settle the earlier entry either — the
        // refusal says nothing about the owner's admission window.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                        return;
                    }
                    sendJson(exchange, 401, "{\"error\":\"unauthorized\"}",
                            false);
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry-refused");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            DaemonHttpException refusal = assertThrows(
                    DaemonHttpException.class, () -> client.submitTurn(first));
            assertEquals(401, refusal.getStatusCode());
            // The retry's answered refusal did not settle the marker, so
            // the status read cannot clear it...
            assertFalse(client.getStatus(session).hasActivePrompt());
            // ...and a different identity stays vetoed locally.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(2, promptCalls.get());
        }
    }

    @Test
    void anErrorSendEscapeReleasesTheOwnedMarker() {
        // The Error half of the unchecked-escape arm: same pre-dispatch
        // shape as anUncheckedSendEscapeLeavesTheMarkerRecoverable, but
        // the probe raises an Error, which must release the owned marker
        // the same way.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        AtomicBoolean failNextSend = new AtomicBoolean();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(0,
                Integer.MAX_VALUE, 60L, TimeUnit.SECONDS,
                new SynchronousQueue<>()) {
            @Override
            public boolean isShutdown() {
                if (failNextSend.getAndSet(false)) {
                    throw new OutOfMemoryError("synthetic send failure");
                }
                return super.isShutdown();
            }
        };
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .httpExecutorOverride(executor)
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            Map<String, Object> block = Map.of(
                    "type", "text", "text", "error-escape");
            failNextSend.set(true);
            assertThrows(OutOfMemoryError.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            // The dispatch failed before anything left the JVM.
            assertEquals(0, promptCalls.get());
            // The released marker must not veto a different identity: the
            // next submission reaches the wire with no status read.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
        } finally {
            client.close();
            executor.shutdownNow();
        }

        assertEquals(1, promptCalls.get());
    }

    private static Throwable captureNext(HarnessEventStream stream) {
        try {
            stream.next();
            return null;
        } catch (Throwable failure) {
            return failure;
        }
    }

    private static void awaitHeartbeat(AtomicInteger heartbeats)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (heartbeats.get() == 0 && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertTrue(heartbeats.get() > 0, "heartbeat never fired");
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

    // Header-only SSE prelude for the streaming fixtures: the zero content
    // length keeps the response chunked and the exchange stays open so the
    // handler can keep writing frames, which is why the fixed-length
    // sendSse below cannot host this.
    private static void sendSseHeaders(HttpExchange exchange)
            throws IOException {
        exchange.getResponseHeaders().set("Content-Type",
                "text/event-stream");
        exchange.getResponseHeaders().set("Content-Encoding", "identity");
        exchange.getResponseHeaders().set(
                HostedHarnessClient.EVENT_EPOCH_HEADER, EVENT_EPOCH);
        exchange.getResponseHeaders().set(
                HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
        exchange.sendResponseHeaders(200, 0);
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
