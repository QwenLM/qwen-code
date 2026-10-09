package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class WorkspaceAccessTest {
    @Test
    void ranksRolesInGrantOrder() {
        assertTrue(WorkspaceAccess.OWNER.atLeast(WorkspaceAccess.OPERATOR));
        assertTrue(WorkspaceAccess.OPERATOR.atLeast(WorkspaceAccess.READER));
        assertTrue(WorkspaceAccess.READER.atLeast(WorkspaceAccess.READER));
        assertFalse(WorkspaceAccess.OPERATOR.atLeast(WorkspaceAccess.OWNER));
        assertFalse(WorkspaceAccess.READER.atLeast(WorkspaceAccess.OPERATOR));
        assertFalse(WorkspaceAccess.NONE.atLeast(WorkspaceAccess.READER));
        assertThrows(IllegalArgumentException.class,
                () -> WorkspaceAccess.OWNER.atLeast(null));
    }
}
