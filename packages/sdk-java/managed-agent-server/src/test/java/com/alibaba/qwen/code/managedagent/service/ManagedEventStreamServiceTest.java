package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

class ManagedEventStreamServiceTest {
    private static final SessionRecord SESSION = new SessionRecord("tenant",
            "session", "qwen-code", null, "ACTIVE", null, null, 0,
            2, 1, 1, null, 1);

    @ParameterizedTest
    @CsvSource({"true,true", "true,false", "false,true", "false,false"})
    void revocationStopsBeforeNextEvent(boolean webShell, boolean reconcile)
            throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, null, registry);
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code",
                null, "ACTIVE", null, null, 0, 2, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1));
        when(store.requireSession("tenant", "session")).thenReturn(session);
        AtomicBoolean revoked = new AtomicBoolean();
        when(registry.canRead("tenant", "actor", "ws-a"))
                .thenAnswer(ignored -> !revoked.get());
        List<EventRecord> records = List.of(event(1, false), event(2, true));
        CountDownLatch initialRead = new CountDownLatch(1);
        when(store.findEvents("tenant", "session", 0, 100))
                .thenAnswer(ignored -> {
                    initialRead.countDown();
                    return reconcile ? records : List.of();
                });
        AtomicInteger sent = new AtomicInteger();
        AtomicBoolean failed = new AtomicBoolean();
        CountDownLatch stopped = new CountDownLatch(1);
        SseEmitter emitter = new SseEmitter() {
            @Override
            public void send(SseEventBuilder builder) {
                sent.incrementAndGet();
                revoked.set(true);
            }

            @Override
            public void complete() {
                stopped.countDown();
            }

            @Override
            public void completeWithError(Throwable error) {
                failed.set(true);
                stopped.countDown();
            }
        };
        SessionEventHub hub = new SessionEventHub();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        ManagedEventStreamService service = streamService(agentService, hub,
                executor, emitter);
        try {
            if (webShell) {
                service.webShellStream("tenant", "actor", "session", 0);
            } else {
                service.publicStream("tenant", "actor", "session", 0);
            }
            assertThat(initialRead.await(2, TimeUnit.SECONDS)).isTrue();
            if (!reconcile) {
                hub.publish(records);
            }
            assertThat(stopped.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(sent.get()).isEqualTo(1);
            assertThat(failed).isFalse();
        } finally {
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @ParameterizedTest
    @CsvSource({"true,true", "true,false", "false,true", "false,false"})
    void deliversDeletionAndClosesWithoutAnotherPoll(boolean webShell,
            boolean reconcile) throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, null, mock(ManagedWorkspaceRegistry.class));
        when(store.requireSession("tenant", "session")).thenReturn(SESSION);
        List<EventRecord> records = List.of(event(1, false),
                new EventRecord("tenant", "session", 2, "event-2", "turn",
                        "turn.completed", java.util.Map.of(), true, "source-2", 1),
                event(3, true));
        CountDownLatch initialRead = new CountDownLatch(1);
        when(store.findEvents("tenant", "session", 0, 100)).thenAnswer(ignored -> {
            initialRead.countDown();
            return reconcile ? records : List.of();
        });
        AtomicInteger sent = new AtomicInteger();
        AtomicBoolean failed = new AtomicBoolean();
        CountDownLatch stopped = new CountDownLatch(1);
        SseEmitter emitter = new SseEmitter() {
            @Override
            public void send(SseEventBuilder builder) {
                sent.incrementAndGet();
                when(store.requireSession("tenant", "session")).thenReturn(
                        new SessionRecord("tenant", "session", "qwen-code",
                                null, "DELETED", null, null, 0,
                                2, 1, 1, 1L, 2));
            }

            @Override
            public void complete() {
                stopped.countDown();
            }

            @Override
            public void completeWithError(Throwable error) {
                failed.set(true);
                stopped.countDown();
            }
        };
        SessionEventHub hub = new SessionEventHub();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        ManagedEventStreamService service = streamService(agentService, hub,
                executor, emitter);
        try {
            if (webShell) {
                service.webShellStream("tenant", null, "session", 0);
            } else {
                service.publicStream("tenant", null, "session", 0);
            }
            assertThat(initialRead.await(2, TimeUnit.SECONDS)).isTrue();
            if (!reconcile) {
                hub.publish(records);
            }
            assertThat(stopped.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(sent.get()).isEqualTo(3);
            assertThat(failed).isFalse();
            executor.shutdown();
            assertThat(executor.awaitTermination(1, TimeUnit.SECONDS)).isTrue();
        } finally {
            executor.shutdownNow();
        }
    }

    private static EventRecord event(long sequence, boolean terminal) {
        return new EventRecord("tenant", "session", sequence,
                "event-" + sequence, null,
                terminal ? "session.deleted" : "session.created",
                java.util.Map.of("sessionId", "session"), terminal,
                "source-" + sequence, 1);
    }

    private static ManagedEventStreamService streamService(
            ManagedAgentService agentService, SessionEventHub hub,
            ExecutorService executor, SseEmitter emitter) {
        return new ManagedEventStreamService(agentService, hub, executor,
                new ManagedAgentProperties()) {
            @Override
            SseEmitter emitter() {
                return emitter;
            }
        };
    }

    @Test
    void pushesCommittedEventsWithoutWaitingForReconciliation()
            throws Exception {
        ManagedAgentService agentService = mock(ManagedAgentService.class);
        when(agentService.requireReadableSession("tenant", null, "session"))
                .thenReturn(SESSION);
        CountDownLatch initialRead = new CountDownLatch(1);
        when(agentService.streamEvents(SESSION, 0))
                .thenAnswer(ignored -> {
                    initialRead.countDown();
                    return List.of();
                });
        EventRecord record = new EventRecord("tenant", "session", 1,
                "event-1", "turn-1", "item.output_text.delta",
                java.util.Map.of("text", "hello"), false, "source-1", 1);
        WebShellEvent webEvent = new WebShellEvent(1, "event-1", "session",
                "turn-1", "item.output_text.delta", 1,
                java.util.Map.of("text", "hello"), false);
        when(agentService.webShellEvent(record)).thenReturn(webEvent);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getEvents().setPollInterval(Duration.ofSeconds(5));
        properties.getEvents().setHeartbeatInterval(Duration.ofSeconds(30));
        SessionEventHub eventHub = new SessionEventHub();
        DisconnectingEmitter emitter = new DisconnectingEmitter();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        ManagedEventStreamService service = new ManagedEventStreamService(
                agentService, eventHub, executor, properties) {
            @Override
            SseEmitter emitter() {
                return emitter;
            }
        };

        service.webShellStream("tenant", null, "session", 0);
        assertThat(initialRead.await(1, TimeUnit.SECONDS)).isTrue();
        eventHub.publish(List.of(record));

        assertThat(emitter.sendAttempt.await(1, TimeUnit.SECONDS)).isTrue();
        verify(agentService, times(1)).streamEvents(SESSION, 0);
        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
    }

    @Test
    void treatsClientDisconnectAsACompletedStream() throws Exception {
        ManagedAgentService agentService = mock(ManagedAgentService.class);
        when(agentService.requireReadableSession("tenant", null, "session"))
                .thenReturn(SESSION);
        when(agentService.streamEvents(SESSION, 0))
                .thenReturn(List.of());
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getEvents().setHeartbeatInterval(Duration.ZERO);
        DisconnectingEmitter emitter = new DisconnectingEmitter();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        ManagedEventStreamService service = new ManagedEventStreamService(
                agentService, new SessionEventHub(), executor, properties) {
            @Override
            SseEmitter emitter() {
                return emitter;
            }
        };

        service.webShellStream("tenant", null, "session", 0);

        assertThat(emitter.sendAttempt.await(5, TimeUnit.SECONDS)).isTrue();
        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        assertThat(emitter.completedWithError).isFalse();
    }

    private static final class DisconnectingEmitter extends SseEmitter {
        private final CountDownLatch sendAttempt = new CountDownLatch(1);
        private final AtomicBoolean completedWithError = new AtomicBoolean();

        @Override
        public void send(SseEventBuilder builder) throws IOException {
            sendAttempt.countDown();
            throw new IOException("client disconnected");
        }

        @Override
        public void completeWithError(Throwable error) {
            completedWithError.set(true);
        }
    }
}
