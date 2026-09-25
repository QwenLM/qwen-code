package com.alibaba.qwen.code.managedworkspace;

import java.util.List;
import java.util.Optional;

/** One page of the Workspaces an actor can read, plus the tenant default. */
public final class WorkspacePage {
    private final List<WorkspaceView> workspaces;
    private final boolean hasMore;
    private final WorkspaceView defaultWorkspace;

    WorkspacePage(List<WorkspaceView> workspaces, boolean hasMore,
            WorkspaceView defaultWorkspace) {
        this.workspaces = List.copyOf(workspaces);
        this.hasMore = hasMore;
        this.defaultWorkspace = defaultWorkspace;
    }

    /** Readable Workspaces in byte order of their IDs. */
    public List<WorkspaceView> getWorkspaces() {
        return workspaces;
    }

    public boolean hasMore() {
        return hasMore;
    }

    /**
     * The tenant default, whether or not it is on this page. Present only
     * when it is active and the actor may create Sessions in it.
     */
    public Optional<WorkspaceView> getDefaultWorkspace() {
        return Optional.ofNullable(defaultWorkspace);
    }
}
