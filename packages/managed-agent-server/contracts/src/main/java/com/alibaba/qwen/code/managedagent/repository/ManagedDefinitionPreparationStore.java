package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation.PreparedBundle;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition;

import java.util.List;
import java.util.Optional;

public interface ManagedDefinitionPreparationStore {
    enum State {
        PENDING,
        RESOLVED,
        PREPARED
    }

    record Preparation(State state, ManagedAgentDefinitionSource.Definition input,
            AgentDefinition definition, List<PreparedBundle> bundles) {
        public Preparation {
            if (state == null || state == State.PREPARED && (definition == null || bundles == null)
                    || state == State.RESOLVED && input == null) {
                throw new IllegalArgumentException("Preparation is incomplete");
            }
            bundles = bundles == null ? null : List.copyOf(bundles);
        }
    }

    Preparation begin(String tenantId, String scopeId, String operationKey,
            String requestDigest, byte[] actorKey, long now);

    void resolve(String tenantId, String scopeId, String operationKey,
            ManagedAgentDefinitionSource.Definition input, String resultJson, long now);

    void complete(String tenantId, String scopeId, String operationKey,
            AgentDefinition definition, List<PreparedBundle> bundles, String resultJson, long now);

    Optional<Preparation> find(String tenantId, String scopeId, String operationKey,
            String requestDigest);

    default String actorScope(byte[] actorKey) {
        return java.util.Base64.getEncoder().encodeToString(actorKey);
    }
}
