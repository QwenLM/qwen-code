package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Service
public class ManagedEventStreamService {
    private final ManagedAgentService agentService;
    private final ExecutorService executor;
    private final Duration pollInterval;
    private final Duration heartbeatInterval;
    private final Duration streamTimeout;

    public ManagedEventStreamService(ManagedAgentService agentService,
            ExecutorService executor, ManagedAgentProperties properties) {
        this.agentService = agentService;
        this.executor = executor;
        this.pollInterval = properties.getEvents().getPollInterval();
        this.heartbeatInterval = properties.getEvents()
                .getHeartbeatInterval();
        this.streamTimeout = properties.getEvents().getStreamTimeout();
    }

    public SseEmitter publicStream(String tenantId, String sessionId,
            long afterSequence) {
        agentService.lastSequence(tenantId, sessionId);
        SseEmitter emitter = emitter();
        executor.execute(() -> streamPublic(emitter, tenantId, sessionId,
                afterSequence));
        return emitter;
    }

    public SseEmitter webShellStream(String tenantId, String sessionId,
            long afterSequence) {
        agentService.lastSequence(tenantId, sessionId);
        SseEmitter emitter = emitter();
        executor.execute(() -> streamWebShell(emitter, tenantId, sessionId,
                afterSequence));
        return emitter;
    }

    SseEmitter emitter() {
        return new SseEmitter(streamTimeout.toMillis());
    }

    private void streamPublic(SseEmitter emitter, String tenantId,
            String sessionId, long initialSequence) {
        AtomicBoolean closed = callbacks(emitter);
        long sequence = initialSequence;
        long heartbeatAt = System.nanoTime()
                + heartbeatInterval.toNanos();
        try {
            while (!closed.get()) {
                List<PublicEvent> events = agentService.publicEvents(tenantId,
                        sessionId, sequence, 100);
                for (PublicEvent event : events) {
                    emitter.send(SseEmitter.event()
                            .id(Long.toString(event.sequence()))
                            .name(event.type()).data(event));
                    sequence = event.sequence();
                }
                heartbeatAt = idle(emitter, events.isEmpty(), heartbeatAt);
            }
        } catch (IOException error) {
            closed.set(true);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            completeWithError(emitter, closed, error);
        } catch (RuntimeException error) {
            completeWithError(emitter, closed, error);
        }
    }

    private void streamWebShell(SseEmitter emitter, String tenantId,
            String sessionId, long initialSequence) {
        AtomicBoolean closed = callbacks(emitter);
        long sequence = initialSequence;
        long heartbeatAt = System.nanoTime()
                + heartbeatInterval.toNanos();
        try {
            while (!closed.get()) {
                List<WebShellEvent> events = agentService.webShellEvents(
                        tenantId, sessionId, sequence, 100);
                for (WebShellEvent event : events) {
                    emitter.send(SseEmitter.event()
                            .id(Long.toString(event.sequence()))
                            .name(event.type()).data(event));
                    sequence = event.sequence();
                }
                heartbeatAt = idle(emitter, events.isEmpty(), heartbeatAt);
            }
        } catch (IOException error) {
            closed.set(true);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            completeWithError(emitter, closed, error);
        } catch (RuntimeException error) {
            completeWithError(emitter, closed, error);
        }
    }

    private long idle(SseEmitter emitter, boolean idle, long heartbeatAt)
            throws IOException, InterruptedException {
        long now = System.nanoTime();
        if (now >= heartbeatAt) {
            emitter.send(SseEmitter.event().comment("keepalive"));
            heartbeatAt = now + heartbeatInterval.toNanos();
        }
        if (idle) {
            Thread.sleep(pollInterval.toMillis());
        }
        return heartbeatAt;
    }

    private static AtomicBoolean callbacks(SseEmitter emitter) {
        AtomicBoolean closed = new AtomicBoolean();
        emitter.onCompletion(() -> closed.set(true));
        emitter.onTimeout(() -> closed.set(true));
        emitter.onError(error -> closed.set(true));
        return closed;
    }

    private static void completeWithError(SseEmitter emitter,
            AtomicBoolean closed, Throwable error) {
        if (closed.compareAndSet(false, true)) {
            emitter.completeWithError(error);
        }
    }
}
