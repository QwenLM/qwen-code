package com.alibaba.qwen.code.daemon;

import com.alibaba.fastjson2.JSON;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadFeature;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class JsonSupport {
    private static final JsonFactory STRICT_JSON = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build();

    private JsonSupport() {
    }

    static String encode(Object value) {
        return JSON.toJSONString(value);
    }

    static Map<String, Object> parseObject(String json, String context) {
        try (JsonParser parser = STRICT_JSON.createParser(json)) {
            if (parser.nextToken() != JsonToken.START_OBJECT) {
                throw new DaemonProtocolException(context + " must be a JSON object");
            }
            Map<String, Object> parsed = readObject(parser, context);
            if (parser.nextToken() != null) {
                throw new DaemonProtocolException(
                        context + " must contain exactly one JSON value");
            }
            return immutableObject(parsed);
        } catch (IOException e) {
            throw new DaemonProtocolException(context + " contains invalid JSON", e);
        }
    }

    private static Map<String, Object> readObject(JsonParser parser, String context)
            throws IOException {
        Map<String, Object> result = new LinkedHashMap<>();
        while (parser.nextToken() != JsonToken.END_OBJECT) {
            if (parser.currentToken() != JsonToken.FIELD_NAME) {
                throw new DaemonProtocolException(context
                        + " contains a malformed JSON object");
            }
            String field = parser.currentName();
            JsonToken valueToken = parser.nextToken();
            if (valueToken == null) {
                throw new DaemonProtocolException(context
                        + " contains an incomplete JSON object");
            }
            result.put(field, readValue(parser, valueToken, context));
        }
        return result;
    }

    private static List<Object> readArray(JsonParser parser, String context)
            throws IOException {
        List<Object> result = new ArrayList<>();
        JsonToken token;
        while ((token = parser.nextToken()) != JsonToken.END_ARRAY) {
            if (token == null) {
                throw new DaemonProtocolException(context
                        + " contains an incomplete JSON array");
            }
            result.add(readValue(parser, token, context));
        }
        return result;
    }

    private static Object readValue(JsonParser parser, JsonToken token,
            String context) throws IOException {
        switch (token) {
            case START_OBJECT:
                return readObject(parser, context);
            case START_ARRAY:
                return readArray(parser, context);
            case VALUE_STRING:
                return parser.getText();
            case VALUE_NUMBER_INT:
                return narrowInteger(parser.getBigIntegerValue());
            case VALUE_NUMBER_FLOAT:
                return parser.getDecimalValue();
            case VALUE_TRUE:
                return Boolean.TRUE;
            case VALUE_FALSE:
                return Boolean.FALSE;
            case VALUE_NULL:
                return null;
            default:
                throw new DaemonProtocolException(context
                        + " contains an unsupported JSON token");
        }
    }

    private static Number narrowInteger(BigInteger value) {
        if (value.bitLength() < Integer.SIZE) {
            return value.intValue();
        }
        if (value.bitLength() < Long.SIZE) {
            return value.longValue();
        }
        return value;
    }

    static Map<String, Object> immutableObject(Map<String, ?> source) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : source.entrySet()) {
            if (entry.getKey() == null) {
                throw new IllegalArgumentException("JSON object key must not be null");
            }
            copy.put(entry.getKey(), immutableValue(entry.getValue()));
        }
        return Collections.unmodifiableMap(copy);
    }

    static String requiredString(Map<String, Object> object, String field,
            String context) {
        Object value = object.get(field);
        if (!(value instanceof String) || ((String) value).isEmpty()) {
            throw new DaemonProtocolException(context + "." + field
                    + " must be a non-empty string");
        }
        return (String) value;
    }

    static String optionalString(Map<String, Object> object, String field) {
        Object value = object.get(field);
        if (value == null) {
            return null;
        }
        if (!(value instanceof String)) {
            throw new DaemonProtocolException(field + " must be a string");
        }
        return (String) value;
    }

    static boolean requiredBoolean(Map<String, Object> object, String field,
            String context) {
        Object value = object.get(field);
        if (!(value instanceof Boolean)) {
            throw new DaemonProtocolException(context + "." + field
                    + " must be a boolean");
        }
        return (Boolean) value;
    }

    static long requiredNonNegativeLong(Map<String, Object> object, String field,
            String context) {
        Object value = object.get(field);
        long result = exactLong(value, context + "." + field);
        if (result < 0) {
            throw new DaemonProtocolException(context + "." + field
                    + " must be non-negative");
        }
        return result;
    }

    static Long optionalPositiveLong(Map<String, Object> object, String field,
            String context) {
        Object value = object.get(field);
        if (value == null) {
            return null;
        }
        long result = exactLong(value, context + "." + field);
        if (result <= 0) {
            throw new DaemonProtocolException(context + "." + field
                    + " must be positive");
        }
        return result;
    }

    static int requiredInt(Map<String, Object> object, String field,
            String context) {
        long value = exactLong(object.get(field), context + "." + field);
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw new DaemonProtocolException(context + "." + field
                    + " is outside the integer range");
        }
        return (int) value;
    }

    static Map<String, Object> requiredObject(Map<String, Object> object,
            String field, String context) {
        Map<String, Object> value = optionalObject(object, field);
        if (value == null) {
            throw new DaemonProtocolException(context + "." + field
                    + " must be an object");
        }
        return value;
    }

    static Map<String, Object> optionalObject(Map<String, Object> object,
            String field) {
        Object value = object.get(field);
        if (value == null) {
            return null;
        }
        if (!(value instanceof Map)) {
            throw new DaemonProtocolException(field + " must be an object");
        }
        return castObject(value);
    }

    static Map<String, Object> extensionObject(Object value) {
        return value instanceof Map ? castObject(value) : null;
    }

    static List<Object> optionalList(Map<String, Object> object, String field) {
        Object value = object.get(field);
        if (value == null) {
            return null;
        }
        if (!(value instanceof List)) {
            throw new DaemonProtocolException(field + " must be an array");
        }
        return castList(value);
    }

    static List<String> stringList(Map<String, Object> object, String field) {
        List<Object> values = optionalList(object, field);
        if (values == null) {
            throw new DaemonProtocolException(field + " must be an array");
        }
        List<String> result = new ArrayList<>();
        for (Object value : values) {
            if (!(value instanceof String)) {
                throw new DaemonProtocolException(field + " must contain only strings");
            }
            result.add((String) value);
        }
        return result;
    }

    private static long exactLong(Object value, String context) {
        try {
            if (value instanceof Byte || value instanceof Short
                    || value instanceof Integer || value instanceof Long) {
                return ((Number) value).longValue();
            }
            if (value instanceof BigInteger) {
                return ((BigInteger) value).longValueExact();
            }
            if (value instanceof BigDecimal) {
                return ((BigDecimal) value).longValueExact();
            }
        } catch (ArithmeticException e) {
            throw new DaemonProtocolException(context + " must be an exact integer", e);
        }
        throw new DaemonProtocolException(context + " must be an integer");
    }

    private static Object immutableValue(Object value) {
        if (value instanceof Map) {
            return immutableObject(castObject(value));
        }
        if (value instanceof List) {
            List<Object> copy = new ArrayList<>();
            for (Object item : (List<?>) value) {
                copy.add(immutableValue(item));
            }
            return Collections.unmodifiableList(copy);
        }
        if ((value instanceof Double && !Double.isFinite((Double) value))
                || (value instanceof Float && !Float.isFinite((Float) value))) {
            throw new IllegalArgumentException("JSON numbers must be finite");
        }
        if (value == null || value instanceof String || value instanceof Number
                || value instanceof Boolean) {
            return value;
        }
        throw new IllegalArgumentException("Unsupported JSON value type: "
                + value.getClass().getName());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castObject(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
