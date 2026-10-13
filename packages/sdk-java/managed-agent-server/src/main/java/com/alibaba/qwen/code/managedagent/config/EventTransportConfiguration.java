package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.EventTransportConsumer;
import com.alibaba.qwen.code.managedagent.service.LiteTopicEventTransport;
import com.alibaba.qwen.code.managedagent.service.LiteTopicPublicEventTransport;
import com.alibaba.qwen.code.managedagent.service.MessageMaterializer;
import com.alibaba.qwen.code.managedagent.service.OwnerSubscriptions;
import com.alibaba.qwen.code.managedagent.service.TransportWakeActivator;
import com.alibaba.qwen.code.managedagent.store.TransportConsumerStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.concurrent.ScheduledFuture;
import org.apache.rocketmq.client.apis.ClientConfiguration;
import org.apache.rocketmq.client.apis.ClientException;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * Wires the broker EventTransport (design
 * 2026-10-04-managed-agent-event-transport): the authoritative-journal
 * producer (phase MQ2b), and the public-event producer and the two consumer
 * lanes (phase MQ2c). Every bean here exists only when
 * {@code qwen.managed-agent.event-transport.enabled=true}, so a flag-off
 * deployment creates no producer, no consumer and no transport, and the
 * after-commit seam's transport list stays empty — the MQ2 byte-identical
 * exit check is an inspectable property of this class, not a claim.
 *
 * <p>Deployment prerequisites, all on the broker (RocketMQ 5.5.0+ with
 * {@code enableLmq}): the topic is a LITE topic, and three groups are
 * pre-created as LITE groups bound to it — the capability-probe group
 * {@value #CAPABILITY_PROBE_GROUP}, and the configured wake-bootstrap and
 * owner groups — because subscribeLite rejects an auto-created (regular)
 * group with "regular group cannot use LITE mode":
 * <pre>
 *   mqadmin updateSubGroup -g &lt;group&gt; -o true \
 *     --attributes +lite.bind.topic=&lt;topic&gt;
 * </pre>
 * The wake-bootstrap group is shared by every node: the one bootstrap
 * LiteTopic is consumed in order by one member at a time, so its listener
 * only checks SQL and claims, and hands each load to a small pool. The owner
 * group is shared too, and each node subscribes it only to the Sessions its
 * Harness writes (§11).
 */
@Configuration
@ConditionalOnProperty(prefix = "qwen.managed-agent.event-transport",
        name = "enabled", havingValue = "true")
public class EventTransportConfiguration {
    // A throwaway group + lite topic used only by the startup capability probe.
    static final String CAPABILITY_PROBE_GROUP =
            "qwen-managed-journal-capability-probe";
    private static final String CAPABILITY_PROBE_LITE = "capability-probe";

    // Replaceable, so the wiring can be exercised without a broker.
    @Bean
    @ConditionalOnMissingBean(ClientServiceProvider.class)
    public ClientServiceProvider eventTransportClientProvider() {
        return ClientServiceProvider.loadService();
    }

    /** The one producer both wires share; closing it closes the connections. */
    @Bean(destroyMethod = "close")
    public Producer eventTransportProducer(ClientServiceProvider provider,
            ManagedAgentProperties properties) throws ClientException {
        var config = properties.getEventTransport();
        ClientConfiguration clientConfig = clientConfiguration(config);
        verifyLiteTopicCapability(provider, clientConfig, config.getTopic());
        return provider.newProducerBuilder()
                .setClientConfiguration(clientConfig)
                .setTopics(config.getTopic())
                .build();
    }

    @Bean
    public LiteTopicEventTransport liteTopicEventTransport(Producer producer,
            ClientServiceProvider provider, ManagedAgentProperties properties) {
        var config = properties.getEventTransport();
        return new LiteTopicEventTransport(producer, provider,
                config.getTopic(), config.getWakeBootstrapLiteTopic());
    }

    @Bean
    public TransportConsumerStore transportConsumerStore(JdbcTemplate jdbc,
            Clock clock) {
        return new TransportConsumerStore(jdbc, clock);
    }

    @Bean(destroyMethod = "close")
    public LiteTopicPublicEventTransport liteTopicPublicEventTransport(
            Producer producer, ClientServiceProvider provider,
            ManagedAgentProperties properties, ObjectMapper objectMapper,
            TransportConsumerStore store) {
        return new LiteTopicPublicEventTransport(producer, provider,
                properties.getEventTransport().getTopic(), objectMapper,
                store::workspaceOf);
    }

    @Bean
    public OwnerSubscriptions ownerSubscriptions(HarnessConnector harness,
            TransportConsumerStore store) {
        return new OwnerSubscriptions(harness, store);
    }

    @Bean(destroyMethod = "close")
    public TransportWakeActivator transportWakeActivator(
            TransportConsumerStore store, HarnessConnector harness,
            OwnerSubscriptions owners) {
        return new TransportWakeActivator(store, harness, owners::subscribe);
    }

    @Bean(destroyMethod = "close")
    public EventTransportConsumer eventTransportConsumer(
            TransportWakeActivator wakes, TransportConsumerStore store,
            MessageMaterializer materializer) {
        return new EventTransportConsumer(wakes, store, materializer);
    }

    /**
     * The owner lane: subscribed per Session by {@link OwnerSubscriptions},
     * never to a fixed LiteTopic.
     */
    @Bean(destroyMethod = "close")
    public LitePushConsumer eventTransportOwnerConsumer(
            ClientServiceProvider provider, ManagedAgentProperties properties,
            EventTransportConsumer listener, OwnerSubscriptions owners)
            throws ClientException {
        var config = properties.getEventTransport();
        LitePushConsumer consumer = provider.newLitePushConsumerBuilder()
                .setClientConfiguration(clientConfiguration(config))
                .setConsumerGroup(config.getOwnerGroup())
                .bindTopic(config.getTopic())
                .setMessageListener(listener::consume)
                .build();
        owners.bind(consumer);
        return consumer;
    }

    /** The shared wake bootstrap lane: every node subscribes the one LiteTopic. */
    @Bean(destroyMethod = "close")
    public LitePushConsumer eventTransportWakeBootstrapConsumer(
            ClientServiceProvider provider, ManagedAgentProperties properties,
            EventTransportConsumer listener) throws ClientException {
        var config = properties.getEventTransport();
        LitePushConsumer consumer = provider.newLitePushConsumerBuilder()
                .setClientConfiguration(clientConfiguration(config))
                .setConsumerGroup(config.getWakeBootstrapGroup())
                .bindTopic(config.getTopic())
                .setMessageListener(listener::consume)
                .build();
        try {
            consumer.subscribeLite(config.getWakeBootstrapLiteTopic());
        } catch (ClientException | RuntimeException failure) {
            closeQuietly(consumer, failure);
            throw new IllegalStateException("the event-transport wake"
                    + " bootstrap group " + config.getWakeBootstrapGroup()
                    + " could not subscribe "
                    + config.getWakeBootstrapLiteTopic() + " on topic "
                    + config.getTopic() + ": pre-create it as a LITE group"
                    + " bound to the topic (mqadmin updateSubGroup"
                    + " --attributes +lite.bind.topic=" + config.getTopic()
                    + ")", failure);
        }
        return consumer;
    }

    /**
     * Owner reconciliation runs on its own thread: it calls the broker, and
     * must never delay the one-thread default scheduler's recovery ticks.
     */
    @Bean
    public ThreadPoolTaskScheduler eventTransportScheduler(
            ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("event-transport-")
                .build();
    }

    @Bean(destroyMethod = "cancel")
    public ScheduledFuture<?> eventTransportOwnerReconcileTask(
            @Qualifier("eventTransportScheduler")
                    ThreadPoolTaskScheduler eventTransportScheduler,
            OwnerSubscriptions owners,
            // Ensures the owner consumer is bound before the first tick.
            @Qualifier("eventTransportOwnerConsumer")
                    LitePushConsumer ownerConsumer,
            ManagedAgentProperties properties) {
        return eventTransportScheduler.scheduleWithFixedDelay(owners::reconcile,
                properties.getEventTransport().getOwnerReconcileInterval());
    }

    private static ClientConfiguration clientConfiguration(
            ManagedAgentProperties.EventTransport config) {
        return ClientConfiguration.newBuilder()
                .setEndpoints(config.getEndpoints())
                .build();
    }

    private static void closeQuietly(LitePushConsumer consumer,
            Throwable failure) {
        try {
            consumer.close();
        } catch (Exception suppressed) {
            failure.addSuppressed(suppressed);
        }
    }

    // #13200 hardening: fail fast at startup on a broker that cannot serve
    // LiteTopics (needs RocketMQ 5.5.0+ with enableLmq), instead of silently
    // degrading to a classic topic. The probe subscribes and unsubscribes; no
    // message is written. Building the consumer also catches an unreachable or
    // non-gRPC (classic 4.x) broker.
    private static void verifyLiteTopicCapability(ClientServiceProvider provider,
            ClientConfiguration clientConfig, String topic) {
        try (LitePushConsumer probe = provider.newLitePushConsumerBuilder()
                .setClientConfiguration(clientConfig)
                .setConsumerGroup(CAPABILITY_PROBE_GROUP)
                .bindTopic(topic)
                .setMessageListener(messageView -> ConsumeResult.SUCCESS)
                .build()) {
            probe.subscribeLite(CAPABILITY_PROBE_LITE);
            probe.unsubscribeLite(CAPABILITY_PROBE_LITE);
        } catch (Exception failure) {
            throw new IllegalStateException("the event-transport LiteTopic"
                    + " capability probe failed on topic " + topic + ": the"
                    + " broker must serve LiteTopics (RocketMQ 5.5.0+ with"
                    + " enableLmq) and the probe group " + CAPABILITY_PROBE_GROUP
                    + " must be pre-created as a LITE group bound to the topic"
                    + " (mqadmin updateSubGroup --attributes +lite.bind.topic="
                    + topic + "); check"
                    + " qwen.managed-agent.event-transport.endpoints", failure);
        }
    }
}
