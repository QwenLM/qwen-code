package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHostedRecoveryRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.ManagedCheckpointHistory;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Checkpoint-history closure validation, extracted from JournalCommit (class-size ratchet). */
final class JournalCheckpointValidation {
    private final JdbcTemplate jdbc;

    JournalCheckpointValidation(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    void validatePagedCheckpoint(StoredResource stored, String tenant, String workspace, String session,
            ManagedHostedRecoveryRecords.HistoricalResources resources) {
        JsonNode body = ManagedExtensionRecordStore.parse(new String(stored.bytes(), StandardCharsets.UTF_8));
        if (body == null || !ManagedCheckpointHistory.paged(body)) {
            return;
        }
        if (!ManagedCheckpointHistory.PROFILE.equals(body.path("storageProfile").asText())) {
            throw JournalStoreRows.invalid("Unsupported checkpoint storage profile.");
        }
        JsonNode history = body.path("history");
        ManagedExtensionRecords.closed(history, Set.of("ref", "toolCount", "bindingCount"), "checkpoint history");
        resources.checkpointHistory(history.path("ref"));
        StoredResource page = resources.apply(history.path("ref").path("resourceId").asText());
        JsonNode saved = ManagedCheckpointHistory.page(page.bytes());
        if (!saved.path("sessionKey").equals(body.path("identity").path("sessionKey"))
                || !saved.path("turnId").equals(body.path("identity").path("turnId"))
                || !saved.path("promptId").equals(body.path("identity").path("promptId"))
                || !saved.path("toolCount").equals(history.path("toolCount"))
                || !saved.path("bindingCount").equals(history.path("bindingCount"))) {
            throw JournalStoreRows.invalid("Checkpoint history identity or coverage conflicts.");
        }
    }

    void validateCheckpointHistory(JsonNode ref, String tenant, String workspace, String session,
            long previousRevision, Set<String> declared, java.util.function.Function<String, StoredResource> resources) {
        try {
            ManagedCheckpointHistory.pageRef(ref);
            StoredResource stored = resources.apply(ref.path("resourceId").asText());
            requireCheckpointResource(ref, stored);
            JsonNode page = ManagedCheckpointHistory.page(stored.bytes());
            JsonNode key = page.path("sessionKey");
            if (!tenant.equals(key.path("tenantId").asText()) || !workspace.equals(key.path("workspaceId").asText())
                    || !session.equals(key.path("sessionId").asText())) {
                throw JournalStoreRows.invalid("Checkpoint history belongs to another Session.");
            }
            Long origin = priorCheckpointResourceRevision(tenant, workspace, session, stored.resourceId(), previousRevision);
            long ceiling = origin == null ? previousRevision : origin;
            for (JsonNode nested : checkpointReferences(page)) {
                StoredResource dependency = resources.apply(nested.path("resourceId").asText());
                requireCheckpointResource(nested, dependency);
                Long owned = priorCheckpointResourceRevision(tenant, workspace, session, dependency.resourceId(), ceiling);
                if (owned == null && (origin != null || !declared.contains(dependency.resourceId()))) {
                    throw JournalStoreRows.invalid("Checkpoint history dependency has no committed owner.");
                }
            }
            long tools = page.path("toolCount").longValue() - page.path("items").size();
            long bindings = page.path("bindingCount").longValue() - page.path("bindings").size();
            JsonNode previous = page.path("previous");
            if (tools < 0 || bindings < 0) {
                throw JournalStoreRows.invalid("Checkpoint history count conflicts.");
            }
            if (previous.isNull()) {
                if (tools != 0 || bindings != 0) {
                    throw JournalStoreRows.invalid("Checkpoint history predecessor is missing.");
                }
            } else {
                JsonNode predecessor = ManagedCheckpointHistory.page(resources.apply(previous.path("resourceId").asText()).bytes());
                if (!predecessor.path("sessionKey").equals(key)
                        || !predecessor.path("turnId").equals(page.path("turnId"))
                        || !predecessor.path("promptId").equals(page.path("promptId"))
                        || predecessor.path("toolCount").longValue() != tools
                        || predecessor.path("bindingCount").longValue() != bindings) {
                    throw JournalStoreRows.invalid("Checkpoint history predecessor conflicts.");
                }
            }
        } catch (IllegalArgumentException | com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException error) {
            throw JournalStoreRows.invalid("Invalid checkpoint history page.");
        }
    }

    static void requireCheckpointResource(JsonNode ref, StoredResource stored) {
        ManagedExtensionRecords.durableRef(ref, "checkpoint history dependency");
        if (!stored.kind().equals(ref.path("kind").asText())
                || stored.schemaVersion() != ref.path("schemaVersion").intValue()
                || stored.byteLength() != ref.path("byteLength").longValue()
                || !stored.digest().equals(ref.path("digest").asText())
                || stored.bytes() == null || stored.bytes().length != stored.byteLength()
                || !ToolPublicationContract.sha256(stored.bytes()).equals(stored.digest())) {
            throw JournalStoreRows.invalid("Checkpoint history resource metadata conflicts.");
        }
    }

    static List<JsonNode> checkpointReferences(JsonNode value) {
        List<JsonNode> result = new ArrayList<>();
        if (value.isObject() && value.has("resourceId")) {
            result.add(value);
        } else if (value.isContainerNode()) {
            for (JsonNode child : value) {
                result.addAll(checkpointReferences(child));
            }
        }
        return result;
    }

    Long priorCheckpointResourceRevision(String tenant, String workspace, String session,
            String resourceId, long maximum) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        List<Long> origins = jdbc.query("SELECT x.owner_revision FROM ma_resource_ref x JOIN ma_session_journal_tx t"
                        + " ON t.tenant_id = x.tenant_id AND t.workspace_id = x.workspace_id AND t.session_id = x.session_id"
                        + " AND t.journal_revision = x.owner_revision WHERE x.resource_key = ? AND x.session_scope_key = ?"
                        + " AND x.tenant_id = ? AND x.workspace_id = ? AND x.session_id = ? AND x.resource_id = ?"
                        + " AND x.owner_kind = 'JOURNAL' AND x.owner_key = ? AND x.owner_revision = x.journal_revision"
                        + " AND x.owner_revision <= ? ORDER BY x.owner_revision LIMIT 1",
                (row, index) -> row.getLong(1), ManagedSessionStore.resourceKey(scope, resourceId), scope, tenant, workspace, session,
                resourceId, scope, maximum);
        return origins.isEmpty() ? null : origins.getFirst();
    }
}
