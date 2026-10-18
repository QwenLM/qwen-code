package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceActor;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceState;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Repository
public class ManagedWorkspaceRegistry {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings ssh;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void configureSsh(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties properties) {
        this.ssh = properties.getRuntimeBroker().getSsh();
    }

    public ManagedWorkspaceRegistry(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public boolean createdSession(String tenantId, String actorId, String sessionId) {
        if (actorId == null || actorId.isEmpty()) {
            return false;
        }
        byte[] key;
        try {
            key = actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return false;
        }
        List<byte[]> creators = jdbc.queryForList(
                "SELECT creator_actor_key FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                byte[].class, tenantId, sessionId);
        return creators.size() == 1 && java.util.Arrays.equals(creators.getFirst(), key);
    }

    public boolean isSessionOwner(String tenantId, String actorId, String sessionId) {
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
                "SELECT COALESCE(owner_actor_key, creator_actor_key) FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                byte[].class, tenantId, sessionId);
        return owners.size() == 1 && java.util.Arrays.equals(owners.getFirst(), key);
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
        java.util.Set<String> visited = new java.util.HashSet<>();
        while (true) {
            if (!visited.add(workspaceId)) {
                return WorkspaceAccess.NONE;
            }
            List<String> parents = jdbc.queryForList(
                    "SELECT parent_workspace_id FROM ma_workspace"
                            + " WHERE tenant_id = ? AND workspace_id = ? AND workspace_kind = 'CHILD_GIT'",
                    String.class, tenantId, workspaceId);
            if (parents.isEmpty()) {
                break;
            }
            if (parents.size() != 1 || parents.getFirst() == null) {
                return WorkspaceAccess.NONE;
            }
            workspaceId = parents.getFirst();
        }
        List<String> roles = jdbc.queryForList(
                "SELECT role FROM ma_workspace_access"
                        + " WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND actor_id = ? AND role IN ('READER', 'OPERATOR',"
                        + " 'OWNER')",
                String.class, tenantId, workspaceId,
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
        byte[] after = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(afterId == null ? "" : afterId);
        List<WorkspaceSummary> rows = jdbc.query("SELECT r.workspace_id, r.display_name, r.state, r.workspace_kind, s.storage_kind, a.role FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON a.tenant_id = r.tenant_id AND a.workspace_id = r.workspace_id"
                        + " LEFT JOIN ma_storage s ON s.tenant_id = r.tenant_id AND s.storage_id = r.storage_id"
                        + " WHERE r.tenant_id = ? AND a.actor_id = ? AND a.role IN ('READER', 'OPERATOR', 'OWNER')"
                        + " AND r.workspace_id > ? ORDER BY r.workspace_id LIMIT ?",
                (result, row) -> summary(result), tenantId, key, after, limit);
        return withDefaults(tenantId, rows);
    }

    public WorkspaceSummary findReadable(String tenantId, String actorId,
            String workspaceId) {
        byte[] key = actorKey(tenantId, actorId);
        List<WorkspaceSummary> rows = jdbc.query(
                "SELECT r.workspace_id, r.display_name, r.state,"
                        + " r.workspace_kind, s.storage_kind, a.role FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " LEFT JOIN ma_storage s ON s.tenant_id = r.tenant_id AND s.storage_id = r.storage_id"
                        + " WHERE r.tenant_id = ? AND r.workspace_id = ?"
                        + " AND a.actor_id = ? AND a.role IN ('READER',"
                        + " 'OPERATOR', 'OWNER')",
                (result, row) -> summary(result), tenantId, workspaceId, key);
        return rows.isEmpty() ? null : withDefaults(tenantId, rows).getFirst();
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
        List<Object> arguments = new java.util.ArrayList<>(
                workspaceIds.size() + 2);
        arguments.add(tenantId);
        arguments.addAll(workspaceIds);
        arguments.add(key);
        List<ReadableGrant> rows = jdbc.query(
                "SELECT r.workspace_id, r.workspace_generation,"
                        + " r.storage_id, r.state, a.role"
                        + " FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " WHERE r.tenant_id = ? AND r.workspace_id IN ("
                        + plain + ")"
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
                "SELECT workspace_id FROM ma_workspace"
                        + " WHERE tenant_id = ? AND is_default = TRUE",
                String.class, tenantId);
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
                        && "ACTIVE".equals(state), ".",
                "OWNER".equals(result.getString("role")) && "ACTIVE".equals(state)
                        && "ROOT".equals(result.getString("workspace_kind"))
                        && !"SSH_LOCAL".equals(result.getString("storage_kind"))
                        && !"CSI".equals(result.getString("storage_kind")));
    }

    private List<WorkspaceSummary> withDefaults(String tenantId, List<WorkspaceSummary> items) {
        List<String> keys = items.stream().map(WorkspaceSummary::workspaceId)
                .filter(id -> id.matches("workspace-[a-f0-9]{64}"))
                .map(id -> id.substring("workspace-".length())).toList();
        if (keys.isEmpty()) {
            return items;
        }
        List<Object> arguments = new java.util.ArrayList<>();
        arguments.add(tenantId);
        arguments.addAll(keys);
        Map<String, String> defaults = new HashMap<>();
        jdbc.query("SELECT receipt_key, result_json FROM ma_request_receipt WHERE tenant_id = ?"
                        + " AND namespace = 'WORKSPACE_CREATE' AND state = 'COMPLETED' AND receipt_key IN ("
                        + String.join(",", java.util.Collections.nCopies(keys.size(), "?")) + ")",
                row -> {
                    var details = WorkspaceCreationRoots.details(row.getString("result_json"), row.getString("receipt_key"));
                    defaults.put(details.workspaceId(), details.cwdRelative() == null ? "." : details.cwdRelative());
                }, arguments.toArray());
        return items.stream().map(item -> new WorkspaceSummary(item.workspaceId(), item.displayName(),
                item.state(), item.canCreateSession(), defaults.getOrDefault(item.workspaceId(), "."),
                item.canSelectDirectory())).toList();
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
        return !jdbc.queryForList("SELECT 1 FROM ma_workspace"
                + " WHERE tenant_id = ? AND workspace_id = ?"
                + " AND workspace_generation = ? AND storage_id = ?",
                Integer.class, tenantId, workspaceId, generation, storageId)
                .isEmpty();
    }

    public record WorkspaceSummary(String workspaceId, String displayName,
            String state, boolean canCreateSession, String defaultCwdRelative, boolean canSelectDirectory) {
        public WorkspaceSummary(String workspaceId, String displayName, String state, boolean canCreateSession) {
            this(workspaceId, displayName, state, canCreateSession, ".", false);
        }
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
                    "SELECT workspace_id FROM ma_workspace"
                            + " WHERE tenant_id = ? AND is_default = TRUE FOR UPDATE",
                    String.class, tenantId);
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
                        + " ma_workspace WHERE tenant_id = ?"
                        + " AND workspace_id = ? FOR UPDATE",
                (result, row) -> workspaceRow(tenantId, workspaceId,
                        result), tenantId, workspaceId);
        if (records.isEmpty()) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "workspace_not_found", "Workspace not found.");
        }
        List<AccessRow> access = jdbc.query(
                "SELECT role FROM ma_workspace_access"
                        + " WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND actor_id = ? AND role IN ('READER', 'OPERATOR',"
                        + " 'OWNER') FOR UPDATE",
                (result, row) -> new AccessRow(WorkspaceAccess.valueOf(
                        result.getString("role"))), tenantId,
                workspaceId, key);
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
        var remote = jdbc.queryForList("SELECT registration_json FROM ma_storage WHERE alias_key = ? AND storage_kind = 'SSH_LOCAL'",
                String.class, com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageAliasKey(tenantId, record.getStorageId()));
        if (!remote.isEmpty()) {
            boolean allowed = false;
            if (ssh != null && ssh.isEnabled()) {
                try {
                    String nodeId = JSON.readTree(remote.getFirst()).path("nodeId").asText();
                    allowed = ssh.getNodes().stream().anyMatch(node -> node.nodeId().equals(nodeId) && node.admits(tenantId, actorId));
                } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
                    throw new ApiException(HttpStatus.CONFLICT, "workspace_unavailable", "Workspace registration is invalid.");
                }
            }
            if (!allowed) {
                throw new ApiException(HttpStatus.FORBIDDEN, "runtime_node_forbidden", "New SSH Sessions are disabled or unauthorized.");
            }
        }
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

    ResolvedBinding resolveOwnedDirectory(String tenant, String actor, String workspace, String cwd) {
        ResolvedBinding resolved = resolveForCreation(tenant, actor, new WorkspaceSelection(workspace, cwd));
        if (accessOf(tenant, actor, workspace) != WorkspaceAccess.OWNER
                || jdbc.queryForList("SELECT 1 FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND workspace_kind = 'ROOT'", Integer.class, tenant, workspace).isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "workspace_not_found", "Workspace not found.");
        }
        return resolved;
    }

    public static byte[] actorKey(String tenantId, String actorId) {
        return new WorkspaceActor(tenantId, actorId).getActorId()
                .getBytes(StandardCharsets.UTF_8);
    }

    static String descriptorRef(String configRef, String policyRef) {
        try {
            byte[] bytes = (configRef + "\u0000" + policyRef)
                    .getBytes(StandardCharsets.UTF_8);
            return "sha256:" + DigestUtils.sha256Hex(bytes);
        } catch (IllegalArgumentException error) {
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
