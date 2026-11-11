package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Binding;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;

import java.util.List;

/**
 * Durable relay state for client filesystem registrations. One binding per
 * Session; re-registration advances the generation so stale browser or
 * Runtime connections can be fenced. Request rows are a bounded TTL queue,
 * not journal records.
 */
public interface ClientFilesRelay {
    Binding register(String tenantId, String sessionId, String actorId, String serverId,
            String tokenHash, long expiresAt, long now, String connectionId);

    /**
     * Compensates a refused re-registration by re-activating the previous
     * credential, but only while the failed attempt still owns the active
     * binding (a newer registration or an unregister already committed makes
     * this a no-op). The restored binding advances to a fresh monotonic
     * generation so a new client never reuses the failed attempt's request
     * namespace. Returns whether the compensation was applied.
     */
    boolean restore(String tenantId, String sessionId, long failedGeneration, Binding previous,
            long now);

    Binding find(String tenantId, String sessionId);

    /** The internal MCP leg knows only the Session; the credential fences it. */
    Binding findBySession(String sessionId);

    boolean close(String tenantId, String sessionId, long expectedGeneration, long now);

    void enqueue(String tenantId, String sessionId, long generation, String requestId,
            String payloadJson, long expiresAt, long now);

    int queuedCount(String tenantId, String sessionId, long generation, long now);

    List<QueuedRequest> queued(String tenantId, String sessionId, long generation, int limit,
            long now);

    QueuedRequest request(String tenantId, String sessionId, long generation, String requestId);

    boolean answer(String tenantId, String sessionId, long generation, String requestId,
            String responseJson, long now);

    boolean fail(String tenantId, String sessionId, long generation, String requestId,
            String errorCode, long now);

    int failQueued(String tenantId, String sessionId, long generation, String errorCode, long now);

    int expireBefore(long now, int limit);

    /** Closes active bindings whose deadline has passed; returns the count. */
    int closeExpiredBindings(long now, int limit);

    /** Deletes settled request rows older than the retention cutoff. */
    int deleteSettledBefore(long cutoff, int limit);

    void deleteSession(String tenantId, String sessionId);
}
