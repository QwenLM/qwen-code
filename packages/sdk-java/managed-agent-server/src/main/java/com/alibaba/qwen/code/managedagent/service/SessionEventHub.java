package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
public class SessionEventHub implements CommittedEventPublisher {
    private static final int CAPACITY = 512;
    private final Map<SessionKey, SessionBuffer> buffers =
            new ConcurrentHashMap<>();

    @Override
    public void publish(List<EventRecord> events) {
        if (events.isEmpty()) {
            return;
        }
        EventRecord first = events.get(0);
        SessionBuffer buffer = buffers.get(new SessionKey(first.tenantId(),
                first.sessionId()));
        if (buffer != null) {
            buffer.publish(events);
        }
    }

    public Subscription subscribe(String tenantId, String sessionId) {
        SessionKey key = new SessionKey(tenantId, sessionId);
        SessionBuffer buffer = buffers.compute(key, (ignored, current) -> {
            SessionBuffer result = current == null
                    ? new SessionBuffer() : current;
            result.retain();
            return result;
        });
        return new Subscription(key, buffer);
    }

    public record Delivery(List<EventRecord> events, boolean overflowed) {
    }

    public final class Subscription implements AutoCloseable {
        private final SessionKey key;
        private final SessionBuffer buffer;
        private boolean closed;

        private Subscription(SessionKey key, SessionBuffer buffer) {
            this.key = key;
            this.buffer = buffer;
        }

        public Delivery await(long afterSequence, Duration timeout)
                throws InterruptedException {
            if (closed) {
                return new Delivery(List.of(), false);
            }
            return buffer.await(afterSequence, timeout);
        }

        @Override
        public void close() {
            if (closed) {
                return;
            }
            closed = true;
            buffers.computeIfPresent(key, (ignored, current) ->
                    current == buffer && current.release() ? null : current);
        }
    }

    private static final class SessionBuffer {
        private final NavigableMap<Long, EventRecord> events =
                new TreeMap<>();
        private int references;
        private long droppedThrough;

        synchronized void retain() {
            references++;
        }

        synchronized boolean release() {
            references--;
            return references == 0;
        }

        synchronized void publish(List<EventRecord> committed) {
            for (EventRecord event : committed) {
                events.put(event.sequence(), event);
                if (events.size() > CAPACITY) {
                    droppedThrough = events.pollFirstEntry().getKey();
                }
            }
            notifyAll();
        }

        synchronized Delivery await(long afterSequence, Duration timeout)
                throws InterruptedException {
            if (!hasAfter(afterSequence)) {
                long millis = timeout.toMillis();
                int nanos = (int) (timeout.minusMillis(millis).toNanos());
                wait(millis, nanos);
            }
            boolean overflowed = afterSequence < droppedThrough;
            List<EventRecord> available = new ArrayList<>();
            if (!overflowed) {
                long expected = afterSequence + 1;
                for (EventRecord event : events.tailMap(expected, true)
                        .values()) {
                    if (event.sequence() != expected) {
                        overflowed = true;
                        available.clear();
                        break;
                    }
                    available.add(event);
                    expected++;
                }
            }
            return new Delivery(List.copyOf(available), overflowed);
        }

        private boolean hasAfter(long sequence) {
            return droppedThrough > sequence
                    || !events.isEmpty()
                    && events.lastKey() > sequence;
        }
    }

    private record SessionKey(String tenantId, String sessionId) {
    }
}
