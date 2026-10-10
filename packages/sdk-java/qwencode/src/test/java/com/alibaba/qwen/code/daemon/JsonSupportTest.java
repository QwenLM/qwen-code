package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.math.BigInteger;
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

    @Test
    void encodeRendersIntegralValuesByTheTwo53Rule() {
        assertEquals("9007199254740992",
                JsonSupport.encode(9007199254740992L));
        // JSON.stringify(9223372036854775807) — ECMAScript only holds the
        // double, so the integer rounds to its nearest representable value.
        assertEquals("9223372036854776000",
                JsonSupport.encode(Long.MAX_VALUE));
        assertEquals("1.2345678901234568e+29",
                JsonSupport.encode(
                        new BigInteger("123456789012345678901234567890")));
        assertEquals("100", JsonSupport.encode(100));
        assertEquals("-5", JsonSupport.encode(-5));
    }

    @Test
    void encodeRefusesSubnormalDoublesBeforeTheDigestCanWedge() {
        assertThrows(IllegalArgumentException.class,
                () -> JsonSupport.encode(Double.MIN_VALUE));
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
}

