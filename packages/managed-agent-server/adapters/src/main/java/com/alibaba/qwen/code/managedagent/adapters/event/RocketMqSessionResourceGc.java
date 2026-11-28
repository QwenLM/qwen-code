package com.alibaba.qwen.code.managedagent.adapters.event;

import org.apache.rocketmq.client.apis.ClientConfiguration;
import org.apache.rocketmq.client.apis.ClientException;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.consumer.FilterExpression;
import org.apache.rocketmq.client.apis.consumer.PushConsumer;
import org.apache.rocketmq.client.apis.message.MessageView;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.function.BiConsumer;

/** Best-effort signals for work already recorded in MySQL. */
public final class RocketMqSessionResourceGc implements Closeable {
    private static final Logger LOG = LoggerFactory.getLogger(RocketMqSessionResourceGc.class);
    private static final String TENANT = "tenantId";
    private static final String SESSION = "sessionId";

    private final ClientServiceProvider provider = ClientServiceProvider.loadService();
    private final ClientConfiguration configuration;
    private final String topic;
    private final String group;
    private final BiConsumer<String, String> worker;
    private volatile Producer producer;
    private PushConsumer consumer;
    private boolean closed;

    public RocketMqSessionResourceGc(String endpoints, String topic, String group,
            BiConsumer<String, String> worker) {
        this.configuration = ClientConfiguration.newBuilder().setEndpoints(endpoints)
                .setRequestTimeout(Duration.ofSeconds(3)).build();
        this.topic = topic;
        this.group = group;
        this.worker = worker;
    }

    public synchronized void connect() {
        if (closed) {
            return;
        }
        if (producer == null) {
            try {
                producer = provider.newProducerBuilder().setClientConfiguration(configuration)
                        .setTopics(topic).build();
            } catch (ClientException | RuntimeException failure) {
                LOG.warn("Session resource GC producer unavailable for topic {}, SQL polling remains active",
                        topic, failure);
            }
        }
        if (worker != null && consumer == null) {
            try {
                consumer = provider.newPushConsumerBuilder().setClientConfiguration(configuration)
                        .setConsumerGroup(group).setSubscriptionExpressions(Map.of(topic, FilterExpression.SUB_ALL))
                        .setConsumptionThreadCount(1).setMessageListener(this::receive).build();
            } catch (ClientException | RuntimeException failure) {
                LOG.warn("Session resource GC consumer unavailable for group {}, SQL polling remains active",
                        group, failure);
            }
        }
    }

    public void publish(String tenant, String session, Duration grace) {
        Producer client = producer;
        if (client == null) {
            return;
        }
        long delivery = Math.addExact(System.currentTimeMillis(), Math.max(1000L, grace.toMillis()));
        client.sendAsync(provider.newMessageBuilder().setTopic(topic).setDeliveryTimestamp(delivery)
                .addProperty(TENANT, tenant).addProperty(SESSION, session).setBody(new byte[] {1}).build())
                .whenComplete((receipt, failure) -> {
                    if (failure != null) {
                        LOG.warn("Session resource GC wakeup publish failed tenant={} session={}",
                                tenant, session, failure);
                    }
                });
    }

    private ConsumeResult receive(MessageView message) {
        String tenant = message.getProperties().get(TENANT);
        String session = message.getProperties().get(SESSION);
        if (tenant == null || tenant.isBlank() || tenant.length() > 36
                || session == null || session.isBlank() || session.length() > 64) {
            return ConsumeResult.SUCCESS;
        }
        try {
            worker.accept(tenant, session);
            return ConsumeResult.SUCCESS;
        } catch (RuntimeException failure) {
            LOG.warn("Session resource GC wakeup processing failed tenant={} session={}", tenant, session, failure);
            return ConsumeResult.FAILURE;
        }
    }

    @Override
    public synchronized void close() throws IOException {
        closed = true;
        Producer client = producer;
        producer = null;
        try {
            if (consumer != null) {
                consumer.close();
            }
        } finally {
            if (client != null) {
                client.close();
            }
        }
    }
}
