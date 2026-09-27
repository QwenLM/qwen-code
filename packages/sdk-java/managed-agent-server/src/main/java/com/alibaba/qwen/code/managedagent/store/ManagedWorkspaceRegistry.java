package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceActor;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceState;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Repository
public class ManagedWorkspaceRegistry {
    private final JdbcTemplate jdbc;

    public ManagedWorkspaceRegistry(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public boolean canRead(String tenantId, String actorId,
            String workspaceId) {
        if (actorId == null || actorId.isEmpty()) {
            return false;
        }
        byte[] key;
        try {
            key = actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return false;
        }
        return !jdbc.queryForList("SELECT 1 FROM managed_workspace_access"
                + " WHERE tenant_id = ? AND workspace_id = ?"
                + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                + " AND CAST(CONCAT(workspace_id, '!') AS BINARY(513))"
                + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                + " AND actor_id = ? AND can_read = TRUE",
                Integer.class, tenantId, workspaceId, tenantId, workspaceId,
                key).isEmpty();
    }

    public ResolvedBinding resolveForCreation(String tenantId,
            String actorId, WorkspaceSelection selection) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException(
                    "Workspace resolution requires a creation transaction");
        }
        if (actorId == null || actorId.isEmpty()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED,
                    "actor_required", "A trusted actor is required.");
        }
        byte[] key;
        try {
            key = actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            throw new ApiException(HttpStatus.FORBIDDEN,
                    "actor_scope_mismatch", "Authenticated actor scope is invalid.");
        }
        String workspaceId;
        if (selection == null) {
            List<String> defaults = jdbc.queryForList(
                    "SELECT workspace_id FROM managed_workspace_default"
                            + " WHERE tenant_id = ?"
                            + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                            + " = CAST(CONCAT(?, '!') AS BINARY(513)) FOR UPDATE",
                    String.class, tenantId, tenantId);
            if (defaults.isEmpty()) {
                throw workspaceRequired();
            }
            workspaceId = defaults.getFirst();
        } else {
            workspaceId = selection.workspaceId();
        }
        List<WorkspaceRecord> records = jdbc.query(
                "SELECT workspace_generation, storage_id, display_name,"
                        + " config_ref, policy_ref, state FROM"
                        + " managed_workspace_registry WHERE tenant_id = ?"
                        + " AND workspace_id = ?"
                        + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513)) FOR UPDATE",
                (result, row) -> workspaceRow(tenantId, workspaceId,
                        result), tenantId, workspaceId, tenantId, workspaceId);
        if (records.isEmpty()) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "workspace_not_found", "Workspace not found.");
        }
        List<AccessRow> access = jdbc.query(
                "SELECT can_read, can_create FROM managed_workspace_access"
                        + " WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND actor_id = ? FOR UPDATE",
                (result, row) -> new AccessRow(result.getBoolean("can_read"),
                        result.getBoolean("can_create")), tenantId,
                workspaceId, tenantId, workspaceId, key);
        if (access.isEmpty() || !access.getFirst().canRead()) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "workspace_not_found", "Workspace not found.");
        }
        if (!access.getFirst().canCreate()) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ApiException(HttpStatus.FORBIDDEN,
                    "workspace_forbidden", "Workspace cannot be used.");
        }
        WorkspaceRecord record = records.getFirst();
        if (record.getState() != WorkspaceState.ACTIVE) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ApiException(HttpStatus.CONFLICT,
                    "workspace_unavailable", "Workspace is unavailable.");
        }
        ContextBinding binding = new ContextBinding(tenantId, workspaceId,
                record.getWorkspaceGeneration(), record.getStorageId(),
                selection == null ? "." : selection.cwdRelative(),
                descriptorRef(record.getConfigRef(), record.getPolicyRef()), 1);
        return new ResolvedBinding(binding, record.getConfigRef(),
                record.getPolicyRef());
    }

    static byte[] actorKey(String tenantId, String actorId) {
        return new WorkspaceActor(tenantId, actorId).getActorId()
                .getBytes(StandardCharsets.UTF_8);
    }

    static String descriptorRef(String configRef, String policyRef) {
        try {
            byte[] bytes = (configRef + "\u0000" + policyRef)
                    .getBytes(StandardCharsets.UTF_8);
            return "sha256:" + HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static WorkspaceRecord workspaceRow(String tenantId,
            String workspaceId, ResultSet result) throws SQLException {
        try {
            return new WorkspaceRecord(tenantId, workspaceId,
                    result.getLong("workspace_generation"),
                    result.getString("storage_id"),
                    result.getString("display_name"),
                    WorkspaceState.valueOf(result.getString("state")),
                    result.getString("policy_ref"),
                    result.getString("config_ref"));
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("Invalid Workspace Registry row for "
                    + workspaceId + " of tenant " + tenantId, error);
        }
    }

    private static ApiException workspaceRequired() {
        return new ApiException(HttpStatus.BAD_REQUEST,
                "workspace_required", "Select a Workspace.");
    }

    public record ResolvedBinding(ContextBinding binding, String configRef,
            String policyRef) {
    }

    private record AccessRow(boolean canRead, boolean canCreate) {
    }
}
