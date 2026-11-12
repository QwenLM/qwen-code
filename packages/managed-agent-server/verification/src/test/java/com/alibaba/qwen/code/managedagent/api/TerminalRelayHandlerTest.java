package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.TerminalHoldAdmission;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
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

        // The hold must be admitted BEFORE the worker upgrade opens: a close
        // racing the attach must never release the Runtime under a terminal
        // that is about to exist. InOrder is what catches a reorder.
        org.mockito.InOrder order = org.mockito.Mockito.inOrder(broker, client);
        order.verify(broker).admitTerminalHold("session-a", "term-1");
        order.verify(client).newWebSocketBuilder();
    }

    @Test
    void browserGoneDuringAdmissionAbandonsTheCreatedHoldWithoutOpeningAWorker() {
        RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
        HttpClient client = mock(HttpClient.class);
        CompletableFuture<TerminalHoldAdmission> admission = new CompletableFuture<>();
        when(broker.admitTerminalHold("session-a", "term-1")).thenReturn(admission);
        when(broker.abandonTerminalHold(eq("session-a"), eq("term-1"), anyString()))
                .thenReturn(CompletableFuture.completedFuture(null));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        WebSocketSession session = session();
        // The browser closes while admission is still in flight.
        when(session.isOpen()).thenReturn(false);

        handler.afterConnectionEstablished(session);
        admission.complete(new TerminalHoldAdmission(
                hold("terminal-attach:term-1:process"), true));

        // The hold this attempt created must be discharged, and no worker
        // terminal may be opened for a client that no longer exists.
        verify(broker).abandonTerminalHold(eq("session-a"), eq("term-1"),
                eq("terminal-attach:term-1:process"));
        verify(client, never()).newWebSocketBuilder();
    }

    @Test
    void presentsTheLeaseIdentityAndTerminalTargetOnTheWorkerUpgrade() throws Exception {
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

        // The worker upgrade must carry the binding's bearer and lease identity
        // and name this terminal and Session, or the worker refuses the attach
        // (or wires a superseded lease epoch's PTY).
        verify(builder).header("Authorization", "Bearer token");
        verify(builder).header("X-Qwen-Managed-Lease-Id", "lease-1");
        verify(builder).header("X-Qwen-Managed-Lease-Epoch", "7");
        ArgumentCaptor<URI> uri = ArgumentCaptor.forClass(URI.class);
        verify(builder).buildAsync(uri.capture(), any(WebSocket.Listener.class));
        assertThat(uri.getValue().getPath())
                .isEqualTo("/internal/managed-runtime/v3/terminal");
        assertThat(uri.getValue().getQuery())
                .isEqualTo("terminalId=term-1&cwd=session-a&replay=1");
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
        // Worker loss is terminal: the relay maps it to the non-retryable
        // terminal-lost code (4003, in the Web Shell NON_RETRYABLE_CLOSE_CODES)
        // so the panel renders the lost notice instead of reconnecting forever.
        verify(session).close(new CloseStatus(4003));
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
        verify(session).close(new CloseStatus(4003));
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
    void synchronousAdmissionThrowIsContainedAndClosesTheBrowser() throws Exception {
        RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
        HttpClient client = mock(HttpClient.class);
        // admit validates synchronously (requireOpen / requirePathSafe); a
        // throw here must not escape the container callback after the 101,
        // which would leave the browser leg an abrupt 1006 with no close.
        when(broker.admitTerminalHold("session-a", "term-1"))
                .thenThrow(new IllegalStateException("runtime unavailable"));
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        WebSocketSession session = session();

        handler.afterConnectionEstablished(session);

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
        // The listener must re-grant demand after every callback (onOpen plus
        // the two fragments); a dropped request(1) would silence the terminal
        // after the first frame while every other assertion stays green.
        verify(worker, org.mockito.Mockito.times(3)).request(1);
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

    @Test
    void forwardsTheWorkerCloseCodeToTheBrowser() throws Exception {
        WebSocket worker = mock(WebSocket.class);
        Attached attached = attach(worker);
        // A fatal worker failure closes 4001; the browser must see 4001 so the
        // panel's non-retryable policy stops reconnecting (not a rewritten 1000).
        attached.relay.onClose(worker, 4001, "fatal");
        verify(attached.browser).close(argThat(status -> status.getCode() == 4001));
    }

    @Test
    void mapsIrretrievableWorkerLossToTheNonRetryableTerminalLostCode() throws Exception {
        // The JDK client reports reserved codes when the worker dies without a
        // Close frame; forwarding them verbatim would make the panel reconnect
        // forever into a replacement worker's empty PTY. Each must map to the
        // relay-owned terminal-lost code (4003, in NON_RETRYABLE_CLOSE_CODES).
        for (int reserved : new int[] {1005, 1006, 1015}) {
            WebSocket worker = mock(WebSocket.class);
            Attached attached = attach(worker);
            attached.relay.onClose(worker, reserved, "");
            verify(attached.browser).close(argThat(status -> status.getCode() == 4003));
        }
        // A transport error is likewise terminal, not a retryable SERVER_ERROR.
        WebSocket worker = mock(WebSocket.class);
        Attached attached = attach(worker);
        attached.relay.onError(worker, new IllegalStateException("worker gone"));
        verify(attached.browser).close(argThat(status -> status.getCode() == 4003));
    }

    @Test
    void aFailedSendToTheAttachedWorkerClosesTheBrowserWithTheTerminalLostCode() throws Exception {
        // The worker is already attached; a send to it failing means the worker
        // is gone. The browser must see the terminal-lost code, not a retryable
        // SERVER_ERROR that would reconnect into a replacement worker's empty
        // PTY (the post-attach half of the worker-loss surface).
        WebSocket worker = mock(WebSocket.class);
        when(worker.sendBinary(any(ByteBuffer.class), eq(true)))
                .thenReturn(CompletableFuture.failedFuture(
                        new IllegalStateException("worker send failed")));
        Attached attached = attach(worker);
        attached.handler.handleBinaryMessage(attached.browser,
                new BinaryMessage(new byte[] {1, 2, 3}));
        verify(attached.browser, org.mockito.Mockito.timeout(2000))
                .close(argThat(status -> status.getCode() == 4003));
    }

    @Test
    void browserCloseRacingWorkerRegistrationNeverOrphansTheWorkerSocket() throws Exception {
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
        WebSocket worker = mock(WebSocket.class);
        AtomicReference<WebSocket.Listener> relayRef = new AtomicReference<>();
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenAnswer(invocation -> {
                    relayRef.set(invocation.getArgument(1));
                    return CompletableFuture.completedFuture(worker);
                });
        // Park the browser liveness probe to widen the window between the probe
        // and the worker registration, so a concurrent browser close can land
        // inside it.
        CountDownLatch probeEntered = new CountDownLatch(1);
        CountDownLatch releaseProbe = new CountDownLatch(1);
        WebSocketSession browser = session();
        // The admission's browser-gone check calls isOpen() first and must not
        // block; only the onOpen liveness probe (the second call) parks.
        java.util.concurrent.atomic.AtomicInteger openCalls =
                new java.util.concurrent.atomic.AtomicInteger();
        when(browser.isOpen()).thenAnswer(invocation -> {
            if (openCalls.incrementAndGet() == 1) {
                return true;
            }
            probeEntered.countDown();
            assertThat(releaseProbe.await(10, TimeUnit.SECONDS)).isTrue();
            return true;
        });
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        handler.afterConnectionEstablished(browser);
        WebSocket.Listener relay = relayRef.get();

        Thread opener = new Thread(() -> relay.onOpen(worker), "relay-onopen");
        opener.start();
        assertThat(probeEntered.await(10, TimeUnit.SECONDS)).isTrue();
        // The browser closes while the probe is parked. With the probe and the
        // registration sharing one monitor, closeWorker waits and then closes the
        // registered worker; with the probe outside the monitor it would see no
        // worker yet and orphan the socket the registration is about to store.
        Thread closer = new Thread(
                () -> handler.afterConnectionClosed(browser, CloseStatus.NORMAL),
                "relay-close");
        closer.start();
        // Let the closer reach closeWorker (it parks on the monitor when the
        // probe and registration are atomic) before the probe is released.
        closer.join(500);
        releaseProbe.countDown();
        opener.join(10_000);
        closer.join(10_000);

        verify(worker).sendClose(eq(WebSocket.NORMAL_CLOSURE), anyString());
    }

    @Test
    void queuesBrowserFramesUntilTheWorkerAttaches() throws Exception {
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
        WebSocket worker = mock(WebSocket.class);
        when(worker.sendBinary(any(ByteBuffer.class), eq(true)))
                .thenReturn(CompletableFuture.completedFuture(worker));
        AtomicReference<WebSocket.Listener> relayRef = new AtomicReference<>();
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenAnswer(invocation -> {
                    relayRef.set(invocation.getArgument(1));
                    // The worker upgrade is still in flight: onOpen has not run.
                    return CompletableFuture.completedFuture(worker);
                });
        WebSocketSession browser = session();
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        handler.afterConnectionEstablished(browser);

        byte[] frame = "early-resize".getBytes(StandardCharsets.UTF_8);
        handler.handleBinaryMessage(browser, new BinaryMessage(frame));
        // Queued, not dropped and not yet sent.
        verify(worker, never()).sendBinary(any(ByteBuffer.class), eq(true));

        relayRef.get().onOpen(worker);
        ArgumentCaptor<ByteBuffer> captor = ArgumentCaptor.forClass(ByteBuffer.class);
        verify(worker).sendBinary(captor.capture(), eq(true));
        ByteBuffer delivered = captor.getValue();
        byte[] bytes = new byte[delivered.remaining()];
        delivered.get(bytes);
        assertThat(bytes).isEqualTo(frame);
    }

    @Test
    void snapshotsQueuedBinaryFramesAgainstContainerBufferReuse() throws Exception {
        // The container may reuse the incoming ByteBuffer once the handler
        // callback returns; a pre-attach send runs later, so the relay must
        // snapshot the bytes at acceptance, not read the buffer at send time.
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
        WebSocket worker = mock(WebSocket.class);
        when(worker.sendBinary(any(ByteBuffer.class), eq(true)))
                .thenReturn(CompletableFuture.completedFuture(worker));
        AtomicReference<WebSocket.Listener> relayRef = new AtomicReference<>();
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenAnswer(invocation -> {
                    relayRef.set(invocation.getArgument(1));
                    return CompletableFuture.completedFuture(worker);
                });
        WebSocketSession browser = session();
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        handler.afterConnectionEstablished(browser);

        byte[] frame = "original".getBytes(StandardCharsets.UTF_8);
        handler.handleBinaryMessage(browser, new BinaryMessage(frame));
        // The container reuses the buffer for the next frame before the worker
        // attaches; the queued send must still deliver the original bytes.
        Arrays.fill(frame, (byte) 'X');
        relayRef.get().onOpen(worker);
        ArgumentCaptor<ByteBuffer> captor = ArgumentCaptor.forClass(ByteBuffer.class);
        verify(worker).sendBinary(captor.capture(), eq(true));
        ByteBuffer delivered = captor.getValue();
        byte[] bytes = new byte[delivered.remaining()];
        delivered.get(bytes);
        assertThat(bytes).isEqualTo("original".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void boundsThePreAttachQueueByEntryCountNotOnlyBytes() throws Exception {
        // A flood of 1-byte frames stays under the 8 MiB byte ceiling but each
        // queued entry costs ~124 bytes of heap; the entry cap must close the
        // browser before the queue exhausts memory.
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
        WebSocket worker = mock(WebSocket.class);
        AtomicReference<WebSocket.Listener> relayRef = new AtomicReference<>();
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenAnswer(invocation -> {
                    relayRef.set(invocation.getArgument(1));
                    return CompletableFuture.completedFuture(worker);
                });
        WebSocketSession browser = session();
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        handler.afterConnectionEstablished(browser);

        for (int i = 0; i < 8192; i++) {
            handler.handleBinaryMessage(browser, new BinaryMessage(new byte[] {1}));
        }
        verify(browser, never()).close(any(CloseStatus.class));
        // The 8193rd entry crosses the cap.
        handler.handleBinaryMessage(browser, new BinaryMessage(new byte[] {1}));
        verify(browser).close(argThat(status ->
                status.getCode() == CloseStatus.TOO_BIG_TO_PROCESS.getCode()));
    }

    @Test
    void flushesAnAcceptedReleaseToTheWorkerWhenTheBrowserClosedDuringAttach() throws Exception {
        // The browser sent a release just before closing while the worker
        // upgrade was in flight. The abort path must deliver that accepted
        // frame to the live worker before closing it, or the PTY and its
        // durable hold leak.
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
        WebSocket worker = mock(WebSocket.class);
        when(worker.sendText(anyString(), eq(true)))
                .thenReturn(CompletableFuture.completedFuture(worker));
        AtomicReference<WebSocket.Listener> relayRef = new AtomicReference<>();
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenAnswer(invocation -> {
                    relayRef.set(invocation.getArgument(1));
                    return CompletableFuture.completedFuture(worker);
                });
        WebSocketSession browser = session();
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);
        handler.afterConnectionEstablished(browser);

        String release = "\u0000{\"type\":\"release\"}";
        handler.handleTextMessage(browser, new org.springframework.web.socket.TextMessage(release));
        // The browser closes before the worker attaches.
        handler.afterConnectionClosed(browser, CloseStatus.NORMAL);
        relayRef.get().onOpen(worker);

        verify(worker, org.mockito.Mockito.timeout(2000)).sendText(eq(release), eq(true));
        verify(worker, org.mockito.Mockito.timeout(2000))
                .sendClose(eq(WebSocket.NORMAL_CLOSURE), anyString());
    }

    @Test
    void picksTheWssSchemeForAnHttpsLeaseEndpointCaseInsensitively() throws Exception {
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
        AtomicReference<URI> uriRef = new AtomicReference<>();
        when(builder.buildAsync(any(URI.class), any(WebSocket.Listener.class)))
                .thenAnswer(invocation -> {
                    uriRef.set(invocation.getArgument(0));
                    return CompletableFuture.completedFuture(mock(WebSocket.class));
                });
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1",
                "/workspace", "capability", "session");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                "iso", "static", null);
        // java.net.URI preserves the scheme's case, so a case-sensitive equals
        // would pick ws for an HTTPS endpoint; the relay must map it to wss.
        RuntimeLease lease = new RuntimeLease("runtime-1",
                URI.create("HTTPS://secure.example:443"), "token", "lease-1", 7);
        RuntimeBindingRecord httpsBinding = new RuntimeBindingRecord("binding-1",
                request, 1, RuntimeBindingRecord.State.READY, lease, false, null,
                null, 0, 1, Instant.now(), Instant.now());
        WebSocketSession browser = mock(WebSocketSession.class);
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(TerminalRelayHandshakeInterceptor.BINDING_ATTRIBUTE, httpsBinding);
        attributes.put(TerminalRelayHandshakeInterceptor.SESSION_ATTRIBUTE, "session-a");
        attributes.put(TerminalRelayHandshakeInterceptor.TERMINAL_ATTRIBUTE, "term-1");
        when(browser.getAttributes()).thenReturn(attributes);
        when(browser.isOpen()).thenReturn(true);
        TerminalRelayHandler handler = new TerminalRelayHandler(broker, client);

        handler.afterConnectionEstablished(browser);

        assertThat(uriRef.get().getScheme()).isEqualTo("wss");
        assertThat(uriRef.get().getRawAuthority()).isEqualTo("secure.example:443");
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
