package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.SubProtocolCapable;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Relays a Managed Web Terminal between the browser and the Runtime worker.
 * The handshake has already admitted the caller and resolved a
 * terminal-capable READY binding; this handler opens the worker's terminal
 * upgrade with the binding's bearer/lease identity and forwards frames
 * verbatim in both directions. Terminal I/O is live, keystroke-volume data:
 * it is never journaled, exported or retained. Closing either side closes
 * the other.
 */
public final class TerminalRelayHandler extends AbstractWebSocketHandler
        implements SubProtocolCapable {
    /** The non-secret marker the handshake selects; never the bearer ticket. */
    private static final String WS_SUBPROTOCOL = "qwen-ws";
    private static final String WORKER_TERMINAL_PATH =
            "/internal/managed-runtime/v3/terminal";
    private static final String RELAY_ATTRIBUTE =
            TerminalRelayHandler.class.getName() + ".relay";
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

    private final HttpClient client;
    private final RuntimeBrokerOperations broker;

    public TerminalRelayHandler(RuntimeBrokerOperations broker) {
        this(broker, HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).build());
    }

    TerminalRelayHandler(RuntimeBrokerOperations broker, HttpClient client) {
        this.broker = broker;
        this.client = client;
    }

    @Override
    public List<String> getSubProtocols() {
        return List.of(WS_SUBPROTOCOL);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        RuntimeBindingRecord binding = (RuntimeBindingRecord) session.getAttributes()
                .get(TerminalRelayHandshakeInterceptor.BINDING_ATTRIBUTE);
        String sessionId = (String) session.getAttributes()
                .get(TerminalRelayHandshakeInterceptor.SESSION_ATTRIBUTE);
        String terminalId = (String) session.getAttributes()
                .get(TerminalRelayHandshakeInterceptor.TERMINAL_ATTRIBUTE);
        if (binding == null || sessionId == null || terminalId == null) {
            closeQuietly(session, CloseStatus.SERVER_ERROR);
            return;
        }
        RuntimeLease lease = binding.getLease();
        Relay relay = new Relay(session);
        session.getAttributes().put(RELAY_ATTRIBUTE, relay);
        URI workerUri = workerUri(lease.getEndpoint(), sessionId, terminalId);
        // Admit the durable hold before the worker terminal exists, so a close
        // racing the attach can never release the Runtime out from under it.
        broker.admitTerminalHold(sessionId, terminalId).whenComplete((hold, holdError) -> {
            if (holdError != null) {
                relay.fail();
                closeQuietly(session, CloseStatus.SERVER_ERROR);
                return;
            }
            openWorker(session, relay, lease, workerUri);
        });
    }

    private void openWorker(WebSocketSession session, Relay relay,
            RuntimeLease lease, URI workerUri) {
        try {
            client.newWebSocketBuilder()
                    .header("Authorization", "Bearer " + lease.getToken())
                    .header("Cache-Control", "no-store")
                    .header("X-Qwen-Managed-Lease-Id", lease.getLeaseId())
                    .header("X-Qwen-Managed-Lease-Epoch", Long.toString(lease.getEpoch()))
                    .connectTimeout(CONNECT_TIMEOUT)
                    .buildAsync(workerUri, relay)
                    .whenComplete((worker, error) -> {
                        if (error != null) {
                            relay.fail();
                            closeQuietly(session, CloseStatus.SERVER_ERROR);
                        }
                    });
        } catch (RuntimeException error) {
            relay.fail();
            closeQuietly(session, CloseStatus.SERVER_ERROR);
        }
    }

    private static URI workerUri(URI endpoint, String sessionId, String terminalId) {
        String scheme = "https".equals(endpoint.getScheme()) ? "wss" : "ws";
        String query = "terminalId=" + encode(terminalId)
                + "&cwd=" + encode(sessionId) + "&replay=1";
        return URI.create(scheme + "://" + endpoint.getRawAuthority()
                + WORKER_TERMINAL_PATH + "?" + query);
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        Relay relay = relay(session);
        if (relay != null) {
            relay.toWorkerText(message.getPayload());
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        Relay relay = relay(session);
        if (relay != null) {
            relay.toWorkerBinary(message.getPayload());
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Relay relay = relay(session);
        if (relay != null) {
            relay.fail();
            relay.closeWorker();
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        Relay relay = relay(session);
        if (relay != null) {
            relay.fail();
        }
        closeQuietly(session, CloseStatus.SERVER_ERROR);
    }

    private static Relay relay(WebSocketSession session) {
        return (Relay) session.getAttributes().get(RELAY_ATTRIBUTE);
    }

    private static void closeQuietly(WebSocketSession session, CloseStatus status) {
        try {
            if (session.isOpen()) {
                session.close(status);
            }
        } catch (Exception ignored) {
            // The browser side is already gone.
        }
    }

    /** One browser connection's pipe to its worker terminal. */
    private static final class Relay implements WebSocket.Listener {
        /** Mirrors the worker's 8 MiB socket backpressure ceiling. */
        private static final long MAX_PENDING_BYTES = 8L * 1024 * 1024;
        private final WebSocketSession browser;
        private final AtomicReference<WebSocket> worker = new AtomicReference<>();
        private final java.util.concurrent.atomic.AtomicLong pendingBytes =
                new java.util.concurrent.atomic.AtomicLong();
        private volatile boolean failed;

        Relay(WebSocketSession browser) {
            this.browser = browser;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            // The browser may have closed while the worker upgrade was in
            // flight; do not pin a worker terminal to a dead browser.
            if (failed || !browser.isOpen()) {
                webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "");
                return;
            }
            worker.set(webSocket);
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data,
                boolean last) {
            sendToBrowser(new TextMessage(data.toString()));
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data,
                boolean last) {
            byte[] bytes = new byte[data.remaining()];
            data.get(bytes);
            sendToBrowser(new BinaryMessage(bytes));
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode,
                String reason) {
            closeQuietly(browser, CloseStatus.NORMAL);
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            fail();
            closeQuietly(browser, CloseStatus.SERVER_ERROR);
        }

        void toWorkerText(String payload) {
            send(webSocket -> webSocket.sendText(payload, true),
                    payload.getBytes(StandardCharsets.UTF_8).length);
        }

        void toWorkerBinary(ByteBuffer payload) {
            int bytes = payload.remaining();
            send(webSocket -> webSocket.sendBinary(payload, true), bytes);
        }

        /** Bounds the browser-to-worker queue at the worker's ceiling. */
        private void send(java.util.function.Function<WebSocket,
                CompletionStage<WebSocket>> op, int bytes) {
            WebSocket webSocket = worker.get();
            if (webSocket == null || failed) {
                return;
            }
            if (pendingBytes.addAndGet(bytes) > MAX_PENDING_BYTES) {
                pendingBytes.addAndGet(-bytes);
                fail();
                closeWorker();
                closeQuietly(browser, CloseStatus.TOO_BIG_TO_PROCESS);
                return;
            }
            op.apply(webSocket).whenComplete((ignored, error) -> {
                pendingBytes.addAndGet(-bytes);
                if (error != null) {
                    fail();
                    closeQuietly(browser, CloseStatus.SERVER_ERROR);
                }
            });
        }

        private void sendToBrowser(org.springframework.web.socket.WebSocketMessage<?> message) {
            try {
                synchronized (browser) {
                    if (browser.isOpen()) {
                        browser.sendMessage(message);
                    }
                }
            } catch (Exception error) {
                fail();
                closeWorker();
            }
        }

        void fail() {
            failed = true;
        }

        void closeWorker() {
            WebSocket webSocket = worker.get();
            if (webSocket != null) {
                webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "");
            }
        }
    }
}
