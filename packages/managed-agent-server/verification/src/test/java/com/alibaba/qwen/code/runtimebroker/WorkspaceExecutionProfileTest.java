package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorkspaceExecutionProfileTest {
    @Test
    void admitsOnlySessionIsolation() {
        assertTrue(WorkspaceExecutionProfile.admitsIsolationClass("session"));
        assertFalse(WorkspaceExecutionProfile.admitsIsolationClass("workspace"));
        assertFalse(WorkspaceExecutionProfile.admitsIsolationClass("Session"));
        assertFalse(WorkspaceExecutionProfile.admitsIsolationClass(null));
    }
}
