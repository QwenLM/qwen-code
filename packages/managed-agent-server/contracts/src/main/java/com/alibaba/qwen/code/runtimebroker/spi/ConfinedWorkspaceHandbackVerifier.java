package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.util.concurrent.CompletionStage;

public interface ConfinedWorkspaceHandbackVerifier {
    CompletionStage<Void> verifyConfinedHandback(RuntimeBindingRecord binding);
}
