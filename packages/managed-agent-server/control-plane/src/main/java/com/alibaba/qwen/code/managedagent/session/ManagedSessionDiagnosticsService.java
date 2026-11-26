package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashSet;
import java.util.Set;

@Service
@Transactional(transactionManager = "managedAgentTransactionManager", readOnly = true,
        isolation = Isolation.REPEATABLE_READ)
public class ManagedSessionDiagnosticsService {
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;

    public ManagedSessionDiagnosticsService(ManagedAgentService sessions, ManagedExtensionRecordStore records) {
        this.sessions = sessions;
        this.records = records;
    }

    public JsonNode context(String tenantId, String actorId, String sessionId) {
        return context(tenantId,
                sessions.requireReadableSession(tenantId, actorId, sessionId),
                sessionId);
    }

    public JsonNode context(SessionPrincipal principal, String sessionId) {
        return context(principal.tenantId(),
                sessions.requireReadableSession(principal, sessionId),
                sessionId);
    }

    private JsonNode context(String tenantId, SessionRecord session,
            String sessionId) {
        var read = records.findModelDiagnostics(tenantId, sessionId);
        JsonNode context = read.context();
        Set<String> reasons = new LinkedHashSet<>();
        if (context != null && !context.path("attributionComplete").asBoolean()) {
            reasons.add("attribution_incomplete");
        }
        if (context != null && context.path("detailsTruncated").asBoolean()) {
            reasons.add("details_truncated");
        }
        ObjectNode result = envelope(session, read.readRevision(), context != null, reasons);
        nullableCounter(result, "sourceSequence", read.contextSequence());
        result.put("estimated", true).put("stale", read.stale());
        ArrayNode staleReasons = result.putArray("staleReasons");
        if (read.stale()) {
            staleReasons.add("context_changed");
        }
        result.set("context", context == null ? JsonNodeFactory.instance.nullNode() : select(context,
                "version", "attemptId", "turnId", "model", "observedAt", "inputTokens", "cachedTokens",
                "contextWindowSize", "breakdown", "thresholds", "details", "attributionComplete", "detailsTruncated"));
        return result;
    }

    public JsonNode statistics(String tenantId, String actorId, String sessionId) {
        return statistics(tenantId,
                sessions.requireReadableSession(tenantId, actorId, sessionId),
                sessionId);
    }

    public JsonNode statistics(SessionPrincipal principal, String sessionId) {
        return statistics(principal.tenantId(),
                sessions.requireReadableSession(principal, sessionId),
                sessionId);
    }

    private JsonNode statistics(String tenantId, SessionRecord session,
            String sessionId) {
        var read = records.findModelDiagnostics(tenantId, sessionId);
        JsonNode statistics = read.statistics();
        Set<String> reasons = new LinkedHashSet<>(read.coverageGaps());
        if (statistics != null) {
            statistics.path("coverage").path("gaps").forEach(value -> reasons.add(value.asText()));
        }
        ObjectNode result = envelope(session, read.readRevision(), statistics != null, reasons);
        nullableCounter(result, "sourceSequence", read.statisticsSequence());
        result.set("statistics", statistics == null ? JsonNodeFactory.instance.nullNode() : select(statistics,
                "version", "snapshotRevision", "observedAt", "coverage", "totals", "sources", "models",
                "overflow", "recent", "modelBreakdownOmitted", "samplesTruncated"));
        return result;
    }

    private static ObjectNode envelope(SessionRecord session, Long revision, boolean observed, Set<String> reasons) {
        ObjectNode result = JsonNodeFactory.instance.objectNode().put("schemaVersion", 1)
                .put("sessionId", session.sessionId())
                .put("availability", observed ? reasons.isEmpty() ? "available" : "partial"
                        : session.workspace() == null ? "unsupported" : "not_recorded");
        nullableCounter(result, "readRevision", revision);
        ArrayNode coverage = result.putArray("coverageReasons");
        reasons.forEach(coverage::add);
        return result;
    }

    private static void nullableCounter(ObjectNode target, String name, Long value) {
        if (value == null) {
            target.putNull(name);
        } else {
            target.put(name, Long.toString(value));
        }
    }

    private static ObjectNode select(JsonNode source, String... fields) {
        ObjectNode result = JsonNodeFactory.instance.objectNode();
        for (String field : fields) {
            result.set(field, source.path(field).deepCopy());
        }
        return result;
    }
}
