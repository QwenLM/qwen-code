package com.alibaba.qwen.code.managedagent.persistence;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Sweeper for journal compaction (S1b). Every pass is a no-op unless session-resource OSS
 * storage is enabled; pack building and grace deletion are additionally gated by their own
 * flags so a deployment can publish packs long before it deletes any SQL blob.
 */
@Component
public class JournalCompactionCoordinator {
    private final JdbcJournalPacks packs;

    public JournalCompactionCoordinator(JdbcJournalPacks packs) {
        this.packs = packs;
    }

    @Scheduled(scheduler = "managedAgentScheduler",
            fixedDelayString = "${qwen.managed-agent.session-resources.scan-delay:30s}")
    public void sweep() {
        packs.sweep();
    }
}
