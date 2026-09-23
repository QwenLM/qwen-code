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
                            .managedSessionStore(
                                    ManagedSessionStoreConnection.builder()
                                            .baseUri(URI.create(
                                                    "https://store.example/"))
                                            .tenantId("tenant-a")
                                            .workspaceId("workspace-a")
                                            .writerId(BOOT_ID)
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
        assertTrue(body.get().contains("\"managedSessionStore\":{"
                + "\"baseUrl\":\"https://store.example\","));
        assertTrue(body.get().contains("\"tenantId\":\"tenant-a\""));
        assertTrue(body.get().contains(
                "\"workspaceId\":\"workspace-a\""));
        assertTrue(body.get().contains("\"writerId\":\"" + BOOT_ID
                + "\""));
        assertTrue(body.get().contains("\"leaseDurationMs\":45000"));
        assertFalse(body.get().contains("cwd"));
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
                                            .build()));
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
        assertTrue(loadBody.get().contains(
                "\"baseUrl\":\"https://store.example\""));
        assertTrue(loadBody.get().contains("\"writerId\":\"" + BOOT_ID
                + "\""));
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
            assertEquals("settled", recovery.getExecutions().get(0)
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

    private static void sendSessionNoContent(HttpExchange exchange)
            throws IOException {
        assertPrivateHeaders(exchange);
        exchange.getResponseHeaders().set(
                HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
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
