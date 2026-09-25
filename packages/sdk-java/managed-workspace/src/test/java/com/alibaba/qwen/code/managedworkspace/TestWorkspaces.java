package com.alibaba.qwen.code.managedworkspace;

final class TestWorkspaces {
    static final String TENANT = "tenant-a";
    static final String OTHER_TENANT = "tenant-b";

    private TestWorkspaces() {
    }

    static WorkspaceRecord workspace(String tenantId, String workspaceId,
            WorkspaceState state) {
        return workspace(tenantId, workspaceId, 1, "storage-" + workspaceId,
                state);
    }

    static WorkspaceRecord workspace(String tenantId, String workspaceId,
            long generation, String storageId, WorkspaceState state) {
        return new WorkspaceRecord(tenantId, workspaceId, generation,
                storageId, "Workspace " + workspaceId, state, "policy:default",
                "config:" + workspaceId);
    }
}
