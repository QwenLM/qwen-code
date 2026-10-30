package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.persistence.WakeRecoveryStore;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
@ConditionalOnProperty(prefix = "qwen.managed-agent.session-store", name = "enabled", havingValue = "true")
public class WakeRecovery {
    private static final Logger LOG = LoggerFactory.getLogger(WakeRecovery.class);
    private static final int SCAN_LIMIT = 8;
    private final WakeRecoveryStore store;
    private final HarnessConnector harness;
    private final ChildResultRelayStore records;
    private final String defaultWorkspace;

    public WakeRecovery(WakeRecoveryStore store, HarnessConnector harness,
            ChildResultRelayStore records, ManagedAgentProperties properties) {
        this.store = store;
        this.harness = harness;
        this.records = records;
        defaultWorkspace = StringUtils.defaultIfBlank(properties.getSessionStore().getWorkspaceId(),
                properties.getRuntimeBroker().getWorkspaceId());
    }

    @Scheduled(scheduler = "wakeRecoveryScheduler", fixedDelayString = "${qwen.managed-agent.wake-recovery.scan-delay:2s}")
    public void scan() {
        if (!harness.isAvailable()) {
            return;
        }
        for (var candidate : store.findPending(defaultWorkspace, SCAN_LIMIT)) {
            try {
                if (!store.claim(candidate)) {
                    continue;
                }
                var proof = store.hasPendingInput(candidate);
                if (proof.isEmpty()) {
                    continue;
                }
                boolean pending = proof.get();
                if (!store.recordPending(candidate, pending) || !pending) {
                    continue;
                }
                if (candidate.parentSessionId() != null) {
                    var run = records.childRunBody(candidate.tenantId(), candidate.parentSessionId(),
                            candidate.parentChildRunId());
                    if (run == null) {
                        throw new IllegalStateException("Child wake recovery cannot read its parent run");
                    }
                    if (ManagedExtensionRecords.isTerminalRunState(run.path("run").path("state").asText())
                            || run.path("stopRequested").asBoolean()) {
                        store.recordPending(candidate, false);
                        continue;
                    }
                }
                harness.recoverForWake(candidate.tenantId(), candidate.sessionId());
                LOG.info("wake recovery attached tenant={} session={}", candidate.tenantId(), candidate.sessionId());
            } catch (RuntimeException failure) {
                LOG.warn("wake recovery deferred tenant={} session={} failure={}", candidate.tenantId(),
                        candidate.sessionId(), failure.getMessage(), failure);
            }
        }
    }
}
