package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ManagedCsiAcknowledgementProtocolTest {
    static Map<String, Object> fixtures() throws Exception {
        return ManagedCsiProtocol.parseAcknowledgement(Files.readAllBytes(
                Path.of("../../cli/src/serve/contracts/managed-csi-worker-ack-v1.fixtures.json")));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    static Map<String, Object> with(Map<String, Object> original, String field, Object value) {
        var changed = new LinkedHashMap<>(original);
        changed.put(field, value);
        return changed;
    }

    static RuntimeScope scope(Map<String, Object> boot) {
        var context = map(boot.get("context"));
        return new RuntimeScope((String) context.get("tenantId"), (String) context.get("workspaceId"),
                (String) context.get("workspaceGeneration"), (String) context.get("mountRoot"),
                (String) context.get("capabilityDigest"), (String) context.get("isolationClass"));
    }

    static RuntimeLease lease(Map<String, Object> boot, URI endpoint) {
        var context = map(boot.get("context"));
        return new RuntimeLease((String) context.get("runtimeInstanceId"), endpoint, (String) context.get("token"),
                (String) context.get("leaseId"), BrokerValues.exactLong(context.get("epoch")));
    }

    static RuntimeSession session(Map<String, Object> fixture) {
        var response = map(fixture.get("response"));
        return new RuntimeSession((String) map(response.get("captureIdentity")).get("sessionId"),
                (String) map(response.get("reference")).get("sessionId"), "continuation", scope(map(fixture.get("boot"))));
    }

    @Test
    void consumesTheSharedClosedFixtureAndKeepsDistinctSessionPromptAndGenerationPins() throws Exception {
        var fixture = fixtures();
        var boot = map(fixture.get("boot"));
        var request = map(fixture.get("request"));
        var response = map(fixture.get("response"));
        var capture = map(response.get("captureIdentity"));
        var pod = map(fixture.get("expectedPod"));
        assertEquals(fixture.get("ackPath"), ManagedCsiProtocol.ACKNOWLEDGE_PATH);
        assertEquals(fixture.get("workerAck"), ManagedCsiProtocol.WORKER_ACK);
        ManagedCsiProtocol.validateAcknowledgementRequest(request, boot, pod);
        ManagedCsiProtocol.validateAcknowledgementIdentity(lease(boot, URI.create("http://127.0.0.1:1")),
                session(fixture), boot, request, capture);
        assertEquals(response, ManagedCsiProtocol.verifyAcknowledgement(response, request, boot, pod, capture));
        var reordered = new LinkedHashMap<String, Object>();
        response.keySet().stream().sorted(java.util.Comparator.reverseOrder()).forEach(key -> reordered.put(key, response.get(key)));
        assertEquals(response, ManagedCsiProtocol.verifyAcknowledgement(reordered, request, boot, pod, capture));
        System.out.println("ACK strict Jackson " + new ObjectMapper().version() + " "
                + ObjectMapper.class.getProtectionDomain().getCodeSource().getLocation());
    }

    @Test
    void refusesEveryChangedResponseFieldAndEveryCaptureField() throws Exception {
        var fixture = fixtures();
        var boot = map(fixture.get("boot"));
        var request = map(fixture.get("request"));
        var response = map(fixture.get("response"));
        var capture = map(response.get("captureIdentity"));
        var pod = map(fixture.get("expectedPod"));
        for (String field : response.keySet()) {
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.verifyAcknowledgement(
                    with(response, field, null), request, boot, pod, capture), field);
        }
        for (String field : capture.keySet()) {
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.verifyAcknowledgement(
                    with(response, "captureIdentity", with(capture, field, null)), request, boot, pod, capture), field);
        }
        for (String group : new String[] {"reference", "acknowledgement", "context", "storage", "pod"}) {
            var original = map(response.get(group));
            for (String field : original.keySet()) {
                assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.verifyAcknowledgement(
                        with(response, group, with(original, field, null)), request, boot, pod, capture), group + "." + field);
            }
        }
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.verifyAcknowledgement(
                with(response, "acknowledged", true), request, boot, pod, capture));
    }

    @Test
    void validatesReceiptNumericDigestUnicodeAndCanonicalIdentityBoundaries() throws Exception {
        var fixture = fixtures();
        var boot = map(fixture.get("boot"));
        var request = map(fixture.get("request"));
        var pod = map(fixture.get("expectedPod"));
        var receipt = map(request.get("acknowledgement"));
        var manifest = map(receipt.get("manifest"));
        for (Object value : new Object[] {0, -1, 1.5, "7", 9_007_199_254_740_992L}) {
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                    with(request, "acknowledgement", with(receipt, "historyRevision", value)), boot, pod));
        }
        assertDoesNotThrow(() -> ManagedCsiProtocol.validateAcknowledgementRequest(
                with(request, "acknowledgement", with(receipt, "historyRevision", 9_007_199_254_740_991L)), boot, pod));
        for (Object value : new Object[] {0, 65537, "1024", 2.5}) {
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                    with(request, "acknowledgement", with(receipt, "manifest", with(manifest, "byteLength", value))), boot, pod));
        }
        for (String value : new String[] {"", "e\u0301", "\u0000", "\ud800", "界".repeat(171)}) {
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                    with(request, "reference", with(map(request.get("reference")), "callId", value)), boot, pod));
        }
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                with(request, "retirementId", "550E8400-E29B-41D4-A716-446655440000"), boot, pod));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                with(request, "acknowledgement", with(receipt, "deliveryStatus", "blocked")), boot, pod));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                with(request, "acknowledgement", with(receipt, "manifest", with(manifest, "digest", "sha256:" + "b".repeat(64)))), boot, pod));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                with(request, "state", "ACKNOWLEDGED"), boot, pod));
    }

    @Test
    void strictReaderRejectsDuplicateKeysMalformedUtf8TrailingTokensAndOversizeBodies() throws Exception {
        for (String json : new String[] {"{\"a\":null,\"a\":1}", "{\"a\":{\"b\":1,\"b\":2}}", "{} {}", "[]", "null"}) {
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.parseAcknowledgement(json.getBytes(StandardCharsets.UTF_8)), json);
        }
        assertEquals(Map.of(), ManagedCsiProtocol.parseAcknowledgement("{} \n\t".getBytes(StandardCharsets.UTF_8)));
        assertEquals(Map.of(), ManagedCsiProtocol.parseAcknowledgement(("{}" + " ".repeat(16 * 1024 - 2)).getBytes(StandardCharsets.UTF_8)));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.parseAcknowledgement(new byte[] {(byte) 0xc3, 0x28}));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.parseAcknowledgement(new byte[16 * 1024 + 1]));
        var fixture = fixtures();
        var request = map(fixture.get("request"));
        var escaped = new String(JsonCodec.encode(request), StandardCharsets.UTF_8)
                .replace("call-a", "\\ud800");
        var decoded = ManagedCsiProtocol.parseAcknowledgement(escaped.getBytes(StandardCharsets.UTF_8));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateAcknowledgementRequest(
                decoded, map(fixture.get("boot")), map(fixture.get("expectedPod"))));
        assertTrue(new String(JsonCodec.encode(request), StandardCharsets.UTF_8).length() < 16 * 1024);
    }

    @Test
    void numericWireTokensMustBeCanonicalPositiveIntegerLiteralsWithoutJsRounding() throws Exception {
        var fixture = fixtures();
        String original = new String(JsonCodec.encode(fixture.get("response")), StandardCharsets.UTF_8);
        for (String number : new String[] {"7.0", "7e0", "7E+0", "7.0000000000000001", "0", "-0", "-7"}) {
            String json = original.replace("\"historyRevision\":7", "\"historyRevision\":" + number);
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.parseAcknowledgement(json.getBytes(StandardCharsets.UTF_8)), number);
        }
        assertDoesNotThrow(() -> ManagedCsiProtocol.parseAcknowledgement(original.getBytes(StandardCharsets.UTF_8)));
    }
}
