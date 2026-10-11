package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import java.util.List;
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
    // up to the cap, and once every MAX_BACKOFF_STREAK passes at and past
    // it. A skipped pass rotates the target behind fresher rows only when
    // a row sits behind the selection window — at or below the limit the
    // same rows are selected again whatever their order, so the write would
    // buy nothing — and the catch already rotates after a failed attempt.
    // Only the exponential phase warns with the stack, so a poisoned
    // session can neither starve healthy ones nor warn at 10 Hz forever.
    private static final int MAX_BACKOFF_STREAK = 64;
    private final AgentStateStore store;
    private final Map<String, Integer> failures = new ConcurrentHashMap<>();

    public MessageMaterializer(AgentStateStore store) {
        this.store = store;
    }

    // Blocking JDBC rotation writes must never occupy the one-thread
    // default pool that carries the dispatch scan and lease recovery.
    @Scheduled(scheduler = "managedMaterializationScheduler",
            fixedDelayString =
                    "${qwen.managed-agent.events.materialize-interval:100ms}")
    public void materialize() {
        // Saturation means a row sits behind the selection window, so
        // probe one row past the limit rather than inferring it from an
        // exactly-full window.
        List<MaterializationTarget> targets =
                store.findMaterializationTargets(TARGET_LIMIT + 1);
        boolean saturated = targets.size() > TARGET_LIMIT;
        for (MaterializationTarget target
                : targets.subList(0, Math.min(TARGET_LIMIT, targets.size()))) {
            String key = target.tenantId() + ":" + target.sessionId();
            int streak = failures.getOrDefault(key, 0);
            if (streak > 0) {
                boolean due = streak < MAX_BACKOFF_STREAK
                        ? (streak & (streak - 1)) == 0
                        : streak % MAX_BACKOFF_STREAK == 0;
                if (!due) {
                    if (saturated) {
                        deferQuietly(target);
                    }
                    failures.put(key, streak + 1);
                    continue;
                }
            }
            try {
                store.materializeNextBatch(target.tenantId(),
                        target.sessionId(), EVENT_LIMIT);
                failures.remove(key);
            } catch (RuntimeException error) {
                failures.put(key, streak + 1);
                deferQuietly(target);
                if (streak < MAX_BACKOFF_STREAK) {
                    LOG.warn("Failed to materialize Managed Agent session {}",
                            target.sessionId(), error);
                } else {
                    // Past the cap an attempt fires every half minute; keep
                    // the signal but drop the repetitive stack.
                    LOG.warn("Failed to materialize Managed Agent session {}: {}",
                            target.sessionId(), error.toString());
                }
            }
        }
    }

    // A store fault while rotating a target must degrade that one target,
    // not abort the pass for every other selected session. The warn never
    // carries the stack: a persistently faulting rotation fires at
    // scheduler rate, and the stack buys nothing per pass.
    private void deferQuietly(MaterializationTarget target) {
        try {
            store.deferMaterializationTarget(target.tenantId(),
                    target.sessionId());
        } catch (RuntimeException deferError) {
            LOG.warn("Failed to defer Managed Agent session {}: {}",
                    target.sessionId(), deferError.toString());
        }
    }
}
