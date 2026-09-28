package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.fastjson2.JSONWriter;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class BrokerValuesTest {
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
