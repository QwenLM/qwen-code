package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class HarnessOwnershipTest {
    private static final String PROFILE = WorkspaceExecutionProfile.CAPABILITY_DIGEST;

    @Test
    void sharesOnlyWorkspaceIsolatedLocalWorkspaceBindings() {
        assertTrue(HarnessOwnership.sharesRuntimeSessions(request("workspace", null, "local-process", "storage", PROFILE)));

        assertFalse(HarnessOwnership.sharesRuntimeSessions(request("session", "harness", "local-process", "storage", PROFILE)));
        assertFalse(HarnessOwnership.sharesRuntimeSessions(request("workspace", null, "local-process", null, PROFILE)));
        assertFalse(HarnessOwnership.sharesRuntimeSessions(request("workspace", null, "legacy", null, PROFILE)));
        assertFalse(HarnessOwnership.sharesRuntimeSessions(request("workspace", null, "static", null, PROFILE)));
        assertFalse(HarnessOwnership.sharesRuntimeSessions(request("workspace", null, "kubernetes-workspace", "storage", PROFILE)));
        assertFalse(HarnessOwnership.sharesRuntimeSessions(
                request("workspace", null, "local-process", "storage", "sha256:" + "b".repeat(64))));
        assertFalse(HarnessOwnership.sharesRuntimeSessions(null));
    }

    private static RuntimeProvisionRequest request(String isolation, String key, String kind, String storage,
            String digest) {
        return new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace", digest, isolation),
                key, kind, storage);
    }
}
