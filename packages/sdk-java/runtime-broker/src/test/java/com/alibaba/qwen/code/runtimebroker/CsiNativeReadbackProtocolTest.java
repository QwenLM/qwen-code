package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CsiNativeReadbackProtocolTest {
    @Test
    void sharesAllThreeClosedActionsAndTheNullablePreparedRule() throws Exception {
        var fixture = JsonCodec.parseObject(Files.readAllBytes(Path.of(
                "../../cli/src/serve/contracts/managed-csi-native-readback-v1.fixtures.json")), "shared fixture");
        for (Object candidate : (List<?>) fixture.get("valid")) {
            var value = ManagedCsiFilesProtocolTest.map(candidate);
            var request = CsiNativeReadbackProtocol.request(JsonCodec.encode(ManagedCsiFilesProtocolTest.map(value.get("request"))));
            var response = ManagedCsiFilesProtocolTest.map(value.get("response"));
            assertTrue(BrokerValues.sameJsonMap(response, CsiNativeReadbackProtocol.response(JsonCodec.encode(response), request)));
            for (String field : request.keySet()) {
                var missing = new LinkedHashMap<>(request);
                missing.remove(field);
                assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.request(missing), field);
            }
            for (String field : response.keySet()) {
                var missing = new LinkedHashMap<>(response);
                missing.remove(field);
                assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.response(missing, request), field);
            }
            if ("execute".equals(value.get("name")) || "execute-read-only".equals(value.get("name"))) {
                for (Object locatorCandidate : (List<?>) fixture.get("intentLocatorCases")) {
                    var locator = ManagedCsiFilesProtocolTest.map(locatorCandidate);
                    var changed = new LinkedHashMap<>(response);
                    var evidence = new LinkedHashMap<>(ManagedCsiFilesProtocolTest.map(changed.get("evidence")));
                    var grant = new LinkedHashMap<>(ManagedCsiFilesProtocolTest.map(evidence.get("grant")));
                    grant.put("intent", locator.get("intent"));
                    if (locator.containsKey("authorization")) {
                        var authorization = ManagedCsiFilesProtocolTest.map(locator.get("authorization"));
                        var head = new LinkedHashMap<>(ManagedCsiFilesProtocolTest.map(changed.get("head")));
                        head.put("revision", authorization.get("revision"));
                        head.put("sequence", authorization.get("sequence"));
                        changed.put("head", head);
                        for (var target : List.of(evidence, grant)) {
                            target.put("authorizationRevision", authorization.get("revision"));
                            target.put("authorizationSequence", authorization.get("sequence"));
                        }
                    }
                    evidence.put("grant", grant);
                    changed.put("evidence", evidence);
                    if (Boolean.TRUE.equals(locator.get("accepted"))) {
                        assertTrue(BrokerValues.sameJsonMap(changed, CsiNativeReadbackProtocol.response(changed, request)),
                                (String) locator.get("name"));
                    } else {
                        assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.response(changed, request),
                                (String) locator.get("name"));
                    }
                }
                String duplicate = new String(JsonCodec.encode(response), StandardCharsets.UTF_8)
                        .replace("\"intent\":{\"revision\":7,", "\"intent\":{\"revision\":1,\"revision\":7,");
                assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.response(
                        duplicate.getBytes(StandardCharsets.UTF_8), request));
                var legacy = new LinkedHashMap<>(response);
                var evidence = new LinkedHashMap<>(ManagedCsiFilesProtocolTest.map(response.get("evidence")));
                var grant = new LinkedHashMap<>(ManagedCsiFilesProtocolTest.map(evidence.get("grant")));
                grant.put("intentRef", Map.of("resourceId", "original-intent", "kind", "managed-tool-intent",
                        "schemaVersion", 1, "byteLength", 22,
                        "digest", "f8d4c77bfb170cfd9be5653febe0c3c23781492dc0c3c1936df6b3b8aa2f47ac"));
                grant.remove("intent");
                evidence.put("grant", grant);
                legacy.put("evidence", evidence);
                assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.response(legacy, request));
            }
        }
        for (Object candidate : (List<?>) fixture.get("invalid")) {
            var value = ManagedCsiFilesProtocolTest.map(candidate);
            assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.response(
                    ManagedCsiFilesProtocolTest.map(value.get("response")), CsiNativeReadbackProtocol.request(
                            ManagedCsiFilesProtocolTest.map(value.get("request")))), (String) value.get("name"));
        }
        for (Object candidate : (List<?>) fixture.get("invalidJson")) {
            assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.request(
                    ((String) candidate).getBytes(StandardCharsets.UTF_8)));
        }
        assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.request(new byte[16385]));
        assertThrows(IllegalArgumentException.class, () -> CsiNativeReadbackProtocol.request(new byte[] {(byte) 0xff}));
    }
}
