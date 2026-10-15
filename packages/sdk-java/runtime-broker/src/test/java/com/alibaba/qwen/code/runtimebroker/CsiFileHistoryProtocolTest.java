package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CsiFileHistoryProtocolTest {
    @Test
    void sharesEmptyAndInheritedPreimagePinsAndRejectsCrossedEvidence() throws Exception {
        var json = new ObjectMapper();
        var fixture = json.readTree(Path.of("../../cli/src/serve/contracts/managed-csi-file-history-v1.fixtures.json").toFile());
        String owner = fixture.path("request").path("identity").path("sessionId").textValue();
        for (var value : fixture.path("valid")) {
            assertDoesNotThrow(() -> CsiFileHistoryProtocol.observation(value.path("observation"), owner));
            Map<String, Object> expected = JsonCodec.parseObject(json.writeValueAsBytes(fixture.path("request")), "fixture");
            var response = new LinkedHashMap<>(expected);
            response.put("observation", JsonCodec.parseObject(json.writeValueAsBytes(value.path("observation")), "observation"));
            assertDoesNotThrow(() -> CsiFileHistoryProtocol.response(JsonCodec.encode(response), expected));
        }
        for (var value : fixture.path("invalid")) {
            assertThrows(RuntimeException.class, () -> CsiFileHistoryProtocol.observation(value.path("observation"), owner),
                    value.path("name").textValue());
        }
        assertThrows(RuntimeException.class, () -> CsiFileHistoryProtocol.operation(
                Map.of("kind", "csi-file-history", "version", 1, "action", "prepare")));
        assertThrows(RuntimeException.class, () -> CsiFileHistoryProtocol.operation(
                Map.of("kind", "csi-file-history", "version", 1, "action", "bind", "paths", java.util.List.of("caller.txt"))));
    }
}
