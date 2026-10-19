package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.AttachedSession;
import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The owner-side half of the §11 routing decision (design
 * 2026-10-04-managed-agent-event-transport, phase MQ2c): this node's owner
 * consumer subscribes to the LiteTopic of every Session the node holds and
 * unsubscribes from every Session it released, so in the steady state a
 * Session's owner is the sole subscriber and dispatch lands on it.
 *
 * <p>The held set is recomputed on every tick rather than hooked into each
 * attach and detach, so a missed transition converges within one interval.
 * It starts from the Harness connector's attachments and keeps only those SQL
 * shows this node's Harness writing — an ACTIVE journal whose writer is this
 * Harness, under an unexpired lease — because an attachment is a cache entry
 * that outlives a lapsed lease or a takeover. The handoff window is accepted,
 * not hidden: until the old owner's next tick (or its broker-side inactivity)
 * removes a stale subscription, dispatch may still pick it; the old owner
 * then does no wake (the fence says another writer holds the Session) and
 * acknowledges; the new owner never receives that notice, and needs no MQ
 * delivery for it — its Harness runs the wake input from the journal.
 * Subscription is fallible (a quota may refuse it), so a refused call is
 * retried on the next tick.
 */
public class OwnerSubscriptions {
    private static final Logger LOG = LoggerFactory.getLogger(
            OwnerSubscriptions.class);

    private final HarnessConnector harness;
    private final TransportConsumerStore store;
    private volatile LitePushConsumer consumer;

    public OwnerSubscriptions(HarnessConnector harness,
            TransportConsumerStore store) {
        this.harness = harness;
        this.store = store;
    }

    /** Binds the owner consumer, which is built after its listener. */
    public void bind(LitePushConsumer consumer) {
        this.consumer = consumer;
    }

    /** Subscribes at once to a Session this node just activated. */
    public void subscribe(String sessionId) {
        LitePushConsumer current = consumer;
        if (current == null) {
            return;
        }
        try {
            if (!current.getLiteTopicSet().contains(sessionId)) {
                current.subscribeLite(sessionId);
            }
        } catch (Exception refused) {
            LOG.warn("owner subscription refused session={} cause={}",
                    sessionId, refused.toString());
        }
    }

    /**
     * One reconciliation tick: subscribe to every Session this node holds,
     * unsubscribe from every Session it no longer holds. Never throws, so the
     * scheduled task survives any single failure; a tick that cannot read the
     * held set changes nothing.
     */
    public void reconcile() {
        LitePushConsumer current = consumer;
        if (current == null) {
            return;
        }
        try {
            // Subscribed first: a Session activated in between is then never
            // mistaken for a released one.
            Set<String> subscribed = Set.copyOf(current.getLiteTopicSet());
            Set<String> owned = held();
            int refused = 0;
            String firstRefusal = null;
            for (String sessionId : owned) {
                if (subscribed.contains(sessionId)) {
                    continue;
                }
                try {
                    current.subscribeLite(sessionId);
                } catch (Exception failure) {
                    refused++;
                    if (firstRefusal == null) {
                        firstRefusal = "subscribe " + sessionId + ": "
                                + failure;
                    }
                }
            }
            for (String sessionId : subscribed) {
                if (owned.contains(sessionId)) {
                    continue;
                }
                try {
                    current.unsubscribeLite(sessionId);
                } catch (Exception failure) {
                    refused++;
                    if (firstRefusal == null) {
                        firstRefusal = "unsubscribe " + sessionId + ": "
                                + failure;
                    }
                }
            }
            if (refused > 0) {
                // One line per tick, however many Sessions a quota refused.
                LOG.warn("owner subscription reconcile left {} changes for the"
                        + " next tick; first: {}", refused, firstRefusal);
            }
        } catch (RuntimeException failure) {
            LOG.warn("owner subscription reconcile failed cause={}",
                    failure.toString());
        }
    }

    private Set<String> held() {
        String writer = harness.writerIdentity();
        if (writer == null) {
            // No Harness client: this node writes no journal.
            return Set.of();
        }
        Map<String, List<String>> byTenant = new HashMap<>();
        for (AttachedSession session : harness.attachedSessions()) {
            byTenant.computeIfAbsent(session.tenantId(),
                    ignored -> new ArrayList<>()).add(session.sessionId());
        }
        Set<String> held = new HashSet<>();
        for (Map.Entry<String, List<String>> tenant : byTenant.entrySet()) {
            held.addAll(store.heldBy(writer, tenant.getKey(),
                    tenant.getValue()));
        }
        return held;
    }
}
