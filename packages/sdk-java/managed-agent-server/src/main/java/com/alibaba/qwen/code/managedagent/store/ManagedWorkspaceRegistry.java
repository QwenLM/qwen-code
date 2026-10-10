package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
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

    /**
     * Whether the actor created this Workspace-bound Session. The create
     * command is the owner of record for Sessions written before V40; later
     * Turns still run under the creator's grants.
     */
    public boolean createdSession(String tenantId, String actorId,
            String sessionId) {
        if (actorId == null || actorId.isEmpty()) {
            return false;
        }
        byte[] key;
        try {
            key = actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return false;
        }
        return !jdbc.queryForList("SELECT 1 FROM managed_workspace_create_command"
                + " WHERE tenant_id = ? AND session_id = ?"
                + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                + " AND actor_id = ?",
                Integer.class, tenantId, sessionId, tenantId, key).isEmpty();
    }

    /**
     * Whether the actor owns this Session: the recorded owner
     * ({@code owner_actor_key}) when one is set — the handover's own
     * keying, so a transferred Session answers only its new owner. With
     * no owner record, a Session with a create command answers its
     * command actor — H4b child Sessions register the parent cascade's
     * synthetic one — and only a command-less, pre-V40 row falls back to
     * {@code creator_actor_key}.
     */
    public boolean isSessionOwner(String tenantId, String actorId,
            String sessionId) {
        if (actorId == null || actorId.isEmpty()) {
            return false;
        }
        byte[] key;
        try {
            key = actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return false;
        }
        List<byte[]> owners = jdbc.queryForList(
                "SELECT owner_actor_key FROM managed_agent_session WHERE"
                        + " tenant_id = ? AND session_id = ?",
                byte[].class, tenantId, sessionId);
        if (!owners.isEmpty() && owners.getFirst() != null) {
            return java.util.Arrays.equals(owners.getFirst(), key);
        }
        List<String> commands = jdbc.queryForList(
                "SELECT 1 FROM managed_workspace_create_command WHERE"
                        + " tenant_id = ? AND session_id = ? LIMIT 1",
                String.class, tenantId, sessionId);
        if (!commands.isEmpty()) {
            return createdSession(tenantId, actorId, sessionId);
        }
        List<byte[]> creators = jdbc.queryForList(
                "SELECT creator_actor_key FROM managed_agent_session WHERE"
                        + " tenant_id = ? AND session_id = ?",
                byte[].class, tenantId, sessionId);
        return !creators.isEmpty() && creators.getFirst() != null
                && java.util.Arrays.equals(creators.getFirst(), key);
    }

    /**
     * The actor's role on the Workspace; {@link WorkspaceAccess#NONE} for no
     * grant row or an actor id the registry key cannot encode.
     */
    public WorkspaceAccess accessOf(String tenantId, String actorId,
            String workspaceId) {
        if (actorId == null || actorId.isEmpty()) {
            return WorkspaceAccess.NONE;
        }
        byte[] key;
        try {
            key = actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return WorkspaceAccess.NONE;
        }
        List<String> roles = jdbc.queryForList(
                "SELECT role FROM managed_workspace_access"
                        + " WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND actor_id = ? AND role IN ('READER', 'OPERATOR',"
                        + " 'OWNER')",
                String.class, tenantId, workspaceId, tenantId, workspaceId,
                key);
        // An out-of-enum stored value (only reachable by an out-of-band
        // write past V53's CHECK) fails closed exactly like a revoked
        // grant, never into valueOf's IllegalArgumentException.
        return roles.isEmpty() ? WorkspaceAccess.NONE
                : WorkspaceAccess.valueOf(roles.getFirst());
    }

    /** The read half of {@link #accessOf}: one grant read per decision. */
    public boolean canRead(String tenantId, String actorId,
            String workspaceId) {
        return accessOf(tenantId, actorId, workspaceId).canRead();
    }

    public List<WorkspaceSummary> listReadable(String tenantId,
            String actorId, String afterId, int limit) {
        byte[] key = actorKey(tenantId, actorId);
        return jdbc.query("SELECT r.workspace_id, r.display_name, r.state,"
                        + " a.role FROM managed_workspace_registry r"
                        + " JOIN managed_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " AND CAST(CONCAT(a.tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(r.tenant_id, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(a.workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(r.workspace_id, '!') AS BINARY(513))"
                        + " WHERE r.tenant_id = ?"
                        + " AND CAST(CONCAT(r.tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND a.actor_id = ? AND a.role IN ('READER',"
                        + " 'OPERATOR', 'OWNER')"
                        + " AND (? IS NULL OR"
                        + " CAST(CONCAT(r.workspace_id, '!') AS BINARY(513)) >"
                        + " CAST(CONCAT(?, '!') AS BINARY(513)))"
                        + " ORDER BY CAST(CONCAT(r.workspace_id, '!')"
                        + " AS BINARY(513)) LIMIT ?",
                (result, row) -> summary(result), tenantId, tenantId, key,
                afterId, afterId, limit);
    }

    public WorkspaceSummary findReadable(String tenantId, String actorId,
            String workspaceId) {
        byte[] key = actorKey(tenantId, actorId);
        List<WorkspaceSummary> rows = jdbc.query(
                "SELECT r.workspace_id, r.display_name, r.state,"
                        + " a.role FROM managed_workspace_registry r"
                        + " JOIN managed_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " AND CAST(CONCAT(a.tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(r.tenant_id, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(a.workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(r.workspace_id, '!') AS BINARY(513))"
                        + " WHERE r.tenant_id = ? AND r.workspace_id = ?"
                        + " AND CAST(CONCAT(r.tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(r.workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND a.actor_id = ? AND a.role IN ('READER',"
                        + " 'OPERATOR', 'OWNER')",
                (result, row) -> summary(result), tenantId, workspaceId,
                tenantId, workspaceId, key);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * The batch twin of findReadable for a page of Workspace ids. It carries
     * the registry's current binding stamp as well, so a page answers the
     * creator-submit gate from this one read instead of a per-row
     * bindingCurrent.
     */
    public java.util.Map<String, ReadableGrant> findReadable(
            String tenantId, String actorId,
            java.util.Collection<String> workspaceIds) {
        if (workspaceIds.isEmpty()) {
            return java.util.Map.of();
        }
        byte[] key = actorKey(tenantId, actorId);
        String plain = String.join(", ", java.util.Collections.nCopies(
                workspaceIds.size(), "?"));
        String binary = String.join(", ", java.util.Collections.nCopies(
                workspaceIds.size(), "CAST(CONCAT(?, '!') AS BINARY(513))"));
        List<Object> arguments = new java.util.ArrayList<>(
                workspaceIds.size() * 2 + 3);
        arguments.add(tenantId);
        arguments.addAll(workspaceIds);
        arguments.addAll(workspaceIds);
        arguments.add(tenantId);
        arguments.add(key);
        List<ReadableGrant> rows = jdbc.query(
                "SELECT r.workspace_id, r.workspace_generation,"
                        + " r.storage_id, r.state, a.role"
                        + " FROM managed_workspace_registry r"
                        + " JOIN managed_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " AND CAST(CONCAT(a.tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(r.tenant_id, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(a.workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(r.workspace_id, '!') AS BINARY(513))"
                        + " WHERE r.tenant_id = ? AND r.workspace_id IN ("
                        + plain + ")"
                        + " AND CAST(CONCAT(r.workspace_id, '!') AS"
                        + " BINARY(513)) IN (" + binary + ")"
                        + " AND CAST(CONCAT(r.tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND a.actor_id = ? AND a.role IN ('READER',"
                        + " 'OPERATOR', 'OWNER')",
                (result, row) -> readableGrant(result), arguments.toArray());
        java.util.Map<String, ReadableGrant> result =
                new java.util.HashMap<>(rows.size() * 2);
        for (ReadableGrant row : rows) {
            result.put(row.workspaceId(), row);
        }
        return result;
    }

    public WorkspaceSummary readableDefault(String tenantId,
            String actorId) {
        List<String> ids = jdbc.queryForList(
                "SELECT workspace_id FROM managed_workspace_default"
                        + " WHERE tenant_id = ?"
                        + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))",
                String.class, tenantId, tenantId);
        if (ids.isEmpty()) {
            return null;
        }
        WorkspaceSummary found = findReadable(tenantId, actorId,
                ids.getFirst());
        return found != null && found.canCreateSession() ? found : null;
    }

    private static WorkspaceSummary summary(ResultSet result)
            throws SQLException {
        String state = result.getString("state");
        return new WorkspaceSummary(result.getString("workspace_id"),
                result.getString("display_name"), state,
                WorkspaceAccess.valueOf(result.getString("role"))
                        .atLeast(WorkspaceAccess.OPERATOR)
                        && "ACTIVE".equals(state));
    }

    private static ReadableGrant readableGrant(ResultSet result)
            throws SQLException {
        String state = result.getString("state");
        return new ReadableGrant(result.getString("workspace_id"),
                result.getLong("workspace_generation"),
                result.getString("storage_id"),
                WorkspaceAccess.valueOf(result.getString("role"))
                        .atLeast(WorkspaceAccess.OPERATOR)
                        && "ACTIVE".equals(state));
    }

    /**
     * Whether the registry still holds the Workspace generation and storage a
     * Session was bound to; a re-registration changes them.
     */
    public boolean bindingCurrent(String tenantId, String workspaceId,
            long generation, String storageId) {
        return !jdbc.queryForList("SELECT 1 FROM managed_workspace_registry"
                + " WHERE tenant_id = ? AND workspace_id = ?"
                + " AND workspace_generation = ? AND storage_id = ?",
                Integer.class, tenantId, workspaceId, generation, storageId)
                .isEmpty();
    }

    public record WorkspaceSummary(String workspaceId, String displayName,
            String state, boolean canCreateSession) {
    }

    /**
     * A readable Workspace with the generation and storage the registry holds
     * now, so a batch caller can tell whether a Session's recorded binding is
     * still the current one.
     */
    public record ReadableGrant(String workspaceId, long workspaceGeneration,
            String storageId, boolean canCreateSession) {
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
                "SELECT role FROM managed_workspace_access"
                        + " WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND CAST(CONCAT(tenant_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND CAST(CONCAT(workspace_id, '!') AS BINARY(513))"
                        + " = CAST(CONCAT(?, '!') AS BINARY(513))"
                        + " AND actor_id = ? AND role IN ('READER', 'OPERATOR',"
                        + " 'OWNER') FOR UPDATE",
                (result, row) -> new AccessRow(WorkspaceAccess.valueOf(
                        result.getString("role"))), tenantId,
                workspaceId, tenantId, workspaceId, key);
        if (access.isEmpty() || !access.getFirst().value().canRead()) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "workspace_not_found", "Workspace not found.");
        }
        if (!access.getFirst().value().canCreate()) {
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

    private record AccessRow(WorkspaceAccess value) {
    }
}
