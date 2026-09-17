package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletionStage;

/** Resolves an authenticated Harness Session into Java-owned placement scope. */
@FunctionalInterface
public interface HarnessSessionResolver {
    CompletionStage<RuntimeScope> resolve(String harnessSessionId);
}
