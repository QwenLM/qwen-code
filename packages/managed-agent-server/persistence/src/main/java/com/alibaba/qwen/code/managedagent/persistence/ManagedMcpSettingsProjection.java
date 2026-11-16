package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;

/**
 * The MCP-settings domain projection of the Stage H commit: the latest settings revision's
 * session-record row and the resource-reference closure its configuration names. Extracted from
 * {@link JdbcManagedExtensionRecordStore} so that store stays within the class-size ratchet; the
 * projection rides the same commit transaction and the shared reference/body checks still live on
 * the store. Package config accumulates its retained closure across revisions, while a legacy
 * settings revision replaces its single projection row (R2-5).
 */
class ManagedMcpSettingsProjection {
    private static final Set<String> RETAINED_REFERENCE_KINDS = Set.of(
            "managed-config_install", "managed-extension-config-bundle",
            "managed-extension-contributions", "managed-extension-root",
            "managed-extension-stage-ack", "managed-extension-enable-ack");

    private final JdbcTemplate jdbc;
    private final AgentStateStore sessions;

    ManagedMcpSettingsProjection(JdbcTemplate jdbc, AgentStateStore sessions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
    }

    void project(String tenantId, String workspaceId, String sessionId, JsonNode payload,
            Function<String, StoredResource> resources, long sequence, long occurredAt, String[] lines) {
        JdbcManagedExtensionRecordStore.require(sessions != null, "Configuration management admission is unavailable");
        JsonNode ref = payload.get("recordRef");
        StoredResource resource = resources.apply(ref.get("resourceId").textValue());
        JdbcManagedExtensionRecordStore.requireReference(resource, ref);
        JsonNode settings = JdbcManagedExtensionRecordStore.readBody(resource);
        try {
            ManagedMcpSettings.require(settings);
        } catch (InvalidRecordException error) {
            throw JdbcManagedExtensionRecordStore.rejected(error.getMessage());
        }
        JdbcManagedExtensionRecordStore.require(settings.get("operationId").equals(payload.get("operationId")), "Configuration command identity conflicts");
        JsonNode previous = ManagedMcpSettings.find(jdbc, tenantId, sessionId);
        if (ManagedConfigInstall.isPackageConfig(settings)) {
            sessions.requireConfigurationCommit(tenantId, workspaceId, sessionId, settings);
            try {
                ManagedConfigInstall.successor(previous, settings);
            } catch (InvalidRecordException error) {
                throw JdbcManagedExtensionRecordStore.rejected(error.getMessage());
            }
            requireConfigurationBinding(settings, lines);
        } else {
            JdbcManagedExtensionRecordStore.require(!ManagedConfigInstall.isPackageConfig(previous), "Legacy MCP writes cannot replace package configuration");
            sessions.requireMcpSettingsCommit(tenantId, workspaceId, sessionId);
        }
        Long settledAt = ManagedConfigInstall.barrier(settings) ? null : occurredAt;
        long revision = settings.get("revision").longValue();
        JdbcManagedExtensionRecordStore.require(revision == (previous == null ? 1 : previous.get("revision").longValue() + 1), "MCP settings revision conflicts");
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String key = ManagedExtensionProjection.recordKey(sessionId, ManagedMcpSettings.DOMAIN, ManagedMcpSettings.RECORD_ID);
        if (previous == null) {
            jdbc.update("INSERT INTO ma_session_record (record_kind, session_scope_key, record_key, tenant_id, workspace_id,"
                            + " session_id, domain, record_id, revision, record_resource_id, gmt_create, settled_at, first_sequence)"
                            + " VALUES ('DOMAIN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", scope, key, tenantId, workspaceId,
                    sessionId, ManagedMcpSettings.DOMAIN, ManagedMcpSettings.RECORD_ID, revision, resource.resourceId(),
                    occurredAt, settledAt, sequence);
        } else {
            JsonNode predecessor = settings.get("previousRecordRef");
            String previousResource = jdbc.queryForObject("SELECT record_resource_id FROM ma_session_record"
                    + " WHERE session_scope_key=? AND record_key=?", String.class, scope, key);
            JdbcManagedExtensionRecordStore.require(previousResource.equals(predecessor.path("resourceId").asText()), "MCP settings predecessor conflicts");
            JdbcManagedExtensionRecordStore.requireReference(resources.apply(previousResource), predecessor);
            jdbc.update("UPDATE ma_session_record SET revision=?, record_resource_id=?, settled_at=?"
                    + " WHERE session_scope_key=? AND record_key=? AND revision=?",
                    revision, resource.resourceId(), settledAt, scope, key, revision - 1);
        }
        if (ManagedConfigInstall.isPackageConfig(settings)) {
            // Package config accumulates across revisions: the retained seed
            // stops the closure walk from re-projecting resources an earlier
            // revision already pinned.
            Set<String> retained = new HashSet<>(jdbc.queryForList(
                    "SELECT resource_id FROM ma_resource_ref WHERE session_scope_key=? AND owner_kind='SESSION_RECORD' AND owner_key=?",
                    String.class, scope, key));
            if (retained.add(resource.resourceId())) {
                JdbcManagedExtensionRecordStore.referenceProjectionResource(jdbc, scope, key, revision, tenantId, workspaceId,
                        sessionId, resource.resourceId());
            }
            // A sealed writer cannot rely on its old journal to retain the
            // recovery resources named by the active package configuration.
            retainPackageConfiguration(scope, key, revision, tenantId, workspaceId,
                    sessionId, settings, resources, retained);
        } else {
            // Legacy MCP settings need no closure: replace the superseded
            // projection row so the key keeps exactly one row instead of
            // accumulating one per revision for the Session's whole life (R2-5).
            jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key=? AND owner_kind='SESSION_RECORD' AND owner_key=?",
                    scope, key);
            JdbcManagedExtensionRecordStore.referenceProjectionResource(jdbc, scope, key, revision, tenantId, workspaceId,
                    sessionId, resource.resourceId());
        }
    }

    // Resources are immutable per (scope, resourceId) and every settings revision links its
    // predecessor, so a resource retained by an earlier commit already pins its whole reference
    // closure: the walk only has to name the resources this commit adds, probing existence once
    // per level instead of per resource and leaving the rows it already wrote untouched.
    private void retainPackageConfiguration(String scope, String key, long revision,
            String tenantId, String workspaceId, String sessionId, JsonNode settings,
            Function<String, StoredResource> resources, Set<String> retained) {
        List<JsonNode> level = configurationReferences(settings);
        while (!level.isEmpty()) {
            Map<String, JsonNode> candidates = new LinkedHashMap<>();
            for (JsonNode ref : level) {
                if (ref != null && !ref.isNull()
                        && retained.add(ref.path("resourceId").asText())) {
                    candidates.put(ref.path("resourceId").asText(), ref);
                }
            }
            level = new ArrayList<>();
            if (candidates.isEmpty()) {
                continue;
            }
            Set<String> existing = existingResources(scope, candidates.keySet());
            for (Map.Entry<String, JsonNode> candidate : candidates.entrySet()) {
                String resourceId = candidate.getKey();
                if (!existing.contains(resourceId)) {
                    continue;
                }
                StoredResource resource = resources.apply(resourceId);
                JdbcManagedExtensionRecordStore.requireReference(resource, candidate.getValue());
                JdbcManagedExtensionRecordStore.referenceProjectionResource(jdbc, scope, key, revision, tenantId, workspaceId,
                        sessionId, resourceId);
                if (RETAINED_REFERENCE_KINDS.contains(resource.kind())) {
                    level.addAll(packageReferences(resource.kind(), JdbcManagedExtensionRecordStore.readBody(resource)));
                }
            }
        }
    }

    private static List<JsonNode> configurationReferences(JsonNode settings) {
        List<JsonNode> refs = new ArrayList<>();
        for (String field : List.of("previousBundleRef", "restoresBundleRef", "bundleRef",
                "rootSnapshotRef", "previousRecordRef")) {
            refs.add(settings.get(field));
        }
        for (String field : List.of("stageAckRefs", "enableAckRefs")) {
            for (JsonNode ref : settings.path(field)) {
                refs.add(ref);
            }
        }
        return refs;
    }

    private static List<JsonNode> packageReferences(String kind, JsonNode body) {
        if ("managed-config_install".equals(kind)) {
            return configurationReferences(body);
        }
        List<JsonNode> refs = new ArrayList<>();
        if ("managed-extension-config-bundle".equals(kind)) {
            for (JsonNode entry : body.path("packages")) {
                refs.add(entry.get("contributionsRef"));
            }
        } else if ("managed-extension-contributions".equals(kind)) {
            for (JsonNode part : body.path("parts")) {
                refs.add(part);
            }
        } else {
            refs.add(body.get("rootSnapshotRef"));
            refs.add(body.get("bundleRef"));
        }
        return refs;
    }

    private Set<String> existingResources(String scope, Set<String> resourceIds) {
        String placeholders = String.join(",",
                java.util.Collections.nCopies(resourceIds.size(), "?"));
        List<Object> args = new ArrayList<>();
        args.add(scope);
        args.addAll(resourceIds);
        return new HashSet<>(jdbc.queryForList(
                "SELECT resource_id FROM ma_resource WHERE session_scope_key = ?"
                        + " AND resource_id IN (" + placeholders + ")",
                String.class, args.toArray()));
    }

    private static void requireConfigurationBinding(JsonNode settings, String[] lines) {
        List<JsonNode> bindings = java.util.Arrays.stream(lines).map(ManagedExtensionRecordStore::parse)
                .filter(Objects::nonNull).map(line -> line.path("managedSession"))
                .filter(event -> "config.bound".equals(event.path("kind").asText())).map(event -> event.path("payload")).toList();
        if (!"committed".equals(settings.path("phase").asText())) {
            JdbcManagedExtensionRecordStore.require(bindings.isEmpty(), "Only a committed configuration may bind");
            return;
        }
        JdbcManagedExtensionRecordStore.require(bindings.size() == 1, "Configuration binding must commit atomically");
        JsonNode binding = bindings.getFirst();
        ManagedExtensionRecords.closed(binding, Set.of("revision", "previousRevision", "bundleRef", "rootSnapshotRef"), "Configuration binding");
        JdbcManagedExtensionRecordStore.require(binding.path("revision").equals(settings.get("configRevision"))
                && (settings.path("previousConfigRevision").asLong() == 0
                        ? binding.path("previousRevision").isNull() : binding.path("previousRevision").equals(settings.get("previousConfigRevision")))
                && binding.get("bundleRef").equals(settings.get("bundleRef"))
                && binding.get("rootSnapshotRef").equals(settings.get("rootSnapshotRef")), "Configuration binding conflicts");
    }
}
