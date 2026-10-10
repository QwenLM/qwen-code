package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CsiFilesRetirementProfileTest {
    private final ContextBinding workspace = new ContextBinding("tenant", "workspace", 3,
            "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1);

    @Test
    void pinsTheReservedWorkerCapabilityDigest() {
        assertEquals("sha256:116dcd2afce7292bdf0bf4c76010964f7a7148ad512b2939e48e3d55ea91118d",
                CsiFilesRetirementProfile.CAPABILITY_DIGEST);
    }

    @Test
    void pinsExactSessionAndUsesTheExistingManagedRequestEncoding() {
        String id = UUID.randomUUID().toString();
        var request = CsiFilesRetirementProfile.request(workspace, "/workspace", id);
        assertEquals("session", request.getScope().getIsolationClass());
        assertEquals(id, request.getIsolationKey());
        assertEquals("3", request.getScope().getWorkspaceGeneration());
        assertEquals("storage", request.getStorageId());
        assertEquals("kubernetes-workspace", request.getProvisionerKind());
        assertEquals(JdbcRepositorySupport.requestKey(request), request.requestKey());
        assertNotEquals(WorkspaceExecutionProfile.CAPABILITY_DIGEST, request.getScope().getCapabilityDigest());
        assertNotEquals(request.requestKey(), CsiFilesRetirementProfile.request(workspace,
                "/workspace", UUID.randomUUID().toString()).requestKey());
        assertNotEquals(request.requestKey(), CsiFilesRetirementProfile.request(workspace,
                "/another", id).requestKey());
    }

    @Test
    void rejectsNoncanonicalOriginalIdentity() {
        String id = UUID.randomUUID().toString();
        var subdirectory = new ContextBinding("tenant", "workspace", 3,
                "storage", "subdir", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1);
        assertThrows(IllegalArgumentException.class,
                () -> CsiFilesRetirementProfile.request(subdirectory, "/workspace", id));
        for (String path : new String[] {"/", "workspace", "/workspace/", "/a/../b", "/a//b", "/a/./b", "/a\\b"}) {
            assertThrows(IllegalArgumentException.class, () -> CsiFilesRetirementProfile.request(workspace, path, id));
        }
        for (String other : new String[] {"prompt", "1-1-1-1-1", id.toUpperCase(java.util.Locale.ROOT)}) {
            assertThrows(IllegalArgumentException.class,
                    () -> CsiFilesRetirementProfile.request(workspace, "/workspace", other));
        }
    }
}
