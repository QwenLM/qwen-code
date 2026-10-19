package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Delayed;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

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

    @ParameterizedTest
    @MethodSource("lifecycleDetachResponses")
    void lifecycleDetachStopsHeartbeatOnlyAfterConfirmedAbsence(boolean byId, int status, boolean sameBoot) throws Exception {
        createSessionRoute();
        AtomicBoolean detached = new AtomicBoolean();
        CountDownLatch firstHeartbeat = new CountDownLatch(1);
        CountDownLatch laterHeartbeats = new CountDownLatch(2);
        server.createContext("/session/" + SESSION_ID + "/heartbeat", exchange -> {
            firstHeartbeat.countDown();
            if (detached.get()) laterHeartbeats.countDown();
            sendSessionJson(exchange, 200, "{\"sessionId\":\"" + SESSION_ID
                    + "\",\"clientId\":\"" + CLIENT_ID + "\",\"lastSeenAt\":123}");
        });
        server.createContext("/session/" + SESSION_ID + "/detach", exchange -> {
            assertPrivateHeaders(exchange, !byId);
            if (status == 204) {
                exchange.getResponseHeaders().set(HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                exchange.getResponseHeaders().set("Connection", "close");
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            } else {
                exchange.getResponseHeaders().set(HostedHarnessClient.BOOT_ID_HEADER, sameBoot ? BOOT_ID : OTHER_BOOT_ID);
                sendJson(exchange, status, "{\"code\":\"session_not_found\"}", false);
            }
        });
        try (HostedHarnessClient client = HostedHarnessClient.builder().baseUri(baseUri).bearerToken("harness-token")
                .capabilityDigest(DIGEST).heartbeatInterval(Duration.ofMillis(20)).build()) {
            HarnessSessionRef session = createSession(client);
            assertTrue(firstHeartbeat.await(2, TimeUnit.SECONDS));
            var authority = Map.<String, Object>of("operationId", "delete-1", "claimGeneration", 2);
            Runnable detach = () -> {
                if (byId) client.detachLifecycle(SESSION_ID, authority);
                else client.detachLifecycle(session, authority);
            };
            boolean confirmed = sameBoot && (status == 204 || status == 404);
            if (confirmed) detach.run();
            else {
                Class<? extends DaemonException> expected = sameBoot ? status == 500 ? MutationOutcomeUnknownException.class
                        : DaemonHttpException.class : HostedHarnessGenerationException.class;
                assertThrows(expected, detach::run);
            }
            detached.set(true);
            // A proven generation change retires every local record for
            // the old peer at the shared mutation channel, the attachment
            // included — the same rule detachSession's generation arm
            // follows.
            boolean retires = confirmed || !sameBoot;
            assertEquals(!retires, retires
                    ? laterHeartbeats.await(200, TimeUnit.MILLISECONDS)
                    : laterHeartbeats.await(5, TimeUnit.SECONDS));
        }
    }

    static Stream<Arguments> lifecycleDetachResponses() {
        return Stream.of(true, false).flatMap(byId -> Stream.of(Arguments.of(byId, 204, true),
                Arguments.of(byId, 404, true), Arguments.of(byId, 403, true), Arguments.of(byId, 409, true),
                Arguments.of(byId, 500, true), Arguments.of(byId, 404, false)));
    }

    @ParameterizedTest
    @MethodSource("confirmedLifecycleDetachResponses")
    void lifecycleDetachReleasesOnlyTheOriginalPrompt(boolean byId, int status, boolean replacement) throws Exception {
        createSessionRoute();
        CountDownLatch detaching = new CountDownLatch(1);
        CountDownLatch reply = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/detach", exchange -> {
            assertPrivateHeaders(exchange, !byId);
            detaching.countDown();
            if (replacement) {
                try { assertTrue(reply.await(2, TimeUnit.SECONDS)); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
            }
            exchange.getResponseHeaders().set(HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            if (status == 204) {
                exchange.getResponseHeaders().set("Connection", "close");
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            } else sendJson(exchange, status, "{\"code\":\"session_not_found\"}", false);
        });
        server.createContext("/session/" + SESSION_ID + "/load", exchange ->
                sendSessionJson(exchange, 200, sessionJson().replace(CLIENT_ID, "replacement-client")));
        AtomicInteger calls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt", exchange -> {
            int call = calls.incrementAndGet();
            assertEquals(call == 1 ? CLIENT_ID : "replacement-client",
                    exchange.getRequestHeaders().getFirst(HostedHarnessClient.CLIENT_ID_HEADER));
            var request = JsonSupport.parseObject(readBody(exchange), "prompt");
            exchange.getResponseHeaders().set(HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            sendJson(exchange, 202, "{\"promptId\":\"" + request.get("promptId")
                    + "\",\"lastEventId\":0,\"eventEpoch\":\"" + EVENT_EPOCH + "\"}", false);
        });
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef original = createSession(client);
            Map<String, Object> block = Map.of("type", "text", "text", "first");
            client.submitTurn(requestForSession(block, original));
            var detach = executor.submit(() -> {
                var authority = Map.<String, Object>of("operationId", "delete", "claimGeneration", 1);
                if (byId) client.detachLifecycle(SESSION_ID, authority);
                else client.detachLifecycle(original, authority);
            });
            assertTrue(detaching.await(2, TimeUnit.SECONDS));
            HarnessSessionRef next;
            if (!replacement) detach.get(2, TimeUnit.SECONDS);
            next = client.loadSession(new LoadHarnessSession(SESSION_ID,
                    ManagedSessionStoreConnection.builder().baseUri(URI.create("https://store.example/"))
                            .tenantId("tenant").workspaceId("workspace").writerId(BOOT_ID)
                            .leaseDuration(Duration.ofSeconds(45)).build()));
            if (replacement) {
                // A completed old prompt permits the replacement's new prompt before the old detach returns.
                server.createContext("/session/" + SESSION_ID + "/status", exchange -> {
                    exchange.getResponseHeaders().set(HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200, "{\"sessionId\":\"" + SESSION_ID + "\",\"hasActivePrompt\":" + (calls.get() >= 2) + "}", false);
                });
                client.getStatus(next);
            } else {
                runningStatusRoute();
            }
            var second = SubmitHarnessTurn.builder().session(next).promptId(SECOND_PROMPT_ID).addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(List.of(block))).build();
            client.submitTurn(second);
            reply.countDown();
            detach.get(2, TimeUnit.SECONDS);
            assertEquals(2, calls.get());
            var third = SubmitHarnessTurn.builder().session(next).promptId(OTHER_BOOT_ID).addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(List.of(block))).build();
            assertThrows(DaemonException.class, () -> client.submitTurn(third));
            assertEquals(2, calls.get());
        } finally {
            reply.countDown();
            executor.shutdownNow();
        }
    }

    static Stream<Arguments> confirmedLifecycleDetachResponses() {
        return Stream.of(true, false).flatMap(byId -> Stream.of(204, 404)
                .flatMap(status -> Stream.of(true, false).map(replacement -> Arguments.of(byId, status, replacement))));
    }

    @Test
    void lifecycleSettlementRetainsAttachmentAndDetachCarriesTheNewClaim() {
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                capabilitiesJson(DIGEST, BOOT_ID).replace("\"hostedHarness\":{", "\"hostedHarness\":{\"lifecycleProtocolVersion\":1,"), false));
        createSessionRoute();
        AtomicReference<Map<String, Object>> settlement = new AtomicReference<>();
        AtomicReference<Map<String, Object>> detach = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/lifecycle", exchange -> {
            assertEquals("POST", exchange.getRequestMethod());
            assertEquals(CLIENT_ID, exchange.getRequestHeaders().getFirst(HostedHarnessClient.CLIENT_ID_HEADER));
            settlement.set(JsonSupport.parseObject(readBody(exchange), "lifecycle"));
            sendSessionJson(exchange, 200, "{\"protocolVersion\":1,\"operationId\":\"delete-1\",\"kind\":\"delete\","
                    + "\"sessionKey\":{\"tenantId\":\"tenant\",\"workspaceId\":\"workspace\",\"sessionId\":\"" + SESSION_ID + "\"},\"effects\":[]}");
        });
        server.createContext("/session/" + SESSION_ID + "/detach", exchange -> {
            detach.set(JsonSupport.parseObject(readBody(exchange), "detach"));
            sendSessionNoContent(exchange);
        });
        try (HostedHarnessClient client = newClient()) {
            var session = createSession(client);
            var authority = Map.<String, Object>of("operationId", "delete-1", "claimGeneration", 2);
            var request = Map.<String, Object>of("kind", "delete", "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace",
                    "sessionId", SESSION_ID), "authority", authority);
            assertEquals(1, client.capabilities().getLifecycleProtocolVersion());
            assertEquals("delete-1", client.settleLifecycle(session, request).get("operationId"));
            assertEquals(request, settlement.get());
            assertNull(detach.get());
            client.detachLifecycle(session, authority);
            assertEquals(Map.of("authority", authority), detach.get());
        }
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"effects", "prepare_resources", "settle_resources"})
    void lifecycleV2RequiresExactCapabilityAndReceiptIdentity(String phase) {
        capabilitiesBody.set(capabilitiesJson(DIGEST, BOOT_ID).replace("\"hostedHarness\":{",
                "\"hostedHarness\":{\"lifecycleProtocolVersion\":1,\"lifecycleV2Profiles\":[\"hosted-workspace-shell/1\"],"));
        createSessionRoute();
        AtomicInteger calls = new AtomicInteger();
        AtomicBoolean wrongPhase = new AtomicBoolean();
        server.createContext("/session/" + SESSION_ID + "/lifecycle", exchange -> {
            calls.incrementAndGet();
            var request = JsonSupport.parseObject(readBody(exchange), "lifecycle");
            var receipt = new java.util.LinkedHashMap<>(request);
            receipt.remove("authority");
            receipt.put("operationId", "close-2");
            if (wrongPhase.get()) receipt.put("phase", "other");
            sendSessionJson(exchange, 200, JsonSupport.encode(receipt));
        });
        try (HostedHarnessClient client = newClient()) {
            var session = createSession(client);
            var request = Map.<String, Object>of("protocolVersion", 2, "phase", phase,
                    "toolProfile", "hosted-workspace-shell/1", "kind", "close",
                    "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", SESSION_ID),
                    "authority", Map.of("operationId", "close-2", "claimGeneration", 3));
            assertEquals("close-2", client.settleLifecycle(session, request).get("operationId"));
            wrongPhase.set(true);
            // The Harness answered 200 with a mismatched receipt: a
            // post-answer failure, not a pre-send protocol refusal.
            assertThrows(HostedHarnessSettleAnsweredException.class, () -> client.settleLifecycle(session, request));
            var unsupported = new java.util.LinkedHashMap<>(request);
            unsupported.put("toolProfile", "hosted-workspace-shell/2");
            assertThrows(DaemonProtocolException.class, () -> client.settleLifecycle(session, unsupported));
            unsupported.put("protocolVersion", 3);
            assertThrows(DaemonProtocolException.class, () -> client.settleLifecycle(session, unsupported));
            assertEquals(2, calls.get());
        }
    }

    @Test
    void oldHarnessDoesNotAdvertiseLifecycleV2() {
        createSessionRoute();
        try (HostedHarnessClient client = newClient()) {
            var session = createSession(client);
            assertTrue(client.capabilities().getLifecycleV2Profiles().isEmpty());
            assertThrows(DaemonProtocolException.class, () -> client.settleLifecycle(session,
                    Map.of("protocolVersion", 2, "toolProfile", "hosted-workspace-shell/1")));
        }
    }

    @Test
    void successorLifecycleDetachNeedsNoNewAttachmentOrLifecycleDispatch() {
        AtomicReference<Map<String, Object>> detach = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/detach", exchange -> {
            assertEquals("POST", exchange.getRequestMethod());
            detach.set(JsonSupport.parseObject(readBody(exchange), "detach"));
            assertPrivateHeaders(exchange, false);
            exchange.getResponseHeaders().set(HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            exchange.getResponseHeaders().set("Connection", "close");
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        AtomicInteger otherMutations = new AtomicInteger();
        server.createContext("/session", exchange -> {
            otherMutations.incrementAndGet();
            sendSessionJson(exchange, 500, "{}");
        });
        try (HostedHarnessClient client = newClient()) {
            var authority = Map.<String, Object>of("operationId", "delete-1", "claimGeneration", 2);
            client.detachLifecycle(SESSION_ID, authority);
            assertEquals(Map.of("authority", authority), detach.get());
            assertEquals(0, otherMutations.get());
        }
    }

    @Test
    void legacyHarnessCannotFallBackToDeleteForLifecycleSettlement() {
        AtomicInteger requests = new AtomicInteger();
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID, exchange -> {
            requests.incrementAndGet();
            sendSessionNoContent(exchange);
        });
        try (HostedHarnessClient client = newClient()) {
            var session = createSession(client);
            assertEquals(0, client.capabilities().getLifecycleProtocolVersion());
            assertThrows(DaemonProtocolException.class, () -> client.settleLifecycle(session, Map.of()));
            assertEquals(0, requests.get());
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
        // The busy-turn probe gets a real answer: the Harness reports the
        // first prompt still running, so the second is refused.
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":true}"));
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
    void releasesAnOutcomeUnknownPromptOnlyOnceTheHarnessReportsItIdle() {
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        AtomicBoolean harnessActive = new AtomicBoolean(true);
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendSessionJson(exchange, 503,
                                "{\"code\":\"temporarily_unavailable\"}");
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
                                + "\",\"hasActivePrompt\":"
                                + harnessActive.get() + "}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            SubmitHarnessTurn next = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(SECOND_PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            // The Harness may still run the earlier prompt: refused.
            assertThrows(DaemonException.class,
                    () -> client.submitTurn(next));
            assertEquals(1, promptCalls.get());
            // Once the Harness reports nothing running, the stale entry no
            // longer pins the Session.
            harnessActive.set(false);
            assertEquals(SECOND_PROMPT_ID,
                    client.submitTurn(next).getPromptId());
        }
        assertEquals(2, promptCalls.get());
    }

    // A status probe the Harness refuses (the Session is gone there) must
    // stay fail-closed: the pinned entry is kept, the next Turn is refused
    // with the plain busy-turn DaemonException the dispatcher retries, and
    // no second prompt is submitted. Letting the probe's
    // DaemonHttpException escape would map to a terminal Turn failure for a
    // prompt that was never submitted (review round 7, R7-2).
    @Test
    void aRefusedStatusProbeKeepsTheRetryableBusyTurnRefusal() {
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 503,
                            "{\"code\":\"temporarily_unavailable\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 404,
                        "{\"code\":\"session_not_found\"}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            DaemonException refusal = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertFalse(refusal instanceof DaemonHttpException);
            assertFalse(refusal instanceof DaemonProtocolException);
        }
        assertEquals(1, promptCalls.get());
    }

    // The same fail-closed shape for a probe that answers 200 without the
    // hasActivePrompt field: the malformed read must surface as the
    // retryable busy-turn refusal, not as a DaemonProtocolException.
    @Test
    void aShapelessStatusProbeKeepsTheRetryableBusyTurnRefusal() {
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 503,
                            "{\"code\":\"temporarily_unavailable\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200, sessionJson()));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            DaemonException refusal = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertFalse(refusal instanceof DaemonHttpException);
            assertFalse(refusal instanceof DaemonProtocolException);
        }
        assertEquals(1, promptCalls.get());
    }

    // A generation change the busy-turn probe observes propagates as
    // itself, so the dispatcher adopts the new generation instead of
    // retrying a busy refusal against the dead one.
    @Test
    void aBusyTurnProbeSurfacesAGenerationChange() {
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> sendSessionJson(exchange, 503,
                        "{\"code\":\"temporarily_unavailable\"}"));
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, OTHER_BOOT_ID);
                    sendJson(exchange, 200, "{\"sessionId\":\""
                            + SESSION_ID + "\",\"hasActivePrompt\":true}",
                            false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "probe-generation");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
        }
    }

    // A vetoed submission opens no send attempt on the entry that vetoes
    // it, so it leaves that entry's send clock alone: an idle status read
    // in flight across the veto still clears the marker when it lands.
    @Test
    void aVetoedSubmitLeavesAnInFlightIdleReadAbleToClear() throws Exception {
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
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        AtomicInteger statusCalls = new AtomicInteger();
        CountDownLatch parked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> {
                    // The first read parks and answers idle; the vetoed
                    // submit's own probe and any later one see a running
                    // prompt.
                    boolean first = statusCalls.incrementAndGet() == 1;
                    if (first) {
                        parked.countDown();
                        try {
                            release.await(5, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"hasActivePrompt\":" + !first
                                    + "}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "veto-clock");
        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            Future<?> status = callers.submit(
                    () -> client.getStatus(session));
            assertTrue(parked.await(5, TimeUnit.SECONDS));
            SubmitHarnessTurn next = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(SECOND_PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertThrows(DaemonException.class,
                    () -> client.submitTurn(next));
            release.countDown();
            status.get(5, TimeUnit.SECONDS);
            assertEquals(SECOND_PROMPT_ID,
                    client.submitTurn(next).getPromptId());
            assertEquals(2, promptCalls.get());
        } finally {
            release.countDown();
            callers.shutdownNow();
            client.close();
        }
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

    // #13753 I2: the child Workspace capability describes the host, so it
    // rides every create and load, survives the lifecycle copy, and is
    // absent unless the control plane serves child Workspaces.
    @Test
    void carriesTheChildWorkspaceCapabilityOnlyWhenEnabled() {
        CreateHarnessSession.Builder create = CreateHarnessSession.builder()
                .harnessSessionId(SESSION_ID)
                .approvalMode(DaemonApprovalMode.DEFAULT);
        assertFalse(create.build().toJson().containsKey("childWorkspaces"));
        assertEquals(Boolean.TRUE,
                create.childWorkspaces(true).build().toJson().get("childWorkspaces"));
        LoadHarnessSession load = new LoadHarnessSession(SESSION_ID, null, true);
        assertFalse(load.toJson().containsKey("childWorkspaces"));
        assertFalse(load.withChildWorkspaces(false).toJson().containsKey("childWorkspaces"));
        LoadHarnessSession enabled = load.withChildWorkspaces(true);
        assertEquals(Boolean.TRUE, enabled.toJson().get("childWorkspaces"));
        assertEquals(Boolean.TRUE, enabled.toJson().get("passiveManagedRuntimeRecovery"));
        Map<String, Object> lifecycle = enabled.forLifecycle("op-1", 3).toJson();
        assertEquals(Boolean.TRUE, lifecycle.get("childWorkspaces"));
        assertNotNull(lifecycle.get("lifecycleAuthority"));
        Map<String, Object> reversed = load.forLifecycle("op-1", 3)
                .withChildWorkspaces(true).toJson();
        assertEquals(Boolean.TRUE, reversed.get("childWorkspaces"));
        assertEquals(lifecycle.get("lifecycleAuthority"), reversed.get("lifecycleAuthority"));
    }

    // #13753 I3: the snapshot capability rides beside the child Workspace
    // one, through every copy, and never alone.
    @Test
    void carriesTheSnapshotCapabilityOnlyBesideChildWorkspaces() {
        CreateHarnessSession.Builder create = CreateHarnessSession.builder()
                .harnessSessionId(SESSION_ID)
                .approvalMode(DaemonApprovalMode.DEFAULT);
        assertFalse(create.childSnapshots(true).build().toJson().containsKey("childSnapshots"));
        Map<String, Object> both = create.childWorkspaces(true).childSnapshots(true).build().toJson();
        assertEquals(Boolean.TRUE, both.get("childWorkspaces"));
        assertEquals(Boolean.TRUE, both.get("childSnapshots"));
        LoadHarnessSession load = new LoadHarnessSession(SESSION_ID, null, true);
        assertFalse(load.withChildWorkspaces(false, true).toJson().containsKey("childSnapshots"));
        assertFalse(load.withChildWorkspaces(true).toJson().containsKey("childSnapshots"));
        LoadHarnessSession enabled = load.withChildWorkspaces(true, true);
        assertEquals(Boolean.TRUE, enabled.toJson().get("childSnapshots"));
        assertEquals(Boolean.TRUE, enabled.forLifecycle("op-1", 3).toJson().get("childSnapshots"));
        assertEquals(Boolean.TRUE, enabled.withStoppedMessages().toJson().get("childSnapshots"));
        assertEquals(Boolean.TRUE, enabled.withForegroundOnly(false).toJson().get("childSnapshots"));
        assertEquals(Boolean.TRUE, enabled.withForegroundOnly(true).forLifecycle("op-1", 3, 2)
                .withStoppedMessages().toJson().get("childSnapshots"));
        assertEquals(Boolean.TRUE, load.forLifecycle("op-1", 3).withChildWorkspaces(true, true)
                .toJson().get("childSnapshots"));
        // #13905 (item 40): restating child Workspaces keeps the snapshot
        // capability; only turning them off drops it, for good.
        assertEquals(Boolean.TRUE, enabled.withChildWorkspaces(true).toJson().get("childSnapshots"));
        assertEquals(Boolean.TRUE, enabled.forLifecycle("op-1", 3).withChildWorkspaces(true)
                .toJson().get("childSnapshots"));
        Map<String, Object> off = enabled.withChildWorkspaces(false).toJson();
        assertFalse(off.containsKey("childWorkspaces"));
        assertFalse(off.containsKey("childSnapshots"));
        assertFalse(enabled.withChildWorkspaces(false).withChildWorkspaces(true).toJson()
                .containsKey("childSnapshots"));
    }

    @Test
    void preservesTheForegroundOnlyRestrictionAcrossEveryLoadCopy() {
        CreateHarnessSession.Builder create = CreateHarnessSession.builder()
                .harnessSessionId(SESSION_ID);
        assertFalse(create.build().toJson().containsKey("foregroundOnly"));
        assertEquals(Boolean.TRUE, create.foregroundOnly(true).build().toJson().get("foregroundOnly"));
        LoadHarnessSession load = new LoadHarnessSession(SESSION_ID, null, true);
        assertFalse(load.toJson().containsKey("foregroundOnly"));
        LoadHarnessSession restricted = load.withForegroundOnly(true);
        for (LoadHarnessSession copy : java.util.List.of(restricted,
                restricted.withChildWorkspaces(false), restricted.withStoppedMessages(),
                restricted.forLifecycle("close-1", 2, 2),
                load.forLifecycle("close-1", 2, 2).withStoppedMessages().withForegroundOnly(true))) {
            assertEquals(Boolean.TRUE, copy.toJson().get("foregroundOnly"));
            assertEquals(Boolean.TRUE, copy.toJson().get("passiveManagedRuntimeRecovery"));
        }
        assertFalse(load.toJson().containsKey("foregroundOnly"));
    }

    @Test
    void extensionPinsSurviveCreateAndEveryLoadCopy() {
        var mcp = java.util.List.<Map<String, Object>>of(Map.of("serverId", "docs", "serverRevision", 1,
                "definitionDigest", "a".repeat(64)));
        Map<String, Object> hooks = Map.of("catalogId", "review", "catalogRevision", 1,
                "definitionDigest", "b".repeat(64));
        Map<String, Object> created = CreateHarnessSession.builder().harnessSessionId(SESSION_ID)
                .mcpServers(mcp).hookCatalog(hooks).build().toJson();
        assertEquals(mcp, created.get("mcpServers"));
        assertEquals(hooks, created.get("hookCatalog"));
        LoadHarnessSession load = new LoadHarnessSession(SESSION_ID).withMcpServers(mcp).withHookCatalog(hooks);
        for (LoadHarnessSession copy : java.util.List.of(load, load.withChildWorkspaces(true),
                load.forLifecycle("op-1", 3, 2), load.withStoppedMessages(),
                load.withStoppedMessages().forLifecycle("op-1", 3, 2).withChildWorkspaces(true),
                load.withForegroundOnly(false), load.withForegroundOnly(true),
                load.withForegroundOnly(true).forLifecycle("op-1", 3, 2).withStoppedMessages())) {
            assertEquals(mcp, copy.toJson().get("mcpServers"));
            assertEquals(hooks, copy.toJson().get("hookCatalog"));
        }
        assertFalse(new LoadHarnessSession(SESSION_ID).toJson().containsKey("mcpServers"));
        assertFalse(CreateHarnessSession.builder().harnessSessionId(SESSION_ID).build().toJson().containsKey("hookCatalog"));
    }

    @Test
    void parsesAnAgentWaitRuntimeRecovery() {
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithAgentWaitRuntimeRecovery()));
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            HarnessRuntimeRecovery recovery = session.getRuntimeRecovery();
            assertNotNull(recovery);
            assertEquals("await_agent", recovery.getPhase());
            // Every wait run is observable through the relay ledger, so the
            // predicates the coordinator gates on hold for this phase.
            assertFalse(recovery.hasUnknownOutcome());
            assertTrue(recovery.isContinuationReady());
            assertTrue(recovery.isCancellationReady());
            assertEquals("run-1", recovery.getExecutions().get(0)
                    .getExecutionCallId());
            assertEquals("agent", recovery.getExecutions().get(0)
                    .getToolName());
            assertEquals("executing", recovery.getExecutions().get(0)
                    .getStatus().get("state"));
            assertEquals("settled", recovery.getExecutions().get(1)
                    .getStatus().get("state"));
        }
    }

    @Test
    void agentWaitWithoutExecutionsIsNotReady() {
        // The wire parser already enforces 1-1024 executions; the predicate
        // keeps the same floor so an empty wait never readies a continuation
        // or a cancellation — the daemon's no-results guard would error the
        // turn instead of failing loudly at admission.
        HarnessRuntimeRecovery recovery = new HarnessRuntimeRecovery(
                "await_agent", "checkpoint-4", "activation-4", List.of());
        assertFalse(recovery.isContinuationReady());
        assertFalse(recovery.isCancellationReady());
    }

    @Test
    void agentWaitWithUnknownOutcomeIsNotReady() {
        // A wait run the relay can no longer observe reports unknown: the
        // all-known conjunct must keep the gates shut, or the coordinator
        // would re-enter a wait it cannot observe (R1-15).
        HarnessRuntimeRecovery recovery = new HarnessRuntimeRecovery(
                "await_agent", "checkpoint-4", "activation-4", List.of(
                        new HarnessRuntimeExecutionRecovery("call-1", "agent",
                                "execution-1", "runtime-session", null,
                                "known", Map.of("state", "executing")),
                        new HarnessRuntimeExecutionRecovery("call-2", "agent",
                                "execution-2", "runtime-session", null,
                                "unknown", Map.of("state", "executing"))));
        assertTrue(recovery.hasUnknownOutcome());
        assertFalse(recovery.isContinuationReady());
        assertFalse(recovery.isCancellationReady());
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
    void parsesAnAbandonedRuntimeRecoveryAsCancellable() {
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJsonWithAbandonedRuntimeRecovery()));

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            HarnessRuntimeRecovery recovery = session.getRuntimeRecovery();

            // A terminally fenced record keeps its distinction: the report
            // parses, and the coordinator may drive the cancellation over it.
            assertNotNull(recovery);
            assertEquals("await_runtime", recovery.getPhase());
            assertFalse(recovery.hasUnknownOutcome());
            assertTrue(recovery.isCancellationReady());
            assertFalse(recovery.isContinuationReady());
            assertEquals("abandoned", recovery.getExecutions().get(0)
                    .getStatus().get("state"));
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
        assertFalse(recovery.isContinuationReady());
        assertTrue(recovery.isCancellationReady());
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
    void refusesVersionedTitleBeforeSendingToAnOlderHarness() {
        createSessionRoute();
        AtomicInteger writes = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/title", exchange -> {
            writes.incrementAndGet();
            sendSessionJson(exchange, 200, "{}");
        });
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(DaemonProtocolException.class, () -> client.updateSessionTitle(session, "A", 1));
        }
        assertEquals(0, writes.get());
    }

    @Test
    void sendsAndChecksTheDurableTitleRevision() {
        createSessionRoute();
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                capabilitiesJson(DIGEST, BOOT_ID).replace("\"hostedHarness\":{",
                        "\"hostedHarness\":{\"titleProtocolVersion\":1,\"features\":[\"hosted_approval_resume_v1\",\"hosted_model_round_recovery_v1\"],"), false));
        AtomicReference<String> body = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/title", exchange -> {
            body.set(readBody(exchange));
            sendSessionJson(exchange, 200, "{\"sessionId\":\"" + SESSION_ID
                    + "\",\"persisted\":true,\"managedRenameRevision\":\"7\"}");
        });
        try (HostedHarnessClient client = newClient()) {
            assertEquals(1, client.capabilities().getTitleProtocolVersion());
            assertEquals(List.of("hosted_approval_resume_v1", "hosted_model_round_recovery_v1"),
                    client.capabilities().getFeatures());
            client.updateSessionTitle(createSession(client), "A", 7);
        }
        assertTrue(body.get().contains("\"managedRenameRevision\":\"7\""));
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

    @ParameterizedTest
    @MethodSource("captureByteBudgets")
    void createCarriesOptionalCaptureByteBudget(Long budget) {
        AtomicReference<Map<String, Object>> payload = new AtomicReference<>();
        server.createContext("/session", exchange -> {
            payload.set(JsonSupport.parseObject(readBody(exchange), "Capture create request"));
            sendSessionJson(exchange, 200, sessionJson());
        });
        CreateHarnessSession.Builder request = CreateHarnessSession.builder()
                .harnessSessionId(SESSION_ID)
                .toolProfile("hosted-workspace-shell/1");
        if (budget != null) request.captureBytes(budget);
        try (HostedHarnessClient client = newClient()) {
            client.createSession(request.build());
        }
        if (budget == null) assertFalse(payload.get().containsKey("captureBytes"));
        else assertEquals(budget.longValue(), ((Number) payload.get().get("captureBytes")).longValue());
    }

    private static Stream<Arguments> captureByteBudgets() {
        return Stream.of(Arguments.of((Long) null), Arguments.of(1L),
                Arguments.of(1048576L), Arguments.of(1L << 41));
    }

    @Test
    void rejectsCaptureByteBudgetsOutsideTheHarnessContract() {
        for (long value : new long[] {-1, 0, (1L << 41) + 1, Long.MAX_VALUE}) {
            assertThrows(IllegalArgumentException.class,
                    () -> CreateHarnessSession.builder().captureBytes(value));
        }
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
        AtomicBoolean harnessActive = new AtomicBoolean();
        CountDownLatch statusEntered = new CountDownLatch(1);
        CountDownLatch statusRelease = new CountDownLatch(1);
        AtomicInteger statusCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> {
                    // Only the stale read parks; a busy-turn probe answers
                    // at once.
                    if (statusCalls.incrementAndGet() == 1) {
                        statusEntered.countDown();
                        try {
                            statusRelease.await(5, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"hasActivePrompt\":"
                                    + harnessActive.get() + "}");
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
            // From here on the Harness reports the admitted prompt running,
            // as it would: the busy-turn probe in the veto below reads that
            // live answer, so only a marker the earlier read wrongly
            // cleared lets the different identity through.
            harnessActive.set(true);
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
        AtomicBoolean harnessActive = new AtomicBoolean();
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":"
                                + harnessActive.get() + "}"));
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
                // From here on the Harness reports the admitted prompt running,
                // as it would: the busy-turn probe in the veto below reads that
                // live answer, so only a marker the earlier read wrongly
                // cleared lets the different identity through.
                harnessActive.set(true);
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
            awaitHeartbeatAfter(heartbeats, first,
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
    void anUnfencedDefinitiveDeleteIsAProtocolFailureNotAVerdict() {
        // R5-4: the private closeSession channel shares the mutation
        // channel's classification rule — a genuine unfenced 4xx refused
        // the request before the route saw it, but it is not the
        // Harness's own answer, so it surfaces as the protocol failure it
        // is rather than a DaemonHttpException consumers key terminal
        // verdicts on.
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendJson(exchange, 413,
                        "Request body too large", false));

        try (HostedHarnessClient client = newClient()) {
            DaemonProtocolException failure = assertThrows(
                    DaemonProtocolException.class,
                    () -> client.closeSession(SESSION_ID));
            assertTrue(failure.getMessage().contains("413"));
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
        advertiseEventKeepalive();
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
                // The typed outcome tells a coordinator a silent peer from
                // a reset socket or a server that ended the stream.
                HostedHarnessStreamIdleException failure = assertThrows(
                        HostedHarnessStreamIdleException.class,
                        () -> assertTimeoutPreemptively(
                                Duration.ofSeconds(10), stream::next));
                assertTrue(failure.getMessage().contains("idle timeout"),
                        failure.getMessage());
                assertEquals(Duration.ofMillis(500),
                        failure.getIdleTimeout());
                // A caller arriving after the out-of-band abort gets the
                // same DaemonException-family signal from the closed
                // guard, not the caller-initiated IllegalStateException.
                HostedHarnessStreamIdleException late = assertThrows(
                        HostedHarnessStreamIdleException.class, stream::next);
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
        advertiseEventKeepalive();
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
                        // Strictly between one watchdog tick (120 ms) and
                        // the idle budget (1200 ms): with the entry stamp
                        // the first tick after the consumer parks again
                        // measures ~650 ms and the stream survives;
                        // without it the tick measures the whole stall and
                        // aborts the stream. Both values stay wide enough
                        // for a loaded CI runner to schedule the write late.
                        Thread.sleep(650);
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
                .sseIdleTimeout(Duration.ofMillis(1200))
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
                Thread.sleep(3600);
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
        advertiseEventKeepalive();
        createSessionRoute();
        CountDownLatch stopKeepalives = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().flush();
                    try {
                        // The handler thread must own the keepalive loop:
                        // returning from the handler closes the exchange.
                        // 120ms cadence against the 1500ms budget below
                        // tolerates a stall of more than ten keepalives on a
                        // loaded runner.
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
                .sseIdleTimeout(Duration.ofMillis(1500))
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
                // Consumer parked in read for over two idle budgets while the
                // peer proves liveness only with keepalive comments: the
                // refills stamp the budget, so the stream must survive.
                ExecutorService consumer = Executors.newSingleThreadExecutor();
                try {
                    Future<DaemonEvent> event = consumer.submit(
                            () -> assertTimeoutPreemptively(
                                    Duration.ofSeconds(8), stream::next));
                    Thread.sleep(3200);
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
        // The Harness advertises keepalives, so only ZERO disables it.
        advertiseEventKeepalive();
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
    void aHarnessWithoutKeepalivesKeepsTheReadUnbounded() throws Exception {
        // #14135: a Harness that does not advertise event-keepalive/1 is
        // silent through every quiet phase of a healthy Turn, so a bound
        // would abort those streams during a rolling upgrade. The client
        // arms no watchdog against it, whatever sseIdleTimeout says.
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
                .sseIdleTimeout(Duration.ofMillis(200))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                assertEquals(0, client.scheduler().getQueue().size());
                ExecutorService consumer =
                        Executors.newSingleThreadExecutor();
                try {
                    // Parked against a peer silent for five budgets: with
                    // no watchdog the event written afterwards arrives.
                    Future<DaemonEvent> parked = consumer.submit(
                            stream::next);
                    Thread.sleep(1000);
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
        advertiseEventKeepalive();
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
        try {
            HarnessSessionRef session = createSession(client);
            // Drive the race through the public call — the only path that
            // reaches startIdleWatchdog: the scheduler is already down,
            // as after a client.close() snapshot, so arming the watchdog
            // rejects and the just-registered stream is dropped again.
            client.scheduler().shutdownNow();
            DaemonTransportException failure = assertThrows(
                    DaemonTransportException.class,
                    () -> client.streamEvents(StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build()));
            assertTrue(failure.getCause()
                    instanceof RejectedExecutionException);
            assertEquals(0, client.registeredStreamCount());
        } finally {
            release.countDown();
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
        SaturatableQueue queue = new SaturatableQueue();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L,
                TimeUnit.MILLISECONDS, queue,
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
                // Park the only worker and saturate its queue, so the
                // response delivery task is rejected after the server
                // answered.
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
                queue.saturated = true;
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
                TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>(),
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
        Thread caller = Thread.currentThread();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L,
                TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>(),
                runnable -> {
                    Thread thread = new Thread(runnable,
                            "http-terminated-before-send");
                    thread.setDaemon(true);
                    return thread;
                },
                (task, pool) -> {
                    // Only the caller's dispatch: a rejected selector-thread
                    // task trailing createSession would abort the client.
                    if (Thread.currentThread() != caller) {
                        ForkJoinPool.commonPool().execute(task);
                        return;
                    }
                    throw new RejectedExecutionException("terminated");
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
        AtomicBoolean harnessActive = new AtomicBoolean(true);
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":"
                                + harnessActive.get() + "}"));
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
            // Retained marker: while the Harness reports a prompt running,
            // the busy-turn probe keeps it, so a different identity is
            // vetoed locally.
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
            harnessActive.set(false);
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
        // the executor refuses the dispatch task with a SecurityException
        // on the calling thread, before anything is dispatched) proves the
        // submission never reached the server, so
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
        AtomicInteger statusCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> {
                    statusCalls.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"hasActivePrompt\":false}");
                });
        AtomicBoolean failNextSend = new AtomicBoolean();
        Thread caller = Thread.currentThread();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(0,
                Integer.MAX_VALUE, 60L, TimeUnit.SECONDS,
                new SynchronousQueue<>()) {
            @Override
            public void execute(Runnable command) {
                // Only the caller's dispatch: a selector-thread task trailing
                // the previous response must not take the injected fault.
                if (Thread.currentThread() == caller
                        && failNextSend.getAndSet(false)) {
                    throw new SecurityException("synthetic send failure");
                }
                super.execute(command);
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
            // No busy-turn probe ran: a leftover marker would have sent one.
            assertEquals(0, statusCalls.get());
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
        // definitive refusal (DELETE 403) still retires the attachment,
        // but it proves the DELETE did not run — the session and its turn
        // are still alive — so the admission ledger stays and keeps
        // vetoing a different identity locally.
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
                    if (call > 1) {
                        // Reached only when the refused close dropped the
                        // ledger: the production route answers a second
                        // admission on a live turn with this refusal.
                        sendSessionJson(exchange, 409,
                                "{\"code\":\"hosted_turn_active\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
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
            // The ledger survived the refused close: a different
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
            assertEquals(1, promptCalls.get());
        } finally {
            client.close();
        }
    }

    @Test
    void aRefusedCloseByIdStillTearsDownTheHeartbeat() throws Exception {
        // Same teardown rule for the by-id overload: the attachment
        // retires, the admission ledger stays.
        createSessionRoute();
        runningStatusRoute();
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
                    if (call > 1) {
                        // Same wire refusal the production route answers a
                        // second admission on a live turn with.
                        sendControlPlaneSessionJson(exchange, 409,
                                "{\"code\":\"hosted_turn_active\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
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
            // The ledger survived the refused close here too: a
            // different identity is vetoed locally and never reaches the
            // wire.
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
    void anUnfencedDefinitiveDetachKeepsTheAttachment() throws Exception {
        // R5-4: an unfenced definitive answer (an intermediary's 413
        // page) is not the Harness's own answer, so it retires nothing:
        // it surfaces as a protocol failure and the attachment — the
        // client's only liveness probe for the ref — stays, matching the
        // close path.
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
            DaemonProtocolException failure = assertThrows(
                    DaemonProtocolException.class,
                    () -> client.detachSession(session));
            assertTrue(failure.getMessage().contains("413"));
            Thread.sleep(100);
            int first = heartbeats.get();
            awaitHeartbeatAfter(heartbeats, first,
                    "heartbeat must keep beating after an unfenced"
                            + " refusal");
        } finally {
            client.close();
        }
    }

    @Test
    void anUnfencedDefinitiveCloseKeepsTheAttachment() throws Exception {
        // R5-4 close half: an unfenced definitive answer is not the
        // Harness's own answer, so the close keeps the local state and
        // surfaces a protocol failure, exactly like detach.
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
            DaemonProtocolException failure = assertThrows(
                    DaemonProtocolException.class,
                    () -> client.closeSession(session));
            assertTrue(failure.getMessage().contains("413"));
            Thread.sleep(100);
            int first = heartbeats.get();
            awaitHeartbeatAfter(heartbeats, first,
                    "heartbeat must keep beating after an unfenced"
                            + " refusal");
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
        runningStatusRoute();
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
            awaitHeartbeatAfter(heartbeats, first,
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
            awaitHeartbeatAfter(heartbeats, first,
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
        AtomicBoolean harnessActive = new AtomicBoolean();
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
                                    + "\",\"hasActivePrompt\":"
                                    + harnessActive.get() + "}");
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
            // From here on the Harness reports the admitted prompt running,
            // as it would: the busy-turn probe in the veto below reads that
            // live answer, so only a marker the earlier read wrongly
            // cleared lets the different identity through.
            harnessActive.set(true);
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
    void aDroppedRetrySendLeavesTheMarkerClearable() throws Exception {
        // R3-2 (d): a same-identity retry's dropped send closes its own
        // admission window, exactly like the owning call's concluded send
        // does. Un-settling the owner's entry instead would wedge the
        // session for this client's lifetime: no path could ever
        // re-settle it, so getStatus — the documented recovery path —
        // could never clear the marker. After the drop a status read
        // answering hasActivePrompt:false clears it and a different
        // identity reaches the wire.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        // Outcome-unknown: retained, settled, nothing
                        // admitted server-side.
                        sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                        return;
                    }
                    if (call == 2) {
                        // The retry's send is dropped before any answer.
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
            // its dropped send closes its own admission window.
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            assertEquals(2, promptCalls.get());
            // No send is in flight anymore: the status answer postdates
            // every admission window the marker tracked, so it clears...
            assertFalse(client.getStatus(session).hasActivePrompt());
            // ...and a different identity reaches the wire.
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
            assertEquals(3, promptCalls.get());
        }
    }

    @Test
    void aRefusedRetryLeavesTheMarkerSettled() {
        // The answered-refusal half of the per-attempt window: a
        // same-identity retry's concluded refusal leaves the marker with
        // no send in flight (the server deduplicates the replay against
        // the earlier registration), so a status read answering
        // hasActivePrompt:false can still clear it — otherwise the
        // refusal would wedge the session.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                        return;
                    }
                    if (call == 2) {
                        sendJson(exchange, 401,
                                "{\"error\":\"unauthorized\"}", false);
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
            // Both sends have concluded, so no later status answer can
            // predate an admission window: the read clears the marker...
            assertFalse(client.getStatus(session).hasActivePrompt());
            // ...and a different identity reaches the wire.
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
            assertEquals(3, promptCalls.get());
        }
    }

    @Test
    void anErrorSendEscapeReleasesTheOwnedMarker() {
        // The Error half of the unchecked-escape arm: same pre-dispatch
        // shape as anUncheckedSendEscapeLeavesTheMarkerRecoverable, but
        // the dispatch refusal raises an Error, which must release the
        // owned marker the same way.
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
        Thread caller = Thread.currentThread();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(0,
                Integer.MAX_VALUE, 60L, TimeUnit.SECONDS,
                new SynchronousQueue<>()) {
            @Override
            public void execute(Runnable command) {
                // Only the caller's dispatch: a selector-thread task trailing
                // the previous response must not take the injected fault.
                if (Thread.currentThread() == caller
                        && failNextSend.getAndSet(false)) {
                    throw new OutOfMemoryError("synthetic send failure");
                }
                super.execute(command);
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

    private static void awaitHeartbeatAfter(AtomicInteger heartbeats,
            int previous, String message) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (heartbeats.get() <= previous && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertTrue(heartbeats.get() > previous, message);
    }

    private static void awaitSchedulerDrained(HostedHarnessClient client)
            throws Exception {
        // A periodic task is off the queue while it runs, so the queue is
        // read on the single scheduler thread, where no heartbeat task can
        // be running and a live one must be queued.
        ScheduledThreadPoolExecutor scheduler = client.scheduler();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        boolean drained;
        while (!(drained = scheduler.submit(
                () -> scheduler.getQueue().isEmpty()).get())
                && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertTrue(drained, "the scheduler queue never drained");
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

    @Test
    void aBootHeaderless202AdmissionIsOutcomeUnknownAndKeepsTheMarker() {
        // R4-1: an allowlisting proxy forwarded the route's real 202 but
        // stripped the boot header. That answer proves nothing about
        // whether the prompt was admitted — the header stripper may have
        // forwarded a success — so it is outcome-unknown and the marker
        // of the possibly admitted turn stays.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "unfenced-202");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
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
    void aBootHeaderless2xxSessionAnswerIsOutcomeUnknown() {
        // R5-2: a boot-headerless 2xx or 3xx on POST /session is not a
        // refusal — an intermediary may have stripped the header from a
        // real success — so it is outcome-unknown and the connector's
        // load fallback stays reachable. A genuine unfenced 4xx refused
        // the request before the route saw it, but it is not the
        // Harness's own answer either (R5-4): it surfaces as a protocol
        // failure, never as a DaemonHttpException consumers key terminal
        // verdicts on. The connector's load fallback still covers the
        // fenced 409 and every outcome-unknown shape.
        AtomicInteger createCalls = new AtomicInteger();
        server.createContext("/session", exchange -> {
            if (createCalls.incrementAndGet() == 1) {
                sendJson(exchange, 200, sessionJson(), false);
                return;
            }
            sendJson(exchange, 409, "{\"code\":\"session_exists\"}", false);
        });

        try (HostedHarnessClient client = newClient()) {
            assertThrows(SessionCreationOutcomeUnknownException.class,
                    () -> client.createSession(CreateHarnessSession.builder()
                            .harnessSessionId(SESSION_ID)
                            .build()));
            DaemonProtocolException refusal = assertThrows(
                    DaemonProtocolException.class,
                    () -> client.createSession(CreateHarnessSession.builder()
                            .harnessSessionId(SESSION_ID)
                            .build()));
            assertTrue(refusal.getMessage().contains("409"));
        }

        assertEquals(2, createCalls.get());
    }

    @Test
    void aBootHeaderless204DetachIsOutcomeUnknownAndKeepsTheState()
            throws Exception {
        // R5-4: an unfenced 204 on detach proves nothing — the header
        // stripper may have forwarded a real detach — so it is
        // outcome-unknown and both the attachment and the admission
        // ledger survive.
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
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    // No boot header: an intermediary stripped it. The
                    // explicit close avoids the JDK 11 pooled-connection
                    // quirk documented on sendSessionNoContent.
                    exchange.getResponseHeaders().set("Connection",
                            "close");
                    exchange.sendResponseHeaders(204, -1);
                    exchange.close();
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "unfenced-detach-204");

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            awaitHeartbeat(heartbeats);
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.detachSession(session));
            Thread.sleep(100);
            int first = heartbeats.get();
            awaitHeartbeatAfter(heartbeats, first,
                    "heartbeat must keep beating after an unfenced 204");
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
    void automationOperationRejectsANonSettledState() {
        server.createContext(
                "/session/" + SESSION_ID + "/automations/operations",
                exchange -> sendJson(exchange, 202, "{\"state\":\"running\","
                        + "\"operationId\":\"op-1\"}", true));

        try (HostedHarnessClient client = newClient()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> client.runAutomationOperation(
                            mockRef(), Map.of("operationId", "op-1")));
            assertTrue(failure.getCause().getMessage()
                    .contains("did not settle the automation operation"));
        }
    }

    @Test
    void automationOperationRejectsACrossedOperationEcho() {
        server.createContext(
                "/session/" + SESSION_ID + "/automations/operations",
                exchange -> sendJson(exchange, 202, "{\"state\":\"settled\","
                        + "\"operationId\":\"op-other\"}", true));

        try (HostedHarnessClient client = newClient()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> client.runAutomationOperation(
                            mockRef(), Map.of("operationId", "op-1")));
            assertTrue(failure.getCause().getMessage()
                    .contains("settled a different automation operation"));
        }
    }

    @Test
    void aBootHeaderless307CloseIsOutcomeUnknownAndKeepsTheState()
            throws Exception {
        // R5-4: the client never follows redirects, so an unfenced 307
        // from a proxy proves the DELETE never ran — outcome-unknown, and
        // the close must not retire the attachment or the ledger.
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
                exchange -> sendJson(exchange, 307,
                        "Temporary Redirect", false));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "unfenced-close-307");

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            awaitHeartbeat(heartbeats);
            assertThrows(MutationOutcomeUnknownException.class,
                    () -> client.closeSession(session));
            Thread.sleep(100);
            int first = heartbeats.get();
            awaitHeartbeatAfter(heartbeats, first,
                    "heartbeat must keep beating after an unfenced 307");
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
    void anUnfencedTurnActiveCloseKeepsTheLedger() {
        // R4-2's ledger requirement survives R5-4's type narrowing: a 409
        // whose boot header an intermediary stripped is not the Harness's
        // own answer, so the close surfaces a protocol failure and
        // retires nothing — the admission ledger survives either way, or
        // the local one-turn veto fails open against a running turn.
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
        server.createContext("/session/" + SESSION_ID,
                exchange -> sendJson(exchange, 409,
                        "{\"code\":\"hosted_turn_active\"}", false));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "unfenced-turn-active");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            DaemonProtocolException failure = assertThrows(
                    DaemonProtocolException.class,
                    () -> client.closeSession(session));
            assertTrue(failure.getMessage().contains("409"));
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
    void aPreContract404ReleasesTheOwnedMarker() {
        // R6-2: the serve delegating app's bare pre-contract 404 proves
        // this submission never reached the runtime, so the marker this
        // call owned is released like a locally rejected send — otherwise
        // the ledger vetoes every later identity until a status read.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        exchange.getResponseHeaders().set("Content-Type",
                                "text/plain");
                        exchange.sendResponseHeaders(404, -1);
                        exchange.close();
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "pre-contract-release");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            DaemonTransportException error = assertThrows(
                    DaemonTransportException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            assertTrue(error.getMessage().contains("pre-contract"));
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
        }

        assertEquals(2, promptCalls.get());
    }

    @Test
    void aReplayedAdmissionAfterTerminalEventPlantsNoMarker()
            throws Exception {
        // R3-2: the route answers a same-identity replay from its
        // admission log with a bare 202 and emits no event, so when the
        // earlier entry is already gone — its turn's terminal event was
        // consumed while this flight was in the air — the 202 owes no
        // future terminal event and no marker may be replanted for it.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        CountDownLatch retrySeen = new CountDownLatch(1);
        CountDownLatch releaseRetry = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    String promptId = call == 3 ? SECOND_PROMPT_ID
                            : PROMPT_ID;
                    if (call == 2) {
                        retrySeen.countDown();
                        try {
                            releaseRetry.await(15, TimeUnit.SECONDS);
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
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    exchange.close();
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "replay-after-terminal");

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
            assertNotNull(client.submitTurn(first));
            HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build());
            try {
                // The same-identity retry is in flight, non-owning,
                // while the turn's terminal event is consumed.
                Future<Throwable> retry = caller.submit(() -> {
                    try {
                        client.submitTurn(first);
                        return null;
                    } catch (Throwable failure) {
                        return failure;
                    }
                });
                assertTrue(retrySeen.await(5, TimeUnit.SECONDS));
                DaemonEvent ended = assertTimeoutPreemptively(
                        Duration.ofSeconds(5), stream::next);
                assertEquals("turn_complete", ended.getType());
                releaseRetry.countDown();
                assertNull(retry.get(5, TimeUnit.SECONDS));
            } finally {
                releaseRetry.countDown();
                stream.closeQuietly();
            }
            // No marker may survive for the completed turn: a different
            // identity reaches the wire.
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
            releaseRetry.countDown();
            caller.shutdownNow();
            client.close();
        }

        assertEquals(3, promptCalls.get());
    }

    @Test
    void anOwningReplayedAdmissionAfterTerminalEventPlantsNoMarker()
            throws Exception {
        // R17-2: the owning ordering of
        // aReplayedAdmissionAfterTerminalEventPlantsNoMarker — the turn's
        // terminal event is consumed BEFORE the same-identity retry, so
        // the ledger is empty and the retry OWNS the marker it plants. The
        // route answers the replay from its journal with a bare 202 and
        // emits no event, so that marker could never be cleared: the 202
        // arm retires it instead, and a different identity reaches the
        // wire.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    String promptId = call == 3 ? SECOND_PROMPT_ID
                            : PROMPT_ID;
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + promptId
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    exchange.close();
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "owning-replay-after-terminal");

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
            HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build());
            try {
                // The terminal event is consumed before the retry:
                // observeEvent clears the marker and records the terminal
                // promptId.
                DaemonEvent ended = assertTimeoutPreemptively(
                        Duration.ofSeconds(5), stream::next);
                assertEquals("turn_complete", ended.getType());
            } finally {
                stream.closeQuietly();
            }
            // The owning replay is answered from the journal with a bare
            // 202: the marker it just planted owes no future terminal
            // event and must not survive.
            assertNotNull(client.submitTurn(first));
            // A different identity reaches the wire.
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

        assertEquals(3, promptCalls.get());
    }

    @Test
    void aNonOwningReplayedAdmissionAfterTerminalEventPlantsNoMarker()
            throws Exception {
        // R17-2: the non-owning ordering of
        // aReplayedAdmissionAfterTerminalEventPlantsNoMarker — the
        // terminal event is consumed BEFORE both same-identity replays,
        // so the first replay owns the marker it plants and the second
        // joins it. The route answers both from its journal with a bare
        // 202 and emits no event, so the terminal-record check must gate
        // the non-owning republish too: an unconditional replace plants a
        // fresh instance the owning arm's release can no longer see, and
        // the replanted marker could never be cleared — it would veto
        // every later identity for this client's lifetime.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        CountDownLatch ownerParked = new CountDownLatch(1);
        CountDownLatch releaseOwner = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 2) {
                        // The owning replay parks server-side while the
                        // non-owning replay runs to its 202.
                        ownerParked.countDown();
                        try {
                            assertTrue(releaseOwner.await(15,
                                    TimeUnit.SECONDS));
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            throw new IOException(e);
                        }
                    }
                    var request = JsonSupport.parseObject(
                            readBody(exchange), "prompt");
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + request.get("promptId")
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    exchange.close();
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "non-owning-replay-after-terminal");

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            assertNotNull(client.submitTurn(first));
            HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build());
            try {
                // The terminal event is consumed before both replays:
                // observeEvent clears the marker and records the terminal
                // promptId, so both replays are answered from the journal.
                DaemonEvent ended = assertTimeoutPreemptively(
                        Duration.ofSeconds(5), stream::next);
                assertEquals("turn_complete", ended.getType());
            } finally {
                stream.closeQuietly();
            }
            // The owning replay plants the marker and parks mid-send; the
            // non-owning replay joins it and is answered first.
            Future<Throwable> owner = callers.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(ownerParked.await(5, TimeUnit.SECONDS));
            assertNotNull(client.submitTurn(first));
            releaseOwner.countDown();
            assertNull(owner.get(5, TimeUnit.SECONDS));
            // No marker may survive the journal replays: a different
            // identity reaches the wire.
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
            assertEquals(4, promptCalls.get());
        } finally {
            releaseOwner.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aRefusedCloseByIdKeepsStateRegisteredMidFlight() throws Exception {
        // R5-3: a by-id close may retire only the records it observed
        // before the DELETE was dispatched. A refusal landing after a
        // concurrent loadSession registered a fresh attachment and a
        // running turn must not wipe either — matches() cannot key this
        // path because the by-id overload holds no client id.
        createSessionRoute();
        runningStatusRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200, sessionJson()));
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
        CountDownLatch deleteSeen = new CountDownLatch(1);
        CountDownLatch releaseDelete = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID, exchange -> {
            deleteSeen.countDown();
            try {
                releaseDelete.await(15, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            sendControlPlaneSessionJson(exchange, 403,
                    "{\"code\":\"forbidden\"}");
        });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "close-race");

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            // The by-id DELETE parks server-side.
            Future<Throwable> close = caller.submit(() -> {
                try {
                    client.closeSession(SESSION_ID);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(deleteSeen.await(5, TimeUnit.SECONDS));
            // A concurrent caller re-registers the session and admits a
            // turn while the DELETE is in flight.
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(reloaded)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            // The DELETE is refused with a definitive fenced answer whose
            // code does not prove a live turn.
            releaseDelete.countDown();
            Throwable closeFailure = close.get(5, TimeUnit.SECONDS);
            assertTrue(closeFailure instanceof DaemonHttpException,
                    String.valueOf(closeFailure));
            assertEquals(403,
                    ((DaemonHttpException) closeFailure).getStatusCode());
            // The concurrent caller's attachment survived: the heartbeat
            // it scheduled keeps beating.
            Thread.sleep(100);
            int first = heartbeats.get();
            awaitHeartbeatAfter(heartbeats, first,
                    "heartbeat must keep beating after the refused close");
            // ...and its admission marker survived: a different identity
            // is still vetoed locally.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(reloaded)
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
            releaseDelete.countDown();
            caller.shutdownNow();
            client.close();
        }
    }

    @Test
    void aSuccessfulDetachClearsTheAdmissionLedger() {
        // R6-1: a 204 detach proves the session is gone server-side, so a
        // retained admission marker is provably stale and must not
        // survive: after the supported load recovery re-opens the same
        // id, a different prompt identity must reach the wire.
        createSessionRoute();
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
        server.createContext("/session/" + SESSION_ID + "/detach",
                HostedHarnessClientTest::sendSessionNoContent);
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200, sessionJson()));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "detach-clears-ledger");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            client.detachSession(session);
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(reloaded)
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
    void aWire409StaysReachableThroughDaemonHttpException() {
        // R5-1: the only in-tree consumer of coded prompt refusals
        // (HarnessCoordinator in managed-agent-server) matches
        // catch (DaemonHttpException) and reads getErrorCode(), so the
        // wire 409 shape must stay visible through that type with the
        // peer's refusal body intact.
        createSessionRoute();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> sendSessionJson(exchange, 409,
                        "{\"code\":\"hosted_prompt_recovery_required\"}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "recovery-reachable");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            DaemonHttpException refusal = assertThrows(
                    DaemonHttpException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
            assertEquals(409, refusal.getStatusCode());
            assertEquals("hosted_prompt_recovery_required",
                    refusal.getErrorCode());
        }
    }

    @Test
    void aPreCanonicalizationDigestStaysOnTheWireInItsOwnShape() {
        // R3-1: a turn row persisted before computePayloadDigest
        // canonicalized its input carries a digest over the as-built key
        // order, and neither the stored digest nor the stored input may
        // be rewritten. The route recomputes the digest over the received
        // key order before any replay check, so recovery must both accept
        // that digest and send the exact shape it covers.
        createSessionRoute();
        AtomicReference<String> promptBody = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptBody.set(readBody(exchange));
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("type", "text");
        block.put("text", "legacy-order");
        List<Map<String, Object>> content = List.of(block);
        String legacyDigest = legacyDigestOf(content);
        // The witness discriminates only if the two shapes hash apart.
        assertNotEquals(legacyDigest,
                SubmitHarnessTurn.computePayloadDigest(content));

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn turn = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(legacyDigest)
                    .build();
            assertEquals(PROMPT_ID,
                    client.submitTurn(turn).getPromptId());
        }

        assertTrue(promptBody.get().contains(
                "\"prompt\":[{\"type\":\"text\","
                        + "\"text\":\"legacy-order\"}]"),
                "the wire shape must be the one the legacy digest covers: "
                        + promptBody.get());
        assertTrue(promptBody.get().contains(
                "\"payloadDigest\":\"" + legacyDigest + "\""));
    }

    // The pre-canonicalization digest shape: the as-built serialization,
    // key order untouched.
    private static String legacyDigestOf(List<Map<String, Object>> content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(JsonSupport.encode(content)
                    .getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder("sha256:");
            for (byte value : hashed) {
                result.append(String.format("%02x", value & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void anUnfencedRefusalOnResolveActionIsAProtocolFailure() {
        // R5-4: an unfenced 4xx (here the body parser's 400, answered
        // before the fencing middleware) refused the request before it
        // reached the route, but it is not the Harness's own answer.
        // Surfacing it as DaemonHttpException lets consumers key a
        // terminal verdict on the status — ActionResponseCoordinator
        // completes the action as invalid_action_response on a 400 —
        // where the merge base requeued it.
        createSessionRoute();
        String actionId = "tool_approval_0123456789abcdef0123456789abcdef";
        server.createContext("/session/" + SESSION_ID + "/actions/"
                        + actionId + "/resolve",
                exchange -> sendJson(exchange, 400,
                        "{\"error\":\"Invalid JSON in request body\"}",
                        false));

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            DaemonProtocolException failure = assertThrows(
                    DaemonProtocolException.class,
                    () -> client.resolveAction(session, actionId,
                            "option-1", 1L, "policy-1"));
            assertTrue(failure.getMessage().contains("400"));
        }
    }

    @Test
    void aStaleRefDetachKeepsTheCurrentOwnersMarker() {
        // R3-2 (a): identity() answers an absent session and a client-id
        // mismatch with the same 404, and a tolerated 404 is a detach
        // success. A stale ref's detach must not wipe the marker the
        // session's current owner planted, or the local one-turn veto
        // fails open against a live turn.
        runningStatusRoute();
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        // The mismatch shape the Harness itself answers: same 404 as an
        // absent session.
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 404,
                            "{\"code\":\"hosted_session_not_found\"}",
                            false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "stale-detach");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef staleRef = createSession(client);
            HarnessSessionRef current = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            client.submitTurn(SubmitHarnessTurn.builder()
                    .session(current)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build());
            // The stale ref's tolerated 404 says nothing about the
            // incarnation the current owner re-opened.
            client.detachSession(staleRef);
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(current)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(1, promptCalls.get());
        }
    }

    @Test
    void aCloseRacingAMarkerPlantLeavesNoVeto() throws Exception {
        // R3-2 (b): a close whose 204 proves the session gone must retire
        // even a marker planted while the DELETE was in flight — the
        // session the turn ran on no longer exists, nothing can clear a
        // retained marker, and the re-opened id would stay vetoed for
        // this client's lifetime.
        createSessionRoute();
        CountDownLatch sawDelete = new CountDownLatch(1);
        CountDownLatch releaseDelete = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID, exchange -> {
            sawDelete.countDown();
            try {
                releaseDelete.await(15, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            sendSessionNoContent(exchange);
        });
        CountDownLatch sawPrompt = new CountDownLatch(1);
        CountDownLatch releasePrompt = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    sawPrompt.countDown();
                    if (call == 1) {
                        try {
                            releasePrompt.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "close-race");
        ExecutorService callers = Executors.newFixedThreadPool(2);
        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            Future<?> close = callers.submit(() -> {
                client.closeSession(session);
                return null;
            });
            assertTrue(sawDelete.await(5, TimeUnit.SECONDS));
            // The DELETE is parked server-side; the submission plants its
            // marker mid-flight.
            Future<?> submission = callers.submit(() -> {
                client.submitTurn(SubmitHarnessTurn.builder()
                        .session(session)
                        .promptId(PROMPT_ID)
                        .addContent(block)
                        .payloadDigest(
                                SubmitHarnessTurn.computePayloadDigest(
                                        List.of(block)))
                        .build());
                return null;
            });
            assertTrue(sawPrompt.await(5, TimeUnit.SECONDS));
            releaseDelete.countDown();
            close.get(5, TimeUnit.SECONDS);
            releasePrompt.countDown();
            submission.get(5, TimeUnit.SECONDS);
            // The close proved the session gone after the marker was
            // planted: it must not survive to veto a different identity.
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
            releaseDelete.countDown();
            releasePrompt.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aStatusReadCannotClearAMarkerWhileARetryIsInFlight()
            throws Exception {
        // R3-2 (c): a same-identity retry's 202 republishes the marker
        // with replace(registered, candidate), which silently no-ops when
        // a concurrent status read removed the entry — leaving the ledger
        // empty while a turn is live. The per-attempt window makes that
        // removal unreachable: a status read may only clear a marker with
        // no send in flight.
        createSessionRoute();
        CountDownLatch sawRetry = new CountDownLatch(1);
        CountDownLatch releaseRetry = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                        return;
                    }
                    if (call == 2) {
                        sawRetry.countDown();
                        try {
                            releaseRetry.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 2 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        AtomicBoolean harnessActive = new AtomicBoolean();
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":"
                                + harnessActive.get() + "}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "republish-race");
        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(digest)
                    .build();
            // Outcome-unknown: the marker is retained and settled.
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            Future<?> retry = callers.submit(() -> {
                client.submitTurn(first);
                return null;
            });
            assertTrue(sawRetry.await(5, TimeUnit.SECONDS));
            // The retry's send is parked: the status answer must not clear
            // the marker underneath its open admission window.
            assertFalse(client.getStatus(session).hasActivePrompt());
            releaseRetry.countDown();
            retry.get(5, TimeUnit.SECONDS);
            // The re-admitted marker is live: a different identity is
            // vetoed locally and never reaches the wire.
            // From here on the Harness reports the admitted prompt running,
            // as it would: the busy-turn probe in the veto below reads that
            // live answer, so only a marker the earlier read wrongly
            // cleared lets the different identity through.
            harnessActive.set(true);
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(2, promptCalls.get());
        } finally {
            releaseRetry.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aRetryBeginningBetweenTheStatusSnapshotReadsKeepsTheMarker()
            throws Exception {
        // R17-3: getStatus reads the marker's clock before its settledness
        // and re-checks both inside the bin-locked clear, so a
        // same-identity retry whose beginSend lands between the two
        // snapshot reads keeps the marker — the status answer the server
        // evaluated before the retry's send landed must not clear it.
        createSessionRoute();
        CountDownLatch sawRetry = new CountDownLatch(1);
        CountDownLatch releaseRetry = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                        return;
                    }
                    if (call == 2) {
                        sawRetry.countDown();
                        try {
                            releaseRetry.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 2 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        AtomicBoolean harnessActive = new AtomicBoolean();
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":"
                                + harnessActive.get() + "}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "status-snapshot-race");
        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(digest)
                    .build();
            // Outcome-unknown: the marker is retained and settled.
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            AtomicReference<Future<?>> retry = new AtomicReference<>();
            client.statusSnapshotProbe = () -> {
                // The seam between the two snapshot reads: the retry's
                // beginSend lands here, after the clock read and before
                // the settledness read.
                retry.set(callers.submit(() -> {
                    client.submitTurn(first);
                    return null;
                }));
                try {
                    assertTrue(sawRetry.await(5, TimeUnit.SECONDS));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            };
            // The retry's send is parked: the status answer must not clear
            // the marker underneath its open admission window.
            assertFalse(client.getStatus(session).hasActivePrompt());
            client.statusSnapshotProbe = () -> {};
            releaseRetry.countDown();
            retry.get().get(5, TimeUnit.SECONDS);
            // The re-admitted marker is live: a different identity is
            // vetoed locally and never reaches the wire.
            // From here on the Harness reports the admitted prompt running,
            // as it would: the busy-turn probe in the veto below reads that
            // live answer, so only a marker the earlier read wrongly
            // cleared lets the different identity through.
            harnessActive.set(true);
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(2, promptCalls.get());
        } finally {
            client.statusSnapshotProbe = () -> {};
            releaseRetry.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aStaleRefCloseKeepsTheCurrentOwnersMarker() {
        // R3-2 (e): the close twin of the stale-detach entrance — the
        // widened 404 tolerance must not land a stale ref's fenced
        // client-id-mismatch 404 on a success path that wipes the marker
        // of the newer identity's genuinely live turn.
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        server.createContext("/session/" + SESSION_ID,
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 404,
                            "{\"code\":\"hosted_session_not_found\"}",
                            false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "stale-close");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef staleRef = createSession(client);
            HarnessSessionRef current = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            client.submitTurn(SubmitHarnessTurn.builder()
                    .session(current)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build());
            // The stale ref's tolerated 404 proves nothing about the
            // re-opened incarnation: the current owner's marker survives.
            client.closeSession(staleRef);
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(current)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(1, promptCalls.get());
        }
    }

    @Test
    void anOwnerRefusalWithASameIdentityRetryInFlightKeepsTheLedger()
            throws Exception {
        // R10-3: a definitive refusal for the owning attempt must not
        // drop the shared marker while a same-identity retry is still in
        // flight — the retry joined that entry and only bumped its
        // in-flight counter, so the release must consult the counter. If
        // the marker disappears, the retry's 202 cannot replant it (the
        // replace keys on the joined instance), leaving a live admitted
        // turn with no ledger entry: the local one-turn veto silently
        // degrades to its own absence.
        createSessionRoute();
        CountDownLatch ownerSeen = new CountDownLatch(1);
        CountDownLatch releaseOwner = new CountDownLatch(1);
        CountDownLatch retrySeen = new CountDownLatch(1);
        CountDownLatch releaseRetry = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        ownerSeen.countDown();
                        try {
                            releaseOwner.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        sendSessionJson(exchange, 400,
                                "{\"code\":\"bad_prompt\"}");
                        return;
                    }
                    if (call == 2) {
                        retrySeen.countDown();
                        try {
                            releaseRetry.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 2 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "owner-refused-retry-in-flight");
        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newFixedThreadPool(2);
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(digest)
                    .build();
            Future<Throwable> owner = callers.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(ownerSeen.await(5, TimeUnit.SECONDS));
            Future<Throwable> retry = callers.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(retrySeen.await(5, TimeUnit.SECONDS));
            // The owner is definitively refused while the retry's send is
            // parked: its release must keep the entry the retry joined.
            releaseOwner.countDown();
            Throwable ownerFailure = owner.get(5, TimeUnit.SECONDS);
            assertTrue(ownerFailure instanceof DaemonHttpException,
                    String.valueOf(ownerFailure));
            assertEquals(400,
                    ((DaemonHttpException) ownerFailure).getStatusCode());
            releaseRetry.countDown();
            assertNull(retry.get(5, TimeUnit.SECONDS));
            // The re-admitted turn is live: a different identity is
            // vetoed locally and never reaches the wire.
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(2, promptCalls.get());
        } finally {
            releaseOwner.countDown();
            releaseRetry.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aSuccessfulCloseByIdKeepsAnAttachmentRegisteredMidFlight()
            throws Exception {
        // R17-4: the by-id close's success arm proves the session it
        // OBSERVED deleted, but the 204 answers a DELETE dispatched before
        // a concurrent loadSession re-registered the id — the peer still
        // accepts the replacement's heartbeats, so discarding the
        // replacement would leave the re-opened session without a
        // heartbeat for the client's lifetime. The success arm retires the
        // observed attachment only; a registration whose session is in
        // fact gone self-retires on its heartbeat's definitive
        // hosted_session_not_found 404 (pinned by
        // aSessionNotFoundHeartbeatRetiresTheAttachment).
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
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200, sessionJson()));
        CountDownLatch deleteSeen = new CountDownLatch(1);
        CountDownLatch releaseDelete = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID, exchange -> {
            deleteSeen.countDown();
            try {
                releaseDelete.await(15, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            assertPrivateHeaders(exchange, false);
            exchange.getResponseHeaders().set(
                    HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            exchange.getResponseHeaders().set("Connection", "close");
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            createSession(client);
            awaitHeartbeat(heartbeats);
            Future<Throwable> close = caller.submit(() -> {
                try {
                    client.closeSession(SESSION_ID);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(deleteSeen.await(5, TimeUnit.SECONDS));
            // A concurrent caller re-registers the session while the
            // DELETE is in flight.
            client.loadSession(new LoadHarnessSession(SESSION_ID));
            releaseDelete.countDown();
            assertNull(close.get(5, TimeUnit.SECONDS));
            // The mid-flight replacement attachment postdates the
            // observation the 204 answers, so it survives the close and
            // keeps beating.
            Thread.sleep(100);
            int beating = heartbeats.get();
            // A loaded runner can delay the 10ms heartbeat task past a fixed
            // observation window; wait for the replacement's beat instead.
            awaitHeartbeatAfter(heartbeats, beating,
                    "the re-registered attachment must keep beating");
        } finally {
            releaseDelete.countDown();
            caller.shutdownNow();
            client.close();
        }
    }

    @Test
    void aCloseByRefKeepsAMidFlightAttachmentUntilItsHeartbeat404()
            throws Exception {
        // R16-1: the ref close's deletion arm retires the attachment
        // identity-matched, so an attachment a concurrent load registered
        // under a different client id survives it; the session the 204
        // deleted is gone, so the survivor's heartbeat meets a definitive
        // hosted_session_not_found 404 and self-retires — the periodic
        // task leaves the scheduler and no heartbeat is issued again,
        // instead of beating against the dead session forever.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    if ("client-2".equals(exchange.getRequestHeaders()
                            .getFirst(HostedHarnessClient.CLIENT_ID_HEADER))) {
                        exchange.getResponseHeaders().set(
                                HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                        sendJson(exchange, 404,
                                "{\"code\":\"hosted_session_not_found\"}",
                                false);
                        return;
                    }
                    sendSessionJson(exchange, 200,
                            "{\"sessionId\":\"" + SESSION_ID
                                    + "\",\"clientId\":\"" + CLIENT_ID
                                    + "\",\"lastSeenAt\":123}");
                });
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        CountDownLatch deleteSeen = new CountDownLatch(1);
        CountDownLatch releaseDelete = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID, exchange -> {
            deleteSeen.countDown();
            try {
                releaseDelete.await(15, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            assertPrivateHeaders(exchange, true);
            exchange.getResponseHeaders().set(
                    HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            exchange.getResponseHeaders().set("Connection", "close");
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef session = createSession(client);
            awaitHeartbeat(heartbeats);
            Future<Throwable> close = caller.submit(() -> {
                try {
                    client.closeSession(session);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(deleteSeen.await(5, TimeUnit.SECONDS));
            // A concurrent caller re-registers the session under a new
            // client identity while the DELETE is in flight.
            client.loadSession(new LoadHarnessSession(SESSION_ID));
            releaseDelete.countDown();
            assertNull(close.get(5, TimeUnit.SECONDS));
            // The close retired only its own identity's attachment; the
            // survivor's heartbeat met the definitive 404 and
            // self-retired: the scheduler queue drains and the heartbeats
            // stop.
            awaitSchedulerDrained(client);
            Thread.sleep(100);
            int last = heartbeats.get();
            Thread.sleep(60);
            assertEquals(last, heartbeats.get(),
                    "no heartbeat may survive the definitive 404");
        } finally {
            releaseDelete.countDown();
            caller.shutdownNow();
            client.close();
        }
    }

    @Test
    void aSessionNotFoundHeartbeatRetiresTheAttachment()
            throws Exception {
        // R17-4/R16-1: a heartbeat answered with a definitive fenced 404
        // hosted_session_not_found proves the session record is gone
        // server-side — the same proof a deleting close or detach rides —
        // so the attachment retires itself: it leaves the attachments map
        // and cancels its periodic task instead of beating against the
        // dead session for the client's lifetime.
        createSessionRoute();
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> {
                    heartbeats.incrementAndGet();
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 404,
                            "{\"code\":\"hosted_session_not_found\"}",
                            false);
                });

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ofMillis(10))
                .build();
        try {
            createSession(client);
            // The first heartbeat self-retires the attachment: the
            // scheduler queue drains and no further heartbeat is issued.
            awaitSchedulerDrained(client);
            Thread.sleep(100);
            int last = heartbeats.get();
            Thread.sleep(60);
            assertEquals(last, heartbeats.get(),
                    "no heartbeat may be issued after the definitive 404");
        } finally {
            client.close();
        }
    }

    @ParameterizedTest
    @MethodSource("closeAndDetachOverloads")
    void aTurnActiveCloseThenLifecycleDetachReleasesTheLedger(boolean byId)
            throws Exception {
        // R10-4: a close refused hosted_turn_active retires the
        // attachment but keeps the admission ledger, leaving a marker
        // with no attachment. A lifecycle detach whose 204 deletes the
        // session must still retire that marker — the retirement must not
        // sit behind the attachment gate — or the local one-turn veto
        // wedges the re-opened id for this client's lifetime.
        createSessionRoute();
        runningStatusRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    assertEquals(call == 1 ? CLIENT_ID : "client-2",
                            exchange.getRequestHeaders().getFirst(
                                    HostedHarnessClient.CLIENT_ID_HEADER));
                    String promptId = String.valueOf(JsonSupport
                            .parseObject(readBody(exchange), "prompt")
                            .get("promptId"));
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + promptId
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\"" + EVENT_EPOCH
                                    + "\"}", false);
                });
        server.createContext("/session/" + SESSION_ID, exchange -> {
            if (byId) {
                sendControlPlaneSessionJson(exchange, 409,
                        "{\"code\":\"hosted_turn_active\"}");
            } else {
                sendSessionJson(exchange, 409,
                        "{\"code\":\"hosted_turn_active\"}");
            }
        });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    assertEquals(byId ? null : CLIENT_ID,
                            exchange.getRequestHeaders().getFirst(
                                    HostedHarnessClient.CLIENT_ID_HEADER));
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    exchange.getResponseHeaders().set("Connection",
                            "close");
                    exchange.sendResponseHeaders(204, -1);
                    exchange.close();
                });
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "close-then-lifecycle-detach");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            DaemonHttpException refusal = assertThrows(
                    DaemonHttpException.class,
                    () -> {
                        if (byId) {
                            client.closeSession(SESSION_ID);
                        } else {
                            client.closeSession(session);
                        }
                    });
            assertEquals(409, refusal.getStatusCode());
            // The refused close kept the ledger: a different identity is
            // vetoed locally.
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
            // The lifecycle detach's 204 deletes the session: the
            // orphaned marker retires with it.
            var authority = Map.<String, Object>of("operationId",
                    "delete-1", "claimGeneration", 2);
            if (byId) {
                client.detachLifecycle(SESSION_ID, authority);
            } else {
                client.detachLifecycle(session, authority);
            }
            HarnessSessionRef reopened = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(reopened)
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

    static Stream<Arguments> closeAndDetachOverloads() {
        return Stream.of(Arguments.of(true), Arguments.of(false));
    }

    @Test
    void aProvenDeletingCloseRetiresAMarkerFromAnOlderIdentity() {
        // R10-5: a 204 on the ref close path proves the session deleted —
        // identity() answers the route only when the client id matches —
        // so every marker for the id is stale, including one planted
        // under an earlier client identity. Identity-matched retirement
        // would leave the older marker to veto every later prompt
        // identity for this client's lifetime.
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    String promptId = String.valueOf(JsonSupport
                            .parseObject(readBody(exchange), "prompt")
                            .get("promptId"));
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + promptId
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\"" + EVENT_EPOCH
                                    + "\"}", false);
                });
        server.createContext("/session/" + SESSION_ID, exchange -> {
            // The current owner's fenced DELETE: the route deletes the
            // session and answers 204.
            assertEquals("client-2",
                    exchange.getRequestHeaders().getFirst(
                            HostedHarnessClient.CLIENT_ID_HEADER));
            exchange.getResponseHeaders().set(
                    HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            exchange.getResponseHeaders().set("Connection", "close");
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "newer-close-retires-older-marker");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef older = createSession(client);
            // The marker is planted under the first client identity.
            assertNotNull(client.submitTurn(SubmitHarnessTurn.builder()
                    .session(older)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build()));
            HarnessSessionRef current = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            // The 204 deletes the session: the marker the older identity
            // planted is stale regardless of the submitting identity.
            client.closeSession(current);
            HarnessSessionRef reopened = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(reopened)
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
    void aDefinitiveDetachRefusalKeepsTheLedger() {
        // R3-6: the detach twin of aTurnActiveCloseKeepsTheLedger — a
        // definitive, non-generation refusal says nothing about a turn
        // detach leaves running server-side, so the admission ledger
        // stays and a different identity remains vetoed locally.
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
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> sendSessionJson(exchange, 403,
                        "{\"code\":\"forbidden\"}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "detach-refusal-keeps-ledger");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.detachSession(session));
            assertEquals(403, failure.getStatusCode());
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
    void aPublicHeartbeatGenerationChangeRetiresLocalState() {
        // R4-3: a client built with heartbeatInterval(Duration.ZERO) arms
        // no scheduled heartbeat, so the public call is its only entrance
        // that can observe a proven generation change — and it must
        // retire the admission ledger too, or the ledger's veto wedges
        // the session for the client's lifetime.
        createSessionRoute();
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
        server.createContext("/session/" + SESSION_ID + "/heartbeat",
                exchange -> sendJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"clientId\":\"" + CLIENT_ID
                                + "\",\"lastSeenAt\":123}",
                        true, OTHER_BOOT_ID));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "heartbeat-generation");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.heartbeat(session));
            // The ledger retired with the rest of the peer's state: a
            // different identity is not vetoed locally.
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
    void aStatusReadGenerationChangeRetiresLocalState() {
        // R4-3: the read path observes the same proof through the same
        // validateGeneration chain and follows the same rule: the peer
        // restarted, so every local record for it is dead.
        createSessionRoute();
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
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":false}",
                        true, OTHER_BOOT_ID));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "status-generation");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.getStatus(session));
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
    void aNonOwningPreDispatchEscapeKeepsTheEarlierEntry() {
        // R4-5: the unchecked-escape arm's pre-dispatch release must stay
        // ownership-gated: a same-identity retry whose send escapes
        // unchecked before dispatch must not delete the earlier entry —
        // the escape says nothing about the owner's admission window.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendSessionJson(exchange, 503, "{\"error\":\"x\"}");
                });
        AtomicBoolean failNextSend = new AtomicBoolean();
        Thread caller = Thread.currentThread();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(0,
                Integer.MAX_VALUE, 60L, TimeUnit.SECONDS,
                new SynchronousQueue<>()) {
            @Override
            public void execute(Runnable command) {
                // Only the caller's dispatch: a selector-thread task trailing
                // the previous response must not take the injected fault.
                if (Thread.currentThread() == caller
                        && failNextSend.getAndSet(false)) {
                    throw new SecurityException("synthetic send failure");
                }
                super.execute(command);
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
                    "type", "text", "text", "non-owning-escape");
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build();
            // Outcome-unknown: the marker is retained, settled, with
            // nothing admitted server-side.
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(first));
            assertEquals(1, promptCalls.get());
            // The same-identity retry is not the marker's owner; its
            // pre-dispatch escape must leave the earlier entry alone.
            failNextSend.set(true);
            assertThrows(SecurityException.class,
                    () -> client.submitTurn(first));
            assertEquals(1, promptCalls.get());
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
            executor.shutdownNow();
        }
    }

    @Test
    void anIdleAbortLandsInsideThePublishedWindow() throws Exception {
        // R4-4: the published abort window — between the budget and the
        // budget plus max(100 ms, a tenth of the budget) — is what an
        // integrator sizes an outer supervisor deadline against, so the
        // watchdog interval formula is pinned here: with a 2000 ms budget
        // the abort must land before 2000 + 200 ms (plus scheduling
        // slack). The ticks run from the stream's creation, so a park
        // right after it sits on a tick of a half-budget 1000 ms interval
        // too, and a tick a few ms late aborts that one at ~2000 ms.
        // Parking 300 ms in puts the park mid-interval for both: the
        // shipped 200 ms tick aborts at 2100 ms, a 1000 ms tick not
        // before 2700 ms.
        advertiseEventKeepalive();
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

        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .heartbeatInterval(Duration.ZERO)
                .sseIdleTimeout(Duration.ofMillis(2000))
                .build();
        try {
            HarnessSessionRef session = createSession(client);
            try (HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build())) {
                Thread.sleep(300);
                long parkedAt = System.nanoTime();
                DaemonTransportException failure = assertThrows(
                        DaemonTransportException.class,
                        () -> assertTimeoutPreemptively(
                                Duration.ofSeconds(10), stream::next));
                long elapsedMillis =
                        (System.nanoTime() - parkedAt) / 1_000_000;
                assertTrue(failure.getMessage().contains("idle timeout"),
                        failure.getMessage());
                assertTrue(elapsedMillis >= 1950,
                        "aborted before the budget: " + elapsedMillis);
                assertTrue(elapsedMillis < 2400,
                        "aborted outside the published window: "
                                + elapsedMillis);
            }
        } finally {
            release.countDown();
            client.close();
        }
    }

    @Test
    void automationOperationRejectsNonSuccessStatuses() {
        // A codeless intermediary 503 is an ambiguous answer, retried as
        // unknown; a refusal with a code flows out translated.
        server.createContext(
                "/session/" + SESSION_ID + "/automations/operations",
                exchange -> sendJson(exchange, 503, "Service Unavailable",
                        true));

        try (HostedHarnessClient client = newClient()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> client.runAutomationOperation(
                            mockRef(), Map.of("operationId", "op-1")));
            assertTrue(failure.getCause() instanceof DaemonHttpException);
        }
    }

    @Test
    void automationOperationCarriesAservicedRefusalCode() {
        server.createContext(
                "/session/" + SESSION_ID + "/automations/operations",
                exchange -> sendJson(exchange, 409, "{\"error\":\"x\","
                        + "\"code\":\"automation_retired\"}", true));

        try (HostedHarnessClient client = newClient()) {
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class,
                    () -> client.runAutomationOperation(
                            mockRef(), Map.of("operationId", "op-1")));
            assertEquals(409, failure.getStatusCode());
            assertEquals("automation_retired", failure.getErrorCode());
        }
    }

    @Test
    void automationOperationCarriesTheSettledAnswerThrough() {
        server.createContext(
                "/session/" + SESSION_ID + "/automations/operations",
                exchange -> sendJson(exchange, 202, "{\"state\":\"settled\","
                        + "\"operationId\":\"op-1\",\"replayed\":true}",
                        true));

        try (HostedHarnessClient client = newClient()) {
            Map<String, Object> answer = client.runAutomationOperation(
                    mockRef(), Map.of("operationId", "op-1"));
            assertEquals("settled", answer.get("state"));
            assertEquals(Boolean.TRUE, answer.get("replayed"));
        }
    }

    private static HarnessSessionRef mockRef() {
        return new HarnessSessionRef(SESSION_ID, CLIENT_ID, BOOT_ID,
                "/workspace", null, null, null);
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

    @Test
    void aStaleRefLifecycleDetachKeepsTheCurrentOwnersMarker() {
        // R10-4: detachLifecycle's tolerated 404 collapses an absent
        // session and a client-id mismatch into the same answer, so it
        // must retire the ledger through the same identity-matched
        // retireLedger detachSession uses — a stale ref's 404 says nothing
        // about the incarnation the current owner re-opened, and wiping
        // its marker fails the local one-turn veto open against a live
        // turn.
        runningStatusRoute();
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 404,
                            "{\"code\":\"hosted_session_not_found\"}",
                            false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "stale-lifecycle-detach");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef staleRef = createSession(client);
            HarnessSessionRef current = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            client.submitTurn(SubmitHarnessTurn.builder()
                    .session(current)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            List.of(block)))
                    .build());
            // The stale ref's tolerated 404 says nothing about the
            // incarnation the current owner re-opened.
            client.detachLifecycle(staleRef, Map.of());
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(current)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(1, promptCalls.get());
        }
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void aLifecycleDetachRacingAMarkerPlantLeavesNoVeto(boolean byId)
            throws Exception {
        // R10-4 (ref overload) and R15-2 (id-only overload): a detach
        // whose 204 proves the session gone must retire even a marker
        // planted while the detach was in flight — the session the turn
        // ran on no longer exists, nothing can clear a retained marker,
        // and the re-opened id would stay vetoed for this client's
        // lifetime. The id-only overload retires it only when no re-load
        // raced the round trip; nothing races here.
        createSessionRoute();
        CountDownLatch sawDetach = new CountDownLatch(1);
        CountDownLatch releaseDetach = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    sawDetach.countDown();
                    try {
                        releaseDetach.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    exchange.getResponseHeaders().set("Connection", "close");
                    exchange.sendResponseHeaders(204, -1);
                    exchange.close();
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
        Map<String, Object> block = Map.of(
                "type", "text", "text", "detach-race");
        ExecutorService callers = Executors.newSingleThreadExecutor();
        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            Future<Throwable> detach = callers.submit(() -> {
                try {
                    if (byId) {
                        client.detachLifecycle(SESSION_ID, Map.of());
                    } else {
                        client.detachLifecycle(session, Map.of());
                    }
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(sawDetach.await(5, TimeUnit.SECONDS));
            // The detach is parked server-side; the submission plants its
            // marker mid-flight and is admitted.
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            releaseDetach.countDown();
            assertNull(detach.get(5, TimeUnit.SECONDS));
            // The 204 proved the session gone after the marker was
            // planted: it must not survive to veto a different identity.
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
            releaseDetach.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {
            "lifecycleById", "lifecycleByRef", "detachSession",
            "closeById", "closeByRef"})
    void aTeardownKeepsTheTerminalRecordForAJournalReplay(String entrance)
            throws Exception {
        // A detach or a DELETE closes only the live session: the durable
        // journal survives it, and after a re-load the prompt route
        // answers a settled promptId's same-identity replay from that
        // journal with a 202 that emits no further terminal event. The
        // terminal-event record must survive every teardown entrance, or
        // the replay's marker can never clear and a different identity is
        // vetoed locally. The Harness reports a prompt running
        // throughout, so the busy-turn probe cannot heal a leftover
        // marker: only the kept record lets the next prompt through.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    var request = JsonSupport.parseObject(
                            readBody(exchange), "prompt");
                    // Both incarnations' client ids submit here.
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + request.get("promptId")
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    sendSseHeaders(exchange);
                    exchange.getResponseBody().write(terminalEvent(1,
                            PROMPT_ID).getBytes(StandardCharsets.UTF_8));
                    exchange.getResponseBody().flush();
                    exchange.close();
                });
        teardownRoutes(entrance);
        runningStatusRoute();
        Map<String, Object> block = Map.of(
                "type", "text", "text", "detach-terminal-record");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            HarnessEventStream stream = client.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build());
            try {
                // Consume the terminal event: the marker clears and the
                // terminal promptId is recorded.
                DaemonEvent ended = assertTimeoutPreemptively(
                        Duration.ofSeconds(5), stream::next);
                assertEquals("turn_complete", ended.getType());
            } finally {
                stream.closeQuietly();
            }
            endSession(client, entrance, session);
            HarnessSessionRef reopened = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            // The journal answers the settled prompt's replay: the 202
            // owes no terminal event, so no marker may survive it.
            assertNotNull(client.submitTurn(requestForSession(block,
                    reopened)));
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(reopened)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
        }

        assertEquals(3, promptCalls.get());
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {
            "lifecycleById", "lifecycleByRef", "detachSession",
            "closeById", "closeByRef"})
    void aTeardownRacingAReloadKeepsTheNewIncarnationsMarker(
            String entrance) throws Exception {
        // A detach or a DELETE retires the ledger after the attachment it
        // observed is gone, and a re-load can register a new attachment
        // and admit a live turn inside that window. The retirement must
        // keep a marker the current attachment's identity planted, or a
        // different prompt reaches the wire while the first is still
        // running. The window is staged by parking the retired
        // attachment's heartbeat-task cancel, which every teardown
        // entrance runs between the attachment removal and the ledger
        // retirement.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    var request = JsonSupport.parseObject(
                            readBody(exchange), "prompt");
                    // Both incarnations' client ids submit here.
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + request.get("promptId")
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        teardownRoutes(entrance);
        // The re-loaded incarnation's turn is running: the busy-turn
        // probe reads that live answer and keeps the marker.
        runningStatusRoute();
        Map<String, Object> block = Map.of(
                "type", "text", "text", "detach-reload-race");
        CountDownLatch cancelEntered = new CountDownLatch(1);
        CountDownLatch releaseCancel = new CountDownLatch(1);

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef original = createSession(client);
            parkAttachmentCancel(client, cancelEntered, releaseCancel);
            Future<Throwable> detach = callers.submit(() -> {
                try {
                    endSession(client, entrance, original);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            // The teardown answered 204 and removed the attachment; its
            // ledger retirement is still ahead of it.
            assertTrue(cancelEntered.await(5, TimeUnit.SECONDS));
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            assertNotNull(client.submitTurn(requestForSession(block,
                    reloaded)));
            releaseCancel.countDown();
            assertNull(detach.get(5, TimeUnit.SECONDS));
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(reloaded)
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
            releaseCancel.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {
            "lifecycleById", "lifecycleByRef", "detachSession",
            "closeById", "closeByRef"})
    void aTeardownRacingAReloadRetiresTheAbandonedMarker(String entrance)
            throws Exception {
        // The other half of the race: a re-load that registered an
        // attachment but planted nothing must not shelter the torn-down
        // identity's marker, which no event can clear any more. The
        // Harness reports a prompt running, so only the retirement — not
        // the busy-turn probe — lets the next prompt through.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    if (promptCalls.incrementAndGet() == 1) {
                        sendSessionJson(exchange, 503,
                                "{\"code\":\"temporarily_unavailable\"}");
                        return;
                    }
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        teardownRoutes(entrance);
        runningStatusRoute();
        Map<String, Object> block = Map.of(
                "type", "text", "text", "teardown-abandoned-marker");
        CountDownLatch cancelEntered = new CountDownLatch(1);
        CountDownLatch releaseCancel = new CountDownLatch(1);

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef original = createSession(client);
            // Outcome-unknown: the original identity's marker stays.
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            original)));
            parkAttachmentCancel(client, cancelEntered, releaseCancel);
            Future<Throwable> teardown = callers.submit(() -> {
                try {
                    endSession(client, entrance, original);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(cancelEntered.await(5, TimeUnit.SECONDS));
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            releaseCancel.countDown();
            assertNull(teardown.get(5, TimeUnit.SECONDS));
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(reloaded)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(
                                    SubmitHarnessTurn.computePayloadDigest(
                                            List.of(block)))
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
            assertEquals(2, promptCalls.get());
        } finally {
            releaseCancel.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {
            "lifecycleById", "lifecycleByRef", "detachSession",
            "closeById", "closeByRef"})
    void aTeardownKeepsAMarkerAReloadedRetryJoined(String entrance)
            throws Exception {
        // A re-load's dispatcher retries the outcome-unknown prompt under
        // the same promptId and digest: the retry joins the torn-down
        // identity's marker and is in flight when the teardown retires.
        // The entry now speaks for the re-loaded identity's attempt, so it
        // must stay; the retry's 202 then republishes it, and a different
        // prompt is vetoed locally while the admitted one runs.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        CountDownLatch retryEntered = new CountDownLatch(1);
        CountDownLatch retryRelease = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        sendSessionJson(exchange, 503,
                                "{\"code\":\"temporarily_unavailable\"}");
                        return;
                    }
                    retryEntered.countDown();
                    try {
                        retryRelease.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        teardownRoutes(entrance);
        runningStatusRoute();
        Map<String, Object> block = Map.of(
                "type", "text", "text", "teardown-joined-retry");
        CountDownLatch cancelEntered = new CountDownLatch(1);
        CountDownLatch releaseCancel = new CountDownLatch(1);

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newFixedThreadPool(2);
        try {
            HarnessSessionRef original = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            original)));
            parkAttachmentCancel(client, cancelEntered, releaseCancel);
            Future<Throwable> teardown = callers.submit(() -> {
                try {
                    endSession(client, entrance, original);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(cancelEntered.await(5, TimeUnit.SECONDS));
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            Future<PromptReceipt> retry = callers.submit(
                    () -> client.submitTurn(requestForSession(block,
                            reloaded)));
            assertTrue(retryEntered.await(5, TimeUnit.SECONDS));
            releaseCancel.countDown();
            assertNull(teardown.get(5, TimeUnit.SECONDS));
            retryRelease.countDown();
            assertNotNull(retry.get(5, TimeUnit.SECONDS));
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(reloaded)
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
            releaseCancel.countDown();
            retryRelease.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {
            "lifecycleByRef", "detachSession", "closeByRef"})
    void aStaleRefTolerated404KeepsAMarkerAReloadedRetryJoined(
            String entrance) throws Exception {
        // The tolerated-404 twin: the stale ref's identity planted the
        // marker, but the re-loaded identity's same-identity retry joined
        // it and is in flight, so the stale ref's 404 must not retire it.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        CountDownLatch retryEntered = new CountDownLatch(1);
        CountDownLatch retryRelease = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        sendSessionJson(exchange, 503,
                                "{\"code\":\"temporarily_unavailable\"}");
                        return;
                    }
                    retryEntered.countDown();
                    try {
                        retryRelease.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        // The Harness now belongs to the re-loaded identity: the stale
        // ref's teardown is answered with the identity-scoped 404.
        com.sun.net.httpserver.HttpHandler notFound = exchange ->
                sendJson(exchange, 404,
                        "{\"code\":\"hosted_session_not_found\"}", true);
        server.createContext("/session/" + SESSION_ID + "/detach", notFound);
        server.createContext("/session/" + SESSION_ID, notFound);
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJson().replace(CLIENT_ID, "client-2")));
        runningStatusRoute();
        Map<String, Object> block = Map.of(
                "type", "text", "text", "stale-ref-joined-retry");

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newSingleThreadExecutor();
        try {
            HarnessSessionRef original = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            original)));
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            Future<PromptReceipt> retry = callers.submit(
                    () -> client.submitTurn(requestForSession(block,
                            reloaded)));
            assertTrue(retryEntered.await(5, TimeUnit.SECONDS));
            endSession(client, entrance, original);
            retryRelease.countDown();
            assertNotNull(retry.get(5, TimeUnit.SECONDS));
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(reloaded)
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
            retryRelease.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    // The 204 teardown routes for every endSession entrance, answered for
    // the original identity (or none, on the headerless overloads), plus
    // a load that re-opens the session under client-2.
    private void teardownRoutes(String entrance) {
        boolean headerless = "lifecycleById".equals(entrance)
                || "closeById".equals(entrance);
        com.sun.net.httpserver.HttpHandler noContent = exchange -> {
            assertPrivateHeaders(exchange, !headerless);
            exchange.getResponseHeaders().set(
                    HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            exchange.getResponseHeaders().set("Connection", "close");
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        };
        server.createContext("/session/" + SESSION_ID + "/detach", noContent);
        server.createContext("/session/" + SESSION_ID, noContent);
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> sendSessionJson(exchange, 200,
                        sessionJson().replace(CLIENT_ID, "client-2")));
    }

    private static void endSession(HostedHarnessClient client,
            String entrance, HarnessSessionRef session) {
        Map<String, Object> authority =
                Map.of("operationId", "detach-1", "claimGeneration", 2);
        switch (entrance) {
            case "lifecycleById":
                client.detachLifecycle(SESSION_ID, authority);
                break;
            case "lifecycleByRef":
                client.detachLifecycle(session, authority);
                break;
            case "detachSession":
                client.detachSession(session);
                break;
            case "closeById":
                client.closeSession(SESSION_ID);
                break;
            case "closeByRef":
                client.closeSession(session);
                break;
            default:
                throw new IllegalArgumentException(entrance);
        }
    }

    @Test
    void terminalRecordsStayBoundedLeastRecentlyUsedFirst() throws Exception {
        // No teardown retires a terminal-event record, so the map bounds
        // itself: past the limit the least recently used session's record
        // goes, and a record read since keeps its place.
        try (HostedHarnessClient client = newClient()) {
            Field limitField = HostedHarnessClient.class.getDeclaredField(
                    "TERMINAL_RECORD_LIMIT");
            limitField.setAccessible(true);
            int limit = limitField.getInt(null);
            Field recordsField = HostedHarnessClient.class.getDeclaredField(
                    "terminalPromptIds");
            recordsField.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, String> records =
                    (Map<String, String>) recordsField.get(client);
            for (int i = 0; i < limit; i++) {
                records.put("session-" + i, "prompt-" + i);
            }
            assertEquals("prompt-0", records.get("session-0"));
            records.put("session-" + limit, "prompt-" + limit);
            assertEquals(limit, records.size());
            assertEquals("prompt-0", records.get("session-0"));
            assertNull(records.get("session-1"));
            assertEquals("prompt-" + limit, records.get("session-" + limit));
        }
    }

    // Swap the session's attachment heartbeat task for one whose cancel
    // parks until released: AttachmentState.cancel() runs right after a
    // detach removed the attachment and before its ledger retirement.
    private static void parkAttachmentCancel(HostedHarnessClient client,
            CountDownLatch entered, CountDownLatch release)
            throws ReflectiveOperationException {
        Field attachments =
                HostedHarnessClient.class.getDeclaredField("attachments");
        attachments.setAccessible(true);
        Object state = ((Map<?, ?>) attachments.get(client)).get(SESSION_ID);
        Field task = state.getClass().getDeclaredField("task");
        task.setAccessible(true);
        task.set(state, new ParkingCancelFuture(entered, release));
    }

    // Unbounded until saturated, then refuses offers (from one thread when
    // set): a burst of client setup tasks on a slow runner can never trip
    // the injected rejection.
    private static final class SaturatableQueue
            extends LinkedBlockingQueue<Runnable> {
        volatile boolean saturated;
        volatile Thread onlyFrom;

        @Override
        public boolean offer(Runnable task) {
            Thread only = onlyFrom;
            if (saturated
                    && (only == null || only == Thread.currentThread())) {
                return false;
            }
            return super.offer(task);
        }
    }

    private static final class ParkingCancelFuture
            implements ScheduledFuture<Object> {
        private final CountDownLatch entered;
        private final CountDownLatch release;

        ParkingCancelFuture(CountDownLatch entered, CountDownLatch release) {
            this.entered = entered;
            this.release = release;
        }

        @Override
        public boolean cancel(boolean mayInterruptIfRunning) {
            entered.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return true;
        }

        @Override
        public long getDelay(TimeUnit unit) {
            return 0;
        }

        @Override
        public int compareTo(Delayed other) {
            return 0;
        }

        @Override
        public boolean isCancelled() {
            return false;
        }

        @Override
        public boolean isDone() {
            return false;
        }

        @Override
        public Object get() {
            return null;
        }

        @Override
        public Object get(long timeout, TimeUnit unit) {
            return null;
        }
    }

    @Test
    void aProvenDeletingDetachRetiresAMarkerFromAnOlderIdentity() {
        // R6-1: a detach answered 204 proves the session deleted outright,
        // so the admission ledger retirement is unconditional — a marker
        // planted by an older attachment identity of the same id is
        // provably stale, exactly like the close path's split. The
        // tolerated-404 half stays identity-matched
        // (aStaleRefDetachKeepsTheCurrentOwnersMarker).
        runningStatusRoute();
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    exchange.getResponseHeaders().set("Connection", "close");
                    exchange.sendResponseHeaders(204, -1);
                    exchange.close();
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "detach-older-identity");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef first = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    first)));
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            // The current identity's 204 detach proves the session gone:
            // the older identity's marker retires with it.
            client.detachSession(reloaded);
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(reloaded)
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
    void aProvenDeletingLifecycleDetachRetiresAMarkerFromAnOlderIdentity() {
        // R10-4: the detachLifecycle twin — the ref overload's 204 is
        // the same deletion proof detachSession rides, so a marker
        // planted by an older identity of the same session id is
        // provably stale: the session no longer exists, nothing can
        // clear the marker, and it would veto every later identity after
        // the supported load recovery re-opens the id. The tolerated-404
        // half stays identity-matched
        // (aStaleRefLifecycleDetachKeepsTheCurrentOwnersMarker).
        runningStatusRoute();
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
        server.createContext("/session/" + SESSION_ID + "/load",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200,
                            sessionJson().replace(CLIENT_ID, "client-2"),
                            false);
                });
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 202,
                            "{\"promptId\":\"" + (call == 1 ? PROMPT_ID
                                    : SECOND_PROMPT_ID)
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}", false);
                });
        server.createContext("/session/" + SESSION_ID + "/detach",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    exchange.getResponseHeaders().set("Connection", "close");
                    exchange.sendResponseHeaders(204, -1);
                    exchange.close();
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "lifecycle-detach-older-identity");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef first = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    first)));
            HarnessSessionRef reloaded = client.loadSession(
                    new LoadHarnessSession(SESSION_ID));
            // The current identity's 204 lifecycle detach proves the
            // session gone: the older identity's marker retires with it.
            client.detachLifecycle(reloaded,
                    Map.of("operationId", "delete-1", "claimGeneration", 2));
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(reloaded)
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
    void aGenerationChangeCloseRacingAMarkerPlantLeavesNoVeto()
            throws Exception {
        // R11-1: the ref-based close's generation arm must not use the
        // observed-snapshot rule: a marker published while the DELETE was
        // in flight postdates the snapshot, and a proven restart kills
        // every local record for the old peer — the retained marker would
        // veto every later identity for the client's lifetime.
        generationChangeCloseRacingAMarkerPlantLeavesNoVeto(false);
    }

    @Test
    void aGenerationChangeCloseByIdRacingAMarkerPlantLeavesNoVeto()
            throws Exception {
        // R11-1: the by-id twin — the same unconditional retirement on a
        // proven restart, through discardLocalSessionState.
        generationChangeCloseRacingAMarkerPlantLeavesNoVeto(true);
    }

    private void generationChangeCloseRacingAMarkerPlantLeavesNoVeto(
            boolean byId) throws Exception {
        createSessionRoute();
        CountDownLatch sawDelete = new CountDownLatch(1);
        CountDownLatch releaseDelete = new CountDownLatch(1);
        server.createContext("/session/" + SESSION_ID, exchange -> {
            sawDelete.countDown();
            try {
                releaseDelete.await(15, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            sendJson(exchange, 404, "{\"code\":\"session_not_found\"}",
                    true, OTHER_BOOT_ID, !byId);
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
        Map<String, Object> block = Map.of(
                "type", "text", "text", "generation-close-race");
        ExecutorService callers = Executors.newSingleThreadExecutor();
        HostedHarnessClient client = newClient();
        try {
            HarnessSessionRef session = createSession(client);
            Future<Throwable> close = callers.submit(() -> {
                try {
                    if (byId) {
                        client.closeSession(SESSION_ID);
                    } else {
                        client.closeSession(session);
                    }
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(sawDelete.await(5, TimeUnit.SECONDS));
            // The DELETE is parked server-side; the submission plants its
            // marker mid-flight.
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            releaseDelete.countDown();
            Throwable failure = close.get(5, TimeUnit.SECONDS);
            assertTrue(failure instanceof HostedHarnessGenerationException,
                    String.valueOf(failure));
            // The proven restart retired the mid-flight marker: a
            // different identity is not vetoed locally and reaches the
            // wire.
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
            releaseDelete.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aCancelTurnGenerationChangeRetiresLocalState() {
        // R11-2: the generation-change retirement invariant must hold at
        // the shared mutation channel too: a fenced cancel answered by a
        // restarted peer proves every local record for that generation
        // dead, the admission ledger included — otherwise, with no
        // scheduled heartbeat armed, nothing ever retires the marker and
        // the ledger's veto wedges the session for the client's lifetime.
        createSessionRoute();
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
        server.createContext("/session/" + SESSION_ID + "/cancel",
                exchange -> sendJson(exchange, 200, "{}", true,
                        OTHER_BOOT_ID));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "cancel-generation");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.cancelTurn(session));
            // The ledger retired with the rest of the peer's state: a
            // different identity is not vetoed locally.
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
    void aTitleUpdateGenerationChangeRetiresLocalState() {
        // R11-2: a second sendMutation-routed entrance observes the same
        // proof through the shared channel and follows the same rule.
        createSessionRoute();
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
        server.createContext("/session/" + SESSION_ID + "/title",
                exchange -> sendJson(exchange, 200, "{}", true,
                        OTHER_BOOT_ID));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "title-generation");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.updateSessionTitle(session, "new title"));
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
    void aStreamFenceGenerationChangeRetiresLocalState() {
        // R11-2: the stream fence observes the same proof through
        // validateGeneration and follows the same rule: the peer
        // restarted, so every local record for it is dead.
        createSessionRoute();
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
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    exchange.getResponseHeaders().set("Content-Type",
                            "text/event-stream");
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER,
                            OTHER_BOOT_ID);
                    exchange.sendResponseHeaders(200, 0);
                    exchange.close();
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "stream-generation");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertNotNull(client.submitTurn(requestForSession(block,
                    session)));
            assertThrows(HostedHarnessGenerationException.class,
                    () -> client.streamEvents(StreamHarnessEvents.builder()
                            .session(session)
                            .eventEpoch(EVENT_EPOCH)
                            .build()));
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
    void anUnfencedRecoveryRequiredRefusalKeepsTheOwnedMarker() {
        // R12-1: an unfenced 409 carries the same refusal vocabulary as a
        // fenced one, so the release must be narrowed by refusal code
        // exactly the same way: a boot-header-stripped
        // hosted_prompt_recovery_required retains the marker (this
        // promptId already sits in the durable input log) and surfaces as
        // PromptAlreadyActiveException with its code intact — not as a
        // plain DaemonHttpException after a release.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendJson(exchange, 409,
                            "{\"code\":\"hosted_prompt_recovery_required\"}",
                            false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "unfenced-recovery");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            PromptAlreadyActiveException refusal = assertThrows(
                    PromptAlreadyActiveException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
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
    void anUnfencedCodelessConflictIsOutcomeUnknown() {
        // R15-3: an unfenced 409 whose body carries no refusal-vocabulary
        // code is not the route's answer — the intermediary that stripped
        // the boot header produced it — so it cannot prove this submission
        // was refused: the outcome is unknown and the owned marker stays
        // vetoing until a status read. Surfacing it as
        // DaemonHttpException(409) instead would let the turn consumer
        // retry the identical refused submission forever.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    promptCalls.incrementAndGet();
                    sendJson(exchange, 409, "{\"error\":\"conflict\"}",
                            false);
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "unfenced-codeless-conflict");

        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            assertThrows(PromptAdmissionUnknownException.class,
                    () -> client.submitTurn(requestForSession(block,
                            session)));
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
    void overlappingSameIdentityRefusalsReleaseTheMarker()
            throws Exception {
        // R11-3: when both the owning attempt and the joined same-identity
        // retry are definitively refused, the marker no attempt owns must
        // be discharged once the last send closes — otherwise the session
        // is wedged for the client's lifetime even though the wire knows
        // nothing is running. The owed release rides the retry's ledger
        // decision; an outcome-unknown conclusion would block it instead.
        createSessionRoute();
        CountDownLatch ownerSeen = new CountDownLatch(1);
        CountDownLatch releaseOwner = new CountDownLatch(1);
        CountDownLatch retrySeen = new CountDownLatch(1);
        CountDownLatch releaseRetry = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        ownerSeen.countDown();
                        try {
                            releaseOwner.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        sendSessionJson(exchange, 400,
                                "{\"code\":\"bad_prompt\"}");
                        return;
                    }
                    if (call == 2) {
                        retrySeen.countDown();
                        try {
                            releaseRetry.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        sendSessionJson(exchange, 400,
                                "{\"code\":\"bad_prompt\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "both-refused");
        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newFixedThreadPool(2);
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(digest)
                    .build();
            Future<Throwable> owner = callers.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(ownerSeen.await(5, TimeUnit.SECONDS));
            Future<Throwable> retry = callers.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(retrySeen.await(5, TimeUnit.SECONDS));
            // Both attempts are definitively refused; the owner's release
            // is owed to the retry's conclusion.
            releaseOwner.countDown();
            Throwable ownerFailure = owner.get(5, TimeUnit.SECONDS);
            assertTrue(ownerFailure instanceof DaemonHttpException,
                    String.valueOf(ownerFailure));
            assertEquals(400,
                    ((DaemonHttpException) ownerFailure).getStatusCode());
            releaseRetry.countDown();
            Throwable retryFailure = retry.get(5, TimeUnit.SECONDS);
            assertTrue(retryFailure instanceof DaemonHttpException,
                    String.valueOf(retryFailure));
            // Both arms proved the prompt was never admitted: the settled
            // marker is discharged and a different identity reaches the
            // wire.
            PromptReceipt receipt = client.submitTurn(
                    SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build());
            assertEquals(SECOND_PROMPT_ID, receipt.getPromptId());
            assertEquals(3, promptCalls.get());
        } finally {
            releaseOwner.countDown();
            releaseRetry.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aRetryDropThenAnOwnerRefusalKeepsTheMarker() throws Exception {
        // R15-4: the reverse conclusion order of
        // overlappingSameIdentityRefusalsReleaseTheMarker — the joined
        // retry's outcome-unknown drop concludes FIRST (blocking the owed
        // release), then the owner's definitive refusal concludes the
        // entry. The owner's settled release must honour the block: this
        // promptId may be admitted server-side, so the marker keeps
        // vetoing until a status read clears it.
        createSessionRoute();
        CountDownLatch ownerSeen = new CountDownLatch(1);
        CountDownLatch releaseOwner = new CountDownLatch(1);
        AtomicInteger promptCalls = new AtomicInteger();
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    int call = promptCalls.incrementAndGet();
                    if (call == 1) {
                        ownerSeen.countDown();
                        try {
                            releaseOwner.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        sendSessionJson(exchange, 400,
                                "{\"code\":\"bad_prompt\"}");
                        return;
                    }
                    if (call == 2) {
                        // The retry's send is dropped before any answer.
                        exchange.close();
                        return;
                    }
                    sendSessionJson(exchange, 202,
                            "{\"promptId\":\"" + SECOND_PROMPT_ID
                                    + "\",\"lastEventId\":0,"
                                    + "\"eventEpoch\":\""
                                    + EVENT_EPOCH + "\"}");
                });
        Map<String, Object> block = Map.of(
                "type", "text", "text", "retry-drop-then-refusal");
        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newFixedThreadPool(2);
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(digest)
                    .build();
            Future<Throwable> owner = callers.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            assertTrue(ownerSeen.await(5, TimeUnit.SECONDS));
            Future<Throwable> retry = callers.submit(() -> {
                try {
                    client.submitTurn(first);
                    return null;
                } catch (Throwable failure) {
                    return failure;
                }
            });
            // The retry's dropped send concludes outcome-unknown first.
            Throwable retryFailure = retry.get(5, TimeUnit.SECONDS);
            assertTrue(retryFailure
                            instanceof PromptAdmissionUnknownException,
                    String.valueOf(retryFailure));
            // The owner's definitive refusal concludes the entry: the
            // blocked release keeps the marker.
            releaseOwner.countDown();
            Throwable ownerFailure = owner.get(5, TimeUnit.SECONDS);
            assertTrue(ownerFailure instanceof DaemonHttpException,
                    String.valueOf(ownerFailure));
            assertEquals(400,
                    ((DaemonHttpException) ownerFailure).getStatusCode());
            DaemonException veto = assertThrows(DaemonException.class,
                    () -> client.submitTurn(SubmitHarnessTurn.builder()
                            .session(session)
                            .promptId(SECOND_PROMPT_ID)
                            .addContent(block)
                            .payloadDigest(digest)
                            .build()));
            assertEquals("Hosted Harness session already has a running turn",
                    veto.getMessage());
            assertEquals(2, promptCalls.get());
        } finally {
            releaseOwner.countDown();
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void anOwnerReleaseDuringARetryRepublishKeepsTheLedger()
            throws Exception {
        // R10-3: the non-owning retry's send window must stay open until
        // its 202 republish has landed: an owning release that runs
        // between the window's close and the replace drops the joined
        // entry, the replace silently no-ops, and the admitted turn is
        // left with no ledger entry — the local one-turn veto degrades to
        // its own absence. The window is CPU-sized, so the interleaving is
        // staged by rate: a parse-heavy 202 body widens it, the owner's
        // refusal is released into it, and every round must keep the veto.
        createSessionRoute();
        AtomicInteger promptCalls = new AtomicInteger();
        AtomicReference<CountDownLatch> ownerSeen = new AtomicReference<>();
        AtomicReference<CountDownLatch> ownerRelease =
                new AtomicReference<>();
        AtomicReference<CountDownLatch> retryWritten =
                new AtomicReference<>();
        String paddedAdmission = "{\"promptId\":\"" + PROMPT_ID
                + "\",\"lastEventId\":0,\"eventEpoch\":\"" + EVENT_EPOCH
                + "\",\"pad\":[" + String.join(",",
                        java.util.Collections.nCopies(110_000, "\"aaaa\""))
                + "]}";
        server.createContext("/session/" + SESSION_ID + "/prompt",
                exchange -> {
                    String promptId = (String) JsonSupport.parseObject(
                            readBody(exchange), "prompt").get("promptId");
                    int call = promptCalls.incrementAndGet();
                    if (!PROMPT_ID.equals(promptId)) {
                        sendSessionJson(exchange, 202,
                                "{\"promptId\":\"" + promptId
                                        + "\",\"lastEventId\":0,"
                                        + "\"eventEpoch\":\""
                                        + EVENT_EPOCH + "\"}");
                        return;
                    }
                    if (call % 2 == 1) {
                        ownerSeen.get().countDown();
                        try {
                            assertTrue(ownerRelease.get().await(15,
                                    TimeUnit.SECONDS));
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        sendSessionJson(exchange, 400,
                                "{\"code\":\"bad_prompt\"}");
                        return;
                    }
                    sendSessionJson(exchange, 202, paddedAdmission);
                    retryWritten.get().countDown();
                });
        AtomicBoolean harnessActive = new AtomicBoolean();
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> sendSessionJson(exchange, 200,
                        "{\"sessionId\":\"" + SESSION_ID
                                + "\",\"hasActivePrompt\":"
                                + harnessActive.get() + "}"));
        Map<String, Object> block = Map.of(
                "type", "text", "text", "republish-window");
        String digest = SubmitHarnessTurn.computePayloadDigest(
                List.of(block));

        HostedHarnessClient client = newClient();
        ExecutorService callers = Executors.newFixedThreadPool(2);
        try {
            HarnessSessionRef session = createSession(client);
            SubmitHarnessTurn first = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(digest)
                    .build();
            SubmitHarnessTurn second = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(SECOND_PROMPT_ID)
                    .addContent(block)
                    .payloadDigest(digest)
                    .build();
            int vetoFailures = 0;
            for (int round = 0; round < 60; round++) {
                // Clear last round's settled marker through the documented
                // recovery path.
                harnessActive.set(false);
                assertFalse(client.getStatus(session).hasActivePrompt());
                ownerSeen.set(new CountDownLatch(1));
                ownerRelease.set(new CountDownLatch(1));
                retryWritten.set(new CountDownLatch(1));
                Future<Throwable> owner = callers.submit(() -> {
                    try {
                        client.submitTurn(first);
                        return null;
                    } catch (Throwable failure) {
                        return failure;
                    }
                });
                assertTrue(ownerSeen.get().await(5, TimeUnit.SECONDS));
                Future<Throwable> retry = callers.submit(() -> {
                    try {
                        client.submitTurn(first);
                        return null;
                    } catch (Throwable failure) {
                        return failure;
                    }
                });
                // The retry's 202 is fully written; releasing the owner's
                // refusal now lands it inside the retry's post-response
                // window while the padded body is consumed and parsed.
                assertTrue(retryWritten.get().await(10, TimeUnit.SECONDS));
                Thread.sleep(2);
                ownerRelease.get().countDown();
                Throwable ownerFailure = owner.get(10, TimeUnit.SECONDS);
                assertTrue(ownerFailure instanceof DaemonHttpException,
                        String.valueOf(ownerFailure));
                assertNull(retry.get(10, TimeUnit.SECONDS));
                // The busy-turn probe in the veto below reads a Harness
                // that reports the re-admitted prompt running.
                harnessActive.set(true);
                try {
                    client.submitTurn(second);
                    vetoFailures++;
                } catch (DaemonException veto) {
                    assertEquals(
                            "Hosted Harness session already has a running turn",
                            veto.getMessage());
                }
            }
            assertEquals(0, vetoFailures,
                    "a republished marker was lost to an owning release");
        } finally {
            callers.shutdownNow();
            client.close();
        }
    }

    @Test
    void aSaturatedHttpExecutorReleasesTheOwnedMarker() throws Exception {
        // R13-1: a submit-time rejection from a saturated but RUNNING pool
        // proves non-dispatch just like a terminated pool does: sendAsync
        // surfaces it synchronously, so it is a known-outcome
        // DaemonTransportException and the owned marker is released. JDK 11
        // parks such sends instead of surfacing the rejection (probed on
        // 11/17/21), so the deterministic arm runs on 17+ only.
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
        SaturatableQueue queue = new SaturatableQueue();
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L,
                TimeUnit.MILLISECONDS, queue,
                runnable -> {
                    Thread thread = new Thread(runnable,
                            "http-saturated-running");
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
        CountDownLatch parkerEntered = new CountDownLatch(1);
        CountDownLatch parkerRelease = new CountDownLatch(1);
        try {
            HarnessSessionRef session = createSession(client);
            // Saturate the RUNNING pool: one parked worker, a full queue.
            executor.execute(() -> {
                parkerEntered.countDown();
                try {
                    assertTrue(parkerRelease.await(15, TimeUnit.SECONDS));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            assertTrue(parkerEntered.await(5, TimeUnit.SECONDS));
            // Only the caller's dispatch: a rejected selector-thread task
            // trailing createSession would abort the client instead.
            queue.onlyFrom = Thread.currentThread();
            queue.saturated = true;
            try {
                Map<String, Object> block = Map.of(
                        "type", "text", "text", "saturated-executor");
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
                // The released marker does not veto a different identity:
                // the next submission reaches dispatch and fails on the
                // still-saturated executor rather than at the local veto.
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
                parkerRelease.countDown();
            }
        } finally {
            client.close();
            executor.shutdownNow();
        }
    }

    private void createSessionRoute() {
        server.createContext("/session", exchange ->
                sendSessionJson(exchange, 200, sessionJson()));
    }

    // The busy-turn probe's answer for fixtures whose vetoing prompt is
    // still running on the Harness. Without a /status route the probe's GET
    // falls through to a prefix handler whose header assertion fails on
    // the server thread, and the probe waits out the request timeout.
    private void runningStatusRoute() {
        server.createContext("/session/" + SESSION_ID + "/status",
                exchange -> {
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    sendJson(exchange, 200, "{\"sessionId\":\""
                            + SESSION_ID + "\",\"hasActivePrompt\":true}",
                            false);
                });
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

    // The keepalive feature arms the idle watchdog (#14135); fixtures for
    // the watchdog advertise it the way the current Harness does.
    private void advertiseEventKeepalive() {
        capabilitiesBody.set(capabilitiesJson(DIGEST, BOOT_ID).replace(
                "\"hostedHarness\":{",
                "\"hostedHarness\":{\"features\":[\""
                        + HostedHarnessClient.EVENT_KEEPALIVE_FEATURE
                        + "\"],"));
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

    @Test
    void modelSelectionIsOptionalNegotiatedAndPartOfActivePromptIdentity() {
        server.createContext("/session", exchange -> sendSessionJson(exchange, 200, sessionJson()));
        capabilitiesBody.set(capabilitiesJson(DIGEST, BOOT_ID).replace("\"hostedHarness\":{",
                "\"hostedHarness\":{\"features\":[\"model-selection/1\"],"));
        AtomicReference<String> sent = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/prompt", exchange -> {
            sent.set(readBody(exchange));
            sendSessionJson(exchange, 202, "{\"promptId\":\"" + PROMPT_ID
                    + "\",\"lastEventId\":0,\"eventEpoch\":\"" + EVENT_EPOCH + "\"}");
        });
        Map<String, Object> block = Map.of("type", "text", "text", "hello");
        String digest = SubmitHarnessTurn.computePayloadDigest(List.of(block));
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            var first = SubmitHarnessTurn.builder().session(session).promptId(PROMPT_ID).addContent(block)
                    .payloadDigest(digest).modelSelection("model-a", 1).build();
            client.submitTurn(first);
            assertTrue(sent.get().contains("\"modelSelection\""));
            assertTrue(sent.get().contains("\"modelId\":\"model-a\""));
            assertTrue(sent.get().contains("\"revision\":1"));
            client.submitTurn(first);
            assertThrows(DaemonException.class, () -> client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session).promptId(PROMPT_ID).addContent(block).payloadDigest(digest)
                    .modelSelection("model-b", 2).build()));
            assertThrows(IllegalArgumentException.class,
                    () -> SubmitHarnessTurn.builder().modelSelection("model-a", 0));
            assertThrows(IllegalArgumentException.class,
                    () -> SubmitHarnessTurn.builder().modelSelection("model-a", 9_007_199_254_740_992L));
        }
    }

    @Test
    void refusesModelSelectionWhenTheHostDidNotAdvertiseIt() {
        server.createContext("/session", exchange -> sendSessionJson(exchange, 200, sessionJson()));
        Map<String, Object> block = Map.of("type", "text", "text", "hello");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            var request = SubmitHarnessTurn.builder().session(session).promptId(PROMPT_ID).addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(List.of(block)))
                    .modelSelection("model-a", 1).build();
            assertThrows(DaemonException.class, () -> client.submitTurn(request));
        }
    }

    @Test
    void approvalSelectionIsOptionalNegotiatedAndPartOfActivePromptIdentity() {
        server.createContext("/session", exchange -> sendSessionJson(exchange, 200, sessionJson()));
        capabilitiesBody.set(capabilitiesJson(DIGEST, BOOT_ID).replace("\"hostedHarness\":{",
                "\"hostedHarness\":{\"features\":[\"approval-selection/1\"],"));
        AtomicReference<String> sent = new AtomicReference<>();
        server.createContext("/session/" + SESSION_ID + "/prompt", exchange -> {
            sent.set(readBody(exchange));
            sendSessionJson(exchange, 202, "{\"promptId\":\"" + PROMPT_ID
                    + "\",\"lastEventId\":0,\"eventEpoch\":\"" + EVENT_EPOCH + "\"}");
        });
        Map<String, Object> block = Map.of("type", "text", "text", "hello");
        String digest = SubmitHarnessTurn.computePayloadDigest(List.of(block));
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            var first = SubmitHarnessTurn.builder().session(session).promptId(PROMPT_ID).addContent(block)
                    .payloadDigest(digest).approvalSelection("yolo", 1).build();
            client.submitTurn(first);
            assertTrue(sent.get().contains("\"approvalSelection\""));
            assertTrue(sent.get().contains("\"mode\":\"yolo\""));
            assertTrue(sent.get().contains("\"revision\":1"));
            client.submitTurn(first);
            assertThrows(DaemonException.class, () -> client.submitTurn(SubmitHarnessTurn.builder()
                    .session(session).promptId(PROMPT_ID).addContent(block).payloadDigest(digest)
                    .approvalSelection("auto-edit", 2).build()));
            assertThrows(IllegalArgumentException.class,
                    () -> SubmitHarnessTurn.builder().approvalSelection("yolo", -1));
            assertThrows(IllegalArgumentException.class,
                    () -> SubmitHarnessTurn.builder().approvalSelection("yolo", 9_007_199_254_740_992L));
        }
    }

    @Test
    void refusesApprovalSelectionWhenTheHostDidNotAdvertiseIt() {
        server.createContext("/session", exchange -> sendSessionJson(exchange, 200, sessionJson()));
        Map<String, Object> block = Map.of("type", "text", "text", "hello");
        try (HostedHarnessClient client = newClient()) {
            HarnessSessionRef session = createSession(client);
            var request = SubmitHarnessTurn.builder().session(session).promptId(PROMPT_ID).addContent(block)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(List.of(block)))
                    .approvalSelection("yolo", 1).build();
            assertThrows(DaemonException.class, () -> client.submitTurn(request));
        }
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

    private static String sessionJsonWithAgentWaitRuntimeRecovery() {
        return "{\"sessionId\":\"" + SESSION_ID
                + "\",\"workspaceCwd\":\"/control\","
                + "\"attached\":true,\"clientId\":\"" + CLIENT_ID
                + "\",\"lastEventId\":0,\"eventEpoch\":\""
                + EVENT_EPOCH
                + "\",\"_meta\":{\"qwen.daemon.managedRuntimeRecovery\":{"
                + "\"phase\":\"await_agent\","
                + "\"checkpointId\":\"checkpoint-3\","
                + "\"activationId\":\"activation-3\",\"executions\":[{"
                + "\"functionCallId\":\"function-1\","
                + "\"toolName\":\"agent\","
                + "\"executionCallId\":\"run-1\","
                + "\"runtimeSessionId\":\"prompt-1\","
                + "\"outcome\":\"known\","
                + "\"status\":{\"state\":\"executing\"}},{"
                + "\"functionCallId\":\"function-2\","
                + "\"toolName\":\"agent\","
                + "\"executionCallId\":\"run-2\","
                + "\"runtimeSessionId\":\"prompt-1\","
                + "\"outcome\":\"known\","
                + "\"status\":{\"state\":\"settled\"}}]}}}";
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

    private static String sessionJsonWithAbandonedRuntimeRecovery() {
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
                + "\"toolName\":\"write_file\","
                + "\"executionCallId\":\"execution-1\","
                + "\"runtimeSessionId\":\"runtime-1\","
                + "\"progressCursor\":null,\"outcome\":\"known\","
                + "\"status\":{\"state\":\"abandoned\"}}]}}}";
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
        assertPrivateHeaders(exchange);
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
