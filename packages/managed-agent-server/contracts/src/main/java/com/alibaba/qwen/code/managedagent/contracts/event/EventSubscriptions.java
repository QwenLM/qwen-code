package com.alibaba.qwen.code.managedagent.contracts.event;

import java.util.Set;
public interface EventSubscriptions extends java.io.Closeable {
    Set<String> getLiteTopicSet();
    void subscribeLite(String topic) throws Exception;
    void unsubscribeLite(String topic) throws Exception;
}
