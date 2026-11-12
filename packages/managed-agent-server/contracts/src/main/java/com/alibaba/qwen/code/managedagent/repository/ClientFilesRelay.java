package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Binding;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.RegisterOutcome;

import java.util.List;

/**
 * Durable relay state for client filesystem registrations. One binding per
 * Session; re-registration advances the generation so stale browser or
 * Runtime connections can be fenced. Request rows are a bounded TTL queue,
 * not journal records.
 */
public interface ClientFilesRelay {
    default Binding register(String tenantId, String sessionId, String actorId, String serverId,
            String tokenHash, long expiresAt, long now, String connectionId) {
        return registerCapturingPrevious(tenantId, sessionId, actorId, serverId, tokenHash,
                expiresAt, now, connectionId).binding();
    }

    /**
     * Registers atomically and also returns the binding this attempt replaced
     * (null for a first registration), so a refused dispatch can compensate
     * against the exact snapshot it replaced rather than one read earlier
     * outside the lock, which a concurrent registration may have changed.
     */
    RegisterOutcome registerCapturingPrevious(String tenantId, String sessionId, String actorId,
            String serverId, String tokenHash, long expiresAt, long now, String connectionId);

    /**
     * Compensates a refused re-registration by re-activating the previous
     * credential, but only while the failed attempt still owns the active
     * binding (a newer registration or an unregister already committed makes
     * this a no-op). It rewinds to the generation the previous client's
     * downlink was opened with so that client keeps draining; settlement is
     * fenced on the connection identity so a reused generation cannot let an
     * old response settle a new connection's request. Returns whether the
     * compensation was applied.
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

    boolean answer(String tenantId, String sessionId, long generation, String connectionId,
            String requestId, String responseJson, long now);

    boolean fail(String tenantId, String sessionId, long generation, String connectionId,
            String requestId, String errorCode, long now);

    int failQueued(String tenantId, String sessionId, long generation, String errorCode, long now);

    int expireBefore(long now, int limit);

    /**
     * Closes active bindings whose deadline has passed; returns the bindings it
     * actually closed so the caller can tear down each harness catalog.
     */
    List<Binding> closeExpiredBindings(long now, int limit);

    /** Deletes settled request rows older than the retention cutoff. */
    int deleteSettledBefore(long cutoff, int limit);
}
