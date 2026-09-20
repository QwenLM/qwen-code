package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.SessionEventHub.Delivery;
import com.alibaba.qwen.code.managedagent.service.SessionEventHub.Subscription;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
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
    private final SessionEventHub eventHub;
    private final ExecutorService executor;
    private final Duration reconciliationInterval;
    private final Duration heartbeatInterval;
    private final Duration streamTimeout;

    public ManagedEventStreamService(ManagedAgentService agentService,
            SessionEventHub eventHub, ExecutorService executor,
            ManagedAgentProperties properties) {
        this.agentService = agentService;
        this.eventHub = eventHub;
        this.executor = executor;
        this.reconciliationInterval = properties.getEvents()
                .getPollInterval();
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
        try (Subscription subscription = eventHub.subscribe(tenantId,
                sessionId)) {
            boolean reconcile = true;
            while (!closed.get()) {
                if (reconcile) {
                    List<PublicEvent> events = agentService.publicEvents(
                            tenantId, sessionId, sequence, 100);
                    for (PublicEvent event : events) {
                        emitter.send(SseEmitter.event()
                                .id(Long.toString(event.sequence()))
                                .name(event.type()).data(event));
                        sequence = event.sequence();
                    }
                    if (events.size() == 100) {
                        continue;
                    }
                    reconcile = false;
                }
                Delivery delivery = subscription.await(sequence,
                        waitDuration(heartbeatAt));
                if (delivery.overflowed()) {
                    reconcile = true;
                    continue;
                }
                for (EventRecord event : delivery.events()) {
                    PublicEvent publicEvent = agentService.publicEvent(event);
                    emitter.send(SseEmitter.event()
                            .id(Long.toString(publicEvent.sequence()))
                            .name(publicEvent.type()).data(publicEvent));
                    sequence = publicEvent.sequence();
                }
                if (delivery.events().isEmpty()) {
                    reconcile = true;
                    heartbeatAt = heartbeat(emitter, heartbeatAt);
                }
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
        try (Subscription subscription = eventHub.subscribe(tenantId,
                sessionId)) {
            boolean reconcile = true;
            while (!closed.get()) {
                if (reconcile) {
                    List<WebShellEvent> events = agentService.webShellEvents(
                            tenantId, sessionId, sequence, 100);
                    for (WebShellEvent event : events) {
                        emitter.send(SseEmitter.event()
                                .id(Long.toString(event.sequence()))
                                .name(event.type()).data(event));
                        sequence = event.sequence();
                    }
                    if (events.size() == 100) {
                        continue;
                    }
                    reconcile = false;
                }
                Delivery delivery = subscription.await(sequence,
                        waitDuration(heartbeatAt));
                if (delivery.overflowed()) {
                    reconcile = true;
                    continue;
                }
                for (EventRecord event : delivery.events()) {
                    WebShellEvent webEvent = agentService.webShellEvent(event);
                    emitter.send(SseEmitter.event()
                            .id(Long.toString(webEvent.sequence()))
                            .name(webEvent.type()).data(webEvent));
                    sequence = webEvent.sequence();
                }
                if (delivery.events().isEmpty()) {
                    reconcile = true;
                    heartbeatAt = heartbeat(emitter, heartbeatAt);
                }
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

    private Duration waitDuration(long heartbeatAt) {
        Duration untilHeartbeat = Duration.ofNanos(Math.max(1,
                heartbeatAt - System.nanoTime()));
        return untilHeartbeat.compareTo(reconciliationInterval) < 0
                ? untilHeartbeat : reconciliationInterval;
    }

    private long heartbeat(SseEmitter emitter, long heartbeatAt)
            throws IOException {
        long now = System.nanoTime();
        if (now >= heartbeatAt) {
            emitter.send(SseEmitter.event().comment("keepalive"));
            heartbeatAt = now + heartbeatInterval.toNanos();
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
