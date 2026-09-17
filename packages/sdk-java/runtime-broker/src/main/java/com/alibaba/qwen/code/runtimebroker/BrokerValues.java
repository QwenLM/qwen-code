package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class BrokerValues {
    private static final int MAXIMUM_ID_LENGTH = 512;

    private BrokerValues() {
    }

    static String requireId(String value, String name) {
        if (value == null || value.isEmpty()
                || value.length() > MAXIMUM_ID_LENGTH
                || value.indexOf('\0') >= 0) {
            throw new IllegalArgumentException(name
                    + " must be a bounded non-empty string");
        }
        return value;
    }

    static URI requireOrigin(URI value, String name) {
        if (value == null
                || (!("http".equalsIgnoreCase(value.getScheme()))
                        && !("https".equalsIgnoreCase(value.getScheme())))
                || value.getHost() == null
                || value.getUserInfo() != null
                || value.getQuery() != null
                || value.getFragment() != null
                || !(value.getPath().isEmpty()
                        || "/".equals(value.getPath()))) {
            throw new IllegalArgumentException(name
                    + " must be an HTTP(S) origin");
        }
        return value.resolve("/");
    }

    static Map<String, Object> immutableMap(Map<String, ?> source) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : source.entrySet()) {
            if (entry.getKey() == null) {
                throw new IllegalArgumentException("map key must not be null");
            }
            copy.put(entry.getKey(), immutableValue(entry.getValue()));
        }
        return Collections.unmodifiableMap(copy);
    }

    private static Object immutableValue(Object value) {
        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, ?> nested = (Map<String, ?>) value;
            return immutableMap(nested);
        }
        if (value instanceof List) {
            List<?> source = (List<?>) value;
            List<Object> copy = new ArrayList<>(source.size());
            for (Object item : source) {
                copy.add(immutableValue(item));
            }
            return Collections.unmodifiableList(copy);
        }
        if (value == null || value instanceof String
                || value instanceof Number || value instanceof Boolean) {
            return value;
        }
        throw new IllegalArgumentException("unsupported JSON value");
    }
}
