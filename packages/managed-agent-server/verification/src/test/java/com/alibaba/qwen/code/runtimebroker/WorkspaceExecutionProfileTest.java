package com.alibaba.qwen.code.runtimebroker;

import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
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

    @Test
    void terminalDigestIsTheCanonicalCapabilityHash() {
        assertEquals("sha256:" + DigestUtils.sha256Hex(
                        "managed-workspace-execution/2;web-terminal/1"
                                .getBytes(StandardCharsets.UTF_8)),
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST);
    }

    @Test
    void terminalDigestIsAMeasuredWorkspaceCapability() {
        assertTrue(WorkspaceExecutionProfile.admitsCapabilityDigest(
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST));
        assertTrue(WorkspaceExecutionProfile.isMeasured(
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST));
        assertTrue(WorkspaceExecutionProfile.isMeasured(
                WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST));
        assertFalse(WorkspaceExecutionProfile.isMeasured(
                WorkspaceExecutionProfile.CAPABILITY_DIGEST));
        assertFalse(WorkspaceExecutionProfile.isMeasured(null));
        assertFalse(WorkspaceExecutionProfile.admitsCapabilityDigest(null));
    }
}
