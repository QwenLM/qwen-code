package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import jakarta.websocket.CloseReason;
import jakarta.websocket.OnClose;
import jakarta.websocket.OnMessage;
import jakarta.websocket.OnOpen;
import jakarta.websocket.Session;
import jakarta.websocket.server.ServerEndpoint;
import jakarta.websocket.server.ServerEndpointConfig;
import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;
import org.apache.tomcat.websocket.server.WsServerContainer;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.ByteBuffer;
import java.time.Clock;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Real-scenario relay: a real control-plane relay (real {@link HttpClient},
 * real durable hold through a real {@link RuntimeBrokerService}) bridges a
 * browser session to a real WebSocket worker over a real socket. Bytes sent
 * by the browser must reach the worker and the worker's reply must come back
 * — no mocked transport on the data path. The worker here is a real Tomcat
 * WebSocket endpoint that echoes, standing in for the Runtime worker's
 * terminal upgrade; the PTY itself is exercised by the worker-side suite.
 */
class TerminalRelayRealScenarioTest {
    /** A real WebSocket worker that echoes every binary/text frame back. */
    @ServerEndpoint("/internal/managed-runtime/v3/terminal")
    public static class EchoWorker {
        static final CountDownLatch opened = new CountDownLatch(1);
        static volatile Session last;

        @OnOpen
        public void onOpen(Session session) {
            last = session;
            opened.countDown();
        }

        @OnMessage
        public void onBinary(byte[] data, Session session) {
            try {
                session.getBasicRemote().sendBinary(ByteBuffer.wrap(data));
            } catch (Exception ignored) {
                // The browser side may already be gone.
            }
        }

        @OnMessage
        public void onText(String text, Session session) {
            try {
                session.getBasicRemote().sendText(text);
            } catch (Exception ignored) {
                // The browser side may already be gone.
            }
        }

        @OnClose
        public void onClose(Session session, CloseReason reason) {
            // Nothing to clean up.
        }
    }

    /** Registers the echo endpoint while the context initializes, so the
     * WsFilter is wired before the first upgrade arrives. */
    public static class EndpointRegistrar implements jakarta.servlet.ServletContextListener {
        @Override
        public void contextInitialized(jakarta.servlet.ServletContextEvent sce) {
            WsServerContainer container = (WsServerContainer) sce.getServletContext()
                    .getAttribute(jakarta.websocket.server.ServerContainer.class.getName());
            try {
                container.addEndpoint(ServerEndpointConfig.Builder
                        .create(EchoWorker.class, "/internal/managed-runtime/v3/terminal").build());
            } catch (jakarta.websocket.DeploymentException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    /** Minimal real transport: only the lifecycle the terminal hold needs. */
    private static final class TerminalTransport implements RuntimeTransport {
        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> operation) {
            return CompletableFuture.completedFuture(Map.of("state", "unknown"));
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of("executionStatus", "success"));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of("state", "cancel_requested"));
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class WorkerProvisioner implements RuntimeProvisioner {
        private final URI endpoint;
        private final AtomicInteger ids = new AtomicInteger();

        WorkerProvisioner(URI endpoint) {
            this.endpoint = endpoint;
        }

        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            int id = ids.incrementAndGet();
            return CompletableFuture.completedFuture(new RuntimeLease(
                    "runtime-" + id, endpoint, "worker-token", "lease-" + id, 1));
        }

        @Override
        public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public boolean canRetryFailedConfirm(RuntimeLease lease) {
            return false;
        }

        @Override
        public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public boolean isUsable(RuntimeLease lease) {
            return true;
        }

        @Override
        public void close() {
            // Nothing to close.
        }
    }

    @Test
    void relaysBrowserBytesToARealWorkerAndBackThroughARealHold() throws Exception {
        // A real WebSocket worker on a real socket.
        Tomcat tomcat = new Tomcat();
        tomcat.setPort(0);
        tomcat.getConnector();
        File docBase = java.nio.file.Files.createTempDirectory("mwt-worker").toFile();
        Context ctx = tomcat.addWebapp("", docBase.getAbsolutePath());
        ctx.addServletContainerInitializer(new org.apache.tomcat.websocket.server.WsSci(), null);
        ctx.addApplicationListener(EndpointRegistrar.class.getName());
        tomcat.start();
        int port = tomcat.getConnector().getLocalPort();
        URI workerEndpoint = URI.create("http://127.0.0.1:" + port);

        // A real broker with a real durable hold.
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1",
                "/workspace", "capability", "session");
        org.h2.jdbcx.JdbcDataSource source = new org.h2.jdbcx.JdbcDataSource();
        source.setURL("jdbc:h2:mem:terminal-real-" + java.util.UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        JdbcRuntimeBindingRepository bindingRepository =
                new JdbcRuntimeBindingRepository(source,
                        new AesGcmSecretProtector("test", new byte[32]));
        JdbcRuntimeSessionRepository sessionRepository =
                new JdbcRuntimeSessionRepository(source);
        JdbcToolExecutionRepository executionRepository =
                new JdbcToolExecutionRepository(source);
        HarnessSessionResolver resolver =
                harness -> CompletableFuture.completedFuture(scope);
        RuntimeBrokerService broker = new RuntimeBrokerService(resolver,
                new WorkerProvisioner(workerEndpoint), new TerminalTransport(),
                bindingRepository, sessionRepository, executionRepository,
                "broker", Duration.ofSeconds(30), Duration.ofSeconds(30));

        // The browser side captures what the relay sends back.
        List<WebSocketMessage<?>> sent = new CopyOnWriteArrayList<>();
        CountDownLatch reply = new CountDownLatch(1);
        WebSocketSession browser = mock(WebSocketSession.class);
        Map<String, Object> attributes = new HashMap<>();
        RuntimeBindingRecord binding = brokerBinding(broker);
        attributes.put(TerminalRelayHandshakeInterceptor.BINDING_ATTRIBUTE, binding);
        attributes.put(TerminalRelayHandshakeInterceptor.SESSION_ATTRIBUTE, "session-a");
        attributes.put(TerminalRelayHandshakeInterceptor.TERMINAL_ATTRIBUTE, "term-real");
        when(browser.getAttributes()).thenReturn(attributes);
        when(browser.isOpen()).thenReturn(true);
        List<CloseStatus> closes = new CopyOnWriteArrayList<>();
        doAnswer(invocation -> {
            closes.add(invocation.getArgument(0));
            return null;
        }).when(browser).close(any(CloseStatus.class));
        doAnswer(invocation -> {
            sent.add(invocation.getArgument(0));
            reply.countDown();
            return null;
        }).when(browser).sendMessage(any(WebSocketMessage.class));

        // Sanity: the real worker socket is reachable on its own.
        java.net.http.WebSocket probe = HttpClient.newHttpClient()
                .newWebSocketBuilder()
                .buildAsync(URI.create("ws://127.0.0.1:" + port
                        + "/internal/managed-runtime/v3/terminal"),
                        new java.net.http.WebSocket.Listener() {})
                .get(10, TimeUnit.SECONDS);
        probe.sendClose(java.net.http.WebSocket.NORMAL_CLOSURE, "")
                .get(10, TimeUnit.SECONDS);

        TerminalRelayHandler handler =
                new TerminalRelayHandler(broker, HttpClient.newHttpClient());
        try {
            handler.afterConnectionEstablished(browser);
            // The static opened latch is already spent by the sanity probe, so
            // awaiting it would pass even if the relay never opened a worker.
            // Poll for the relay's own live worker session instead (the probe
            // is fully closed above, so an open 'last' can only be the relay's).
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while ((EchoWorker.last == null || !EchoWorker.last.isOpen())
                    && System.nanoTime() < deadline) {
                Thread.sleep(20);
            }
            assertThat(EchoWorker.last != null && EchoWorker.last.isOpen())
                    .as("relay opened a real worker connection; browser closes=%s", closes)
                    .isTrue();
            // The durable hold was really admitted before the worker opened.
            // The ledger key folds in the harness Session (hashed).
            String terminalKey = org.apache.commons.codec.digest.DigestUtils
                    .sha256Hex("session-a:term-real");
            ToolExecutionRecord hold = executionRepository
                    .findByExecutionCallId("terminal-attach:" + terminalKey + ":process");
            assertThat(hold).isNotNull();
            assertThat(hold.getState()).isEqualTo(ToolExecutionRecord.State.PREPARED);

            // Browser input reaches the real worker and the echo comes back.
            byte[] payload = "hello-terminal".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            handler.handleBinaryMessage(browser, new BinaryMessage(payload));
            assertThat(reply.await(10, TimeUnit.SECONDS))
                    .as("worker reply came back through the relay").isTrue();
            BinaryMessage echoed = (BinaryMessage) sent.get(0);
            byte[] back = new byte[echoed.getPayload().remaining()];
            echoed.getPayload().get(back);
            assertThat(back).isEqualTo(payload);

            // Closing the browser closes the real worker connection.
            handler.afterConnectionClosed(browser, CloseStatus.NORMAL);
        } finally {
            broker.close();
            tomcat.stop();
            tomcat.destroy();
        }
    }

    @Test
    void killingTheRealWorkerClosesTheBrowserLegWithTheTerminalLostCode() throws Exception {
        Tomcat tomcat = new Tomcat();
        tomcat.setPort(0);
        tomcat.getConnector();
        File docBase = java.nio.file.Files.createTempDirectory("mwt-worker-loss").toFile();
        Context ctx = tomcat.addWebapp("", docBase.getAbsolutePath());
        ctx.addServletContainerInitializer(new org.apache.tomcat.websocket.server.WsSci(), null);
        ctx.addApplicationListener(EndpointRegistrar.class.getName());
        tomcat.start();
        int port = tomcat.getConnector().getLocalPort();
        URI workerEndpoint = URI.create("http://127.0.0.1:" + port);

        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1",
                "/workspace", "capability", "session");
        org.h2.jdbcx.JdbcDataSource source = new org.h2.jdbcx.JdbcDataSource();
        source.setURL("jdbc:h2:mem:terminal-loss-" + java.util.UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        JdbcRuntimeBindingRepository bindingRepository =
                new JdbcRuntimeBindingRepository(source,
                        new AesGcmSecretProtector("test", new byte[32]));
        JdbcRuntimeSessionRepository sessionRepository =
                new JdbcRuntimeSessionRepository(source);
        JdbcToolExecutionRepository executionRepository =
                new JdbcToolExecutionRepository(source);
        HarnessSessionResolver resolver =
                harness -> CompletableFuture.completedFuture(scope);
        RuntimeBrokerService broker = new RuntimeBrokerService(resolver,
                new WorkerProvisioner(workerEndpoint), new TerminalTransport(),
                bindingRepository, sessionRepository, executionRepository,
                "broker", Duration.ofSeconds(30), Duration.ofSeconds(30));

        WebSocketSession browser = mock(WebSocketSession.class);
        Map<String, Object> attributes = new HashMap<>();
        RuntimeBindingRecord binding = brokerBinding(broker);
        attributes.put(TerminalRelayHandshakeInterceptor.BINDING_ATTRIBUTE, binding);
        attributes.put(TerminalRelayHandshakeInterceptor.SESSION_ATTRIBUTE, "session-a");
        attributes.put(TerminalRelayHandshakeInterceptor.TERMINAL_ATTRIBUTE, "term-loss");
        when(browser.getAttributes()).thenReturn(attributes);
        when(browser.isOpen()).thenReturn(true);
        List<CloseStatus> closes = new CopyOnWriteArrayList<>();
        doAnswer(invocation -> {
            closes.add(invocation.getArgument(0));
            return null;
        }).when(browser).close(any(CloseStatus.class));

        TerminalRelayHandler handler =
                new TerminalRelayHandler(broker, HttpClient.newHttpClient());
        try {
            handler.afterConnectionEstablished(browser);
            // Wait for the real worker connection to be open (the shared opened
            // latch may already be spent by a sibling test, so poll the session).
            long deadline = System.currentTimeMillis() + 10_000;
            while (System.currentTimeMillis() < deadline
                    && (EchoWorker.last == null || !EchoWorker.last.isOpen())) {
                Thread.sleep(20);
            }
            assertThat(EchoWorker.last).isNotNull();
            assertThat(EchoWorker.last.isOpen()).isTrue();

            // Kill the real worker abruptly (no graceful WebSocket Close frame),
            // simulating a killed worker process: the JDK client then reports the
            // reserved abnormal-close code 1006, which the relay must map to the
            // non-retryable terminal-lost code 4003, not forward verbatim.
            tomcat.getConnector().getProtocolHandler().destroy();
            long closeDeadline = System.currentTimeMillis() + 10_000;
            while (System.currentTimeMillis() < closeDeadline && closes.isEmpty()) {
                Thread.sleep(20);
            }
            assertThat(closes).isNotEmpty();
            assertThat(closes.get(0).getCode())
                    .as("worker loss must surface the terminal-lost code, not a retryable one")
                    .isEqualTo(4003);
        } finally {
            broker.close();
            tomcat.stop();
            tomcat.destroy();
        }
    }

    @Test
    void browserLegAcceptsAWholePasteBeyondTheTomcatDefault() throws Exception {
        Tomcat tomcat = new Tomcat();
        tomcat.setPort(0);
        tomcat.getConnector();
        File docBase = java.nio.file.Files.createTempDirectory("mwt-paste").toFile();
        Context ctx = tomcat.addWebapp("", docBase.getAbsolutePath());
        ctx.addServletContainerInitializer(new org.apache.tomcat.websocket.server.WsSci(), null);
        ctx.addApplicationListener(EndpointRegistrar.class.getName());
        tomcat.start();
        int port = tomcat.getConnector().getLocalPort();
        try {
            // Apply the terminal container configuration (the fix under test);
            // Tomcat's 8 KiB default would close a larger frame with 1009.
            com.alibaba.qwen.code.managedagent.config.TerminalWebSocketConfig config =
                    new com.alibaba.qwen.code.managedagent.config.TerminalWebSocketConfig(
                            mock(RuntimeBrokerService.class), Clock.systemUTC());
            org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean container =
                    config.terminalWebSocketContainer();
            container.setServletContext(ctx.getServletContext());
            container.afterPropertiesSet();

            byte[] paste = new byte[32 * 1024];
            new java.util.Random(7).nextBytes(paste);
            java.io.ByteArrayOutputStream received = new java.io.ByteArrayOutputStream();
            CountDownLatch echoed = new CountDownLatch(1);
            java.net.http.WebSocket client = HttpClient.newHttpClient()
                    .newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port
                                    + "/internal/managed-runtime/v3/terminal"),
                            new java.net.http.WebSocket.Listener() {
                                @Override
                                public CompletionStage<?> onBinary(
                                        java.net.http.WebSocket webSocket,
                                        ByteBuffer data, boolean last) {
                                    byte[] chunk = new byte[data.remaining()];
                                    data.get(chunk);
                                    received.writeBytes(chunk);
                                    if (last) {
                                        echoed.countDown();
                                    }
                                    webSocket.request(1);
                                    return null;
                                }
                            })
                    .get(10, TimeUnit.SECONDS);
            client.sendBinary(ByteBuffer.wrap(paste), true);
            assertThat(echoed.await(10, TimeUnit.SECONDS))
                    .as("a 32 KiB paste is echoed, not closed 1009").isTrue();
            assertThat(received.toByteArray()).isEqualTo(paste);
            client.sendClose(java.net.http.WebSocket.NORMAL_CLOSURE, "");
        } finally {
            tomcat.stop();
            tomcat.destroy();
        }
    }

    private static RuntimeBindingRecord brokerBinding(RuntimeBrokerService broker) {
        // Admit the hold once to materialize a READY binding the relay can use,
        // then read it back; the relay re-admits idempotently on attach.
        broker.admitTerminalHold("session-a", "term-real").toCompletableFuture().join();
        return broker.findLatestBindingByHarnessSession("tenant", "session-a");
    }
}
