package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
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
            parsed = JSON.parseObject(new String(bytes, StandardCharsets.UTF_8),
                    JSONReader.Feature.DisableReferenceDetect);
        } catch (RuntimeException exception) {
            throw new RuntimeBrokerException(400, "runtime_broker_invalid_json",
                    context + " contains invalid JSON.", false, exception);
        }
        if (!(parsed instanceof Map)) {
            throw new RuntimeBrokerException(400, "runtime_broker_invalid_json",
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

    private static RuntimeBrokerException invalid(String message) {
        return new RuntimeBrokerException(400,
                "runtime_broker_invalid_request", message, false);
    }
}
