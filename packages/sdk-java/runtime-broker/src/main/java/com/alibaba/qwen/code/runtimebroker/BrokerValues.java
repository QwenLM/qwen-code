package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import java.math.BigDecimal;
import java.math.BigInteger;
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

    /**
     * Text without an unpaired surrogate: the JSON writer turns one into
     * '?', so two identifiers could reach the Runtime as one.
     */
    static String requireWellFormed(String value, String name) {
        if (value.codePoints().anyMatch(point ->
                point >= Character.MIN_SURROGATE
                        && point <= Character.MAX_SURROGATE)) {
            throw new IllegalArgumentException(name
                    + " must be well-formed text");
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
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            Object key = entry.getKey();
            if (!(key instanceof String)) {
                throw new IllegalArgumentException(
                        "map key must be a string");
            }
            copy.put((String) key, immutableValue(entry.getValue()));
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
        if (value instanceof Number && !isJsonFinite((Number) value)) {
            throw new IllegalArgumentException(
                    "JSON number must be finite");
        }
        // Mutable Number subtypes (AtomicLong, adders) would alias caller
        // state into a record, so only immutable JSON scalars pass.
        if (value == null || value instanceof String || value instanceof Boolean
                || value instanceof Byte || value instanceof Short
                || value instanceof Integer || value instanceof Long
                || value instanceof Float || value instanceof Double
                || value instanceof BigInteger || value instanceof BigDecimal) {
            return value;
        }
        throw new IllegalArgumentException("unsupported JSON value");
    }

    // JSON has a single number type, but a persistence round-trip picks Java
    // numeric subtypes by magnitude (a written 1L can read back as Integer).
    // Identity comparison therefore canonicalizes numbers by value so a
    // round-tripped payload still matches the caller's own map.
    static boolean sameJsonMap(Map<String, Object> first,
            Map<String, Object> second) {
        if (first == second) {
            return true;
        }
        if (first == null || second == null
                || first.size() != second.size()) {
            return false;
        }
        for (Map.Entry<String, Object> entry : first.entrySet()) {
            if (!second.containsKey(entry.getKey())
                    || !sameJsonValue(entry.getValue(),
                            second.get(entry.getKey()))) {
                return false;
            }
        }
        return true;
    }

    private static boolean sameJsonValue(Object first, Object second) {
        if (first == second) {
            return true;
        }
        if (first == null || second == null) {
            return false;
        }
        if (first instanceof Number && second instanceof Number) {
            return sameJsonNumber((Number) first, (Number) second);
        }
        if (first instanceof Map && second instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> left = (Map<String, Object>) first;
            @SuppressWarnings("unchecked")
            Map<String, Object> right = (Map<String, Object>) second;
            return sameJsonMap(left, right);
        }
        if (first instanceof List && second instanceof List) {
            List<?> left = (List<?>) first;
            List<?> right = (List<?>) second;
            if (left.size() != right.size()) {
                return false;
            }
            for (int index = 0; index < left.size(); index++) {
                if (!sameJsonValue(left.get(index), right.get(index))) {
                    return false;
                }
            }
            return true;
        }
        return first.equals(second);
    }

    private static boolean sameJsonNumber(Number first, Number second) {
        if (!isJsonFinite(first) || !isJsonFinite(second)) {
            return first.equals(second);
        }
        return jsonNumber(first).compareTo(jsonNumber(second)) == 0;
    }

    private static BigDecimal jsonNumber(Number value) {
        return new BigDecimal(JSON.toJSONString(value));
    }

    private static boolean isJsonFinite(Number value) {
        return !(value instanceof Double
                && !Double.isFinite(((Double) value).doubleValue()))
                && !(value instanceof Float
                        && !Float.isFinite(((Float) value).floatValue()));
    }
}
