package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.Objects;

/** The immutable external execution principal, including a committed public-child lineage. */
public final class ExternalWorkspaceSessionLineage {
    private ExternalWorkspaceSessionLineage() { }

    public static byte[] executionActor(Connection connection, ContextBinding scope, String sessionId, boolean acquiring) throws SQLException {
        Session child = read(connection, scope.getTenantId(), sessionId);
        requireScope(child, scope);
        if (WorkspaceToolProfiles.EXTERNAL_FILES.equals(child.profile())) {
            if (child.parent() != null || child.version() != 0) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return child.actor();
        }
        if (!WorkspaceToolProfiles.EXTERNAL_CONTENT.equals(child.profile()) || child.version() != 1) {
            throw WorkspaceExecutionStore.unavailable();
        }
        if (child.parent() == null) {
            if (child.root() != null || child.depth() != 0) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return child.actor();
        }
        Session parent = read(connection, scope.getTenantId(), child.parent());
        requireScope(parent, scope);
        if (parent.parent() != null || !child.parent().equals(child.root()) || child.depth() != 1
                || !WorkspaceToolProfiles.EXTERNAL_CONTENT.equals(parent.profile()) || parent.version() != 1
                || !Objects.equals(child.cwd(), parent.cwd()) || child.contextRevision() != parent.contextRevision()
                || !Arrays.equals(child.actor(), parent.actor()) || child.run() == null
                || acquiring && !"ACTIVE".equals(parent.status())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try (var statement = connection.prepareStatement("SELECT tenant_id, session_id, record_id FROM ma_session_record"
                + " WHERE session_scope_key=? AND record_key=? AND domain='child_run'")) {
            statement.setString(1, ManagedSessionStore.sessionScopeKey(scope.getTenantId(), child.parent()));
            statement.setString(2, ManagedExtensionProjection.recordKey(child.parent(), "child_run", child.run()));
            try (var row = statement.executeQuery()) {
                if (!row.next() || !scope.getTenantId().equals(row.getString("tenant_id"))
                        || !child.parent().equals(row.getString("session_id")) || !child.run().equals(row.getString("record_id")) || row.next()) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            }
        }
        return parent.actor();
    }

    private static void requireScope(Session session, ContextBinding scope) {
        if (!scope.getWorkspaceId().equals(session.workspace()) || scope.getWorkspaceGeneration() != session.generation()
                || !scope.getStorageId().equals(session.storage()) || session.actor() == null
                || !"qwen-code".equals(session.agent()) || session.definition() != null || session.deleted()
                || !WorkspaceExecutionProfile.CONFIG_REF.equals(session.configuration())
                || !WorkspaceExecutionProfile.POLICY_REF.equals(session.policy())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(session.context())) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private static Session read(Connection connection, String tenant, String id) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT * FROM ma_session WHERE tenant_id=? AND session_id=? FOR UPDATE")) {
            statement.setBytes(1, tenant.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            statement.setBytes(2, id.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            try (var row = statement.executeQuery()) {
                if (!row.next() || !tenant.equals(row.getString("tenant_id")) || !id.equals(row.getString("session_id"))) {
                    throw WorkspaceExecutionStore.unavailable();
                }
                Session session = session(row);
                if (row.next()) {
                    throw WorkspaceExecutionStore.unavailable();
                }
                return session;
            }
        }
    }

    private static Session session(ResultSet row) throws SQLException {
        byte[] owner = row.getBytes("owner_actor_key");
        return new Session(row.getString("workspace_id"), row.getLong("workspace_generation"), row.getString("workspace_storage_id"),
                row.getString("cwd_relative"), row.getString("context_config_ref"), row.getLong("context_revision"),
                row.getString("workspace_config_ref"), row.getString("workspace_policy_ref"), row.getString("tool_profile"),
                row.getInt("public_child_agents_version"), row.getString("parent_session_id"), row.getString("root_session_id"),
                row.getString("parent_child_run_id"), row.getInt("child_depth"), row.getString("status"),
                row.getString("agent_id"), row.getString("agent_definition_digest"), row.getObject("deleted_at") != null,
                owner == null ? row.getBytes("creator_actor_key") : owner);
    }

    private record Session(String workspace, long generation, String storage, String cwd, String context, long contextRevision,
            String configuration, String policy, String profile, int version, String parent, String root, String run, int depth,
            String status, String agent, String definition, boolean deleted, byte[] actor) { }
}
