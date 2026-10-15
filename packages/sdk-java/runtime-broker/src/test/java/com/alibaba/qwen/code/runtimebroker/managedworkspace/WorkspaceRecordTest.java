package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.List;
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
        assertEquals("active", WorkspaceState.ACTIVE.wireName());
        assertEquals("removed", WorkspaceState.REMOVED.wireName());
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
        assertInvalid(values -> values.storageId = null);
        assertInvalid(values -> values.policyRef = "policy:é");
        assertInvalid(values -> values.policyRef = "p".repeat(513));
        assertInvalid(values -> values.policyRef = null);
        assertInvalid(values -> values.configRef = "config\u007f");
        assertInvalid(values -> values.configRef = "c".repeat(513));
        assertInvalid(values -> values.configRef = null);
        assertInvalid(values -> values.displayName = null);
    }

    @Test
    void acceptsEachReferenceAtItsLimit() {
        Values values = new Values();
        values.storageId = "s".repeat(256);
        values.policyRef = "p".repeat(512);
        values.configRef = "c".repeat(512);
        WorkspaceRecord record = values.build();

        assertEquals(256, record.getStorageId().length());
        assertEquals(512, record.getPolicyRef().length());
        assertEquals(512, record.getConfigRef().length());
    }

    @Test
    void requiresBoundedDisplayTextWithoutControls() {
        assertInvalid(values -> values.displayName = "");
        assertInvalid(values -> values.displayName = "a\nb");
        assertInvalid(values -> values.displayName = "a\u009bb");
        assertInvalid(values -> values.displayName = "a\ud800");
        assertInvalid(values -> values.displayName = "x".repeat(513));

        Values values = new Values();
        values.displayName = "\uD834\uDD1E".repeat(512);
        assertEquals(1024, values.build().getDisplayName().length());
        // Spaces count and are kept.
        values.displayName = " ";
        assertEquals(" ", values.build().getDisplayName());
        values.displayName = "x".repeat(511) + " ";
        assertEquals(512, values.build().getDisplayName().length());
        assertInvalid(changed -> changed.displayName = "x".repeat(512) + " ");
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
        List<Consumer<Values>> changes = List.of(
                values -> values.tenantId = "tenant-b",
                values -> values.workspaceId = "ws-b",
                values -> values.generation = 2,
                values -> values.storageId = "storage-b",
                values -> values.displayName = "Workspace B",
                values -> values.state = WorkspaceState.DRAINING,
                values -> values.policyRef = "policy:b",
                values -> values.configRef = "config:b",
                values -> values.tenantId = "TENANT-A",
                values -> values.workspaceId = "WS-A",
                values -> values.storageId = "Storage-a",
                values -> values.displayName = "workspace a",
                values -> values.policyRef = "Policy:a",
                values -> values.configRef = "Config:a");
        for (Consumer<Values> change : changes) {
            Values changed = new Values();
            change.accept(changed);
            assertNotEquals(new Values().build(), changed.build());
        }
        Values copied = new Values();
        copied.tenantId = copy(copied.tenantId);
        copied.workspaceId = copy(copied.workspaceId);
        copied.storageId = copy(copied.storageId);
        copied.displayName = copy(copied.displayName);
        copied.policyRef = copy(copied.policyRef);
        copied.configRef = copy(copied.configRef);
        assertEquals(new Values().build(), copied.build());
        WorkspaceRecord record = new Values().build();
        assertFalse(record.equals(null));
        assertFalse(record.equals(record.getWorkspaceId()));
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
