package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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
    void bufferIsEvictedWhenTheLastSubscriberCloses() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        SessionEventHub.Subscription first = hub.subscribe("tenant",
                "session");
        hub.publish(List.of(event(1)));
        first.close();

        // A fresh subscription, not the closed handle: await short-circuits
        // on a closed Subscription, which is indistinguishable from an
        // evicted buffer. A leaked buffer would hand the stale event to the
        // new subscriber; an evicted one starts empty.
        try (SessionEventHub.Subscription second = hub.subscribe("tenant",
                "session")) {
            SessionEventHub.Delivery delivery = second.await(0,
                    Duration.ofMillis(10));

            assertThat(delivery.events()).isEmpty();
            assertThat(delivery.overflowed()).isFalse();
        }
    }

    @Test
    void closingOneOfTwoSubscribersKeepsTheBuffer() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        SessionEventHub.Subscription first = hub.subscribe("tenant",
                "session");
        SessionEventHub.Subscription second = hub.subscribe("tenant",
                "session");
        first.close();
        hub.publish(List.of(event(1)));

        // The surviving subscriber must still receive events published
        // after the other reference closed: a premature eviction would
        // leave it parked on an orphaned buffer that publish can no
        // longer reach.
        SessionEventHub.Delivery delivery = second.await(0,
                Duration.ofMillis(10));

        assertThat(delivery.overflowed()).isFalse();
        assertThat(delivery.events()).extracting(EventRecord::sequence)
                .containsExactly(1L);

        second.close();

        // With the last reference gone the buffer is evicted, observable
        // only through a fresh subscription: it starts empty rather than
        // replaying the stale event.
        try (SessionEventHub.Subscription third = hub.subscribe("tenant",
                "session")) {
            SessionEventHub.Delivery afterEviction = third.await(0,
                    Duration.ofMillis(10));

            assertThat(afterEviction.events()).isEmpty();
            assertThat(afterEviction.overflowed()).isFalse();
        }
    }

    @Test
    void closingTheSameSubscriberTwiceKeepsTheBufferForTheOther()
            throws Exception {
        SessionEventHub hub = new SessionEventHub();
        SessionEventHub.Subscription first = hub.subscribe("tenant",
                "session");
        SessionEventHub.Subscription second = hub.subscribe("tenant",
                "session");
        first.close();
        first.close();
        hub.publish(List.of(event(1)));

        // Observe through the surviving subscriber, never the closed
        // handle: await on a closed Subscription short-circuits to an
        // empty Delivery, indistinguishable from an evicted buffer.
        // Without the idempotency guard in Subscription.close() the second
        // close decrements references to zero and evicts the buffer while
        // second is still subscribed, so publish silently no-ops on it.
        SessionEventHub.Delivery delivery = second.await(0,
                Duration.ofMillis(10));

        assertThat(delivery.overflowed()).isFalse();
        assertThat(delivery.events()).extracting(EventRecord::sequence)
                .containsExactly(1L);

        second.close();
    }

    @Test
    void publishWakesEveryParkedSubscriber() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        try (SessionEventHub.Subscription first = hub.subscribe("tenant",
                "session");
                SessionEventHub.Subscription second = hub.subscribe(
                        "tenant", "session");
                ExecutorService waiters = Executors
                        .newVirtualThreadPerTaskExecutor()) {
            Future<SessionEventHub.Delivery> firstDelivery = waiters.submit(
                    () -> first.await(0, Duration.ofSeconds(30)));
            Future<SessionEventHub.Delivery> secondDelivery = waiters.submit(
                    () -> second.await(0, Duration.ofSeconds(30)));
            // Let both waiters park inside await before publishing.
            Thread.sleep(500);

            hub.publish(List.of(event(1)));

            // A signal() in place of signalAll() would wake one waiter
            // and leave the other parked until its 30 s timeout.
            SessionEventHub.Delivery firstResult = firstDelivery.get(1,
                    TimeUnit.SECONDS);
            SessionEventHub.Delivery secondResult = secondDelivery.get(1,
                    TimeUnit.SECONDS);

            assertThat(firstResult.overflowed()).isFalse();
            assertThat(firstResult.events())
                    .extracting(EventRecord::sequence).containsExactly(1L);
            assertThat(secondResult.overflowed()).isFalse();
            assertThat(secondResult.events())
                    .extracting(EventRecord::sequence).containsExactly(1L);
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
