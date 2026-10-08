package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayFloorTarget;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Raises each Session's replay floor as far as its Snapshot proves safe, the
 * first half of the Session event retention work (#12380): events at or below
 * the floor may be pruned later, and a replay cursor below it expires while
 * the Snapshot backs the floor.
 * Nothing deletes events here, and the pass is disabled until a deployment
 * opts in; the retention window and the reader-aware cleanup remain separate
 * decisions.
 */
@Component
public class ReplayFloorAdvancer {
    private static final Logger LOG = LoggerFactory.getLogger(
            ReplayFloorAdvancer.class);
    private static final int TARGET_LIMIT = 64;
    private final AgentStateStore store;
    private final ManagedAgentProperties properties;

    public ReplayFloorAdvancer(AgentStateStore store,
            ManagedAgentProperties properties) {
        this.store = store;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.events.replay-floor-interval:60s}")
    public void advance() {
        if (!properties.getEvents().isReplayFloorEnabled()) {
            return;
        }
        // A pass drains the backlog, not just the first batch: the candidate
        // query orders by updated_at, which the advance never moves, so a
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
                    // MAX_VALUE asks for as far as the Snapshot proves safe;
                    // the store clamps the floor to the covered sequence.
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
