package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRef;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

final class WorkspaceEvidenceResources {
    private WorkspaceEvidenceResources() {
    }

    static String publish(JdbcTemplate jdbc, String tenant, String workspace, String session,
            String ownerKey, byte[] bytes) {
        String digest = digest(bytes);
        String resourceId = "workspace-proof:" + ownerKey + ":" + digest;
        String resourceRef = ManagedIdentityRefs.resourceRef(tenant, session, resourceId);
        List<byte[]> existing = jdbc.query("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ? FOR UPDATE", (row, index) -> {
            if (!tenant.equals(row.getString("tenant_id")) || !workspace.equals(row.getString("workspace_id"))
                    || !session.equals(row.getString("session_id")) || !resourceId.equals(row.getString("resource_id"))
                    || !"managed-workspace-proof".equals(row.getString("kind")) || !"REFERENCED".equals(row.getString("state"))
                    || ManagedSchemaRows.identity(row, "deletion_operation_ref") != null || !digest.equals(row.getString("sha256"))) {
                throw new IllegalStateException("Workspace proof resource is unavailable");
            }
            return row.getBytes("inline_bytes");
        }, tenant, session, resourceId);
        if (existing.isEmpty()) {
            jdbc.update("INSERT INTO ma_resource (tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, 'managed-workspace-proof', 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                    tenant, workspace, session, resourceId, bytes.length, digest, bytes, ownerKey);
        } else if (existing.size() != 1 || !Arrays.equals(existing.getFirst(), bytes)) {
            throw new IllegalStateException("Workspace proof resource conflicts");
        }
        String ownerRef = ManagedIdentityRefs.ref(ManagedIdentityRefs.OWNER_REF_BYTES, ownerKey);
        jdbc.update("INSERT INTO ma_resource_ref (owner_kind, owner_ref, owner_revision, tenant_id, workspace_id, session_id, resource_id, gmt_create) VALUES ('OPERATION_WORK', ?, 1, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE owner_ref = owner_ref", ownerRef, tenant, workspace, session, resourceId);
        return resourceRef;
    }

    static byte[] read(JdbcTemplate jdbc, String resourceRef, String expectedDigest) {
        List<String> identity;
        try {
            identity = ManagedIdentityRef.decode(resourceRef.getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("Workspace proof resource is missing");
        }
        List<byte[]> rows = jdbc.query("SELECT inline_bytes, sha256, state, kind, byte_length, deletion_operation_ref FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                (row, index) -> {
                    byte[] value = row.getBytes("inline_bytes");
                    if (value == null || !"REFERENCED".equals(row.getString("state"))
                            || !"managed-workspace-proof".equals(row.getString("kind"))
                            || ManagedSchemaRows.identity(row, "deletion_operation_ref") != null || row.getLong("byte_length") != value.length
                            || !expectedDigest.equals(row.getString("sha256")) || !expectedDigest.equals(digest(value))) {
                        throw new IllegalStateException("Workspace proof resource is unavailable");
                    }
                    return value;
                }, identity.get(0), identity.get(1), identity.get(2));
        if (rows.size() != 1) {
            throw new IllegalStateException("Workspace proof resource is missing");
        }
        return rows.getFirst();
    }

    static String digest(byte[] bytes) {
        try {
            return DigestUtils.sha256Hex(bytes);
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }
}
