package com.alibaba.qwen.code.runtimebroker;

import java.nio.file.Path;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ManagedExtensionExecutionProfileTest {
    @Test
    void requiresExplicitDelegationAndKeepsDeveloperModeDistinct() {
        String linux = ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST;
        String developer = ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST;
        // Absolute on the host OS. A POSIX literal such as "/private/cache" is
        // not absolute to WindowsPath, and this suite also runs on the
        // windows-latest leg of the full tier.
        String root = Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath().toString();
        String cache = Path.of(root, "managed-extension-cache").toString();
        String cgroup = Path.of(root, "cgroup").toString();
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(linux, cache, ""));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.configuration(developer, cache, cgroup));
        assertEquals("linux-cgroup", ManagedExtensionExecutionProfile.configuration(linux, cache, cgroup).get("mode"));
        assertEquals("developer-process-group", ManagedExtensionExecutionProfile.configuration(developer, cache, "").get("mode"));
        assertFalse(ManagedExtensionExecutionProfile.admits(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
        assertThrows(IllegalArgumentException.class, () -> ManagedExtensionExecutionProfile.mode(WorkspaceExecutionProfile.CAPABILITY_DIGEST));
    }
}
