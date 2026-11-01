package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.EventProjectionStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Advances replay floors through message projection coverage when explicitly enabled. */
@Component
public class ReplayFloorAdvancer {
    private static final Logger LOG = LoggerFactory.getLogger(
            ReplayFloorAdvancer.class);
    private static final int TARGET_LIMIT = 64;
    private final EventProjectionStore store;
    private final ManagedAgentSettings properties;

    public ReplayFloorAdvancer(EventProjectionStore store,
            ManagedAgentSettings properties) {
        this.store = store;
        this.properties = properties;
    }

    @Scheduled(scheduler = "replayFloorScheduler", fixedDelayString =
            "${qwen.managed-agent.events.replay-floor-interval:60s}")
    public void advance() {
        if (!properties.getEvents().isReplayFloorEnabled()) {
            return;
        }
        // A pass drains the backlog, not just the first batch: the candidate
        // query orders by gmt_modified, which the advance never moves, so a
        // Session that keeps appending would sort last of every full batch
        // and starve while more than TARGET_LIMIT candidates remain. A target
        // whose advance keeps failing stays a candidate, so the attempted set
        // keeps it from wedging the pass.
        Set<ReplayFloorTarget> attempted = new HashSet<>();
        while (true) {
            List<ReplayFloorTarget> batch =
                    store.findReplayFloorTargets(TARGET_LIMIT);
            boolean fresh = false;
            for (ReplayFloorTarget target : batch) {
                if (!attempted.add(target)) {
                    continue;
                }
                fresh = true;
                try {
                    // The store clamps the requested floor to readable projection coverage.
                    store.advanceReplayFloor(target.tenantId(),
                            target.sessionId(), Long.MAX_VALUE);
                } catch (RuntimeException error) {
                    LOG.warn("Failed to advance the replay floor of Managed"
                            + " Agent session {}", target.sessionId(), error);
                }
            }
            if (!fresh || batch.size() < TARGET_LIMIT) {
                return;
            }
        }
    }
}
