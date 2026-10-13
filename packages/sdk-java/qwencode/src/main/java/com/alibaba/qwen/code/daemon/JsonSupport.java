package com.alibaba.qwen.code.daemon;

import com.alibaba.fastjson2.JSON;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.core.io.JsonEOFException;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class JsonSupport {
    private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();
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
     * substrate is canonicalized here, not at each call site. Contract JSON
     * values (Map, List, String, Boolean, null, and finite numbers) render
     * directly. A map's keys come in the order JSON.stringify enumerates an
     * object's own keys: array-index keys ascending first, then the rest in
     * the map's iteration order (the builders of these blocks use
     * LinkedHashMap). The daemon re-parses a body and stringifies it in that
     * order, so a map built or read in any other order would digest
     * differently on the two sides. Every other value — a
     * Jackson tree a caller read from a store column (the channel policy of
     * a `submit_input` body), a record, an enum — is the same request body
     * this encoder replaced fastjson2 for, so it renders as fastjson2
     * rendered it and is read back strictly into contract values, keeping
     * the output canonical either way.
     */
    private static void writeCanonical(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ownKeyOrder((Map<?, ?>) value)) {
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
            writeCanonical(parseValue(JSON.toJSONString(value),
                    "JSON value of type " + value.getClass().getName()), out);
        }
    }

    /**
     * A map's entries in ECMAScript's OrdinaryOwnPropertyKeys order, the
     * order JSON.stringify writes an object's keys in: every array-index key
     * ("0" through "4294967294", no leading zero) in ascending numeric order,
     * then every other key in the map's own iteration order.
     */
    private static Iterable<? extends Map.Entry<?, ?>> ownKeyOrder(
            Map<?, ?> map) {
        List<Map.Entry<?, ?>> indexed = new ArrayList<>();
        List<Map.Entry<?, ?>> named = new ArrayList<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (arrayIndex(String.valueOf(entry.getKey())) < 0) {
                named.add(entry);
            } else {
                indexed.add(entry);
            }
        }
        if (indexed.isEmpty()) {
            return map.entrySet();
        }
        indexed.sort(Comparator.comparingLong(
                entry -> arrayIndex(String.valueOf(entry.getKey()))));
        indexed.addAll(named);
        return indexed;
    }

    /** The key's value as an ECMAScript array index, or -1 if it is none. */
    private static long arrayIndex(String key) {
        int length = key.length();
        if (length == 0 || length > 10
                || (length > 1 && key.charAt(0) == '0')) {
            return -1;
        }
        long index = 0;
        for (int i = 0; i < length; i++) {
            char digit = key.charAt(i);
            if (digit < '0' || digit > '9') {
                return -1;
            }
            index = index * 10 + (digit - '0');
        }
        return index < 0xFFFF_FFFFL ? index : -1;
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
                        out.append("\\u")
                                .append(HEX_DIGITS[(code >> 12) & 0xF])
                                .append(HEX_DIGITS[(code >> 8) & 0xF])
                                .append(HEX_DIGITS[(code >> 4) & 0xF])
                                .append(HEX_DIGITS[code & 0xF]);
                    } else {
                        out.appendCodePoint(code);
                    }
            }
        }
        out.append('"');
    }

    /**
     * A JSON number with JSON.stringify's numeric grammar. ECMAScript has
     * only Number (IEEE 754 double), so every Java number renders through
     * the double the script side would hold: an integer prints exactly when
     * |x| < 2^53, everything else as ECMAScript's Number::toString — the
     * shortest decimal that round-trips to that double. A BigDecimal (what
     * Jackson yields for a fractional literal) and a Long or BigInteger
     * past 2^53 take the same route, so `3E-324` and `Double.MIN_VALUE`
     * both print `5e-324`: one string per double, whatever type carried it.
     * Only a non-finite value (NaN, an infinity, or a decimal past the
     * double range) has no JSON form.
     */
    private static void writeCanonicalNumber(Number value, StringBuilder out) {
        if (value instanceof Byte || value instanceof Short
                || value instanceof Integer) {
            out.append(value.longValue());
            return;
        }
        double number = value.doubleValue();
        if (!Double.isFinite(number)) {
            throw new IllegalArgumentException(
                    "JSON numbers must be finite: " + value);
        }
        if (number == Math.rint(number)
                && Math.abs(number) < 9.007199254740992e15) {
            // Integral and exact: the long is the whole decimal, and `-0`
            // prints `0` as JSON.stringify prints it.
            out.append((long) number);
            return;
        }
        writeShortestDouble(number, out);
    }

    /**
     * ECMAScript Number::toString(x) for a finite nonzero double, derived
     * from the double's exact binary value rather than from
     * `Double.toString`, whose shortest-digit guarantee only exists from
     * JDK 19 while this artifact runs on Java 11. For each digit count
     * k = 1..17 only the two k-digit neighbours of the exact value can be
     * candidates (any k-digit decimal that round-trips lies between one of
     * them and x); the first k with a round-tripping neighbour wins, the
     * closer one when both do and the even one on a tie, as the
     * specification asks.
     */
    private static void writeShortestDouble(double number,
            StringBuilder out) {
        double magnitude = Math.abs(number);
        BigDecimal exact = new BigDecimal(magnitude);
        BigDecimal shortest = null;
        for (int digits = 1; digits <= 17 && shortest == null; digits++) {
            BigDecimal below = exact.round(
                    new MathContext(digits, RoundingMode.FLOOR));
            BigDecimal above = exact.round(
                    new MathContext(digits, RoundingMode.CEILING));
            boolean belowRoundTrips = below.doubleValue() == magnitude;
            boolean aboveRoundTrips = above.doubleValue() == magnitude;
            if (belowRoundTrips && aboveRoundTrips) {
                int closer = exact.subtract(below)
                        .compareTo(above.subtract(exact));
                if (closer < 0) {
                    shortest = below;
                } else if (closer > 0) {
                    shortest = above;
                } else {
                    shortest = below.unscaledValue().testBit(0)
                            ? above : below;
                }
            } else if (belowRoundTrips) {
                shortest = below;
            } else if (aboveRoundTrips) {
                shortest = above;
            }
        }
        if (shortest == null) {
            // Unreachable: seventeen significant digits round-trip every
            // double.
            throw new IllegalStateException(
                    "No round-trip decimal for " + number);
        }
        BigDecimal stripped = shortest.stripTrailingZeros();
        String digits = stripped.unscaledValue().toString();
        int length = digits.length();
        // x = digits × 10^(point − length); `point` is the specification's n.
        int point = length - stripped.scale();
        if (number < 0) {
            out.append('-');
        }
        if (length <= point && point <= 21) {
            out.append(digits);
            for (int zeros = point - length; zeros > 0; zeros--) {
                out.append('0');
            }
        } else if (0 < point && point <= 21) {
            out.append(digits, 0, point).append('.')
                    .append(digits, point, length);
        } else if (-6 < point && point <= 0) {
            out.append("0.");
            for (int zeros = -point; zeros > 0; zeros--) {
                out.append('0');
            }
            out.append(digits);
        } else {
            out.append(digits.charAt(0));
            if (length > 1) {
                out.append('.').append(digits, 1, length);
            }
            // ECMAScript always signs the exponent: `1e+21`, `5e-324`.
            int exponent = point - 1;
            out.append('e').append(exponent < 0 ? '-' : '+')
                    .append(Math.abs(exponent));
        }
    }

    /** One strict JSON value of any shape, as contract values. */
    private static Object parseValue(String json, String context) {
        try (JsonParser parser = STRICT_JSON.createParser(json)) {
            JsonToken token = parser.nextToken();
            if (token == null) {
                throw new DaemonProtocolException(context + " is empty");
            }
            Object parsed = readValue(parser, token, context);
            if (parser.nextToken() != null) {
                throw new DaemonProtocolException(
                        context + " must contain exactly one JSON value");
            }
            return parsed;
        } catch (IOException e) {
            throw new DaemonProtocolException(context + " contains invalid JSON", e);
        }
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
        // Every Number the encoder can render is accepted here and nothing
        // else: a BigDecimal or BigInteger past the double range has no
        // JSON form, so the builder refuses it instead of the request
        // failing at send time.
        if (value instanceof Number
                && !Double.isFinite(((Number) value).doubleValue())) {
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
