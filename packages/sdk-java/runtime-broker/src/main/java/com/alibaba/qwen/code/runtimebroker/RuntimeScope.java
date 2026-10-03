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

    public RuntimeScope(String tenantId, String workspaceId,
            String workspaceGeneration, String canonicalCwd,
            String capabilityDigest, String isolationClass) {
        this.tenantId = BrokerValues.requireId(tenantId, "tenantId");
        this.workspaceId = BrokerValues.requireId(workspaceId, "workspaceId");
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
