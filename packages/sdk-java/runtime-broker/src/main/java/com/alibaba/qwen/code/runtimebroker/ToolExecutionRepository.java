package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;

/** Persistence boundary for idempotent Tool execution state. */
public interface ToolExecutionRepository {
    ToolExecutionRecord findOrCreate(ToolExecutionRecord candidate);

    ToolExecutionRecord findByExecutionCallId(String executionCallId);

    ToolExecutionRecord findByIdempotencyKey(String idempotencyKey);

    /** Mutates only while the caller holds the live dispatch claim. */
    ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement);

    /** Taking over an expired EXECUTING claim yields UNKNOWN, not a claim. */
    ToolExecutionRecord claimDispatch(String executionCallId, String owner,
            Duration leaseDuration);

    ToolExecutionRecord renewDispatch(String executionCallId, String owner,
            long dispatchGeneration, Duration leaseDuration);

    /** Records cancellation intent without requiring the dispatch claim. */
    ToolExecutionRecord requestCancel(String executionCallId,
            long expectedVersion);

    /** Settles an UNKNOWN execution through recovery reconciliation. */
    ToolExecutionRecord resolveUnknown(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime);

    boolean hasActiveByRuntimeSession(String runtimeSessionId);
}
