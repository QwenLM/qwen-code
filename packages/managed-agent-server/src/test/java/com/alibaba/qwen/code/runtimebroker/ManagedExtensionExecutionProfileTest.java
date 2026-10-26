package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ManagedExtensionExecutionProfileTest {
    @Test
    void requiresExplicitDelegationAndKeepsDeveloperModeDistinct() {
        String linux = ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST;
        String developer = ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST;
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(linux, "/private/cache", ""));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(developer, "/private/cache", "/cgroup"));
        assertEquals("linux-cgroup", ManagedExtensionExecutionProfile.configuration(linux, "/private/cache", "/sys/fs/cgroup/extensions").get("mode"));
        assertEquals("developer-process-group", ManagedExtensionExecutionProfile.configuration(developer, "/private/cache", "").get("mode"));
        assertFalse(ManagedExtensionExecutionProfile.admits(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.mode(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
    }
}
