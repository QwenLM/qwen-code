package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.message.Message;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiteTopicPublicEventTransportTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOPIC = "event-parent";
    private static final Executor DIRECT = Runnable::run;

    private static EventRecord event(String session, long sequence,
            String type) {
        return new EventRecord("t1", session, sequence, "evt-" + sequence,
                "turn-1", type, Map.of("text", "hi", "count", sequence),
                false, null, 1_760_000_000_000L + sequence);
    }

    private static Producer acceptingProducer() {
        Producer producer = mock(Producer.class);
        when(producer.sendAsync(any()))
                .thenReturn(CompletableFuture.completedFuture(null));
        return producer;
    }

    private static LiteTopicPublicEventTransport transport(Producer producer,
            BiFunction<String, String, Optional<String>> workspaces,
            Executor executor) {
        return new LiteTopicPublicEventTransport(producer,
                ClientServiceProvider.loadService(), TOPIC, JSON, workspaces,
                executor);
    }

    private static ManagedEventEnvelope envelopeOf(Message message)
            throws Exception {
        ByteBuffer buffer = message.getBody();
        byte[] bytes = new byte[buffer.remaining()];
        buffer.get(bytes);
        return ManagedEventEnvelopes.parse(JSON.readTree(
                new String(bytes, StandardCharsets.UTF_8)));
    }

    @Test
    void publishesOnePublicEventEnvelopePerRowToTheSessionLiteTopic()
            throws Exception {
        Producer producer = acceptingProducer();
        List<EventRecord> batch = List.of(event("s1", 7, "turn.accepted"),
                event("s1", 8, "item.output_text.delta"));

        transport(producer, (tenant, session) -> Optional.of("w1"), DIRECT)
                .publish(batch);

        ArgumentCaptor<Message> sent = ArgumentCaptor.forClass(Message.class);
        verify(producer, times(2)).sendAsync(sent.capture());
        for (int i = 0; i < 2; i++) {
            Message message = sent.getAllValues().get(i);
            EventRecord record = batch.get(i);
            assertEquals(TOPIC, message.getTopic());
            assertEquals("s1", message.getLiteTopic().orElseThrow());
            assertEquals(List.of(record.eventId()),
                    List.copyOf(message.getKeys()));
            ManagedEventEnvelope envelope = envelopeOf(message);
            assertEquals(ManagedEventEnvelopes.STREAM_PUBLIC_EVENT,
                    envelope.stream());
            assertEquals(record.sequence(), envelope.sequence());
            assertEquals(record.type(), envelope.kind());
            assertEquals(record.createdAt(), envelope.occurredAt());
            assertEquals("w1", envelope.workspaceId());
            // The digest binds the row exactly as the contract derives it.
            assertEquals(ManagedEventEnvelopes.fromPublicEventRow(
                    ManagedEventEnvelopes.publicEventRow(record, JSON), "w1"),
                    envelope);
        }
    }

    // A Session's journal may be created after its first public events, so
    // a missing workspace is never cached: the rows wait for it, then flow.
    @Test
    void aSessionWithoutAWorkspaceYetIsSkippedAndLookedUpAgain()
            throws Exception {
        Producer producer = acceptingProducer();
        AtomicInteger lookups = new AtomicInteger();
        LiteTopicPublicEventTransport transport = transport(producer,
                (tenant, session) -> lookups.incrementAndGet() < 3
                        ? Optional.empty() : Optional.of("journal-w"), DIRECT);

        transport.publish(List.of(event("s1", 1, "session.created")));
        transport.publish(List.of(event("s1", 2, "session.updated")));
        verify(producer, never()).sendAsync(any());

        transport.publish(List.of(event("s1", 3, "turn.accepted"),
                event("s1", 4, "turn.started")));

        ArgumentCaptor<Message> sent = ArgumentCaptor.forClass(Message.class);
        verify(producer, times(2)).sendAsync(sent.capture());
        assertEquals("journal-w", envelopeOf(sent.getValue()).workspaceId());
        assertEquals(3, lookups.get());
    }

    @Test
    void theBindingIsCachedPerSession() {
        Producer producer = acceptingProducer();
        List<String> looked = new ArrayList<>();
        LiteTopicPublicEventTransport transport = transport(producer,
                (tenant, session) -> {
                    looked.add(session);
                    return Optional.of("w-" + session);
                }, DIRECT);

        transport.publish(List.of(event("s1", 1, "turn.started")));
        transport.publish(List.of(event("s2", 1, "turn.started")));
        transport.publish(List.of(event("s1", 2, "turn.completed")));

        assertEquals(List.of("s1", "s2"), looked);
        verify(producer, times(3)).sendAsync(any());
    }

    @Test
    void aRowTheContractRefusesIsSkippedWithoutStoppingTheBatch()
            throws Exception {
        Producer producer = acceptingProducer();

        transport(producer, (tenant, session) -> Optional.of("w1"), DIRECT)
                .publish(List.of(event("s1", 1, "Not.A.Type"),
                        event("s1", 2, "turn.started")));

        ArgumentCaptor<Message> sent = ArgumentCaptor.forClass(Message.class);
        verify(producer, times(1)).sendAsync(sent.capture());
        assertEquals(2, envelopeOf(sent.getValue()).sequence());
    }

    @Test
    void aFailingLookupOrSendNeverPropagates() {
        Producer producer = mock(Producer.class);
        when(producer.sendAsync(any()))
                .thenThrow(new IllegalStateException("producer closing"));

        transport(producer, (tenant, session) -> Optional.of("w1"), DIRECT)
                .publish(List.of(event("s1", 1, "turn.started")));
        transport(acceptingProducer(), (tenant, session) -> {
            throw new IllegalStateException("database down");
        }, DIRECT).publish(List.of(event("s1", 1, "turn.started")));

        verify(producer, times(1)).sendAsync(any());
    }

    @Test
    void aFullQueueDropsTheBatchWithoutBlockingTheCommitter() {
        Producer producer = acceptingProducer();
        Executor full = command -> {
            throw new RejectedExecutionException("queue full");
        };

        transport(producer, (tenant, session) -> Optional.of("w1"), full)
                .publish(List.of(event("s1", 1, "turn.started")));

        verify(producer, never()).sendAsync(any());
    }

    @Test
    void theBatchIsCopiedBeforeTheSeamTakesItsListBack() {
        Producer producer = acceptingProducer();
        List<Runnable> queued = new ArrayList<>();
        List<EventRecord> lent = new ArrayList<>(
                List.of(event("s1", 1, "turn.started")));

        transport(producer, (tenant, session) -> Optional.of("w1"),
                queued::add).publish(lent);
        lent.clear();
        queued.forEach(Runnable::run);

        verify(producer, times(1)).sendAsync(any());
    }
}
