package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;

/** One attested Runtime endpoint and its immutable fencing identity. */
public final class RuntimeLease {
    private final String runtimeInstanceId;
    private final URI endpoint;
    private final String token;
    private final String leaseId;
    private final long epoch;

    public RuntimeLease(String runtimeInstanceId, URI endpoint, String token,
            String leaseId, long epoch) {
        this.runtimeInstanceId = BrokerValues.requireId(runtimeInstanceId,
                "runtimeInstanceId");
        this.endpoint = BrokerValues.requireOrigin(endpoint, "endpoint");
        this.token = BrokerValues.requireId(token, "token");
        this.leaseId = BrokerValues.requireId(leaseId, "leaseId");
        if (epoch < 0) {
            throw new IllegalArgumentException("epoch must be non-negative");
        }
        this.epoch = epoch;
    }

    public String getRuntimeInstanceId() {
        return runtimeInstanceId;
    }

    public URI getEndpoint() {
        return endpoint;
    }

    public String getToken() {
        return token;
    }

    public String getLeaseId() {
        return leaseId;
    }

    public long getEpoch() {
        return epoch;
    }
}
