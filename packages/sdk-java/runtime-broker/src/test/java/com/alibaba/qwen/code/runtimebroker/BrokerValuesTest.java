package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.fastjson2.JSONWriter;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class BrokerValuesTest {
    @Test
    void wellFormedJsonFindsALoneSurrogateInAnyStringOrKey() {
        for (String lone : List.of("\ud800", "\udbff", "\udc00", "\udfff", "a\udc00\ud800b")) {
            for (Object value : List.of(lone, Map.of("k", lone), Map.of(lone, "v"),
                    List.of("ok", lone), Map.of("k", List.of(Map.of("n", lone))))) {
                assertFalse(BrokerValues.isWellFormedJson(value), value::toString);
                // The writer the Broker uses changes each of them.
                assertNotEquals(value instanceof String ? lone : value,
                        JSON.parse(JSON.toJSONBytes(value, JSONWriter.Feature.WriteNulls)));
            }
        }
        java.util.Map<String, Object> nulls = new java.util.HashMap<>();
        nulls.put("n", null);
        for (Object value : java.util.Arrays.asList(null, "𝄞", "é", nulls,
                Map.of("键-𝄞", List.of("😀", 1, true, 2.5, new BigDecimal("1.5"))))) {
            assertTrue(BrokerValues.isWellFormedJson(value), String.valueOf(value));
        }
        // The writer serializes these too, and would change "\ud800" in them
        // to '?', but they are not JSON values, so they fail closed.
        for (Object value : List.of(new String[] {"a"}, java.util.Set.of("a"), 'a',
                Map.of(1, "v"), new StringBuilder("a"), new Object())) {
            assertFalse(BrokerValues.isWellFormedJson(value), value::toString);
        }
    }

    @Test
    void exactLongReadsOnlyTheIntegerAJsonNumberDenotes() {
        for (String literal : List.of("4", "4.0", "4E0", "4L")) {
            assertEquals(4L, BrokerValues.exactLong(parse(literal)), literal);
        }
        assertEquals(Long.MIN_VALUE,
                BrokerValues.exactLong(parse("-9223372036854775808")));
        // A fraction, a value beyond a long, or a type that may round or
        // wrap, even when it holds 4.
        for (String literal : List.of("4.5", "4.0000000000000001",
                "40000000000000001E-16", "4.0000000000000001D", "4F", "65540S",
                "260B", "9223372036854775808")) {
            assertNull(BrokerValues.exactLong(parse(literal)), literal);
        }
        // The exponent alone decides these, without expanding the digits.
        assertNull(BrokerValues.exactLong(new BigDecimal("1E+1000000000")));
        assertNull(BrokerValues.exactLong(new BigDecimal("1E-1000000000")));
        assertNull(BrokerValues.exactLong(new AtomicLong(4)));
        assertNull(BrokerValues.exactLong("4"));
        assertNull(BrokerValues.exactLong(null));
    }

    @Test
    void exactIntegerReadsTheSameRuleWithoutTheLongBound() {
        for (String literal : List.of("4", "4.0", "4E0", "4L")) {
            assertEquals(0, new BigDecimal(4).compareTo(
                    BrokerValues.exactInteger(parse(literal))), literal);
        }
        // A cursor of any magnitude stays exact: it is never narrowed.
        for (String literal : List.of("9223372036854775808",
                "18446744073709551616")) {
            assertEquals(0, new BigDecimal(literal).compareTo(
                    BrokerValues.exactInteger(parse(literal))), literal);
        }
        assertEquals(0, new BigDecimal("0.00").compareTo(
                BrokerValues.exactInteger(parse("0.00"))));
        assertEquals(0, new BigDecimal("1E+1000000000").compareTo(
                BrokerValues.exactInteger(new BigDecimal("1E+1000000000"))));
        // A fraction, or a type that may round or wrap, even when it holds 4.
        for (String literal : List.of("4.5", "4.0000000000000001",
                "40000000000000001E-16", "4.0000000000000001D", "4F",
                "65540S", "260B")) {
            assertNull(BrokerValues.exactInteger(parse(literal)), literal);
        }
        assertNull(BrokerValues.exactInteger(new BigDecimal("1E-1000000000")));
        assertNull(BrokerValues.exactInteger(new AtomicLong(4)));
        assertNull(BrokerValues.exactInteger("4"));
        assertNull(BrokerValues.exactInteger(null));
    }

    private static Object parse(String literal) {
        return JsonCodec.parseObject(("{\"value\":" + literal + "}")
                .getBytes(StandardCharsets.UTF_8), "test").get("value");
    }

    @Test
    void acceptsDecimalScalesWithinTheReadableRange() {
        assertDoesNotThrow(() -> BrokerValues.immutableMap(Map.of(
                "fraction", new BigDecimal("0." + "1".repeat(2048)),
                "limit", new BigDecimal("1E+2048"))));
    }

    @Test
    void rejectsDecimalScalesBeyondTheReadableRange() {
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("fraction",
                        new BigDecimal("0." + "1".repeat(2049)))));
        // A negative scale is written in plain form as an integer with
        // -scale digits, which the same codec refuses to read back.
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("limit",
                        new BigDecimal("1E+2049"))));
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("limit",
                        new BigDecimal("1E+100000"))));
    }

    @Test
    void rejectsTheMinimumIntegerScaleBeforeSerializing() {
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("scale",
                        new BigDecimal(BigInteger.ONE, Integer.MIN_VALUE))));
    }

    @Test
    void rejectsOutOfRangeScalesNestedInListsAndMaps() {
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("list",
                        List.of(new BigDecimal("1E+100000")))));
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("map",
                        Map.of("scale", new BigDecimal("1E+100000")))));
    }

    @Test
    void plainFormOfANegativeScaleIsUnreadable() {
        // JdbcToolExecutionRepository writes BigDecimal values in plain
        // form, so 1E+100000 becomes a 100001-digit integer literal.
        String json = JSON.toJSONString(
                Map.of("scale", new BigDecimal("1E+100000")),
                JSONWriter.Feature.WriteBigDecimalAsPlain);
        assertTrue(json.length() > 100000);
        Exception exception = assertThrows(Exception.class,
                () -> JSON.parseObject(json,
                        JSONReader.Feature.DisableReferenceDetect));
        assertTrue(exception.getMessage().contains(
                "Number literal too long"));
    }

    @Test
    void acceptsValuesWhosePlainFormFitsTheReaderDigitBudget() {
        assertDoesNotThrow(() -> BrokerValues.immutableMap(Map.of(
                "integer", BigInteger.TEN.pow(9999).negate(),
                "wide", new BigDecimal(new BigInteger("9".repeat(7952)), -2048),
                "mixed", new BigDecimal(new BigInteger("9".repeat(10000)), 2048))));
    }

    @Test
    void rejectsValuesWhosePlainFormExceedsTheReaderDigitBudget() {
        // Each clears the ±2048 scale bound but writes more than 10000
        // digits, which the JDBC codec then refuses to read back.
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("integer",
                        BigInteger.TEN.pow(10000))));
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("integer",
                        BigInteger.TEN.pow(10000).negate())));
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("wide",
                        new BigDecimal(new BigInteger("9".repeat(7953)), -2048))));
        // The v2 wire literal "9{8000}E+2047" parses under
        // UseBigDecimalForDoubles to precision 8000, scale -2047.
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("wire",
                        new BigDecimal(new BigInteger("9".repeat(8000)), -2047))));
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("mixed",
                        new BigDecimal(new BigInteger("9".repeat(10001)), 2048))));
        assertThrows(IllegalArgumentException.class,
                () -> BrokerValues.immutableMap(Map.of("list", List.of(
                        new BigDecimal(BigInteger.TEN.pow(10000))))));
    }

    @Test
    void digitBudgetMatchesTheCodecReader() {
        for (Object value : List.of(BigInteger.TEN.pow(9999).negate(),
                new BigDecimal(new BigInteger("9".repeat(7952)), -2048),
                new BigDecimal(new BigInteger("9".repeat(10000)), 2048))) {
            String json = JSON.toJSONString(Map.of("v", value),
                    JSONWriter.Feature.WriteBigDecimalAsPlain);
            assertDoesNotThrow(() -> JSON.parseObject(json,
                    JSONReader.Feature.DisableReferenceDetect));
        }
        for (Object value : List.of(BigInteger.TEN.pow(10000),
                new BigDecimal(new BigInteger("9".repeat(7953)), -2048),
                new BigDecimal(new BigInteger("9".repeat(10001)), 2048))) {
            String json = JSON.toJSONString(Map.of("v", value),
                    JSONWriter.Feature.WriteBigDecimalAsPlain);
            assertThrows(Exception.class, () -> JSON.parseObject(json,
                    JSONReader.Feature.DisableReferenceDetect));
        }
    }
}
