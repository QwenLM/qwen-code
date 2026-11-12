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
import java.util.concurrent.CompletableFuture;
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
    /**
     * The relay-owned non-retryable close code for irretrievable worker loss.
     * Kept in sync with NON_RETRYABLE_CLOSE_CODES in the Web Shell's
     * terminal-protocol.ts; the daemon's own terminal never sends 4003, so the
     * shared local panel is unaffected. Reserved wire codes (1005/1006/1015),
     * transport errors, attach failures and post-attach send failures map here
     * so the panel renders the terminal-lost notice instead of reconnecting
     * forever into a replacement worker's empty PTY. Note: Live Voice also uses
     * 4003 on its own disjoint routes (/live/web, /live/host); the terminal
     * panels never connect to those, so the overlap is benign.
     */
    private static final int TERMINAL_LOST_CLOSE_CODE = 4003;

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
        try {
            broker.admitTerminalHold(sessionId, terminalId).whenComplete((admission, holdError) -> {
                if (holdError != null) {
                    relay.fail();
                    closeQuietly(session, CloseStatus.SERVER_ERROR);
                    return;
                }
                // The browser may have closed while admission was in flight; do
                // not open a worker terminal for a gone client, and discharge the
                // hold this attempt created so it never wedges. A reconnect's
                // reused hold (created=false) belongs to the live PTY and stays.
                if (!session.isOpen()) {
                    relay.fail();
                    if (admission.created()) {
                        broker.abandonTerminalHold(sessionId, terminalId,
                                admission.hold().getExecutionCallId());
                    }
                    closeQuietly(session, CloseStatus.SERVER_ERROR);
                    return;
                }
                openWorker(session, relay, lease, workerUri, sessionId, terminalId,
                        admission.created(), admission.hold().getExecutionCallId());
            });
        } catch (RuntimeException error) {
            // admit validates synchronously (requireOpen / requirePathSafe); a
            // throw here would otherwise escape the container callback after the
            // 101, leaving the browser leg an abrupt 1006 with no server close.
            relay.fail();
            closeQuietly(session, CloseStatus.SERVER_ERROR);
        }
    }

    private void openWorker(WebSocketSession session, Relay relay,
            RuntimeLease lease, URI workerUri, String sessionId, String terminalId,
            boolean createdHold, String holdCallId) {
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
                            abandonHold(sessionId, terminalId, createdHold, holdCallId);
                            closeQuietly(session, new CloseStatus(TERMINAL_LOST_CLOSE_CODE));
                        }
                    });
        } catch (RuntimeException error) {
            relay.fail();
            abandonHold(sessionId, terminalId, createdHold, holdCallId);
            closeQuietly(session, new CloseStatus(TERMINAL_LOST_CLOSE_CODE));
        }
    }

    /** A failed attach may only discharge the hold this attempt newly admitted.
     * A reconnect reuses a live PTY's hold, so a transient failed reconnect must
     * retain it; the broker additionally settles only the named hold. Best-effort:
     * a failure here leaves the hold to the drain, never masks the refused upgrade. */
    private void abandonHold(String sessionId, String terminalId,
            boolean createdHold, String holdCallId) {
        if (!createdHold) {
            return;
        }
        try {
            broker.abandonTerminalHold(sessionId, terminalId, holdCallId)
                    .whenComplete((ignored, error) -> {
                        // The drain remains the backstop if this cannot settle.
                    });
        } catch (RuntimeException ignored) {
            // The drain remains the backstop.
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

    /** Maps a worker close code to the browser leg. Reserved codes that RFC
     * 6455 forbids on the wire (the JDK client reports them when the worker dies
     * without a Close frame) become the relay-owned terminal-lost code; genuine
     * peer codes pass through verbatim. */
    private static CloseStatus browserCloseFor(int workerCode) {
        if (workerCode == 1005 || workerCode == 1006 || workerCode == 1015) {
            return new CloseStatus(TERMINAL_LOST_CLOSE_CODE);
        }
        return new CloseStatus(workerCode);
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
        // The JDK listener may deliver one worker message across several
        // callbacks; reassemble to the message boundary before the browser
        // decodes it, or a multibyte character split across callbacks corrupts.
        private final java.io.ByteArrayOutputStream binaryBuffer =
                new java.io.ByteArrayOutputStream();
        private final StringBuilder textBuffer = new StringBuilder();
        // JDK sends are asynchronous and reject a second send while one is
        // pending; chain them so backpressured input queues instead of closing.
        private final Object sendLock = new Object();
        private CompletionStage<WebSocket> sendTail =
                CompletableFuture.completedFuture(null);
        // The browser socket is open on 101 before the worker upgrade completes
        // (hold admission + handshake). Frames sent in that window — the initial
        // resize and early keystrokes — must queue, not be silently dropped.
        private final java.util.List<PendingSend> preAttach = new java.util.ArrayList<>();
        private volatile boolean failed;

        private record PendingSend(
                java.util.function.Function<WebSocket, CompletionStage<WebSocket>> op,
                int bytes) {
        }

        Relay(WebSocketSession browser) {
            this.browser = browser;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            // The liveness test and the registration must share one critical
            // section with closeWorker(): a browser close landing between the
            // test and the store would otherwise pin a worker socket that
            // nothing ever closes.
            synchronized (sendLock) {
                // The browser may have closed while the worker upgrade was in
                // flight; do not pin a worker terminal to a dead browser.
                if (failed || !browser.isOpen()) {
                    webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "");
                    return;
                }
                worker.set(webSocket);
                for (PendingSend pending : preAttach) {
                    chainSend(webSocket, pending.op(), pending.bytes());
                }
                preAttach.clear();
            }
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data,
                boolean last) {
            textBuffer.append(data);
            if (textBuffer.length() > MAX_PENDING_BYTES) {
                fail();
                closeWorker();
                closeQuietly(browser, CloseStatus.TOO_BIG_TO_PROCESS);
                return null;
            }
            if (last) {
                String message = textBuffer.toString();
                textBuffer.setLength(0);
                sendToBrowser(new TextMessage(message));
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data,
                boolean last) {
            byte[] chunk = new byte[data.remaining()];
            data.get(chunk);
            binaryBuffer.writeBytes(chunk);
            if (binaryBuffer.size() > MAX_PENDING_BYTES) {
                fail();
                closeWorker();
                closeQuietly(browser, CloseStatus.TOO_BIG_TO_PROCESS);
                return null;
            }
            if (last) {
                byte[] message = binaryBuffer.toByteArray();
                binaryBuffer.reset();
                sendToBrowser(new BinaryMessage(message));
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode,
                String reason) {
            // Forward genuine peer close codes: the panel's non-retryable policy
            // keys on them (e.g. 4001 fatal failure). Rewriting every close to
            // 1000 would make a fatally failed terminal reconnect forever. But
            // the reserved codes the JDK client reports when the worker dies
            // without a Close frame (1005/1006/1015) must map to the relay-owned
            // terminal-lost code, or the panel would retry forever.
            fail();
            closeQuietly(browser, browserCloseFor(statusCode));
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            fail();
            closeQuietly(browser, new CloseStatus(TERMINAL_LOST_CLOSE_CODE));
        }

        void toWorkerText(String payload) {
            send(webSocket -> webSocket.sendText(payload, true),
                    payload.getBytes(StandardCharsets.UTF_8).length);
        }

        void toWorkerBinary(ByteBuffer payload) {
            int bytes = payload.remaining();
            send(webSocket -> webSocket.sendBinary(payload, true), bytes);
        }

        /** Bounds the browser-to-worker queue at the worker's ceiling and
         * serializes the asynchronous JDK sends, which reject a second send
         * while one is pending; queued input waits its turn instead of closing
         * the connection. */
        private void send(java.util.function.Function<WebSocket,
                CompletionStage<WebSocket>> op, int bytes) {
            synchronized (sendLock) {
                if (failed) {
                    return;
                }
                if (pendingBytes.addAndGet(bytes) > MAX_PENDING_BYTES) {
                    pendingBytes.addAndGet(-bytes);
                    fail();
                    closeWorker();
                    closeQuietly(browser, CloseStatus.TOO_BIG_TO_PROCESS);
                    return;
                }
                WebSocket webSocket = worker.get();
                if (webSocket == null) {
                    // The worker upgrade is still in flight; hold the frame
                    // (already accounted) until onOpen flushes the queue.
                    preAttach.add(new PendingSend(op, bytes));
                    return;
                }
                chainSend(webSocket, op, bytes);
            }
        }

        /** Chains one already-accounted send onto the pending tail; the caller
         * holds {@code sendLock}. */
        private void chainSend(WebSocket webSocket,
                java.util.function.Function<WebSocket, CompletionStage<WebSocket>> op,
                int bytes) {
            sendTail = sendTail.thenCompose(ignored -> {
                if (failed) {
                    return CompletableFuture.completedFuture(webSocket);
                }
                return op.apply(webSocket);
            }).whenComplete((ignored, error) -> {
                pendingBytes.addAndGet(-bytes);
                if (error != null) {
                    fail();
                    // The worker is already attached and a send to it failed:
                    // the worker is gone. Close with the terminal-lost code so
                    // the panel ends instead of reconnecting into a replacement
                    // worker's empty PTY.
                    closeQuietly(browser, new CloseStatus(TERMINAL_LOST_CLOSE_CODE));
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
            // Same monitor as onOpen's registration so a close can never slip
            // between the liveness test and the store (reentrant: send() already
            // holds sendLock when it calls this).
            synchronized (sendLock) {
                WebSocket webSocket = worker.get();
                if (webSocket != null) {
                    webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "");
                }
            }
        }
    }
}
