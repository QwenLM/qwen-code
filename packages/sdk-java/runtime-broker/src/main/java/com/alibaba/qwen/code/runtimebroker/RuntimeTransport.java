package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/** Executes protocol operations against one attested Runtime lease. */
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
