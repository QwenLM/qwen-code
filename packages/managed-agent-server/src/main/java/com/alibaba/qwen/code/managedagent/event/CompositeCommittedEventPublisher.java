package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.session.SessionEventHub;
import jdk.jfr.Enabled;
import jdk.jfr.Event;
import jdk.jfr.EventType;
import jdk.jfr.FlightRecorder;
import jdk.jfr.Name;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Sole CommittedEventPublisher bean: the local hub fan-out first (unchanged
 * semantics), then each EventTransport. A transport failure must never block
 * or break local post-commit SSE, so transport calls are isolated.
 */
@Component
public class CompositeCommittedEventPublisher implements CommittedEventPublisher {
    private static final Logger LOG = LoggerFactory.getLogger(
            CompositeCommittedEventPublisher.class);

    private static final EventType PUBLISH_TIMING = FlightRecorder.isAvailable()
            ? EventType.getEventType(PublishTiming.class) : null;

    @Name("com.qwen.ManagedEventPublish")
    @Enabled(false)
    private static class PublishTiming extends Event {
        public String sessionId;
        public long sequence;
        public int transportCount;
        public long hubNanos;
        public long transportNanos;
    }

    private final SessionEventHub hub;
    private final List<EventTransport> transports;

    public CompositeCommittedEventPublisher(SessionEventHub hub,
            List<EventTransport> transports) {
        this.hub = hub;
        this.transports = List.copyOf(transports);
    }

    @Override
    public void publish(List<EventRecord> events) {
        if (events.isEmpty()) {
            return;
        }
        PublishTiming timing = PUBLISH_TIMING != null && PUBLISH_TIMING.isEnabled()
                ? new PublishTiming() : null;
        long started = 0;
        long hubCompleted = 0;
        if (timing != null) {
            timing.sessionId = events.getFirst().sessionId();
            timing.sequence = events.getFirst().sequence();
            timing.transportCount = transports.size();
            timing.begin();
            started = System.nanoTime();
        }
        try {
            hub.publish(events);
            if (timing != null) {
                hubCompleted = System.nanoTime();
            }
            for (EventTransport transport : transports) {
                try {
                    transport.publish(events);
                } catch (RuntimeException failure) {
                    // One batch is one session (the hub keys it off the first
                    // record), so first/last carry the replayable identity.
                    EventRecord first = events.getFirst();
                    EventRecord last = events.getLast();
                    LOG.warn("EventTransport {} dropped {} committed events"
                            + " tenant={} session={} firstSequence={}"
                            + " lastSequence={}",
                            transport.getClass().getName(), events.size(),
                            first.tenantId(), first.sessionId(),
                            first.sequence(), last.sequence(), failure);
                }
            }
        } finally {
            if (timing != null) {
                long completed = System.nanoTime();
                timing.hubNanos = (hubCompleted == 0 ? completed : hubCompleted) - started;
                timing.transportNanos = hubCompleted == 0 ? 0 : completed - hubCompleted;
                timing.end();
                timing.commit();
            }
        }
    }
}
