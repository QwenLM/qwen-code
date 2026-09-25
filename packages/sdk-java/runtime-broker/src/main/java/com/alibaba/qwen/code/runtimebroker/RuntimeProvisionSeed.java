package com.alibaba.qwen.code.runtimebroker;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Durable credentials created before one physical Runtime is provisioned. */
public final class RuntimeProvisionSeed {
    private static final SecureRandom RANDOM = new SecureRandom();

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

    /**
     * Creates fresh credentials bound to one binding generation, so a retried
     * provision for the same binding keeps a stable identity.
     */
    public static RuntimeProvisionSeed create(String bindingId,
            long generation) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (generation <= 0) {
            throw new IllegalArgumentException("generation must be positive");
        }
        byte[] tokenBytes = new byte[32];
        RANDOM.nextBytes(tokenBytes);
        String provisionRequestId = id + ":" + generation;
        return new RuntimeProvisionSeed(provisionRequestId, id,
                provisionRequestId, UUID.randomUUID().toString(), generation,
                Base64.getUrlEncoder().withoutPadding()
                        .encodeToString(tokenBytes));
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
                && token.equals(lease.getToken())
                && provisionalRuntimeId.equals(lease.getRuntimeInstanceId());
    }

    byte[] encode() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("provisionRequestId", provisionRequestId);
        value.put("provisionalRuntimeId", provisionalRuntimeId);
        value.put("gatewayIncarnation", gatewayIncarnation);
        value.put("leaseId", leaseId);
        value.put("epoch", epoch);
        value.put("token", token);
        return JsonCodec.encode(value);
    }

    static RuntimeProvisionSeed decode(byte[] encoded) {
        Map<String, Object> value = JsonCodec.parseObject(encoded,
                "Runtime provision seed");
        if (value.size() != 6) {
            throw new IllegalStateException(
                    "Runtime provision seed is invalid");
        }
        Object rawEpoch = value.get("epoch");
        if (!(rawEpoch instanceof Number)) {
            throw new IllegalStateException(
                    "Runtime provision seed is invalid");
        }
        Number number = (Number) rawEpoch;
        long parsedEpoch = number.longValue();
        if (number.doubleValue() != parsedEpoch) {
            throw new IllegalStateException(
                    "Runtime provision seed is invalid");
        }
        try {
            return new RuntimeProvisionSeed(required(value,
                    "provisionRequestId"), required(value,
                            "provisionalRuntimeId"), required(value,
                                    "gatewayIncarnation"), required(value,
                                            "leaseId"), parsedEpoch,
                    required(value, "token"));
        } catch (IllegalArgumentException exception) {
            throw new IllegalStateException(
                    "Runtime provision seed is invalid", exception);
        }
    }

    private static String required(Map<String, Object> value,
            String field) {
        Object raw = value.get(field);
        if (!(raw instanceof String)) {
            throw new IllegalStateException(
                    "Runtime provision seed is invalid");
        }
        return (String) raw;
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
