package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

class ManagedEventStreamServiceTest {
    @Test
    void pushesCommittedEventsWithoutWaitingForReconciliation()
            throws Exception {
        ManagedAgentService agentService = mock(ManagedAgentService.class);
        CountDownLatch initialRead = new CountDownLatch(1);
        when(agentService.webShellEvents("tenant", "session", 0, 100))
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

        service.webShellStream("tenant", "session", 0);
        assertThat(initialRead.await(1, TimeUnit.SECONDS)).isTrue();
        eventHub.publish(List.of(record));

        assertThat(emitter.sendAttempt.await(1, TimeUnit.SECONDS)).isTrue();
        verify(agentService, times(1)).webShellEvents(
                "tenant", "session", 0, 100);
        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
    }

    @Test
    void treatsClientDisconnectAsACompletedStream() throws Exception {
        ManagedAgentService agentService = mock(ManagedAgentService.class);
        when(agentService.webShellEvents("tenant", "session", 0, 100))
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

        service.webShellStream("tenant", "session", 0);

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
