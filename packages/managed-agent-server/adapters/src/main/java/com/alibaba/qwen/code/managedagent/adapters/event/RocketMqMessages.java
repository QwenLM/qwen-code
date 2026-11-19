package com.alibaba.qwen.code.managedagent.adapters.event;

import com.alibaba.qwen.code.managedagent.contracts.event.EventMessageListener;
import com.alibaba.qwen.code.managedagent.contracts.event.EventSubscriptions;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.message.MessageView;

import java.io.IOException;
import java.util.Set;
public final class RocketMqMessages {
    private RocketMqMessages() { }
    public static ConsumeResult consume(EventMessageListener listener, MessageView message) {
        var buffer = message.getBody().duplicate();
        byte[] bytes = new byte[buffer.remaining()];
        buffer.get(bytes);
        listener.consume(bytes, message.getMessageId().toString());
        return ConsumeResult.SUCCESS;
    }
    public static EventSubscriptions subscriptions(LitePushConsumer consumer) {
        return new EventSubscriptions() {
            public Set<String> getLiteTopicSet() { return consumer.getLiteTopicSet(); }
            public void subscribeLite(String topic) throws Exception { consumer.subscribeLite(topic); }
            public void unsubscribeLite(String topic) throws Exception { consumer.unsubscribeLite(topic); }
            public void close() throws IOException { consumer.close(); }
        };
    }
}
