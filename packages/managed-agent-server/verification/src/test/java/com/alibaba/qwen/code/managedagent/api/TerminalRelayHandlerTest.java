package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.TerminalHoldAdmission;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The relay admits the terminal's durable hold before it opens the worker
 * terminal, and refuses the browser connection when the hold cannot be
 * admitted — a close racing the attach can never release the Runtime out
 * from under a terminal that is about to exist.
 */
class TerminalRelayHandlerTest {
    private static RuntimeBindingRecord binding() {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1",
                "/workspace", "capability", "session");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                "iso", "static", null);
        RuntimeLease lease = new RuntimeLease("runtime-1",
                URI.create("http://127.0.0.1:43190"), "token", "lease-1", 7);
        return new RuntimeBindingRecord("binding-1", request, 1,
                RuntimeBindingRecord.State.READY, lease, false, null, null, 0, 1,
                Instant.now(), Instant.now());
    }

    private static WebSocketSession session() {
        WebSocketSession session = mock(WebSocketSession.class);
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(TerminalRelayHandshakeInterceptor.BINDING_ATTRIBUTE, binding());
        attributes.put(TerminalRelayHandshakeInterceptor.SESSION_ATTRIBUTE, "session-a");
        attributes.put(TerminalRelayHandshakeInterceptor.TERMINAL_ATTRIBUTE, "term-1");
        when(session.getAttributes()).thenReturn(attributes);
        when(session.isOpen()).thenReturn(true);
        return session;
    }

    @Test
    void admitsTheHoldBeforeOpeningTheWorkerTerminal() {
        RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
        HttpClient client = mock(HttpClient.class);
        WebSocket.Builder builder = mock(WebSocket.Builder.class);
        when(client.newWebSocketBuilder()).thenReturn(builder);
        when(builder.header(anyString(), anyString())).thenReturn(builder);
        when(builder.connectTimeout(any())).thenReturn(builder);
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenReturn(CompletableFuture.completedFuture(mock(WebSocket.class)));
        when(broker.admitTerminalHold("session-a", "term-1"))
                .thenReturn(CompletableFuture.completedFuture(
                        new TerminalHoldAdmission(hold("terminal-attach:term-1:process"), true)));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);

        handler.afterConnectionEstablished(session());

        verify(broker).admitTerminalHold("session-a", "term-1");
        verify(client).newWebSocketBuilder();
    }

    @Test
    void failedFreshAttachAbandonsOnlyTheHoldItCreated() throws Exception {
        RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
        HttpClient client = mock(HttpClient.class);
        WebSocket.Builder builder = mock(WebSocket.Builder.class);
        when(client.newWebSocketBuilder()).thenReturn(builder);
        when(builder.header(anyString(), anyString())).thenReturn(builder);
        when(builder.connectTimeout(any())).thenReturn(builder);
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenReturn(CompletableFuture.failedFuture(
                        new IllegalStateException("worker refused")));
        when(broker.admitTerminalHold("session-a", "term-1"))
                .thenReturn(CompletableFuture.completedFuture(
                        new TerminalHoldAdmission(hold("terminal-attach:term-1:process"), true)));
        when(broker.abandonTerminalHold(anyString(), anyString(), anyString()))
                .thenReturn(CompletableFuture.completedFuture(null));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        WebSocketSession session = session();

        handler.afterConnectionEstablished(session);

        verify(broker).abandonTerminalHold(
                "session-a", "term-1", "terminal-attach:term-1:process");
        verify(session).close(CloseStatus.SERVER_ERROR);
    }

    @Test
    void failedReconnectRetainsTheReusedLiveHold() throws Exception {
        RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
        HttpClient client = mock(HttpClient.class);
        WebSocket.Builder builder = mock(WebSocket.Builder.class);
        when(client.newWebSocketBuilder()).thenReturn(builder);
        when(builder.header(anyString(), anyString())).thenReturn(builder);
        when(builder.connectTimeout(any())).thenReturn(builder);
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenReturn(CompletableFuture.failedFuture(
                        new IllegalStateException("transient reconnect failure")));
        // A reconnect reuses a live PTY's hold (created=false): the failed
        // attempt must not discharge the hold that still protects that PTY.
        when(broker.admitTerminalHold("session-a", "term-1"))
                .thenReturn(CompletableFuture.completedFuture(
                        new TerminalHoldAdmission(hold("terminal-attach:term-1:process"), false)));
        when(broker.abandonTerminalHold(anyString(), anyString(), anyString()))
                .thenReturn(CompletableFuture.completedFuture(null));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        WebSocketSession session = session();

        handler.afterConnectionEstablished(session);

        verify(broker, never()).abandonTerminalHold(anyString(), anyString(), anyString());
        verify(session).close(CloseStatus.SERVER_ERROR);
    }

    private static ToolExecutionRecord hold(String executionCallId) {
        // A real record: getExecutionCallId is final and cannot be stubbed.
        return new ToolExecutionRecord(executionCallId, "idem-1", "binding-1", 1,
                "session-a", "terminal-term-1", "turn-1", "tool-1", "digest-1",
                Map.of("sessionId", "terminal-term-1", "promptId", "turn-1",
                        "callId", "tool-1", "argsDigest", "digest-1"),
                ToolExecutionRecord.State.PREPARED, null, null, 0, false,
                null, null, 0, 1, null);
    }

    @Test
    void holdAdmissionFailureClosesTheBrowserWithoutOpeningTheWorker() throws Exception {
        RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
        HttpClient client = mock(HttpClient.class);
        when(broker.admitTerminalHold("session-a", "term-1"))
                .thenReturn(CompletableFuture.failedFuture(
                        new IllegalStateException("runtime unavailable")));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        WebSocketSession session = session();

        handler.afterConnectionEstablished(session);

        verify(broker).admitTerminalHold("session-a", "term-1");
        verify(client, never()).newWebSocketBuilder();
        verify(session).close(CloseStatus.SERVER_ERROR);
    }

    @Test
    void reassemblesWorkerFragmentsBeforeTheBrowserDecodesThem() throws Exception {
        WebSocket worker = mock(WebSocket.class);
        Attached attached = attach(worker);
        // One worker message delivered across two JDK callbacks, split inside a
        // multibyte character: the browser must receive a single complete
        // message, not two halves its per-message UTF-8 decoder would corrupt.
        byte[] full = "终端€".getBytes(StandardCharsets.UTF_8);
        byte[] first = Arrays.copyOfRange(full, 0, 4);
        byte[] second = Arrays.copyOfRange(full, 4, full.length);
        attached.relay.onBinary(worker, ByteBuffer.wrap(first), false);
        attached.relay.onBinary(worker, ByteBuffer.wrap(second), true);
        assertThat(attached.sent).hasSize(1);
        BinaryMessage message = (BinaryMessage) attached.sent.get(0);
        byte[] received = new byte[message.getPayload().remaining()];
        message.getPayload().get(received);
        assertThat(received).isEqualTo(full);
    }

    @Test
    void queuesASecondFrameWhileTheFirstSendIsPending() throws Exception {
        WebSocket worker = mock(WebSocket.class);
        List<byte[]> delivered = new CopyOnWriteArrayList<>();
        List<CompletableFuture<WebSocket>> sends = new CopyOnWriteArrayList<>();
        AtomicReference<CompletableFuture<WebSocket>> lastSend = new AtomicReference<>();
        // Mimic the JDK client: a second send while the previous one is still
        // pending is rejected. Read the previous future's completion state
        // rather than a flag cleared in a callback, so the check does not race
        // the relay's chained dependent.
        when(worker.sendBinary(any(ByteBuffer.class), eq(true))).thenAnswer(invocation -> {
            CompletableFuture<WebSocket> previous = lastSend.get();
            if (previous != null && !previous.isDone()) {
                throw new IllegalStateException("Send pending");
            }
            ByteBuffer buffer = invocation.getArgument(0);
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);
            CompletableFuture<WebSocket> future = new CompletableFuture<>();
            lastSend.set(future);
            sends.add(future);
            future.whenComplete((ignored, error) -> delivered.add(bytes));
            return future;
        });
        Attached attached = attach(worker);
        byte[] first = new byte[4096];
        byte[] second = new byte[] {7};

        attached.handler.handleBinaryMessage(attached.browser, new BinaryMessage(first));
        attached.handler.handleBinaryMessage(attached.browser, new BinaryMessage(second));

        // The second frame queues behind the pending first send instead of
        // hitting "Send pending" and closing the browser.
        assertThat(sends).hasSize(1);
        sends.get(0).complete(worker);
        assertThat(sends).hasSize(2);
        sends.get(1).complete(worker);
        assertThat(delivered).containsExactly(first, second);
        verify(attached.browser, never()).close(any(CloseStatus.class));
    }

    /** A relay attached to a mock worker, exposing the JDK listener the relay
     * registers so fragment and backpressure behavior can be driven directly. */
    private static final class Attached {
        private final TerminalRelayHandler handler;
        private final WebSocketSession browser;
        private final WebSocket.Listener relay;
        private final List<WebSocketMessage<?>> sent;

        private Attached(TerminalRelayHandler handler, WebSocketSession browser,
                WebSocket.Listener relay, List<WebSocketMessage<?>> sent) {
            this.handler = handler;
            this.browser = browser;
            this.relay = relay;
            this.sent = sent;
        }
    }

    private static Attached attach(WebSocket worker) throws Exception {
        RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
        when(broker.admitTerminalHold("session-a", "term-1"))
                .thenReturn(CompletableFuture.completedFuture(
                        new TerminalHoldAdmission(
                                hold("terminal-attach:term-1:process"), true)));
        HttpClient client = mock(HttpClient.class);
        WebSocket.Builder builder = mock(WebSocket.Builder.class);
        when(client.newWebSocketBuilder()).thenReturn(builder);
        when(builder.header(anyString(), anyString())).thenReturn(builder);
        when(builder.connectTimeout(any())).thenReturn(builder);
        AtomicReference<WebSocket.Listener> relayRef = new AtomicReference<>();
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenAnswer(invocation -> {
                    WebSocket.Listener listener = invocation.getArgument(1);
                    relayRef.set(listener);
                    listener.onOpen(worker);
                    return CompletableFuture.completedFuture(worker);
                });
        WebSocketSession browser = session();
        List<WebSocketMessage<?>> sent = new CopyOnWriteArrayList<>();
        doAnswer(invocation -> {
            sent.add(invocation.getArgument(0));
            return null;
        }).when(browser).sendMessage(any(WebSocketMessage.class));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        handler.afterConnectionEstablished(browser);
        return new Attached(handler, browser, relayRef.get(), sent);
    }
}
