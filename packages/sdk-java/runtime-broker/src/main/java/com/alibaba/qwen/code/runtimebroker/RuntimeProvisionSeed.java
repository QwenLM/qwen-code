package com.alibaba.qwen.code.runtimebroker;

import java.util.Objects;

/**
 * Credentials fixed before one physical Runtime is provisioned.
 *
 * <p>Durable encoding stays with the later reconcile slice. Attestation only
 * needs the identity this seed already binds.
 */
public final class RuntimeProvisionSeed {
    private final String provisionRequestId;
    private final String provisionalRuntimeId;
    private final String gatewayIncarnation;
    private final String leaseId;
    private final long epoch;
    private final String token;

    public RuntimeProvisionSeed(String provisionRequestId,
            String provisionalRuntimeId, String gatewayIncarnation,
            String leaseId, long epoch, String token) {
        this.provisionRequestId = BrokerValues.requireId(provisionRequestId,
                "provisionRequestId");
        this.provisionalRuntimeId = BrokerValues.requireId(
                provisionalRuntimeId, "provisionalRuntimeId");
        this.gatewayIncarnation = BrokerValues.requireId(gatewayIncarnation,
                "gatewayIncarnation");
        this.leaseId = BrokerValues.requireId(leaseId, "leaseId");
        if (epoch <= 0) {
            throw new IllegalArgumentException("epoch must be positive");
        }
        this.epoch = epoch;
        this.token = BrokerValues.requireId(token, "token");
    }

    public String getProvisionRequestId() {
        return provisionRequestId;
    }

    public String getProvisionalRuntimeId() {
        return provisionalRuntimeId;
    }

    public String getGatewayIncarnation() {
        return gatewayIncarnation;
    }

    public String getLeaseId() {
        return leaseId;
    }

    public long getEpoch() {
        return epoch;
    }

    public String getToken() {
        return token;
    }

    boolean matches(RuntimeLease lease) {
        return lease != null && leaseId.equals(lease.getLeaseId())
                && epoch == lease.getEpoch()
                && token.equals(lease.getToken());
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof RuntimeProvisionSeed)) {
            return false;
        }
        RuntimeProvisionSeed other = (RuntimeProvisionSeed) candidate;
        return epoch == other.epoch
                && provisionRequestId.equals(other.provisionRequestId)
                && provisionalRuntimeId.equals(other.provisionalRuntimeId)
                && gatewayIncarnation.equals(other.gatewayIncarnation)
                && leaseId.equals(other.leaseId)
                && token.equals(other.token);
    }

    @Override
    public int hashCode() {
        return Objects.hash(provisionRequestId, provisionalRuntimeId,
                gatewayIncarnation, leaseId, epoch, token);
    }
}
