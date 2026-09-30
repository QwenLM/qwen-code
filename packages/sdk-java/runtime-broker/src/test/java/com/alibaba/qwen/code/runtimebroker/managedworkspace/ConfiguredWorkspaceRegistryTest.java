package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.OTHER_TENANT;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.TENANT;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.workspace;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ConfiguredWorkspaceRegistryTest {
    @Test
    void findsOnlyWithinTheTenant() {
        WorkspaceRecord own = workspace(TENANT, "shared", WorkspaceState.ACTIVE);
        WorkspaceRecord other = workspace(OTHER_TENANT, "shared",
                WorkspaceState.ACTIVE);
        WorkspaceRecord onlyOther = workspace(OTHER_TENANT, "private",
                WorkspaceState.ACTIVE);
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                List.of(own, other, onlyOther), Map.of());

        assertEquals(own, registry.find(TENANT, "shared").orElseThrow());
        assertEquals(own, registry.find(copy(TENANT), copy("shared"))
                .orElseThrow());
        assertEquals(other, registry.find(OTHER_TENANT, "shared").orElseThrow());
        assertTrue(registry.find(TENANT, "private").isEmpty());
    }

    @Test
    void findsNothingForValuesThatCannotBeIdentifiers() {
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                List.of(workspace(TENANT, "ws-a", WorkspaceState.ACTIVE)),
                Map.of());

        assertTrue(registry.find(TENANT, "../ws-a").isEmpty());
        assertTrue(registry.find(TENANT, null).isEmpty());
        assertTrue(registry.find(null, "ws-a").isEmpty());
        assertTrue(registry.defaultWorkspaceId(null).isEmpty());
        assertTrue(registry.page(null, null, 10).isEmpty());
    }

    @Test
    void pagesInByteOrderOfTheWorkspaceId() {
        List<WorkspaceRecord> records = new ArrayList<>();
        for (String id : List.of("b", "B", "a", "_x", "0")) {
            records.add(workspace(TENANT, id, WorkspaceState.ACTIVE));
        }
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                records, Map.of());

        assertEquals(List.of("0"), ids(registry.page(TENANT, null, 1)));
        assertEquals(List.of("0", "B"), ids(registry.page(TENANT, null, 2)));
        assertEquals(List.of("_x", "a"), ids(registry.page(TENANT, "B", 2)));
        assertEquals(List.of("b"), ids(registry.page(TENANT, "a", 2)));
        assertEquals(List.of(), ids(registry.page(TENANT, "b", 2)));
        assertEquals(List.of("_x", "a", "b"),
                ids(registry.page(TENANT, "Z", 5)));
        assertEquals(List.of(), ids(registry.page(OTHER_TENANT, null, 5)));
    }

    @Test
    void returnsPagesThatCannotBeChanged() {
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                List.of(workspace(TENANT, "ws-a", WorkspaceState.ACTIVE)),
                Map.of());

        assertThrows(UnsupportedOperationException.class,
                () -> registry.page(TENANT, null, 10).clear());
    }

    @Test
    void rejectsInvalidPageArguments() {
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                List.of(), Map.of());

        assertThrows(IllegalArgumentException.class,
                () -> registry.page(TENANT, null, 0));
        assertThrows(IllegalArgumentException.class,
                () -> registry.page(TENANT, null, 1001));
        assertThrows(IllegalArgumentException.class,
                () -> registry.page(TENANT, "a/b", 10));
        assertEquals(List.of(), registry.page(TENANT, null, 1000));
    }

    @Test
    void groupsTenantsByContentNotByInstance() {
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(List.of(
                        workspace(TENANT, "ws-a", WorkspaceState.ACTIVE),
                        workspace(copy(TENANT), "ws-a", WorkspaceState.ACTIVE)),
                        Map.of()));
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                List.of(workspace(TENANT, "ws-a", WorkspaceState.ACTIVE),
                        workspace(copy(TENANT), "ws-b", WorkspaceState.ACTIVE)),
                Map.of(copy(TENANT), "ws-b"));

        assertEquals(List.of("ws-a", "ws-b"),
                ids(registry.page(TENANT, null, 10)));
        assertEquals("ws-b", registry.defaultWorkspaceId(TENANT).orElseThrow());
        Map<String, String> twice = new IdentityHashMap<>();
        twice.put(TENANT, "ws-a");
        twice.put(copy(TENANT), "ws-b");
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(List.of(
                        workspace(TENANT, "ws-a", WorkspaceState.ACTIVE),
                        workspace(TENANT, "ws-b", WorkspaceState.ACTIVE)),
                        twice));
    }

    @Test
    void keepsTenantsThatDifferInCaseApart() {
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                List.of(workspace(TENANT, "ws-x", WorkspaceState.ACTIVE),
                        workspace("TENANT-A", "ws-y", WorkspaceState.ACTIVE)),
                Map.of(TENANT, "ws-x", "TENANT-A", "ws-y"));

        assertEquals(List.of("ws-x"), ids(registry.page(TENANT, null, 10)));
        assertEquals(List.of("ws-y"), ids(registry.page("TENANT-A", null, 10)));
        assertTrue(registry.find("TENANT-A", "ws-y").isPresent());
        assertTrue(registry.find(TENANT, "ws-y").isEmpty());
        assertEquals("ws-y",
                registry.defaultWorkspaceId("TENANT-A").orElseThrow());
    }

    @Test
    void rejectsAWorkspaceRegisteredTwiceInOneTenant() {
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(List.of(
                        workspace(TENANT, "ws-a", WorkspaceState.ACTIVE),
                        workspace(TENANT, "ws-a", WorkspaceState.DRAINING)),
                        Map.of()));
    }

    @Test
    void requiresEachDefaultToNameAWorkspaceOfItsTenant() {
        List<WorkspaceRecord> records = List.of(
                workspace(TENANT, "ws-a", WorkspaceState.ACTIVE),
                workspace(OTHER_TENANT, "ws-b", WorkspaceState.ACTIVE));

        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(records,
                        Map.of(TENANT, "ws-b")));
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(records,
                        Map.of(TENANT, "missing")));
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(records,
                        Map.of("bad/tenant", "ws-a")));
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(records,
                        Map.of("tenant-without-records", "ws-a")));
        assertEquals("ws-a", new ConfiguredWorkspaceRegistry(records,
                Map.of(TENANT, "ws-a")).defaultWorkspaceId(TENANT)
                .orElseThrow());
    }

    @Test
    void allowsADefaultInAnyStateAndLeavesUsabilityToTheCatalog() {
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                List.of(workspace(TENANT, "ws-a", WorkspaceState.DRAINING)),
                Map.of(TENANT, "ws-a"));

        assertEquals("ws-a", registry.defaultWorkspaceId(TENANT).orElseThrow());
        assertTrue(registry.defaultWorkspaceId(OTHER_TENANT).isEmpty());
    }

    @Test
    void rejectsMissingInputs() {
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(null, Map.of()));
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(List.of(), null));
        List<WorkspaceRecord> withNull = new ArrayList<>();
        withNull.add(null);
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(withNull, Map.of()));
        List<WorkspaceRecord> records = List.of(
                workspace(TENANT, "ws-a", WorkspaceState.ACTIVE));
        Map<String, String> nullDefault = new HashMap<>();
        nullDefault.put(TENANT, null);
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(records, nullDefault));
        Map<String, String> nullTenant = new HashMap<>();
        nullTenant.put(null, "ws-a");
        assertThrows(IllegalArgumentException.class,
                () -> new ConfiguredWorkspaceRegistry(records, nullTenant));
    }

    @Test
    void doesNotChangeWhenTheInputsChangeLater() {
        List<WorkspaceRecord> records = new ArrayList<>(List.of(
                workspace(TENANT, "ws-a", WorkspaceState.ACTIVE)));
        Map<String, String> defaults = new HashMap<>(Map.of(TENANT, "ws-a"));
        ConfiguredWorkspaceRegistry registry = new ConfiguredWorkspaceRegistry(
                records, defaults);

        records.add(workspace(TENANT, "ws-b", WorkspaceState.ACTIVE));
        defaults.clear();

        assertTrue(registry.find(TENANT, "ws-b").isEmpty());
        assertEquals("ws-a", registry.defaultWorkspaceId(TENANT).orElseThrow());
    }

    @Test
    void acceptsSuccessorsThatKeepEveryWorkspace() {
        ConfiguredWorkspaceRegistry previous = snapshot(
                workspace(TENANT, "ws-a", 3, "storage-1", WorkspaceState.ACTIVE));

        ConfiguredWorkspaceRegistry same = snapshot(
                workspace(TENANT, "ws-a", 3, "storage-1", WorkspaceState.ACTIVE));
        assertSame(same, same.requireSuccessorOf(previous));
        snapshot(workspace(TENANT, "ws-a", 3, "storage-1",
                WorkspaceState.REMOVED)).requireSuccessorOf(previous);
        snapshot(workspace(copy(TENANT), copy("ws-a"), 3, copy("storage-1"),
                WorkspaceState.ACTIVE)).requireSuccessorOf(previous);
        snapshot(workspace(TENANT, "ws-a", 4, "storage-2",
                WorkspaceState.ACTIVE)).requireSuccessorOf(previous);
        snapshot(workspace(TENANT, "ws-a", 3, "storage-1",
                WorkspaceState.ACTIVE), workspace(TENANT, "ws-b",
                        WorkspaceState.ACTIVE)).requireSuccessorOf(previous);
    }

    @Test
    void rejectsSuccessorsThatDropLowerOrSwapStorageSilently() {
        ConfiguredWorkspaceRegistry previous = snapshot(
                workspace(TENANT, "ws-a", 3, "storage-1", WorkspaceState.ACTIVE));

        assertThrows(IllegalArgumentException.class,
                () -> snapshot().requireSuccessorOf(previous));
        assertThrows(IllegalArgumentException.class,
                () -> snapshot(workspace(OTHER_TENANT, "ws-a", 3, "storage-1",
                        WorkspaceState.ACTIVE)).requireSuccessorOf(previous));
        assertThrows(IllegalArgumentException.class,
                () -> snapshot(workspace(TENANT, "ws-a", 2, "storage-1",
                        WorkspaceState.ACTIVE)).requireSuccessorOf(previous));
        assertThrows(IllegalArgumentException.class,
                () -> snapshot(workspace(TENANT, "ws-a", 3, "storage-2",
                        WorkspaceState.ACTIVE)).requireSuccessorOf(previous));
        assertThrows(IllegalArgumentException.class,
                () -> snapshot().requireSuccessorOf(null));
    }

    @Test
    void comparesSuccessorsExactly() {
        ConfiguredWorkspaceRegistry previous = snapshot(
                workspace(TENANT, "ws-a", 3, "storage-1", WorkspaceState.ACTIVE));

        assertThrows(IllegalArgumentException.class,
                () -> snapshot(workspace(TENANT, "ws-a", 3, "Storage-1",
                        WorkspaceState.ACTIVE)).requireSuccessorOf(previous));
        assertThrows(IllegalArgumentException.class,
                () -> snapshot(workspace(TENANT, "WS-A", 3, "storage-1",
                        WorkspaceState.ACTIVE)).requireSuccessorOf(previous));
        assertThrows(IllegalArgumentException.class,
                () -> snapshot(workspace("TENANT-A", "ws-a", 3, "storage-1",
                        WorkspaceState.ACTIVE)).requireSuccessorOf(previous));
    }

    private static ConfiguredWorkspaceRegistry snapshot(
            WorkspaceRecord... records) {
        return new ConfiguredWorkspaceRegistry(List.of(records), Map.of());
    }

    private static List<String> ids(List<WorkspaceRecord> records) {
        List<String> ids = new ArrayList<>();
        for (WorkspaceRecord record : records) {
            ids.add(record.getWorkspaceId());
        }
        return ids;
    }
}
