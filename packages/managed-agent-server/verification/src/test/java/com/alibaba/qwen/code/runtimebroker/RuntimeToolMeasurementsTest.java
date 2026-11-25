package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RuntimeToolMeasurementsTest {
    @Test
    void exposesNamedFieldsWithoutRetypingPersistedJsonValues() {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("protocolVersion", 4L);
        raw.put("executionProtocol", 2L);
        raw.put("measurements", null);
        raw.put("resultDigest", "a".repeat(64));

        var metadata = RuntimeToolMeasurements.metadata(
                Map.of(RuntimeToolMeasurements.FIELD, raw));

        assertEquals(4L, metadata.protocolVersion());
        assertEquals(2L, metadata.executionProtocol());
        assertNull(metadata.measurements());
        assertEquals("a".repeat(64), metadata.resultDigest());
        assertEquals(raw.keySet(), metadata.wireValue().keySet());
    }

    @Test
    void retainsTheClosedKeyCheckWithoutAddingValueValidation() {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("protocolVersion", "legacy");
        raw.put("executionProtocol", 2);
        raw.put("measurements", null);
        raw.put("resultDigest", 7);
        var metadata = RuntimeToolMeasurements.metadata(
                Map.of(RuntimeToolMeasurements.FIELD, raw));
        assertEquals("legacy", metadata.protocolVersion());
        assertEquals(7, metadata.resultDigest());

        raw.put("extra", true);
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> RuntimeToolMeasurements.metadata(
                        Map.of(RuntimeToolMeasurements.FIELD, raw)));
        assertEquals("runtime_tool_measurements_missing", error.getCode());
    }

    @Test
    @SuppressWarnings("unchecked")
    void wireValueTakesARecursiveImmutableSnapshot() {
        List<Object> items = new ArrayList<>();
        items.add("before");
        Map<String, Object> measurements = new LinkedHashMap<>();
        measurements.put("items", items);
        var metadata = new RuntimeToolMeasurements.Metadata(
                4, 2, measurements, "a".repeat(64));

        Map<String, Object> wire = metadata.wireValue();
        measurements.put("items", List.of("after"));
        items.add("later");

        Map<String, Object> saved = (Map<String, Object>) wire.get("measurements");
        assertEquals(List.of("before"), saved.get("items"));
        assertThrows(UnsupportedOperationException.class,
                () -> wire.put("extra", true));
        assertThrows(UnsupportedOperationException.class,
                () -> saved.put("extra", true));
        assertThrows(UnsupportedOperationException.class,
                () -> ((List<Object>) saved.get("items")).add("later"));
    }
}
