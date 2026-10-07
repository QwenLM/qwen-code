package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayFloorTarget;
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
        for (ReplayFloorTarget target :
                store.findReplayFloorTargets(TARGET_LIMIT)) {
            try {
                // MAX_VALUE asks for as far as the Snapshot proves safe; the
                // store clamps the floor to the Snapshot's covered sequence.
                store.advanceReplayFloor(target.tenantId(), target.sessionId(),
                        Long.MAX_VALUE);
            } catch (RuntimeException error) {
                LOG.warn("Failed to advance the replay floor of Managed Agent"
                        + " session {}", target.sessionId(), error);
            }
        }
    }
}
