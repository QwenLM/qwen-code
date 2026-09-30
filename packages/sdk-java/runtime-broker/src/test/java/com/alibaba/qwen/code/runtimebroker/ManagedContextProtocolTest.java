package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ManagedContextProtocolTest {
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);

    @Test
    void validatesEverySharedBootAndReadyFixtureWithProductionRules()
            throws Exception {
        JsonNode suite = fixtures();
        for (JsonNode item : suite.required("bootCases")) {
            String id = item.required("id").asText();
            if (item.required("valid").asBoolean()) {
                assertDoesNotThrow(() -> ManagedContextProtocol.validateBoot(
                        map(item.required("boot"))), id);
            } else {
                assertThrows(Exception.class, () -> ManagedContextProtocol
                        .validateBoot(map(item.required("boot"))), id);
            }
        }
        Map<String, Object> boot = map(suite.required("boot"));
        for (JsonNode item : suite.required("readyCases")) {
            String id = item.required("id").asText();
            if (item.required("valid").asBoolean()) {
                assertDoesNotThrow(() -> ManagedContextProtocol.ready(
                        map(item.required("ready")), boot), id);
            } else {
                assertThrows(Exception.class, () -> ManagedContextProtocol.ready(
                        map(item.required("ready")), boot), id);
            }
        }
    }

    @Test
    void encodesInstallationAndReceiptExactlyLikeTheSharedFixture()
            throws Exception {
        JsonNode suite = fixtures();
        JsonNode expected = suite.required("installationSequences").get(0)
                .required("steps").get(0);
        ContextBinding binding = binding();
        assertEquals(expected.required("request"), JSON.readTree(JsonCodec.encode(
                ManagedContextProtocol.installation(request(), "op-1", "session-1", binding))));
        assertEquals(expected.required("expected").required("body"), JSON.readTree(JsonCodec.encode(
                ManagedContextProtocol.receipt(seed(), "op-1", "session-1", binding))));
        Map<String, Object> boot = ManagedContextProtocol.boot(request(), seed());
        assertEquals(suite.required("boot"), JSON.readTree(JsonCodec.encode(boot)));
        assertEquals(suite.required("attestationResponse"), JSON.readTree(JsonCodec.encode(
                ManagedContextProtocol.attestationResponse(boot))));
    }

    @Test
    void optInCannotSilentlyFallBackOrAcceptInvalidScope() {
        try (LocalProcessRuntimeProvisioner legacy = new LocalProcessRuntimeProvisioner(
                List.of("node"), Path.of("."), new HttpRuntimeTransport());
                LocalProcessRuntimeProvisioner managed = new LocalProcessRuntimeProvisioner(
                        List.of("node"), Path.of("."), new HttpRuntimeTransport(),
                        scope -> "storage://pvc/workspace-a");
                LocalProcessRuntimeProvisioner empty = new LocalProcessRuntimeProvisioner(
                        List.of("node"), Path.of("."), new HttpRuntimeTransport(), scope -> null)) {
            assertFalse(legacy.createRequest(request().getScope(), null).isManagedContext());
            assertTrue(managed.createRequest(request().getScope(), null).isManagedContext());
            assertThrows(IllegalArgumentException.class,
                    () -> empty.createRequest(request().getScope(), null));
        }
        for (String generation : List.of("01", "+1", "١", "9223372036854775808")) {
            assertThrows(IllegalArgumentException.class, () -> new RuntimeProvisionRequest(
                    new RuntimeScope("tenant-a", "workspace-a", generation,
                            "/root", "sha256:" + "a".repeat(64), "workspace"),
                    null, "local-process", "storage"));
        }
        assertThrows(IllegalArgumentException.class, () -> new RuntimeProvisionRequest(
                request().getScope(), null, "static", "storage"));
    }

    @Test
    void installationPreservesUnicodeAndRejectsMalformedSessionBeforeSending() {
        String sessionId = "会话-𝄞";
        Map<String, Object> body = ManagedContextProtocol.installation(request(),
                "op", sessionId, binding());
        assertEquals(sessionId, ManagedContextProtocol.parse(JsonCodec.encode(body)).get("sessionId"));
        for (String invalid : List.of("\ud800", "\udfff", "x\0y", "a".repeat(513))) {
            assertThrows(IllegalArgumentException.class, () -> ManagedContextProtocol.installation(
                    request(), "op", invalid, binding()));
        }
        assertThrows(IllegalArgumentException.class, () -> ManagedContextProtocol.installation(
                request(), "op", sessionId, new ContextBinding("tenant-a", "workspace-b",
                        7, "storage://pvc/workspace-a", "", "config", 1)));
        assertThrows(RuntimeBrokerException.class,
                () -> ManagedContextProtocol.parse(new byte[] {(byte) 0xff}));
        Map<String, Object> fractional = ManagedContextProtocol.parse(
                "{\"epoch\":4.0000000000000000001}".getBytes(StandardCharsets.UTF_8));
        assertThrows(RuntimeBrokerException.class,
                () -> ManagedContextProtocol.verify(fractional, Map.of("epoch", 4)));
    }

    static RuntimeProvisionRequest request() {
        return new RuntimeProvisionRequest(new RuntimeScope("tenant-a", "workspace-a",
                "7", "/runtime/workspaces/workspace-a", "sha256:" + "a".repeat(64),
                "workspace"), null, "local-process", "storage://pvc/workspace-a");
    }

    static RuntimeProvisionSeed seed() {
        return new RuntimeProvisionSeed("provision-01", "runtime-01", "boot-01",
                "lease-01", 4, "fixture-token");
    }

    static ContextBinding binding() {
        return new ContextBinding("tenant-a", "workspace-a", 7,
                "storage://pvc/workspace-a", "services/api", "config:bundle-3@r12", 1);
    }

    private static JsonNode fixtures() throws Exception {
        return JSON.readTree(ManagedRuntimeAttestationConformanceTest.contractDirectory()
                .resolve("managed-context-v1.fixtures.json").toFile());
    }

    private static Map<String, Object> map(JsonNode value) throws Exception {
        return JSON.readValue(value.toString(), new TypeReference<>() { });
    }
}
