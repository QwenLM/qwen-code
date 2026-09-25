package com.alibaba.qwen.code.managedworkspace;

import static com.alibaba.qwen.code.managedworkspace.TestWorkspaces.OTHER_TENANT;
import static com.alibaba.qwen.code.managedworkspace.TestWorkspaces.TENANT;
import static com.alibaba.qwen.code.managedworkspace.TestWorkspaces.workspace;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class WorkspaceCatalogTest {
    private static final WorkspaceActor ALICE = new WorkspaceActor(TENANT,
            "alice");

    private static final List<WorkspaceRecord> RECORDS = List.of(
            workspace(TENANT, "alpha", WorkspaceState.ACTIVE),
            workspace(TENANT, "beta", WorkspaceState.ACTIVE),
            workspace(TENANT, "draining", WorkspaceState.DRAINING),
            workspace(TENANT, "hidden", WorkspaceState.ACTIVE),
            workspace(TENANT, "readonly", WorkspaceState.ACTIVE),
            workspace(TENANT, "removed", WorkspaceState.REMOVED),
            workspace(OTHER_TENANT, "alpha", 5, "storage-other",
                    WorkspaceState.ACTIVE),
            workspace(OTHER_TENANT, "gamma", WorkspaceState.ACTIVE));

    private static final WorkspaceAccessPolicy GRANTS =
            GrantedWorkspaceAccessPolicy.builder()
                    .grant(TENANT, "alice", "alpha", WorkspaceAccess.CREATE)
                    .grant(TENANT, "alice", "beta", WorkspaceAccess.CREATE)
                    .grant(TENANT, "alice", "draining", WorkspaceAccess.CREATE)
                    .grant(TENANT, "alice", "readonly", WorkspaceAccess.READ)
                    .grant(TENANT, "alice", "removed", WorkspaceAccess.CREATE)
                    .grant(OTHER_TENANT, "alice", "alpha",
                            WorkspaceAccess.CREATE)
                    .grant(OTHER_TENANT, "alice", "gamma",
                            WorkspaceAccess.CREATE)
                    .build();

    @Test
    void resolvesAnExplicitSelectionInTheActorsTenant() {
        ResolvedWorkspace resolved = catalog(Map.of()).resolve(ALICE,
                WorkspaceSelection.explicit("alpha", "./services//api/"));

        assertEquals(TENANT, resolved.getTenantId());
        assertEquals("alpha", resolved.getWorkspaceId());
        assertEquals(1, resolved.getWorkspaceGeneration());
        assertEquals("storage-alpha", resolved.getStorageId());
        assertEquals("config:alpha", resolved.getConfigRef());
        assertEquals("policy:default", resolved.getPolicyRef());
        assertEquals("services/api", resolved.getCwdRelative());
        assertFalse(resolved.isTenantDefault());
    }

    @Test
    void hidesMissingForeignAndUnreadableWorkspacesAlike() {
        WorkspaceCatalog catalog = catalog(Map.of());
        List<WorkspaceException> errors = new ArrayList<>();
        for (String workspaceId : List.of("nope", "gamma", "hidden", "../x",
                "")) {
            errors.add(assertThrows(WorkspaceException.class,
                    () -> catalog.resolve(ALICE,
                            WorkspaceSelection.explicit(workspaceId)),
                    workspaceId));
        }
        for (WorkspaceException error : errors) {
            assertEquals("workspace_not_found", error.getCode());
            assertEquals(404, error.getStatusCode());
            assertEquals(errors.get(0).getMessage(), error.getMessage());
        }
    }

    @Test
    void rejectsAReadOnlyWorkspaceAsForbidden() {
        WorkspaceException error = assertThrows(WorkspaceException.class,
                () -> catalog(Map.of()).resolve(ALICE,
                        WorkspaceSelection.explicit("readonly")));

        assertEquals("workspace_forbidden", error.getCode());
        assertEquals(403, error.getStatusCode());
    }

    @Test
    void rejectsAWorkspaceThatIsNotActiveAsUnavailable() {
        for (String workspaceId : List.of("draining", "removed")) {
            WorkspaceException error = assertThrows(WorkspaceException.class,
                    () -> catalog(Map.of()).resolve(ALICE,
                            WorkspaceSelection.explicit(workspaceId)),
                    workspaceId);
            assertEquals("workspace_unavailable", error.getCode());
            assertEquals(409, error.getStatusCode());
        }
    }

    @Test
    void checksAccessBeforeStateSoTheStateRevealsNothing() {
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new ConfiguredWorkspaceRegistry(List.of(
                        workspace(TENANT, "gated", WorkspaceState.DRAINING),
                        workspace(TENANT, "peek", WorkspaceState.REMOVED)),
                        Map.of()),
                GrantedWorkspaceAccessPolicy.builder()
                        .grant(TENANT, "alice", "peek", WorkspaceAccess.READ)
                        .build());

        assertEquals("workspace_not_found", assertThrows(
                WorkspaceException.class, () -> catalog.resolve(ALICE,
                        WorkspaceSelection.explicit("gated"))).getCode());
        assertEquals("workspace_forbidden", assertThrows(
                WorkspaceException.class, () -> catalog.resolve(ALICE,
                        WorkspaceSelection.explicit("peek"))).getCode());
    }

    @Test
    void checksTheDirectoryBeforeLookingUpTheWorkspace() {
        WorkspaceException error = assertThrows(WorkspaceException.class,
                () -> catalog(Map.of()).resolve(ALICE,
                        WorkspaceSelection.explicit("nope", "../x")));

        assertEquals("invalid_cwd", error.getCode());
    }

    @Test
    void neverFallsBackFromAnExplicitSelection() {
        WorkspaceException error = assertThrows(WorkspaceException.class,
                () -> catalog(Map.of(TENANT, "alpha")).resolve(ALICE,
                        WorkspaceSelection.explicit("nope")));

        assertEquals("workspace_not_found", error.getCode());
    }

    @Test
    void resolvesAnOmittedSelectionToAUsableDefault() {
        ResolvedWorkspace resolved = catalog(Map.of(TENANT, "alpha"))
                .resolve(ALICE, WorkspaceSelection.omitted());

        assertEquals("alpha", resolved.getWorkspaceId());
        assertEquals(".", resolved.getCwdRelative());
        assertTrue(resolved.isTenantDefault());
    }

    @Test
    void reportsEveryUnusableDefaultAsWorkspaceRequired() {
        List<Map<String, String>> defaults = List.of(Map.of(),
                Map.of(TENANT, "draining"), Map.of(TENANT, "removed"),
                Map.of(TENANT, "readonly"), Map.of(TENANT, "hidden"),
                Map.of(OTHER_TENANT, "gamma"));
        for (Map<String, String> tenantDefaults : defaults) {
            WorkspaceException error = assertThrows(WorkspaceException.class,
                    () -> catalog(tenantDefaults).resolve(ALICE,
                            WorkspaceSelection.omitted()),
                    tenantDefaults.toString());
            assertEquals("workspace_required", error.getCode());
            assertEquals(400, error.getStatusCode());
        }
    }

    @Test
    void listsReadableWorkspacesInByteOrderWithPermissionHints() {
        WorkspacePage page = catalog(Map.of()).list(ALICE, null, 10);

        assertEquals(List.of("alpha", "beta", "draining", "readonly",
                "removed"), ids(page));
        assertFalse(page.hasMore());
        assertEquals(List.of(true, true, true, false, true),
                page.getWorkspaces().stream()
                        .map(WorkspaceView::canCreateSession).toList());
        assertEquals(WorkspaceState.DRAINING,
                page.getWorkspaces().get(2).getState());
        assertEquals("Workspace alpha",
                page.getWorkspaces().get(0).getDisplayName());
    }

    @Test
    void pagesWithoutCountingUnreadableWorkspaces() {
        WorkspaceCatalog catalog = catalog(Map.of());

        assertPage(catalog.list(ALICE, null, 2), true, "alpha", "beta");
        assertPage(catalog.list(ALICE, "beta", 2), true, "draining",
                "readonly");
        assertPage(catalog.list(ALICE, "draining", 1), true, "readonly");
        assertPage(catalog.list(ALICE, "draining", 2), false, "readonly",
                "removed");
        assertPage(catalog.list(ALICE, "readonly", 2), false, "removed");
        assertPage(catalog.list(ALICE, "removed", 2), false);
    }

    @Test
    void reportsTheDefaultIndependentlyOfThePage() {
        WorkspacePage page = catalog(Map.of(TENANT, "alpha")).list(ALICE,
                "beta", 2);

        WorkspaceView defaultWorkspace = page.getDefaultWorkspace()
                .orElseThrow();
        assertEquals("alpha", defaultWorkspace.getWorkspaceId());
        assertTrue(defaultWorkspace.canCreateSession());
        assertFalse(ids(page).contains("alpha"));
    }

    @Test
    void omitsAnUnusableDefaultFromTheList() {
        for (String workspaceId : List.of("draining", "removed", "readonly",
                "hidden")) {
            assertTrue(catalog(Map.of(TENANT, workspaceId)).list(ALICE, null,
                    10).getDefaultWorkspace().isEmpty(), workspaceId);
        }
    }

    @Test
    void asksThePolicyOnEveryCall() {
        AtomicReference<WorkspaceAccess> access = new AtomicReference<>(
                WorkspaceAccess.CREATE);
        WorkspaceCatalog catalog = new WorkspaceCatalog(registry(Map.of()),
                (actor, workspace) -> access.get());
        catalog.resolve(ALICE, WorkspaceSelection.explicit("alpha"));

        access.set(WorkspaceAccess.READ);

        assertEquals("workspace_forbidden", assertThrows(
                WorkspaceException.class, () -> catalog.resolve(ALICE,
                        WorkspaceSelection.explicit("alpha"))).getCode());
        assertFalse(catalog.list(ALICE, null, 1).getWorkspaces().get(0)
                .canCreateSession());
    }

    @Test
    void failsClosedWhenThePolicyGivesNoDecision() {
        WorkspaceCatalog catalog = new WorkspaceCatalog(registry(Map.of()),
                (actor, workspace) -> null);

        assertThrows(IllegalStateException.class, () -> catalog.resolve(ALICE,
                WorkspaceSelection.explicit("alpha")));
        assertThrows(IllegalStateException.class,
                () -> catalog.list(ALICE, null, 10));
    }

    @Test
    void ignoresRecordsOfAnotherTenantFromAFaultyRegistry() {
        WorkspaceRecord foreign = workspace(OTHER_TENANT, "alpha",
                WorkspaceState.ACTIVE);
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new FixedRegistry(List.of(foreign), Optional.of("alpha")),
                (actor, workspace) -> WorkspaceAccess.CREATE);

        assertEquals("workspace_not_found", assertThrows(
                WorkspaceException.class, () -> catalog.resolve(ALICE,
                        WorkspaceSelection.explicit("alpha"))).getCode());
        assertEquals("workspace_required", assertThrows(
                WorkspaceException.class, () -> catalog.resolve(ALICE,
                        WorkspaceSelection.omitted())).getCode());
        WorkspacePage page = catalog.list(ALICE, null, 10);
        assertTrue(page.getWorkspaces().isEmpty());
        assertTrue(page.getDefaultWorkspace().isEmpty());
    }

    @Test
    void ignoresARecordWhoseIdDiffersFromTheOneAskedFor() {
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new FixedRegistry(List.of(
                        workspace(TENANT, "alpha2", WorkspaceState.ACTIVE)),
                        Optional.of("alpha")),
                (actor, workspace) -> WorkspaceAccess.CREATE);

        assertEquals("workspace_not_found", assertThrows(
                WorkspaceException.class, () -> catalog.resolve(ALICE,
                        WorkspaceSelection.explicit("alpha"))).getCode());
        assertEquals("workspace_required", assertThrows(
                WorkspaceException.class, () -> catalog.resolve(ALICE,
                        WorkspaceSelection.omitted())).getCode());
    }

    @Test
    void rejectsARegistryPageThatDoesNotMoveForward() {
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new FixedRegistry(List.of(
                        workspace(TENANT, "b", WorkspaceState.ACTIVE),
                        workspace(TENANT, "a", WorkspaceState.ACTIVE)),
                        Optional.empty()),
                (actor, workspace) -> WorkspaceAccess.CREATE);

        assertThrows(IllegalStateException.class,
                () -> catalog.list(ALICE, null, 10));
    }

    @Test
    void readsASparseListingInFullBatches() {
        List<WorkspaceRecord> records = new ArrayList<>();
        for (int index = 0; index < 2500; index++) {
            records.add(workspace(TENANT, String.format("hidden-%04d", index),
                    WorkspaceState.ACTIVE));
        }
        records.add(workspace(TENANT, "visible", WorkspaceState.ACTIVE));
        CountingRegistry registry = new CountingRegistry(
                new ConfiguredWorkspaceRegistry(records, Map.of()));
        WorkspaceCatalog catalog = new WorkspaceCatalog(registry,
                GrantedWorkspaceAccessPolicy.builder()
                        .grant(TENANT, "alice", "visible", WorkspaceAccess.READ)
                        .build());

        WorkspacePage page = catalog.list(ALICE, null, 1);

        assertEquals(List.of("visible"), ids(page));
        assertFalse(page.hasMore());
        assertEquals(3, registry.pageCalls);
    }

    @Test
    void rejectsARegistryThatReturnsTheCursorAgain() {
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new InclusiveRegistry(List.of(
                        workspace(TENANT, "a", WorkspaceState.ACTIVE),
                        workspace(TENANT, "b", WorkspaceState.ACTIVE))),
                (actor, workspace) -> WorkspaceAccess.CREATE);

        assertThrows(IllegalStateException.class,
                () -> catalog.list(ALICE, "a", 10));
    }

    @Test
    void rejectsInvalidArguments() {
        WorkspaceCatalog catalog = catalog(Map.of());

        assertThrows(IllegalArgumentException.class,
                () -> catalog.list(ALICE, null, 0));
        assertThrows(IllegalArgumentException.class,
                () -> catalog.list(ALICE, null, 1001));
        assertThrows(IllegalArgumentException.class,
                () -> catalog.list(null, null, 10));
        assertThrows(IllegalArgumentException.class,
                () -> catalog.resolve(ALICE, null));
        assertThrows(IllegalArgumentException.class,
                () -> catalog.resolve(null, WorkspaceSelection.omitted()));
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceCatalog(null, GRANTS));
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceCatalog(registry(Map.of()), null));
    }

    private static WorkspaceCatalog catalog(Map<String, String> defaults) {
        return new WorkspaceCatalog(registry(defaults), GRANTS);
    }

    private static ConfiguredWorkspaceRegistry registry(
            Map<String, String> defaults) {
        return new ConfiguredWorkspaceRegistry(RECORDS, defaults);
    }

    private static void assertPage(WorkspacePage page, boolean hasMore,
            String... ids) {
        assertEquals(List.of(ids), ids(page));
        assertEquals(hasMore, page.hasMore());
    }

    private static List<String> ids(WorkspacePage page) {
        return page.getWorkspaces().stream()
                .map(WorkspaceView::getWorkspaceId).toList();
    }

    /** Returns the same records for every lookup, whatever is asked. */
    private static final class FixedRegistry implements WorkspaceRegistry {
        private final List<WorkspaceRecord> records;
        private final Optional<String> defaultWorkspaceId;

        FixedRegistry(List<WorkspaceRecord> records,
                Optional<String> defaultWorkspaceId) {
            this.records = records;
            this.defaultWorkspaceId = defaultWorkspaceId;
        }

        @Override
        public Optional<WorkspaceRecord> find(String tenantId,
                String workspaceId) {
            return records.stream().findFirst();
        }

        @Override
        public List<WorkspaceRecord> page(String tenantId,
                String afterWorkspaceId, int limit) {
            return afterWorkspaceId == null ? records : List.of();
        }

        @Override
        public Optional<String> defaultWorkspaceId(String tenantId) {
            return defaultWorkspaceId;
        }
    }

    /** Counts page calls, the Registry round trips a listing costs. */
    private static final class CountingRegistry implements WorkspaceRegistry {
        private final WorkspaceRegistry delegate;
        private int pageCalls;

        CountingRegistry(WorkspaceRegistry delegate) {
            this.delegate = delegate;
        }

        @Override
        public Optional<WorkspaceRecord> find(String tenantId,
                String workspaceId) {
            return delegate.find(tenantId, workspaceId);
        }

        @Override
        public List<WorkspaceRecord> page(String tenantId,
                String afterWorkspaceId, int limit) {
            pageCalls++;
            return delegate.page(tenantId, afterWorkspaceId, limit);
        }

        @Override
        public Optional<String> defaultWorkspaceId(String tenantId) {
            return delegate.defaultWorkspaceId(tenantId);
        }
    }

    /** Treats the cursor as inclusive, which breaks the page contract. */
    private static final class InclusiveRegistry implements WorkspaceRegistry {
        private final List<WorkspaceRecord> records;

        InclusiveRegistry(List<WorkspaceRecord> records) {
            this.records = records;
        }

        @Override
        public Optional<WorkspaceRecord> find(String tenantId,
                String workspaceId) {
            return Optional.empty();
        }

        @Override
        public List<WorkspaceRecord> page(String tenantId,
                String afterWorkspaceId, int limit) {
            return records.stream()
                    .filter(workspace -> afterWorkspaceId == null
                            || workspace.getWorkspaceId()
                                    .compareTo(afterWorkspaceId) >= 0)
                    .toList();
        }

        @Override
        public Optional<String> defaultWorkspaceId(String tenantId) {
            return Optional.empty();
        }
    }
}
