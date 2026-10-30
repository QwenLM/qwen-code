package com.alibaba.qwen.code.managedagent.adapters.event;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumerBuilder;
import org.apache.rocketmq.client.apis.message.Message;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.apache.rocketmq.client.apis.producer.ProducerBuilder;
import org.apache.rocketmq.client.java.exception.BadRequestException;
import org.apache.rocketmq.client.java.exception.InternalErrorException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.RETURNS_SELF;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The startup send probe tells a broker that cannot accept writes apart
 * from a topic whose message type is wrong. Only the second is a
 * deployment misconfiguration, so only it may name the mqadmin remedy.
 */
public class RocketMqEventClientsTest {
    private static final String TOPIC = "qwen-managed-events";

    private ClientServiceProvider provider;
    private Producer producer;
    private ManagedAgentSettings settings;

    @BeforeEach
    void setUp() throws Exception {
        provider = mock(ClientServiceProvider.class);
        ProducerBuilder producerBuilder = mock(ProducerBuilder.class,
                RETURNS_SELF);
        producer = mock(Producer.class);
        when(producerBuilder.build()).thenReturn(producer);
        when(provider.newProducerBuilder()).thenReturn(producerBuilder);
        // Messages are plain values: build them for real.
        ClientServiceProvider real = ClientServiceProvider.loadService();
        when(provider.newMessageBuilder()).thenAnswer(
                invocation -> real.newMessageBuilder());
        LitePushConsumerBuilder probeBuilder = mock(
                LitePushConsumerBuilder.class, RETURNS_SELF);
        when(probeBuilder.build()).thenReturn(mock(LitePushConsumer.class));
        when(provider.newLitePushConsumerBuilder()).thenReturn(probeBuilder);

        ManagedAgentSettings.EventTransport config =
                mock(ManagedAgentSettings.EventTransport.class);
        when(config.getEndpoints()).thenReturn("127.0.0.1:8081");
        when(config.getTopic()).thenReturn(TOPIC);
        when(config.getCapabilityProbeGroup()).thenReturn("probe-group");
        settings = mock(ManagedAgentSettings.class);
        when(settings.getEventTransport()).thenReturn(config);
    }

    // #15892: the broker's disk filled on the runner, so it answered the
    // probe with 50001 and refused the write. The topic was already LITE.
    @Test
    public void aBrokerThatCannotWriteNamesItselfNotTheTopicType()
            throws Exception {
        InternalErrorException unavailable = new InternalErrorException(50001,
                "req-1", "service not available now. It may be caused by one"
                        + " of the following reasons: the broker's disk is"
                        + " full [CL:  0.90 CQ:  0.90 INDEX:  0.90]");
        when(producer.send(any(Message.class))).thenThrow(unavailable);

        IllegalStateException failure = assertThrows(
                IllegalStateException.class,
                () -> new RocketMqEventClients(provider).producer(settings));

        assertTrue(failure.getMessage().contains("could not write the probe"
                + " message to topic " + TOPIC), failure.getMessage());
        assertTrue(failure.getMessage().contains("disk space"),
                failure.getMessage());
        assertFalse(failure.getMessage().contains("mqadmin updateTopic"),
                failure.getMessage());
        assertFalse(failure.getMessage().contains("refused a LiteTopic"
                + " message"), failure.getMessage());
        assertSame(unavailable, failure.getCause());
        verify(producer).close();
    }

    // A NORMAL topic refuses the LITE message with 40014, which the client
    // maps to BadRequestException. That one really is a misconfiguration
    // and keeps the fail-fast remedy.
    @Test
    public void aTopicTypeConflictStillNamesTheMqadminRemedy()
            throws Exception {
        when(producer.send(any(Message.class))).thenThrow(
                new BadRequestException(40014, "req-2", "Message property"
                        + " conflict with message type, expect: NORMAL,"
                        + " actual: LITE"));

        IllegalStateException failure = assertThrows(
                IllegalStateException.class,
                () -> new RocketMqEventClients(provider).producer(settings));

        assertTrue(failure.getMessage().contains("refused a LiteTopic"
                + " message"), failure.getMessage());
        assertTrue(failure.getMessage().contains("mqadmin updateTopic"
                + " -c <cluster> -t " + TOPIC + " -a +message.type=LITE"),
                failure.getMessage());
        assertEquals(BadRequestException.class, failure.getCause().getClass());
        verify(producer).close();
    }
}
