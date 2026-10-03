package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import java.time.Clock;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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

    /**
     * Consecutive per-session failures after which the stuck projection is
     * surfaced once at ERROR. The session keeps being retried on the capped
     * backoff, and a later success resets it.
     */
    private static final int STUCK_FAILURE_BUDGET = 10;
    private static final long MAX_BACKOFF_MS = 60_000;

    private final AgentStateStore store;
    private final Clock clock;
    private final Map<String, SessionFailure> failures =
            new ConcurrentHashMap<>();

    private record SessionFailure(int count, long retryAfter,
            boolean surfaced) {
    }

    public MessageMaterializer(AgentStateStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.events.materialize-interval:100ms}")
    public void materialize() {
        long now = clock.millis();
        List<MaterializationTarget> targets =
                store.findMaterializationTargets(TARGET_LIMIT);
        // A session that stopped being a target (caught up or deleted) never
        // fails again; drop its entry so the map tracks only live failures.
        if (!failures.isEmpty()) {
            Set<String> live = new HashSet<>();
            for (MaterializationTarget target : targets) {
                live.add(target.tenantId() + "\n" + target.sessionId());
            }
            failures.keySet().removeIf(key -> !live.contains(key));
        }
        for (MaterializationTarget target : targets) {
            String key = target.tenantId() + "\n" + target.sessionId();
            SessionFailure failure = failures.get(key);
            if (failure != null && now < failure.retryAfter()) {
                continue;
            }
            try {
                store.materializeNextBatch(target.tenantId(),
                        target.sessionId(), EVENT_LIMIT);
                failures.remove(key);
            } catch (RuntimeException error) {
                // A deterministic failure (e.g. an unreadable event row)
                // must not retry at the scan rate forever: back off
                // exponentially, and surface the stuck projection once.
                int count = (failure == null ? 0 : failure.count()) + 1;
                long backoff = Math.min(MAX_BACKOFF_MS,
                        100L << Math.min(count - 1, 10));
                boolean surfaced = failure != null && failure.surfaced();
                boolean surface = count >= STUCK_FAILURE_BUDGET && !surfaced;
                failures.put(key, new SessionFailure(count,
                        now + backoff, surfaced || surface));
                if (surface) {
                    LOG.error("Managed Agent session {} projection is stuck"
                                    + " after {} consecutive failures;"
                                    + " retrying on a capped backoff",
                            target.sessionId(), count, error);
                } else {
                    LOG.warn("Failed to materialize Managed Agent session {}",
                            target.sessionId(), error);
                }
            }
        }
    }
}
