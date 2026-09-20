package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
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
    void treatsClientDisconnectAsACompletedStream() throws Exception {
        ManagedAgentService agentService = mock(ManagedAgentService.class);
        when(agentService.webShellEvents("tenant", "session", 0, 100))
                .thenReturn(List.of());
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getEvents().setHeartbeatInterval(Duration.ZERO);
        DisconnectingEmitter emitter = new DisconnectingEmitter();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        ManagedEventStreamService service = new ManagedEventStreamService(
                agentService, executor, properties) {
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
