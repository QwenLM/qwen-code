package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
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
                .thenReturn(CompletableFuture.completedFuture(mock(ToolExecutionRecord.class)));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);

        handler.afterConnectionEstablished(session());

        verify(broker).admitTerminalHold("session-a", "term-1");
        verify(client).newWebSocketBuilder();
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
}
