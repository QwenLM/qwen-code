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
    // Selection gate for failing targets: retry on streaks 1, 2, 4, ...,
    // capped. Between retries the target is rotated behind fresher rows,
    // so a poisoned session can neither starve healthy ones nor warn at
    // 10 Hz forever.
    private static final int MAX_BACKOFF_STREAK = 64;
    private final AgentStateStore store;
    private final Map<String, Integer> failures = new ConcurrentHashMap<>();

    public MessageMaterializer(AgentStateStore store) {
        this.store = store;
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.events.materialize-interval:100ms}")
    public void materialize() {
        for (MaterializationTarget target :
                store.findMaterializationTargets(TARGET_LIMIT)) {
            String key = target.tenantId() + ":" + target.sessionId();
            int streak = failures.getOrDefault(key, 0);
            if (streak > 0) {
                store.deferMaterializationTarget(target.tenantId(),
                        target.sessionId());
                if (streak < MAX_BACKOFF_STREAK
                        && (streak & (streak - 1)) != 0) {
                    failures.put(key, streak + 1);
                    continue;
                }
            }
            try {
                store.materializeNextBatch(target.tenantId(),
                        target.sessionId(), EVENT_LIMIT);
                failures.remove(key);
            } catch (RuntimeException error) {
                failures.put(key, Math.min(streak + 1, MAX_BACKOFF_STREAK));
                store.deferMaterializationTarget(target.tenantId(),
                        target.sessionId());
                LOG.warn("Failed to materialize Managed Agent session {}",
                        target.sessionId(), error);
            }
        }
    }
}
