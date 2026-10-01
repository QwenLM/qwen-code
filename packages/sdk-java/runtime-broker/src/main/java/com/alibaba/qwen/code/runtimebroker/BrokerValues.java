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
import java.util.regex.Pattern;

final class BrokerValues {
    private static final int MAXIMUM_ID_LENGTH = 512;
    private static final Pattern PATH_SAFE_ID = Pattern.compile(
            "[A-Za-z0-9._-]{1," + MAXIMUM_ID_LENGTH + "}");
    private static final int MAXIMUM_DECIMAL_SCALE = 2048;
    // The JDBC codec's reader (fastjson2 2.0.65) refuses a number literal
    // with more digits than this, whatever its scale.
    private static final int MAXIMUM_NUMBER_DIGITS = 10_000;
    private static final BigInteger MAXIMUM_INTEGER_EXCLUSIVE =
            BigInteger.TEN.pow(MAXIMUM_NUMBER_DIGITS);

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
     * An id the worker admits on its provider envelope, where it becomes a
     * file name: ASCII letters, digits, {@code .}, {@code _} and {@code -},
     * never {@code .} and never containing {@code ..}. The Broker releases
     * every Runtime Session through that envelope, so an id the worker would
     * refuse must not be acquired.
     */
    static String requirePathSafe(String value, String name) {
        if (value == null || !PATH_SAFE_ID.matcher(value).matches()
                || value.equals(".") || value.contains("..")) {
            throw new IllegalArgumentException(name
                    + " must be 1-512 ASCII letters, digits, '.', '_' or '-',"
                    + " without '..'");
        }
        return value;
    }

    /**
     * Text without an unpaired surrogate: the JSON writer turns one into
     * '?', so two identifiers could reach the Runtime as one.
     */
    static String requireWellFormed(String value, String name) {
        if (!isWellFormed(value)) {
            throw new IllegalArgumentException(name
                    + " must be well-formed text");
        }
        return value;
    }

    /**
     * Whether a value is JSON (maps with string keys, lists, strings,
     * numbers, booleans and null) whose strings and keys are all well-formed
     * text, for the same reason as {@link #requireWellFormed}: a tool input
     * would reach the Runtime, and run, with '?' in place of an unpaired
     * surrogate. Anything else, such as an array or a set the writer would
     * also serialize, answers false.
     */
    static boolean isWellFormedJson(Object value) {
        if (value instanceof String text) {
            return isWellFormed(text);
        }
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)
                        || !isWellFormed(key)
                        || !isWellFormedJson(entry.getValue())) {
                    return false;
                }
            }
            return true;
        }
        if (value instanceof List<?> list) {
            for (Object item : list) {
                if (!isWellFormedJson(item)) {
                    return false;
                }
            }
            return true;
        }
        return value == null || value instanceof Number
                || value instanceof Boolean;
    }

    private static boolean isWellFormed(String value) {
        return value.codePoints().noneMatch(point ->
                point >= Character.MIN_SURROGATE
                        && point <= Character.MAX_SURROGATE);
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

    /**
     * The exact integer a parsed JSON number denotes, of any magnitude, or
     * null. A parsed Double or Float may be rounded and a Short or Byte
     * wrapped, as with 40000000000000001E-16 or 65540S, so neither counts.
     * Under the default parse an integer written with a non-zero exponent,
     * such as 40e-1, can arrive as a Double and is then rejected too. A
     * cursor is validated exactly but never narrowed to a long.
     */
    static BigDecimal exactInteger(Object value) {
        if (value instanceof Integer || value instanceof Long) {
            return BigDecimal.valueOf(((Number) value).longValue());
        }
        if (value instanceof BigInteger integer) {
            return new BigDecimal(integer);
        }
        if (value instanceof BigDecimal decimal
                && decimal.stripTrailingZeros().scale() <= 0) {
            return decimal;
        }
        return null;
    }

    /**
     * The exact long a parsed JSON integer denotes, or null: an
     * {@link #exactInteger(Object) exact integer} that fits in a long.
     */
    static Long exactLong(Object value) {
        BigDecimal integer = exactInteger(value);
        if (integer == null) {
            return null;
        }
        try {
            return integer.longValueExact();
        } catch (ArithmeticException exception) {
            // A value beyond a long is not an exact long.
            return null;
        }
    }

    static Map<String, Object> immutableMap(Map<String, ?> source) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw new IllegalArgumentException(
                        "map key must be a string");
            }
            copy.put(key, immutableValue(entry.getValue()));
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
        if (value instanceof Number number && !isJsonFinite(number)) {
            throw new IllegalArgumentException(
                    "JSON number must be finite");
        }
        // The JDBC codec writes BigDecimal in plain form, so the digit
        // count grows with the scale's magnitude on both sides: a scale
        // of -N persists as an N-digit integer literal that the same
        // codec then refuses to read back.
        if (value instanceof BigDecimal decimal
                && (decimal.scale() > MAXIMUM_DECIMAL_SCALE
                        || decimal.scale() < -MAXIMUM_DECIMAL_SCALE)) {
            throw new IllegalArgumentException(
                    "JSON number scale must be within ±"
                            + MAXIMUM_DECIMAL_SCALE);
        }
        // Precision grows the plain form too, so the scale bound alone does
        // not keep a persisted literal inside the reader's digit budget.
        if ((value instanceof BigDecimal decimal
                        && plainDigits(decimal) > MAXIMUM_NUMBER_DIGITS)
                || (value instanceof BigInteger integer
                        && integer.abs().compareTo(
                                MAXIMUM_INTEGER_EXCLUSIVE) >= 0)) {
            throw new IllegalArgumentException(
                    "JSON number must have at most "
                            + MAXIMUM_NUMBER_DIGITS + " digits");
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

    // Digits of the plain form: integer digits plus fraction digits, with a
    // leading zero when the magnitude is below one. Called once the scale
    // is known to be within ±MAXIMUM_DECIMAL_SCALE.
    private static long plainDigits(BigDecimal decimal) {
        long precision = decimal.precision();
        long scale = decimal.scale();
        return scale <= 0 ? precision - scale
                : Math.max(precision, scale + 1);
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
        if (first instanceof Number left && second instanceof Number right) {
            return sameJsonNumber(left, right);
        }
        if (first instanceof Map && second instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> left = (Map<String, Object>) first;
            @SuppressWarnings("unchecked")
            Map<String, Object> right = (Map<String, Object>) second;
            return sameJsonMap(left, right);
        }
        if (first instanceof List<?> left && second instanceof List<?> right) {
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
        return !(value instanceof Double doubleValue
                && !Double.isFinite(doubleValue))
                && !(value instanceof Float floatValue
                        && !Float.isFinite(floatValue));
    }
}
