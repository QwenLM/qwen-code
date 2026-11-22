package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;

/** The original Runtime remains referenced until its Hosted cleanup is confirmed. */
final class HostedCleanupReferences {
    private HostedCleanupReferences() {}

    static String bindingKey(String tenant, String workspace, String binding) {
        return binding;
    }

    /**
     * True when the transaction carries a Hosted cleanup event. Retention takes
     * placement before binding and Session locks, so cleanup admission must
     * join that order before it can inspect the original binding.
     */
    static boolean containsCleanup(byte[] recordBytes) {
        return Arrays.stream(new String(recordBytes, StandardCharsets.UTF_8).split("\n"))
                .map(ManagedExtensionRecordStore::parse)
                .filter(Objects::nonNull)
                .anyMatch(record -> "hosted.cleanup".equals(record.path("managedSession").path("kind").asText()));
    }

    static void apply(JdbcTemplate jdbc, String tenant, String workspace, String session,
            JsonNode payload, Function<String, StoredResource> resources, long revision, long now) {
        String owner = ManagedIdentityRefs.ref(ManagedIdentityRefs.OWNER_REF_BYTES,
                "hosted-cleanup", payload.path("cleanupId").textValue());
        String resourceId = payload.path("descriptorRef").path("resourceId").textValue();
        StoredResource resource = resources.apply(resourceId);
        JsonNode descriptor = ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
        if (descriptor == null) {
            throw new IllegalStateException("Validated cleanup descriptor is unreadable");
        }
        String binding = bindingKey(tenant, workspace, descriptor.path("bindingId").textValue());
        long generation = Long.parseLong(descriptor.path("generation").textValue());
        if (!"confirmed".equals(payload.path("state").textValue())) {
            // The caller holds placement before its Session/head locks, matching
            // retention. A current read also rejects a binding collected before admission.
            var originals = jdbc.query("SELECT tenant_id, workspace_id, workspace_generation, runtime_generation"
                            + " FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE",
                    (row, index) -> tenant.equals(row.getString("tenant_id"))
                            && workspace.equals(row.getString("workspace_id"))
                            && descriptor.path("workspaceGeneration").textValue().equals(row.getString("workspace_generation"))
                            && generation == row.getLong("runtime_generation"),
                    descriptor.path("bindingId").textValue().getBytes(StandardCharsets.UTF_8));
            if (originals.size() != 1 || !originals.getFirst()) {
                throw new ManagedAgentException(409, "managed_session_cleanup_conflict",
                        "Cleanup Runtime binding is missing or differs from its original descriptor");
            }
        }
        // Only this Session's commits insert its cleanup references, and they
        // queue on its Session row before their first read, so a plain probe
        // sees every earlier one. Retirement deletes them only under the head
        // row this commit holds, so rows the probe finds are re-read with a
        // lock. A locking probe of a missing owner would gap-lock the index
        // other Sessions' commits insert into (design
        // 2026-11-03-managed-journal-commit-tenant-guard).
        var previous = references(jdbc, tenant, session, owner, false);
        if (!previous.isEmpty()) {
            previous = references(jdbc, tenant, session, owner, true);
        }
        requireSameIdentity(previous, resourceId, binding, generation);
        if ("confirmed".equals(payload.path("state").textValue())) {
            jdbc.update("DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                    + " AND owner_kind = 'HOSTED_CLEANUP' AND owner_ref = ? AND owner_revision = ?"
                    + " AND resource_id = ? AND runtime_binding_id = ?", tenant, session,
                    ManagedSchemaKeys.identity(owner), generation, ManagedSchemaKeys.identity(resourceId), binding);
        } else if (previous.isEmpty()) {
            try {
                jdbc.update("INSERT INTO ma_resource_ref (owner_kind, owner_ref, owner_revision,"
                        + " tenant_id, workspace_id, session_id, journal_revision, resource_id,"
                        + " gmt_create, runtime_binding_id) VALUES ('HOSTED_CLEANUP', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        ManagedSchemaKeys.identity(owner), generation, tenant, workspace,
                        session, revision, ManagedSchemaKeys.identity(resourceId), now, binding);
            } catch (DuplicateKeyException race) {
                requireSameIdentity(references(jdbc, tenant, session, owner, true), resourceId, binding, generation);
            }
        }
    }

    private static List<Map<String, Object>> references(JdbcTemplate jdbc, String tenant, String session, String owner,
            boolean lock) {
        return jdbc.queryForList("SELECT resource_id, runtime_binding_id, owner_revision"
                + " FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'HOSTED_CLEANUP'"
                + " AND owner_ref = ?" + (lock ? " FOR UPDATE" : ""), tenant, session, ManagedSchemaKeys.identity(owner));
    }

    private static void requireSameIdentity(List<Map<String, Object>> rows, String resourceId, String binding,
            long generation) {
        for (var row : rows) {
            if (!resourceId.equals(text(row.get("resource_id"))) || !binding.equals(row.get("runtime_binding_id"))
                    || generation != ((Number) row.get("owner_revision")).longValue()) {
                throw new ManagedAgentException(409, "managed_session_cleanup_conflict",
                        "Cleanup identity changed its original Runtime descriptor");
            }
        }
    }

    private static String text(Object value) {
        return value instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8) : (String) value;
    }
}
