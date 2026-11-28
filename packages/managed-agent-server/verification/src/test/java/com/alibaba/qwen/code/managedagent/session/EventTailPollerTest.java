package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.EventProjectionStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionKey;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;

import java.time.Duration;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * A stream on this instance must learn about events another instance
 * committed within one poll, without re-reading the store on every tick.
 */
class EventTailPollerTest {
    private static final SessionKey KEY = new SessionKey("tenant", "session");

    private final EventProjectionStore store = mock(EventProjectionStore.class);
    private final SessionEventHub hub = new SessionEventHub();
    private final EventTailPoller poller = new EventTailPoller(store, hub);

    @Test
    void wakesSubscribersWhenAnotherInstanceAdvancesTheTail() throws Exception {
        try (SessionEventHub.Subscription subscription = hub.subscribe("tenant", "session")) {
            when(store.findEventTails(Set.of(KEY))).thenReturn(Map.of(KEY, 4L));
            poller.poll();
            assertThat(subscription.await(0, Duration.ofMillis(10)).overflowed()).isTrue();

            // An unchanged tail raises no further notice.
            poller.poll();
            assertThat(subscription.await(4, Duration.ofMillis(10)).overflowed()).isFalse();

            when(store.findEventTails(Set.of(KEY))).thenReturn(Map.of(KEY, 6L));
            poller.poll();
            assertThat(subscription.await(4, Duration.ofMillis(10)).overflowed()).isTrue();
        }
    }

    @Test
    void readsNothingWithoutASubscriber() {
        poller.poll();
        verifyNoInteractions(store);
    }

    @Test
    void forgetsATailOnceTheLastSubscriberLeaves() throws Exception {
        when(store.findEventTails(Set.of(KEY))).thenReturn(Map.of(KEY, 4L));
        SessionEventHub.Subscription first = hub.subscribe("tenant", "session");
        poller.poll();
        first.close();
        poller.poll();
        // A returning subscriber must be woken for the same tail again.
        try (SessionEventHub.Subscription again = hub.subscribe("tenant", "session")) {
            poller.poll();
            assertThat(again.await(0, Duration.ofMillis(10)).overflowed()).isTrue();
        }
    }

    @Test
    void aStoreFailureDoesNotStopLaterPolls() throws Exception {
        try (SessionEventHub.Subscription subscription = hub.subscribe("tenant", "session")) {
            when(store.findEventTails(any()))
                    .thenThrow(new DataAccessResourceFailureException("down"))
                    .thenReturn(Map.of(KEY, 2L));
            poller.poll();
            poller.poll();
            assertThat(subscription.await(0, Duration.ofMillis(10)).overflowed()).isTrue();
        }
    }
}
