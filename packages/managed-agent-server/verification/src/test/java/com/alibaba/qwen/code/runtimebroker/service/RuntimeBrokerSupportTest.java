package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RuntimeBrokerSupportTest {
    @Test
    void v3ProjectionKeepsItsExistingLeniencyBeforeCanonicalValidation() {
        assertEquals(Map.of("state", "settled", "result", Map.of("value", 1)),
                RuntimeBrokerSupport.projectV3Status(Map.of("protocolVersion", 3,
                        "state", "settled", "result", Map.of("value", 1),
                        "lastSequence", 9)));
        Map<String, Object> nullResult = new HashMap<>();
        nullResult.put("state", "executing");
        nullResult.put("result", null);
        for (Map<String, Object> response : List.<Map<String, Object>>of(
                Map.of("state", "executing"), nullResult,
                Map.of("state", "executing", "result", "ignored"))) {
            assertEquals(Map.of("state", "executing"),
                    RuntimeBrokerSupport.projectV3Status(response));
        }
    }

    @Test
    void v3ProjectionRetainsItsConflictBoundary() {
        Map<String, Object> settledNull = new HashMap<>();
        settledNull.put("state", "settled");
        settledNull.put("result", null);
        for (Map<String, Object> response : List.<Map<String, Object>>of(
                Map.of("state", "settled"),
                settledNull, Map.of("state", "settled", "result", "bad"),
                Map.of("state", "executing", "result", Map.of()),
                Map.of("state", "acknowledged"), Map.of("state", "done"))) {
            RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                    () -> RuntimeBrokerSupport.projectV3Status(response));
            assertEquals(409, error.getStatusCode());
            assertEquals("runtime_execution_conflict", error.getCode());
        }
    }
}
