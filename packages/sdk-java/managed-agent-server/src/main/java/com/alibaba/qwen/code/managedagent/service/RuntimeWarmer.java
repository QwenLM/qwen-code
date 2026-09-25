package com.alibaba.qwen.code.managedagent.service;

import java.util.concurrent.CompletionStage;

public interface RuntimeWarmer {
    boolean isEnabled();

    CompletionStage<Void> warm(String sessionId);

    CompletionStage<Void> drain(String sessionId);

    void resume(String sessionId);
}
