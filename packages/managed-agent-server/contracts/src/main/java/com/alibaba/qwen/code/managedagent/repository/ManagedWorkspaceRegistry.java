package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceActor;

import java.nio.charset.StandardCharsets;
import java.util.List;

public interface ManagedWorkspaceRegistry {
    public boolean createdSession(String tenantId, String actorId, String sessionId);

    public boolean isSessionOwner(String tenantId, String actorId, String sessionId);

    public WorkspaceAccess accessOf(String tenantId, String actorId,
            String workspaceId);

    public boolean canRead(String tenantId, String actorId,
            String workspaceId);

    public List<WorkspaceSummary> listReadable(String tenantId,
            String actorId, String afterId, int limit);

    public WorkspaceSummary findReadable(String tenantId, String actorId,
            String workspaceId);

    public java.util.Map<String, ReadableGrant> findReadable(
            String tenantId, String actorId,
            java.util.Collection<String> workspaceIds);

    public WorkspaceSummary readableDefault(String tenantId,
            String actorId);

    public boolean bindingCurrent(String tenantId, String workspaceId,
            long generation, String storageId);

    public record WorkspaceSummary(String workspaceId, String displayName,
            String state, boolean canCreateSession, String defaultCwdRelative, boolean canSelectDirectory) {
        public WorkspaceSummary(String workspaceId, String displayName, String state, boolean canCreateSession) {
            this(workspaceId, displayName, state, canCreateSession, ".", false);
        }
    }

    public record ReadableGrant(String workspaceId, long workspaceGeneration,
            String storageId, boolean canCreateSession) {
    }

    public ResolvedBinding resolveForCreation(String tenantId,
            String actorId, WorkspaceSelection selection);

    public record ResolvedBinding(ContextBinding binding, String configRef,
            String policyRef) {
    }

    public static byte[] actorKey(String tenantId, String actorId) {
        return new WorkspaceActor(tenantId, actorId).getActorId()
                .getBytes(StandardCharsets.UTF_8);
    }
}
