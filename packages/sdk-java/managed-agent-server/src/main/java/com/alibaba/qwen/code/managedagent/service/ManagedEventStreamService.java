package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionResyncRequired;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellResyncRequired;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.SessionEventHub.Delivery;
import com.alibaba.qwen.code.managedagent.service.SessionEventHub.Subscription;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Service
public class ManagedEventStreamService {
    static final String RESYNC = "agent.session.resync_required";
    // Read the Session and its Items, then resume after the Snapshot.
    static final String RESYNC_ACTION = "reload_snapshot";
    private final ManagedAgentService agentService;
    private final SessionEventHub eventHub;
    private final ExecutorService executor;
    private final Duration reconciliationInterval;
    private final Duration heartbeatInterval;
    private final Duration streamTimeout;
    private final Duration readGrantRecheckInterval;

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
        this.readGrantRecheckInterval = properties.getEvents()
                .getReadGrantRecheckInterval();
    }

    public SseEmitter publicStream(String tenantId, String actorId,
            String sessionId, long afterSequence) {
        SessionRecord session = agentService.requireReadableSession(
                tenantId, actorId, sessionId);
        SseEmitter emitter = emitter();
        executor.execute(() -> streamPublic(emitter, actorId, session,
                afterSequence));
        return emitter;
    }

    public SseEmitter webShellStream(String tenantId, String actorId,
            String sessionId, long afterSequence) {
        SessionRecord session = agentService.requireReadableSession(
                tenantId, actorId, sessionId);
        SseEmitter emitter = emitter();
        executor.execute(() -> streamWebShell(emitter, actorId, session,
                afterSequence));
        return emitter;
    }

    SseEmitter emitter() {
        return new SseEmitter(streamTimeout.toMillis());
    }

    private void streamPublic(SseEmitter emitter, String actorId,
            SessionRecord session, long initialSequence) {
        String tenantId = session.tenantId();
        String sessionId = session.sessionId();
        AtomicBoolean closed = callbacks(emitter);
        ReadGrant grant = new ReadGrant(emitter, closed, actorId, session);
        long sequence = initialSequence;
        long heartbeatAt = System.nanoTime()
                + heartbeatInterval.toNanos();
        try (Subscription subscription = eventHub.subscribe(tenantId,
                sessionId)) {
            boolean reconcile = true;
            while (!closed.get()) {
                if (!grant.stillReadable()) {
                    break;
                }
                if (reconcile) {
                    List<EventRecord> events;
                    try {
                        events = agentService.streamEvents(session, sequence);
                    } catch (ReplayCursorExpired expired) {
                        ReplayWindow window = expired.window();
                        resync(emitter, closed, new SessionResyncRequired(
                                RESYNC, sessionId, window.floorSequence(),
                                window.snapshotThroughSequence(),
                                RESYNC_ACTION));
                        break;
                    }
                    for (EventRecord record : events) {
                        PublicEvent event = agentService.publicEvent(record);
                        if (!grant.stillReadable()) {
                            break;
                        }
                        emitter.send(SseEmitter.event()
                                .id(Long.toString(event.sequence()))
                                .name(event.type()).data(event));
                        sequence = event.sequence();
                        if ("session.deleted".equals(event.type())) {
                            complete(emitter, closed);
                            break;
                        }
                    }
                    if (events.size() == ManagedAgentService.STREAM_PAGE) {
                        continue;
                    }
                    reconcile = false;
                }
                if (closed.get()) {
                    break;
                }
                Delivery delivery = subscription.await(sequence,
                        waitDuration(heartbeatAt));
                if (delivery.overflowed()) {
                    reconcile = true;
                    continue;
                }
                for (EventRecord event : delivery.events()) {
                    if (!grant.stillReadable()) {
                        break;
                    }
                    PublicEvent publicEvent = agentService.publicEvent(event);
                    emitter.send(SseEmitter.event()
                            .id(Long.toString(publicEvent.sequence()))
                            .name(publicEvent.type()).data(publicEvent));
                    sequence = publicEvent.sequence();
                    if ("session.deleted".equals(event.type())) {
                        complete(emitter, closed);
                        break;
                    }
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

    private void streamWebShell(SseEmitter emitter, String actorId,
            SessionRecord session, long initialSequence) {
        String tenantId = session.tenantId();
        String sessionId = session.sessionId();
        AtomicBoolean closed = callbacks(emitter);
        ReadGrant grant = new ReadGrant(emitter, closed, actorId, session);
        long sequence = initialSequence;
        long heartbeatAt = System.nanoTime()
                + heartbeatInterval.toNanos();
        try (Subscription subscription = eventHub.subscribe(tenantId,
                sessionId)) {
            boolean reconcile = true;
            while (!closed.get()) {
                if (!grant.stillReadable()) {
                    break;
                }
                if (reconcile) {
                    List<EventRecord> events;
                    try {
                        events = agentService.streamEvents(session, sequence);
                    } catch (ReplayCursorExpired expired) {
                        ReplayWindow window = expired.window();
                        resync(emitter, closed, new WebShellResyncRequired(
                                RESYNC, sessionId, window.floorSequence(),
                                window.snapshotThroughSequence(),
                                RESYNC_ACTION));
                        break;
                    }
                    for (EventRecord record : events) {
                        WebShellEvent event = agentService.webShellEvent(record);
                        if (!grant.stillReadable()) {
                            break;
                        }
                        emitter.send(SseEmitter.event()
                                .id(Long.toString(event.sequence()))
                                .name(event.type()).data(event));
                        sequence = event.sequence();
                        if ("session.deleted".equals(event.type())) {
                            complete(emitter, closed);
                            break;
                        }
                    }
                    if (events.size() == ManagedAgentService.STREAM_PAGE) {
                        continue;
                    }
                    reconcile = false;
                }
                if (closed.get()) {
                    break;
                }
                Delivery delivery = subscription.await(sequence,
                        waitDuration(heartbeatAt));
                if (delivery.overflowed()) {
                    reconcile = true;
                    continue;
                }
                for (EventRecord event : delivery.events()) {
                    if (!grant.stillReadable()) {
                        break;
                    }
                    WebShellEvent webEvent = agentService.webShellEvent(event);
                    emitter.send(SseEmitter.event()
                            .id(Long.toString(webEvent.sequence()))
                            .name(webEvent.type()).data(webEvent));
                    sequence = webEvent.sequence();
                    if ("session.deleted".equals(event.type())) {
                        complete(emitter, closed);
                        break;
                    }
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

    // The frame has no id, so a reconnect does not move past the events the
    // client still lacks; the client reloads the Snapshot instead.
    private static void resync(SseEmitter emitter, AtomicBoolean closed,
            Object frame) throws IOException {
        emitter.send(SseEmitter.event().name(RESYNC).data(frame));
        complete(emitter, closed);
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

    /**
     * A stream's read grant, re-verified against the database at most once
     * per recheck interval instead of before every delivered event; a
     * revocation stops event delivery within the interval, and a
     * session.deleted event still ends the stream immediately. The recheck
     * runs when the stream loop iterates, so an idle stream closes at its
     * next wake: closure takes at most the interval plus
     * events.poll-interval.
     */
    private final class ReadGrant {
        private final SseEmitter emitter;
        private final AtomicBoolean closed;
        private final String actorId;
        private final SessionRecord session;
        // MIN_VALUE, not 0: nanoTime may be negative, and a first check must
        // always run.
        private long recheckAt = Long.MIN_VALUE;

        private ReadGrant(SseEmitter emitter, AtomicBoolean closed,
                String actorId, SessionRecord session) {
            this.emitter = emitter;
            this.closed = closed;
            this.actorId = actorId;
            this.session = session;
        }

        private boolean stillReadable() {
            long now = System.nanoTime();
            if (now < recheckAt) {
                return true;
            }
            if (ManagedEventStreamService.this.stillReadable(emitter, closed,
                    actorId, session)) {
                recheckAt = now + readGrantRecheckInterval.toNanos();
                return true;
            }
            return false;
        }
    }

    private boolean stillReadable(SseEmitter emitter, AtomicBoolean closed,
            String actorId, SessionRecord session) {
        try {
            agentService.requireReadGrant(session, actorId);
            return true;
        } catch (ApiException error) {
            if (error.getStatus() != HttpStatus.NOT_FOUND) {
                throw error;
            }
            complete(emitter, closed);
            return false;
        }
    }

    private static void complete(SseEmitter emitter, AtomicBoolean closed) {
        if (closed.compareAndSet(false, true)) {
            emitter.complete();
        }
    }

    private static void completeWithError(SseEmitter emitter,
            AtomicBoolean closed, Throwable error) {
        if (closed.compareAndSet(false, true)) {
            emitter.completeWithError(error);
        }
    }
}
