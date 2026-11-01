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
        return com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.externalStorage(jdbc, binding);
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
        List<WorkspaceRow> rows = jdbc.query("SELECT r.workspace_id, r.display_name, r.state, r.workspace_kind, r.workspace_generation,"
                        + " r.storage_id, r.config_ref, r.policy_ref, s.storage_kind, a.role FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON a.tenant_id = r.tenant_id AND a.workspace_id = r.workspace_id"
                        + " LEFT JOIN ma_storage s ON s.tenant_id = r.tenant_id AND s.storage_id = r.storage_id"
                        + " WHERE r.tenant_id = ? AND a.actor_id = ? AND a.role IN ('READER', 'OPERATOR', 'OWNER')"
                        + " AND r.workspace_id > ? ORDER BY r.workspace_id LIMIT ?",
                (result, row) -> workspaceRow(result), tenantId, key, after, limit);
        return withDefaults(tenantId, summarize(tenantId, rows));
    }

    public WorkspaceSummary findReadable(String tenantId, String actorId,
            String workspaceId) {
        byte[] key = com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        List<WorkspaceRow> rows = jdbc.query(
                "SELECT r.workspace_id, r.display_name, r.state,"
                        + " r.workspace_kind, r.workspace_generation, r.storage_id,"
                        + " r.config_ref, r.policy_ref, s.storage_kind, a.role FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " LEFT JOIN ma_storage s ON s.tenant_id = r.tenant_id AND s.storage_id = r.storage_id"
                        + " WHERE r.tenant_id = ? AND r.workspace_id = ?"
                        + " AND a.actor_id = ? AND a.role IN ('READER',"
                        + " 'OPERATOR', 'OWNER')",
                (result, row) -> workspaceRow(result), tenantId, workspaceId, key);
        return rows.isEmpty() ? null : findOneReadable(tenantId, rows.getFirst());
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
        List<WorkspaceRow> rows = jdbc.query(
                "SELECT r.workspace_id, r.workspace_generation,"
                        + " r.storage_id, r.state, r.config_ref, r.policy_ref,"
                        + " s.storage_kind, a.role"
                        + " FROM ma_workspace r"
                        + " JOIN ma_workspace_access a ON"
                        + " a.tenant_id = r.tenant_id"
                        + " AND a.workspace_id = r.workspace_id"
                        + " LEFT JOIN ma_storage s ON s.tenant_id = r.tenant_id AND s.storage_id = r.storage_id"
                        + " WHERE r.tenant_id = ? AND r.workspace_id IN ("
                        + plain + ")"
                        + " AND a.actor_id = ? AND a.role IN ('READER',"
                        + " 'OPERATOR', 'OWNER')",
                (result, row) -> workspaceRow(result), arguments.toArray());
        return readableGrants(tenantId, rows);
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

    private List<WorkspaceSummary> summarize(String tenantId,
            List<WorkspaceRow> rows) {
        boolean[] external = externalEligibility(tenantId, rows);
        return java.util.stream.IntStream.range(0, rows.size()).mapToObj(index -> {
            WorkspaceRow row = rows.get(index);
            return new WorkspaceSummary(row.workspaceId(),
                    row.displayName(), row.state(),
                    row.access().atLeast(WorkspaceAccess.OPERATOR)
                            && "ACTIVE".equals(row.state())
                            && (!"EXTERNAL".equals(row.storageKind()) || external[index]), ".",
                    "OWNER".equals(row.role()) && "ACTIVE".equals(row.state())
                            && "ROOT".equals(row.workspaceKind())
                            && !"SSH_LOCAL".equals(row.storageKind())
                            && !"CSI".equals(row.storageKind())
                            && !"EXTERNAL".equals(row.storageKind()));
        }).toList();
    }

    private WorkspaceSummary findOneReadable(String tenantId, WorkspaceRow row) {
        boolean external = externalEligibility(tenantId, List.of(row))[0];
        WorkspaceSummary summary = new WorkspaceSummary(row.workspaceId(),
                row.displayName(), row.state(),
                row.access().atLeast(WorkspaceAccess.OPERATOR)
                        && "ACTIVE".equals(row.state())
                        && (!"EXTERNAL".equals(row.storageKind()) || external), ".",
                "OWNER".equals(row.role()) && "ACTIVE".equals(row.state())
                        && "ROOT".equals(row.workspaceKind())
                        && !"SSH_LOCAL".equals(row.storageKind())
                        && !"CSI".equals(row.storageKind())
                        && !"EXTERNAL".equals(row.storageKind()));
        return withDefaults(tenantId, List.of(summary)).getFirst();
    }

    private java.util.Map<String, ReadableGrant> readableGrants(String tenantId,
            List<WorkspaceRow> rows) {
        boolean[] external = externalEligibility(tenantId, rows);
        java.util.Map<String, ReadableGrant> result = new java.util.HashMap<>(rows.size() * 2);
        for (int index = 0; index < rows.size(); index++) {
            WorkspaceRow row = rows.get(index);
            result.put(row.workspaceId(), new ReadableGrant(row.workspaceId(),
                    row.workspaceGeneration(), row.storageId(),
                    row.access().atLeast(WorkspaceAccess.OPERATOR)
                            && "ACTIVE".equals(row.state())
                            && (!"EXTERNAL".equals(row.storageKind()) || external[index])));
        }
        return result;
    }

    /**
     * Resolve external eligibility after the Workspace page has been read. One
     * storage query and one readiness evaluation replace per-row JDBC reads
     * inside a ResultSet mapper.
     */
    private boolean[] externalEligibility(String tenantId, List<WorkspaceRow> rows) {
        boolean[] result = new boolean[rows.size()];
        var external = java.util.stream.IntStream.range(0, rows.size())
                .filter(index -> "EXTERNAL".equals(rows.get(index).storageKind()))
                .boxed().toList();
        if (external.isEmpty() || !externalFilesAvailable()) {
            return result;
        }
        java.util.Map<String, ExternalStorageRegistrationStore.RegistrationState> states =
                externalRegistrations.states(tenantId, external.stream()
                        .map(index -> rows.get(index).storageId()).toList());
        for (int index : external) {
            WorkspaceRow row = rows.get(index);
            var state = states.get(row.storageId());
            result[index] = "ACTIVE".equals(row.state())
                    && "ROOT".equals(row.workspaceKind())
                    && com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONTEXT_CONFIG_REF
                            .equals(descriptorRef(row.configRef(), row.policyRef()))
                    && state != null && state.current()
                    && row.workspaceId().equals(state.tenantWorkspaceId())
                    && properties.getRuntimeBroker().getExternalProviderId().equals(state.providerId());
        }
        return result;
    }

    private static WorkspaceRow workspaceRow(ResultSet result) throws SQLException {
        return new WorkspaceRow(result.getString("workspace_id"),
                result.getString("display_name"), result.getString("state"),
                result.getString("workspace_kind"), result.getLong("workspace_generation"),
                result.getString("storage_id"), result.getString("config_ref"),
                result.getString("policy_ref"), result.getString("storage_kind"),
                WorkspaceAccess.valueOf(result.getString("role")),
                result.getString("role"));
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
            throw new ManagedAgentException(HttpStatus.CONFLICT.value(), "workspace_unavailable", "External Workspace files are unavailable.");
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

    private record WorkspaceRow(String workspaceId, String displayName,
            String state, String workspaceKind, long workspaceGeneration,
            String storageId, String configRef, String policyRef,
            String storageKind, WorkspaceAccess access, String role) {
    }

}
