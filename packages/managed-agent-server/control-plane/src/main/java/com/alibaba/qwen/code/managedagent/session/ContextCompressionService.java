package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicContextCompressionOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellContextCompressionOperation;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Map;

@Service
public class ContextCompressionService {
    private final AgentStateStore store;
    private final RequestDigests digests;
    private final HarnessConnector harness;
    private final ContextCompressionCoordinator coordinator;
    private final ManagedExtensionRecordStore records;

    public ContextCompressionService(AgentStateStore store, RequestDigests digests,
            HarnessConnector harness, ContextCompressionCoordinator coordinator,
            ManagedExtensionRecordStore records) {
        this.store = store;
        this.digests = digests;
        this.harness = harness;
        this.coordinator = coordinator;
        this.records = records;
    }

    public PublicContextCompressionOperation admitPublic(String tenantId, String actorId,
            String sessionId, String key, Long revision) {
        OperationAdmission admitted = admit(tenantId, actorId, sessionId, key, revision);
        return publicOperation(admitted.operation(), admitted.replayed());
    }

    public WebShellContextCompressionOperation admitWebShell(String tenantId, String actorId,
            String sessionId, String key, Long revision) {
        OperationAdmission admitted = admit(tenantId, actorId, sessionId, key, revision);
        return webOperation(admitted.operation(), admitted.replayed());
    }

    private OperationAdmission admit(String tenantId, String actorId, String sessionId,
            String key, Long revision) {
        if (actorId == null || actorId.isEmpty()) {
            throw new ManagedAgentException(401, "actor_required",
                    "A trusted actor is required.");
        }
        ManagedAgentService.validateIdempotencyKey(key);
        if (revision == null || revision < 0 || revision > 9_007_199_254_740_991L) {
            throw new ManagedAgentException(400, "invalid_request",
                    "expected_compaction_revision must be a nonnegative safe integer.");
        }
        String digest = digests.digest(Map.of("sessionId", sessionId,
                "operation", "CONTEXT_COMPRESSION", "expectedCompactionRevision", revision));
        OperationAdmission admitted = store.beginContextCompression(tenantId, sessionId,
                actorId, digests.digest(Map.of("actorId", actorId)), key, digest,
                revision, harness.supportsContextCompression());
        if (!admitted.replayed() && "PENDING".equals(admitted.operation().state())) {
            coordinator.dispatch(tenantId, sessionId, admitted.operation().operationId());
        }
        return admitted;
    }

    public PublicContextCompressionOperation publicOperation(OperationRecord operation, boolean replayed) {
        JsonNode record = records.findRecord(operation.tenantId(), operation.sessionId(),
                "history_maintenance", operation.operationId()).orElse(null);
        return new PublicContextCompressionOperation(operation.operationId(), operation.sessionId(),
                "context_compression", operation.state().toLowerCase(Locale.ROOT), expected(operation),
                revision(record, expected(operation)), outcome(record), operation.failureCode(), replayed);
    }

    public WebShellContextCompressionOperation webOperation(OperationRecord operation, boolean replayed) {
        JsonNode record = records.findRecord(operation.tenantId(), operation.sessionId(),
                "history_maintenance", operation.operationId()).orElse(null);
        return new WebShellContextCompressionOperation(operation.operationId(), operation.sessionId(),
                "context_compression", operation.state().toLowerCase(Locale.ROOT), expected(operation),
                revision(record, expected(operation)), outcome(record), operation.failureCode(), replayed);
    }

    private long expected(OperationRecord operation) {
        return ((Number) store.contextCompressionRequest(operation.tenantId(), operation.sessionId(),
                operation.operationId()).get("expectedCompactionRevision")).longValue();
    }

    private static Long revision(JsonNode record, long expected) {
        if (record != null && "noop".equals(record.path("outcome").textValue())) {
            return expected;
        }
        return record == null || !record.path("compactionRevision").isIntegralNumber()
                ? null : record.get("compactionRevision").longValue();
    }

    private static String outcome(JsonNode record) {
        if (record == null || !"settled".equals(record.path("phase").asText())) {
            return null;
        }
        String outcome = record.path("outcome").textValue();
        return "failed".equals(outcome) ? null : outcome;
    }
}
