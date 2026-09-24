package com.alibaba.qwen.code.runtimebroker;

import java.util.Objects;

/** Immutable Runtime placement request including its isolation key. */
public final class RuntimeProvisionRequest {
    private final RuntimeScope scope;
    private final String isolationKey;

    public RuntimeProvisionRequest(RuntimeScope scope, String isolationKey) {
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
    }

    public RuntimeScope getScope() {
        return scope;
    }

    public String getIsolationKey() {
        return isolationKey;
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
                && Objects.equals(isolationKey, other.isolationKey);
    }

    @Override
    public int hashCode() {
        return Objects.hash(scope, isolationKey);
    }
}
