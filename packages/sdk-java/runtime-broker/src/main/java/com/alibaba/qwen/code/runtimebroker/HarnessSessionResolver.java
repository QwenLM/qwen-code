package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletionStage;

/**
 * Resolves the authoritative Runtime scope for one Harness Session.
 *
 * <p>The returned scope must remain stable for the lifetime of every Runtime
 * Session created under it. A genuine scope change requires a new Runtime
 * Session identity.
 */
public interface HarnessSessionResolver {
    CompletionStage<RuntimeScope> resolve(String harnessSessionId);
}
