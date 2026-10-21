package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.AttachedSession;
import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore;
import org.apache.rocketmq.client.apis.ClientException;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class OwnerSubscriptionsTest {
    private static final String WRITER = "harness-boot-1";

    private HarnessConnector harness;
    private TransportConsumerStore store;
    private LitePushConsumer consumer;
    private OwnerSubscriptions owners;

    @BeforeEach
    void setUp() {
        harness = mock(HarnessConnector.class);
        when(harness.writerIdentity()).thenReturn(WRITER);
        store = mock(TransportConsumerStore.class);
        consumer = mock(LitePushConsumer.class);
        owners = new OwnerSubscriptions(harness, store);
        owners.bind(consumer);
    }

    @Test
    void followsTheSessionsThisNodesHarnessWrites() throws Exception {
        when(consumer.getLiteTopicSet()).thenReturn(Set.of("held", "released"));
        when(harness.attachedSessions()).thenReturn(List.of(
                new AttachedSession("t1", "held"),
                new AttachedSession("t1", "acquired")));
        when(store.heldBy(WRITER, "t1", List.of("held", "acquired")))
                .thenReturn(Set.of("held", "acquired"));

        owners.reconcile();

        verify(consumer).subscribeLite("acquired");
        verify(consumer).unsubscribeLite("released");
        verify(consumer, never()).subscribeLite("held");
        verify(consumer, never()).unsubscribeLite("held");
    }

    // An attachment outlives a lapsed lease or a takeover by another node;
    // only SQL says whose Harness writes the journal now.
    @Test
    void anAttachmentSqlNoLongerShowsHeldHereIsUnsubscribed()
            throws Exception {
        when(consumer.getLiteTopicSet()).thenReturn(Set.of("taken-over"));
        when(harness.attachedSessions()).thenReturn(List.of(
                new AttachedSession("t1", "taken-over"),
                new AttachedSession("t2", "other-tenant")));
        when(store.heldBy(WRITER, "t1", List.of("taken-over")))
                .thenReturn(Set.of());
        when(store.heldBy(WRITER, "t2", List.of("other-tenant")))
                .thenReturn(Set.of("other-tenant"));

        owners.reconcile();

        verify(consumer).unsubscribeLite("taken-over");
        verify(consumer).subscribeLite("other-tenant");
    }

    @Test
    void aNodeWithoutAHarnessWriterHoldsNothing() throws Exception {
        when(harness.writerIdentity()).thenReturn(null);
        when(consumer.getLiteTopicSet()).thenReturn(Set.of("s1"));
        when(harness.attachedSessions()).thenReturn(List.of(
                new AttachedSession("t1", "s1")));

        owners.reconcile();

        verify(consumer).unsubscribeLite("s1");
        verify(store, never()).heldBy(anyString(), anyString(), anyList());
    }

    // An activation adds the Session to the attachments and subscribes it
    // between the tick's two reads. Read subscribed-then-held, the tick sees
    // it as newly held (a harmless re-subscribe); read the other way round it
    // would take it for released and drop the new owner's subscription.
    @Test
    void aSessionActivatedMidTickIsNeverTakenForReleased() throws Exception {
        AtomicBoolean activatedYet = new AtomicBoolean();
        when(consumer.getLiteTopicSet()).thenAnswer(invocation ->
                activatedYet.getAndSet(true) ? Set.of("s1") : Set.of());
        when(harness.attachedSessions()).thenAnswer(invocation ->
                activatedYet.getAndSet(true)
                        ? List.of(new AttachedSession("t1", "s1")) : List.of());
        when(store.heldBy(WRITER, "t1", List.of("s1")))
                .thenReturn(Set.of("s1"));

        owners.reconcile();

        verify(consumer, never()).unsubscribeLite(anyString());
    }

    @Test
    void aRefusedSubscriptionNeitherStopsTheTickNorEscapesIt()
            throws Exception {
        when(consumer.getLiteTopicSet()).thenReturn(Set.of("released"));
        when(harness.attachedSessions()).thenReturn(List.of(
                new AttachedSession("t1", "over-quota")));
        when(store.heldBy(WRITER, "t1", List.of("over-quota")))
                .thenReturn(Set.of("over-quota"));
        doThrow(new ClientException("subscription quota exceeded"))
                .when(consumer).subscribeLite("over-quota");

        owners.reconcile();

        verify(consumer).unsubscribeLite("released");
    }

    @Test
    void aTickThatCannotReadTheHeldSetChangesNothing() throws Exception {
        when(consumer.getLiteTopicSet()).thenReturn(Set.of("s1"));
        when(harness.attachedSessions()).thenReturn(List.of(
                new AttachedSession("t1", "s1")));
        when(store.heldBy(anyString(), anyString(), anyList())).thenThrow(
                new IllegalStateException("database down"));

        owners.reconcile();

        verify(consumer, never()).unsubscribeLite(any());
        verify(consumer, never()).subscribeLite(any());
    }

    @Test
    void anActivationSubscribesAtOnceAndOnlyOnce() throws Exception {
        when(consumer.getLiteTopicSet()).thenReturn(Set.of(), Set.of("s1"));

        owners.subscribe("s1");
        owners.subscribe("s1");

        verify(consumer).subscribeLite("s1");
    }

    @Test
    void nothingRunsBeforeTheConsumerIsBound() throws Exception {
        OwnerSubscriptions unbound = new OwnerSubscriptions(harness, store);

        unbound.reconcile();
        unbound.subscribe("s1");

        verify(harness, never()).attachedSessions();
        verify(consumer, never()).subscribeLite(anyString());
    }
}
