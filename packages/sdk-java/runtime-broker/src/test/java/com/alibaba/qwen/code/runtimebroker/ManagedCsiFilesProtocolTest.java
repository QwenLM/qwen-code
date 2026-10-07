package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ManagedCsiFilesProtocolTest {
    static Map<String, Object> fixtures() throws Exception {
        return ManagedCsiFilesProtocol.parse(Files.readAllBytes(
                Path.of("../../cli/src/serve/contracts/managed-csi-files-v2.fixtures.json")));
    }

    static RuntimeProvisionRequest request(Map<String, Object> fixture) {
        var boot = map(fixture.get("boot"));
        var context = map(boot.get("context"));
        return new RuntimeProvisionRequest(new RuntimeScope((String) context.get("tenantId"),
                (String) context.get("workspaceId"), (String) context.get("workspaceGeneration"),
                (String) context.get("mountRoot"), (String) context.get("capabilityDigest"), "session"),
                (String) map(boot.get("identity")).get("sessionId"), "kubernetes-workspace", (String) context.get("storageId"));
    }

    static RuntimeProvisionSeed seed(Map<String, Object> fixture) {
        var context = map(map(fixture.get("boot")).get("context"));
        return new RuntimeProvisionSeed((String) context.get("provisionRequestId"), (String) context.get("runtimeInstanceId"),
                (String) context.get("runtimeIncarnation"), (String) context.get("leaseId"), BrokerValues.exactLong(context.get("epoch")),
                (String) context.get("token"));
    }

    @Test
    void sharesTheExactClosedTypeScriptBootAndBothAttestationContracts() throws Exception {
        var fixture = fixtures();
        var expected = map(fixture.get("boot"));
        var request = request(fixture);
        var boot = ManagedCsiFilesProtocol.boot(request, seed(fixture), map(expected.get("storage")));
        assertTrue(BrokerValues.sameJsonMap(expected, boot));
        assertTrue(BrokerValues.sameJsonMap(map(fixture.get("attestationRequest")), ManagedCsiFilesProtocol.attestationRequest(boot)));
        assertTrue(BrokerValues.sameJsonMap(map(fixture.get("attestationResponse")), ManagedCsiFilesProtocol.verifyAttestation(
                map(fixture.get("attestationResponse")), boot, map(fixture.get("expectedPod")))));
        var inner = ManagedCsiFilesProtocol.unwrapContext(request, map(fixture.get("contextAttestationResponse")));
        ManagedContextProtocol.verify(inner, ManagedContextProtocol.attestationResponse(map(boot.get("context"))));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateBoot(boot));
        assertTrue(ManagedCsiFilesProtocol.selects(request));
        var ordinary = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace"), null, "kubernetes-workspace", "storage");
        assertFalse(ManagedCsiFilesProtocol.selects(ordinary));
    }

    @Test
    void rejectsMissingExtraCrossedAndDowngradedIdentity() throws Exception {
        var fixture = fixtures();
        var boot = map(fixture.get("boot"));
        for (String key : boot.keySet()) {
            var changed = new LinkedHashMap<>(boot);
            changed.remove(key);
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiFilesProtocol.validateBoot(changed), key);
        }
        for (String field : List.of("profile", "sessionId", "capabilityDigest")) {
            var identity = new LinkedHashMap<>(map(boot.get("identity")));
            identity.put(field, "foreign");
            var changed = new LinkedHashMap<>(boot);
            changed.put("identity", identity);
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiFilesProtocol.validateBoot(changed));
        }
        var extra = new LinkedHashMap<>(boot);
        extra.put("token", "private");
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiFilesProtocol.validateBoot(extra));
        var reply = new LinkedHashMap<>(map(fixture.get("attestationResponse")));
        reply.put("identity", Map.of("profile", CsiFilesRetirementProfile.PROFILE,
                "sessionId", "d911c54f-ad76-420f-8c76-fb124c0ce623", "capabilityDigest", CsiFilesRetirementProfile.CAPABILITY_DIGEST));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiFilesProtocol.verifyAttestation(reply, boot, map(fixture.get("expectedPod"))));
    }

    @Test
    void rejectsAmbiguousJsonAndPreservesNativeZeroCounters() throws Exception {
        for (Object text : (List<?>) fixtures().get("invalidJson")) {
            assertThrows(IllegalArgumentException.class, () -> ManagedCsiFilesProtocol.parse(((String) text).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        }
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiFilesProtocol.parse(new byte[] {(byte) 0xff}));
        assertThrows(IllegalArgumentException.class, () -> ManagedCsiFilesProtocol.parse(new byte[32769]));
        assertEquals(0, ManagedCsiFilesProtocol.parse("{\"pendingStarts\":0}".getBytes(java.nio.charset.StandardCharsets.UTF_8)).get("pendingStarts"));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }
}
