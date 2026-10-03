package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.time.Duration;
import java.util.List;
import java.util.Map;
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
    void evictsBeyondCapacityAndSignalsOverflowBelowTheWatermark()
            throws Exception {
        SessionEventHub hub = new SessionEventHub();
        try (SessionEventHub.Subscription subscription = hub.subscribe(
                "tenant", "session")) {
            for (long base = 1; base <= 600; base += 100) {
                List<EventRecord> batch = new java.util.ArrayList<>();
                for (long sequence = base; sequence < base + 100;
                        sequence++) {
                    batch.add(event(sequence));
                }
                hub.publish(batch);
            }

            // 600 published over CAPACITY 512: a subscriber behind the
            // watermark learns it overflowed instead of stalling forever.
            SessionEventHub.Delivery overflow = subscription.await(0,
                    Duration.ofMillis(10));
            assertThat(overflow.overflowed()).isTrue();
            assertThat(overflow.events()).isEmpty();

            // At the watermark the surviving region stays contiguous.
            SessionEventHub.Delivery surviving = subscription.await(88,
                    Duration.ofMillis(10));
            assertThat(surviving.overflowed()).isFalse();
            assertThat(surviving.events()).extracting(EventRecord::sequence)
                    .containsExactlyElementsOf(
                            java.util.stream.LongStream.rangeClosed(89, 600)
                                    .boxed().toList());
        }
    }

    private static EventRecord event(long sequence) {
        return new EventRecord("tenant", "session", sequence,
                "event-" + sequence, "turn", "type", Map.of(), false,
                "source-" + sequence, 1);
    }
}
