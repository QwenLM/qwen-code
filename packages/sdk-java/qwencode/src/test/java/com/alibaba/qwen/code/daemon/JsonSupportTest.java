package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class JsonSupportTest {
    @ParameterizedTest
    @ValueSource(strings = {
            "{'value':'single quotes'}",
            "{\"value\":1,}",
            "{\"value\":+1}",
            "{\"value\":01}",
            "{\"value\":1,\"value\":2}"
    })
    void rejectsNonStandardOrAmbiguousJson(String json) {
        assertThrows(DaemonProtocolException.class,
                () -> JsonSupport.parseObject(json, "test response"));
    }

    @Test
    void parsesStrictJsonWithoutLosingIntegerPrecision() {
        Map<String, Object> parsed = JsonSupport.parseObject(
                "{\"value\":9223372036854775808}", "test response");
        assertEquals("9223372036854775808", parsed.get("value").toString());
    }

    @Test
    void identifiesTruncatedObjectAsIncomplete() {
        DaemonProtocolException failure = assertThrows(
                DaemonProtocolException.class,
                () -> JsonSupport.parseObject("{\"value\":1", "test response"));
        assertEquals("test response contains an incomplete JSON object",
                failure.getMessage());
    }

    @Test
    void rejectsNonFiniteJsonNumbersRecursively() {
        for (Number value : new Number[] {
                Double.NaN,
                Double.POSITIVE_INFINITY,
                Float.NaN,
                Float.NEGATIVE_INFINITY
        }) {
            Map<String, Object> block = Map.of(
                    "type", "custom",
                    "nested", List.of(Map.of("value", value)));
            assertThrows(IllegalArgumentException.class,
                    () -> PromptRequest.builder().addContent(block));
        }
    }

    /**
     * Golden vectors for `encode`: every expected string was produced by
     * Node's `JSON.stringify` of the same value (the digest substrate the
     * daemon pins with `sha256(JSON.stringify(prompt))`). Digest call sites
     * hash and re-present this output to themselves, so only golden vectors
     * like these can catch a drift between the two languages.
     */
    @Test
    void encodeRendersDoublesTheEcmaScriptWay() {
        String[][] vectors = {
                {"0.0001", "0.0001"},
                {"5e-5", "0.00005"},
                {"1e-6", "0.000001"},
                {"1e-7", "1e-7"},
                {"1e20", "100000000000000000000"},
                {"1e21", "1e+21"},
                {"1e22", "1e+22"},
                {"0.1", "0.1"},
                {"12345678.9", "12345678.9"},
                {"6.02e23", "6.02e+23"},
                {"0.5", "0.5"},
                {"-0.25", "-0.25"},
                {"0.0", "0"},
                {"-0.0", "0"},
                {"2.5e-7", "2.5e-7"},
                {"-1.5e-10", "-1.5e-10"},
                {"2.2250738585072014e-308", "2.2250738585072014e-308"},
        };
        for (String[] vector : vectors) {
            double input = Double.parseDouble(vector[0]);
            assertEquals(vector[1], JsonSupport.encode(input),
                    "JSON.stringify(" + vector[0] + ") is " + vector[1]);
        }
    }

    /**
     * JSON.stringify writes array-index keys first, ascending, then the rest
     * in insertion order; the daemon re-stringifies a parsed body that way,
     * so the encoder must too. Expected strings are Node's output for an
     * object built with these keys in this order.
     */
    @Test
    void encodeOrdersKeysAsJsonStringifyDoes() {
        Map<String, Object> keys = new LinkedHashMap<>();
        String[] names = {"b", "10", "2", "a", "01", "4294967295",
                "4294967294", "-1", "1.5", "0", " 1", "1e3"};
        for (int i = 0; i < names.length; i++) {
            keys.put(names[i], i);
        }
        assertEquals("{\"0\":9,\"2\":2,\"10\":1,\"4294967294\":6,"
                + "\"b\":0,\"a\":3,\"01\":4,\"4294967295\":5,\"-1\":7,"
                + "\"1.5\":8,\" 1\":10,\"1e3\":11}", JsonSupport.encode(keys));

        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("9", 1);
        inner.put("k", 2);
        inner.put("8", 3);
        Map<String, Object> middle = new LinkedHashMap<>();
        middle.put("3", true);
        middle.put("x", null);
        middle.put("1", List.of(inner));
        assertEquals("{\"z\":{\"1\":[{\"8\":3,\"9\":1,\"k\":2}],"
                + "\"3\":true,\"x\":null}}",
                JsonSupport.encode(Map.of("z", middle)));
    }

    @Test
    void encodeRendersIntegralValuesByTheTwo53Rule() {
        assertEquals("9007199254740992",
                JsonSupport.encode(9007199254740992L));
        // JSON.stringify(9223372036854775807) — ECMAScript only holds the
        // double, so the integer rounds to its nearest representable value.
        assertEquals("9223372036854776000",
                JsonSupport.encode(Long.MAX_VALUE));
        // The same double the script side reads for in-range values: never
        // a longValue() view of the low 64 bits. Long.MIN_VALUE defeats
        // Math.abs, and a BigInteger at or past 2^63 sign-flips or
        // truncates under longValue().
        assertEquals("-9223372036854776000",
                JsonSupport.encode(Long.MIN_VALUE));
        assertEquals("9223372036854776000",
                JsonSupport.encode(new BigInteger("9223372036854775808")));
        assertEquals("18446744073709552000",
                JsonSupport.encode(new BigInteger("18446744073709551616")));
        assertEquals("1.2345678901234568e+29",
                JsonSupport.encode(
                        new BigInteger("123456789012345678901234567890")));
        assertEquals("100", JsonSupport.encode(100));
        assertEquals("-5", JsonSupport.encode(-5));
    }

    @Test
    void encodeRendersBigDecimalsThroughTheDoubleTheScriptSideHolds() {
        // The parser hands fractions over as BigDecimal; the script peer
        // holds only the double, so exact digits beyond it never match
        // JSON.stringify.
        assertEquals("12345678901234567000",
                JsonSupport.encode(new BigDecimal("12345678901234567890.5")));
        assertEquals("0", JsonSupport.encode(new BigDecimal("1E-400")));
        assertThrows(IllegalArgumentException.class,
                () -> JsonSupport.encode(new BigDecimal("1E+400")));
        assertThrows(IllegalArgumentException.class,
                () -> JsonSupport.encode(BigInteger.TWO.pow(1100)));
    }

    /**
     * Subnormals are ordinary doubles to JSON.stringify: whatever literal
     * or type carried one, the output is the shortest digits of the double
     * the script side holds — never the literal's own digits, and never a
     * refusal (Node: JSON.stringify(Number("3E-324")) is "5e-324").
     */
    @Test
    void encodeRendersSubnormalsAsTheShortestDigitsOfTheirDouble() {
        for (String literal : new String[] {"3E-324", "4.9E-324", "5E-324",
                "7E-324"}) {
            assertEquals("5e-324", JsonSupport.encode(new BigDecimal(literal)),
                    literal);
        }
        assertEquals("5e-324", JsonSupport.encode(Double.MIN_VALUE));
        assertEquals("-5e-324", JsonSupport.encode(-Double.MIN_VALUE));
        assertEquals("1.1e-308", JsonSupport.encode(
                new BigDecimal("1.10000000000000000001E-308")));
        assertEquals("1.5e-308", JsonSupport.encode(1.5e-308));
        assertEquals("2.225073858507201e-308",
                JsonSupport.encode(Math.nextDown(Double.MIN_NORMAL)));
    }

    /**
     * Doubles whose shortest round-trip form needs all seventeen digits:
     * JDK 11–18 `Double.toString` emits an extra digit for some of them
     * (8.5834334893786225E18 where the shortest form is
     * 8.583433489378622E18), so the encoder must not lean on it. Expected
     * strings are Node's JSON.stringify of the same double.
     */
    @Test
    void encodeRendersDigitsIndependentlyOfTheJdk() {
        assertEquals("8583433489378622000",
                JsonSupport.encode(Double.longBitsToDouble(0x43ddc79ed205e6afL)));
        assertEquals("-1975991724385561900",
                JsonSupport.encode(Double.longBitsToDouble(0xc3bb6c22010b1cedL)));
        assertEquals("8583433489378622000",
                JsonSupport.encode(new BigDecimal("8583433489378622000")));
        assertEquals("392234277478662800",
                JsonSupport.encode(392234277478662780L));
        assertEquals("2422889551725347000",
                JsonSupport.encode(2422889551725346800L));
        assertEquals("1.7976931348623157e+308",
                JsonSupport.encode(Double.MAX_VALUE));
    }

    /**
     * The generated oracle: canonical-doubles.txt holds JSON.stringify's
     * output for every binade's power of two and its lower neighbour (the
     * asymmetric rounding intervals), random subnormals, random values in
     * each notation band, and uniform bit patterns — regenerate it with
     * canonical-doubles.mjs beside it. Each double is checked as a Double
     * and as the BigDecimal a parser would hand over for that text.
     */
    @Test
    void encodeMatchesJsonStringifyOverTheGeneratedOracle() throws Exception {
        int checked = 0;
        List<String> mismatches = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                JsonSupportTest.class.getResourceAsStream("canonical-doubles.txt"),
                StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                int space = line.indexOf(' ');
                double value = Double.longBitsToDouble(
                        Long.parseUnsignedLong(line.substring(0, space), 16));
                String expected = line.substring(space + 1);
                String asDouble = JsonSupport.encode(value);
                String asDecimal = JsonSupport.encode(new BigDecimal(expected));
                if (!expected.equals(asDouble) || !expected.equals(asDecimal)) {
                    mismatches.add(line + " double=" + asDouble
                            + " decimal=" + asDecimal);
                }
                checked++;
            }
        }
        assertTrue(checked > 10000, "oracle lines read: " + checked);
        assertEquals(List.of(), mismatches.subList(0,
                Math.min(20, mismatches.size())),
                mismatches.size() + " of " + checked + " differ");
    }

    @Test
    void builderRefusesNumbersWithNoJsonForm() {
        for (Number value : new Number[] {
                new BigDecimal("1E+400"),
                BigInteger.TWO.pow(1100).negate()
        }) {
            Map<String, Object> block = Map.of("type", "custom", "value", value);
            assertThrows(IllegalArgumentException.class,
                    () -> PromptRequest.builder().addContent(block));
        }
        PromptRequest.builder().addContent(
                Map.of("type", "custom", "value", Double.MIN_VALUE));
    }

    @Test
    void encodeEscapesLikeWellFormedStringify() {
        // JSON.stringify answers "\ud800" for a lone surrogate (ES2019
        // well-formed stringify), never the raw char the UTF-8 digest step
        // would destroy. The cast mints the surrogate without a source
        // escape, keeping this file itself pure UTF-8.
        assertEquals("\"\\ud800\"",
                JsonSupport.encode(String.valueOf((char) 0xd800)));
        assertEquals("\"\\udfff\"",
                JsonSupport.encode(String.valueOf((char) 0xdfff)));
        assertEquals(
                "\"new" + "\\n" + "line" + "\\t" + "\\b" + "\\f" + "\\r"
                        + "\\\\" + "\\\"" + "\"",
                JsonSupport.encode("new\nline\t\b\f\r\\\""));
        assertEquals("\"café 中 😀\"", JsonSupport.encode("café 中 😀"));
        // C0 controls without a short escape take lowercase \\u00xx.
        assertEquals("\"\\u0001\\u001f\\u000b\"",
                JsonSupport.encode(String.valueOf(new char[] {1, 0x1f, 0x0b})));
    }

    @Test
    void encodeKeepsInsertionKeyOrderAsJsonStringifyDoes() {
        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("x", true);
        inner.put("y", new LinkedHashMap<String, Object>());
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("a", 1);
        value.put("b", List.of(1, 2, 0.0001));
        value.put("c", inner);
        value.put("d", null);
        assertEquals("{\"a\":1,\"b\":[1,2,0.0001],\"c\":{\"x\":true,\"y\":{}},\"d\":null}",
                JsonSupport.encode(value));
    }

    /** A bean, the shape fastjson2 renders by its getters. */
    public static final class ChannelPolicy {
        private final String privatePolicy;
        private final List<String> allowedUsers;
        private final double ratio;
        private final String note;

        ChannelPolicy(String privatePolicy, List<String> allowedUsers,
                double ratio, String note) {
            this.privatePolicy = privatePolicy;
            this.allowedUsers = allowedUsers;
            this.ratio = ratio;
            this.note = note;
        }

        public String getPrivatePolicy() {
            return privatePolicy;
        }

        public List<String> getAllowedUsers() {
            return allowedUsers;
        }

        public double getRatio() {
            return ratio;
        }

        public String getNote() {
            return note;
        }
    }

    private enum PolicyMode {
        ALLOWLIST
    }

    /**
     * Request bodies are not all contract values: the channel `submit_input`
     * body carries its policy as the Jackson tree read from the store column,
     * and fastjson2 rendered every such value before this encoder replaced
     * it. They still encode — the same JSON fastjson2 produced, canonicalized
     * (`1.0E-7` → `1e-7`, the lone surrogate escaped) — instead of throwing
     * and turning every inbound channel event into a 400.
     */
    @Test
    void encodeRendersNonContractValuesAsFastjsonDidThenCanonicalizes() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("policy", new ChannelPolicy("allowlist", List.of("a@b"), 1e-7,
                "x\uD800y"));
        value.put("mode", PolicyMode.ALLOWLIST);
        value.put("tail", List.of(PolicyMode.ALLOWLIST, 1));
        assertEquals("{\"policy\":{\"allowedUsers\":[\"a@b\"],"
                        + "\"note\":\"x\\ud800y\",\"privatePolicy\":\"allowlist\","
                        + "\"ratio\":1e-7},\"mode\":\"ALLOWLIST\","
                        + "\"tail\":[\"ALLOWLIST\",1]}",
                JsonSupport.encode(value));
    }

    @Test
    void protocolHelperMessagesKeepTheirFieldPath() {
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("count", -1L);
        assertEquals("ctx.count must be non-negative",
                assertThrows(DaemonProtocolException.class,
                        () -> JsonSupport.requiredNonNegativeLong(block,
                                "count", "ctx")).getMessage());

        block.put("count", 0L);
        assertEquals("ctx.count must be positive",
                assertThrows(DaemonProtocolException.class,
                        () -> JsonSupport.optionalPositiveLong(block, "count",
                                "ctx")).getMessage());

        block.put("count", (long) Integer.MAX_VALUE + 1L);
        assertEquals("ctx.count is outside the integer range",
                assertThrows(DaemonProtocolException.class,
                        () -> JsonSupport.requiredInt(block, "count", "ctx"))
                        .getMessage());

        assertEquals("ctx.inner must be an object",
                assertThrows(DaemonProtocolException.class,
                        () -> JsonSupport.requiredObject(Map.of(), "inner",
                                "ctx")).getMessage());
    }
}

