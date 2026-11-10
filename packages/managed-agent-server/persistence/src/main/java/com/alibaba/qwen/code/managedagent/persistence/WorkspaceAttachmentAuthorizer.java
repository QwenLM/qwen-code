package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

import static com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable;

/**
 * Session-attachment eligibility, split out of WorkspaceExecutionStore along
 * the authorization seam. The predicates, SQL and verdict order are the ones
 * the store enforced inline.
 */
final class WorkspaceAttachmentAuthorizer {
    private final JdbcWorkspaceExecutionStore store;
    private final JdbcTemplate jdbc;
    private final ResidentWorkspaces residents;

    WorkspaceAttachmentAuthorizer(JdbcWorkspaceExecutionStore store, JdbcTemplate jdbc, ResidentWorkspaces residents) {
        this.store = store;
        this.jdbc = jdbc;
        this.residents = residents;
    }

    void authorizeAttachment(SessionRecord session, boolean cancellation,
            boolean actionResponse, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority,
            boolean legacyClose) {
        authorizeAttachment(session, cancellation, actionResponse, authority,
                legacyClose, false);
    }

    void authorizeAttachment(SessionRecord session, boolean cancellation,
            boolean actionResponse, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority,
            boolean legacyClose, boolean committedStop) {
        boolean external = WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && store.isExternal(session.workspace());
        if (external && (!"qwen-code".equals(session.agentId()) || session.agentDefinitionDigest() != null)) {
            throw unavailable();
        }
        authorizeAttachment(session, cancellation, actionResponse, authority, legacyClose, committedStop, external);
    }

    void authorizeAttachment(SessionRecord session, boolean cancellation,
            boolean actionResponse, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority,
            boolean legacyClose, boolean committedStop, boolean external) {
        ContextBinding binding = session.workspace();
        String expectedStatus = authority == null && !legacyClose ? "ACTIVE" : session.status();
        if (binding == null || !(legacyClose ? "CLOSING".equals(session.status()) : authority == null ? "ACTIVE".equals(session.status())
                : java.util.List.of("CLOSING", "DELETING").contains(session.status()))
                || session.deletedAt() != null || !executableAgent(session.agentId(), session.agentDefinitionDigest())
                || !session.tenantId().equals(binding.getTenantId())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (!cancellation && !committedStop && authority == null && !legacyClose) {
            requireWorktreeAncestorsReady(jdbc, session.tenantId(), session.sessionId());
        }
        var resident = residents.find(binding);
        if (external) {
            if (!store.isExternal(binding) || !"hosted-workspace-external-files/1".equals(session.toolProfile())) {
                throw unavailable();
            }
        } else if (resident == null) {
            WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        } else {
            if (!WorkspaceToolProfiles.FILES.equals(session.toolProfile())
                    || jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                            + " AND parent_session_id IS NULL", Long.class, session.tenantId(), session.sessionId()) != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            ResidentWorkspaces.requireRegistration(jdbc, resident);
        }
        // Verdicts per matched row: 0 structural mismatch, 1 refused only by
        // operator-mutable grant or registry state, 2 authorized.
        byte[] executionActor = cancellation || committedStop ? null
                : external ? externalExecutionActor(binding, session.sessionId())
                        : inheritedExecutionActor(jdbc, binding, session.sessionId());
        List<Integer> grants = jdbc.query("SELECT s.tenant_id, s.session_id,"
                + " s.agent_id AS session_agent,"
                + " s.agent_definition_digest AS session_definition_digest,"
                + " s.status AS session_status,"
                + " s.deleted_at AS session_deleted_at,"
                + " s.workspace_id AS session_workspace,"
                + " s.workspace_generation AS session_generation,"
                + " s.workspace_storage_id AS session_storage,"
                + " s.cwd_relative AS session_cwd,"
                + " s.context_config_ref AS session_context,"
                + " s.context_revision AS session_revision,"
                + " s.workspace_config_ref, s.workspace_policy_ref"
                + (cancellation
                        ? ", t.tenant_id AS cancellation_tenant, t.session_id AS cancellation_session"
                        : committedStop ? ""
                        : ", r.tenant_id AS registry_tenant, r.workspace_id,"
                + " r.workspace_generation, r.storage_id, r.state,"
                + " s.tenant_id AS command_tenant, s.session_id AS command_session,"
                + " a.tenant_id AS access_tenant, a.workspace_id AS access_workspace,"
                + " a.role")
                + " FROM ma_session s"
                + (cancellation
                        ? " JOIN ma_turn t ON t.tenant_id = s.tenant_id"
                                + " AND t.session_id = s.session_id AND t.status = 'CANCELLING'"
                                + " AND (t.is_submission_attempted = TRUE OR t.harness_event_epoch IS NOT NULL)"
                        : committedStop ? ""
                        : " JOIN ma_workspace r ON r.tenant_id = s.tenant_id"
                + " AND r.workspace_id = s.workspace_id"
                + " JOIN ma_workspace_access a ON a.tenant_id = r.tenant_id"
                + " AND a.workspace_id = r.workspace_id AND a.actor_id = ?"
                + " AND a.role IN ('READER', 'OPERATOR', 'OWNER')")
                + " WHERE s.tenant_id = ? AND s.session_id = ?",
                (row, index) -> {
                    boolean structural = session.tenantId().equals(row.getString("tenant_id"))
                            && session.sessionId().equals(row.getString("session_id"))
                            && executableAgent(row.getString("session_agent"),
                                    row.getString("session_definition_digest"))
                            && expectedStatus.equals(row.getString("session_status"))
                            && row.getObject("session_deleted_at") == null
                            && binding.getWorkspaceId().equals(row.getString("session_workspace"))
                            && binding.getWorkspaceGeneration() == row.getLong("session_generation")
                            && binding.getStorageId().equals(row.getString("session_storage"))
                            && binding.getCwdRelative().equals(row.getString("session_cwd"))
                            && binding.getContextConfigRef().equals(row.getString("session_context"))
                            && binding.getContextRevision() == row.getLong("session_revision")
                            && WorkspaceExecutionProfile.CONFIG_REF.equals(
                                    row.getString("workspace_config_ref"))
                            && WorkspaceExecutionProfile.POLICY_REF.equals(
                                    row.getString("workspace_policy_ref"))
                            // Cancellation was authorized when it was persisted;
                            // retries must not depend on mutable creation grants.
                            && (cancellation
                                    ? session.tenantId().equals(row.getString("cancellation_tenant"))
                                            && session.sessionId().equals(row.getString("cancellation_session"))
                                    : committedStop
                                    || session.tenantId().equals(row.getString("registry_tenant"))
                            && session.tenantId().equals(row.getString("command_tenant"))
                            && session.sessionId().equals(row.getString("command_session"))
                            && session.tenantId().equals(row.getString("access_tenant"))
                            && binding.getWorkspaceId().equals(row.getString("workspace_id"))
                            && binding.getWorkspaceId().equals(row.getString("access_workspace"))
                            && binding.getWorkspaceGeneration() == row.getLong("workspace_generation")
                            && binding.getStorageId().equals(row.getString("storage_id")));
                    if (!structural) {
                        return 0;
                    }
                    // Grants and registry state are operator-mutable: a
                    // refusal stemming only from them is not the structural
                    // verdict the terminal exit promises.
                    return cancellation || committedStop
                            || ("ACTIVE".equals(row.getString("state"))
                                    && WorkspaceAccess.valueOf(row.getString("role"))
                                            .atLeast(WorkspaceAccess.OPERATOR))
                            ? 2 : 1;
                },
                cancellation || committedStop ? new Object[] {session.tenantId(), session.sessionId()}
                        : new Object[] {executionActor, session.tenantId(), session.sessionId()});
        if (grants.size() != 1) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (grants.getFirst() == 1) {
            throw actionResponse ? com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailablePendingGrant() : com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (grants.getFirst() != 2) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    private void requireWorktreeAncestorsReady(JdbcTemplate jdbc, String tenantId, String sessionId) {
        java.util.Set<String> visited = new java.util.HashSet<>();
        String current = sessionId;
        while (visited.add(current)) {
            JdbcSessionWorktreeStore.requireReady(store.worktreeFiles(), jdbc, tenantId, current);
            var parents = jdbc.query("SELECT parent_session_id FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    (row, index) -> row.getString(1), tenantId, current);
            if (parents.size() != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            if (parents.getFirst() == null) {
                return;
            }
            current = parents.getFirst();
        }
        throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
    }

    static byte[] inheritedExecutionActor(JdbcTemplate jdbc, ContextBinding binding, String sessionId) {
        java.util.Set<String> visited = new java.util.HashSet<>();
        String current = sessionId;
        while (visited.add(current)) {
            var rows = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, parent_session_id, creator_actor_key,"
                    + " workspace_id, workspace_generation, workspace_storage_id FROM ma_session"
                    + " WHERE tenant_id = ? AND session_id = ?", binding.getTenantId(), current);
            if (rows.size() != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            var row = rows.getFirst();
            if (!binding.getTenantId().equals(row.get("tenant_id")) || !current.equals(row.get("session_id"))
                    || !binding.getWorkspaceId().equals(row.get("workspace_id"))
                    || !(row.get("workspace_generation") instanceof Number generation)
                    || binding.getWorkspaceGeneration() != generation.longValue()
                    || !binding.getStorageId().equals(row.get("workspace_storage_id"))) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            String parent = (String) row.get("parent_session_id");
            if (parent == null) {
                if (!(row.get("creator_actor_key") instanceof byte[] actor)) {
                    throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                }
                return actor;
            }
            current = parent;
        }
        throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
    }

    private byte[] externalExecutionActor(ContextBinding binding, String sessionId) {
        var actors = jdbc.query("SELECT COALESCE(owner_actor_key, creator_actor_key) AS execution_actor"
                + " FROM ma_session WHERE tenant_id = ? AND session_id = ? AND parent_session_id IS NULL",
                (row, index) -> row.getBytes("execution_actor"),
                binding.getTenantId(), sessionId);
        if (actors.size() != 1 || actors.getFirst() == null) {
            throw unavailable();
        }
        return actors.getFirst();
    }

    // qwen-code, or a Session that pinned a compiled definition (D8c-1).
    private static boolean executableAgent(String agentId,
            String agentDefinitionDigest) {
        return "qwen-code".equals(agentId) || agentDefinitionDigest != null;
    }
}
