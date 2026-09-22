package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/**
 * Executes protocol operations against one attested Runtime lease.
 *
 * <p>Acquire and release must be idempotent by Runtime Session identifier.
 * Execute results must contain a string {@code executionStatus}. Cancel
 * results must contain {@code state} with one of {@code prepared},
 * {@code executing}, {@code cancel_requested}, or {@code settled}; a settled
 * response must also contain a valid execution result. Release acknowledges
 * completion only with {@code true}.
 */
public interface RuntimeTransport {
    CompletionStage<Void> acquire(RuntimeLease lease,
            RuntimeSession session);

    CompletionStage<Object> control(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> operation);

    CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session);
}
