package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceState;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
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
public class ManagedWorkspaceRegistry
        implements com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private com.alibaba.qwen.code.managedagent.settings.SshSettings ssh;
    private java.util.function.BooleanSupplier externalFilesActivation = () -> false;
    private ExternalStorageRegistrationStore externalRegistrations;
    private com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings properties;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void configureExternalFiles(com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings settings,
            ExternalStorageRegistrationStore registrations,
            org.springframework.beans.factory.ObjectProvider<com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector> harnesses,
            org.springframework.beans.factory.ObjectProvider<com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer> warmers) {
        this.properties = settings;
        this.externalRegistrations = registrations;
        this.externalFilesActivation = () -> {
            if (!settings.isExternalWorkspaceFilesConfigured()) {
                return false;
            }
            var harness = harnesses.getIfAvailable();
            var warmer = warmers.getIfAvailable();
            String profile = com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.EXTERNAL_FILES;
            return harness != null && warmer != null && harness.supportsLifecycle(profile)
                    && warmer.supportsWorkspaceClose(profile);
        };
    }

    public boolean externalFilesAvailable() {
        return externalFilesActivation.getAsBoolean();
    }

    public boolean isExternal(ContextBinding binding) {
        return com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.externalStorage(jdbc, binding);
    }

    public boolean externalFilesAllowed(ContextBinding binding) {
        return externalFilesAvailable() && externalBindingCurrent(binding);
    }

    private boolean externalBindingCurrent(ContextBinding binding) {
        if (binding == null || properties == null || externalRegistrations == null
                || !".".equals(binding.getCwdRelative())
                || !com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(binding.getContextConfigRef())) {
            return false;
        }
        var rows = jdbc.query("SELECT config_ref, policy_ref FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?"
                + " AND workspace_generation = ? AND storage_id = ? AND workspace_kind = 'ROOT' AND state = 'ACTIVE'",
                (row, index) -> com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF.equals(row.getString("config_ref"))
                        && com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF.equals(row.getString("policy_ref")),
                binding.getTenantId(), binding.getWorkspaceId(), binding.getWorkspaceGeneration(), binding.getStorageId());
        if (rows.size() != 1 || !rows.getFirst()) {
            return false;
        }
        var registered = externalRegistrations.find(binding.getTenantId(), binding.getStorageId()).orElse(null);
        return registered != null && binding.getWorkspaceId().equals(registered.tenantWorkspaceId())
                && properties.getRuntimeBroker().getExternalProviderId().equals(registered.providerId());
    }

    private boolean externalFilesAllowed(String tenant, String workspace) {
        try {
            if (!externalFilesAvailable()) {
                return false;
            }
            var rows = jdbc.query("SELECT workspace_generation, storage_id, config_ref, policy_ref FROM ma_workspace"
                    + " WHERE tenant_id = ? AND workspace_id = ?", (row, index) -> new ContextBinding(tenant, workspace,
                            row.getLong("workspace_generation"), row.getString("storage_id"), ".",
                            descriptorRef(row.getString("config_ref"), row.getString("policy_ref")), 1), tenant, workspace);
            return rows.size() == 1 && externalBindingCurrent(rows.getFirst());
        } catch (com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException | org.springframework.dao.DataAccessException unavailable) {
            return false;
        }
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void configureSsh(com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings properties) {
        this.ssh = properties.getRuntimeBroker().getSsh();
    }

    public ManagedWorkspaceRegistry(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public boolean createdSession(String tenantId, String actorId, String sessionId) {
        if (actorId == null || actorId.isEmpty()) {
            return false;
        }
        byte[] key;
        try {
            key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
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
            key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
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
            key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
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
        byte[] key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        byte[] after = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.identity(afterId == null ? "" : afterId);
        List<WorkspaceSummary> rows = jdbc.query("SELECT r.workspace_id, r.display_name, r.state, r.workspace_kind, s.storage_kind, a.role FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON a.tenant_id = r.tenant_id AND a.workspace_id = r.workspace_id"
                        + " LEFT JOIN ma_storage s ON s.tenant_id = r.tenant_id AND s.storage_id = r.storage_id"
                        + " WHERE r.tenant_id = ? AND a.actor_id = ? AND a.role IN ('READER', 'OPERATOR', 'OWNER')"
                        + " AND r.workspace_id > ? ORDER BY r.workspace_id LIMIT ?",
                (result, row) -> summary(tenantId, result), tenantId, key, after, limit);
        return withDefaults(tenantId, rows);
    }

    public WorkspaceSummary findReadable(String tenantId, String actorId,
            String workspaceId) {
        byte[] key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
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
                (result, row) -> summary(tenantId, result), tenantId, workspaceId, key);
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
        byte[] key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        String plain = String.join(", ", java.util.Collections.nCopies(
                workspaceIds.size(), "?"));
        List<Object> arguments = new java.util.ArrayList<>(
                workspaceIds.size() + 2);
        arguments.add(tenantId);
        arguments.addAll(workspaceIds);
        arguments.add(key);
        List<ReadableGrant> rows = jdbc.query(
                "SELECT r.workspace_id, r.workspace_generation,"
                        + " r.storage_id, r.state, s.storage_kind, a.role"
                        + " FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " LEFT JOIN ma_storage s ON s.tenant_id = r.tenant_id AND s.storage_id = r.storage_id"
                        + " WHERE r.tenant_id = ? AND r.workspace_id IN ("
                        + plain + ")"
                        + " AND a.actor_id = ? AND a.role IN ('READER',"
                        + " 'OPERATOR', 'OWNER')",
                (result, row) -> readableGrant(tenantId, result), arguments.toArray());
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

    private WorkspaceSummary summary(String tenantId, ResultSet result)
            throws SQLException {
        String state = result.getString("state");
        return new WorkspaceSummary(result.getString("workspace_id"),
                result.getString("display_name"), state,
                WorkspaceAccess.valueOf(result.getString("role"))
                        .atLeast(WorkspaceAccess.OPERATOR)
                        && "ACTIVE".equals(state) && (!"EXTERNAL".equals(result.getString("storage_kind"))
                                || externalFilesAllowed(tenantId, result.getString("workspace_id"))), ".",
                "OWNER".equals(result.getString("role")) && "ACTIVE".equals(state)
                        && "ROOT".equals(result.getString("workspace_kind"))
                        && !"SSH_LOCAL".equals(result.getString("storage_kind"))
                        && !"CSI".equals(result.getString("storage_kind"))
                        && !"EXTERNAL".equals(result.getString("storage_kind")));
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

    private ReadableGrant readableGrant(String tenantId, ResultSet result)
            throws SQLException {
        String state = result.getString("state");
        return new ReadableGrant(result.getString("workspace_id"),
                result.getLong("workspace_generation"),
                result.getString("storage_id"),
                WorkspaceAccess.valueOf(result.getString("role"))
                        .atLeast(WorkspaceAccess.OPERATOR)
                        && "ACTIVE".equals(state) && (!"EXTERNAL".equals(result.getString("storage_kind"))
                                || externalFilesAllowed(tenantId, result.getString("workspace_id"))));
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

    /**
     * A readable Workspace with the generation and storage the registry holds
     * now, so a batch caller can tell whether a Session's recorded binding is
     * still the current one.
     */

    public ResolvedBinding resolveForCreation(String tenantId,
            String actorId, WorkspaceSelection selection) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException(
                    "Workspace resolution requires a creation transaction");
        }
        if (actorId == null || actorId.isEmpty()) {
            throw new ManagedAgentException(401,
                    "actor_required", "A trusted actor is required.");
        }
        byte[] key;
        try {
            key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(403,
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
            throw new ManagedAgentException(404,
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
            throw new ManagedAgentException(404,
                    "workspace_not_found", "Workspace not found.");
        }
        if (!access.getFirst().value().canCreate()) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ManagedAgentException(403,
                    "workspace_forbidden", "Workspace cannot be used.");
        }
        WorkspaceRecord record = records.getFirst();
        requireSshNodeAccess(tenantId, actorId, record.getStorageId());
        if (record.getState() != WorkspaceState.ACTIVE) {
            if (selection == null) {
                throw workspaceRequired();
            }
            throw new ManagedAgentException(409,
                    "workspace_unavailable", "Workspace is unavailable.");
        }
        ContextBinding binding = new ContextBinding(tenantId, workspaceId,
                record.getWorkspaceGeneration(), record.getStorageId(),
                selection == null ? "." : selection.cwdRelative(),
                descriptorRef(record.getConfigRef(), record.getPolicyRef()), 1);
        if (isExternal(binding) && (!externalFilesAllowed(binding) || !".".equals(binding.getCwdRelative()))) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_unavailable", "External Workspace files are unavailable.");
        }
        return new ResolvedBinding(binding, record.getConfigRef(),
                record.getPolicyRef());
    }

    void requireSshNodeAccess(String tenantId, String actorId, String storageId) {
        var remote = jdbc.queryForList("SELECT registration_json FROM ma_storage WHERE alias_key = ? AND storage_kind = 'SSH_LOCAL'",
                String.class, com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.storageAliasKey(tenantId, storageId));
        if (!remote.isEmpty()) {
            boolean allowed = false;
            if (ssh != null && ssh.isEnabled()) {
                try {
                    String nodeId = JSON.readTree(remote.getFirst()).path("nodeId").asText();
                    allowed = ssh.getNodes().stream().anyMatch(node -> node.nodeId().equals(nodeId) && node.admits(tenantId, actorId));
                } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
                    throw new ManagedAgentException(409, "workspace_unavailable", "Workspace registration is invalid.");
                }
            }
            if (!allowed) {
                throw new ManagedAgentException(403, "runtime_node_forbidden", "SSH runtime node is disabled or unauthorized.");
            }
        }
    }

    ResolvedBinding resolveOwnedDirectory(String tenant, String actor, String workspace, String cwd) {
        ResolvedBinding resolved = resolveForCreation(tenant, actor, new WorkspaceSelection(workspace, cwd));
        if (accessOf(tenant, actor, workspace) != WorkspaceAccess.OWNER
                || jdbc.queryForList("SELECT 1 FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND workspace_kind = 'ROOT'", Integer.class, tenant, workspace).isEmpty()) {
            throw new ManagedAgentException(404, "workspace_not_found", "Workspace not found.");
        }
        return resolved;
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

    private static ManagedAgentException workspaceRequired() {
        return new ManagedAgentException(400,
                "workspace_required", "Select a Workspace.");
    }

    private record AccessRow(WorkspaceAccess value) {
    }
}
