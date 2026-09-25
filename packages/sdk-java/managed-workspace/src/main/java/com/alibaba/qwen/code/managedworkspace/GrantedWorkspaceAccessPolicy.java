package com.alibaba.qwen.code.managedworkspace;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Explicit per-actor grants, for tests and single-tenant deployments.
 * Anything not granted is {@link WorkspaceAccess#NONE}; there is no wildcard.
 */
public final class GrantedWorkspaceAccessPolicy
        implements WorkspaceAccessPolicy {
    private final Map<List<String>, WorkspaceAccess> grants;

    private GrantedWorkspaceAccessPolicy(
            Map<List<String>, WorkspaceAccess> grants) {
        this.grants = Map.copyOf(grants);
    }

    public static Builder builder() {
        return new Builder();
    }

    @Override
    public WorkspaceAccess accessFor(WorkspaceActor actor,
            WorkspaceRecord workspace) {
        if (actor == null || workspace == null
                || !actor.getTenantId().equals(workspace.getTenantId())) {
            return WorkspaceAccess.NONE;
        }
        return grants.getOrDefault(List.of(actor.getTenantId(),
                actor.getActorId(), workspace.getWorkspaceId()),
                WorkspaceAccess.NONE);
    }

    /** Collects grants; each actor gets at most one grant per Workspace. */
    public static final class Builder {
        private final Map<List<String>, WorkspaceAccess> grants =
                new HashMap<>();

        private Builder() {
        }

        public Builder grant(String tenantId, String actorId,
                String workspaceId, WorkspaceAccess access) {
            List<String> key = List.of(
                    WorkspaceValues.requireIdentifier(tenantId, "tenantId"),
                    WorkspaceValues.requireText(actorId, "actorId"),
                    WorkspaceValues.requireIdentifier(workspaceId,
                            "workspaceId"));
            if (access == null || access == WorkspaceAccess.NONE) {
                throw new IllegalArgumentException(
                        "access must be READ or CREATE");
            }
            if (grants.putIfAbsent(key, access) != null) {
                throw new IllegalArgumentException(
                        "The actor already has a grant for this Workspace");
            }
            return this;
        }

        public GrantedWorkspaceAccessPolicy build() {
            return new GrantedWorkspaceAccessPolicy(grants);
        }
    }
}
