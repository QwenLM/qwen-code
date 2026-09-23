package com.alibaba.qwen.code.runtimebroker;

/** Private Runtime proof returned before a restored endpoint is used. */
public final class RuntimeAttestation {
    private final String runtimeInstanceId;
    private final String runtimeIncarnation;
    private final String leaseId;
    private final long epoch;
    private final RuntimeScope scope;
    private final String provisionRequestId;

    public RuntimeAttestation(String runtimeInstanceId,
            String runtimeIncarnation, String leaseId, long epoch,
            RuntimeScope scope, String provisionRequestId) {
        this.runtimeInstanceId = BrokerValues.requireId(runtimeInstanceId,
                "runtimeInstanceId");
        this.runtimeIncarnation = BrokerValues.requireId(runtimeIncarnation,
                "runtimeIncarnation");
        this.leaseId = BrokerValues.requireId(leaseId, "leaseId");
        if (epoch <= 0) {
            throw new IllegalArgumentException("epoch must be positive");
        }
        if (scope == null) {
            throw new IllegalArgumentException("scope is required");
        }
        this.epoch = epoch;
        this.scope = scope;
        this.provisionRequestId = BrokerValues.requireId(provisionRequestId,
                "provisionRequestId");
    }

    public String getRuntimeInstanceId() {
        return runtimeInstanceId;
    }

    public String getRuntimeIncarnation() {
        return runtimeIncarnation;
    }

    public String getLeaseId() {
        return leaseId;
    }

    public long getEpoch() {
        return epoch;
    }

    public RuntimeScope getScope() {
        return scope;
    }

    public String getProvisionRequestId() {
        return provisionRequestId;
    }
}
