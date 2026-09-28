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
}
