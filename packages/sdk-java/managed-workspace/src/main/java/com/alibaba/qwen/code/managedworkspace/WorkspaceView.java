package com.alibaba.qwen.code.managedworkspace;

import java.util.Objects;

/**
 * What a Workspace list shows about one entry. It carries no storage,
 * policy or configuration reference.
 */
public final class WorkspaceView {
    private final String workspaceId;
    private final String displayName;
    private final WorkspaceState state;
    private final boolean canCreateSession;

    WorkspaceView(WorkspaceRecord workspace, WorkspaceAccess access) {
        this.workspaceId = workspace.getWorkspaceId();
        this.displayName = workspace.getDisplayName();
        this.state = workspace.getState();
        this.canCreateSession = access.canCreate();
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public String getDisplayName() {
        return displayName;
    }

    public WorkspaceState getState() {
        return state;
    }

    /**
     * Permission hint only: whether the actor may create Sessions here. The
     * state is separate, and creation checks both again.
     */
    public boolean canCreateSession() {
        return canCreateSession;
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof WorkspaceView)) {
            return false;
        }
        WorkspaceView other = (WorkspaceView) candidate;
        return workspaceId.equals(other.workspaceId)
                && displayName.equals(other.displayName)
                && state == other.state
                && canCreateSession == other.canCreateSession;
    }

    @Override
    public int hashCode() {
        return Objects.hash(workspaceId, displayName, state,
                canCreateSession);
    }
}
