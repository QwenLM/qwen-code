package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.EventProjectionStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionKey;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Wakes this instance's event streams for events another control-plane
 * instance committed. The hub only hears this instance's own commits, so
 * every tick reads the public event tail of each locally subscribed Session
 * in one query and tells the hub about every tail that moved; a stream then
 * re-reads the store within one tick instead of its poll interval.
 */
@Component
public class EventTailPoller {
    static final long INTERVAL_MILLIS = 200;
    private static final Logger LOG = LoggerFactory.getLogger(EventTailPoller.class);

    private final EventProjectionStore store;
    private final SessionEventHub hub;
    // Touched only by the polling thread.
    private final Map<SessionKey, Long> tails = new HashMap<>();
    private final ScheduledExecutorService poller =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "managed-event-tail-poller");
                thread.setDaemon(true);
                return thread;
            });

    public EventTailPoller(EventProjectionStore store, SessionEventHub hub) {
        this.store = store;
        this.hub = hub;
    }

    @PostConstruct
    void start() {
        poller.scheduleWithFixedDelay(this::poll, INTERVAL_MILLIS,
                INTERVAL_MILLIS, TimeUnit.MILLISECONDS);
    }

    @PreDestroy
    void close() {
        poller.shutdownNow();
    }

    void poll() {
        // A throw would cancel every later tick; streams fall back to their
        // own poll interval until the store answers again.
        try {
            Set<SessionKey> subscribed = hub.subscribedSessions();
            tails.keySet().retainAll(subscribed);
            if (subscribed.isEmpty()) {
                return;
            }
            store.findEventTails(subscribed).forEach((key, tail) -> {
                Long previous = tails.put(key, tail);
                if (previous == null || previous < tail) {
                    hub.notifyCommitted(key, tail);
                }
            });
        } catch (RuntimeException unavailable) {
            LOG.debug("Event tail poll failed: {}", unavailable.getClass().getSimpleName());
        }
    }
}
