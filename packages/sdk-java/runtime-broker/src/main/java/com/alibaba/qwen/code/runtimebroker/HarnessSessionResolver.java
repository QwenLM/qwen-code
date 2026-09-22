package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletionStage;

/**
 * Resolves an authenticated Harness Session into Java-owned placement scope.
 *
 * <p>The returned scope must remain stable for the lifetime of every Runtime
 * Session created under it. A genuine scope change requires a new Runtime
 * Session identity.
 */
@FunctionalInterface
public interface HarnessSessionResolver {
    CompletionStage<RuntimeScope> resolve(String harnessSessionId);
}
