package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

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
}
