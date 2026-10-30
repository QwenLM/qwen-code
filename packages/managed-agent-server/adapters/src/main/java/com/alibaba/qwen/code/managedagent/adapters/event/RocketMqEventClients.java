package com.alibaba.qwen.code.managedagent.adapters.event;

import com.alibaba.qwen.code.managedagent.contracts.event.EventMessageListener;
import com.alibaba.qwen.code.managedagent.contracts.event.EventSubscriptions;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.ClientConfiguration;
import org.apache.rocketmq.client.apis.ClientException;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.apache.rocketmq.client.java.exception.InternalErrorException;
public final class RocketMqEventClients {
    public static final String CAPABILITY_PROBE_LITE = "capability-probe";
    private final ClientServiceProvider provider;
    public RocketMqEventClients() { this(ClientServiceProvider.loadService()); }
    public RocketMqEventClients(ClientServiceProvider provider) { this.provider = provider; }
    public static final class Publisher implements java.io.Closeable {
        private final Producer producer;
        private Publisher(Producer producer) { this.producer = producer; }
        public void close() throws java.io.IOException { producer.close(); }
    }
    public LiteTopicEventTransport journal(Publisher publisher, ManagedAgentSettings properties) {
        var config = properties.getEventTransport();
        return new LiteTopicEventTransport(publisher.producer, provider, config.getTopic(), config.getWakeBootstrapLiteTopic());
    }
    public LiteTopicPublicEventTransport publicEvents(Publisher publisher, ManagedAgentSettings properties,
            ObjectMapper json, java.util.function.BiFunction<String, String, java.util.Optional<String>> workspaceOf) {
        return new LiteTopicPublicEventTransport(publisher.producer, provider, properties.getEventTransport().getTopic(), json, workspaceOf);
    }
    public Publisher producer(ManagedAgentSettings properties) throws ClientException {
        var config = properties.getEventTransport();
        ClientConfiguration clientConfig = clientConfiguration(config);
        verifyLiteTopicCapability(provider, clientConfig, config.getTopic(),
                config.getCapabilityProbeGroup());
        Producer producer = provider.newProducerBuilder()
                .setClientConfiguration(clientConfig)
                .setTopics(config.getTopic())
                .build();
        try {
            verifyTopicAcceptsLiteMessages(provider, producer,
                    config.getTopic());
        } catch (RuntimeException failure) {
            closeQuietly(producer, failure);
            throw failure;
        }
        return new Publisher(producer);
    }

    public EventSubscriptions owner(
            ManagedAgentSettings properties,
            EventMessageListener listener,
            java.util.function.Consumer<EventSubscriptions> bind)
            throws ClientException {
        var config = properties.getEventTransport();
        LitePushConsumer consumer = provider.newLitePushConsumerBuilder()
                .setClientConfiguration(clientConfiguration(config))
                .setConsumerGroup(config.getOwnerGroup())
                .bindTopic(config.getTopic())
                .setMessageListener(message -> com.alibaba.qwen.code.managedagent.adapters.event.RocketMqMessages.consume(listener, message))
                .build();
        bind.accept(com.alibaba.qwen.code.managedagent.adapters.event.RocketMqMessages.subscriptions(consumer));
        return RocketMqMessages.subscriptions(consumer);
    }

    public EventSubscriptions wake(ManagedAgentSettings properties, EventMessageListener listener)
            throws ClientException {
        var config = properties.getEventTransport();
        LitePushConsumer consumer = provider.newLitePushConsumerBuilder()
                .setClientConfiguration(clientConfiguration(config))
                .setConsumerGroup(config.getWakeBootstrapGroup())
                .bindTopic(config.getTopic())
                .setMessageListener(message -> com.alibaba.qwen.code.managedagent.adapters.event.RocketMqMessages.consume(listener, message))
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
                    + " bound to the topic (mqadmin updateSubGroup -c"
                    + " <cluster> -g " + config.getWakeBootstrapGroup()
                    + " -o true --attributes +lite.bind.topic="
                    + config.getTopic() + ")", failure);
        }
        return RocketMqMessages.subscriptions(consumer);
    }
    private static ClientConfiguration clientConfiguration(
            ManagedAgentSettings.EventTransport config) {
        return ClientConfiguration.newBuilder()
                .setEndpoints(config.getEndpoints())
                .build();
    }

    private static void closeQuietly(java.io.Closeable closeable,
            Throwable failure) {
        try {
            closeable.close();
        } catch (Exception suppressed) {
            failure.addSuppressed(suppressed);
        }
    }

    private static void verifyLiteTopicCapability(ClientServiceProvider provider,
            ClientConfiguration clientConfig, String topic, String group) {
        try (LitePushConsumer probe = provider.newLitePushConsumerBuilder()
                .setClientConfiguration(clientConfig)
                .setConsumerGroup(group)
                .bindTopic(topic)
                .setMessageListener(messageView -> ConsumeResult.SUCCESS)
                .build()) {
            probe.subscribeLite(CAPABILITY_PROBE_LITE);
            probe.unsubscribeLite(CAPABILITY_PROBE_LITE);
        } catch (Exception failure) {
            throw new IllegalStateException("the event-transport LiteTopic"
                    + " capability probe failed on topic " + topic + ": the"
                    + " broker must serve LiteTopics (RocketMQ 5.5.0+ with"
                    + " enableLmq) and the probe group " + group
                    + " must be pre-created as a LITE group bound to the topic"
                    + " (mqadmin updateSubGroup -c <cluster> -g " + group
                    + " -o true --attributes +lite.bind.topic=" + topic
                    + "); check qwen.managed-agent.event-transport.endpoints",
                    failure);
        }
    }

    private static void verifyTopicAcceptsLiteMessages(
            ClientServiceProvider provider, Producer producer, String topic) {
        try {
            producer.send(provider.newMessageBuilder()
                    .setTopic(topic)
                    .setLiteTopic(CAPABILITY_PROBE_LITE)
                    .setKeys(CAPABILITY_PROBE_LITE)
                    .setBody("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8))
                    .build());
        } catch (InternalErrorException unavailable) {
            // The broker answered and refused the write itself — a full
            // disk, a stopped store, an HA failover — so the topic's message
            // type is not in question. A type conflict arrives as a
            // BadRequestException instead; naming mqadmin here would send an
            // operator to reconfigure a topic that is already correct.
            throw new IllegalStateException("the event-transport broker"
                    + " is reachable but could not write the probe message"
                    + " to topic " + topic + ": check the broker's disk"
                    + " space and message store, not the topic's message"
                    + " type", unavailable);
        } catch (ClientException | RuntimeException failure) {
            throw new IllegalStateException("the event-transport topic "
                    + topic + " refused a LiteTopic message: create it as a"
                    + " LITE topic (mqadmin updateTopic -c <cluster> -t "
                    + topic + " -a +message.type=LITE)", failure);
        }
    }
}
