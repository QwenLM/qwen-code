package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;

import java.util.Map;
import java.util.Optional;

public interface ManagedAgentDefinitionStore {
    public static final class ConcurrentWriteException
            extends RuntimeException {
        private final String code;

        public ConcurrentWriteException(String code, String message) {
            super(message);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    public record DefinitionRevision(String agentId, long revision,
            String digest, String definitionJson, long createdAt) {
    }

    public record Admission(DefinitionRevision revision, boolean replayed) {
    }

    public Admission create(String tenantId, String idempotencyKey,
            String requestDigest, String agentId, String digest,
            String definitionJson, long now);

    public Admission update(String tenantId, String idempotencyKey,
            String requestDigest, String agentId, String digest,
            String definitionJson, long now);

    public Map<String, Object> pinnedContent(SessionRecord session);

    public Optional<DefinitionRevision> latest(String tenantId,
            String agentId);

    public Optional<DefinitionRevision> latestForUpdate(String tenantId,
            String agentId);

    public Optional<DefinitionRevision> find(String tenantId, String agentId,
            long revision);

    public Optional<Admission> replayCommitted(String tenantId,
            String idempotencyKey, String requestDigest);

    public static ManagedAgentException notFound() {
        return new ManagedAgentException(404, "agent_not_found",
                "The agent definition was not found.");
    }
}
