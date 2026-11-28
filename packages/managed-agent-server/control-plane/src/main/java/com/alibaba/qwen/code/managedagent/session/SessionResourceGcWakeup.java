package com.alibaba.qwen.code.managedagent.session;

@FunctionalInterface
public interface SessionResourceGcWakeup {
    void retired(String tenant, String session);
}
