package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class CsiFileHistoryProtocolTest {
    @Test
    void rejectsSnapshotCwdControlsWithoutEchoingThem() throws Exception {
        var json = new ObjectMapper();
        var fixture = json.readTree(VerificationFixtures.moduleRoot().resolve("../cli/src/serve/contracts/managed-csi-file-history-v1.fixtures.json").toFile());
        String owner = fixture.path("request").path("identity").path("sessionId").textValue();
        var observation = fixture.path("valid").get(2).path("observation").deepCopy();
        var snapshot = (com.fasterxml.jackson.databind.node.ObjectNode) observation.path("state").path("snapshots").get(0);
        snapshot.put("cwd", "/workspace");
        assertDoesNotThrow(() -> CsiFileHistoryProtocol.observation(observation, owner));
        for (int code = 0; code <= 127; code++) {
            if (code >= 32 && code != 127) {
                continue;
            }
            char control = (char) code;
            for (String cwd : new String[] {"/" + control + "workspace", "/work" + control + "space", "/workspace" + control}) {
                snapshot.put("cwd", cwd);
                var error = assertThrows(IllegalArgumentException.class,
                        () -> CsiFileHistoryProtocol.observation(observation, owner), "control " + code);
                assertEquals("Invalid private CSI file history.", error.getMessage());
            }
        }
    }

    @Test
    void sharesEmptyAndInheritedPreimagePinsAndRejectsCrossedEvidence() throws Exception {
        var json = new ObjectMapper();
        var fixture = json.readTree(VerificationFixtures.moduleRoot().resolve("../cli/src/serve/contracts/managed-csi-file-history-v1.fixtures.json").toFile());
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
        for (var value : fixture.path("snapshotCwdCases")) {
            var observation = fixture.path("valid").get(2).path("observation").deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) observation.path("state").path("snapshots").get(0))
                    .set("cwd", value.path("cwd"));
            if (value.path("valid").booleanValue()) {
                assertDoesNotThrow(() -> CsiFileHistoryProtocol.observation(observation, owner), value.path("cwd").textValue());
            } else {
                assertThrows(RuntimeException.class, () -> CsiFileHistoryProtocol.observation(observation, owner), value.path("cwd").textValue());
            }
        }
        for (int length : new int[] {4096, 4097}) {
            var observation = fixture.path("valid").get(2).path("observation").deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) observation.path("state").path("snapshots").get(0))
                    .put("cwd", "/" + "x".repeat(length - 1));
            if (length == 4096) {
                assertDoesNotThrow(() -> CsiFileHistoryProtocol.observation(observation, owner));
            } else {
                assertThrows(RuntimeException.class, () -> CsiFileHistoryProtocol.observation(observation, owner));
            }
        }
        assertThrows(RuntimeException.class, () -> CsiFileHistoryProtocol.operation(
                Map.of("kind", "csi-file-history", "version", 1, "action", "prepare")));
        assertThrows(RuntimeException.class, () -> CsiFileHistoryProtocol.operation(
                Map.of("kind", "csi-file-history", "version", 1, "action", "bind", "paths", java.util.List.of("caller.txt"))));
    }
}
