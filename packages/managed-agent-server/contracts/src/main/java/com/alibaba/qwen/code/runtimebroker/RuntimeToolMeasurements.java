package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedToolMeasurements;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Private v4 transport metadata; never part of a legacy tool-result envelope. */
public final class RuntimeToolMeasurements {
    public static final String FIELD = "diagnostics";

    public record Metadata(Object protocolVersion, Object executionProtocol,
            Object measurements, Object resultDigest) {
        public Map<String, Object> wireValue() {
            Map<String, Object> wire = new LinkedHashMap<>();
            wire.put("protocolVersion", protocolVersion);
            wire.put("executionProtocol", executionProtocol);
            wire.put("measurements", measurements);
            wire.put("resultDigest", resultDigest);
            return BrokerValues.immutableMap(wire);
        }
    }

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
                || !value.equals(DigestUtils.sha256Hex(canonical(node)))) {
            throw new RuntimeBrokerException(
                    502, "runtime_tool_v4_invalid", "Measured result digest conflicts.", false);
        }
        if (measurements != null) {
            JsonNode measured = node.get("measurements");
            ManagedToolMeasurements.requireMeasurements(measured);
        }
        Metadata metadata = new Metadata(4, protocol, measurements, value);
        Map<String, Object> combined = new LinkedHashMap<>(result);
        combined.put(FIELD, metadata.wireValue());
        return BrokerValues.immutableMap(combined);
    }

    public static Metadata metadata(Map<String, Object> result) {
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
        return new Metadata(map.get("protocolVersion"), map.get("executionProtocol"),
                map.get("measurements"), map.get("resultDigest"));
    }

    public static String canonical(JsonNode node) {
        requireValid(node != null);
        if (node.isObject()) {
            List<String> fields = new ArrayList<>();
            node.fieldNames().forEachRemaining(fields::add);
            fields.sort(String::compareTo);
            List<String> entries = new ArrayList<>();
            for (String field : fields) {
                entries.add(quote(field) + ":" + canonical(node.get(field)));
            }
            return "{" + String.join(",", entries) + "}";
        }
        if (node.isArray()) {
            List<String> entries = new ArrayList<>();
            node.forEach(child -> entries.add(canonical(child)));
            return "[" + String.join(",", entries) + "]";
        }
        if (node.isTextual()) {
            return quote(node.textValue());
        }
        if (node.isNumber()) {
            return canonicalNumber(node.doubleValue());
        }
        requireValid(node.isNull() || node.isBoolean());
        return node.toString();
    }

    private static String canonicalNumber(double value) {
        requireValid(Double.isFinite(value));
        if (value == 0) {
            return "0";
        }
        double magnitude = Math.abs(value);
        BigDecimal decimal = BigDecimal.valueOf(magnitude).stripTrailingZeros();
        if (decimal.precision() == 2) {
            BigDecimal exact = new BigDecimal(magnitude);
            BigDecimal lower = exact.round(new MathContext(1, RoundingMode.FLOOR)).stripTrailingZeros();
            BigDecimal upper = exact.round(new MathContext(1, RoundingMode.CEILING)).stripTrailingZeros();
            boolean lowerMatches = lower.doubleValue() == magnitude;
            if (lowerMatches) {
                decimal = lower;
            }
            if (upper.doubleValue() == magnitude) {
                int distance = upper.subtract(exact).abs().compareTo(lower.subtract(exact).abs());
                if (!lowerMatches || distance < 0 || distance == 0 && !upper.unscaledValue().testBit(0)) {
                    decimal = upper;
                }
            }
        }
        int exponent = decimal.precision() - decimal.scale() - 1;
        String encoded;
        if (exponent >= -6 && exponent < 21) {
            encoded = decimal.toPlainString();
        } else {
            String digits = decimal.unscaledValue().toString();
            encoded = digits.substring(0, 1) + (digits.length() == 1 ? "" : "." + digits.substring(1))
                    + "e" + (exponent < 0 ? "" : "+") + exponent;
        }
        return value < 0 ? "-" + encoded : encoded;
    }

    private static String quote(String text) {
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < text.length(); index++) {
            char value = text.charAt(index);
            switch (value) {
                case '"', '\\' -> result.append('\\').append(value);
                case '\b' -> result.append("\\b");
                case '\f' -> result.append("\\f");
                case '\n' -> result.append("\\n");
                case '\r' -> result.append("\\r");
                case '\t' -> result.append("\\t");
                default -> {
                    if (value < 0x20 || Character.isSurrogate(value)
                            && !(Character.isHighSurrogate(value) && index + 1 < text.length()
                                    && Character.isLowSurrogate(text.charAt(index + 1)))
                            && !(Character.isLowSurrogate(value) && index > 0
                                    && Character.isHighSurrogate(text.charAt(index - 1)))) {
                        result.append("\\u");
                        for (int shift = 12; shift >= 0; shift -= 4) {
                            result.append(Character.forDigit((value >> shift) & 15, 16));
                        }
                    } else {
                        result.append(value);
                    }
                }
            }
        }
        return result.append('"').toString();
    }

    private static void requireValid(boolean condition) {
        if (!condition) {
            throw new RuntimeBrokerException(
                    502, "runtime_tool_v4_invalid", "Measured result digest is invalid.", false);
        }
    }
}
