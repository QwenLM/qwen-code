package com.alibaba.qwen.code.managedworkspace;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;
import java.util.TreeMap;

/**
 * Immutable Registry snapshot built from deployment configuration. To apply a
 * change, build a new snapshot, check it with
 * {@link #requireSuccessorOf(ConfiguredWorkspaceRegistry)}, and swap it in.
 */
public final class ConfiguredWorkspaceRegistry implements WorkspaceRegistry {
    static final int MAXIMUM_PAGE_SIZE = 1000;

    // Workspace IDs are ASCII, so String order is byte order.
    private final Map<String, NavigableMap<String, WorkspaceRecord>> tenants;
    private final Map<String, String> defaults;

    /**
     * @param workspaces every registered Workspace, of any tenant
     * @param tenantDefaults the default Workspace ID of each tenant that has
     *     one; it must name a Workspace of that tenant
     */
    public ConfiguredWorkspaceRegistry(Collection<WorkspaceRecord> workspaces,
            Map<String, String> tenantDefaults) {
        if (workspaces == null || tenantDefaults == null) {
            throw new IllegalArgumentException(
                    "workspaces and tenantDefaults are required");
        }
        Map<String, NavigableMap<String, WorkspaceRecord>> byTenant =
                new HashMap<>();
        for (WorkspaceRecord workspace : workspaces) {
            if (workspace == null) {
                throw new IllegalArgumentException(
                        "workspaces must not contain null");
            }
            NavigableMap<String, WorkspaceRecord> records =
                    byTenant.computeIfAbsent(workspace.getTenantId(),
                            ignored -> new TreeMap<>());
            if (records.putIfAbsent(workspace.getWorkspaceId(), workspace)
                    != null) {
                throw new IllegalArgumentException("Workspace "
                        + describe(workspace) + " is registered twice");
            }
        }
        Map<String, String> checkedDefaults = new HashMap<>();
        for (Map.Entry<String, String> entry : tenantDefaults.entrySet()) {
            String tenantId = WorkspaceValues.requireIdentifier(entry.getKey(),
                    "tenantId");
            String workspaceId = WorkspaceValues.requireIdentifier(
                    entry.getValue(), "default workspaceId");
            NavigableMap<String, WorkspaceRecord> records =
                    byTenant.get(tenantId);
            if (records == null || !records.containsKey(workspaceId)) {
                throw new IllegalArgumentException("The default Workspace of "
                        + tenantId + " is not registered in that tenant");
            }
            checkedDefaults.put(tenantId, workspaceId);
        }
        Map<String, NavigableMap<String, WorkspaceRecord>> frozen =
                new HashMap<>();
        byTenant.forEach((tenantId, records) -> frozen.put(tenantId,
                Collections.unmodifiableNavigableMap(records)));
        this.tenants = Map.copyOf(frozen);
        this.defaults = Map.copyOf(checkedDefaults);
    }

    @Override
    public Optional<WorkspaceRecord> find(String tenantId,
            String workspaceId) {
        NavigableMap<String, WorkspaceRecord> records = recordsOf(tenantId);
        if (records == null || !WorkspaceValues.isIdentifier(workspaceId)) {
            return Optional.empty();
        }
        return Optional.ofNullable(records.get(workspaceId));
    }

    @Override
    public List<WorkspaceRecord> page(String tenantId,
            String afterWorkspaceId, int limit) {
        if (limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
            throw new IllegalArgumentException("limit must be between 1 and "
                    + MAXIMUM_PAGE_SIZE);
        }
        if (afterWorkspaceId != null) {
            WorkspaceValues.requireIdentifier(afterWorkspaceId,
                    "afterWorkspaceId");
        }
        NavigableMap<String, WorkspaceRecord> records = recordsOf(tenantId);
        if (records == null) {
            return List.of();
        }
        Collection<WorkspaceRecord> remaining = afterWorkspaceId == null
                ? records.values()
                : records.tailMap(afterWorkspaceId, false).values();
        List<WorkspaceRecord> page = new ArrayList<>();
        for (WorkspaceRecord workspace : remaining) {
            if (page.size() == limit) {
                break;
            }
            page.add(workspace);
        }
        return List.copyOf(page);
    }

    @Override
    public Optional<String> defaultWorkspaceId(String tenantId) {
        if (!WorkspaceValues.isIdentifier(tenantId)) {
            return Optional.empty();
        }
        return Optional.ofNullable(defaults.get(tenantId));
    }

    /**
     * Throws unless this snapshot may replace {@code previous}: no Workspace
     * is dropped (retire one by moving it to {@code removed}), no workspace
     * generation goes down, and a changed storage ID comes with a higher
     * generation.
     *
     * @return this snapshot
     */
    public ConfiguredWorkspaceRegistry requireSuccessorOf(
            ConfiguredWorkspaceRegistry previous) {
        if (previous == null) {
            throw new IllegalArgumentException("previous is required");
        }
        for (NavigableMap<String, WorkspaceRecord> records
                : previous.tenants.values()) {
            for (WorkspaceRecord before : records.values()) {
                WorkspaceRecord after = find(before.getTenantId(),
                        before.getWorkspaceId()).orElseThrow(
                                () -> new IllegalArgumentException("Workspace "
                                        + describe(before) + " was dropped;"
                                        + " move it to removed instead"));
                if (after.getWorkspaceGeneration()
                        < before.getWorkspaceGeneration()) {
                    throw new IllegalArgumentException("Workspace "
                            + describe(before)
                            + " must not lower its generation");
                }
                if (!after.getStorageId().equals(before.getStorageId())
                        && after.getWorkspaceGeneration()
                                == before.getWorkspaceGeneration()) {
                    throw new IllegalArgumentException("Workspace "
                            + describe(before) + " changed its storage"
                            + " without a new generation");
                }
            }
        }
        return this;
    }

    private NavigableMap<String, WorkspaceRecord> recordsOf(String tenantId) {
        return WorkspaceValues.isIdentifier(tenantId)
                ? tenants.get(tenantId)
                : null;
    }

    private static String describe(WorkspaceRecord workspace) {
        return workspace.getTenantId() + "/" + workspace.getWorkspaceId();
    }
}
