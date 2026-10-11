package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.OTHER_TENANT;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.TENANT;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.workspace;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class GrantedWorkspaceAccessPolicyTest {
    private static final WorkspaceRecord WORKSPACE = workspace(TENANT, "ws-a",
            WorkspaceState.ACTIVE);

    @Test
    void grantsOnlyTheExactTenantActorAndWorkspace() {
        GrantedWorkspaceAccessPolicy policy = GrantedWorkspaceAccessPolicy
                .builder()
                .grant(TENANT, "alice", "ws-a", WorkspaceAccess.OPERATOR)
                .grant(TENANT, "bob", "ws-a", WorkspaceAccess.READER)
                .build();

        assertEquals(WorkspaceAccess.OPERATOR,
                policy.accessFor(new WorkspaceActor(TENANT, "alice"), WORKSPACE));
        assertEquals(WorkspaceAccess.OPERATOR, policy.accessFor(
                new WorkspaceActor(copy(TENANT), copy("alice")),
                workspace(copy(TENANT), copy("ws-a"), WorkspaceState.ACTIVE)));
        assertEquals(WorkspaceAccess.READER,
                policy.accessFor(new WorkspaceActor(TENANT, "bob"), WORKSPACE));
        assertEquals(WorkspaceAccess.NONE,
                policy.accessFor(new WorkspaceActor(TENANT, "carol"), WORKSPACE));
        assertEquals(WorkspaceAccess.NONE, policy.accessFor(
                new WorkspaceActor(TENANT, "alice"),
                workspace(TENANT, "ws-b", WorkspaceState.ACTIVE)));
        assertEquals(WorkspaceAccess.NONE,
                policy.accessFor(new WorkspaceActor(TENANT, "Alice"), WORKSPACE));
        assertEquals(WorkspaceAccess.NONE, policy.accessFor(
                new WorkspaceActor(TENANT, "alice"),
                workspace(TENANT, "WS-A", WorkspaceState.ACTIVE)));
    }

    @Test
    void neverCrossesTenantsEvenForTheSameIds() {
        GrantedWorkspaceAccessPolicy policy = GrantedWorkspaceAccessPolicy
                .builder()
                .grant(OTHER_TENANT, "alice", "ws-a", WorkspaceAccess.OPERATOR)
                .build();

        assertEquals(WorkspaceAccess.NONE,
                policy.accessFor(new WorkspaceActor(TENANT, "alice"), WORKSPACE));
        assertEquals(WorkspaceAccess.NONE, policy.accessFor(
                new WorkspaceActor(OTHER_TENANT, "alice"), WORKSPACE));
        assertEquals(WorkspaceAccess.NONE, policy.accessFor(null, WORKSPACE));
        assertEquals(WorkspaceAccess.NONE, policy.accessFor(
                new WorkspaceActor(OTHER_TENANT, "alice"), null));
    }

    @Test
    void treatsATenantThatDiffersInCaseAsAnotherTenant() {
        GrantedWorkspaceAccessPolicy policy = GrantedWorkspaceAccessPolicy
                .builder()
                .grant("TENANT-A", "alice", "ws-a", WorkspaceAccess.OPERATOR)
                .build();

        assertEquals(WorkspaceAccess.NONE, policy.accessFor(
                new WorkspaceActor("TENANT-A", "alice"), WORKSPACE));
        assertEquals(WorkspaceAccess.OPERATOR, policy.accessFor(
                new WorkspaceActor("TENANT-A", "alice"),
                workspace("TENANT-A", "ws-a", WorkspaceState.ACTIVE)));
    }

    @Test
    void rejectsAmbiguousOrEmptyGrants() {
        GrantedWorkspaceAccessPolicy.Builder builder =
                GrantedWorkspaceAccessPolicy.builder()
                        .grant(TENANT, "alice", "ws-a", WorkspaceAccess.READER);

        assertThrows(IllegalArgumentException.class, () -> builder.grant(
                TENANT, "alice", "ws-a", WorkspaceAccess.OPERATOR));
        assertThrows(IllegalArgumentException.class, () -> builder.grant(
                TENANT, "alice", "ws-b", WorkspaceAccess.NONE));
        assertThrows(IllegalArgumentException.class,
                () -> builder.grant(TENANT, "alice", "ws-b", null));
        assertThrows(IllegalArgumentException.class, () -> builder.grant(
                TENANT, "alice\n", "ws-b", WorkspaceAccess.READER));
        assertThrows(IllegalArgumentException.class, () -> builder.grant(
                TENANT, "alice", "ws/b", WorkspaceAccess.READER));
        assertThrows(IllegalArgumentException.class, () -> builder.grant(
                "tenant/a", "alice", "ws-b", WorkspaceAccess.READER));
    }

    @Test
    void keepsABuiltPolicyWhenTheBuilderIsReused() {
        GrantedWorkspaceAccessPolicy.Builder builder =
                GrantedWorkspaceAccessPolicy.builder()
                        .grant(TENANT, "alice", "ws-a", WorkspaceAccess.READER);
        GrantedWorkspaceAccessPolicy policy = builder.build();

        builder.grant(TENANT, "alice", "ws-b", WorkspaceAccess.OPERATOR);

        assertEquals(WorkspaceAccess.NONE, policy.accessFor(
                new WorkspaceActor(TENANT, "alice"),
                workspace(TENANT, "ws-b", WorkspaceState.ACTIVE)));
    }

    @Test
    void grantsAnActorIdThatIsNotAnIdentifier() {
        GrantedWorkspaceAccessPolicy policy = GrantedWorkspaceAccessPolicy
                .builder()
                .grant(TENANT, "alice@example.com", "ws-a",
                        WorkspaceAccess.READER)
                .build();

        assertEquals(WorkspaceAccess.READER, policy.accessFor(
                new WorkspaceActor(TENANT, "alice@example.com"), WORKSPACE));
    }

    @Test
    void createImpliesRead() {
        assertTrue(WorkspaceAccess.OPERATOR.canRead());
        assertTrue(WorkspaceAccess.OPERATOR.canCreate());
        assertTrue(WorkspaceAccess.READER.canRead());
        assertFalse(WorkspaceAccess.READER.canCreate());
        assertFalse(WorkspaceAccess.NONE.canRead());
    }
}
