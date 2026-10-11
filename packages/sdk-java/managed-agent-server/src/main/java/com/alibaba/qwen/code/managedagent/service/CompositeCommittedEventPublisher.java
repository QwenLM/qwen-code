package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.store.EventTransport;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Sole CommittedEventPublisher bean: the local hub fan-out first (unchanged
 * semantics), then each EventTransport. A transport failure must never block
 * or break local post-commit SSE, so transport calls are isolated.
 */
@Component
public class CompositeCommittedEventPublisher implements CommittedEventPublisher {
    private static final Logger LOG = LoggerFactory.getLogger(
            CompositeCommittedEventPublisher.class);

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
        hub.publish(events);
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
    }
}
