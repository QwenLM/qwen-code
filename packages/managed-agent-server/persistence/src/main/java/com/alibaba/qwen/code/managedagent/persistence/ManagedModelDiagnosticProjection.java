package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedMcpRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedModelDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.ModelDiagnostics;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;

import static com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore.readBody;
import static com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore.require;
import static com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore.requireReference;

/** Two bounded projections updated under the native journal's existing Session fence. */
final class ManagedModelDiagnosticProjection {
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final String MODEL_CONTEXT_DOMAIN = ManagedModelDiagnostics.CONTEXT_DOMAIN;
    private static final String MODEL_USAGE_KIND = "managed-hosted-model-usage";
    private final JdbcTemplate jdbc;
    private final JdbcManagedExtensionRecordStore store;

    ManagedModelDiagnosticProjection(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store) {
        this.jdbc = jdbc;
        this.store = store;
    }

    static int storageFloor(byte[] records,
            List<com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource> requested,
            List<JournalResourceWrites.ValidatedResource> validated) {
        boolean promotes = com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHostedRecoveryRecords.requiresVersionTwo(records, requested)
                || validated.stream().anyMatch(resource -> {
                    if (!"managed-action-options".equals(resource.resource().kind()) || resource.bytes() == null) {
                        return false;
                    }
                    JsonNode body = ManagedExtensionRecordStore.parse(new String(resource.bytes(), java.nio.charset.StandardCharsets.UTF_8));
                    return body != null && (body.path("v").asInt() == 3 || body.path("v").asInt() == 4);
                });
        boolean diagnostics = validated.stream().anyMatch(resource -> {
            if (com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedModelDiagnostics.KINDS.contains(resource.resource().kind())) {
                return true;
            }
            if (!"managed-history_maintenance".equals(resource.resource().kind()) || resource.bytes() == null) {
                return false;
            }
            JsonNode body = ManagedExtensionRecordStore.parse(
                    new String(resource.bytes(), java.nio.charset.StandardCharsets.UTF_8));
            return body != null && body.path("schemaVersion").asInt() == 2;
        });
        boolean activity = validated.stream().anyMatch(resource ->
                com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics.KIND.equals(resource.resource().kind()));
        return activity ? 4 : diagnostics ? 3 : promotes ? 2 : 1;
    }

    static void validateResource(StoredResource resource) {
        require(resource.schemaVersion() == 1 && resource.bytes() != null && resource.bytes().length <= 65_536,
                "Invalid model diagnostics resource.");
        try {
            ManagedModelDiagnostics.requireBody(resource.kind(), readBody(resource));
        } catch (ManagedExtensionRecords.InvalidRecordException error) {
            throw JournalStoreRows.invalid(error.getMessage());
        }
    }

    public ModelDiagnostics findModelDiagnostics(String tenantId, String sessionId) {
        for (int attempt = 0; attempt < 2; attempt++) {
            Long before = diagnosticReadRevision(tenantId, sessionId);
            DiagnosticRow context = diagnosticRow(tenantId, sessionId, MODEL_CONTEXT_DOMAIN);
            DiagnosticRow statistics = diagnosticRow(tenantId, sessionId, ManagedModelDiagnostics.STATS_DOMAIN);
            Long after = diagnosticReadRevision(tenantId, sessionId);
            if (!Objects.equals(before, after)) {
                continue;
            }
            JsonNode contextBody = context == null ? null : context.body().get("context");
            if (contextBody != null && contextBody.isNull()) {
                contextBody = null;
            }
            JsonNode stats = statistics == null ? null : statistics.body().get("statistics");
            List<String> gaps = new ArrayList<>();
            if (stats != null) {
                stats.path("coverage").path("gaps").forEach(gap -> gaps.add(gap.textValue()));
            } else if (context != null) {
                gaps.add("legacy_history");
            }
            Long observed = null;
            if (stats != null) {
                observed = stats.path("observedAt").longValue();
            } else if (contextBody != null) {
                observed = contextBody.path("observedAt").longValue();
            }
            return new ModelDiagnostics(contextBody, stats, context == null ? null : context.sequence(),
                    statistics == null ? null : statistics.sequence(), observed, after,
                    contextBody != null && context.settledAt() == null, List.copyOf(gaps));
        }
        throw new ManagedAgentException(409, "managed_session_diagnostics_changed",
                "The Session changed while reading diagnostics; retry the read.");
    }

    private Long diagnosticReadRevision(String tenantId, String sessionId) {
        return jdbc.queryForList("SELECT journal_revision FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'"
                + " AND tenant_id = ? AND session_id = ?", Long.class, tenantId, sessionId).stream().findFirst().orElse(null);
    }

    private record DiagnosticRow(JsonNode body, long sequence, Long settledAt) { }

    private DiagnosticRow diagnosticRow(String tenantId, String sessionId, String domain) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        return jdbc.query("SELECT revision, settled_at, record_resource_id FROM ma_session_record"
                        + " WHERE record_kind = 'DOMAIN' AND session_scope_key = ? AND record_key = ?"
                        + " AND tenant_id = ? AND session_id = ? AND domain = ? AND record_id = ?",
                (row, index) -> {
                    StoredResource resource = store.readResource(tenantId, sessionId, row.getString("record_resource_id"));
                    require(resource.schemaVersion() == 1 && resource.byteLength() <= 65_536,
                            "Invalid diagnostic projection resource.");
                    JsonNode body = readBody(resource);
                    if (ManagedModelDiagnostics.KINDS.contains(resource.kind())) {
                        require(!MODEL_CONTEXT_DOMAIN.equals(domain) || ManagedModelDiagnostics.MAIN_KIND.equals(resource.kind()),
                                "A context projection must reference main model usage.");
                        ManagedModelDiagnostics.requireBody(resource.kind(), body);
                    } else {
                        require(MODEL_CONTEXT_DOMAIN.equals(domain) && MODEL_USAGE_KIND.equals(resource.kind()),
                                "Invalid diagnostic projection kind.");
                    }
                    long settled = row.getLong("settled_at");
                    Long settledAt = row.wasNull() ? null : settled;
                    return new DiagnosticRow(body, row.getLong("revision"), settledAt);
                }, scope, ManagedExtensionProjection.recordKey(sessionId, domain, "latest"),
                tenantId, sessionId, domain, "latest").stream().findFirst().orElse(null);
    }

    void projectModelStatistics(String tenantId, String workspaceId, String sessionId,
            JsonNode event, JsonNode ref, Function<String, StoredResource> resources, long occurredAt) {
        ManagedExtensionRecords.durableRef(ref, "model statistics");
        StoredResource resource = resources.apply(ref.get("resourceId").textValue());
        requireReference(resource, ref);
        require(resource.schemaVersion() == 1 && resource.byteLength() <= 65_536, "Invalid model statistics resource.");
        JsonNode body = readBody(resource);
        ManagedModelDiagnostics.requireBody(resource.kind(), body);
        JsonNode payload = event.get("payload");
        String kind = event.get("kind").textValue();
        JsonNode budget = body.get("budget");
        require(budget.isNull() || sessionId.equals(budget.path("sessionId").asText()),
                "Model statistics belong to another Session.");
        if ("model.attempt".equals(kind)) {
            require(!ManagedModelDiagnostics.STATS_KIND.equals(resource.kind())
                    && List.of("output_committed", "abandoned").contains(payload.path("state").asText()),
                    "Model statistics require a terminal model attempt.");
            JsonNode routeRef = payload.get("routeRef");
            ManagedExtensionRecords.durableRef(routeRef, "model route");
            StoredResource routeResource = resources.apply(routeRef.get("resourceId").textValue());
            requireReference(routeResource, routeRef);
            JsonNode route = readBody(routeResource);
            String expected = ManagedModelDiagnostics.MAIN_KIND.equals(resource.kind())
                    ? "managed-hosted-model-route" : "managed-hook-model-route";
            require(expected.equals(routeResource.kind()) && body.get("model").equals(route.get("model")),
                    "Model statistics do not match their route.");
            require(ManagedMcpRecords.same(body.get("budget"), route.get("budget")), "Model statistics budget conflicts.");
            for (String field : ManagedModelDiagnostics.MAIN_KIND.equals(resource.kind()) ? List.of("turnId")
                    : List.of("operationId", "occurrenceId", "originTurnId", "eventName")) {
                require(body.get(field).equals(route.get(field)), "Model statistics route identity conflicts.");
            }
            require("output_committed".equals(payload.path("state").asText()) || body.get("context").isNull(),
                    "An abandoned attempt cannot publish context.");
        } else {
            require(ManagedModelDiagnostics.STATS_KIND.equals(resource.kind()), "Invalid terminal statistics kind.");
            require(!"turn.settled".equals(kind) || budget.isNull() || budget.path("promptId").equals(payload.path("turnId")),
                    "Turn statistics budget belongs to another Turn.");
        }
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                        + " AND session_kind = 'PUBLIC' AND workspace_id = ? AND workspace_storage_id IS NOT NULL",
                Integer.class, tenantId, sessionId, workspaceId) == 0) {
            return;
        }
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String key = ManagedExtensionProjection.recordKey(sessionId, ManagedModelDiagnostics.STATS_DOMAIN, "latest");
        List<String> existing = jdbc.queryForList("SELECT record_resource_id FROM ma_session_record"
                + " WHERE session_scope_key = ? AND record_key = ?", String.class, scope, key);
        JsonNode statistics = body.get("statistics");
        if (!existing.isEmpty()) {
            StoredResource previousResource = store.readResource(tenantId, sessionId, existing.getFirst());
            JsonNode previousBody = readBody(previousResource);
            ManagedModelDiagnostics.requireBody(previousResource.kind(), previousBody);
            JsonNode previous = previousBody.get("statistics");
            long revision = statistics.get("snapshotRevision").longValue();
            long before = previous.get("snapshotRevision").longValue();
            if (revision <= before) {
                require(revision != before || ManagedMcpRecords.same(previous, statistics),
                        "The same statistics revision has conflicting content.");
                if (revision < before) {
                    Integer committed = jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref f JOIN ma_session_head h"
                            + " ON h.tenant_id = f.tenant_id AND h.session_id = f.session_id AND h.head_kind = 'MANAGED_SESSION'"
                            + " WHERE f.session_scope_key = ? AND f.resource_id = ? AND f.owner_kind = 'JOURNAL'"
                            + " AND f.journal_revision <= h.journal_revision", Integer.class, scope, resource.resourceId());
                    require(committed != null && committed > 0, "An older statistics snapshot must reference its original committed resource.");
                }
                return;
            }
            for (String field : List.of("totals", "sources", "overflow", "rawOutputTokensTotal")) {
                requireMonotonicStatistics(previous.get(field), statistics.get(field));
            }
            for (JsonNode gap : previous.path("coverage").path("gaps")) {
                require(java.util.stream.StreamSupport.stream(statistics.path("coverage").path("gaps").spliterator(), false)
                        .anyMatch(gap::equals), "Statistics coverage gaps cannot be forgotten.");
            }
        }
        long sequence = event.get("sequence").longValue();
        if (existing.isEmpty()) {
            jdbc.update("INSERT INTO ma_session_record (record_kind, session_scope_key, record_key, tenant_id, workspace_id,"
                    + " session_id, domain, record_id, revision, record_resource_id, gmt_create, settled_at, first_sequence)"
                    + " VALUES ('DOMAIN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", scope, key, tenantId, workspaceId,
                    sessionId, ManagedModelDiagnostics.STATS_DOMAIN, "latest", sequence, resource.resourceId(), occurredAt, occurredAt, sequence);
        } else {
            jdbc.update("UPDATE ma_session_record SET revision = ?, record_resource_id = ?, settled_at = ?"
                    + " WHERE session_scope_key = ? AND record_key = ?", sequence, resource.resourceId(), occurredAt, scope, key);
        }
        jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = 'SESSION_RECORD' AND owner_key = ?", scope, key);
        JdbcManagedExtensionRecordStore.referenceProjectionResource(jdbc, scope, key, sequence, tenantId, workspaceId,
                sessionId, resource.resourceId());
    }

    private static void requireMonotonicStatistics(JsonNode before, JsonNode after) {
        if (before.isNumber()) {
            require(after.decimalValue().compareTo(before.decimalValue()) >= 0, "Cumulative model statistics cannot decrease.");
            return;
        }
        before.fields().forEachRemaining(field -> requireMonotonicStatistics(field.getValue(), after.get(field.getKey())));
    }

    static boolean invalidatesContext(String kind, String domain) {
        return Set.of("input.accepted", "config.bound", "context.compacted", "tool.receipt").contains(kind)
                || "domain.committed".equals(kind) && domain != null && Set.of("config_install", "workspace_initialization", "skill_activation",
                        "workspace_operation", "history_rewind", "history_copy", "memory_job", "file_history").contains(domain);
    }

    static void invalidateModelContext(JdbcTemplate jdbc, String tenantId, String sessionId) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        jdbc.update("UPDATE ma_session_record SET settled_at = NULL WHERE session_scope_key = ? AND record_key = ?"
                + " AND EXISTS (SELECT 1 FROM ma_resource u WHERE u.session_scope_key = ma_session_record.session_scope_key"
                + " AND u.resource_id = ma_session_record.record_resource_id AND u.kind = ?)", scope,
                ManagedExtensionProjection.recordKey(sessionId, MODEL_CONTEXT_DOMAIN, "latest"), ManagedModelDiagnostics.MAIN_KIND);
    }

    static void clearLegacyModelContext(JdbcTemplate jdbc, String tenantId, String sessionId) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String key = ManagedExtensionProjection.recordKey(sessionId, MODEL_CONTEXT_DOMAIN, "latest");
        Integer legacy = jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record r JOIN ma_resource u"
                + " ON u.session_scope_key = r.session_scope_key AND u.resource_id = r.record_resource_id"
                + " WHERE r.session_scope_key = ? AND r.record_key = ? AND u.kind = ?", Integer.class, scope, key, MODEL_USAGE_KIND);
        if (legacy != null && legacy > 0) {
            jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = 'SESSION_RECORD' AND owner_key = ?", scope, key);
            jdbc.update("DELETE FROM ma_session_record WHERE session_scope_key = ? AND record_key = ?", scope, key);
        }
    }

    static WebShellModelContext modelContext(byte[] bytes, long observedAt, String kind) {
        JsonNode body = ManagedExtensionRecordStore.parse(new String(bytes, StandardCharsets.UTF_8));
        if (ManagedModelDiagnostics.MAIN_KIND.equals(kind) && body != null && body.path("version").asInt() == 2) {
            try {
                ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body);
                JsonNode context = body.get("context");
                return context.isNull() ? null : new WebShellModelContext(context.path("model").textValue(),
                        tokenCount(context, "inputTokens", 0), tokenCount(context, "contextWindowSize", 1),
                        context.path("observedAt").longValue());
            } catch (InvalidRecordException error) {
                return null;
            }
        }
        if (body == null || !body.path("version").isIntegralNumber()
                || !body.path("version").canConvertToLong()
                || body.path("version").longValue() != 1) {
            return null;
        }
        JsonNode model = body.path("model");
        if (!model.isTextual() || StringUtils.isBlank(model.textValue())
                || model.textValue().getBytes(StandardCharsets.UTF_8).length > 512
                || model.textValue().chars().anyMatch(Character::isISOControl)) {
            return null;
        }
        JsonNode attempts = body.path("attempts");
        JsonNode latest = attempts.isArray() && !attempts.isEmpty()
                ? attempts.get(attempts.size() - 1) : null;
        return new WebShellModelContext(model.textValue(), tokenCount(latest, "promptTokenCount", 0),
                tokenCount(latest, "contextWindowSize", 1), observedAt);
    }

    private static Long tokenCount(JsonNode usage, String field, long minimum) {
        JsonNode value = usage == null ? null : usage.get(field);
        return value != null && value.isNumber() && value.canConvertToLong()
                && value.decimalValue().stripTrailingZeros().scale() <= 0
                && value.longValue() >= minimum && value.longValue() <= MAX_SAFE_INTEGER
                ? value.longValue() : null;
    }
}
