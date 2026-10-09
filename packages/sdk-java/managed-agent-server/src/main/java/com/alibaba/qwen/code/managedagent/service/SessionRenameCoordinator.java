package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.RenameDelivery;
import java.time.Clock;
import java.util.Set;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class SessionRenameCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(SessionRenameCoordinator.class);
    private final AgentStateStore store;
    private final HarnessConnector harness;
    private final ExecutorService executor;
    private final Clock clock;
    private final ManagedAgentProperties.Dispatch settings;
    private final String owner = UUID.randomUUID().toString();
    private final Set<List<String>> active = ConcurrentHashMap.newKeySet();

    public SessionRenameCoordinator(AgentStateStore store, HarnessConnector harness,
            ExecutorService executor, Clock clock, ManagedAgentProperties properties) {
        this.store = store;
        this.harness = harness;
        this.executor = executor;
        this.clock = clock;
        this.settings = properties.getDispatch();
    }

    @Scheduled(fixedDelayString = "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void recover() {
        if (!harness.isAvailable()) {
            return;
        }
        for (RenameDelivery delivery : store.deliverableRenames(clock.millis())) {
            List<String> key = List.of(delivery.tenantId(), delivery.sessionId());
            if (active.add(key)) {
                try {
                    executor.execute(() -> {
                        try {
                            deliver(delivery);
                        } finally {
                            active.remove(key);
                        }
                    });
                } catch (RuntimeException error) {
                    active.remove(key);
                    throw error;
                }
            }
        }
    }

    private void deliver(RenameDelivery candidate) {
        RenameDelivery delivery = store.claimRename(candidate, owner, settings.getLeaseDuration()).orElse(null);
        if (delivery == null) {
            return;
        }
        try {
            var session = store.requireSession(delivery.tenantId(), delivery.sessionId());
            var attachment = harness.createOrLoad(delivery.tenantId(), delivery.sessionId(),
                    session.harnessBootId() != null, true);
            if ("RETIRING".equals(delivery.state())) {
                var receipt = harness.retireRename(delivery.tenantId(), delivery.sessionId(), delivery.revision());
                store.completeRenameRetirement(delivery, owner, receipt.title(), receipt.bootId());
            } else {
                harness.rename(delivery.tenantId(), delivery.sessionId(), delivery.title(), delivery.revision());
                store.completeSessionRename(delivery.tenantId(), delivery.idempotencyKey(), delivery.sessionId(),
                        delivery.title(), attachment.bootId(), delivery.revision());
            }
        } catch (RuntimeException failure) {
            try {
                store.abandonSessionRename(delivery.tenantId(), delivery.idempotencyKey(), delivery.sessionId(), delivery.revision(), owner);
            } catch (RuntimeException cleanupError) {
                LOG.warn("Failed to retire Session title delivery session={}", delivery.sessionId(), cleanupError);
            }
            long delay = HarnessCoordinator.retryDelay(settings.getRetryInitialDelay(),
                    settings.getRetryMaxDelay(), delivery.attemptCount());
            store.retryRename(delivery, owner, Math.addExact(clock.millis(), delay));
            LOG.debug("Session title delivery will retry session={} revision={} failure={}",
                    delivery.sessionId(), delivery.revision(), failure.toString());
        }
    }
}
