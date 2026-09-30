package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.TENANT;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.workspace;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class WorkspaceViewTest {
    private static final WorkspaceRecord ALPHA = workspace(TENANT, "alpha",
            WorkspaceState.ACTIVE);

    @Test
    void showsOnlyTheListedFields() {
        WorkspaceView view = new WorkspaceView(ALPHA, WorkspaceAccess.CREATE);

        assertEquals("alpha", view.getWorkspaceId());
        assertEquals("Workspace alpha", view.getDisplayName());
        assertEquals(WorkspaceState.ACTIVE, view.getState());
        assertTrue(view.canCreateSession());
        assertFalse(new WorkspaceView(ALPHA, WorkspaceAccess.READ)
                .canCreateSession());
    }

    @Test
    void comparesByEveryField() {
        WorkspaceView view = new WorkspaceView(ALPHA, WorkspaceAccess.CREATE);

        assertEquals(new WorkspaceView(ALPHA, WorkspaceAccess.CREATE), view);
        assertEquals(new WorkspaceView(new WorkspaceRecord(copy(TENANT),
                copy("alpha"), 1, "storage-alpha",
                copy("Workspace alpha"), WorkspaceState.ACTIVE,
                "policy:default", "config:alpha"), WorkspaceAccess.CREATE),
                view);
        assertEquals(new WorkspaceView(ALPHA, WorkspaceAccess.CREATE)
                .hashCode(), view.hashCode());
        assertNotEquals(new WorkspaceView(ALPHA, WorkspaceAccess.READ), view);
        assertNotEquals(new WorkspaceView(new WorkspaceRecord(TENANT, "beta",
                1, "storage-alpha", "Workspace alpha", WorkspaceState.ACTIVE,
                "policy:default", "config:alpha"), WorkspaceAccess.CREATE),
                view);
        assertNotEquals(new WorkspaceView(workspace(TENANT, "beta",
                WorkspaceState.ACTIVE), WorkspaceAccess.CREATE), view);
        assertNotEquals(new WorkspaceView(workspace(TENANT, "alpha",
                WorkspaceState.DRAINING), WorkspaceAccess.CREATE), view);
        assertNotEquals(new WorkspaceView(new WorkspaceRecord(TENANT, "alpha",
                1, "storage-alpha", "Renamed", WorkspaceState.ACTIVE,
                "policy:default", "config:alpha"), WorkspaceAccess.CREATE),
                view);
        assertNotEquals(new WorkspaceView(new WorkspaceRecord(TENANT, "Alpha",
                1, "storage-alpha", "Workspace alpha", WorkspaceState.ACTIVE,
                "policy:default", "config:alpha"), WorkspaceAccess.CREATE),
                view);
        assertNotEquals(new WorkspaceView(new WorkspaceRecord(TENANT, "alpha",
                1, "storage-alpha", "workspace alpha", WorkspaceState.ACTIVE,
                "policy:default", "config:alpha"), WorkspaceAccess.CREATE),
                view);
        assertFalse(view.equals(null));
        assertFalse(view.equals("alpha"));
    }
}
