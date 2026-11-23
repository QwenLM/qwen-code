package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;
import java.util.Optional;

/**
 * The PR-watch binding catalog: one watched pull request per channel
 * instance bound to an existing Managed Session (design
 * 2026-11-17-managed-github-pr-watch-bound-session, D2). A plain SQL row,
 * not an extension-record domain; the channel route catalog is untouched.
 */
public interface PrWatchBindingStore {
    public record PrWatchBinding(String tenantId, String channelId,
            String bindingId, String owner, String repo, long prNumber,
            String sessionId, String eventsJson, long createdAt) {
    }

    /** Inserts the binding, or keeps the first one a racing create won. */
    public PrWatchBinding bind(PrWatchBinding candidate);

    public Optional<PrWatchBinding> findBinding(String tenantId,
            String channelId, String owner, String repo, long prNumber);

    /** Oldest first by (createdAt, bindingId); the adapter's watch set. */
    public List<PrWatchBinding> listByChannel(String tenantId,
            String channelId);

    /** Deletes the binding; false when no row held the business key. */
    public boolean retire(String tenantId, String channelId, String owner,
            String repo, long prNumber);
}
