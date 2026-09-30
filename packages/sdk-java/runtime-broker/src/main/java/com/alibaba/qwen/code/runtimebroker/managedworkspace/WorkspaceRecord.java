package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import java.util.Objects;

/**
 * Immutable Registry record for one administrator-registered Workspace. The
 * workspace generation grows whenever the Workspace is replaced, for example
 * when its storage changes; Sessions pin the generation they were admitted
 * with.
 */
public final class WorkspaceRecord {
    static final int MAXIMUM_STORAGE_ID_LENGTH = 256;
    static final int MAXIMUM_REFERENCE_LENGTH = 512;

    private final String tenantId;
    private final String workspaceId;
    private final long workspaceGeneration;
    private final String storageId;
    private final String displayName;
    private final WorkspaceState state;
    private final String policyRef;
    private final String configRef;

    public WorkspaceRecord(String tenantId, String workspaceId,
            long workspaceGeneration, String storageId, String displayName,
            WorkspaceState state, String policyRef, String configRef) {
        this.tenantId = WorkspaceValues.requireIdentifier(tenantId,
                "tenantId");
        this.workspaceId = WorkspaceValues.requireIdentifier(workspaceId,
                "workspaceId");
        this.workspaceGeneration = WorkspaceValues.requirePositive(
                workspaceGeneration, "workspaceGeneration");
        this.storageId = WorkspaceValues.requirePrintableAscii(storageId,
                "storageId", MAXIMUM_STORAGE_ID_LENGTH);
        this.displayName = WorkspaceValues.requireText(displayName,
                "displayName");
        if (state == null) {
            throw new IllegalArgumentException("state is required");
        }
        this.state = state;
        this.policyRef = WorkspaceValues.requirePrintableAscii(policyRef,
                "policyRef", MAXIMUM_REFERENCE_LENGTH);
        this.configRef = WorkspaceValues.requirePrintableAscii(configRef,
                "configRef", MAXIMUM_REFERENCE_LENGTH);
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

    public String getDisplayName() {
        return displayName;
    }

    public WorkspaceState getState() {
        return state;
    }

    public String getPolicyRef() {
        return policyRef;
    }

    public String getConfigRef() {
        return configRef;
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof WorkspaceRecord)) {
            return false;
        }
        WorkspaceRecord other = (WorkspaceRecord) candidate;
        return tenantId.equals(other.tenantId)
                && workspaceId.equals(other.workspaceId)
                && workspaceGeneration == other.workspaceGeneration
                && storageId.equals(other.storageId)
                && displayName.equals(other.displayName)
                && state == other.state
                && policyRef.equals(other.policyRef)
                && configRef.equals(other.configRef);
    }

    @Override
    public int hashCode() {
        return Objects.hash(tenantId, workspaceId, workspaceGeneration,
                storageId, displayName, state, policyRef, configRef);
    }
}
