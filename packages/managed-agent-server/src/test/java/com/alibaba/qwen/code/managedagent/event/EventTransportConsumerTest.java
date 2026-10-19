package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.event.EventTransportConsumer.MaterializeOutcome;
import com.alibaba.qwen.code.managedagent.event.TransportWakeActivator.Outcome;
import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.message.MessageView;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.OptionalLong;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class EventTransportConsumerTest {
    private static final String DIGEST = "b".repeat(64);

    private TransportWakeActivator wakes;
    private TransportConsumerStore store;
    private MessageMaterializer materializer;
    private List<Runnable> queued;
    private EventTransportConsumer consumer;

    private static ManagedEventEnvelope envelope(String stream, String kind,
            long sequence) {
        return new ManagedEventEnvelope(1, "s1", "t1", "w1", stream, sequence,
                "evt-" + sequence, kind, 1_760_000_000_000L,
                new ManagedEventEnvelope.PayloadRef(DIGEST));
    }

    private static MessageView message(String body) {
        MessageView view = mock(MessageView.class);
        // A read-only view: the listener must not depend on a fresh buffer.
        when(view.getBody()).thenReturn(ByteBuffer.wrap(
                body.getBytes(StandardCharsets.UTF_8)).asReadOnlyBuffer());
        return view;
    }

    private static MessageView message(ManagedEventEnvelope envelope) {
        return message(ManagedEventEnvelopes.toJson(envelope));
    }

    @BeforeEach
    void setUp() {
        wakes = mock(TransportWakeActivator.class);
        store = mock(TransportConsumerStore.class);
        materializer = mock(MessageMaterializer.class);
        queued = new ArrayList<>();
        consumer = new EventTransportConsumer(wakes, store, materializer,
                queued::add);
    }

    @Test
    void aWakeGoesToTheActivator() {
        ManagedEventEnvelope wake = envelope("authoritative_journal",
                "wake.requested", 3);
        when(wakes.onWake(wake)).thenReturn(Outcome.SCHEDULED);

        assertEquals(ConsumeResult.SUCCESS, consumer.consume(message(wake)));

        verify(wakes).onWake(wake);
        verify(store, never()).materializedThrough(anyString(), anyString());
    }

    @Test
    void aRedeliveredPublicEventIsANoOpAgainstTheProjectionWatermark() {
        when(store.materializedThrough("t1", "s1"))
                .thenReturn(OptionalLong.of(9));

        assertEquals(MaterializeOutcome.DUPLICATE, consumer.materialize(
                envelope("public_event", "turn.started", 9)));
        assertEquals(MaterializeOutcome.DUPLICATE, consumer.materialize(
                envelope("public_event", "turn.started", 4)));

        assertEquals(List.of(), queued);
    }

    @Test
    void aNewPublicEventQueuesOneBatchThroughTheMaterializerPath() {
        when(store.materializedThrough("t1", "s1"))
                .thenReturn(OptionalLong.of(9));

        assertEquals(ConsumeResult.SUCCESS, consumer.consume(message(
                envelope("public_event", "item.output_text.delta", 10))));

        verify(materializer, never()).materializeNotified(anyString(),
                anyString());
        assertEquals(1, queued.size());
        queued.getFirst().run();
        verify(materializer).materializeNotified("t1", "s1");
        verify(wakes, never()).onWake(any());
    }

    // A streaming Turn's notices must not cost one locking batch each: while
    // a batch is queued, later notices fold into it; once it starts, the
    // next notice queues one more, which reads the rows that came after.
    @Test
    void publicNoticesCoalescePerSession() {
        when(store.materializedThrough("t1", "s1"))
                .thenReturn(OptionalLong.of(9));

        assertEquals(MaterializeOutcome.QUEUED, consumer.materialize(
                envelope("public_event", "item.output_text.delta", 10)));
        for (long sequence = 11; sequence <= 20; sequence++) {
            assertEquals(MaterializeOutcome.COALESCED, consumer.materialize(
                    envelope("public_event", "item.output_text.delta",
                            sequence)));
        }
        assertEquals(1, queued.size());

        queued.getFirst().run();
        assertEquals(MaterializeOutcome.QUEUED, consumer.materialize(
                envelope("public_event", "item.output_text.delta", 21)));
        assertEquals(2, queued.size());
        verify(materializer, times(1)).materializeNotified("t1", "s1");
    }

    @Test
    void aFullQueueLeavesTheSessionToTheScheduledPassAndRequeuesLater() {
        when(store.materializedThrough("t1", "s1"))
                .thenReturn(OptionalLong.of(1));
        Executor full = command -> {
            throw new RejectedExecutionException("full");
        };
        EventTransportConsumer saturated = new EventTransportConsumer(wakes,
                store, materializer, full);

        assertEquals(MaterializeOutcome.DROPPED, saturated.materialize(
                envelope("public_event", "turn.started", 2)));
        // The drop did not leave the Session marked as queued.
        assertEquals(MaterializeOutcome.DROPPED, saturated.materialize(
                envelope("public_event", "turn.started", 3)));

        when(store.materializedThrough("t1", "s1"))
                .thenReturn(OptionalLong.empty());
        assertEquals(MaterializeOutcome.UNKNOWN_SESSION, consumer.materialize(
                envelope("public_event", "turn.started", 2)));
    }

    @Test
    void everyMessageIsAcknowledgedWhateverItComesTo() {
        // Not JSON, not an envelope, a forbidden field: dropped, never
        // retried — a FAILURE would stall the ordered LiteTopic behind it.
        for (String body : List.of("not json", "{\"v\":1}",
                ManagedEventEnvelopes.toJson(envelope("public_event",
                        "turn.started", 2)).replace("{\"eventId\"",
                        "{\"pid\":1,\"eventId\""))) {
            assertEquals(ConsumeResult.SUCCESS, consumer.consume(
                    message(body)));
        }
        verify(wakes, never()).onWake(any());
        verify(store, never()).materializedThrough(anyString(), anyString());

        // A role that throws is acknowledged too.
        ManagedEventEnvelope wake = envelope("authoritative_journal",
                "wake.requested", 3);
        when(wakes.onWake(wake)).thenThrow(
                new IllegalStateException("database down"));
        assertEquals(ConsumeResult.SUCCESS, consumer.consume(message(wake)));
    }
}
