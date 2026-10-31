package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;

public interface TransportConsumerStore {
    public record WakeFence(String sessionStatus, String workspaceId,
            String headState, long committedSequence, boolean liveWriter) {
        /** Whether a wake may act: an ACTIVE Session with an ACTIVE or SEALED journal head. */
        public boolean open() {
            return "ACTIVE".equals(sessionStatus)
                    && ("ACTIVE".equals(headState) || "SEALED".equals(headState));
        }
    }

    public Optional<WakeFence> wakeFence(String tenantId, String sessionId);

    public Set<String> heldBy(String writerId, String tenantId,
            List<String> sessionIds);

    public boolean claimWake(String tenantId, String sessionId,
            long sequence);

    public OptionalLong materializedThrough(String tenantId,
            String sessionId);

    public Optional<String> workspaceOf(String tenantId, String sessionId);
}
