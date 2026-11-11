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
            String tokenHash, long expiresAt, long now);

    /**
     * Re-activates a previous binding exactly (generation, credential digest,
     * deadline) after a re-registration's harness dispatch was refused, so the
     * still-installed harness leg keeps serving instead of being fenced to a
     * credential it never received.
     */
    void restore(String tenantId, String sessionId, Binding previous, long now);

    Binding find(String tenantId, String sessionId);

    /** The internal MCP leg knows only the Session; the credential fences it. */
    Binding findBySession(String sessionId);

    boolean close(String tenantId, String sessionId, long expectedGeneration, long now);

    void enqueue(String tenantId, String sessionId, long generation, String requestId,
            String payloadJson, long expiresAt, long now);

    int queuedCount(String tenantId, String sessionId, long generation, long now);

    List<QueuedRequest> queued(String tenantId, String sessionId, long generation, int limit);

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
