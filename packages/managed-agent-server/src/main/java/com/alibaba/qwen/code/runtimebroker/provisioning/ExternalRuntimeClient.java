package com.alibaba.qwen.code.runtimebroker.provisioning;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/**
 * Operator-run placement service for Session-exclusive tool workers. The
 * provider owns only the physical lifecycle; the Broker mints identity and
 * attests every endpoint it returns.
 */
public interface ExternalRuntimeClient {
    /** Idempotent on {@code provisionRequestId}; returns {@code handle} and {@code endpoint}. */
    CompletionStage<Map<String, Object>> provision(Map<String, Object> request);

    /** Returns {@code state} RUNNING, STARTING, GONE or UNKNOWN, and {@code endpoint} when RUNNING. */
    CompletionStage<Map<String, Object>> observe(Map<String, Object> request);

    default CompletionStage<Map<String, Object>> retire(Map<String, Object> request) {
        return java.util.concurrent.CompletableFuture.failedFuture(new IllegalStateException("Provider retirement is unavailable"));
    }
}
