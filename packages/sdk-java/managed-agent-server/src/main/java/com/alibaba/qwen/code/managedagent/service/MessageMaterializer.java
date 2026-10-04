package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class MessageMaterializer {
    private static final Logger LOG = LoggerFactory.getLogger(
            MessageMaterializer.class);
    private static final int TARGET_LIMIT = 32;
    private static final int EVENT_LIMIT = 200;
    private final AgentStateStore store;

    public MessageMaterializer(AgentStateStore store) {
        this.store = store;
    }

    // Driven by ManagedArtifactConfiguration.messageMaterializerTask on the
    // dedicated single-thread scheduler at
    // ManagedAgentProperties.Events.materializeInterval (bound from
    // application.yml's materialize-interval, 100 ms by default).
    public void materialize() {
        for (MaterializationTarget target :
                store.findMaterializationTargets(TARGET_LIMIT)) {
            try {
                store.materializeNextBatch(target.tenantId(),
                        target.sessionId(), EVENT_LIMIT);
            } catch (RuntimeException error) {
                LOG.warn("Failed to materialize Managed Agent session {}",
                        target.sessionId(), error);
            }
        }
    }
}
