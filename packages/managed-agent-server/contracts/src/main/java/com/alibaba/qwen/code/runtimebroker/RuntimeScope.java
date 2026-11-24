package com.alibaba.qwen.code.runtimebroker;

import java.util.Objects;

/** Java-authoritative tenant and workspace placement scope. */
public final class RuntimeScope {
    private final String tenantId;
    private final String workspaceId;
    private final String workspaceGeneration;
    private final String canonicalCwd;
    private final String capabilityDigest;
    private final String isolationClass;
    private final RuntimeLifecycleAuthority lifecycleAuthority;

    public RuntimeLifecycleAuthority getLifecycleAuthority() {
        return lifecycleAuthority;
    }

    public RuntimeScope withLifecycleAuthority(RuntimeLifecycleAuthority authority) {
        return new RuntimeScope(tenantId, workspaceId, workspaceGeneration,
                canonicalCwd, capabilityDigest, isolationClass, authority);
    }

    public RuntimeScope(String tenantId, String workspaceId,
            String workspaceGeneration, String canonicalCwd,
            String capabilityDigest, String isolationClass) {
        this(tenantId, workspaceId, workspaceGeneration, canonicalCwd, capabilityDigest, isolationClass, null);
    }

    private RuntimeScope(String tenantId, String workspaceId, String workspaceGeneration,
            String canonicalCwd, String capabilityDigest, String isolationClass, RuntimeLifecycleAuthority authority) {
        this.lifecycleAuthority = authority;
        this.tenantId = BrokerValues.requireTenantId(tenantId, "tenantId");
        this.workspaceId = BrokerValues.requireWorkspaceId(workspaceId, "workspaceId");
        this.workspaceGeneration = BrokerValues.requireId(
                workspaceGeneration, "workspaceGeneration");
        this.canonicalCwd = BrokerValues.requireId(canonicalCwd,
                "canonicalCwd");
        this.capabilityDigest = BrokerValues.requireId(capabilityDigest,
                "capabilityDigest");
        if (!"workspace".equals(isolationClass)
                && !"session".equals(isolationClass)) {
            throw new IllegalArgumentException(
                    "isolationClass must be workspace or session");
        }
        this.isolationClass = isolationClass;
        // The canonical scope reference percent-encodes these components, so a
        // tuple the character validators admit can still overflow the column
        // budget. Refuse it here at admission rather than at a repository
        // INSERT or replay path.
        RuntimeRequestKeys.scopeKey(this);
    }

    public String getTenantId() {
        return tenantId;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public String getWorkspaceGeneration() {
        return workspaceGeneration;
    }

    public String getCanonicalCwd() {
        return canonicalCwd;
    }

    public String getCapabilityDigest() {
        return capabilityDigest;
    }

    public String getIsolationClass() {
        return isolationClass;
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof RuntimeScope)) {
            return false;
        }
        RuntimeScope other = (RuntimeScope) candidate;
        return tenantId.equals(other.tenantId)
                && workspaceId.equals(other.workspaceId)
                && workspaceGeneration.equals(other.workspaceGeneration)
                && canonicalCwd.equals(other.canonicalCwd)
                && capabilityDigest.equals(other.capabilityDigest)
                && isolationClass.equals(other.isolationClass);
    }

    @Override
    public int hashCode() {
        return Objects.hash(tenantId, workspaceId, workspaceGeneration,
                canonicalCwd, capabilityDigest, isolationClass);
    }
}
