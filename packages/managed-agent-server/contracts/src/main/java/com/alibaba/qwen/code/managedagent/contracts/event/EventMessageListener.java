package com.alibaba.qwen.code.managedagent.contracts.event;

@FunctionalInterface
public interface EventMessageListener {
    void consume(byte[] body, String messageId);
}
