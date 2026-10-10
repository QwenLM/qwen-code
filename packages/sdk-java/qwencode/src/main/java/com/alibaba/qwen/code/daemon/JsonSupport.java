package com.alibaba.qwen.code.daemon;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.core.io.JsonEOFException;
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
        StringBuilder result = new StringBuilder();
        writeCanonical(value, result);
        return result.toString();
    }

    /**
     * Serializes one contract value byte-for-byte as JavaScript's
     * `JSON.stringify` renders it. The daemon's prompt admission pins
     * `sha256(JSON.stringify(prompt))` over this exact substrate, and the
     * managed workflow launch block is the first prompt ever to carry a
     * fractional number across it: fastjson2's `Double.toString` scientific
     * form diverges from ECMAScript outside [0.001, 1e7), so the digest
     * substrate is canonicalized here, not at each call site. Only contract
     * JSON values appear (Map, List, String, Boolean, null, and finite
     * numbers); key order follows each map's own iteration order, as the
     * builders of these blocks use LinkedHashMap.
     */
    private static void writeCanonical(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, ?> entry
                    : ((Map<String, ?>) value).entrySet()) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                writeCanonicalString(String.valueOf(entry.getKey()), out);
                out.append(':');
                writeCanonical(entry.getValue(), out);
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                writeCanonical(item, out);
            }
            out.append(']');
        } else if (value instanceof String) {
            writeCanonicalString((String) value, out);
        } else if (value instanceof Boolean) {
            out.append(value);
        } else if (value instanceof Number) {
            writeCanonicalNumber((Number) value, out);
        } else {
            throw new IllegalArgumentException(
                    "Unsupported JSON value type: " + value.getClass().getName());
        }
    }

    /** A JSON string with the escapes JSON.stringify performs. */
    private static void writeCanonicalString(String text, StringBuilder out) {
        out.append('"');
        int length = text.length();
        for (int index = 0; index < length; index++) {
            int code = text.codePointAt(index);
            if (Character.isSupplementaryCodePoint(code)) {
                index++;
            }
            switch (code) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\b':
                    out.append("\\b");
                    break;
                case '\f':
                    out.append("\\f");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    // ES2019 well-formed stringify escapes C0 controls and
                    // lone surrogates alike; a raw lone surrogate would be
                    // destroyed (replaced with U+FFFD/'?') when the digest
                    // step encodes this string as UTF-8.
                    if (code < 0x20 || (code >= 0xD800 && code <= 0xDFFF)) {
                        out.append(String.format("\\u%04x", code));
                    } else {
                        out.appendCodePoint(code);
                    }
            }
        }
        out.append('"');
    }

    /**
     * A JSON number with JSON.stringify's numeric grammar. ECMAScript has
     * only Number (IEEE 754 double): integers print exactly when |x| < 2^53
     * and round through the double beyond it; a non-integer prints plain
     * when 1e-6 ≤ |x| < 1e21, otherwise shortest-round-trip exponent
     * notation. Longs and BigIntegers therefore render through the same
     * double the JS side would hold — an exact decimal printout past 2^53
     * never matches `JSON.stringify`.
     */
    private static void writeCanonicalNumber(Number value, StringBuilder out) {
        if (value instanceof Byte || value instanceof Short
                || value instanceof Integer) {
            out.append(value.longValue());
            return;
        }
        if (value instanceof Long || value instanceof BigInteger) {
            long asLong = value.longValue();
            if (Math.abs(asLong) < 9_007_199_254_740_992L) {
                out.append(asLong);
            } else {
                writeCanonicalDecimal(
                        BigDecimal.valueOf(value.doubleValue())
                                .stripTrailingZeros(),
                        out);
            }
            return;
        }
        if (value instanceof BigDecimal) {
            writeCanonicalDecimal(
                    ((BigDecimal) value).stripTrailingZeros(), out);
            return;
        }
        double number = value.doubleValue();
        if (!Double.isFinite(number)) {
            throw new IllegalArgumentException(
                    "JSON numbers must be finite: " + value);
        }
        // Subnormal doubles carry Java's minimum-two-digit `Double.toString`
        // form where ECMAScript prints the shortest one (`5e-324`): the
        // BigDecimal digit path cannot reconcile them, so they are refused
        // here rather than digested into a cross-language wedge. JSON
        // parses never produce them — Jackson yields BigDecimal for
        // fractional literals — and model-produced args at this scale are
        // not a lawful prompt payload to begin with.
        if (number != 0 && Math.abs(number) < 1.1125369292536007e-308) {
            throw new IllegalArgumentException(
                    "JSON number outside the canonical range: " + value);
        }
        if (number == Math.rint(number)
                && Math.abs(number) < 9.007199254740992e15) {
            out.append((long) number);
            return;
        }
        writeCanonicalDecimal(
                BigDecimal.valueOf(number).stripTrailingZeros(), out);
    }

    /**
     * Renders a scale-stripped BigDecimal with JSON.stringify's notation:
     * a plain decimal when the ECMAScript Number the value names is in
     * [1e-6, 1e21), otherwise the shortest exponent form with no '+', no
     * redundant exponent zeros and no trailing coefficient zeros.
     */
    private static void writeCanonicalDecimal(BigDecimal value,
            StringBuilder out) {
        if (value.signum() == 0) {
            out.append('0');
            return;
        }
        double asDouble = value.doubleValue();
        double magnitude = Math.abs(asDouble);
        if (magnitude >= 1e-6 && magnitude < 1e21) {
            out.append(value.toPlainString());
            return;
        }
        String coefficient = value.unscaledValue().abs().toString();
        int exponent = coefficient.length() - 1 - value.scale();
        if (value.signum() < 0) {
            out.append('-');
        }
        out.append(coefficient.charAt(0));
        if (coefficient.length() > 1) {
            out.append('.').append(coefficient.substring(1));
        }
        // ECMAScript always signs a positive exponent: `1e+21`, never `1e21`.
        out.append('e');
        if (exponent >= 0) {
            out.append('+');
        }
        out.append(exponent);
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
        while (true) {
            JsonToken fieldToken = nextContainerToken(parser, context, "object");
            if (fieldToken == JsonToken.END_OBJECT) {
                return result;
            }
            if (fieldToken != JsonToken.FIELD_NAME) {
                throw new DaemonProtocolException(context
                        + " contains a malformed JSON object");
            }
            String field = parser.currentName();
            JsonToken valueToken = nextContainerToken(parser, context, "object");
            result.put(field, readValue(parser, valueToken, context));
        }
    }

    private static List<Object> readArray(JsonParser parser, String context)
            throws IOException {
        List<Object> result = new ArrayList<>();
        while (true) {
            JsonToken token = nextContainerToken(parser, context, "array");
            if (token == JsonToken.END_ARRAY) {
                return result;
            }
            result.add(readValue(parser, token, context));
        }
    }

    private static JsonToken nextContainerToken(JsonParser parser, String context,
            String container) throws IOException {
        try {
            JsonToken token = parser.nextToken();
            if (token != null) {
                return token;
            }
        } catch (JsonEOFException e) {
            throw new DaemonProtocolException(context
                    + " contains an incomplete JSON " + container, e);
        }
        throw new DaemonProtocolException(context
                + " contains an incomplete JSON " + container);
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
            throw new DaemonProtocolException(context + " must be non-negative");
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
            throw new DaemonProtocolException(context + " must be positive");
        }
        return result;
    }

    static int requiredInt(Map<String, Object> object, String field,
            String context) {
        long value = exactLong(object.get(field), context + "." + field);
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw new DaemonProtocolException(context
                    + " is outside the integer range");
        }
        return (int) value;
    }

    static Map<String, Object> requiredObject(Map<String, Object> object,
            String field, String context) {
        Map<String, Object> value = optionalObject(object, field);
        if (value == null) {
            throw new DaemonProtocolException(field + " must be an object");
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
