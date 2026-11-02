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

    /**
     * Reattaches the provider to the persisted original Worker after a
     * provider-process restart. The request carries the original boot, scope,
     * handle and endpoint; implementations must never provision a replacement.
     */
    public CompletionStage<Map<String, Object>> reattach(Map<String, Object> request);
}
