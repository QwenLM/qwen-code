package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.EventTransport;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

class CompositeCommittedEventPublisherTest {
    @Test
    void defaultCompositionDeliversToTheHubVerbatim() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub, List.of());
        try (SessionEventHub.Subscription subscription = hub.subscribe(
                "tenant", "session")) {
            publisher.publish(List.of(event(1), event(2)));

            SessionEventHub.Delivery delivery = subscription.await(0,
                    Duration.ofMillis(10));

            assertThat(delivery.overflowed()).isFalse();
            assertThat(delivery.events()).extracting(EventRecord::sequence)
                    .containsExactly(1L, 2L);
        }
    }

    @Test
    void hubRunsBeforeTransports() {
        List<String> calls = new CopyOnWriteArrayList<>();
        SessionEventHub hub = new SessionEventHub() {
            @Override
            public void publish(List<EventRecord> events) {
                calls.add("hub");
                super.publish(events);
            }
        };
        EventTransport transport = events -> calls.add("transport");
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub,
                        List.of(transport));

        publisher.publish(List.of(event(1)));

        assertThat(calls).containsExactly("hub", "transport");
    }

    @Test
    void aThrowingTransportNeitherPropagatesNorBlocksOthers() {
        SessionEventHub hub = new SessionEventHub();
        List<Long> received = new CopyOnWriteArrayList<>();
        EventTransport failing = events -> {
            throw new IllegalStateException("broker down");
        };
        EventTransport recording = events -> events.forEach(
                event -> received.add(event.sequence()));
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub,
                        List.of(failing, recording));

        assertThatCode(() -> publisher.publish(List.of(event(1))))
                .doesNotThrowAnyException();
        assertThat(received).containsExactly(1L);
    }

    @Test
    void aThrowingTransportStillLeavesHubDeliveryIntact() throws Exception {
        SessionEventHub hub = new SessionEventHub();
        EventTransport failing = events -> {
            throw new IllegalStateException("broker down");
        };
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub, List.of(failing));
        try (SessionEventHub.Subscription subscription = hub.subscribe(
                "tenant", "session")) {
            publisher.publish(List.of(event(1)));

            SessionEventHub.Delivery delivery = subscription.await(0,
                    Duration.ofMillis(10));

            assertThat(delivery.overflowed()).isFalse();
            assertThat(delivery.events()).extracting(EventRecord::sequence)
                    .containsExactly(1L);
        }
    }

    @Test
    void hubFailurePropagatesAndSkipsTransports() {
        SessionEventHub hub = new SessionEventHub() {
            @Override
            public void publish(List<EventRecord> events) {
                throw new IllegalStateException("hub failed");
            }
        };
        AtomicBoolean transportCalled = new AtomicBoolean();
        EventTransport recording = events -> transportCalled.set(true);
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub,
                        List.of(recording));

        assertThatThrownBy(() -> publisher.publish(List.of(event(1))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("hub failed");
        assertThat(transportCalled).isFalse();
    }

    @Test
    void transportErrorIsNotIsolated() {
        SessionEventHub hub = new SessionEventHub();
        EventTransport failing = events -> {
            throw new AssertionError("not a RuntimeException");
        };
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub, List.of(failing));

        assertThatThrownBy(() -> publisher.publish(List.of(event(1))))
                .isInstanceOf(AssertionError.class);
    }

    @Test
    void emptyListIsANoOp() {
        SessionEventHub hub = new SessionEventHub();
        AtomicBoolean transportCalled = new AtomicBoolean();
        EventTransport recording = events -> transportCalled.set(true);
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub,
                        List.of(recording));

        publisher.publish(List.of());

        assertThat(transportCalled).isFalse();
    }

    @Test
    void transportsRunInInjectionOrder() {
        SessionEventHub hub = new SessionEventHub();
        List<String> calls = new CopyOnWriteArrayList<>();
        EventTransport first = events -> calls.add("first");
        EventTransport second = events -> calls.add("second");
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub,
                        List.of(first, second));

        publisher.publish(List.of(event(1)));

        assertThat(calls).containsExactly("first", "second");
    }

    private static EventRecord event(long sequence) {
        return new EventRecord("tenant", "session", sequence,
                "event-" + sequence, "turn", "type", Map.of(), false,
                "source-" + sequence, 1);
    }
}
