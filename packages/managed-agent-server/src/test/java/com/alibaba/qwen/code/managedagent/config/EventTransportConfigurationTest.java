package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.EventTransportConsumer;
import com.alibaba.qwen.code.managedagent.service.LiteTopicEventTransport;
import com.alibaba.qwen.code.managedagent.service.LiteTopicPublicEventTransport;
import com.alibaba.qwen.code.managedagent.service.MessageMaterializer;
import com.alibaba.qwen.code.managedagent.service.TransportWakeActivator;
import com.alibaba.qwen.code.managedagent.store.EventTransport;
import com.alibaba.qwen.code.managedagent.store.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.store.TransportConsumerStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.ClientException;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumerBuilder;
import org.apache.rocketmq.client.apis.message.Message;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.apache.rocketmq.client.apis.producer.ProducerBuilder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.RETURNS_SELF;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The EventTransport wiring without a broker. Flag off, the MQ2
 * byte-identical exit check is a structural property: no producer, consumer,
 * transport or consumer store exists, so the after-commit seam's transport
 * list stays empty. Flag on, against a stand-in client: the probe runs first,
 * both wires share the one producer, the bootstrap lane subscribes its
 * LiteTopic in its group, the owner lane starts with no subscription, and a
 * broker that refuses the probe or the bootstrap subscription fails startup.
 */
class EventTransportConfigurationTest {
    private static final String TOPIC = "event-parent";

    private ClientServiceProvider provider;
    private LitePushConsumerBuilder probeBuilder;
    private LitePushConsumerBuilder ownerBuilder;
    private LitePushConsumerBuilder bootstrapBuilder;
    private LitePushConsumer probe;
    private LitePushConsumer owner;
    private LitePushConsumer bootstrap;
    private Producer producer;

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(EventTransportConfiguration.class);

    @BeforeEach
    void setUp() throws ClientException {
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
        probeBuilder = mock(LitePushConsumerBuilder.class, RETURNS_SELF);
        ownerBuilder = mock(LitePushConsumerBuilder.class, RETURNS_SELF);
        bootstrapBuilder = mock(LitePushConsumerBuilder.class, RETURNS_SELF);
        probe = mock(LitePushConsumer.class);
        owner = mock(LitePushConsumer.class);
        bootstrap = mock(LitePushConsumer.class);
        when(probeBuilder.build()).thenReturn(probe);
        when(ownerBuilder.build()).thenReturn(owner);
        when(bootstrapBuilder.build()).thenReturn(bootstrap);
        // One builder per consumer, in bean order: the probe inside the
        // producer bean, then the owner lane, then the bootstrap lane — so
        // each lane's group is pinned to the consumer it built.
        when(provider.newLitePushConsumerBuilder()).thenReturn(probeBuilder,
                ownerBuilder, bootstrapBuilder);
    }

    private ApplicationContextRunner enabled() {
        HarnessConnector harness = mock(HarnessConnector.class);
        return runner
                .withPropertyValues(
                        "qwen.managed-agent.event-transport.enabled=true",
                        "qwen.managed-agent.event-transport.endpoints=127.0.0.1:8081",
                        "qwen.managed-agent.event-transport.topic=" + TOPIC)
                // Bound from the property values, as in a deployment.
                .withUserConfiguration(PropertiesConfiguration.class)
                .withBean(ClientServiceProvider.class, () -> provider)
                .withBean(JdbcTemplate.class, () -> mock(JdbcTemplate.class))
                .withBean(Clock.class, Clock::systemUTC)
                .withBean(ObjectMapper.class, ObjectMapper::new)
                .withBean(HarnessConnector.class, () -> harness)
                .withBean(MessageMaterializer.class,
                        () -> mock(MessageMaterializer.class))
                .withBean(ThreadPoolTaskSchedulerBuilder.class,
                        ThreadPoolTaskSchedulerBuilder::new);
    }

    @Test
    void aFlagOffDeploymentGetsNoTransportBean() {
        for (String flag : new String[] {null, "false"}) {
            ApplicationContextRunner context = flag == null ? runner
                    : runner.withPropertyValues(
                            "qwen.managed-agent.event-transport.enabled="
                                    + flag);
            context.run(started -> {
                assertThat(started).hasNotFailed();
                assertThat(started).doesNotHaveBean(Producer.class);
                assertThat(started).doesNotHaveBean(LitePushConsumer.class);
                assertThat(started).doesNotHaveBean(EventTransport.class);
                assertThat(started).doesNotHaveBean(
                        JournalEventTransport.class);
                assertThat(started).doesNotHaveBean(
                        TransportConsumerStore.class);
                assertThat(started).doesNotHaveBean(
                        EventTransportConfiguration.class);
            });
        }
    }

    @Test
    void aFlagOnDeploymentWiresBothWiresAndBothLanes() throws Exception {
        enabled().run(started -> {
            assertThat(started).hasNotFailed();
            assertThat(started).hasSingleBean(Producer.class);
            assertThat(started).hasSingleBean(LiteTopicEventTransport.class);
            assertThat(started).getBean(JournalEventTransport.class)
                    .isSameAs(started.getBean(LiteTopicEventTransport.class));
            assertThat(started.getBeansOfType(EventTransport.class).values())
                    .containsExactly(started.getBean(
                            LiteTopicPublicEventTransport.class));
            assertThat(started).hasSingleBean(EventTransportConsumer.class);
            assertThat(started).hasSingleBean(TransportWakeActivator.class);
            assertThat(started.getBeansOfType(LitePushConsumer.class))
                    .containsOnlyKeys("eventTransportOwnerConsumer",
                            "eventTransportWakeBootstrapConsumer");
        });
        verify(probe).subscribeLite("capability-probe");
        verify(probe).unsubscribeLite("capability-probe");
        verify(bootstrap).subscribeLite("qwen-wake-bootstrap");
        verify(owner, never()).subscribeLite(anyString());
        verify(probeBuilder).setConsumerGroup(
                "qwen-managed-journal-capability-probe");
        verify(ownerBuilder).setConsumerGroup("qwen-managed-session-owner");
        verify(bootstrapBuilder).setConsumerGroup(
                "qwen-managed-wake-bootstrap");
        for (LitePushConsumerBuilder builder : List.of(probeBuilder,
                ownerBuilder, bootstrapBuilder)) {
            verify(builder).bindTopic(TOPIC);
        }
        // The send probe went to the probe's own lite topic on the topic.
        ArgumentCaptor<Message> probeSend = ArgumentCaptor.forClass(Message.class);
        verify(producer).send(probeSend.capture());
        assertThat(probeSend.getValue().getTopic()).isEqualTo(TOPIC);
        assertThat(probeSend.getValue().getLiteTopic()).contains(
                EventTransportConfiguration.CAPABILITY_PROBE_LITE);
        verify(owner).close();
        verify(bootstrap).close();
        verify(producer).close();
    }

    // A group binds to a topic whatever its message type, so the
    // subscription probe passes on a NORMAL topic; the send probe is what
    // refuses it, before any envelope would be dropped at send time.
    @Test
    void aTopicThatIsNotLiteFailsStartupAtTheSendProbe() throws Exception {
        when(producer.send(any(Message.class))).thenThrow(new ClientException(
                "the topic does not accept LITE messages"));

        enabled().run(started -> assertThat(started).hasFailed()
                .getFailure().hasStackTraceContaining(
                        "refused a LiteTopic message"));
        verify(producer).close();
        // The probe consumer was built; no lane consumer ever was.
        verify(ownerBuilder, never()).build();
        verify(bootstrapBuilder, never()).build();
    }

    @Test
    void theProbeSubscribesInTheConfiguredGroup() throws Exception {
        enabled().withPropertyValues(
                "qwen.managed-agent.event-transport.capability-probe-group=probe-2")
                .run(started -> assertThat(started).hasNotFailed());
        verify(probeBuilder).setConsumerGroup("probe-2");
    }

    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class PropertiesConfiguration {
    }

    @Test
    void aBrokerThatCannotServeLiteTopicsFailsStartup() throws Exception {
        doThrow(new ClientException("regular group cannot use LITE mode"))
                .when(probe).subscribeLite("capability-probe");

        enabled().run(started -> assertThat(started).hasFailed()
                .getFailure().rootCause().hasMessageContaining(
                        "regular group cannot use LITE mode"));
        verify(provider, never()).newProducerBuilder();
    }

    @Test
    void anUnsubscribableBootstrapGroupFailsStartup() throws Exception {
        doThrow(new ClientException("subscription quota exceeded"))
                .when(bootstrap).subscribeLite("qwen-wake-bootstrap");

        enabled().run(started -> assertThat(started).hasFailed()
                .getFailure().hasStackTraceContaining(
                        "qwen-managed-wake-bootstrap could not subscribe"));
        verify(bootstrap).close();
    }
}
