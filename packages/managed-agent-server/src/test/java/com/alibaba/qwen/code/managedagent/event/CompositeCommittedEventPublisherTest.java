package com.alibaba.qwen.code.managedagent.event;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.session.SessionEventHub;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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

    @Test
    void transportsReceiveTheWholeBatchUnchanged() {
        SessionEventHub hub = new SessionEventHub();
        List<EventRecord> received = new CopyOnWriteArrayList<>();
        EventTransport recording = received::addAll;
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub,
                        List.of(recording));

        publisher.publish(List.of(event(1), event(2)));

        assertThat(received).extracting(EventRecord::sequence)
                .containsExactly(1L, 2L);
    }

    @Test
    void droppedBatchLogCarriesSessionIdentity() {
        SessionEventHub hub = new SessionEventHub();
        EventTransport failing = events -> {
            throw new IllegalStateException("broker down");
        };
        CompositeCommittedEventPublisher publisher =
                new CompositeCommittedEventPublisher(hub, List.of(failing));
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(
                        CompositeCommittedEventPublisher.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        logger.addAppender(logged);
        try {
            publisher.publish(List.of(event(11), event(12), event(13)));
        } finally {
            logger.detachAppender(logged);
        }

        assertThat(logged.list).hasSize(1);
        assertThat(logged.list.get(0).getFormattedMessage())
                .contains("tenant=tenant").contains("session=session")
                .contains("firstSequence=11").contains("lastSequence=13");
    }

    @Test
    void containerCollectsTransportBeansIntoTheComposite() {
        List<EventRecord> received = new CopyOnWriteArrayList<>();
        new ApplicationContextRunner()
                .withBean(SessionEventHub.class)
                .withBean(EventTransport.class, () -> received::addAll)
                .withBean(CompositeCommittedEventPublisher.class)
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(
                            CommittedEventPublisher.class);
                    CommittedEventPublisher bean =
                            context.getBean(CommittedEventPublisher.class);
                    assertThat(bean).isInstanceOf(
                            CompositeCommittedEventPublisher.class);
                    bean.publish(List.of(event(1), event(2)));
                    assertThat(received)
                            .extracting(EventRecord::sequence)
                            .containsExactly(1L, 2L);
                });
    }

    private static EventRecord event(long sequence) {
        return new EventRecord("tenant", "session", sequence,
                "event-" + sequence, "turn", "type", Map.of(), false,
                "source-" + sequence, 1);
    }
}
