package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedToolMeasurements;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Private v4 transport metadata; never part of a legacy tool-result envelope. */
public final class RuntimeToolMeasurements {
    public static final String FIELD = "diagnostics";

    private RuntimeToolMeasurements() {}

    public static boolean selected(Map<String, Object> reference) {
        return Integer.valueOf(4).equals(reference.get("resultProtocol"));
    }

    public static int executionProtocol(Map<String, Object> reference) {
        return "deferred_v3".equals(reference.get("dispatchMode"))
                        || Integer.valueOf(3).equals(reference.get("runtimeProtocol"))
                ? 3
                : 2;
    }

    public static void requireProfile(RuntimeSession session) {
        if (session == null
                || !WorkspaceExecutionProfile.isMeasured(
                        session.getScope().getCapabilityDigest())) {
            throw new RuntimeBrokerException(
                    501,
                    "runtime_tool_v4_unsupported",
                    "Runtime measurement profile is unavailable.",
                    false);
        }
    }

    public static Map<String, Object> base(Map<String, Object> result) {
        Map<String, Object> base = new LinkedHashMap<>(result);
        base.remove(FIELD);
        return BrokerValues.immutableMap(base);
    }

    public static Map<String, Object> attach(
            int protocol, Map<String, Object> result, Object measurements, Object digest) {
        if (!(digest instanceof String value) || !value.matches("[0-9a-f]{64}")) {
            throw new RuntimeBrokerException(
                    502, "runtime_tool_v4_invalid", "Measured result digest is invalid.", false);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("executionProtocol", protocol);
        body.put("result", result);
        body.put("measurements", measurements);
        JsonNode node =
                ManagedExtensionRecordStore.parse(
                        new String(JsonCodec.encode(body), StandardCharsets.UTF_8));
        if (node == null
                || !value.equals(DigestUtils.sha256Hex(CsiNativeActivationProof.canonical(node)))) {
            throw new RuntimeBrokerException(
                    502, "runtime_tool_v4_invalid", "Measured result digest conflicts.", false);
        }
        if (measurements != null) {
            JsonNode measured = node.get("measurements");
            ManagedToolMeasurements.requireMeasurements(measured);
        }
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("protocolVersion", 4);
        metadata.put("executionProtocol", protocol);
        metadata.put("measurements", measurements);
        metadata.put("resultDigest", value);
        Map<String, Object> combined = new LinkedHashMap<>(result);
        combined.put(FIELD, BrokerValues.immutableMap(metadata));
        return BrokerValues.immutableMap(combined);
    }

    public static Map<String, Object> metadata(Map<String, Object> result) {
        Object raw = result.get(FIELD);
        if (!(raw instanceof Map<?, ?> map)
                || !map.keySet()
                        .equals(
                                Set.of(
                                        "protocolVersion",
                                        "executionProtocol",
                                        "measurements",
                                        "resultDigest"))) {
            throw new RuntimeBrokerException(
                    409,
                    "runtime_tool_measurements_missing",
                    "Original measured result is unavailable.",
                    false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> metadata = (Map<String, Object>) map;
        return metadata;
    }
}
