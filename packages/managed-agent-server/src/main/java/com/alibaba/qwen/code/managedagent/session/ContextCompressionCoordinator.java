package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;

/** A submitted compression is reconciled from its native record, never blindly sent again. */
@Component
public class ContextCompressionCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(ContextCompressionCoordinator.class);
    private final AgentStateStore store;
    private final ManagedExtensionRecordStore records;
    private final HarnessConnector harness;
    private final ExecutorService executor;
    private final Clock clock;
    private final Duration lease;
    private final String owner = UUID.randomUUID().toString();
    private final Set<String> active = ConcurrentHashMap.newKeySet();

    public ContextCompressionCoordinator(AgentStateStore store, ManagedExtensionRecordStore records,
            HarnessConnector harness, @Qualifier("managedAgentExecutor") ExecutorService executor, @Qualifier("managedAgentClock") Clock clock,
            ManagedAgentProperties properties) {
        this.store = store;
        this.records = records;
        this.harness = harness;
        this.executor = executor;
        this.clock = clock;
        this.lease = properties.getDispatch().getLeaseDuration();
    }

    public void dispatch(String tenantId, String sessionId, String operationId) {
        String key = tenantId + "\n" + sessionId + "\n" + operationId;
        if (!active.add(key)) {
            return;
        }
        executor.execute(() -> {
            try {
                deliver(tenantId, sessionId, operationId);
            } finally {
                active.remove(key);
            }
        });
    }

    @Scheduled(scheduler = "managedAgentScheduler", fixedDelayString = "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void recover() {
        for (var target : store.findContextCompressions(50)) {
            dispatch(target.tenantId(), target.sessionId(), target.operationId());
        }
    }

    private void deliver(String tenantId, String sessionId, String operationId) {
        OperationRecord operation = store.claimContextCompression(tenantId, sessionId,
                operationId, owner, lease).orElse(null);
        if (operation == null) {
            return;
        }
        JsonNode evidence = evidence(operation);
        boolean submitted = !"JAVA_DURABLE".equals(operation.admissionStage());
        try {
            if (evidence == null && "JAVA_DURABLE".equals(operation.admissionStage())) {
                var submission = harness.prepareContextCompression(tenantId, sessionId,
                        store.contextCompressionRequest(tenantId, sessionId, operationId));
                if (!store.markContextCompressionSubmitted(operation, owner)) {
                    return;
                }
                submitted = true;
                submission.submit();
            } else if (evidence != null && !"settled".equals(evidence.path("phase").asText())) {
                harness.readContextCompression(tenantId, sessionId, operationId);
            }
        } catch (RuntimeException error) {
            if (evidence == null && error instanceof com.alibaba.qwen.code.daemon.DaemonHttpException refusal
                    && refusal.getStatusCode() >= 400 && refusal.getStatusCode() < 500
                    && evidence(operation) == null) {
                store.settleContextCompression(operation, owner, "failed", null,
                        refusal.getErrorCode() == null ? "context_compression_refused" : refusal.getErrorCode());
                return;
            }
            if (!submitted && evidence == null) {
                if (error instanceof com.alibaba.qwen.code.managedagent.exception.ManagedAgentException refusal) {
                    store.settleContextCompression(operation, owner, "failed", null, refusal.getCode());
                } else {
                    store.retryContextCompressionPreparation(operation, owner, clock.millis() + 1000);
                }
                return;
            }
            LOG.debug("Context compression waits for durable evidence tenant={} session={} operation={} failure={}",
                    tenantId, sessionId, operationId, error.getMessage());
        }
        evidence = evidence(operation);
        if (evidence != null && "settled".equals(evidence.path("phase").asText())) {
            JsonNode revision = evidence.path("compactionRevision");
            store.settleContextCompression(operation, owner, evidence.path("outcome").asText(),
                    revision.isIntegralNumber() ? revision.longValue() : null,
                    evidence.path("failureCode").textValue());
            return;
        }
        String blocked = evidence != null && "recovery_blocked".equals(evidence.path("run").path("state").asText())
                ? "context_compression_recovery_blocked" : null;
        store.awaitContextCompression(operation, owner, evidence != null, blocked, clock.millis() + 1000);
    }

    private JsonNode evidence(OperationRecord operation) {
        return records.findRecord(operation.tenantId(), operation.sessionId(),
                "history_maintenance", operation.operationId()).orElse(null);
    }
}
