package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RuntimeExecutionStatusTest {
    @Test
    void acceptsEveryNonTerminalStateWithoutAResult() {
        for (RuntimeExecutionStatus.State state : RuntimeExecutionStatus.State.values()) {
            if (state == RuntimeExecutionStatus.State.SETTLED) {
                continue;
            }
            var status = RuntimeExecutionStatus.from(Map.of("state", state.wireName()));
            assertEquals(state, status.state());
            assertNull(status.result());
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void takesARecursiveImmutableSnapshotOfTheDynamicResult() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("detail", null);
        List<Object> items = new ArrayList<>();
        items.add(nested);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("executionStatus", "success");
        result.put("items", items);

        var status = RuntimeExecutionStatus.from(Map.of(
                "state", "settled", "result", result));
        result.put("executionStatus", "error");
        items.add("later");
        nested.put("detail", "changed");

        assertEquals("success", status.result().get("executionStatus"));
        List<?> savedItems = (List<?>) status.result().get("items");
        assertEquals(1, savedItems.size());
        assertNull(((Map<?, ?>) savedItems.get(0)).get("detail"));
        assertThrows(UnsupportedOperationException.class,
                () -> status.result().put("later", true));
        assertThrows(UnsupportedOperationException.class,
                () -> ((List<Object>) savedItems).add("later"));
        assertThrows(UnsupportedOperationException.class,
                () -> ((Map<String, Object>) savedItems.get(0)).put("detail", "changed"));
    }

    @Test
    void rejectsInvalidShapesAndPresentNullResults() {
        Map<String, Object> nullKey = new HashMap<>();
        nullKey.put("state", "unknown");
        nullKey.put(null, "value");
        Map<String, Object> settledNull = new HashMap<>();
        settledNull.put("state", "settled");
        settledNull.put("result", null);
        Map<String, Object> executingNull = new HashMap<>();
        executingNull.put("state", "executing");
        executingNull.put("result", null);
        List<Map<String, Object>> invalid = List.of(nullKey, Map.of(),
                Map.of("state", 1), Map.of("state", "acknowledged"),
                Map.of("state", "unknown", "reason", "missing"),
                Map.of("state", "settled"),
                Map.of("state", "settled", "result", "success"),
                settledNull, executingNull,
                Map.of("state", "executing", "result", Map.of()),
                Map.of("state", "executing", "result", "later"));
        assertThrows(IllegalArgumentException.class,
                () -> RuntimeExecutionStatus.from(null));
        for (Map<String, Object> status : invalid) {
            assertThrows(IllegalArgumentException.class,
                    () -> RuntimeExecutionStatus.from(status), status.toString());
        }
    }

    @Test
    void rejectsInvalidJsonInsideAResult() {
        Map<Object, Object> nonStringKey = new HashMap<>();
        nonStringKey.put(1, "bad");
        assertThrows(IllegalArgumentException.class,
                () -> RuntimeExecutionStatus.from(Map.of("state", "settled",
                        "result", Map.of("value", new Object()))));
        assertThrows(IllegalArgumentException.class,
                () -> RuntimeExecutionStatus.from(Map.of("state", "settled",
                        "result", Map.of("value", Double.NaN))));
        assertThrows(IllegalArgumentException.class,
                () -> RuntimeExecutionStatus.from(Map.of("state", "settled",
                        "result", nonStringKey)));
    }
}
