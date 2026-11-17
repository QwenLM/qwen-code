package com.alibaba.qwen.code.runtimebroker.managedworkspace;

public final class TestWorkspaces {
    public static final String TENANT = "tenant-a";
    public static final String OTHER_TENANT = "tenant-b";

    private TestWorkspaces() {
    }

    /**
     * An equal String that is a different instance. String literals are
     * interned, so only a copy makes a test fail when code compares strings
     * with {@code ==} instead of {@code equals}.
     */
    public static String copy(String value) {
        return new String(value);
    }

    public static WorkspaceRecord workspace(String tenantId, String workspaceId,
            WorkspaceState state) {
        return workspace(tenantId, workspaceId, 1, "storage-" + workspaceId,
                state);
    }

    public static WorkspaceRecord workspace(String tenantId, String workspaceId,
            long generation, String storageId, WorkspaceState state) {
        return new WorkspaceRecord(tenantId, workspaceId, generation,
                storageId, "Workspace " + workspaceId, state, "policy:default",
                "config:" + workspaceId);
    }
}
