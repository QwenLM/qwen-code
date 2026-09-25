package com.alibaba.qwen.code.managedworkspace;

/**
 * The Workspace a new Session binds to, as resolved on first admission. The
 * caller persists it with the creation receipt; a retry must reuse the
 * persisted result instead of resolving again.
 */
public final class ResolvedWorkspace {
    private final String tenantId;
    private final String workspaceId;
    private final long workspaceGeneration;
    private final String storageId;
    private final String configRef;
    private final String policyRef;
    private final String cwdRelative;
    private final boolean tenantDefault;

    ResolvedWorkspace(WorkspaceRecord workspace, String cwdRelative,
            boolean tenantDefault) {
        this.tenantId = workspace.getTenantId();
        this.workspaceId = workspace.getWorkspaceId();
        this.workspaceGeneration = workspace.getWorkspaceGeneration();
        this.storageId = workspace.getStorageId();
        this.configRef = workspace.getConfigRef();
        this.policyRef = workspace.getPolicyRef();
        this.cwdRelative = cwdRelative;
        this.tenantDefault = tenantDefault;
    }

    public String getTenantId() {
        return tenantId;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public long getWorkspaceGeneration() {
        return workspaceGeneration;
    }

    public String getStorageId() {
        return storageId;
    }

    public String getConfigRef() {
        return configRef;
    }

    public String getPolicyRef() {
        return policyRef;
    }

    public String getCwdRelative() {
        return cwdRelative;
    }

    /** Whether an omitted selection resolved to the tenant default. */
    public boolean isTenantDefault() {
        return tenantDefault;
    }
}
