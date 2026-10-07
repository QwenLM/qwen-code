package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class MessageMaterializer {
    private static final Logger LOG = LoggerFactory.getLogger(
            MessageMaterializer.class);
    private static final int TARGET_LIMIT = 32;
    private static final int EVENT_LIMIT = 200;
    // Selection gate for failing targets: attempt (and warn) again only on
    // streaks 1, 2, 4, 8, ... so the cadence keeps halving for a poisoned
    // row. A skipped pass rotates the target behind fresher rows; nothing
    // else is deferred, so one pass costs at most one queue update.
    private final AgentStateStore store;
    private final Map<String, Long> failures = new ConcurrentHashMap<>();

    public MessageMaterializer(AgentStateStore store) {
        this.store = store;
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.events.materialize-interval:100ms}")
    public void materialize() {
        for (MaterializationTarget target :
                store.findMaterializationTargets(TARGET_LIMIT)) {
            String key = target.tenantId() + ":" + target.sessionId();
            long streak = failures.getOrDefault(key, 0L);
            if (streak > 0 && (streak & (streak - 1)) != 0) {
                // Not yet due: push the row behind fresher ones and count
                // the skip; the power-of-two passes attempt again.
                store.deferMaterializationTarget(target.tenantId(),
                        target.sessionId());
                failures.put(key, streak + 1);
                continue;
            }
            try {
                store.materializeNextBatch(target.tenantId(),
                        target.sessionId(), EVENT_LIMIT);
                failures.remove(key);
            } catch (RuntimeException error) {
                failures.put(key, streak + 1);
                store.deferMaterializationTarget(target.tenantId(),
                        target.sessionId());
                LOG.warn("Failed to materialize Managed Agent session {}",
                        target.sessionId(), error);
            }
        }
    }
}
