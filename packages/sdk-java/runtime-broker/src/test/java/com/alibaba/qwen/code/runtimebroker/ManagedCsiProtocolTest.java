package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ManagedCsiProtocolTest {
    @Test
    void replaysTheSameClosedEnvelopeAndIndependentPhysicalKeyFixturesAsTypescript() throws Exception {
        var path = Path.of("../../cli/src/serve/contracts/managed-csi-v1.fixtures.json");
        var fixtures = ManagedContextProtocol.parse(Files.readAllBytes(path));
        assertEquals(ManagedCsiProtocol.PROTOCOL, fixtures.get("managedCsi"));
        assertEquals(ManagedCsiProtocol.ATTEST_PATH, fixtures.get("attestPath"));
        int cases = 0;
        for (Object item : (Iterable<?>) fixtures.get("bootCases")) {
            var fixture = map(item);
            var boot = map(fixture.get("boot"));
            String id = (String) fixture.get("id");
            if (Boolean.TRUE.equals(fixture.get("valid"))) {
                assertDoesNotThrow(() -> ManagedCsiProtocol.validateBoot(boot), id);
                assertThrows(IllegalArgumentException.class, () -> ManagedContextProtocol.validateBoot(boot), id);
            } else {
                var failure = assertThrows(IllegalArgumentException.class, () -> ManagedCsiProtocol.validateBoot(boot), id);
                assertEquals("Managed CSI boot document is invalid.", failure.getMessage(), id);
            }
            cases++;
        }
        assertEquals(69, cases);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @Test
    void verifiesIndependentReservationAndMountReceiptsWithoutExtendingContextRecords() throws Exception {
        var fixtures = ManagedContextProtocol.parse(Files.readAllBytes(
                Path.of("../../cli/src/serve/contracts/managed-csi-v1.fixtures.json")));
        var boot = map(fixtures.get("boot"));
        var pod = map(fixtures.get("expectedPod"));
        assertEquals(fixtures.get("attestationRequest"), ManagedCsiProtocol.attestationRequest(boot));
        int requests = 0;
        for (Object item : (Iterable<?>) fixtures.get("requestCases")) {
            var fixture = map(item);
            var request = map(fixture.get("request"));
            String id = (String) fixture.get("id");
            if (Boolean.TRUE.equals(fixture.get("valid"))) {
                assertDoesNotThrow(() -> ManagedCsiProtocol.validateAttestationRequest(request, boot), id);
            } else {
                assertEquals("Managed CSI attestation request is invalid.", assertThrows(IllegalArgumentException.class,
                        () -> ManagedCsiProtocol.validateAttestationRequest(request, boot), id).getMessage());
            }
            requests++;
        }
        int responses = 0;
        for (Object item : (Iterable<?>) fixtures.get("responseCases")) {
            var fixture = map(item);
            var response = map(fixture.get("response"));
            String id = (String) fixture.get("id");
            if (Boolean.TRUE.equals(fixture.get("valid"))) {
                assertEquals(response, ManagedCsiProtocol.verifyAttestation(response, boot, pod), id);
            } else {
                assertEquals("Managed CSI attestation response is invalid.", assertThrows(IllegalArgumentException.class,
                        () -> ManagedCsiProtocol.verifyAttestation(response, boot, pod), id).getMessage());
            }
            responses++;
        }
        assertEquals(16, requests);
        assertEquals(110, responses);
    }
}
