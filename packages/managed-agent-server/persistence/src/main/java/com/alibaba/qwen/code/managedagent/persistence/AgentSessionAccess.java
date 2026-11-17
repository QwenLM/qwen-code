package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;

final class AgentSessionAccess {
    private AgentSessionAccess() {
    }

    static WorkspaceAccess requireContextCompressionRead(SessionRecord session, String actorId,
            JdbcManagedWorkspaceRegistry workspaces) {
        ManagedWorkspaceRegistry.requireSessionVisibility(
                session, actorId, workspaces);
        ContextBinding binding = session.workspace();
        if (binding == null) {
            throw new ManagedAgentException(400, "unsupported_feature",
                    "Context compression requires a Workspace Session.");
        }
        WorkspaceAccess access = workspaces.accessOf(session.tenantId(), actorId, binding.getWorkspaceId());
        if (!access.canRead()) {
            throw new ManagedAgentException(404, "session_not_found", "The Session was not found.");
        }
        return access;
    }

    static void requireWorkspaceCreator(SessionRecord session, String actorId, JdbcManagedWorkspaceRegistry workspaces) {
        ManagedWorkspaceRegistry.requireSessionVisibility(
                session, actorId, workspaces);
        if (!workspaces.canRead(session.tenantId(), actorId, session.workspace().getWorkspaceId())) {
            throw new ManagedAgentException(
                    404, "session_not_found", "The Session was not found.");
        }
        if (!workspaces.isSessionOwner(session.tenantId(), actorId, session.sessionId())) {
            throw new ManagedAgentException(403, "session_operation_forbidden",
                    "Only the Session owner may manage it.");
        }
    }
}
