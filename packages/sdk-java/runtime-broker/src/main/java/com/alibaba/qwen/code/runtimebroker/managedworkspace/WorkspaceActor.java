package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import java.util.Objects;

/**
 * Authenticated caller identity. The embedding service builds it from its own
 * authentication; it never comes from a request body.
 */
public final class WorkspaceActor {
    private final String tenantId;
    private final String actorId;

    public WorkspaceActor(String tenantId, String actorId) {
        this.tenantId = WorkspaceValues.requireIdentifier(tenantId,
                "tenantId");
        this.actorId = WorkspaceValues.requireText(actorId, "actorId");
    }

    public String getTenantId() {
        return tenantId;
    }

    public String getActorId() {
        return actorId;
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof WorkspaceActor)) {
            return false;
        }
        WorkspaceActor other = (WorkspaceActor) candidate;
        return tenantId.equals(other.tenantId)
                && actorId.equals(other.actorId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(tenantId, actorId);
    }
}
