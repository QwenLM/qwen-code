package com.alibaba.qwen.code.managedworkspace;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Lists the Workspaces an actor can read and resolves a Session's Workspace
 * selection. It keeps no state: the Registry and the access policy are asked
 * on every call, and nothing falls back to a launch directory or to another
 * Workspace.
 */
public final class WorkspaceCatalog {
    private final WorkspaceRegistry registry;
    private final WorkspaceAccessPolicy policy;

    public WorkspaceCatalog(WorkspaceRegistry registry,
            WorkspaceAccessPolicy policy) {
        if (registry == null || policy == null) {
            throw new IllegalArgumentException(
                    "registry and policy are required");
        }
        this.registry = registry;
        this.policy = policy;
    }

    /**
     * Returns up to {@code limit} Workspaces the actor can read, after
     * {@code afterWorkspaceId} in byte order (from the first when null).
     */
    public WorkspacePage list(WorkspaceActor actor, String afterWorkspaceId,
            int limit) {
        requireActor(actor);
        if (limit < 1 || limit > ConfiguredWorkspaceRegistry.MAXIMUM_PAGE_SIZE) {
            throw new IllegalArgumentException("limit must be between 1 and "
                    + ConfiguredWorkspaceRegistry.MAXIMUM_PAGE_SIZE);
        }
        List<WorkspaceView> views = new ArrayList<>();
        boolean hasMore = false;
        String cursor = afterWorkspaceId;
        // Full batches regardless of the caller's limit: records the actor
        // cannot read are skipped, and small batches would turn a sparse
        // listing into one Registry call per record.
        int batchSize = ConfiguredWorkspaceRegistry.MAXIMUM_PAGE_SIZE;
        scan:
        while (true) {
            List<WorkspaceRecord> batch = registry.page(actor.getTenantId(),
                    cursor, batchSize);
            for (WorkspaceRecord workspace : batch) {
                if (cursor != null
                        && workspace.getWorkspaceId().compareTo(cursor) <= 0) {
                    throw new IllegalStateException(
                            "The Registry returned a page out of order");
                }
                cursor = workspace.getWorkspaceId();
                if (!workspace.getTenantId().equals(actor.getTenantId())) {
                    continue;
                }
                WorkspaceAccess access = accessFor(actor, workspace);
                if (!access.canRead()) {
                    continue;
                }
                if (views.size() == limit) {
                    hasMore = true;
                    break scan;
                }
                views.add(new WorkspaceView(workspace, access));
            }
            if (batch.size() < batchSize) {
                break;
            }
        }
        WorkspaceView defaultView = usableDefault(actor)
                .map(workspace -> new WorkspaceView(workspace,
                        WorkspaceAccess.CREATE))
                .orElse(null);
        return new WorkspacePage(views, hasMore, defaultView);
    }

    /**
     * Resolves the Workspace for a new Session. An omitted selection uses the
     * tenant default only when it is active and the actor may create Sessions
     * in it, and otherwise fails with {@code workspace_required}. An explicit
     * selection never falls back to the default.
     *
     * @throws WorkspaceException {@code workspace_required},
     *     {@code workspace_not_found}, {@code workspace_forbidden} or
     *     {@code workspace_unavailable}
     */
    public ResolvedWorkspace resolve(WorkspaceActor actor,
            WorkspaceSelection selection) {
        requireActor(actor);
        if (selection == null) {
            throw new IllegalArgumentException("selection is required");
        }
        if (selection.isOmitted()) {
            WorkspaceRecord workspace = usableDefault(actor)
                    .orElseThrow(WorkspaceException::workspaceRequired);
            return new ResolvedWorkspace(workspace, WorkspaceRelativePath.ROOT,
                    true);
        }
        WorkspaceRecord workspace = find(actor,
                selection.getWorkspaceId().orElseThrow())
                .orElseThrow(WorkspaceException::workspaceNotFound);
        WorkspaceAccess access = accessFor(actor, workspace);
        if (!access.canRead()) {
            throw WorkspaceException.workspaceNotFound();
        }
        if (!access.canCreate()) {
            throw WorkspaceException.workspaceForbidden();
        }
        if (workspace.getState() != WorkspaceState.ACTIVE) {
            throw WorkspaceException.workspaceUnavailable();
        }
        return new ResolvedWorkspace(workspace, selection.getCwdRelative(),
                false);
    }

    private Optional<WorkspaceRecord> usableDefault(WorkspaceActor actor) {
        return registry.defaultWorkspaceId(actor.getTenantId())
                .flatMap(workspaceId -> find(actor, workspaceId))
                .filter(workspace -> accessFor(actor, workspace).canCreate())
                .filter(workspace -> workspace.getState()
                        == WorkspaceState.ACTIVE);
    }

    private Optional<WorkspaceRecord> find(WorkspaceActor actor,
            String workspaceId) {
        return registry.find(actor.getTenantId(), workspaceId)
                .filter(workspace -> workspace.getTenantId()
                        .equals(actor.getTenantId())
                        && workspace.getWorkspaceId().equals(workspaceId));
    }

    private WorkspaceAccess accessFor(WorkspaceActor actor,
            WorkspaceRecord workspace) {
        WorkspaceAccess access = policy.accessFor(actor, workspace);
        if (access == null) {
            throw new IllegalStateException(
                    "The access policy returned no decision");
        }
        return access;
    }

    private static void requireActor(WorkspaceActor actor) {
        if (actor == null) {
            throw new IllegalArgumentException("actor is required");
        }
    }
}
