package com.alibaba.qwen.code.runtimebroker;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

class ManagedExtensionExecutionProfileTest {
    @Test
    void requiresExplicitDelegationAndKeepsDeveloperModeDistinct(@TempDir Path directory) {
        String cacheDirectory = directory.resolve("cache").toAbsolutePath().toString();
        String cgroupRoot = directory.resolve("cgroup").toAbsolutePath().toString();
        String linux = ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST;
        String developer = ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST;
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(linux, cacheDirectory, ""));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(developer, cacheDirectory, cgroupRoot));
        assertEquals("linux-cgroup", ManagedExtensionExecutionProfile.configuration(linux, cacheDirectory, cgroupRoot).get("mode"));
        assertEquals("developer-process-group", ManagedExtensionExecutionProfile.configuration(developer, cacheDirectory, "").get("mode"));
        assertFalse(ManagedExtensionExecutionProfile.admits(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.mode(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
    }
}
