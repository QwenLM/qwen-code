package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition;

import java.util.Optional;

public interface ManagedDefinitionPreparationStore {
    enum State {
        PENDING,
        RESOLVED,
        PREPARED
    }

    record Preparation(State state, ManagedAgentDefinitionSource.Definition input,
            AgentDefinition definition) {
        public Preparation {
            if (state == null) {
                throw new IllegalArgumentException("Preparation state is required");
            }
        }
    }

    Preparation begin(String tenantId, String scopeId, String operationKey,
            String requestDigest, byte[] actorKey, long now);

    void resolve(String tenantId, String scopeId, String operationKey,
            ManagedAgentDefinitionSource.Definition input, String resultJson, long now);

    void complete(String tenantId, String scopeId, String operationKey,
            AgentDefinition definition, String resultJson, long now);

    Optional<Preparation> find(String tenantId, String scopeId, String operationKey,
            String requestDigest);

    default String actorScope(byte[] actorKey) {
        return java.util.Base64.getEncoder().encodeToString(actorKey);
    }
}
