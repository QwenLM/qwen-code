package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** Trusted provisioner evidence, never accepted from a public request. */
public record RuntimeRecoveryEvidence(String evidenceId, Fact fact,
        String source, Instant observedAt, String hostDomain,
        String provisionRequestId, String runtimeInstanceId,
        String runtimeIncarnation, String leaseId, long epoch,
        RuntimeResourceHandle resourceHandle) {
    public enum Fact {
        JOURNAL_LOST,
        WRITERS_STOPPED
    }

    public RuntimeRecoveryEvidence {
        BrokerValues.requireId(evidenceId, "evidenceId");
        BrokerValues.requireId(source, "source");
        BrokerValues.requireId(hostDomain, "hostDomain");
        BrokerValues.requireId(provisionRequestId, "provisionRequestId");
        BrokerValues.requireId(runtimeInstanceId, "runtimeInstanceId");
        BrokerValues.requireId(runtimeIncarnation, "runtimeIncarnation");
        BrokerValues.requireId(leaseId, "leaseId");
        if (fact == null || observedAt == null || epoch <= 0
                || resourceHandle == null) {
            throw new IllegalArgumentException("Recovery evidence is incomplete");
        }
    }

    boolean matches(RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            RuntimeLease lease) {
        return seed != null
                && provisionRequestId.equals(seed.getProvisionRequestId())
                && runtimeInstanceId.equals(seed.getProvisionalRuntimeId())
                && runtimeIncarnation.equals(seed.getGatewayIncarnation())
                && leaseId.equals(seed.getLeaseId())
                && epoch == seed.getEpoch()
                && (lease == null || seed.matches(lease))
                && resourceHandle.equals(handle);
    }

    String toJson() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("version", 1);
        value.put("evidenceId", evidenceId);
        value.put("fact", fact.name());
        value.put("source", source);
        value.put("observedAt", observedAt.toString());
        value.put("hostDomain", hostDomain);
        value.put("provisionRequestId", provisionRequestId);
        value.put("runtimeInstanceId", runtimeInstanceId);
        value.put("runtimeIncarnation", runtimeIncarnation);
        value.put("leaseId", leaseId);
        value.put("epoch", epoch);
        value.put("handleKind", resourceHandle.getKind());
        value.put("handleVersion", resourceHandle.getVersion());
        value.put("handle", resourceHandle.toJson());
        return new String(JsonCodec.encode(value), StandardCharsets.UTF_8);
    }

    static RuntimeRecoveryEvidence fromJson(String json) {
        if (json == null) {
            return null;
        }
        Map<String, Object> value = JsonCodec.parseObject(
                json.getBytes(StandardCharsets.UTF_8), "Runtime recovery evidence");
        if (!Objects.equals(value.get("version"), 1) || value.size() != 14) {
            throw new IllegalArgumentException("Unsupported recovery evidence");
        }
        return new RuntimeRecoveryEvidence((String) value.get("evidenceId"),
                Fact.valueOf((String) value.get("fact")),
                (String) value.get("source"),
                Instant.parse((String) value.get("observedAt")),
                (String) value.get("hostDomain"),
                (String) value.get("provisionRequestId"),
                (String) value.get("runtimeInstanceId"),
                (String) value.get("runtimeIncarnation"),
                (String) value.get("leaseId"),
                ((Number) value.get("epoch")).longValue(),
                RuntimeResourceHandle.fromJson((String) value.get("handleKind"),
                        ((Number) value.get("handleVersion")).intValue(),
                        (String) value.get("handle")));
    }
}
