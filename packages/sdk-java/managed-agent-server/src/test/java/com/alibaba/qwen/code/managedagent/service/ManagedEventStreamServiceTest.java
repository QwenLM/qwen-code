package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
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
import org.springframework.http.HttpStatus;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

class ManagedEventStreamServiceTest {
    private static final SessionRecord SESSION = new SessionRecord("tenant",
            "session", "qwen-code", null, "ACTIVE", null, null, 0,
            2, 1, 1, null, 1);

    @Test
    void rejectsNegativeReconciliationCursorBeforeReadingEvents() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, mock(ManagedWorkspaceRegistry.class));
        assertThatThrownBy(() -> agentService.streamEvents(SESSION, -1))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(error.getCode()).isEqualTo("invalid_event_cursor");
                });
        verifyNoInteractions(store);
    }

    // A zero recheck window re-verifies the grant before every event.
    @ParameterizedTest
    @CsvSource({"true,true", "true,false", "false,true", "false,false"})
    void revocationStopsBeforeNextEvent(boolean webShell, boolean reconcile)
            throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, registry);
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code",
                null, null, "ACTIVE", null, null, 0, 2, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1), "yolo",
                        "hosted-workspace-files/1");
        when(store.requireSession("tenant", "session")).thenReturn(session);
        AtomicBoolean revoked = new AtomicBoolean();
        when(registry.canRead("tenant", "actor", "ws-a"))
                .thenAnswer(ignored -> !revoked.get());
        List<EventRecord> records = List.of(event(1, false), event(2, true));
        CountDownLatch initialRead = new CountDownLatch(1);
        when(store.findReplayWindow("tenant", "session"))
                .thenReturn(new ReplayWindow(0, 0));
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
                executor, emitter, Duration.ZERO);
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

    // Within the recheck window the stream reuses the verified grant, so a
    // revocation lands at the window's end instead of before the next event.
    @ParameterizedTest
    @CsvSource({"true,true", "true,false", "false,true", "false,false"})
    void readGrantIsRecheckedOnAWindow(boolean webShell, boolean reconcile)
            throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, registry);
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code",
                null, null, "ACTIVE", null, null, 0, 2, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1), "yolo", null);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        AtomicBoolean revoked = new AtomicBoolean();
        AtomicInteger grantChecks = new AtomicInteger();
        when(registry.canRead("tenant", "actor", "ws-a"))
                .thenAnswer(ignored -> {
                    grantChecks.incrementAndGet();
                    return !revoked.get();
                });
        List<EventRecord> records = List.of(event(1, false), event(2, true));
        CountDownLatch initialRead = new CountDownLatch(1);
        when(store.findReplayWindow("tenant", "session"))
                .thenReturn(new ReplayWindow(0, 0));
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
                executor, emitter, Duration.ofSeconds(60));
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
            // Both events arrive: the window defers the revocation, and the
            // terminal event still ends the stream.
            assertThat(sent.get()).isEqualTo(2);
            assertThat(failed).isFalse();
            // Admission plus the first in-loop check; the window covers the rest.
            assertThat(grantChecks.get()).isEqualTo(2);
        } finally {
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    // A revocation lands once the recheck window expires: the event after
    // the window is no longer delivered and the stream completes.
    @ParameterizedTest
    @CsvSource({"true", "false"})
    void revocationTakesEffectWhenTheWindowExpires(boolean webShell)
            throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, registry);
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code",
                null, null, "ACTIVE", null, null, 0, 2, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1), "yolo", null);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        AtomicBoolean revoked = new AtomicBoolean();
        AtomicInteger grantChecks = new AtomicInteger();
        when(registry.canRead("tenant", "actor", "ws-a"))
                .thenAnswer(ignored -> {
                    grantChecks.incrementAndGet();
                    return !revoked.get();
                });
        CountDownLatch initialRead = new CountDownLatch(1);
        when(store.findReplayWindow("tenant", "session"))
                .thenReturn(new ReplayWindow(0, 0));
        when(store.findEvents("tenant", "session", 0, 100))
                .thenAnswer(ignored -> {
                    initialRead.countDown();
                    return List.of(event(1, false));
                });
        AtomicInteger sent = new AtomicInteger();
        AtomicBoolean failed = new AtomicBoolean();
        CountDownLatch delivered = new CountDownLatch(1);
        CountDownLatch stopped = new CountDownLatch(1);
        SseEmitter emitter = new SseEmitter() {
            @Override
            public void send(SseEventBuilder builder) {
                sent.incrementAndGet();
                delivered.countDown();
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
                executor, emitter, Duration.ofMillis(500));
        try {
            if (webShell) {
                service.webShellStream("tenant", "actor", "session", 0);
            } else {
                service.publicStream("tenant", "actor", "session", 0);
            }
            assertThat(delivered.await(2, TimeUnit.SECONDS)).isTrue();
            revoked.set(true);
            // Let the window lapse, then publish: the recheck must observe
            // the revocation instead of delivering the event.
            Thread.sleep(1000);
            hub.publish(List.of(event(2, false)));
            assertThat(stopped.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(sent.get()).isEqualTo(1);
            assertThat(failed).isFalse();
            // Admission, the first in-loop check, and the recheck. The exact
            // count is what distinguishes the window from per-event checks;
            // it assumes no >500ms stall inside one event's microsecond-scale
            // processing gap.
            assertThat(grantChecks.get()).isEqualTo(3);
        } finally {
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    // An idle stream's revocation is observed by the loop-head recheck:
    // nothing is published, and the stream completes at its first wake past
    // the window — closure within the interval plus one poll interval, as
    // the ReadGrant javadoc states.
    @ParameterizedTest
    @CsvSource({"true", "false"})
    void idleStreamClosesAfterRevocationAtTheNextWake(boolean webShell)
            throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, registry);
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code",
                null, null, "ACTIVE", null, null, 0, 2, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1), "yolo", null);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        AtomicBoolean revoked = new AtomicBoolean();
        AtomicInteger grantChecks = new AtomicInteger();
        when(registry.canRead("tenant", "actor", "ws-a"))
                .thenAnswer(ignored -> {
                    grantChecks.incrementAndGet();
                    return !revoked.get();
                });
        when(store.findReplayWindow("tenant", "session"))
                .thenReturn(new ReplayWindow(0, 0));
        when(store.findEvents("tenant", "session", 0, 100))
                .thenReturn(List.of());
        AtomicInteger sent = new AtomicInteger();
        AtomicBoolean failed = new AtomicBoolean();
        CountDownLatch stopped = new CountDownLatch(1);
        SseEmitter emitter = new SseEmitter() {
            @Override
            public void send(SseEventBuilder builder) {
                sent.incrementAndGet();
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
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getEvents().setReadGrantRecheckInterval(
                Duration.ofMillis(500));
        properties.getEvents().setPollInterval(Duration.ofSeconds(1));
        properties.getEvents().setHeartbeatInterval(Duration.ofSeconds(30));
        ManagedEventStreamService service = new ManagedEventStreamService(
                agentService, hub, executor, properties) {
            @Override
            SseEmitter emitter() {
                return emitter;
            }
        };
        try {
            if (webShell) {
                service.webShellStream("tenant", "actor", "session", 0);
            } else {
                service.publicStream("tenant", "actor", "session", 0);
            }
            // Admission plus the first in-loop check arm the window; revoke
            // only after both, so closure must come from a LATER recheck.
            org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(2))
                    .until(() -> grantChecks.get() == 2);
            revoked.set(true);
            assertThat(stopped.await(4, TimeUnit.SECONDS)).isTrue();
            assertThat(sent.get()).isZero();
            assertThat(failed).isFalse();
            assertThat(grantChecks.get()).isGreaterThanOrEqualTo(3);
        } finally {
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS))
                    .isTrue();
        }
    }

    // A successful recheck re-anchors the window: the steady-state grant
    // check rate stays bounded for the stream's whole life.
    @Test
    void readGrantRecheckReanchorsAfterEachSuccess() throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, registry);
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code",
                null, null, "ACTIVE", null, null, 0, 2, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1), "yolo", null);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        AtomicInteger grantChecks = new AtomicInteger();
        when(registry.canRead("tenant", "actor", "ws-a"))
                .thenAnswer(ignored -> {
                    grantChecks.incrementAndGet();
                    return true;
                });
        CountDownLatch initialRead = new CountDownLatch(1);
        CountDownLatch delivered = new CountDownLatch(1);
        when(store.findReplayWindow("tenant", "session"))
                .thenReturn(new ReplayWindow(0, 0));
        when(store.findEvents("tenant", "session", 0, 100))
                .thenAnswer(ignored -> {
                    initialRead.countDown();
                    return List.of(event(1, false));
                });
        AtomicInteger sent = new AtomicInteger();
        AtomicBoolean failed = new AtomicBoolean();
        CountDownLatch stopped = new CountDownLatch(1);
        SseEmitter emitter = new SseEmitter() {
            @Override
            public void send(SseEventBuilder builder) {
                sent.incrementAndGet();
                delivered.countDown();
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
                executor, emitter, Duration.ofMillis(500));
        try {
            service.publicStream("tenant", "actor", "session", 0);
            assertThat(delivered.await(2, TimeUnit.SECONDS)).isTrue();
            // Let the first window lapse; the next event's recheck must
            // re-anchor the window over the remaining events. The sleep
            // stays below the 5s poll interval cap on Subscription.await.
            Thread.sleep(1000);
            hub.publish(List.of(event(2, false), event(3, false),
                    event(4, true)));
            assertThat(stopped.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(sent.get()).isEqualTo(4);
            assertThat(failed).isFalse();
            // Admission, the first in-loop check, and the one re-anchoring
            // recheck; an anchor-once window would check before each event.
            assertThat(grantChecks.get()).isEqualTo(3);
        } finally {
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    // The shipped 5-second default covers a quick second delivery: the
    // second event arrives under the first check's window. A zero default
    // would recheck per event; the value itself is pinned in
    // ManagedAgentPropertiesTest.
    @Test
    void readGrantRechecksOnTheDefaultWindow() throws Exception {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
        ManagedAgentService agentService = new ManagedAgentService(store,
                null, null, null, registry);
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code",
                null, null, "ACTIVE", null, null, 0, 2, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1), "yolo", null);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        AtomicInteger grantChecks = new AtomicInteger();
        when(registry.canRead("tenant", "actor", "ws-a"))
                .thenAnswer(ignored -> {
                    grantChecks.incrementAndGet();
                    return true;
                });
        List<EventRecord> records = List.of(event(1, false), event(2, true));
        CountDownLatch initialRead = new CountDownLatch(1);
        when(store.findReplayWindow("tenant", "session"))
                .thenReturn(new ReplayWindow(0, 0));
        when(store.findEvents("tenant", "session", 0, 100))
                .thenAnswer(ignored -> {
                    initialRead.countDown();
                    return List.of();
                });
        AtomicInteger sent = new AtomicInteger();
        AtomicBoolean failed = new AtomicBoolean();
        CountDownLatch stopped = new CountDownLatch(1);
        SseEmitter emitter = new SseEmitter() {
            @Override
            public void send(SseEventBuilder builder) {
                sent.incrementAndGet();
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
            service.publicStream("tenant", "actor", "session", 0);
            assertThat(initialRead.await(2, TimeUnit.SECONDS)).isTrue();
            hub.publish(records);
            assertThat(stopped.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(sent.get()).isEqualTo(2);
            assertThat(failed).isFalse();
            // Admission plus the first in-loop check; the default window
            // covers the second event.
            assertThat(grantChecks.get()).isEqualTo(2);
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
                null, null, null, mock(ManagedWorkspaceRegistry.class));
        when(store.requireSession("tenant", "session")).thenReturn(SESSION);
        List<EventRecord> records = List.of(event(1, false),
                new EventRecord("tenant", "session", 2, "event-2", "turn",
                        "turn.completed", java.util.Map.of(), true, "source-2", 1),
                event(3, true));
        CountDownLatch initialRead = new CountDownLatch(1);
        when(store.findReplayWindow("tenant", "session"))
                .thenReturn(new ReplayWindow(0, 0));
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
        return streamService(agentService, hub, executor, emitter, null);
    }

    private static ManagedEventStreamService streamService(
            ManagedAgentService agentService, SessionEventHub hub,
            ExecutorService executor, SseEmitter emitter,
            Duration readGrantRecheckInterval) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        if (readGrantRecheckInterval != null) {
            properties.getEvents().setReadGrantRecheckInterval(
                    readGrantRecheckInterval);
        }
        return new ManagedEventStreamService(agentService, hub, executor,
                properties) {
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
        WebShellEvent webEvent = new WebShellEvent(1, 1, 1, "event-1",
                "session", "turn-1", null, null, "item.output_text.delta", 1,
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
