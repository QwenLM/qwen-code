package com.alibaba.qwen.code.managedagent.contracts.persistence;

import java.util.Optional;

/**
 * Persistence boundary for the PR-watch injection ledger: one row per
 * derived input identity (tenant, channel instance, owner, repo, PR number,
 * transition, head SHA, episode). The receipt fixes the durable envelope before the
 * Harness commit; the operation owns the admission, so a crash between the
 * Harness commit and the ledger replays to the same admission (the channel
 * ingress discipline, design 2026-11-17-managed-github-pr-watch-bound-session).
 */
public interface PrWatchInjectionRepository {
    /** The states an injection row can be in. */
    java.util.List<String> INJECTION_STATES = java.util.List.of("staged", "admitted");

    /** One pinned injection: the envelope as first admitted, any state. */
    public record PrWatchInjection(
            String tenantId,
            String inputId,
            String channelInstanceId,
            String bindingId,
            String sessionId,
            String owner,
            String repo,
            long prNumber,
            String transition,
            String headSha,
            long episode,
            String evidence,
            String text,
            String state,
            long createdAt,
            long updatedAt) {
    }

    /**
     * Inserts the candidate, or returns the row its input identity already
     * committed. A redelivery of one transition adds nothing.
     */
    public PrWatchInjection findOrCreate(PrWatchInjection candidate);

    public Optional<PrWatchInjection> find(String tenantId, String inputId);

    /**
     * Records the admission of a staged injection. Returns null when the
     * row is absent; a replay of an admitted row returns the current row.
     */
    public PrWatchInjection admit(String tenantId, String inputId);
}
