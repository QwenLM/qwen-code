package com.alibaba.qwen.code.managedworkspace;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class WorkspaceRecordTest {
    @Test
    void keepsEveryField() {
        WorkspaceRecord record = new WorkspaceRecord("tenant.a:1",
                "ws_project-a", 7, "pvc://ns/claim-a", "项目 A",
                WorkspaceState.DRAINING, "policy:strict", "config:bundle@3");

        assertEquals("tenant.a:1", record.getTenantId());
        assertEquals("ws_project-a", record.getWorkspaceId());
        assertEquals(7, record.getWorkspaceGeneration());
        assertEquals("pvc://ns/claim-a", record.getStorageId());
        assertEquals("项目 A", record.getDisplayName());
        assertEquals(WorkspaceState.DRAINING, record.getState());
        assertEquals("policy:strict", record.getPolicyRef());
        assertEquals("config:bundle@3", record.getConfigRef());
        assertEquals("draining", record.getState().wireName());
    }

    @Test
    void rejectsInvalidIdentifiers() {
        for (String id : new String[] {null, "", "a/b", "a b", "é",
                "x".repeat(129)}) {
            assertInvalid(values -> values.tenantId = id);
            assertInvalid(values -> values.workspaceId = id);
        }
    }

    @Test
    void acceptsIdentifiersAtTheLengthLimit() {
        Values values = new Values();
        values.tenantId = "t".repeat(128);
        values.workspaceId = "w".repeat(128);
        assertEquals(128, values.build().getWorkspaceId().length());
    }

    @Test
    void rejectsANonPositiveGeneration() {
        assertInvalid(values -> values.generation = 0);
        assertInvalid(values -> values.generation = -1);
    }

    @Test
    void requiresPrintableAsciiReferences() {
        assertInvalid(values -> values.storageId = "storage a");
        assertInvalid(values -> values.storageId = "s".repeat(257));
        assertInvalid(values -> values.storageId = "");
        assertInvalid(values -> values.policyRef = "policy:é");
        assertInvalid(values -> values.configRef = "config\u007f");
        assertInvalid(values -> values.configRef = "c".repeat(513));
    }

    @Test
    void requiresBoundedDisplayTextWithoutControls() {
        assertInvalid(values -> values.displayName = "");
        assertInvalid(values -> values.displayName = "a\nb");
        assertInvalid(values -> values.displayName = "a\u009bb");
        assertInvalid(values -> values.displayName = "a\ud800");
        assertInvalid(values -> values.displayName = "x".repeat(513));

        Values values = new Values();
        values.displayName = "𝄞".repeat(512);
        assertEquals(1024, values.build().getDisplayName().length());
    }

    @Test
    void requiresAState() {
        assertInvalid(values -> values.state = null);
    }

    @Test
    void comparesByEveryField() {
        assertEquals(new Values().build(), new Values().build());
        assertEquals(new Values().build().hashCode(),
                new Values().build().hashCode());
        Values changed = new Values();
        changed.generation = 2;
        assertNotEquals(new Values().build(), changed.build());
    }

    private static void assertInvalid(Consumer<Values> change) {
        Values values = new Values();
        change.accept(values);
        assertThrows(IllegalArgumentException.class, values::build);
    }

    private static final class Values {
        private String tenantId = "tenant-a";
        private String workspaceId = "ws-a";
        private long generation = 1;
        private String storageId = "storage-a";
        private String displayName = "Workspace A";
        private WorkspaceState state = WorkspaceState.ACTIVE;
        private String policyRef = "policy:a";
        private String configRef = "config:a";

        WorkspaceRecord build() {
            return new WorkspaceRecord(tenantId, workspaceId, generation,
                    storageId, displayName, state, policyRef, configRef);
        }
    }
}
