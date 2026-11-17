package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class ManagedExtensionExecutionProfileTest {
    @Test
    void requiresExplicitDelegationAndKeepsDeveloperModeDistinct() {
        String linux = ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST;
        String developer = ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST;
        // Absolute on every platform: a POSIX literal like "/private/cache" is
        // relative on Windows, where the profile's own absolute-path check
        // rejects it before the assertion under test is reached.
        String cache = Path.of("private-cache").toAbsolutePath().toString();
        String cgroup = Path.of("cgroup").toAbsolutePath().toString();
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(linux, cache, ""));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(developer, cache, cgroup));
        assertEquals("linux-cgroup", ManagedExtensionExecutionProfile.configuration(linux, cache, cgroup).get("mode"));
        assertEquals("developer-process-group", ManagedExtensionExecutionProfile.configuration(developer, cache, "").get("mode"));
        assertFalse(ManagedExtensionExecutionProfile.admits(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.mode(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
    }
}
