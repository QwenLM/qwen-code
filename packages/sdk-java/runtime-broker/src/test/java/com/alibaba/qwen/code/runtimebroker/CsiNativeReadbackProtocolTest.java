package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
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
