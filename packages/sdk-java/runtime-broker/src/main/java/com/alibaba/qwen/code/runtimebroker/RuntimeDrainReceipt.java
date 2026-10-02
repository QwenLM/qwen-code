package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;

/** Trusted proof of clean retirement of one original worker, not journal loss. */
public record RuntimeDrainReceipt(String bindingId, long generation,
        String provisionRequestId, RuntimeResourceHandle resourceHandle,
        Instant stoppedAt) {
    public RuntimeDrainReceipt {
        BrokerValues.requireId(bindingId, "bindingId");
        BrokerValues.requireId(provisionRequestId, "provisionRequestId");
        if (generation <= 0 || resourceHandle == null || stoppedAt == null) {
            throw new IllegalArgumentException("Drain receipt is incomplete");
        }
    }

    boolean matches(RuntimeBindingRecord binding) {
        return bindingId.equals(binding.getBindingId()) && generation == binding.getGeneration()
                && binding.getProvisionSeed() != null
                && provisionRequestId.equals(binding.getProvisionSeed().getProvisionRequestId())
                && (binding.getResourceHandle() == null || resourceHandle.equals(binding.getResourceHandle()));
    }

    String toJson() {
        return new String(JsonCodec.encode(Map.of("version", 1, "bindingId", bindingId,
                "generation", generation, "provisionRequestId", provisionRequestId,
                "handleKind", resourceHandle.getKind(), "handleVersion", resourceHandle.getVersion(),
                "handle", resourceHandle.toJson(), "stoppedAt", stoppedAt.toString())), StandardCharsets.UTF_8);
    }

    static RuntimeDrainReceipt fromJson(String json) {
        if (json == null) {
            return null;
        }
        var value = JsonCodec.parseObject(json.getBytes(StandardCharsets.UTF_8), "Runtime drain receipt");
        if (!Integer.valueOf(1).equals(value.get("version")) || value.size() != 8) {
            throw new IllegalArgumentException("Unsupported drain receipt");
        }
        return new RuntimeDrainReceipt((String) value.get("bindingId"),
                ((Number) value.get("generation")).longValue(), (String) value.get("provisionRequestId"),
                RuntimeResourceHandle.fromJson((String) value.get("handleKind"),
                        ((Number) value.get("handleVersion")).intValue(), (String) value.get("handle")),
                Instant.parse((String) value.get("stoppedAt")));
    }
}
