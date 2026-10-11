package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.util.List;

/**
 * Distribution adapter behind the after-commit seam (design
 * 2026-10-04-managed-agent-event-transport, phase MQ1). Implementations carry
 * copies of committed facts to other nodes; the local SessionEventHub fan-out
 * does not depend on them. MQ1 ships no implementation.
 */
public interface EventTransport {
    void publish(List<EventRecord> events);
}
