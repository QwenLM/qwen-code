package com.alibaba.qwen.code.runtimebroker.spi;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/**
 * Operator-run placement service for Session-exclusive tool workers. The
 * provider owns only the physical lifecycle; the Broker mints identity and
 * attests every endpoint it returns.
 */
public interface ExternalRuntimeClient {
    /** Idempotent on {@code provisionRequestId}; returns {@code handle} and {@code endpoint}. */
    public CompletionStage<Map<String, Object>> provision(Map<String, Object> request);

    /** Returns {@code state} RUNNING, STARTING, GONE or UNKNOWN, and {@code endpoint} when RUNNING. */
    public CompletionStage<Map<String, Object>> observe(Map<String, Object> request);
}
