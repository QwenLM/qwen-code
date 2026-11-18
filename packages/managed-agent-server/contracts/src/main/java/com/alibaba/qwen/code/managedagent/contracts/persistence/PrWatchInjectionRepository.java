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
     * Records the admission of the staged injection owned by
     * {@code sessionId}. Returns null when no staged row matches that
     * identity — absent, already admitted, or re-staged under another
     * Session — so a concurrent rebind surfaces as a conflict instead of
     * flipping the other Session's row.
     */
    public PrWatchInjection admit(String tenantId, String inputId,
            String sessionId);

    /**
     * Releases a merely staged injection (receipt and operation) so the
     * identity can be re-staged under a new binding. The caller must first
     * prove the pinned Session never committed (a replay against it that
     * cannot answer): a staged row whose Harness call did commit reserves
     * the occurrence for that Session. A dead binding must not block the PR
     * forever. Returns false when the row is absent or already admitted (an
     * admitted row permanently reserves the identity).
     */
    public boolean releaseStaged(String tenantId, String inputId);
}
