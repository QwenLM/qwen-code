package com.alibaba.qwen.code.runtimebroker;

import java.util.Objects;

/** Immutable Runtime placement request including its isolation key. */
public final class RuntimeProvisionRequest {
    private final RuntimeScope scope;
    private final String isolationKey;
    private final String provisionerKind;
    private final String storageId;

    public RuntimeProvisionRequest(RuntimeScope scope, String isolationKey) {
        this(scope, isolationKey, "legacy");
    }

    public RuntimeProvisionRequest(RuntimeScope scope, String isolationKey,
            String provisionerKind) {
        this(scope, isolationKey, provisionerKind, null);
    }

    /** A non-null storageId explicitly selects managed-context/1. */
    public RuntimeProvisionRequest(RuntimeScope scope, String isolationKey,
            String provisionerKind, String storageId) {
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
        this.storageId = storageId == null ? null
                : ManagedContextProtocol.storageId(storageId);
        if (isManagedContext()) {
            if (!requiresDurableIdentity()) {
                throw new IllegalArgumentException(
                        "managed context requires durable provisioning");
            }
            ManagedContextProtocol.validateScope(this);
        }
    }

    public String getStorageId() {
        return storageId;
    }

    public boolean isManagedContext() {
        return storageId != null;
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

    /**
     * Legacy and static placements keep no recoverable identity, so a READY
     * binding for them is not required to carry seed, handle, and
     * attestation facts.
     */
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
                && Objects.equals(storageId, other.storageId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(scope, isolationKey, provisionerKind, storageId);
    }
}
