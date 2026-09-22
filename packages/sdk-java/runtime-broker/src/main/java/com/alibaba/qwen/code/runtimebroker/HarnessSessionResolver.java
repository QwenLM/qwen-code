package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletionStage;

/** Resolves the authoritative Runtime scope for one Harness Session. */
public interface HarnessSessionResolver {
    CompletionStage<RuntimeScope> resolve(String harnessSessionId);
}
