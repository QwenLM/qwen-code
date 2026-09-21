package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;

/** Persistence boundary for idempotent Tool execution state. */
public interface ToolExecutionRepository {
    ToolExecutionRecord findOrCreate(ToolExecutionRecord candidate);

    ToolExecutionRecord findByExecutionCallId(String executionCallId);

    ToolExecutionRecord findByIdempotencyKey(String idempotencyKey);

    ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement);

    ToolExecutionRecord claimDispatch(String executionCallId, String owner,
            Duration leaseDuration);

    ToolExecutionRecord renewDispatch(String executionCallId, String owner,
            long dispatchGeneration, Duration leaseDuration);

    boolean hasActiveByRuntimeSession(String runtimeSessionId);
}
