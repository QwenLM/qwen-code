package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/** Executes the existing Managed Runtime v1/v2 protocol for the Broker. */
public interface RuntimeTransport {
    CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session);

    CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> operation);

    CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    CompletionStage<Map<String, Object>> status(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence);

    CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference);

    CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session);
}
