package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import java.nio.charset.StandardCharsets;
import java.util.Map;

final class JsonCodec {
    private JsonCodec() {
    }

    static byte[] encode(Object value) {
        return JSON.toJSONString(value).getBytes(StandardCharsets.UTF_8);
    }

    static Map<String, Object> parseObject(byte[] bytes, String context) {
        Object parsed;
        try {
            parsed = JSON.parse(bytes);
        } catch (RuntimeException exception) {
            throw new RuntimeBrokerException(400,
                    "runtime_broker_invalid_json",
                    context + " contains invalid JSON.", false);
        }
        if (!(parsed instanceof Map)) {
            throw new RuntimeBrokerException(400,
                    "runtime_broker_invalid_json",
                    context + " must be a JSON object.", false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> object = (Map<String, Object>) parsed;
        return BrokerValues.immutableMap(object);
    }

    static String requiredString(Map<String, Object> object, String field,
            String context) {
        Object value = object.get(field);
        if (!(value instanceof String)) {
            throw invalid(context + "." + field
                    + " must be a non-empty string.");
        }
        try {
            return BrokerValues.requireId((String) value, field);
        } catch (IllegalArgumentException exception) {
            throw invalid(context + "." + field
                    + " must be a bounded non-empty string.");
        }
    }

    static int requiredInt(Map<String, Object> object, String field,
            String context) {
        Object value = object.get(field);
        if (!(value instanceof Number)) {
            throw invalid(context + "." + field + " must be an integer.");
        }
        Number number = (Number) value;
        long result = number.longValue();
        if (number.doubleValue() != result
                || result < Integer.MIN_VALUE || result > Integer.MAX_VALUE) {
            throw invalid(context + "." + field + " must be an integer.");
        }
        return (int) result;
    }

    static Long optionalNonNegativeLong(Map<String, Object> object,
            String field, String context) {
        Object value = object.get(field);
        if (value == null) {
            return null;
        }
        if (!(value instanceof Number)) {
            throw invalid(context + "." + field
                    + " must be a non-negative integer.");
        }
        Number number = (Number) value;
        long result = number.longValue();
        if (number.doubleValue() != result || result < 0) {
            throw invalid(context + "." + field
                    + " must be a non-negative integer.");
        }
        return result;
    }

    static Map<String, Object> requiredObject(Map<String, Object> object,
            String field, String context) {
        Object value = object.get(field);
        if (!(value instanceof Map)) {
            throw invalid(context + "." + field + " must be an object.");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) value;
        return BrokerValues.immutableMap(result);
    }

    private static RuntimeBrokerException invalid(String message) {
        return new RuntimeBrokerException(400,
                "runtime_broker_invalid_request", message, false);
    }
}
