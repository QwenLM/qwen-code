package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.OTHER_TENANT;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.TENANT;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.workspace;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

// A listing that stops advancing must fail here, not hang the build. The
// scan never checks for interrupts, so the timeout needs its own thread.
@Timeout(value = 10, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
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
    void matchesTenantsAndIdsByContentNotByInstance() {
        WorkspaceActor alice = new WorkspaceActor(copy(TENANT), "alice");
        WorkspaceCatalog catalog = catalog(Map.of(TENANT, "alpha"));

        assertEquals("alpha", catalog.resolve(alice,
                WorkspaceSelection.explicit(copy("alpha"))).getWorkspaceId());
        assertEquals("alpha", catalog.resolve(alice,
                WorkspaceSelection.omitted()).getWorkspaceId());
        WorkspacePage page = catalog.list(alice, null, 10);
        assertEquals(List.of("alpha", "beta", "draining", "readonly",
                "removed"), ids(page));
        assertEquals("alpha",
                page.getDefaultWorkspace().orElseThrow().getWorkspaceId());
    }

    @Test
    void hidesMissingForeignAndUnreadableWorkspacesAlike() {
        WorkspaceCatalog catalog = catalog(Map.of());
        List<WorkspaceException> errors = new ArrayList<>();
        for (String workspaceId : List.of("nope", "gamma", "hidden", "../x",
                "", " alpha", "alpha ")) {
            errors.add(assertThrows(WorkspaceException.class,
                    () -> catalog.resolve(ALICE,
                            WorkspaceSelection.explicit(workspaceId)),
                    workspaceId));
        }
        for (WorkspaceException error : errors) {
            assertEquals("workspace_not_found", error.getCode());
            assertEquals(404, error.getStatusCode());
            assertEquals(errors.get(0).getMessage(), error.getMessage());
            assertEquals(throwSite(errors.get(0)), throwSite(error));
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
    void reportsNoMoreWhenOnlyHiddenRecordsFollowAFullPage() {
        // A record the actor cannot see must not show up as hasMore.
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new ConfiguredWorkspaceRegistry(List.of(
                        workspace(TENANT, "alpha", WorkspaceState.ACTIVE),
                        workspace(TENANT, "beta", WorkspaceState.ACTIVE),
                        workspace(TENANT, "zz-hidden", WorkspaceState.ACTIVE)),
                        Map.of()),
                GrantedWorkspaceAccessPolicy.builder()
                        .grant(TENANT, "alice", "alpha", WorkspaceAccess.READ)
                        .grant(TENANT, "alice", "beta", WorkspaceAccess.READ)
                        .build());
        WorkspaceCatalog faulty = new WorkspaceCatalog(
                new FixedRegistry(List.of(
                        workspace(TENANT, "alpha", WorkspaceState.ACTIVE),
                        workspace(OTHER_TENANT, "zeta", WorkspaceState.ACTIVE)),
                        Optional.empty()),
                (actor, workspace) -> WorkspaceAccess.READ);

        assertPage(catalog.list(ALICE, null, 2), false, "alpha", "beta");
        assertPage(faulty.list(ALICE, null, 1), false, "alpha");
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
        // Access comes before state for the default too, so a draining
        // default still asks the policy.
        WorkspaceCatalog drainingDefault = new WorkspaceCatalog(
                registry(Map.of(TENANT, "draining")),
                (actor, workspace) -> null);
        assertThrows(IllegalStateException.class,
                () -> drainingDefault.resolve(ALICE,
                        WorkspaceSelection.omitted()));
    }

    @Test
    void ignoresRecordsOfAnotherTenantFromAFaultyRegistry() {
        // Tenant IDs compare exactly: a case variant is another tenant.
        for (String tenantId : List.of(OTHER_TENANT, "TENANT-A")) {
            WorkspaceRecord foreign = workspace(tenantId, "alpha",
                    WorkspaceState.ACTIVE);
            List<WorkspaceRecord> asked = new ArrayList<>();
            WorkspaceCatalog catalog = new WorkspaceCatalog(
                    new FixedRegistry(List.of(foreign), Optional.of("alpha")),
                    (actor, workspace) -> {
                        asked.add(workspace);
                        return WorkspaceAccess.CREATE;
                    });

            assertEquals("workspace_not_found", assertThrows(
                    WorkspaceException.class, () -> catalog.resolve(ALICE,
                            WorkspaceSelection.explicit("alpha")),
                    tenantId).getCode());
            assertEquals("workspace_required", assertThrows(
                    WorkspaceException.class, () -> catalog.resolve(ALICE,
                            WorkspaceSelection.omitted()), tenantId).getCode());
            WorkspacePage page = catalog.list(ALICE, null, 10);
            assertTrue(page.getWorkspaces().isEmpty(), tenantId);
            assertTrue(page.getDefaultWorkspace().isEmpty(), tenantId);
            // The tenant check comes first, so the policy never sees the
            // record.
            assertEquals(List.of(), asked, tenantId);
        }
    }

    @Test
    void ignoresARecordWhoseIdDiffersFromTheOneAskedFor() {
        for (String workspaceId : List.of("alpha2", "ALPHA")) {
            WorkspaceCatalog catalog = new WorkspaceCatalog(
                    new FixedRegistry(List.of(workspace(TENANT, workspaceId,
                            WorkspaceState.ACTIVE)), Optional.of("alpha")),
                    (actor, workspace) -> WorkspaceAccess.CREATE);

            assertEquals("workspace_not_found", assertThrows(
                    WorkspaceException.class, () -> catalog.resolve(ALICE,
                            WorkspaceSelection.explicit("alpha")),
                    workspaceId).getCode());
            assertEquals("workspace_required", assertThrows(
                    WorkspaceException.class, () -> catalog.resolve(ALICE,
                            WorkspaceSelection.omitted()),
                    workspaceId).getCode());
        }
    }

    @Test
    void listsIdsThatDifferInCaseInByteOrder() {
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new ConfiguredWorkspaceRegistry(List.of(
                        workspace(TENANT, "a", WorkspaceState.ACTIVE),
                        workspace(TENANT, "_x", WorkspaceState.ACTIVE),
                        workspace(TENANT, "B", WorkspaceState.ACTIVE)),
                        Map.of()),
                (actor, workspace) -> WorkspaceAccess.CREATE);

        assertPage(catalog.list(ALICE, null, 10), false, "B", "_x", "a");
        assertPage(catalog.list(ALICE, "B", 10), false, "_x", "a");
        assertPage(catalog.list(ALICE, "_x", 10), false, "a");
        assertPage(catalog.list(ALICE, "A", 10), false, "B", "_x", "a");
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
        // Order is checked over every record, including one the actor's
        // tenant does not own.
        WorkspaceCatalog mixed = new WorkspaceCatalog(
                new FixedRegistry(List.of(
                        workspace(TENANT, "alpha", WorkspaceState.ACTIVE),
                        workspace(OTHER_TENANT, "zeta", WorkspaceState.ACTIVE),
                        workspace(TENANT, "beta", WorkspaceState.ACTIVE)),
                        Optional.empty()),
                (actor, workspace) -> WorkspaceAccess.CREATE);
        assertThrows(IllegalStateException.class,
                () -> mixed.list(ALICE, null, 10));
    }

    @Test
    void readsASparseListingInFullBatches() {
        List<WorkspaceRecord> records = new ArrayList<>();
        for (int index = 0; index < 2500; index++) {
            records.add(workspace(TENANT,
                    String.format(Locale.ROOT, "hidden-%04d", index),
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
        assertEquals(List.of(1000, 1000, 1000), registry.limits);
    }

    @Test
    void readsPastAFullPageOnlyUntilTheNextReadableRecord() {
        List<WorkspaceRecord> records = new ArrayList<>();
        for (int index = 0; index < 2500; index++) {
            records.add(workspace(TENANT,
                    String.format(Locale.ROOT, "ws-%04d", index),
                    WorkspaceState.ACTIVE));
        }
        CountingRegistry dense = new CountingRegistry(
                new ConfiguredWorkspaceRegistry(records, Map.of()));
        CountingRegistry sparse = new CountingRegistry(
                new ConfiguredWorkspaceRegistry(records, Map.of()));

        // Every record is readable: the third one ends the scan.
        assertPage(new WorkspaceCatalog(dense,
                (actor, workspace) -> WorkspaceAccess.READ).list(ALICE, null, 2),
                true, "ws-0000", "ws-0001");
        assertEquals(List.of(1000), dense.limits);
        // Only the first two are readable: an exact hasMore scans to the end.
        assertPage(new WorkspaceCatalog(sparse,
                (actor, workspace) -> workspace.getWorkspaceId()
                        .compareTo("ws-0002") < 0
                        ? WorkspaceAccess.READ
                        : WorkspaceAccess.NONE).list(ALICE, null, 2),
                false, "ws-0000", "ws-0001");
        assertEquals(List.of(1000, 1000, 1000), sparse.limits);
    }

    @Test
    void neverPassesAnImpossibleIdToTheRegistry() {
        WorkspaceRegistry strict = new ValidatingRegistry(registry(Map.of()));
        WorkspaceCatalog catalog = new WorkspaceCatalog(strict, GRANTS);

        for (String workspaceId : List.of("../x", "", "a\n", "x".repeat(129))) {
            assertEquals("workspace_not_found", assertThrows(
                    WorkspaceException.class, () -> catalog.resolve(ALICE,
                            WorkspaceSelection.explicit(workspaceId)),
                    workspaceId).getCode());
        }
        assertEquals("alpha", catalog.resolve(ALICE,
                WorkspaceSelection.explicit("alpha")).getWorkspaceId());
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
    void takesEveryResolvedFieldFromTheRecord() {
        WorkspaceRecord zeta = new WorkspaceRecord("tenant-z", "zeta", 42,
                "pvc://volume-9f3", "Zeta", WorkspaceState.ACTIVE,
                "policy:strict-7", "bundle@r42");
        WorkspaceCatalog catalog = new WorkspaceCatalog(
                new ConfiguredWorkspaceRegistry(List.of(zeta), Map.of()),
                (actor, workspace) -> WorkspaceAccess.CREATE);

        ResolvedWorkspace resolved = catalog.resolve(
                new WorkspaceActor("tenant-z", "zed"),
                WorkspaceSelection.explicit("zeta", "src"));

        assertEquals("tenant-z", resolved.getTenantId());
        assertEquals("zeta", resolved.getWorkspaceId());
        assertEquals(42, resolved.getWorkspaceGeneration());
        assertEquals("pvc://volume-9f3", resolved.getStorageId());
        assertEquals("bundle@r42", resolved.getConfigRef());
        assertEquals("policy:strict-7", resolved.getPolicyRef());
        assertEquals("src", resolved.getCwdRelative());
    }

    @Test
    void rejectsACursorThatIsNotAWorkspaceId() {
        CountingRegistry registry = new CountingRegistry(registry(Map.of()));
        WorkspaceCatalog catalog = new WorkspaceCatalog(registry, GRANTS);

        for (String cursor : List.of("../x", "a\nb", "", "x".repeat(129))) {
            assertThrows(IllegalArgumentException.class,
                    () -> catalog.list(ALICE, cursor, 10), cursor);
        }
        assertEquals(List.of(), registry.limits);
    }

    @Test
    void returnsAPageThatCannotBeChanged() {
        WorkspacePage page = catalog(Map.of()).list(ALICE, null, 10);

        assertThrows(UnsupportedOperationException.class,
                () -> page.getWorkspaces().clear());
    }

    @Test
    void rejectsInvalidArguments() {
        WorkspaceCatalog catalog = catalog(Map.of());

        assertThrows(IllegalArgumentException.class,
                () -> catalog.list(ALICE, null, 0));
        assertThrows(IllegalArgumentException.class,
                () -> catalog.list(ALICE, null, 1001));
        assertEquals(5, catalog.list(ALICE, null, 1000).getWorkspaces()
                .size());
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

    /** The frames of the library code that created the error. */
    private static List<StackTraceElement> throwSite(Throwable error) {
        List<StackTraceElement> frames = new ArrayList<>();
        for (StackTraceElement frame : error.getStackTrace()) {
            if (frame.getClassName().startsWith(
                    WorkspaceCatalogTest.class.getName())) {
                break;
            }
            frames.add(frame);
        }
        assertFalse(frames.isEmpty());
        return frames;
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

    /** Records the limit of each page call a listing makes. */
    private static final class CountingRegistry implements WorkspaceRegistry {
        private final WorkspaceRegistry delegate;
        private final List<Integer> limits = new ArrayList<>();

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
            limits.add(limit);
            return delegate.page(tenantId, afterWorkspaceId, limit);
        }

        @Override
        public Optional<String> defaultWorkspaceId(String tenantId) {
            return delegate.defaultWorkspaceId(tenantId);
        }
    }

    /** Rejects a lookup of anything that cannot be a Workspace ID. */
    private static final class ValidatingRegistry
            implements WorkspaceRegistry {
        private final WorkspaceRegistry delegate;

        ValidatingRegistry(WorkspaceRegistry delegate) {
            this.delegate = delegate;
        }

        @Override
        public Optional<WorkspaceRecord> find(String tenantId,
                String workspaceId) {
            if (!workspaceId.matches("[A-Za-z0-9._:-]{1,128}")) {
                throw new IllegalArgumentException("invalid Workspace ID");
            }
            return delegate.find(tenantId, workspaceId);
        }

        @Override
        public List<WorkspaceRecord> page(String tenantId,
                String afterWorkspaceId, int limit) {
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
