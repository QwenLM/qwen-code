package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.function.Function;

/** The original Runtime remains referenced until its Hosted cleanup is confirmed. */
final class HostedCleanupReferences {
    private HostedCleanupReferences() {}

    static String bindingKey(String tenant, String workspace, String binding) {
        return ManagedSchemaKeys.key("hosted-cleanup-binding", tenant, workspace, binding);
    }

    static void apply(JdbcTemplate jdbc, String tenant, String workspace, String session,
            JsonNode payload, Function<String, StoredResource> resources, long revision, long now) {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session);
        String owner = ManagedSchemaKeys.key("hosted-cleanup", payload.path("cleanupId").textValue());
        String resourceId = payload.path("descriptorRef").path("resourceId").textValue();
        StoredResource resource = resources.apply(resourceId);
        JsonNode descriptor = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
        if (descriptor == null) {
            throw new IllegalStateException("Validated cleanup descriptor is unreadable");
        }
        String binding = bindingKey(tenant, workspace, descriptor.path("bindingId").textValue());
        long generation = Long.parseLong(descriptor.path("generation").textValue());
        String key = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, resourceId);
        var previous = jdbc.queryForList("SELECT resource_key, runtime_binding_key, owner_revision"
                + " FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = 'HOSTED_CLEANUP'"
                + " AND owner_key = ? FOR UPDATE", scope, owner);
        for (var row : previous) {
            if (!key.equals(row.get("resource_key")) || !binding.equals(row.get("runtime_binding_key"))
                    || generation != ((Number) row.get("owner_revision")).longValue()) {
                throw new ManagedAgentException(409, "managed_session_cleanup_conflict",
                        "Cleanup identity changed its original Runtime descriptor");
            }
        }
        if ("confirmed".equals(payload.path("state").textValue())) {
            jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ?"
                    + " AND owner_kind = 'HOSTED_CLEANUP' AND owner_key = ? AND owner_revision = ?"
                    + " AND resource_key = ? AND runtime_binding_key = ?", scope, owner, generation, key, binding);
        } else if (previous.isEmpty()) {
            jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision,"
                    + " resource_key, tenant_id, workspace_id, session_id, journal_revision, resource_id,"
                    + " gmt_create, runtime_binding_key) VALUES (?, 'HOSTED_CLEANUP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    scope, owner, generation, key, tenant, workspace, session, revision, resourceId, now, binding);
        }
    }
}
