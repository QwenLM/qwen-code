package com.alibaba.qwen.code.managedagent.persistence;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Sweeper for journal compaction (S1b). Every pass is a no-op unless session-resource OSS
 * storage is enabled; pack building and grace deletion are additionally gated by their own
 * flags so a deployment can publish packs long before it deletes any SQL blob.
 */
@Component
public class JournalCompactionCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(JournalCompactionCoordinator.class);
    private final JdbcJournalPacks packs;

    public JournalCompactionCoordinator(JdbcJournalPacks packs) {
        this.packs = packs;
    }

    @Scheduled(scheduler = "journalCompactionScheduler",
            fixedDelayString = "${qwen.managed-agent.session-resources.scan-delay:30s}")
    public void sweep() {
        try {
            packs.sweep();
        } catch (RuntimeException error) {
            // A failed sweep must not kill the scheduler; the next pass retries.
            LOG.warn("Journal compaction sweep failed; the next scheduled pass retries", error);
        }
    }
}
