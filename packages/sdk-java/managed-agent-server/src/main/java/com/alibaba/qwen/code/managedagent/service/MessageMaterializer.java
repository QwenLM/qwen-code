package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
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

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.events.materialize-interval:100ms}")
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
