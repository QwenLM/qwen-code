package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;

/** Trusted proof of clean retirement of one original worker, not journal loss. */
public record RuntimeDrainReceipt(String bindingId, long generation,
        String provisionRequestId, RuntimeResourceHandle resourceHandle,
        Instant stoppedAt, String executionMode, String stopScope) {
    public RuntimeDrainReceipt(String bindingId, long generation, String provisionRequestId,
            RuntimeResourceHandle resourceHandle, Instant stoppedAt) {
        this(bindingId, generation, provisionRequestId, resourceHandle, stoppedAt, null, null);
    }

    public RuntimeDrainReceipt {
        if (executionMode == null ? stopScope != null
                : !("linux-cgroup".equals(executionMode) && "process_tree".equals(stopScope)
                    || "developer-process-group".equals(executionMode) && "process_group".equals(stopScope))) {
            throw new IllegalArgumentException("Invalid extension drain receipt scope");
        }
        BrokerValues.requireId(bindingId, "bindingId");
        BrokerValues.requireId(provisionRequestId, "provisionRequestId");
        if (generation <= 0 || resourceHandle == null || stoppedAt == null) {
            throw new IllegalArgumentException("Drain receipt is incomplete");
        }
    }

    public boolean matches(RuntimeBindingRecord binding) {
        String digest = binding.getRequest().getScope().getCapabilityDigest();
        boolean extended = ManagedExtensionExecutionProfile.admits(digest);
        if (extended) {
            if (!ManagedExtensionExecutionProfile.mode(digest).equals(executionMode)
                    || !("linux-cgroup".equals(executionMode) ? "process_tree" : "process_group").equals(stopScope)) {
                return false;
            }
        } else if (executionMode != null || stopScope != null) {
            return false;
        }
        return bindingId.equals(binding.getBindingId()) && generation == binding.getGeneration()
                && binding.getProvisionSeed() != null
                && provisionRequestId.equals(binding.getProvisionSeed().getProvisionRequestId())
                && (binding.getResourceHandle() == null || resourceHandle.equals(binding.getResourceHandle()));
    }

    String toJson() {
        Map<String, Object> value = new java.util.LinkedHashMap<>();
        value.put("version", executionMode == null ? 1 : 2);
        value.put("bindingId", bindingId);
        value.put("generation", generation);
        value.put("provisionRequestId", provisionRequestId);
        value.put("handleKind", resourceHandle.getKind());
        value.put("handleVersion", resourceHandle.getVersion());
        value.put("handle", resourceHandle.toJson());
        value.put("stoppedAt", stoppedAt.toString());
        if (executionMode != null) {
            value.put("executionMode", executionMode);
            value.put("stopScope", stopScope);
        }
        return new String(JsonCodec.encode(value), StandardCharsets.UTF_8);
    }

    static RuntimeDrainReceipt fromJson(String json) {
        if (json == null) {
            return null;
        }
        var value = JsonCodec.parseObject(json.getBytes(StandardCharsets.UTF_8), "Runtime drain receipt");
        boolean extended = Integer.valueOf(2).equals(value.get("version"));
        if (extended && (!java.util.Set.of("linux-cgroup", "developer-process-group").contains(value.get("executionMode"))
                || !("linux-cgroup".equals(value.get("executionMode")) ? "process_tree" : "process_group").equals(value.get("stopScope")))) {
            throw new IllegalArgumentException("Invalid extension stop scope");
        }
        if (extended ? !value.keySet().equals(java.util.Set.of("version", "bindingId", "generation", "provisionRequestId", "handleKind", "handleVersion", "handle", "stoppedAt", "executionMode", "stopScope")) : !Integer.valueOf(1).equals(value.get("version")) || !value.keySet().equals(java.util.Set.of("version", "bindingId", "generation", "provisionRequestId", "handleKind", "handleVersion", "handle", "stoppedAt"))) {
            throw new IllegalArgumentException("Unsupported drain receipt");
        }
        return new RuntimeDrainReceipt((String) value.get("bindingId"),
                ((Number) value.get("generation")).longValue(), (String) value.get("provisionRequestId"),
                RuntimeResourceHandle.fromJson((String) value.get("handleKind"),
                        ((Number) value.get("handleVersion")).intValue(), (String) value.get("handle")),
                Instant.parse((String) value.get("stoppedAt")), extended ? (String) value.get("executionMode") : null, extended ? (String) value.get("stopScope") : null);
    }
}
