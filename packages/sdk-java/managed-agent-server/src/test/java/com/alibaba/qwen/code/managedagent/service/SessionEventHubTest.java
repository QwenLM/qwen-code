package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

class SessionEventHubTest {
    @Test
    void returnsCommittedEventsInSequenceOrder() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        try (SessionEventHub.Subscription subscription = hub.subscribe(
                "tenant", "session")) {
            hub.publish(List.of(event(2)));
            hub.publish(List.of(event(1)));

            SessionEventHub.Delivery delivery = subscription.await(0,
                    Duration.ofMillis(10));

            assertThat(delivery.overflowed()).isFalse();
            assertThat(delivery.events()).extracting(EventRecord::sequence)
                    .containsExactly(1L, 2L);
        }
    }

    @Test
    void requestsDurableReplayWhenASequenceIsMissing() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        try (SessionEventHub.Subscription subscription = hub.subscribe(
                "tenant", "session")) {
            hub.publish(List.of(event(2)));

            SessionEventHub.Delivery delivery = subscription.await(0,
                    Duration.ofMillis(10));

            assertThat(delivery.overflowed()).isTrue();
            assertThat(delivery.events()).isEmpty();
        }
    }

    @Test
    void awaitPropagatesInterruptionLikeObjectWait() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        try (SessionEventHub.Subscription subscription = hub.subscribe(
                "tenant", "session")) {
            AtomicBoolean interrupted = new AtomicBoolean();
            Thread waiter = Thread.ofVirtual().start(() -> {
                try {
                    subscription.await(0, Duration.ofMinutes(5));
                } catch (InterruptedException expected) {
                    interrupted.set(true);
                    Thread.currentThread().interrupt();
                }
            });
            // Let the waiter park inside await before interrupting it.
            Thread.sleep(500);
            waiter.interrupt();
            waiter.join(10_000);

            assertThat(waiter.isAlive()).isFalse();
            assertThat(interrupted).isTrue();
        }
    }

    private static EventRecord event(long sequence) {
        return new EventRecord("tenant", "session", sequence,
                "event-" + sequence, "turn", "type", Map.of(), false,
                "source-" + sequence, 1);
    }
}
