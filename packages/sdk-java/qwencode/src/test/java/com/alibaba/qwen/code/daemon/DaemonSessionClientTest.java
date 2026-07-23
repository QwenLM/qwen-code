package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class DaemonSessionClientTest {

    private HttpServer server;
    private ExecutorService serverExecutor;
    private URI baseUri;
    private AtomicReference<String> createBody;

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverExecutor = Executors.newCachedThreadPool();
        createBody = new AtomicReference<>();
        server.setExecutor(serverExecutor);
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                "{\"v\":1,\"mode\":\"http-bridge\",\"features\":["
                        + "\"session_scope_override\",\"client_heartbeat\","
                        + "\"prompt_absolute_deadline\"],"
                        + "\"transports\":[\"rest\"]}"));
        server.createContext("/session", exchange -> {
            if ("POST".equals(exchange.getRequestMethod())
                    && "/session".equals(exchange.getRequestURI().getPath())) {
                createBody.set(new String(exchange.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8));
                sendJson(exchange, 200, sessionJson());
                return;
            }
            sendJson(exchange, 404, "{}");
        });
        server.start();
        baseUri = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
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
    void replaysTextAndTerminalEmittedBeforeAdmissionResponse() {
        AtomicReference<String> lastEventId = new AtomicReference<>();
        AtomicReference<String> acceptEncoding = new AtomicReference<>();
        AtomicReference<String> authorization = new AtomicReference<>();
        AtomicReference<String> clientId = new AtomicReference<>();
        AtomicReference<String> promptBody = new AtomicReference<>();
        AtomicReference<String> replay = new AtomicReference<>();
        server.createContext("/session/session-1/prompt", exchange -> {
            promptBody.set(new String(exchange.getRequestBody().readAllBytes(),
                    StandardCharsets.UTF_8));
            replay.set(textEvent(1, "hello") + terminalEvent(2));
            sendJson(exchange, 202,
                    "{\"promptId\":\"prompt-1\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/events", exchange -> {
            lastEventId.set(exchange.getRequestHeaders().getFirst("Last-Event-ID"));
            acceptEncoding.set(exchange.getRequestHeaders().getFirst("Accept-Encoding"));
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            clientId.set(exchange.getRequestHeaders().getFirst("X-Qwen-Client-Id"));
            sendSse(exchange, replay.get());
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder().bearerToken("test-token").build();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTextResult result = session.promptText(PromptRequest.builder()
                    .addText("say hello")
                    .deadline(Duration.ofMillis(1234))
                    .build());
            assertEquals("hello", result.getText());
            assertEquals(PromptTerminal.Kind.COMPLETE, result.getTerminal().getKind());
            assertEquals("0", lastEventId.get());
            assertEquals("identity", acceptEncoding.get());
            assertEquals("Bearer test-token", authorization.get());
            assertEquals("client-1", clientId.get());
            assertTrue(createBody.get().contains("\"sessionScope\":\"thread\""));
            assertTrue(promptBody.get().contains("\"deadlineMs\":1234"));
        }
    }

    @Test
    void exposesCapabilitiesWithoutFastjsonTypes() {
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                "{\"v\":1,\"mode\":\"http-bridge\",\"features\":["
                        + "\"session_events\"],\"transports\":[\"rest\"],"
                        + "\"workspaceCwd\":\"/tmp/work\"}"));

        try (DaemonClient daemon = newClient()) {
            DaemonCapabilities capabilities = daemon.capabilities();
            assertTrue(capabilities.supports("session_events"));
            assertEquals(List.of("rest"), capabilities.getTransports());
            assertTrue(!capabilities.getRaw().getClass().getName()
                    .startsWith("com.alibaba.fastjson2"));
        }
    }

    @Test
    void rejectsCredentialsInBaseUri() {
        IllegalArgumentException failure = assertThrows(
                IllegalArgumentException.class,
                () -> DaemonClient.builder()
                        .baseUri(URI.create("http://user:password@127.0.0.1:4170"))
                        .build());
        assertTrue(failure.getMessage().contains("without credentials"));
    }

    @Test
    void rejectsMissingCapabilitiesTransports() {
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                "{\"v\":1,\"mode\":\"http-bridge\",\"features\":[]}"));

        try (DaemonClient daemon = newClient()) {
            assertThrows(DaemonProtocolException.class, daemon::capabilities);
        }
    }

    @Test
    void refusesToCreateWhenThreadScopeCannotBeGuaranteed() {
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                "{\"v\":1,\"mode\":\"http-bridge\",\"features\":[],"
                        + "\"transports\":[\"rest\"]}"));

        try (DaemonClient daemon = newClient()) {
            assertThrows(DaemonProtocolException.class, daemon::createSession);
            assertEquals(null, createBody.get());
        }
    }

    @Test
    void refusesToCreateWhenRestTransportIsNotAdvertised() {
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                "{\"v\":1,\"mode\":\"http-bridge\",\"features\":["
                        + "\"session_scope_override\"],"
                        + "\"transports\":[\"websocket\"]}"));

        try (DaemonClient daemon = newClient()) {
            assertThrows(DaemonProtocolException.class, daemon::createSession);
            assertEquals(null, createBody.get());
        }
    }

    @Test
    void slowSessionCreationDoesNotBlockExistingSessionMutation()
            throws Exception {
        CountDownLatch createStarted = new CountDownLatch(1);
        CountDownLatch releaseCreate = new CountDownLatch(1);
        CountDownLatch cancelReceived = new CountDownLatch(1);
        server.createContext("/session/session-1/cancel", exchange -> {
            cancelReceived.countDown();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());
        server.createContext("/session/session-2/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient first = daemon.createSession()) {
            server.removeContext("/session");
            server.createContext("/session", exchange -> {
                createStarted.countDown();
                await(releaseCreate);
                sendJson(exchange, 200,
                        sessionJson("session-2", "client-2"));
            });
            CompletableFuture<DaemonSessionClient> creating =
                    CompletableFuture.supplyAsync(daemon::createSession);
            try {
                assertTrue(createStarted.await(1, TimeUnit.SECONDS));
                CompletableFuture<Void> cancelling = CompletableFuture.runAsync(
                        first::cancelActivePrompt);
                assertTrue(cancelReceived.await(1, TimeUnit.SECONDS));
                cancelling.get(1, TimeUnit.SECONDS);
            } finally {
                releaseCreate.countDown();
            }
            try (DaemonSessionClient second = creating.get(1, TimeUnit.SECONDS)) {
                assertEquals("session-2", second.getSessionId());
            }
        }
    }

    @Test
    void clientCloseDetachesSessionCreatedByLosingRace() throws Exception {
        CountDownLatch createStarted = new CountDownLatch(1);
        CountDownLatch releaseCreate = new CountDownLatch(1);
        CountDownLatch detachReceived = new CountDownLatch(1);
        AtomicReference<String> detachedClient = new AtomicReference<>();
        server.removeContext("/session");
        server.createContext("/session", exchange -> {
            createStarted.countDown();
            await(releaseCreate);
            sendJson(exchange, 200, sessionJson("session-2", "client-2"));
        });
        server.createContext("/session/session-2/detach", exchange -> {
            detachedClient.set(exchange.getRequestHeaders()
                    .getFirst("X-Qwen-Client-Id"));
            detachReceived.countDown();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });

        DaemonClient daemon = newClient();
        CompletableFuture<DaemonSessionClient> creating =
                CompletableFuture.supplyAsync(daemon::createSession);
        try {
            assertTrue(createStarted.await(1, TimeUnit.SECONDS));
            CompletableFuture.runAsync(daemon::close)
                    .get(1, TimeUnit.SECONDS);
            assertTrue(!creating.isDone());
            releaseCreate.countDown();
            CompletionException failure = assertThrows(
                    CompletionException.class, creating::join);
            assertInstanceOf(IllegalStateException.class, failure.getCause());
            assertTrue(detachReceived.await(1, TimeUnit.SECONDS));
            assertEquals("client-2", detachedClient.get());
        } finally {
            releaseCreate.countDown();
            daemon.close();
        }
    }

    @Test
    void refusesDeadlineBeforePromptWhenDaemonCannotGuaranteeIt() {
        AtomicInteger promptRequests = new AtomicInteger();
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                "{\"v\":1,\"mode\":\"http-bridge\",\"features\":["
                        + "\"session_scope_override\"],"
                        + "\"transports\":[\"rest\"]}"));
        server.createContext("/session/session-1/prompt", exchange -> {
            promptRequests.incrementAndGet();
            sendJson(exchange, 202,
                    "{\"promptId\":\"prompt-1\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptRequest request = PromptRequest.builder()
                    .addText("go")
                    .deadline(Duration.ofSeconds(1))
                    .build();
            assertThrows(DaemonProtocolException.class,
                    () -> session.startPrompt(request, PromptObserver.NOOP));
            assertEquals(0, promptRequests.get());
        }
    }

    @Test
    void rejectsDeadlineOutsideMillisecondRange() {
        assertThrows(IllegalArgumentException.class,
                () -> PromptRequest.builder().addText("go")
                        .deadline(Duration.ofSeconds(Long.MAX_VALUE)));
    }

    @Test
    void enforcesDaemonDeadlineTimerRange() {
        PromptRequest maximum = PromptRequest.builder().addText("go")
                .deadline(Duration.ofMillis(Integer.MAX_VALUE))
                .build();
        assertEquals(Long.valueOf(Integer.MAX_VALUE),
                maximum.getDeadlineMillis());
        assertThrows(IllegalArgumentException.class,
                () -> PromptRequest.builder().addText("go")
                        .deadline(Duration.ofMillis(
                                (long) Integer.MAX_VALUE + 1L)));
    }

    @Test
    void reconnectsFromCommittedCursorAndDeduplicatesReplay() {
        AtomicInteger subscriptions = new AtomicInteger();
        List<String> cursors = new ArrayList<>();
        List<String> observed = new ArrayList<>();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            synchronized (cursors) {
                cursors.add(exchange.getRequestHeaders().getFirst("Last-Event-ID"));
            }
            if (subscriptions.incrementAndGet() == 1) {
                sendSse(exchange, textEvent(1, "one"));
            } else {
                sendSse(exchange, textEvent(1, "duplicate") + terminalEvent(2));
            }
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    new PromptObserver() {
                        @Override
                        public void onText(String text, DaemonEvent event) {
                            observed.add(text);
                        }
                    });
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    call.completionFuture().join().getKind());
        }
        assertEquals(List.of("one"), observed);
        assertEquals(List.of("0", "1"), cursors);
    }

    @Test
    void retainsServerRetryDelayAcrossSseConnections() {
        AtomicInteger subscriptions = new AtomicInteger();
        List<Long> openedAt = new ArrayList<>();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            synchronized (openedAt) {
                openedAt.add(System.nanoTime());
            }
            int attempt = subscriptions.incrementAndGet();
            if (attempt == 1) {
                byte[] retry = "retry: 1000\n\n".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type",
                        "text/event-stream");
                exchange.sendResponseHeaders(200, retry.length);
                exchange.getResponseBody().write(retry);
                exchange.close();
            } else if (attempt == 2) {
                exchange.getResponseHeaders().set("Content-Type",
                        "text/event-stream");
                exchange.sendResponseHeaders(200, -1);
                exchange.close();
            } else {
                sendSse(exchange, terminalEvent(1));
            }
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    session.startPrompt(PromptRequest.text("go"),
                            PromptObserver.NOOP).completionFuture().join().getKind());
        }
        assertEquals(3, openedAt.size());
        assertTrue(Duration.ofNanos(openedAt.get(1) - openedAt.get(0))
                .toMillis() >= 800);
        assertTrue(Duration.ofNanos(openedAt.get(2) - openedAt.get(1))
                .toMillis() >= 800);
    }

    @Test
    void failsClosedOnIdGapAndReturnsIncompletePartialText() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, textEvent(1, "partial") + terminalEvent(3)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptOutcomeIndeterminateException failure = assertThrows(
                    PromptOutcomeIndeterminateException.class,
                    () -> session.promptText("go"));
            assertEquals("partial", failure.getPartialText());
            assertTrue(failure.hasIncompletePartialText());
        }
    }

    @Test
    void malformedTextChunkCannotBecomeTruncatedSuccess() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                updateEvent(1, "agent_message_chunk",
                        "\"content\":{\"type\":\"text\"}")
                        + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptOutcomeIndeterminateException failure = assertThrows(
                    PromptOutcomeIndeterminateException.class,
                    () -> session.promptText("go"));
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
            assertThrows(PromptAlreadyActiveException.class,
                    () -> session.startPrompt(
                            PromptRequest.text("unsafe-reuse"),
                            PromptObserver.NOOP));
        }
    }

    @Test
    void updateForAnotherSessionCannotContaminatePromptText() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        String wrongSessionUpdate = textEvent(1, "wrong")
                .replace("\"sessionId\":\"session-1\"",
                        "\"sessionId\":\"session-2\"");
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                wrongSessionUpdate + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptOutcomeIndeterminateException failure = assertThrows(
                    PromptOutcomeIndeterminateException.class,
                    () -> session.promptText("go"));
            assertEquals("", failure.getPartialText());
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
        }
    }

    @Test
    void malformedTerminalCannotBecomeSuccess() {
        AtomicInteger rawEvents = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                "id: 1\nevent: turn_complete\ndata: {\"id\":1,\"v\":1,"
                        + "\"type\":\"turn_complete\",\"promptId\":"
                        + "\"prompt-1\",\"data\":{\"sessionId\":"
                        + "\"session-1\",\"promptId\":\"prompt-1\"}}\n\n"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            new PromptObserver() {
                                @Override
                                public void onEvent(DaemonEvent event) {
                                    rawEvents.incrementAndGet();
                                }
                            }).completionFuture().join());
            PromptOutcomeIndeterminateException outcome = assertInstanceOf(
                    PromptOutcomeIndeterminateException.class, failure.getCause());
            assertInstanceOf(DaemonProtocolException.class, outcome.getCause());
            assertEquals(0, rawEvents.get());
        }
    }

    @Test
    void duplicateTerminalFieldCannotBecomeSuccess() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                "id: 1\nevent: turn_complete\ndata: {\"id\":1,\"v\":1,"
                        + "\"type\":\"turn_complete\",\"promptId\":"
                        + "\"prompt-1\",\"data\":{\"sessionId\":"
                        + "\"session-1\",\"promptId\":\"prompt-1\","
                        + "\"stopReason\":\"end_turn\","
                        + "\"stopReason\":\"other\"}}\n\n"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            PromptObserver.NOOP).completionFuture().join());
            PromptOutcomeIndeterminateException outcome = assertInstanceOf(
                    PromptOutcomeIndeterminateException.class, failure.getCause());
            assertInstanceOf(DaemonProtocolException.class, outcome.getCause());
        }
    }

    @Test
    void terminalForAnotherSessionCannotCompletePrompt() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEventForSession(1, "session-2")));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            PromptObserver.NOOP).completionFuture().join());
            PromptOutcomeIndeterminateException outcome = assertInstanceOf(
                    PromptOutcomeIndeterminateException.class, failure.getCause());
            assertInstanceOf(DaemonProtocolException.class, outcome.getCause());
        }
    }

    @Test
    void malformedPermissionRequestFailsClosed() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        String malformedPermission = permissionEvent(1)
                .replace("\"toolCallId\":\"tool-1\"",
                        "\"toolCallId\":null");
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, malformedPermission + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            new PromptObserver() {
                                @Override
                                public void onPermission(PermissionRequest request,
                                        DaemonEvent event) {
                                    fail("Malformed permission must not be dispatched");
                                }
                            }).completionFuture().join());
            PromptOutcomeIndeterminateException outcome = assertInstanceOf(
                    PromptOutcomeIndeterminateException.class, failure.getCause());
            assertInstanceOf(DaemonProtocolException.class, outcome.getCause());
        }
    }

    @Test
    void observerFailureDoesNotBecomeSuccess() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, textEvent(1, "hello") + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    new PromptObserver() {
                        @Override
                        public void onText(String text, DaemonEvent event) {
                            throw new IllegalStateException("observer failed");
                        }
                    });
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
        }
    }

    @Test
    void slowTerminalObserverCannotOutrunObservationTimeout() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEvent(1)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptRequest request = PromptRequest.text("go")
                    .withObservationTimeout(Duration.ofMillis(100));
            PromptCall call = session.startPrompt(request, new PromptObserver() {
                @Override
                public void onEvent(DaemonEvent event) {
                    sleep(200);
                }
            });
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
        }
    }

    @Test
    void dispatchesThoughtToolUsagePermissionAndRawEventsInOrder() {
        List<String> calls = new ArrayList<>();
        AtomicReference<String> permissionBody = new AtomicReference<>();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                updateEvent(1, "agent_thought_chunk",
                        "\"content\":{\"type\":\"text\",\"text\":\"think\"}")
                        + updateEvent(2, "tool_call",
                                "\"toolCallId\":\"tool-1\",\"title\":\"Read\","
                                        + "\"content\":[{\"type\":\"text\","
                                        + "\"text\":\"starting\"}]")
                        + updateEvent(3, "agent_message_chunk",
                                "\"content\":{\"type\":\"text\",\"text\":\"\"},"
                                        + "\"_meta\":{\"usage\":{\"inputTokens\":3}}")
                        + permissionEvent(4) + terminalEvent(5)));
        server.createContext("/session/session-1/permission/request-1", exchange -> {
            permissionBody.set(new String(exchange.getRequestBody().readAllBytes(),
                    StandardCharsets.UTF_8));
            sendJson(exchange, 200, "{}");
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptObserver observer = new PromptObserver() {
                @Override
                public void onThought(String thought, DaemonEvent event) {
                    calls.add("thought:" + thought);
                }

                @Override
                public void onTool(java.util.Map<String, Object> update,
                        DaemonEvent event) {
                    calls.add("tool:" + update.get("toolCallId"));
                }

                @Override
                public void onUsage(java.util.Map<String, Object> usage,
                        DaemonEvent event) {
                    calls.add("usage:" + usage.get("inputTokens"));
                }

                @Override
                public void onPermission(PermissionRequest request,
                        DaemonEvent event) {
                    calls.add("permission:" + request.getRequestId());
                    assertTrue(session.respondToPermission(request.getRequestId(),
                            PermissionResponse.selected("allow_once")));
                }

                @Override
                public void onEvent(DaemonEvent event) {
                    calls.add("raw:" + event.getId());
                }
            };
            PromptTerminal terminal = session.startPrompt(PromptRequest.text("go"),
                    observer).completionFuture().join();
            assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
        }
        assertEquals(List.of("thought:think", "raw:1", "tool:tool-1", "raw:2",
                "usage:3", "raw:3", "permission:request-1", "raw:4", "raw:5"),
                calls);
        assertTrue(permissionBody.get().contains("\"optionId\":\"allow_once\""));
    }

    @Test
    void dispatchesAcpUsageUpdateToTypedObserver() {
        AtomicReference<Map<String, Object>> observed = new AtomicReference<>();
        AtomicInteger usageCalls = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                updateEvent(1, "usage_update", "\"used\":12,\"size\":100,"
                        + "\"_meta\":{\"usage\":{\"inputTokens\":3}}")
                        + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTerminal terminal = session.startPrompt(PromptRequest.text("go"),
                    new PromptObserver() {
                        @Override
                        public void onUsage(Map<String, Object> usage,
                                DaemonEvent event) {
                            usageCalls.incrementAndGet();
                            observed.set(usage);
                        }
                    }).completionFuture().join();
            assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
        }
        assertEquals(12L, ((Number) observed.get().get("used")).longValue());
        assertEquals(100L, ((Number) observed.get().get("size")).longValue());
        assertEquals(1, usageCalls.get());
    }

    @Test
    void ignoresOpaqueUsageMetadata() {
        AtomicInteger rawEvents = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                updateEvent(1, "agent_message_chunk",
                        "\"content\":{\"type\":\"text\",\"text\":\"ok\"},"
                                + "\"_meta\":{\"usage\":\"opaque\"}")
                        + updateEvent(2, "agent_thought_chunk",
                                "\"content\":{\"type\":\"text\",\"text\":\"t\"},"
                                        + "\"_meta\":\"opaque\"")
                        + terminalEvent(3)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTerminal terminal = session.startPrompt(PromptRequest.text("go"),
                    new PromptObserver() {
                        @Override
                        public void onUsage(Map<String, Object> usage,
                                DaemonEvent event) {
                            fail("Opaque usage metadata must be ignored");
                        }

                        @Override
                        public void onEvent(DaemonEvent event) {
                            rawEvents.incrementAndGet();
                        }
                    }).completionFuture().join();
            assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
        }
        assertEquals(3, rawEvents.get());
    }

    @Test
    void rejectsCompressedSseResponse() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.getResponseHeaders().set("Content-Encoding", "gzip");
            byte[] body = terminalEvent(1).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            PromptObserver.NOOP).completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
        }
    }

    @Test
    void rejectsLookalikeSseContentType() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            exchange.getResponseHeaders().set("Content-Type",
                    "application/nottext/event-stream");
            byte[] body = terminalEvent(1).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            PromptObserver.NOOP).completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
        }
    }

    @Test
    void unexpectedSuccessfulSseStatusIsProtocolFailure() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptOutcomeIndeterminateException failure = assertThrows(
                    PromptOutcomeIndeterminateException.class,
                    () -> session.promptText("go"));
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
        }
    }

    @Test
    void rejectsConflictingPromptIdsInReliableTerminal() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, conflictingTerminalEvent(1)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            PromptObserver.NOOP).completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
        }
    }

    @Test
    void rejectsIdlessReliableTerminal() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, "event: turn_complete\ndata: {\"v\":1,"
                        + "\"type\":\"turn_complete\",\"promptId\":"
                        + "\"prompt-1\",\"data\":{\"promptId\":"
                        + "\"prompt-1\",\"stopReason\":\"end_turn\"}}\n\n"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> session.startPrompt(PromptRequest.text("go"),
                            PromptObserver.NOOP).completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
        }
    }

    @Test
    void toleratesOpaqueDataOnUnknownEvent() {
        List<String> observed = new ArrayList<>();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                "id: 1\nevent: future_event\ndata: {\"id\":1,\"v\":1,"
                        + "\"type\":\"future_event\",\"promptId\":"
                        + "\"prompt-1\",\"data\":{\"promptId\":42}}\n\n"
                        + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTerminal terminal = session.startPrompt(PromptRequest.text("go"),
                    new PromptObserver() {
                        @Override
                        public void onEvent(DaemonEvent event) {
                            observed.add(event.getType());
                        }
                    }).completionFuture().join();
            assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
        }
        assertEquals(List.of("future_event", "turn_complete"), observed);
    }

    @Test
    void sessionFailureEventMakesOutcomeIndeterminate() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                "event: state_resync_required\ndata: {\"v\":1,\"type\":"
                        + "\"state_resync_required\",\"data\":{}}\n\n"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptOutcomeIndeterminateException failure = assertThrows(
                    PromptOutcomeIndeterminateException.class,
                    () -> session.promptText("go"));
            assertTrue(failure.getMessage().contains("state_resync_required"));
        }
    }

    @Test
    void dispatchesSubscriberControlFramesAsRawEvents() {
        List<String> observed = new ArrayList<>();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                syntheticEvent("slow_client_warning")
                        + syntheticEvent("replay_complete")
                        + terminalEvent(1)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTerminal terminal = session.startPrompt(PromptRequest.text("go"),
                    new PromptObserver() {
                        @Override
                        public void onEvent(DaemonEvent event) {
                            observed.add(event.getType());
                        }
                    }).completionFuture().join();
            assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
        }
        assertEquals(List.of("slow_client_warning", "replay_complete",
                "turn_complete"), observed);
    }

    @Test
    void localObservationTimeoutDoesNotSendCancel() {
        AtomicInteger cancels = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(": heartbeat\n\n"
                    .getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
        });
        server.createContext("/session/session-1/cancel", exchange -> {
            cancels.incrementAndGet();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptRequest request = PromptRequest.text("go")
                    .withObservationTimeout(Duration.ofMillis(150));
            long started = System.nanoTime();
            assertThrows(PromptOutcomeIndeterminateException.class,
                    () -> session.promptText(request));
            assertTrue(Duration.ofNanos(System.nanoTime() - started).toMillis() < 900);
        }
        assertEquals(0, cancels.get());
    }

    @Test
    void localObservationTimeoutAlsoBoundsSseHandshake() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptRequest request = PromptRequest.text("go")
                    .withObservationTimeout(Duration.ofMillis(150));
            long started = System.nanoTime();
            assertThrows(PromptOutcomeIndeterminateException.class,
                    () -> session.promptText(request));
            assertTrue(Duration.ofNanos(System.nanoTime() - started).toMillis() < 900);
        }
    }

    @Test
    void requestTimeoutBoundsStalledAdmissionResponseBody() {
        AtomicInteger prompts = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange -> {
            prompts.incrementAndGet();
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(202, 100);
            exchange.getResponseBody().write('{');
            exchange.getResponseBody().flush();
            sleep(2000);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .requestTimeout(Duration.ofMillis(150)).build();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            long started = System.nanoTime();
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.acceptanceFuture().join());
            assertInstanceOf(PromptAdmissionUnknownException.class,
                    failure.getCause());
            assertThrows(PromptAlreadyActiveException.class,
                    () -> session.startPrompt(
                            PromptRequest.text("unsafe-reuse"),
                            PromptObserver.NOOP));
            assertTrue(Duration.ofNanos(System.nanoTime() - started).toMillis() < 900);
        }
        assertEquals(1, prompts.get());
    }

    @Test
    void requestTimeoutBoundsStalledSseErrorBody() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            exchange.sendResponseHeaders(503, 100);
            exchange.getResponseBody().write('{');
            exchange.getResponseBody().flush();
            sleep(2000);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .requestTimeout(Duration.ofMillis(150))
                .maximumReconnectAttempts(0).build();
                DaemonSessionClient session = daemon.createSession()) {
            long started = System.nanoTime();
            assertThrows(PromptOutcomeIndeterminateException.class,
                    () -> session.promptText("go"));
            assertTrue(Duration.ofNanos(System.nanoTime() - started).toMillis() < 900);
        }
    }

    @Test
    void slowSseLineBytesKeepIdleWatchdogAlive() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            byte[] bytes = terminalEvent(1).getBytes(StandardCharsets.UTF_8);
            for (int offset = 0; offset < bytes.length; offset += 20) {
                int count = Math.min(20, bytes.length - offset);
                exchange.getResponseBody().write(bytes, offset, count);
                exchange.getResponseBody().flush();
                sleep(50);
            }
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .sseIdleTimeout(Duration.ofMillis(150)).build();
                DaemonSessionClient session = daemon.createSession()) {
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    session.promptText("go").getTerminal().getKind());
        }
    }

    @Test
    void turnErrorIsReliableButPromptTextThrowsTurnFailure() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                textEvent(1, "partial") + errorTerminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTurnException failure = assertThrows(PromptTurnException.class,
                    () -> session.promptText("go"));
            assertEquals(PromptTerminal.Kind.ERROR, failure.getTerminal().getKind());
            assertEquals("partial", failure.getPartialText());
        }
    }

    @Test
    void deadlineTerminalIsReliableAndSessionRemainsReusable() {
        AtomicInteger prompts = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange -> {
            int prompt = prompts.incrementAndGet();
            sendJson(exchange, 202, "{\"promptId\":\"prompt-" + prompt
                    + "\",\"lastEventId\":" + (prompt - 1) + "}");
        });
        server.createContext("/session/session-1/events", exchange -> {
            String cursor = exchange.getRequestHeaders().getFirst("Last-Event-ID");
            if ("0".equals(cursor)) {
                sendSse(exchange, errorTerminalEvent(1, "prompt-1",
                        "prompt_deadline_exceeded",
                        "prompt exceeded the 50ms deadline"));
            } else {
                sendSse(exchange, terminalEventForPrompt(2, "prompt-2"));
            }
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTurnException failure = assertThrows(PromptTurnException.class,
                    () -> session.promptText(PromptRequest.builder()
                            .addText("slow")
                            .deadline(Duration.ofMillis(50))
                            .build()));
            assertEquals("prompt_deadline_exceeded",
                    failure.getTerminal().getCode());
            assertEquals("prompt-1", failure.getTerminal().getPromptId());

            PromptTextResult followUp = session.promptText("continue");
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    followUp.getTerminal().getKind());
            assertEquals("prompt-2", followUp.getTerminal().getPromptId());
        }
        assertEquals(2, prompts.get());
    }

    @Test
    void teardownTerminalWinsOverFollowingSessionFailure() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> sendSse(exchange,
                errorTerminalEvent(1, "prompt-1", "session_closed",
                        "session closed before the prompt completed")
                        + sessionClosedEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTurnException failure = assertThrows(PromptTurnException.class,
                    () -> session.promptText("go"));
            assertEquals("session_closed", failure.getTerminal().getCode());
            assertEquals(PromptTerminal.Kind.ERROR,
                    failure.getTerminal().getKind());
        }
    }

    @Test
    void cancelledTurnCompleteIsReliableAndExposesStopReason() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEvent(1, "prompt-1", "cancelled")));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptTextResult result = session.promptText("go");
            assertEquals("", result.getText());
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    result.getTerminal().getKind());
            assertEquals("cancelled", result.getTerminal().getStopReason());
        }
    }

    @Test
    void enforcesTextCollectionLimitBeforeReliableTerminal() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, textEvent(1, "hello") + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptContentLimitException failure = assertThrows(
                    PromptContentLimitException.class,
                    () -> session.promptText(PromptRequest.text("go"), 4));
            assertEquals(4, failure.getMaximumBytes());
        }
    }

    @Test
    void countsUtf8BytesAcrossSplitSurrogatePairs() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, textEvent(1, "\\uD83D")
                        + textEvent(2, "\\uDE00") + terminalEvent(3)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptContentLimitException failure = assertThrows(
                    PromptContentLimitException.class,
                    () -> session.promptText(PromptRequest.text("go"), 3));
            assertEquals(3, failure.getMaximumBytes());
            assertEquals("", failure.getPartialText());
        }
    }

    @Test
    void keepsPartialTextBoundedWhenSplitSurrogateIsUnpaired() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, textEvent(1, "a\\uD83D")
                        + textEvent(2, "b") + terminalEvent(3)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptContentLimitException failure = assertThrows(
                    PromptContentLimitException.class,
                    () -> session.promptText(PromptRequest.text("go"), 1));
            assertEquals("a", failure.getPartialText());
            assertEquals(1, failure.getPartialText()
                    .getBytes(StandardCharsets.UTF_8).length);
        }
    }

    @Test
    void preservesIndeterminateOutcomeWhenFinalizingBoundedPartialText() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, textEvent(1, "a\\uD83D")
                        + terminalEvent(3)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptOutcomeIndeterminateException failure = assertThrows(
                    PromptOutcomeIndeterminateException.class,
                    () -> session.promptText(PromptRequest.text("go"), 1));
            assertEquals("a", failure.getPartialText());
            assertEquals(1, failure.getPartialText()
                    .getBytes(StandardCharsets.UTF_8).length);
            assertInstanceOf(DaemonProtocolException.class,
                    failure.getCause().getCause());
            assertThrows(PromptAlreadyActiveException.class,
                    () -> session.startPrompt(
                            PromptRequest.text("unsafe-reuse"),
                            PromptObserver.NOOP));
        }
    }

    @Test
    void rejectsSecondLocalPromptUntilFirstSettles() {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(": keep-alive\n\n"
                    .getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            session.startPrompt(PromptRequest.text("first"), PromptObserver.NOOP);
            assertThrows(PromptAlreadyActiveException.class,
                    () -> session.startPrompt(PromptRequest.text("second"),
                            PromptObserver.NOOP));
        }
    }

    @Test
    void rejectsClientWidePromptCapacityBeforeMutation() throws Exception {
        server.removeContext("/session");
        AtomicInteger created = new AtomicInteger();
        server.createContext("/session", exchange -> {
            int number = created.incrementAndGet();
            sendJson(exchange, 200, sessionJson("session-" + number,
                    "client-" + number));
        });
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        CountDownLatch streamOpened = new CountDownLatch(1);
        CountDownLatch releaseStream = new CountDownLatch(1);
        server.createContext("/session/session-1/events", exchange -> {
            streamOpened.countDown();
            await(releaseStream);
            sendSse(exchange, terminalEvent(1));
        });
        AtomicInteger secondPromptRequests = new AtomicInteger();
        server.createContext("/session/session-2/prompt", exchange -> {
            secondPromptRequests.incrementAndGet();
            sendJson(exchange, 202,
                    "{\"promptId\":\"prompt-2\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/detach", noContent());
        server.createContext("/session/session-2/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1).build();
                DaemonSessionClient first = daemon.createSession();
                DaemonSessionClient second = daemon.createSession()) {
            PromptCall running = first.startPrompt(PromptRequest.text("first"),
                    PromptObserver.NOOP);
            assertEquals("prompt-1",
                    running.acceptanceFuture().join().getPromptId());
            assertTrue(streamOpened.await(1, TimeUnit.SECONDS));

            PromptCall rejected = second.startPrompt(PromptRequest.text("second"),
                    PromptObserver.NOOP);
            CompletionException admissionFailure = assertThrows(
                    CompletionException.class,
                    () -> rejected.acceptanceFuture().join());
            CompletionException completionFailure = assertThrows(
                    CompletionException.class,
                    () -> rejected.completionFuture().join());
            assertInstanceOf(DaemonClientCapacityException.class,
                    admissionFailure.getCause());
            assertInstanceOf(DaemonClientCapacityException.class,
                    completionFailure.getCause());
            assertEquals(0, secondPromptRequests.get());

            releaseStream.countDown();
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    running.completionFuture().join().getKind());
        } finally {
            releaseStream.countDown();
        }
    }

    @Test
    void closeAttemptsDetachOnlyOnceAndDestroyUsesDelete() {
        AtomicInteger detaches = new AtomicInteger();
        AtomicInteger deletes = new AtomicInteger();
        AtomicReference<String> detachClientId = new AtomicReference<>();
        server.createContext("/session/session-1/detach", exchange -> {
            detaches.incrementAndGet();
            detachClientId.set(exchange.getRequestHeaders()
                    .getFirst("X-Qwen-Client-Id"));
            exchange.close();
        });
        server.createContext("/session/session-1", exchange -> {
            if ("DELETE".equals(exchange.getRequestMethod())) {
                deletes.incrementAndGet();
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            sendJson(exchange, 404, "{}");
        });

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            assertThrows(DetachOutcomeUnknownException.class, session::close);
            session.close();
            session.destroySession();
        }
        assertEquals(1, detaches.get());
        assertEquals(1, deletes.get());
        assertEquals("client-1", detachClientId.get());
    }

    @Test
    void clientClosePreservesEverySessionDetachFailure() {
        AtomicInteger detaches = new AtomicInteger();
        server.createContext("/session/session-1/detach", exchange -> {
            detaches.incrementAndGet();
            exchange.close();
        });

        DaemonClient daemon = newClient();
        daemon.createSession();
        daemon.createSession();
        DetachOutcomeUnknownException failure = assertThrows(
                DetachOutcomeUnknownException.class, daemon::close);
        assertEquals(1, failure.getSuppressed().length);
        assertEquals(2, detaches.get());
    }

    @Test
    void destroyAfterDetachOmitsRetiredClientIdAndAcceptsNotFound() {
        AtomicReference<String> deleteClientId = new AtomicReference<>();
        server.createContext("/session/session-1/detach", noContent());
        server.createContext("/session/session-1", exchange -> {
            deleteClientId.set(exchange.getRequestHeaders()
                    .getFirst("X-Qwen-Client-Id"));
            sendJson(exchange, 404,
                    "{\"error\":\"not found\",\"sessionId\":\"session-1\"}");
        });

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            session.detach();
            session.destroySession();
        }
        assertEquals(null, deleteClientId.get());
    }

    @Test
    void destroyDoesNotTreatGenericNotFoundAsAlreadyDeleted() {
        server.createContext("/session/session-1", exchange ->
                sendJson(exchange, 404, "{\"error\":\"route not found\"}"));

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            DaemonHttpException failure = assertThrows(
                    DaemonHttpException.class, session::destroySession);
            assertEquals(404, failure.getStatusCode());
        }
    }

    @Test
    void malformedSuccessfulMutationResponseIsOutcomeUnknown() {
        server.createContext("/session/session-1/permission/request-1", exchange -> {
            byte[] bytes = {(byte) 0xC3, (byte) 0x28};
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> session.respondToPermission("request-1",
                            PermissionResponse.cancelled()));
            assertInstanceOf(DaemonProtocolException.class, failure.getCause());
        }
    }

    @Test
    void permissionResponseReportsAlreadyResolvedWithoutStoppingObservation() {
        server.createContext("/session/session-1/permission/request-1", exchange ->
                sendJson(exchange, 404,
                        "{\"error\":\"already resolved\","
                                + "\"sessionId\":\"session-1\","
                                + "\"requestId\":\"request-1\"}"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            assertTrue(!session.respondToPermission("request-1",
                    PermissionResponse.cancelled()));
        }
    }

    @Test
    void permissionResponseRejectsGenericNotFound() {
        server.createContext("/session/session-1/permission/request-1", exchange ->
                sendJson(exchange, 404, "{\"error\":\"route not found\"}"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            DaemonHttpException failure = assertThrows(DaemonHttpException.class,
                    () -> session.respondToPermission("request-1",
                            PermissionResponse.cancelled()));
            assertEquals(404, failure.getStatusCode());
        }
    }

    @Test
    void unexpectedSuccessfulMutationStatusIsOutcomeUnknown() {
        server.createContext("/session/session-1/permission/request-1", exchange ->
                sendJson(exchange, 202, "{}"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class,
                    () -> session.respondToPermission("request-1",
                            PermissionResponse.cancelled()));
            assertInstanceOf(DaemonProtocolException.class, failure.getCause());
        }
    }

    @Test
    void ambiguousHttpMutationStatusesAreOutcomeUnknown() {
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/session/session-1/permission/request-1", exchange -> {
            requests.incrementAndGet();
            sendJson(exchange, 503, "{\"error\":\"unavailable\"}");
        });
        server.createContext("/session/session-1/cancel", exchange -> {
            requests.incrementAndGet();
            sendJson(exchange, 408, "{\"error\":\"timeout\"}");
        });
        server.createContext("/session/session-1/heartbeat", exchange -> {
            requests.incrementAndGet();
            sendJson(exchange, 502, "{\"error\":\"bad gateway\"}");
        });
        server.createContext("/session/session-1", exchange -> {
            requests.incrementAndGet();
            sendJson(exchange, 504, "{\"error\":\"gateway timeout\"}");
        });

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            assertAmbiguousHttpMutation(() -> session.respondToPermission(
                    "request-1", PermissionResponse.cancelled()), 503);
            assertAmbiguousHttpMutation(session::cancelActivePrompt, 408);
            assertAmbiguousHttpMutation(session::heartbeat, 502);
            assertAmbiguousHttpMutation(session::destroySession, 504);
        }
        assertEquals(4, requests.get());
    }

    @Test
    void ambiguousDetachHttpStatusIsSpecializedAndNotRetried() {
        AtomicInteger detaches = new AtomicInteger();
        server.createContext("/session/session-1/detach", exchange -> {
            detaches.incrementAndGet();
            sendJson(exchange, 503, "{\"error\":\"unavailable\"}");
        });

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            DetachOutcomeUnknownException failure = assertThrows(
                    DetachOutcomeUnknownException.class, session::close);
            DaemonHttpException cause = assertInstanceOf(DaemonHttpException.class,
                    failure.getCause());
            assertEquals(503, cause.getStatusCode());
            session.close();
        }
        assertEquals(1, detaches.get());
    }

    @Test
    void definitiveHttpErrorToleratesMalformedErrorText() {
        server.createContext("/session/session-1/permission/request-1", exchange -> {
            byte[] bytes = {(byte) 0xC3, (byte) 0x28};
            exchange.sendResponseHeaders(400, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            DaemonHttpException failure = assertThrows(DaemonHttpException.class,
                    () -> session.respondToPermission("request-1",
                            PermissionResponse.cancelled()));
            assertEquals(400, failure.getStatusCode());
        }
    }

    @Test
    void unexpectedSuccessfulCreateStatusIsOutcomeUnknown() {
        server.removeContext("/session");
        server.createContext("/session", exchange ->
                sendJson(exchange, 201, sessionJson()));

        try (DaemonClient daemon = newClient()) {
            SessionCreationOutcomeUnknownException failure = assertThrows(
                    SessionCreationOutcomeUnknownException.class,
                    daemon::createSession);
            assertInstanceOf(DaemonProtocolException.class, failure.getCause());
        }
    }

    @Test
    void requestTimeoutHttpCreateFailureIsOutcomeUnknown() {
        server.removeContext("/session");
        AtomicInteger creates = new AtomicInteger();
        server.createContext("/session", exchange -> {
            creates.incrementAndGet();
            sendJson(exchange, 408, "{\"error\":\"request timeout\"}");
        });

        try (DaemonClient daemon = newClient()) {
            SessionCreationOutcomeUnknownException failure = assertThrows(
                    SessionCreationOutcomeUnknownException.class,
                    daemon::createSession);
            DaemonHttpException cause = assertInstanceOf(DaemonHttpException.class,
                    failure.getCause());
            assertEquals(408, cause.getStatusCode());
        }
        assertEquals(1, creates.get());
    }

    @Test
    void malformedCreatedClientIdIsOutcomeUnknown() {
        server.removeContext("/session");
        server.createContext("/session", exchange -> sendJson(exchange, 200,
                sessionJson("session-1", "invalid client id")));

        try (DaemonClient daemon = newClient()) {
            SessionCreationOutcomeUnknownException failure = assertThrows(
                    SessionCreationOutcomeUnknownException.class,
                    daemon::createSession);
            assertInstanceOf(DaemonProtocolException.class, failure.getCause());
        }
    }

    @Test
    void closeWaitsForInFlightAdmissionBeforeDetaching() throws Exception {
        CountDownLatch admissionStarted = new CountDownLatch(1);
        CountDownLatch releaseAdmission = new CountDownLatch(1);
        AtomicInteger detaches = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange -> {
            admissionStarted.countDown();
            await(releaseAdmission);
            sendJson(exchange, 202,
                    "{\"promptId\":\"prompt-1\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEvent(1)));
        server.createContext("/session/session-1/detach", exchange -> {
            detaches.incrementAndGet();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            assertTrue(admissionStarted.await(1, TimeUnit.SECONDS));
            CompletableFuture<Void> close = CompletableFuture.runAsync(session::close);
            Thread.sleep(100);
            assertTrue(!close.isDone());
            assertEquals(0, detaches.get());
            releaseAdmission.countDown();
            close.get(1, TimeUnit.SECONDS);
            assertEquals("prompt-1",
                    call.acceptanceFuture().join().getPromptId());
        }
        assertEquals(1, detaches.get());
    }

    @Test
    void acceptanceContinuationDoesNotHoldSessionLifecycleLock() throws Exception {
        CountDownLatch admissionStarted = new CountDownLatch(1);
        CountDownLatch releaseAdmission = new CountDownLatch(1);
        CountDownLatch continuationEntered = new CountDownLatch(1);
        CountDownLatch releaseContinuation = new CountDownLatch(1);
        CountDownLatch eventsOpened = new CountDownLatch(1);
        CountDownLatch releaseEvents = new CountDownLatch(1);
        server.createContext("/session/session-1/prompt", exchange -> {
            admissionStarted.countDown();
            await(releaseAdmission);
            sendJson(exchange, 202,
                    "{\"promptId\":\"prompt-1\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/events", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(
                    "retry: 0\n\n".getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
            eventsOpened.countDown();
            await(releaseEvents);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            assertTrue(admissionStarted.await(1, TimeUnit.SECONDS));
            CompletableFuture<Void> continuation = call.acceptanceFuture()
                    .thenRun(() -> {
                        continuationEntered.countDown();
                        await(releaseContinuation);
                    });
            releaseAdmission.countDown();
            assertTrue(continuationEntered.await(1, TimeUnit.SECONDS));
            assertTrue(eventsOpened.await(1, TimeUnit.SECONDS));
            CompletableFuture<Void> close = CompletableFuture.runAsync(session::close);
            try {
                close.get(1, TimeUnit.SECONDS);
            } finally {
                releaseContinuation.countDown();
                releaseEvents.countDown();
            }
            continuation.get(1, TimeUnit.SECONDS);
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
        } finally {
            releaseAdmission.countDown();
            releaseContinuation.countDown();
            releaseEvents.countDown();
        }
    }

    @Test
    void acceptanceContinuationWaitingForTerminalCannotBlockObservation()
            throws Exception {
        CountDownLatch admissionStarted = new CountDownLatch(1);
        CountDownLatch releaseAdmission = new CountDownLatch(1);
        server.createContext("/session/session-1/prompt", exchange -> {
            admissionStarted.countDown();
            await(releaseAdmission);
            sendJson(exchange, 202,
                    "{\"promptId\":\"prompt-1\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEvent(1)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1)
                .build();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            assertTrue(admissionStarted.await(1, TimeUnit.SECONDS));
            CompletableFuture<Void> continuation = call.acceptanceFuture()
                    .thenRun(() -> call.completionFuture().join());
            releaseAdmission.countDown();
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    call.completionFuture().get(1, TimeUnit.SECONDS).getKind());
            continuation.get(1, TimeUnit.SECONDS);
        } finally {
            releaseAdmission.countDown();
        }
    }

    @Test
    void failedAdmissionContinuationWaitingForTerminalCannotBlockFailure()
            throws Exception {
        CountDownLatch admissionStarted = new CountDownLatch(1);
        CountDownLatch releaseAdmission = new CountDownLatch(1);
        server.createContext("/session/session-1/prompt", exchange -> {
            admissionStarted.countDown();
            await(releaseAdmission);
            sendJson(exchange, 400, "{\"error\":\"rejected\"}");
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1)
                .build();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            assertTrue(admissionStarted.await(1, TimeUnit.SECONDS));
            CompletableFuture<Void> continuation = call.acceptanceFuture()
                    .handle((ignored, failure) -> {
                        assertTrue(failure != null);
                        assertThrows(
                                CompletionException.class,
                                () -> call.completionFuture().join());
                        return null;
                    });
            releaseAdmission.countDown();
            CompletionException terminalFailure = assertThrows(
                    CompletionException.class,
                    () -> call.completionFuture()
                            .orTimeout(1, TimeUnit.SECONDS).join());
            assertInstanceOf(DaemonHttpException.class,
                    terminalFailure.getCause());
            continuation.get(1, TimeUnit.SECONDS);
        } finally {
            releaseAdmission.countDown();
        }
    }

    @Test
    void terminalContinuationCanStartNextPromptAtClientCapacity()
            throws Exception {
        AtomicInteger prompts = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange -> {
            int prompt = prompts.incrementAndGet();
            sendJson(exchange, 202, "{\"promptId\":\"prompt-" + prompt
                    + "\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEventForPrompt(1,
                        "prompt-" + prompts.get())));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1)
                .build();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall first = session.startPrompt(PromptRequest.text("one"),
                    PromptObserver.NOOP);
            CompletableFuture<PromptTerminal> second = first.completionFuture()
                    .thenCompose(ignored -> session.startPrompt(
                            PromptRequest.text("two"), PromptObserver.NOOP)
                            .completionFuture());
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    second.get(1, TimeUnit.SECONDS).getKind());
            assertEquals(2, prompts.get());
        }
    }

    @Test
    void blockedTerminalContinuationsApplyBoundedPublicationBackpressure()
            throws Exception {
        AtomicInteger prompts = new AtomicInteger();
        AtomicInteger sessions = new AtomicInteger();
        AtomicInteger rejectedPromptRequests = new AtomicInteger();
        CountDownLatch releaseContinuations = new CountDownLatch(1);
        CountDownLatch finalTerminalObserved = new CountDownLatch(1);
        CountDownLatch releaseFinalObserver = new CountDownLatch(1);
        List<CompletableFuture<Void>> continuations = new ArrayList<>();
        server.removeContext("/session");
        server.createContext("/session", exchange -> {
            int session = sessions.incrementAndGet();
            sendJson(exchange, 200, sessionJson("session-" + session,
                    "client-" + session));
        });
        server.createContext("/session/session-1/prompt", exchange -> {
            int prompt = prompts.incrementAndGet();
            sendJson(exchange, 202, "{\"promptId\":\"prompt-" + prompt
                    + "\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEventForPrompt(1,
                        "prompt-" + prompts.get())));
        server.createContext("/session/session-2/prompt", exchange -> {
            rejectedPromptRequests.incrementAndGet();
            sendJson(exchange, 202,
                    "{\"promptId\":\"unexpected\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/detach", noContent());
        server.createContext("/session/session-2/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1)
                .build();
                DaemonSessionClient session = daemon.createSession();
                DaemonSessionClient secondSession = daemon.createSession()) {
            try {
                for (int index = 0; index < 2; index++) {
                    CountDownLatch continuationEntered = new CountDownLatch(1);
                    PromptCall call = session.startPrompt(
                            PromptRequest.text("blocking-" + index),
                            PromptObserver.NOOP);
                    continuations.add(call.completionFuture().thenRun(() -> {
                        continuationEntered.countDown();
                        await(releaseContinuations);
                    }));
                    assertTrue(continuationEntered.await(1, TimeUnit.SECONDS));
                }
                PromptCall finalCall = session.startPrompt(
                        PromptRequest.text("final"), new PromptObserver() {
                            @Override
                            public void onEvent(DaemonEvent event) {
                                if ("turn_complete".equals(event.getType())) {
                                    finalTerminalObserved.countDown();
                                    await(releaseFinalObserver);
                                }
                            }
                        });
                CompletableFuture<PromptTerminal> finalCompletion =
                        finalCall.completionFuture();
                assertTrue(finalTerminalObserved.await(1, TimeUnit.SECONDS));
                PromptCall capacityRejected = secondSession.startPrompt(
                        PromptRequest.text("capacity-rejected"),
                        PromptObserver.NOOP);
                assertThrows(DaemonClientCapacityException.class,
                        () -> secondSession.startPrompt(
                                PromptRequest.text("publication-rejected"),
                                PromptObserver.NOOP));
                assertEquals(0, rejectedPromptRequests.get());
                assertTrue(!finalCompletion.isDone());
                assertTrue(!capacityRejected.completionFuture().isDone());
                releaseFinalObserver.countDown();
                releaseContinuations.countDown();
                assertEquals(PromptTerminal.Kind.COMPLETE,
                        finalCompletion.get(1, TimeUnit.SECONDS).getKind());
                CompletionException rejection = assertThrows(
                        CompletionException.class,
                        () -> capacityRejected.completionFuture().join());
                assertInstanceOf(DaemonClientCapacityException.class,
                        rejection.getCause());
            } finally {
                releaseFinalObserver.countDown();
                releaseContinuations.countDown();
            }
            for (CompletableFuture<Void> continuation : continuations) {
                continuation.get(1, TimeUnit.SECONDS);
            }
        } finally {
            releaseFinalObserver.countDown();
            releaseContinuations.countDown();
        }
        assertEquals(3, prompts.get());
    }

    @Test
    void completionContinuationCanCloseClientWithoutWaitingOnItself()
            throws Exception {
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEvent(1)));
        server.createContext("/session/session-1/detach", noContent());

        DaemonClient daemon = newClient();
        try {
            DaemonSessionClient session = daemon.createSession();
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            call.completionFuture().thenRun(daemon::close)
                    .get(1, TimeUnit.SECONDS);
        } finally {
            daemon.close();
        }
    }

    @Test
    void clientCloseRacingAdmissionKeepsFuturePublicationAsynchronous()
            throws Exception {
        CountDownLatch admissionStarted = new CountDownLatch(1);
        CountDownLatch releaseAdmission = new CountDownLatch(1);
        server.createContext("/session/session-1/prompt", exchange -> {
            admissionStarted.countDown();
            await(releaseAdmission);
            sendJson(exchange, 202,
                    "{\"promptId\":\"prompt-1\",\"lastEventId\":0}");
        });
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEvent(1)));
        server.createContext("/session/session-1/detach", noContent());

        DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1)
                .build();
        try {
            DaemonSessionClient session = daemon.createSession();
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            assertTrue(admissionStarted.await(1, TimeUnit.SECONDS));
            CompletableFuture<Void> continuation = call.acceptanceFuture()
                    .handle((ignored, failure) -> {
                        try {
                            call.completionFuture().join();
                        } catch (CompletionException expected) {
                            assertTrue(expected.getCause() != null);
                        }
                        return null;
                    });
            CompletableFuture<Void> closing =
                    CompletableFuture.runAsync(daemon::close);
            releaseAdmission.countDown();
            closing.get(1, TimeUnit.SECONDS);
            continuation.get(1, TimeUnit.SECONDS);
            assertTrue(call.completionFuture().isDone());
        } finally {
            releaseAdmission.countDown();
            daemon.close();
        }
    }

    @Test
    void clientCloseRejectsPromptFromSessionNotYetSwept() throws Exception {
        AtomicInteger created = new AtomicInteger();
        AtomicInteger promptRequests = new AtomicInteger();
        AtomicInteger mutationRequests = new AtomicInteger();
        AtomicReference<String> detachingSession = new AtomicReference<>();
        CountDownLatch detachStarted = new CountDownLatch(1);
        CountDownLatch releaseDetach = new CountDownLatch(1);
        server.removeContext("/session");
        server.createContext("/session", exchange -> {
            int session = created.incrementAndGet();
            sendJson(exchange, 200, sessionJson("session-" + session,
                    "client-" + session));
        });
        for (int session = 1; session <= 2; session++) {
            String sessionId = "session-" + session;
            String clientId = "client-" + session;
            server.createContext("/session/" + sessionId + "/prompt", exchange -> {
                promptRequests.incrementAndGet();
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}");
            });
            server.createContext("/session/" + sessionId + "/events", exchange ->
                    sendSse(exchange, terminalEventForSession(1, sessionId)));
            server.createContext("/session/" + sessionId + "/cancel", exchange -> {
                mutationRequests.incrementAndGet();
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            });
            server.createContext("/session/" + sessionId + "/heartbeat", exchange -> {
                mutationRequests.incrementAndGet();
                sendJson(exchange, 200, "{\"sessionId\":\"" + sessionId
                        + "\",\"clientId\":\"" + clientId
                        + "\",\"lastSeenAt\":1}");
            });
            server.createContext("/session/" + sessionId
                    + "/permission/request-1", exchange -> {
                        mutationRequests.incrementAndGet();
                        sendJson(exchange, 200, "{\"accepted\":true}");
                    });
            server.createContext("/session/" + sessionId + "/detach", exchange -> {
                detachingSession.compareAndSet(null, sessionId);
                detachStarted.countDown();
                await(releaseDetach);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            });
        }

        DaemonClient daemon = newClient();
        try {
            DaemonSessionClient first = daemon.createSession();
            DaemonSessionClient second = daemon.createSession();
            CompletableFuture<Void> closing =
                    CompletableFuture.runAsync(daemon::close);
            assertTrue(detachStarted.await(1, TimeUnit.SECONDS));
            DaemonSessionClient unswept = "session-1".equals(
                    detachingSession.get()) ? second : first;
            PromptCall rejected = unswept.startPrompt(
                    PromptRequest.text("too-late"), PromptObserver.NOOP);
            assertThrows(CompletionException.class,
                    () -> rejected.acceptanceFuture().join());
            assertThrows(CompletionException.class,
                    () -> rejected.completionFuture().join());
            assertEquals(0, promptRequests.get());
            assertThrows(IllegalStateException.class, unswept::cancelActivePrompt);
            assertThrows(IllegalStateException.class, unswept::heartbeat);
            assertThrows(IllegalStateException.class,
                    () -> unswept.respondToPermission("request-1",
                            PermissionResponse.cancelled()));
            assertEquals(0, mutationRequests.get());
            releaseDetach.countDown();
            closing.get(1, TimeUnit.SECONDS);
        } finally {
            releaseDetach.countDown();
            daemon.close();
        }
    }

    @Test
    void stoppedPromptCompletesOnlyAfterObserverExits() throws Exception {
        CountDownLatch observerEntered = new CountDownLatch(1);
        CountDownLatch releaseObserver = new CountDownLatch(1);
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, textEvent(1, "partial") + terminalEvent(2)));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient()) {
            DaemonSessionClient session = daemon.createSession();
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    new PromptObserver() {
                        @Override
                        public void onText(String text, DaemonEvent event) {
                            observerEntered.countDown();
                            awaitUninterruptibly(releaseObserver);
                        }
                    });
            assertTrue(observerEntered.await(1, TimeUnit.SECONDS));
            session.close();
            assertTrue(!call.completionFuture().isDone());
            releaseObserver.countDown();
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.completionFuture().join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
        }
    }

    @Test
    void automaticHeartbeatRequiresAdvertisedCapability() throws Exception {
        AtomicInteger heartbeats = new AtomicInteger();
        server.removeContext("/capabilities");
        server.createContext("/capabilities", exchange -> sendJson(exchange, 200,
                "{\"v\":1,\"mode\":\"http-bridge\",\"features\":["
                        + "\"session_scope_override\"],"
                        + "\"transports\":[\"rest\"]}"));
        server.createContext("/session/session-1/heartbeat", exchange -> {
            heartbeats.incrementAndGet();
            sendJson(exchange, 200,
                    "{\"sessionId\":\"session-1\",\"lastSeenAt\":1}");
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .heartbeatInterval(Duration.ofMillis(20)).build();
                DaemonSessionClient session = daemon.createSession()) {
            Thread.sleep(100);
            assertEquals(0, heartbeats.get());
        }
    }

    @Test
    void automaticHeartbeatStopsWithSession() throws Exception {
        AtomicInteger heartbeats = new AtomicInteger();
        server.createContext("/session/session-1/heartbeat", exchange -> {
            int count = heartbeats.incrementAndGet();
            sendJson(exchange, 200, "{\"sessionId\":\"session-1\","
                    + "\"clientId\":\"client-1\",\"lastSeenAt\":" + count + "}");
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .heartbeatInterval(Duration.ofMillis(30)).build()) {
            DaemonSessionClient session = daemon.createSession();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (heartbeats.get() == 0 && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            assertTrue(heartbeats.get() > 0);
            HeartbeatResult result = session.heartbeat();
            assertEquals("session-1", result.getSessionId());
            session.close();
            int afterClose = heartbeats.get();
            Thread.sleep(100);
            assertEquals(afterClose, heartbeats.get());
        }
    }

    @Test
    void heartbeatRejectsMismatchedClientIdentity() {
        server.createContext("/session/session-1/heartbeat", exchange ->
                sendJson(exchange, 200, "{\"sessionId\":\"session-1\","
                        + "\"clientId\":\"another-client\",\"lastSeenAt\":1}"));
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            MutationOutcomeUnknownException failure = assertThrows(
                    MutationOutcomeUnknownException.class, session::heartbeat);
            assertInstanceOf(DaemonProtocolException.class, failure.getCause());
        }
    }

    @Test
    void queuedHeartbeatsAreFairAndDoNotDelayClose() throws Exception {
        server.removeContext("/session");
        AtomicInteger created = new AtomicInteger();
        server.createContext("/session", exchange -> {
            int number = created.incrementAndGet();
            sendJson(exchange, 200, sessionJson("session-" + number,
                    "client-" + number));
        });
        CountDownLatch fourRunning = new CountDownLatch(4);
        CountDownLatch releaseHeartbeats = new CountDownLatch(1);
        AtomicInteger heartbeats = new AtomicInteger();
        for (int number = 1; number <= 6; number++) {
            String sessionId = "session-" + number;
            String clientId = "client-" + number;
            server.createContext("/session/" + sessionId + "/heartbeat",
                    exchange -> {
                        int count = heartbeats.incrementAndGet();
                        if (count <= 4) {
                            fourRunning.countDown();
                            await(releaseHeartbeats);
                        }
                        sendJson(exchange, 200, "{\"sessionId\":\""
                                + sessionId + "\",\"clientId\":\""
                                + clientId + "\",\"lastSeenAt\":1}");
                    });
            server.createContext("/session/" + sessionId + "/detach",
                    noContent());
        }

        try (DaemonClient daemon = clientBuilder()
                .heartbeatInterval(Duration.ofMillis(20)).build()) {
            List<DaemonSessionClient> sessions = new ArrayList<>();
            try {
                for (int number = 0; number < 6; number++) {
                    sessions.add(daemon.createSession());
                }
                assertTrue(fourRunning.await(1, TimeUnit.SECONDS));
                long started = System.nanoTime();
                sessions.get(4).close();
                assertTrue(Duration.ofNanos(System.nanoTime() - started)
                        .toMillis() < 500);
                releaseHeartbeats.countDown();
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
                while (heartbeats.get() < 5 && System.nanoTime() < deadline) {
                    Thread.sleep(10);
                }
                assertTrue(heartbeats.get() >= 5);
            } finally {
                releaseHeartbeats.countDown();
                for (DaemonSessionClient session : sessions) {
                    session.close();
                }
            }
        }
    }

    @Test
    void blockedHeartbeatDoesNotDelayPromptObservationTimeout() throws Exception {
        server.removeContext("/session");
        AtomicInteger created = new AtomicInteger();
        server.createContext("/session", exchange -> {
            int number = created.incrementAndGet();
            sendJson(exchange, 200, sessionJson("session-" + number,
                    "client-" + number));
        });
        CountDownLatch heartbeatEntered = new CountDownLatch(1);
        CountDownLatch releaseHeartbeat = new CountDownLatch(1);
        CountDownLatch streamOpened = new CountDownLatch(1);
        CountDownLatch releaseStream = new CountDownLatch(1);
        server.createContext("/session/session-1/heartbeat", exchange -> {
            heartbeatEntered.countDown();
            await(releaseHeartbeat);
            sendJson(exchange, 200, "{\"sessionId\":\"session-1\","
                    + "\"clientId\":\"client-1\",\"lastSeenAt\":1}");
        });
        server.createContext("/session/session-2/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-2/events", exchange -> {
            exchange.getResponseHeaders().set("Content-Type",
                    "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(": heartbeat\n\n"
                    .getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
            streamOpened.countDown();
            await(releaseStream);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());
        server.createContext("/session/session-2/detach", noContent());

        try (DaemonClient daemon = clientBuilder()
                .heartbeatInterval(Duration.ofMillis(50))
                .maximumReconnectAttempts(0)
                .build()) {
            DaemonSessionClient first = daemon.createSession();
            DaemonSessionClient second = daemon.createSession();
            CompletableFuture<Void> manualHeartbeat = CompletableFuture.runAsync(
                    first::heartbeat);
            try {
                assertTrue(heartbeatEntered.await(1, TimeUnit.SECONDS));
                Thread.sleep(100);
                PromptCall call = second.startPrompt(PromptRequest.builder()
                        .addText("go")
                        .observationTimeout(Duration.ofMillis(200))
                        .build(), PromptObserver.NOOP);
                assertTrue(streamOpened.await(1, TimeUnit.SECONDS));
                CountDownLatch completed = new CountDownLatch(1);
                call.completionFuture().whenComplete((outcome, failure) ->
                        completed.countDown());
                assertTrue(completed.await(1, TimeUnit.SECONDS));
                CompletionException failure = assertThrows(
                        CompletionException.class,
                        () -> call.completionFuture().join());
                assertInstanceOf(PromptOutcomeIndeterminateException.class,
                        failure.getCause());
            } finally {
                releaseHeartbeat.countDown();
                releaseStream.countDown();
                manualHeartbeat.join();
            }
        }
    }

    @Test
    void streamCloseDoesNotBlockScheduler() throws Exception {
        CountDownLatch firstCloseEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstClose = new CountDownLatch(1);
        CountDownLatch timerDispatchedSecondClose = new CountDownLatch(1);
        CountDownLatch secondStreamClosed = new CountDownLatch(1);
        InputStream first = new ByteArrayInputStream(new byte[0]) {
            @Override
            public void close() {
                firstCloseEntered.countDown();
                awaitUninterruptibly(releaseFirstClose);
            }
        };
        InputStream second = new ByteArrayInputStream(new byte[0]) {
            @Override
            public void close() throws IOException {
                secondStreamClosed.countDown();
                super.close();
            }
        };

        try (DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(2)
                .build()) {
            try {
                daemon.scheduler().execute(() -> daemon.closeStreamAsync(first));
                assertTrue(firstCloseEntered.await(1, TimeUnit.SECONDS));
                daemon.scheduler().execute(() -> {
                    daemon.closeStreamAsync(second);
                    timerDispatchedSecondClose.countDown();
                });
                assertTrue(timerDispatchedSecondClose.await(1, TimeUnit.SECONDS));
                assertTrue(secondStreamClosed.await(1, TimeUnit.SECONDS));
            } finally {
                releaseFirstClose.countDown();
            }
        }
    }

    @Test
    void streamCloseFailureIsReported() {
        InputStream stream = new ByteArrayInputStream(new byte[0]) {
            @Override
            public void close() throws IOException {
                throw new IOException("close failed");
            }
        };

        try (DaemonClient daemon = newClient()) {
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> daemon.closeStreamAsync(stream).join());
            assertInstanceOf(IOException.class, failure.getCause());
        }
    }

    @Test
    void observationTimeoutSettlesWhileStreamCloseWorkerIsBlocked()
            throws Exception {
        assertStoppedPromptSettlesWithBlockedClose(200, false);
    }

    @Test
    void observationTimeoutSettlesWhileErrorBodyCloseWorkerIsBlocked()
            throws Exception {
        assertStoppedPromptSettlesWithBlockedClose(503, false);
    }

    @Test
    void sessionCloseSettlesWhileStreamCloseWorkerIsBlocked()
            throws Exception {
        assertStoppedPromptSettlesWithBlockedClose(200, true);
    }

    private void assertStoppedPromptSettlesWithBlockedClose(int status,
            boolean closeSession) throws Exception {
        CountDownLatch blockerCloseEntered = new CountDownLatch(1);
        CountDownLatch releaseBlockerClose = new CountDownLatch(1);
        CountDownLatch streamOpened = new CountDownLatch(1);
        CountDownLatch releaseStream = new CountDownLatch(1);
        InputStream blocker = new ByteArrayInputStream(new byte[0]) {
            @Override
            public void close() {
                blockerCloseEntered.countDown();
                awaitUninterruptibly(releaseBlockerClose);
            }
        };
        server.createContext("/session/session-1/prompt", exchange ->
                sendJson(exchange, 202,
                        "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange -> {
            String contentType = status == 200
                    ? "text/event-stream" : "application/json";
            String partialBody = status == 200
                    ? ": keep-alive\n\n" : "{\"error\":\"partial";
            exchange.getResponseHeaders().set("Content-Type", contentType);
            exchange.sendResponseHeaders(status, 0);
            exchange.getResponseBody().write(
                    partialBody.getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
            streamOpened.countDown();
            await(releaseStream);
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1)
                .build();
        try {
            daemon.closeStreamAsync(blocker);
            assertTrue(blockerCloseEntered.await(1, TimeUnit.SECONDS));
            DaemonSessionClient session = daemon.createSession();
            PromptCall call = session.startPrompt(PromptRequest.builder()
                    .addText("go")
                    .observationTimeout(closeSession
                            ? Duration.ofSeconds(30) : Duration.ofMillis(200))
                    .build(), PromptObserver.NOOP);
            assertTrue(streamOpened.await(1, TimeUnit.SECONDS));
            if (closeSession) {
                session.close();
            }
            CompletionException failure = assertThrows(
                    CompletionException.class,
                    () -> call.completionFuture().orTimeout(
                            1, TimeUnit.SECONDS).join());
            assertInstanceOf(PromptOutcomeIndeterminateException.class,
                    failure.getCause());
            if (!closeSession) {
                assertThrows(PromptAlreadyActiveException.class,
                        () -> session.startPrompt(
                                PromptRequest.text("unsafe-reuse"),
                                PromptObserver.NOOP));
            }
        } finally {
            releaseBlockerClose.countDown();
            releaseStream.countDown();
            daemon.close();
        }
    }

    @Test
    void stalledStreamCleanupAppliesBackpressureBeforePromptExecution()
            throws Exception {
        CompletableFuture<Void> firstCleanup = new CompletableFuture<>();
        CountDownLatch firstReleased = new CountDownLatch(1);
        AtomicInteger rejectedTaskRuns = new AtomicInteger();

        try (DaemonClient daemon = clientBuilder()
                .maximumConcurrentPrompts(1)
                .build()) {
            daemon.submit(() -> { }, () -> { }, firstReleased::countDown,
                    () -> firstCleanup);
            assertTrue(firstReleased.await(1, TimeUnit.SECONDS));

            assertThrows(DaemonClientCapacityException.class,
                    () -> daemon.submit(rejectedTaskRuns::incrementAndGet,
                            () -> { }, () -> { },
                            () -> CompletableFuture.completedFuture(null)));
            assertEquals(0, rejectedTaskRuns.get());

            firstCleanup.complete(null);
            CountDownLatch recovered = new CountDownLatch(1);
            daemon.submit(() -> { }, () -> { }, recovered::countDown,
                    () -> CompletableFuture.completedFuture(null));
            assertTrue(recovered.await(1, TimeUnit.SECONDS));
        } finally {
            firstCleanup.complete(null);
        }
    }

    @Test
    void doesNotRetryPromptWhenAdmissionResponseIsLost() {
        AtomicInteger prompts = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange -> {
            prompts.incrementAndGet();
            exchange.close();
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.acceptanceFuture().join());
            assertInstanceOf(PromptAdmissionUnknownException.class,
                    failure.getCause());
        }
        assertEquals(1, prompts.get());
    }

    @Test
    void retryableHttpPromptFailureIsAdmissionUnknownAndNotRetried() {
        AtomicInteger prompts = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange -> {
            prompts.incrementAndGet();
            sendJson(exchange, 502, "{\"error\":\"bad gateway\"}");
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.acceptanceFuture().join());
            PromptAdmissionUnknownException admissionFailure = assertInstanceOf(
                    PromptAdmissionUnknownException.class, failure.getCause());
            DaemonHttpException cause = assertInstanceOf(DaemonHttpException.class,
                    admissionFailure.getCause());
            assertEquals(502, cause.getStatusCode());
            assertThrows(PromptAlreadyActiveException.class,
                    () -> session.startPrompt(
                            PromptRequest.text("unsafe-reuse"),
                            PromptObserver.NOOP));
        }
        assertEquals(1, prompts.get());
    }

    @Test
    void definitivePromptRejectionRemainsHttpError() {
        AtomicInteger prompts = new AtomicInteger();
        server.createContext("/session/session-1/prompt", exchange -> {
            prompts.incrementAndGet();
            sendJson(exchange, 429, "{\"error\":\"queue full\"}");
        });
        server.createContext("/session/session-1/detach", noContent());

        try (DaemonClient daemon = newClient();
                DaemonSessionClient session = daemon.createSession()) {
            PromptCall call = session.startPrompt(PromptRequest.text("go"),
                    PromptObserver.NOOP);
            CompletionException failure = assertThrows(CompletionException.class,
                    () -> call.acceptanceFuture().join());
            DaemonHttpException cause = assertInstanceOf(DaemonHttpException.class,
                    failure.getCause());
            assertEquals(429, cause.getStatusCode());
            assertThrows(CompletionException.class,
                    () -> call.completionFuture().join());

            PromptCall retry = session.startPrompt(PromptRequest.text("retry"),
                    PromptObserver.NOOP);
            CompletionException retryFailure = assertThrows(
                    CompletionException.class,
                    () -> retry.acceptanceFuture().join());
            assertEquals(429, assertInstanceOf(DaemonHttpException.class,
                    retryFailure.getCause()).getStatusCode());
        }
        assertEquals(2, prompts.get());
    }

    @Test
    void saturatesOversizedHeartbeatAndIdleDurations() {
        server.createContext("/session/session-1/prompt", exchange -> sendJson(exchange,
                202, "{\"promptId\":\"prompt-1\",\"lastEventId\":0}"));
        server.createContext("/session/session-1/events", exchange ->
                sendSse(exchange, terminalEvent(1)));
        server.createContext("/session/session-1/detach", noContent());

        Duration oversized = Duration.ofSeconds(Long.MAX_VALUE);
        try (DaemonClient daemon = clientBuilder()
                .heartbeatInterval(oversized)
                .sseIdleTimeout(oversized)
                .build();
                DaemonSessionClient session = daemon.createSession()) {
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    session.promptText("go").getTerminal().getKind());
        }
    }

    private DaemonClient newClient() {
        return clientBuilder().build();
    }

    private static void assertAmbiguousHttpMutation(Runnable mutation,
            int expectedStatus) {
        MutationOutcomeUnknownException failure = assertThrows(
                MutationOutcomeUnknownException.class, mutation::run);
        DaemonHttpException cause = assertInstanceOf(DaemonHttpException.class,
                failure.getCause());
        assertEquals(expectedStatus, cause.getStatusCode());
    }

    private DaemonClient.Builder clientBuilder() {
        return DaemonClient.builder()
                .baseUri(baseUri)
                .connectTimeout(Duration.ofSeconds(2))
                .requestTimeout(Duration.ofSeconds(2))
                .promptObservationTimeout(Duration.ofSeconds(3))
                .sseIdleTimeout(Duration.ofSeconds(1))
                .heartbeatInterval(Duration.ZERO)
                .maximumReconnectAttempts(2);
    }

    private static HttpHandler noContent() {
        return exchange -> {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        };
    }

    private static void sendJson(HttpExchange exchange, int status, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static void sendSse(HttpExchange exchange, String events)
            throws IOException {
        byte[] bytes = ("retry: 0\n\n" + events).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static String sessionJson() {
        return sessionJson("session-1", "client-1");
    }

    private static String sessionJson(String sessionId, String clientId) {
        return "{\"sessionId\":\"" + sessionId
                + "\",\"workspaceCwd\":\"/tmp/work\","
                + "\"attached\":false,\"clientId\":\"" + clientId + "\"}";
    }

    private static String textEvent(long id, String text) {
        return "id: " + id + "\nevent: session_update\ndata: {\"id\":" + id
                + ",\"v\":1,\"type\":\"session_update\","
                + "\"promptId\":\"prompt-1\",\"data\":{\"sessionId\":"
                + "\"session-1\",\"update\":{\"sessionUpdate\":"
                + "\"agent_message_chunk\",\"content\":{\"type\":\"text\","
                + "\"text\":\"" + text + "\"}}}}\n\n";
    }

    private static String terminalEvent(long id) {
        return terminalEventForPrompt(id, "prompt-1");
    }

    private static String terminalEventForPrompt(long id, String promptId) {
        return terminalEventForPromptAndSession(id, promptId, "session-1");
    }

    private static String terminalEventForSession(long id, String sessionId) {
        return terminalEventForPromptAndSession(id, "prompt-1", sessionId);
    }

    private static String terminalEventForPromptAndSession(long id,
            String promptId, String sessionId) {
        return terminalEvent(id, promptId, sessionId, "end_turn");
    }

    private static String terminalEvent(long id, String promptId,
            String stopReason) {
        return terminalEvent(id, promptId, "session-1", stopReason);
    }

    private static String terminalEvent(long id, String promptId,
            String sessionId, String stopReason) {
        return "id: " + id + "\nevent: turn_complete\ndata: {\"id\":" + id
                + ",\"v\":1,\"type\":\"turn_complete\","
                + "\"promptId\":\"" + promptId + "\",\"data\":{\"promptId\":"
                + "\"" + promptId + "\",\"sessionId\":\"" + sessionId
                + "\",\"stopReason\":\"" + stopReason + "\"}}\n\n";
    }

    private static String conflictingTerminalEvent(long id) {
        return "id: " + id + "\nevent: turn_complete\ndata: {\"id\":" + id
                + ",\"v\":1,\"type\":\"turn_complete\","
                + "\"promptId\":\"prompt-1\",\"data\":{\"promptId\":"
                + "\"prompt-2\",\"sessionId\":\"session-1\","
                + "\"stopReason\":\"end_turn\"}}\n\n";
    }

    private static String errorTerminalEvent(long id) {
        return errorTerminalEvent(id, "prompt-1", "model_error",
                "model failed");
    }

    private static String errorTerminalEvent(long id, String promptId,
            String code, String message) {
        return "id: " + id + "\nevent: turn_error\ndata: {\"id\":" + id
                + ",\"v\":1,\"type\":\"turn_error\","
                + "\"promptId\":\"" + promptId + "\",\"data\":{\"promptId\":"
                + "\"" + promptId + "\",\"sessionId\":\"session-1\","
                + "\"code\":\"" + code + "\","
                + "\"message\":\"" + message + "\"}}\n\n";
    }

    private static String sessionClosedEvent(long id) {
        return "id: " + id + "\nevent: session_closed\ndata: {\"id\":" + id
                + ",\"v\":1,\"type\":\"session_closed\","
                + "\"data\":{\"sessionId\":\"session-1\"}}\n\n";
    }

    private static String updateEvent(long id, String kind, String fields) {
        return "id: " + id + "\nevent: session_update\ndata: {\"id\":" + id
                + ",\"v\":1,\"type\":\"session_update\","
                + "\"promptId\":\"prompt-1\",\"data\":{\"sessionId\":"
                + "\"session-1\",\"update\":{\"sessionUpdate\":\"" + kind
                + "\"," + fields + "}}}\n\n";
    }

    private static String permissionEvent(long id) {
        return "id: " + id + "\nevent: permission_request\ndata: {\"id\":" + id
                + ",\"v\":1,\"type\":\"permission_request\","
                + "\"promptId\":\"prompt-1\",\"data\":{\"requestId\":"
                + "\"request-1\",\"sessionId\":\"session-1\","
                + "\"toolCall\":{\"toolCallId\":\"tool-1\"},"
                + "\"options\":[{\"optionId\":"
                + "\"allow_once\",\"name\":\"Allow once\","
                + "\"kind\":\"allow_once\"}]}}\n\n";
    }

    private static String syntheticEvent(String type) {
        return "event: " + type + "\ndata: {\"v\":1,\"type\":\"" + type
                + "\",\"data\":{}}\n\n";
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void awaitUninterruptibly(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try {
                latch.await();
                break;
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
