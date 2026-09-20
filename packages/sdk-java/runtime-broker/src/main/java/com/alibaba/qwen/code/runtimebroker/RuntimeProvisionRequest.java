package com.alibaba.qwen.code.runtimebroker;

import java.util.Objects;

/** Immutable Runtime placement request including its isolation key. */
public final class RuntimeProvisionRequest {
    private final RuntimeScope scope;
    private final String isolationKey;
    private final String provisionerKind;
    private final String placementDomain;
    private final String runtimeTemplateDigest;

    public RuntimeProvisionRequest(RuntimeScope scope, String isolationKey) {
        this(scope, isolationKey, "legacy", "process-local", "legacy");
    }

    public RuntimeProvisionRequest(RuntimeScope scope, String isolationKey,
            String provisionerKind, String placementDomain,
            String runtimeTemplateDigest) {
        if (scope == null) {
            throw new IllegalArgumentException("scope is required");
        }
        if ("session".equals(scope.getIsolationClass())) {
            this.isolationKey = BrokerValues.requireId(isolationKey,
                    "isolationKey");
        } else {
            if (isolationKey != null) {
                throw new IllegalArgumentException(
                        "workspace isolation must not have an isolationKey");
            }
            this.isolationKey = null;
        }
        this.scope = scope;
        this.provisionerKind = BrokerValues.requireId(provisionerKind,
                "provisionerKind");
        this.placementDomain = BrokerValues.requireId(placementDomain,
                "placementDomain");
        this.runtimeTemplateDigest = BrokerValues.requireId(
                runtimeTemplateDigest, "runtimeTemplateDigest");
    }

    public RuntimeScope getScope() {
        return scope;
    }

    public String getIsolationKey() {
        return isolationKey;
    }

    public String getProvisionerKind() {
        return provisionerKind;
    }

    public String getPlacementDomain() {
        return placementDomain;
    }

    public String getRuntimeTemplateDigest() {
        return runtimeTemplateDigest;
    }

    boolean requiresDurableIdentity() {
        return !"legacy".equals(provisionerKind)
                && !"static".equals(provisionerKind);
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof RuntimeProvisionRequest)) {
            return false;
        }
        RuntimeProvisionRequest other = (RuntimeProvisionRequest) candidate;
        return scope.equals(other.scope)
                && Objects.equals(isolationKey, other.isolationKey)
                && provisionerKind.equals(other.provisionerKind)
                && placementDomain.equals(other.placementDomain)
                && runtimeTemplateDigest.equals(
                        other.runtimeTemplateDigest);
    }

    @Override
    public int hashCode() {
        return Objects.hash(scope, isolationKey, provisionerKind,
                placementDomain, runtimeTemplateDigest);
    }
}
