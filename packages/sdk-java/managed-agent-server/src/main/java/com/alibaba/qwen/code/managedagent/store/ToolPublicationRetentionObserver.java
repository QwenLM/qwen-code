package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import java.util.HashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;

public final class ToolPublicationRetentionObserver {
    private static final Logger LOG = LoggerFactory.getLogger(ToolPublicationRetentionObserver.class);
    private final ToolPublicationRetentionStore retention;
    private final ManagedAgentProperties properties;

    public ToolPublicationRetentionObserver(ToolPublicationRetentionStore retention, ManagedAgentProperties properties) {
        this.retention = retention;
        this.properties = properties;
    }

    @Scheduled(fixedDelay = 60_000, scheduler = "managedToolOutputScheduler")
    public void tick() {
        try {
            var sample = retention.observe(properties.getToolPublication().getDeletionGrace());
            Map<String, Long> blockers = new HashMap<>();
            long eligibleBytes = 0;
            for (var candidate : sample) {
                blockers.merge(candidate.blocker() == null ? "eligible" : candidate.blocker(), 1L, Long::sum);
                if (candidate.blocker() == null) {
                    eligibleBytes += candidate.bytes();
                }
            }
            LOG.info("tool_output_retention sample={} eligible_bytes={} reasons={}", sample.size(), eligibleBytes, blockers);
        } catch (RuntimeException error) {
            LOG.warn("Tool output retention observation failed", error);
        }
    }
}
