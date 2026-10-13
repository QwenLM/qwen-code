package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.LiteTopicEventTransport;
import org.apache.rocketmq.client.apis.ClientConfiguration;
import org.apache.rocketmq.client.apis.ClientException;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the authoritative-journal broker transport (design
 * 2026-10-04-managed-agent-event-transport, phase MQ2b). The bean exists only
 * when {@code qwen.managed-agent.event-transport.enabled=true}, so a flag-off
 * deployment creates no transport and stays byte-identical — the MQ2 exit
 * check is an inspectable property of this class, not a claim.
 */
@Configuration
public class EventTransportConfiguration {
    // A throwaway group + lite topic used only by the startup capability probe.
    private static final String CAPABILITY_PROBE_GROUP =
            "qwen-managed-journal-capability-probe";
    private static final String CAPABILITY_PROBE_LITE = "capability-probe";

    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(prefix = "qwen.managed-agent.event-transport",
            name = "enabled", havingValue = "true")
    public LiteTopicEventTransport liteTopicEventTransport(
            ManagedAgentProperties properties) throws ClientException {
        var config = properties.getEventTransport();
        ClientServiceProvider provider = ClientServiceProvider.loadService();
        ClientConfiguration clientConfig = ClientConfiguration.newBuilder()
                .setEndpoints(config.getEndpoints())
                .build();
        verifyLiteTopicCapability(provider, clientConfig, config.getTopic());
        Producer producer = provider.newProducerBuilder()
                .setClientConfiguration(clientConfig)
                .setTopics(config.getTopic())
                .build();
        return new LiteTopicEventTransport(producer, provider, config.getTopic());
    }

    // #13200 hardening: fail fast at startup on a broker that cannot serve
    // LiteTopics (needs RocketMQ 5.5.0+ with enableLmq), instead of silently
    // degrading to a classic topic. The probe subscribes and unsubscribes; no
    // message is written. Building the consumer also catches an unreachable or
    // non-gRPC (classic 4.x) broker.
    //
    // Deployment prerequisite: the probe group must be pre-created as a LITE
    // group bound to the topic, because subscribeLite rejects an auto-created
    // (regular) group with "regular group cannot use LITE mode":
    //   mqadmin updateSubGroup -g qwen-managed-journal-capability-probe \
    //     -o true --attributes +lite.bind.topic=<topic>
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
